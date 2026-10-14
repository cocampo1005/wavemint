const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { SQUARE_CROP_FILTER, createArtworkProcessor, downloadImage, imageExtensionFromUrl, normalizeArtworkMode } = require("../electron/artwork.cjs");

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

test("the square crop is a true center crop to 1000 × 1000 (no padding or blur)", () => {
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

/** FFmpeg/FFprobe stand-in: records calls, writes the output file, reports valid images. */
function fakeTools(calls = [], { invalid = new Set() } = {}) {
  return async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "ffprobe") {
      const input = args.at(-1);
      return { stdout: JSON.stringify({ streams: invalid.has(path.basename(input)) ? [] : [{ width: 640, height: 360 }] }) };
    }
    fs.writeFileSync(args.at(-1), "jpeg");
    return { stdout: "" };
  };
}

test("the cover comes from the first thumbnail that downloads as a real image, with the chosen crop", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const downloads = [];
  const artwork = createArtworkProcessor({
    runChecked: fakeTools(calls, { invalid: new Set(["base-downloaded-artwork-0.jpg"]) }),
    getTempDir: () => dir,
    download: async (url, destination) => {
      downloads.push(url);
      if (url.includes("fail")) throw new Error("HTTP 404");
      fs.writeFileSync(destination, "image");
    },
    logger: { warn() {} },
  });

  const cover = await artwork.prepareCover({
    mode: "square_crop",
    thumbnailCandidates: ["https://x/not-an-image.jpg", "https://x/fail.jpg", "https://x/good.jpg", "https://x/good.jpg"],
    folder: dir,
    baseName: "base",
  });
  assert.equal(cover, path.join(dir, "base-prepared-artwork.jpg"));
  assert.deepEqual(downloads, ["https://x/not-an-image.jpg", "https://x/fail.jpg", "https://x/good.jpg"], "duplicates are tried once");
  const ffmpeg = calls.find((call) => call.tool === "ffmpeg");
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-vf") + 1], SQUARE_CROP_FILTER);
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-i") + 1], path.join(dir, "base-downloaded-artwork-2.jpg"));
  assert.equal(fs.existsSync(path.join(dir, "base-downloaded-artwork-0.jpg")), false, "rejected downloads are removed");

  // The original thumbnail isn't cropped; no thumbnails means no cover.
  calls.length = 0;
  await artwork.prepareCover({ mode: "original_thumbnail", thumbnailCandidates: ["https://x/good.jpg"], folder: dir, baseName: "orig" });
  assert.ok(!calls.find((call) => call.tool === "ffmpeg").args.includes("-vf"));
  assert.equal(await artwork.prepareCover({ mode: "square_crop", thumbnailCandidates: [], folder: dir, baseName: "none" }), null);
  await assert.rejects(artwork.prepareCover({ mode: "custom_file", customFilePath: path.join(dir, "missing.png"), folder: dir, baseName: "c" }), /could not be found/);
});

test("square previews use the same filter as the embedded cover, once per thumbnail", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  let downloads = 0;
  const artwork = createArtworkProcessor({
    runChecked: fakeTools(calls),
    getTempDir: () => dir,
    download: async (_url, destination) => {
      downloads += 1;
      fs.writeFileSync(destination, "image");
    },
  });
  const [first, second] = await Promise.all([artwork.squarePreview("https://x/a.jpg"), artwork.squarePreview("https://x/a.jpg")]);
  assert.match(first, /^data:image\/jpeg;base64,/);
  assert.equal(first, second);
  await artwork.squarePreview("https://x/a.jpg");
  assert.equal(downloads, 1, "concurrent and repeated requests share one download");
  assert.equal(calls[0].args[calls[0].args.indexOf("-vf") + 1], SQUARE_CROP_FILTER);
  assert.deepEqual(fs.readdirSync(dir), [], "no temporary files are left");
});

test("the renderer offers exactly the artwork modes the main process accepts", () => {
  const { ARTWORK_MODES } = require("../electron/artwork.cjs");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "addMusic", "extraction.js"), "utf8");
  const block = /export const ARTWORK_OPTIONS = \[([\s\S]*?)\];/.exec(source)[1];
  assert.deepEqual([...block.matchAll(/value: "([a-z_]+)"/g)].map((match) => match[1]), ARTWORK_MODES);
});
