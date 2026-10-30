const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readMediaBytes } = require("../electron/library/mediaBytes.cjs");

test("unconsumed playback responses allow repeated file replacement and retain their audio", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wavemint-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "song.mp3");
  fs.writeFileSync(target, "original audio");
  const full = new Response(await readMediaBytes(target));
  const range = new Response(await readMediaBytes(target, 2, 7));
  // Leave both responses unread, as happens when playback is paused.
  for (let n = 0; n < 2; n += 1) {
    fs.renameSync(target, path.join(root, `old-${n}.mp3`));
    fs.writeFileSync(target, `replacement ${n}`);
  }
  assert.equal(await full.text(), "original audio");
  assert.equal(await range.text(), "iginal");
  assert.equal(fs.readFileSync(target, "utf8"), "replacement 1");
});
