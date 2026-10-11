const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { isAutoImportFolder, moveIntoOutputFolder } = require("../electron/outputFiles.cjs");
const { makeTempDir, writeFile } = require("./helpers.cjs");

test("same-drive moves are a single rename", (t) => {
  const dir = makeTempDir(t);
  const source = writeFile(path.join(dir, "work", "tagged.mp3"), "audio");
  const destination = path.join(dir, "Music", "Artist - Song.mp3");
  fs.mkdirSync(path.dirname(destination));

  assert.equal(moveIntoOutputFolder(source, destination), "renamed");
  assert.equal(fs.readFileSync(destination, "utf8"), "audio");
  assert.equal(fs.existsSync(source), false);
});

test("moves to another drive copy the file, then remove the source", (t) => {
  const dir = makeTempDir(t);
  const source = writeFile(path.join(dir, "tagged.mp3"), "audio");
  const destination = path.join(dir, "Artist - Song.mp3");
  // Simulates a different drive: rename fails with EXDEV, as on Windows.
  const fsImpl = {
    ...fs,
    renameSync: () => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    },
  };

  assert.equal(moveIntoOutputFolder(source, destination, { fsImpl }), "copied");
  assert.equal(fs.readFileSync(destination, "utf8"), "audio");
  assert.equal(fs.existsSync(source), false);
});

test("a copy never overwrites an existing file", (t) => {
  const dir = makeTempDir(t);
  const source = writeFile(path.join(dir, "tagged.mp3"), "new");
  const destination = writeFile(path.join(dir, "Artist - Song.mp3"), "existing");
  const fsImpl = {
    ...fs,
    renameSync: () => {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    },
  };

  assert.throws(() => moveIntoOutputFolder(source, destination, { fsImpl }), /EEXIST/);
  assert.equal(fs.readFileSync(destination, "utf8"), "existing");
});

test("other failures are reported, not hidden", (t) => {
  const dir = makeTempDir(t);
  assert.throws(
    () => moveIntoOutputFolder(path.join(dir, "missing.mp3"), path.join(dir, "out.mp3")),
    (error) => error.code === "ENOENT",
  );
});

test("iTunes and Music auto-import folders are recognized", () => {
  for (const folder of [
    "C:\\Users\\Me\\Music\\iTunes\\iTunes Media\\Automatically Add to iTunes",
    "C:\\Users\\Me\\Music\\iTunes\\iTunes Media\\Automatically Add to iTunes\\",
    "D:\\Media\\Automatically Add to Music",
  ]) {
    assert.equal(isAutoImportFolder(folder), true, folder);
  }

  for (const folder of ["C:\\Users\\Me\\Music", "C:\\Automatically Add to iTunes\\Albums", "", null]) {
    assert.equal(isAutoImportFolder(folder), false, String(folder));
  }
});
