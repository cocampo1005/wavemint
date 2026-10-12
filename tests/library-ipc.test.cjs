const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { HOST_METHOD_NAMES, WORKER_METHODS } = require("../electron/library/host.cjs");
const { createLibraryService } = require("../electron/library/service.cjs");
const { validate } = require("../electron/library/validate.cjs");

test("the preload bridge exposes exactly the allowlisted library methods", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  const block = /const LIBRARY_METHODS = \[([\s\S]*?)\];/.exec(preload)[1];
  const exposed = [...block.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  const allowed = [...Object.keys(WORKER_METHODS), ...HOST_METHOD_NAMES].sort();
  assert.deepEqual(exposed, allowed);
});

test("every renderer-callable worker method exists in the service", () => {
  const db = { prepare: () => ({ all: () => [], get: () => null, run: () => ({}) }), exec() {} };
  const { methods } = createLibraryService({
    db,
    media: {},
    jobs: { isBusy: () => false, start() {}, list: () => [], cancel() {} },
    paths: { dataDir: require("os").tmpdir(), backupsDir: require("os").tmpdir() },
    logger: { log() {}, warn() {}, error() {} },
  });
  for (const name of Object.keys(WORKER_METHODS)) assert.equal(typeof methods[name], "function", name);

  // Host-only worker methods are never exposed to the renderer.
  for (const name of ["resolvePlayback", "resolvePreview", "resolveArtwork", "addSource", "setArtworkFromPath", "getPaths"]) {
    assert.equal(Object.hasOwn(WORKER_METHODS, name), false, name);
  }
});

test("parameters are validated and unknown keys dropped", () => {
  const schema = WORKER_METHODS.applyEdits;
  const ok = validate(schema, {
    edits: [{ trackId: 3, fields: { title: "Song", year: 2001, evil: "x" } }],
    sql: "DROP TABLE tracks",
  });
  assert.deepEqual(ok, { edits: [{ trackId: 3, fields: { title: "Song", year: 2001 } }] });

  assert.throws(() => validate(schema, { edits: [{ trackId: -1, fields: {} }] }), /invalid/);
  assert.throws(() => validate(schema, { edits: [{ trackId: 1, fields: { year: "2001; DROP" } }] }), /invalid/);
  assert.throws(() => validate(WORKER_METHODS.getTrack, {}), /required/);
  assert.throws(() => validate(WORKER_METHODS.listTracks, { direction: "sideways" }), /invalid/);
  assert.throws(() => validate(WORKER_METHODS.setReviewStatus, { ids: [1], status: "deleted" }), /invalid/);
});
