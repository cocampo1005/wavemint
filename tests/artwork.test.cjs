const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  SQUARE_CROP_FILTER,
  createArtworkProcessor,
  downloadImage,
  findContentBox,
  grayDifference,
  imageExtensionFromUrl,
  isBlank,
  normalizeArtworkMode,
  snapToShape,
  squareFilterFor,
} = require("../electron/artwork.cjs");
const { getHighResThumbnailCandidates, getSquareVideoSource, isArtTrack } = require("../electron/youtubeMetadata.cjs");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavemint-artwork-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fetch stand-in: `routes` maps URL -> { status, headers, body }. */
function fakeFetch(routes, seen = []) {
  return async (url, options) => {
    const href = String(url);
    seen.push({ href, redirect: options?.redirect });
    const route = routes[href];
    if (!route) return new Response(null, { status: 404 });
    return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers || {} });
  };
}

test("the plain square crop is a true center crop to 1000 × 1000 (no padding or blur)", () => {
  assert.equal(SQUARE_CROP_FILTER, "crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=1000:1000:flags=lanczos");
  assert.doesNotMatch(SQUARE_CROP_FILTER, /pad|blur|boxblur|overlay/);
  assert.equal(normalizeArtworkMode("square_crop"), "square_crop");
  assert.equal(normalizeArtworkMode("video_frame"), "original_thumbnail", "removed modes fall back");
  assert.equal(imageExtensionFromUrl("https://x/y.PNG?s=1"), ".png");
  assert.equal(imageExtensionFromUrl("https://x/y"), ".jpg");
});

test("artwork downloads follow HTTPS redirects only, and stay within the size limit", async (t) => {
  const dir = tempDir(t);
  const seen = [];
  const fetchImpl = fakeFetch(
    {
      "https://a.example/thumb.jpg": { status: 302, headers: { location: "https://cdn.example/thumb.jpg" } },
      "https://cdn.example/thumb.jpg": { body: "image-bytes" },
      "https://a.example/to-http.jpg": { status: 301, headers: { location: "http://insecure.example/x.jpg" } },
      "https://a.example/big.jpg": { body: "x".repeat(2000) },
      "https://a.example/declared-big.jpg": { body: "small", headers: { "content-length": "999999" } },
      "https://a.example/missing.jpg": { status: 404 },
      "https://a.example/loop.jpg": { status: 302, headers: { location: "/loop.jpg" } },
    },
    seen,
  );
  const target = path.join(dir, "out.jpg");

  await downloadImage("https://a.example/thumb.jpg", target, { fetchImpl });
  assert.equal(fs.readFileSync(target, "utf8"), "image-bytes");
  assert.ok(seen.every((call) => call.redirect === "manual"), "every hop is checked by WaveMint");

  await assert.rejects(downloadImage("http://a.example/thumb.jpg", target, { fetchImpl }), /only downloaded over HTTPS/);
  await assert.rejects(downloadImage("https://a.example/to-http.jpg", target, { fetchImpl }), /only downloaded over HTTPS/);
  await assert.rejects(downloadImage("file:///C:/Windows/win.ini", target, { fetchImpl }), /only downloaded over HTTPS/);
  await assert.rejects(downloadImage("not a url", target, { fetchImpl }), /invalid/);
  await assert.rejects(downloadImage("https://a.example/missing.jpg", target, { fetchImpl }), /HTTP 404/);
  await assert.rejects(downloadImage("https://a.example/loop.jpg", target, { fetchImpl }), /Too many redirects/);

  const big = path.join(dir, "big.jpg");
  await assert.rejects(downloadImage("https://a.example/big.jpg", big, { fetchImpl, maxBytes: 1000 }), /too large/);
  assert.equal(fs.existsSync(big), false, "a partial download is removed");
  await assert.rejects(downloadImage("https://a.example/declared-big.jpg", big, { fetchImpl, maxBytes: 1000 }), /too large/);
});

/**
 * FFmpeg/FFprobe stand-in: records calls and writes output files. Downloaded
 * "images" hold their URL as text; one whose URL contains "not-an-image" is
 * reported as invalid. Images are `size` wide/high (per URL: `sizes`).
 */
function fakeTools(calls = [], { size = { width: 640, height: 360 }, sizes = {} } = {}) {
  return async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "ffprobe") {
      const input = args.at(-1);
      const content = fs.existsSync(input) ? fs.readFileSync(input, "utf8") : "";
      const known = Object.entries(sizes).find(([key]) => content.includes(key))?.[1];
      return { stdout: JSON.stringify({ streams: content.includes("not-an-image") ? [] : [known || size] }) };
    }
    const input = args[args.indexOf("-i") + 1];
    fs.writeFileSync(args.at(-1), fs.existsSync(input) ? fs.readFileSync(input) : "jpeg");
    return { stdout: "" };
  };
}

const fakeDownload = (downloads = []) => async (url, destination) => {
  downloads.push(url);
  if (url.includes("fail")) throw new Error("HTTP 404");
  fs.writeFileSync(destination, url);
};

const cropCall = (calls) => calls.find((call) => call.tool === "ffmpeg" && call.args.includes("-q:v") && /crop=/.test(call.args[call.args.indexOf("-vf") + 1] || ""));

test("the cover comes from the first thumbnail that downloads as a real image, with the chosen crop", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const downloads = [];
  const artwork = createArtworkProcessor({ runChecked: fakeTools(calls), getTempDir: () => dir, download: fakeDownload(downloads), logger: { warn() {} } });

  const cover = await artwork.prepareCover({
    mode: "square_crop",
    thumbnailCandidates: ["https://x/not-an-image.jpg", "https://x/fail.jpg", "https://x/good.jpg", "https://x/good.jpg"],
    folder: dir,
    baseName: "base",
  });
  assert.equal(cover, path.join(dir, "base-prepared-artwork.jpg"));
  assert.deepEqual(downloads, ["https://x/not-an-image.jpg", "https://x/fail.jpg", "https://x/good.jpg"], "duplicates are tried once");
  const crop = cropCall(calls);
  assert.equal(crop.args[crop.args.indexOf("-vf") + 1], SQUARE_CROP_FILTER, "no bars: the plain center square");
  assert.match(crop.args[crop.args.indexOf("-i") + 1], /downloaded-artwork-2\.jpg$/, "from the first real image");
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("wavemint-")), [], "no temporary files are left");

  // The original thumbnail isn't cropped; no thumbnails means no cover.
  calls.length = 0;
  await artwork.prepareCover({ mode: "original_thumbnail", thumbnailCandidates: ["https://x/good.jpg"], folder: dir, baseName: "orig" });
  assert.ok(!calls.find((call) => call.tool === "ffmpeg").args.includes("-vf"));
  assert.equal(await artwork.prepareCover({ mode: "square_crop", thumbnailCandidates: [], folder: dir, baseName: "none" }), null);
  await assert.rejects(artwork.prepareCover({ mode: "custom_file", customFilePath: path.join(dir, "missing.png"), folder: dir, baseName: "c" }), /could not be found/);
});

test("the square preview is the very file that gets embedded, made once per thumbnail", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const downloads = [];
  const artwork = createArtworkProcessor({ runChecked: fakeTools(calls), getTempDir: () => dir, download: fakeDownload(downloads) });
  const [first, second] = await Promise.all([artwork.squarePreview("https://x/a.jpg"), artwork.squarePreview("https://x/a.jpg")]);
  assert.match(first, /^data:image\/jpeg;base64,/);
  assert.equal(first, second);
  await artwork.squarePreview("https://x/a.jpg");
  assert.equal(downloads.length, 1, "concurrent and repeated requests share one download");

  // The extraction embeds the preview's file instead of making another.
  calls.length = 0;
  const cover = await artwork.prepareCover({ mode: "square_crop", squareKey: "https://x/a.jpg", thumbnailCandidates: ["https://x/other.jpg"], folder: dir, baseName: "song" });
  assert.equal(downloads.length, 1, "nothing downloaded again");
  assert.deepEqual(fs.readFileSync(cover), Buffer.from(first.split(",")[1], "base64"), "preview and cover are identical");
  assert.equal(calls.length, 0);
});

test("larger versions of a YouTube thumbnail are tried first (same picture)", async (t) => {
  const dir = tempDir(t);
  const downloads = [];
  const artwork = createArtworkProcessor({ runChecked: fakeTools(), getTempDir: () => dir, download: fakeDownload(downloads) });
  const small = "https://i.ytimg.com/vi/IluRBvnYMoY/hqdefault.jpg?sqp=abc&rs=def";
  await artwork.squarePreview(small);
  assert.equal(downloads[0], "https://i.ytimg.com/vi/IluRBvnYMoY/maxresdefault.jpg");
  assert.deepEqual(getHighResThumbnailCandidates(small), [
    "https://i.ytimg.com/vi/IluRBvnYMoY/maxresdefault.jpg",
    "https://i.ytimg.com/vi/IluRBvnYMoY/hq720.jpg",
    "https://i.ytimg.com/vi/IluRBvnYMoY/sddefault.jpg",
    "https://i.ytimg.com/vi/IluRBvnYMoY/hqdefault.jpg",
    small,
  ]);
  assert.deepEqual(getHighResThumbnailCandidates("https://example.com/vi/IluRBvnYMoY/a.jpg"), [], "only YouTube's own thumbnails");

  // The published thumbnail (Original) only uses the 16:9 sizes: same framing as shown.
  downloads.length = 0;
  await artwork.prepareCover({ mode: "original_thumbnail", thumbnailCandidates: ["https://i.ytimg.com/vi/IluRBvnYMoY/hqdefault.jpg"], folder: dir, baseName: "orig" });
  assert.deepEqual(downloads, ["https://i.ytimg.com/vi/IluRBvnYMoY/maxresdefault.jpg"]);
});

/** RGB pixels: `fill` everywhere, `picture` (a noisy pattern) inside `box`. */
function image(width, height, { fill = [0, 0, 0], boxes = [] } = {}) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let color = fill;
      for (const box of boxes) {
        if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) color = box.color || [(x * 37) % 256, (y * 53) % 256, ((x + y) * 29) % 256];
      }
      pixels.set(color, (y * width + x) * 3);
    }
  }
  return pixels;
}

test("bars YouTube adds around a picture are found and removed, nested ones too", () => {
  // A square cover pillarboxed into a 16:9 thumbnail (colored bars).
  const pillar = image(320, 180, { fill: [70, 66, 40], boxes: [{ x: 70, y: 0, w: 180, h: 180 }] });
  const box = findContentBox(pillar, 320, 180);
  assert.deepEqual(box, { x: 70, y: 0, w: 180, h: 180 });
  assert.equal(squareFilterFor(snapToShape(box, 320, 180), 320, 180), "crop=180:180:70:0,scale=1000:1000:flags=lanczos");

  // The same cover in a 4:3 thumbnail: black letterbox, then the pillar bars.
  const nested = image(320, 240, { fill: [0, 0, 0], boxes: [{ x: 0, y: 30, w: 320, h: 180, color: [70, 66, 40] }, { x: 70, y: 30, w: 180, h: 180 }] });
  assert.deepEqual(findContentBox(nested, 320, 240), { x: 70, y: 30, w: 180, h: 180 });

  // A plain widescreen picture has nothing to remove: the center square, as before.
  const plain = image(320, 180, { boxes: [{ x: 0, y: 0, w: 320, h: 180 }] });
  assert.equal(findContentBox(plain, 320, 180), null);
  assert.equal(squareFilterFor(null, 1280, 720), SQUARE_CROP_FILTER);
  assert.doesNotMatch(squareFilterFor(snapToShape(box, 320, 180), 320, 180), /pad|blur|boxblur|overlay/);
});

test("pictures are never trimmed on one side or into odd shapes", () => {
  // A dark edge on one side only is part of the picture.
  const oneSided = image(320, 180, { fill: [0, 0, 0], boxes: [{ x: 40, y: 0, w: 280, h: 180 }] });
  assert.equal(findContentBox(oneSided, 320, 180), null);

  // Bars of different colors on the two sides aren't bars.
  const mixed = image(320, 180, { fill: [0, 0, 0], boxes: [{ x: 250, y: 0, w: 70, h: 180, color: [200, 30, 30] }, { x: 70, y: 0, w: 180, h: 180 }] });
  assert.equal(findContentBox(mixed, 320, 180), null);

  // What's left must be a standard frame shape (5:4 isn't): then nothing is trimmed.
  assert.equal(snapToShape({ x: 48, y: 0, w: 225, h: 180 }, 320, 180), null);

  // Bars detected a little too wide (a dark cover edge next to dark bars) snap back to the full square.
  assert.deepEqual(snapToShape({ x: 73, y: 0, w: 174, h: 180 }, 320, 180), { x: 70, y: 0, w: 180, h: 180 });
});

test("square video sources: the largest square stream, art tracks recognized", () => {
  const formats = [
    { url: "https://v/137", vcodec: "avc1.640028", width: 1080, height: 1080, protocol: "https", http_headers: { "User-Agent": "UA" } },
    { url: "https://v/248", vcodec: "vp9", width: 1080, height: 1080, protocol: "https" },
    { url: "https://v/136", vcodec: "avc1.4d401f", width: 720, height: 720, protocol: "https" },
    { url: "https://v/hls", vcodec: "avc1", width: 1080, height: 1080, protocol: "m3u8_native" },
    { url: "https://v/audio", vcodec: "none", acodec: "opus" },
  ];
  const source = getSquareVideoSource({ width: 1080, height: 1080, duration: 248, formats, description: "Provided to YouTube by Columbia\n\nGet Lucky · Daft Punk\n\nAuto-generated by YouTube." });
  assert.deepEqual(source, { url: "https://v/137", headers: { "User-Agent": "UA" }, size: 1080, duration: 248, artTrack: true });
  assert.equal(getSquareVideoSource({ width: 1920, height: 1080, formats }), null, "widescreen videos use their thumbnail");
  assert.equal(getSquareVideoSource({ width: 1080, height: 1080, formats: [] }), null);
  assert.equal(isArtTrack({ channel: "Daft Punk - Topic" }), true);
  assert.equal(isArtTrack({ channel: "Daft Punk", description: "Official video" }), false);
});

test("a still of a square video is used only when it's the better picture", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  // The thumbnail is a plain 640 × 360 picture (no bars: reframed); the video is a 1080 square.
  const artwork = createArtworkProcessor({
    runChecked: async (tool, args, options) => {
      if (tool === "ffmpeg" && args.includes("-headers")) {
        calls.push(args);
        fs.writeFileSync(args.at(-1), `still-${args.includes("-ss") ? args[args.indexOf("-ss") + 1] : 0}`);
        return { stdout: "" };
      }
      // Grayscale samples: stills of a still video are identical; a moving one differs.
      if (tool === "ffmpeg" && args.includes("gray")) {
        const input = fs.readFileSync(args[args.indexOf("-i") + 1], "utf8");
        const moving = input.includes("still-30") && dir.includes("moving");
        const value = moving ? 200 : input.startsWith("still") ? 90 : 40;
        fs.writeFileSync(args.at(-1), Buffer.from(Array.from({ length: 576 }, (_, i) => (i % 2 ? value : value + 40))));
        return { stdout: "" };
      }
      return fakeTools([], { sizes: { still: { width: 1080, height: 1080 } } })(tool, args, options);
    },
    getTempDir: () => dir,
    download: fakeDownload(),
    logger: { warn() {} },
  });
  const video = { url: "https://v/137", headers: { "User-Agent": "UA", Cookie: "secret" }, size: 1080, duration: 60, artTrack: false };

  await artwork.prepareCover({ mode: "square_crop", squareKey: "https://x/thumb-a.jpg", thumbnailCandidates: ["https://x/thumb-a.jpg"], video, folder: dir, baseName: "still" });
  assert.equal(calls.length, 2, "a still at 1 s and one halfway through");
  assert.ok(calls.every((args) => !args.join(" ").includes("secret")), "cookies are never passed on");
  assert.match(fs.readFileSync(path.join(dir, "still-prepared-artwork.jpg"), "utf8"), /^still/, "a video that is one still image gives the artwork");

  // An art track needs only one still.
  calls.length = 0;
  await artwork.prepareCover({ mode: "square_crop", squareKey: "https://x/thumb-b.jpg", thumbnailCandidates: ["https://x/thumb-b.jpg"], video: { ...video, artTrack: true }, folder: dir, baseName: "art" });
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(path.join(dir, "art-prepared-artwork.jpg"), "utf8"), /^still/);

  // Without a square video only the thumbnail is used (no video requests).
  calls.length = 0;
  await artwork.prepareCover({ mode: "square_crop", squareKey: "https://x/plain.jpg", thumbnailCandidates: ["https://x/plain.jpg"], folder: dir, baseName: "plain" });
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, "plain-prepared-artwork.jpg"), "utf8"), "https://x/plain.jpg");
});

test("a moving square video keeps the thumbnail", async (t) => {
  const dir = path.join(tempDir(t), "moving");
  fs.mkdirSync(dir);
  const artwork = createArtworkProcessor({
    runChecked: async (tool, args, options) => {
      if (tool === "ffmpeg" && args.includes("-headers")) {
        fs.writeFileSync(args.at(-1), `frame-${args[args.indexOf("-ss") + 1]}`);
        return { stdout: "" };
      }
      if (tool === "ffmpeg" && args.includes("gray")) {
        const input = fs.readFileSync(args[args.indexOf("-i") + 1], "utf8");
        const value = input === "frame-1" ? 60 : input === "frame-30" ? 210 : 140;
        fs.writeFileSync(args.at(-1), Buffer.from(Array.from({ length: 576 }, (_, i) => (i % 3 ? value : value - 50))));
        return { stdout: "" };
      }
      return fakeTools([], { sizes: { frame: { width: 1080, height: 1080 } } })(tool, args, options);
    },
    getTempDir: () => dir,
    download: fakeDownload(),
    logger: { warn() {} },
  });
  await artwork.prepareCover({
    mode: "square_crop",
    squareKey: "https://x/video.jpg",
    thumbnailCandidates: ["https://x/video.jpg"],
    video: { url: "https://v/1", headers: {}, size: 1080, duration: 60, artTrack: false },
    folder: dir,
    baseName: "moving",
  });
  assert.equal(fs.readFileSync(path.join(dir, "moving-prepared-artwork.jpg"), "utf8"), "https://x/video.jpg");
});

test("blank stills and difference measures", () => {
  assert.equal(isBlank(Buffer.alloc(576, 12)), true);
  assert.equal(isBlank(Buffer.from(Array.from({ length: 576 }, (_, i) => (i % 2 ? 20 : 220)))), false);
  assert.equal(grayDifference(Buffer.alloc(4, 100), Buffer.alloc(4, 100)), 0);
  assert.equal(grayDifference(Buffer.alloc(4, 0), Buffer.alloc(4, 255)), 1);
  assert.equal(grayDifference(Buffer.alloc(4, 0), Buffer.alloc(3, 0)), 1);
});

test("the renderer offers exactly the artwork modes the main process accepts", () => {
  const { ARTWORK_MODES } = require("../electron/artwork.cjs");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "addMusic", "extraction.js"), "utf8");
  const block = /export const ARTWORK_OPTIONS = \[([\s\S]*?)\];/.exec(source)[1];
  assert.deepEqual([...block.matchAll(/value: "([a-z_]+)"/g)].map((match) => match[1]), ARTWORK_MODES);
});
