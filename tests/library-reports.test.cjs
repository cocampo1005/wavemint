const assert = require("node:assert/strict");
const fs = require("fs");
const test = require("node:test");

const { SKIP_REASON, ensureBase, mediaForTests } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

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
