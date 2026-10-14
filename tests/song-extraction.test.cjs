const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { ExtractionError } = require("../electron/errors.cjs");
const { validateMediaUrl } = require("../electron/extraction.cjs");
const { createOperationRegistry } = require("../electron/operationRegistry.cjs");
const { buildTaggingArgs, createSongExtractor, removeStaleWorkFolders, uniqueFilePath } = require("../electron/songExtraction.cjs");
const { createEditableMetadata } = require("../electron/youtubeMetadata.cjs");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavemint-song-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("tagging copies the audio stream and embeds the cover as the front picture", () => {
  const metadata = { title: "Song", artist: "Artist", album: "Album", genre: "" };
  const withCover = buildTaggingArgs({ input: "in.mp3", cover: "cover.jpg", output: "out.mp3", metadata });
  assert.deepEqual(withCover.slice(withCover.indexOf("-c:a"), withCover.indexOf("-c:a") + 4), ["-c:a", "copy", "-c:v", "copy"], "no re-encoding");
  assert.ok(withCover.includes("attached_pic"));
  assert.ok(withCover.includes("title=Song") && withCover.includes("genre="));
  assert.equal(withCover.at(-1), "out.mp3");
  const noCover = buildTaggingArgs({ input: "in.mp3", output: "out.mp3", metadata });
  assert.ok(!noCover.includes("1:v") && noCover.includes("copy"));
});

test("media URLs: web links and the bare forms yt-dlp understands pass; local and malformed input doesn't", () => {
  for (const url of ["https://www.youtube.com/watch?v=abc", "  http://youtu.be/abc  ", "youtube.com/watch?v=abc", "dQw4w9WgXcQ", "https://music.youtube.com/playlist?list=PL1"]) {
    assert.equal(validateMediaUrl(url), url.trim());
  }
  for (const url of ["", "   ", "file:///C:/Windows/win.ini", "FILE:C:/x", "data:text/html,hi", "javascript:alert(1)", "https://a b.com", `https://x.com/${"a".repeat(3000)}`, "https://x.com/\u0000"]) {
    assert.throws(() => validateMediaUrl(url), (error) => error instanceof ExtractionError && error.category === "unsupported-url", url);
  }
});

test("operations are cancelled per request, so one part of the UI can't stop another's work", () => {
  const registry = createOperationRegistry();
  const addMusic = registry.begin(1, "add-1");
  const addMusicSecond = registry.begin(1, "add-1");
  const upgrade = registry.begin(1, "upgrade-7");
  const otherWindow = registry.begin(2, "add-1");

  assert.equal(registry.cancel(1, "upgrade-7"), 1);
  assert.equal(upgrade.signal.aborted, true);
  assert.equal(addMusic.signal.aborted, false);
  assert.equal(registry.cancel(1, "add-1"), 2);
  assert.ok(addMusic.signal.aborted && addMusicSecond.signal.aborted);
  assert.equal(otherWindow.signal.aborted, false, "other windows are unaffected");

  const legacy = registry.begin(2);
  assert.equal(registry.cancel(2), 2, "without a request id: everything the window started");
  assert.ok(legacy.signal.aborted && otherWindow.signal.aborted);
  assert.equal(registry.cancel(3, "<script>"), 0);
  legacy.end();
});

test("unique file names and stale work-folder cleanup", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "A - B.mp3");
  assert.equal(uniqueFilePath(file), file);
  fs.writeFileSync(file, "x");
  assert.equal(uniqueFilePath(file), path.join(dir, "A - B (1).mp3"));

  const stale = path.join(dir, "wavemint-temp-old");
  const fresh = path.join(dir, "wavemint-temp-new");
  const other = path.join(dir, "something-else");
  for (const folder of [stale, fresh, other]) fs.mkdirSync(folder);
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, dayAgo, dayAgo);
  fs.utimesSync(other, dayAgo, dayAgo);
  removeStaleWorkFolders(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["A - B.mp3", "something-else", "wavemint-temp-new"]);
});

/** An extraction manager stand-in: "downloads" an MP3 and its info.json. */
function fakeExtraction({ info, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async download({ outputTemplate, onStatus }) {
      if (fail) throw fail;
      onStatus({ phase: "downloading", percent: 50 });
      const base = outputTemplate.replace(".%(ext)s", "");
      fs.writeFileSync(`${base}.mp3`, "audio");
      fs.writeFileSync(`${base}.info.json`, JSON.stringify(info));
    },
    async runChecked(tool, args) {
      calls.push({ tool, args });
      fs.writeFileSync(args.at(-1), "tagged audio");
      return { stdout: "", stderr: "" };
    },
  };
}

test("an extraction tags the song with the final metadata and leaves only the finished MP3", async (t) => {
  const dir = tempDir(t);
  const workRoot = path.join(dir, "work");
  const outputFolder = path.join(dir, "staging");
  fs.mkdirSync(outputFolder);
  const extraction = fakeExtraction({ info: { title: "Artist - Song (Official Video)", track: "Song", artist: "Artist", album: "Album", thumbnail: "https://i.ytimg.com/vi/x/hq.jpg" } });
  const covers = [];
  const artwork = {
    async prepareCover(options) {
      covers.push(options);
      const cover = path.join(options.folder, `${options.baseName}-prepared-artwork.jpg`);
      fs.writeFileSync(cover, "jpeg");
      return cover;
    },
  };
  const extractor = createSongExtractor({ extraction, artwork, workRoot });
  const progress = [];
  // The user edited the genre; everything else was guessed from the video.
  const shown = createEditableMetadata({ title: "Artist - Song (Official Video)", artist: "ArtistVEVO", album: "", genre: "" }, { title: true, artist: true, album: true, genre: true });
  const result = await extractor.extract({
    url: "https://www.youtube.com/watch?v=x",
    metadata: { ...shown, genre: "Synthpop" },
    thumbnail: "https://i.ytimg.com/vi/x/shown.jpg",
    artworkMode: "square_crop",
    outputFolder,
    onProgress: (status) => progress.push(status.phase),
  });

  assert.deepEqual(result.metadata, { title: "Song", artist: "Artist", album: "Album", genre: "Synthpop" });
  assert.equal(result.filePath, path.join(outputFolder, "Artist - Song.mp3"));
  assert.equal(fs.readFileSync(result.filePath, "utf8"), "tagged audio");
  assert.equal(covers[0].thumbnailCandidates[0], "https://i.ytimg.com/vi/x/shown.jpg", "the cover uses the thumbnail the user saw");
  assert.equal(covers[0].mode, "square_crop");
  const tagging = extraction.calls.find((call) => call.tool === "ffmpeg").args;
  assert.ok(tagging.includes("genre=Synthpop") && tagging.includes("attached_pic"));
  assert.deepEqual(progress, ["downloading", "artwork", "metadata"]);
  assert.deepEqual(fs.readdirSync(workRoot), [], "the private work folder is removed");
});

test("a failed extraction leaves nothing behind and reports a short error", async (t) => {
  const dir = tempDir(t);
  const workRoot = path.join(dir, "work");
  const outputFolder = path.join(dir, "staging");
  fs.mkdirSync(outputFolder);
  const recorded = [];
  const diagnostics = { record: (entry) => recorded.push(entry) && "d1" };

  const cancelled = new ExtractionError({ category: "cancelled", message: "Cancelled." });
  const extractor = createSongExtractor({ extraction: fakeExtraction({ fail: cancelled }), artwork: {}, workRoot, diagnostics });
  await assert.rejects(extractor.extract({ url: "u", outputFolder }), (error) => error === cancelled);

  const brokenArtwork = { prepareCover: async () => Promise.reject(new Error("HTTP 404")) };
  const extractor2 = createSongExtractor({ extraction: fakeExtraction({ info: {} }), artwork: brokenArtwork, workRoot, diagnostics });
  await assert.rejects(extractor2.extract({ url: "u", outputFolder }), (error) => error.category === "post-processing" && /Failed to prepare artwork: HTTP 404/.test(error.message));
  assert.equal(recorded.length, 1, "technical details go to diagnostics");
  assert.deepEqual(fs.readdirSync(workRoot), []);
  assert.deepEqual(fs.readdirSync(outputFolder), []);
});
