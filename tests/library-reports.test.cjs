const assert = require("node:assert/strict");
const fs = require("fs");
const test = require("node:test");

const review = require("../electron/library/review.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, ensureBase, makeTempDir, makeTrack, mediaForTests } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

test("albums missing songs are reported per disc, only when totals are known", needsAudio, async (t) => {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  for (const number of [1, 2, 4]) makeTrack(root, `A/Gaps/${number}.mp3`, { tags: { title: `Song ${number}`, artist: "A", album: "Gaps", trackNo: number, trackTotal: 5 } });
  for (const [disc, number] of [[1, 1], [1, 2], [2, 2]]) {
    makeTrack(root, `B/Double/${disc}-${number}.mp3`, { tags: { title: `Song ${disc}-${number}`, artist: "B", album: "Double", trackNo: number, trackTotal: 2, discNo: disc, discTotal: 2 } });
  }
  for (const number of [1, 2]) makeTrack(root, `C/Whole/${number}.mp3`, { tags: { title: `Whole ${number}`, artist: "C", album: "Whole", trackNo: number, trackTotal: 2 } });
  makeTrack(root, "D/Unknown/1.mp3", { tags: { title: "Lonely", artist: "D", album: "Unknown", trackNo: 3 } });
  await addAndScan(lib.db, lib.scanner, root);

  const issues = [...review.detectIssues(lib.db).values()].filter((issue) => issue.kind === "incomplete_album");
  const byAlbum = Object.fromEntries(issues.map((issue) => [issue.details.album, issue.details]));
  assert.deepEqual(byAlbum.Gaps, { album: "Gaps", have: 3, total: 5, missing: ["3", "5"] });
  assert.deepEqual(byAlbum.Double.missing, ["2-1"]);
  assert.equal(byAlbum.Whole, undefined, "complete albums aren't reported");
  assert.equal(byAlbum.Unknown, undefined, "no total, no guess");
});

test("spectrograms are rendered once and cached", needsAudio, async (t) => {
  const media = mediaForTests();
  const key = `test-${process.pid}-${Date.now()}`;
  const image = await media.spectrogram(ensureBase("noise_128"), key);
  t.after(() => fs.rmSync(image, { force: true }));
  const bytes = fs.readFileSync(image);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  const mtime = fs.statSync(image).mtimeMs;
  assert.equal(await media.spectrogram(ensureBase("noise_128"), key), image);
  assert.equal(fs.statSync(image).mtimeMs, mtime);
  await assert.rejects(media.spectrogram(ensureBase("noise_128"), "../escape"), /Invalid/);
});
