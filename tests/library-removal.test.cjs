const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const edits = require("../electron/library/edits.cjs");
const playlists = require("../electron/library/playlists.cjs");
const queries = require("../electron/library/queries.cjs");
const { createRemoval } = require("../electron/library/removal.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, makeTempDir, makeTrack, snapshotFolder } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

async function library(t) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const legacy = path.join(root, "Legacy");
  const writable = path.join(root, "Writable");
  makeTrack(legacy, "A/One.mp3", { tags: { title: "One", artist: "Alpha", album: "First", genre: "Rock" } });
  makeTrack(legacy, "A/Two.mp3", { tags: { title: "Two", artist: "Alpha", album: "First", genre: "Rock" } });
  makeTrack(writable, "B/Three.mp3", { tags: { title: "Three", artist: "Beta", album: "Second", genre: "Jazz" }, cover: "navy" });
  makeTrack(writable, "B/Four.mp3", { tags: { title: "Four", artist: "Beta", album: "Second", genre: "" } });
  const legacyId = await addAndScan(lib.db, lib.scanner, legacy, { role: "legacy" });
  const writableId = await addAndScan(lib.db, lib.scanner, writable, { role: "other", writable: true });
  const id = (title) => lib.db.prepare("SELECT id FROM tracks WHERE title = ?").get(title).id;
  // Distinct "added" times, in this order.
  ["One", "Two", "Three", "Four"].forEach((title, index) => lib.db.prepare("UPDATE tracks SET created_at = ? WHERE id = ?").run(`2026-01-0${index + 1}T00:00:00.000Z`, id(title)));
  return { ...lib, legacy, writable, legacyId, writableId, id, removal: createRemoval({ db: lib.db }) };
}

const titles = (rows) => rows.map((row) => row.title);

test("favorites filter and the date-added sorts", needsAudio, async (t) => {
  const lib = await library(t);
  lib.db.prepare("UPDATE tracks SET favorite = 1 WHERE id IN (?, ?)").run(lib.id("Two"), lib.id("Four"));
  assert.deepEqual(titles(queries.listTracks(lib.db, { filters: { favorite: true }, sort: "title" }).rows), ["Four", "Two"]);
  assert.deepEqual(titles(queries.listTracks(lib.db, { sort: "added", direction: "desc" }).rows), ["Four", "Three", "Two", "One"]);
  assert.deepEqual(titles(queries.listTracks(lib.db, { sort: "added", direction: "asc" }).rows), ["One", "Two", "Three", "Four"]);
  assert.equal(queries.listTracks(lib.db, { search: "four", filters: { favorite: true } }).total, 1);
  // Playing a whole list uses the same order.
  assert.deepEqual(queries.listTrackIds(lib.db, { sort: "added", direction: "desc" }), ["Four", "Three", "Two", "One"].map(lib.id));
  assert.equal(queries.listTracks(lib.db, { limit: 1 }).rows[0].favorite, 0);
});

test("the overview shows what the collection is made of", needsAudio, async (t) => {
  const lib = await library(t);
  const overview = queries.getDashboard(lib.db);
  assert.equal(overview.totals.tracks, 4);
  assert.deepEqual(
    overview.genres.map((genre) => [genre.name, genre.count]),
    [
      ["Rock", 2],
      ["Jazz", 1],
      ["", 1],
    ],
  );
  assert.deepEqual(titles(overview.recent), ["Four", "Three", "Two", "One"]);
  assert.deepEqual(
    overview.topArtists.map((artist) => [artist.name, artist.track_count]),
    [
      ["Alpha", 2],
      ["Beta", 2],
    ],
  );
  assert.equal(overview.formats, undefined, "file formats are no longer part of the overview");
});

test("Remove from Library hides the song, leaves files alone, survives a rescan and can be undone", needsAudio, async (t) => {
  const lib = await library(t);
  const before = snapshotFolder(lib.legacy);
  const { id: playlistId } = playlists.createPlaylist(lib.db, { name: "Mix", trackIds: [lib.id("One"), lib.id("Three")] });

  const result = lib.removal.removeFromLibrary({ trackIds: [lib.id("One")] });
  assert.equal(result.removed, 1);
  assert.equal(queries.listTracks(lib.db, {}).total, 3);
  assert.deepEqual(titles(playlists.getPlaylist(lib.db, { id: playlistId }).tracks), ["Three"]);
  assert.deepEqual(snapshotFolder(lib.legacy), before, "files are untouched");

  await lib.scanner.scanSource(lib.legacyId);
  assert.equal(queries.listTracks(lib.db, {}).total, 3, "a rescan doesn't bring it back");

  edits.undoMetadataOperation(lib.db, result.operationId);
  assert.equal(queries.listTracks(lib.db, {}).total, 4);
  assert.deepEqual(titles(playlists.getPlaylist(lib.db, { id: playlistId }).tracks), ["One", "Three"], "it returns to its playlist");
});

test("Delete File only plans the songs' own files in folders WaveMint may change", needsAudio, async (t) => {
  const lib = await library(t);
  const plan = lib.removal.deletionPlan({ trackIds: [lib.id("One"), lib.id("Three")], withPaths: true });
  assert.deepEqual(
    plan.blocked.map((item) => item.title),
    ["One"],
    "files in a read-only folder are never deleted",
  );
  assert.equal(plan.items.length, 1);
  assert.deepEqual(
    plan.items[0].files.map((file) => file.name),
    ["Three.mp3"],
  );
  const preview = lib.removal.deletionPlan({ trackIds: [lib.id("Three")] });
  assert.equal(preview.items[0].files[0].path, undefined, "the renderer never gets paths from the preview");

  // What the main process does: move the file to the Recycle Bin.
  const target = plan.items[0].files[0];
  fs.rmSync(target.path);
  const done = lib.removal.finishDeletion({ results: [{ trackId: lib.id("Three"), trashed: [target.fileId], missing: [], failed: [] }] });
  assert.deepEqual(done, { deleted: 1, trackIds: [lib.id("Three")], failures: [] });
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM files WHERE id = ?").get(target.fileId).n, 0);
  assert.equal(lib.db.prepare("SELECT state FROM tracks WHERE id = ?").get(lib.id("Three")).state, "removed");
  assert.ok(fs.existsSync(path.join(lib.writable, "B", "Four.mp3")), "other songs' files stay");
  assert.equal(queries.listTracks(lib.db, {}).total, 3);

  // A file that couldn't be moved keeps its song in the library.
  const failed = lib.removal.finishDeletion({ results: [{ trackId: lib.id("Four"), trashed: [], missing: [], failed: [{ name: "Four.mp3", error: "busy" }] }] });
  assert.equal(failed.deleted, 0);
  assert.equal(failed.failures.length, 1);
  assert.equal(lib.db.prepare("SELECT state FROM tracks WHERE id = ?").get(lib.id("Four")).state, "active");
  const history = lib.db.prepare("SELECT kind, status, undoable FROM operations ORDER BY id").all().map((row) => `${row.kind}:${row.status}:${row.undoable}`);
  assert.deepEqual(history, ["delete:completed:0", "delete:failed:0"]);
});
