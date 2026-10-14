const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const { createAudioEditor } = require("../electron/library/audioedit.cjs");
const { ARCHIVE_DIR, createConsolidator } = require("../electron/library/consolidate.cjs");
const edits = require("../electron/library/edits.cjs");
const { createImporter } = require("../electron/library/importer.cjs");
const { finishOperation, startOperation } = require("../electron/library/operations.cjs");
const { createStorage, isInsideRoots } = require("../electron/library/storage.cjs");
const { createUpgrader } = require("../electron/library/upgrade.cjs");
const { SKIP_REASON, addAndScan, coverBytes, createTestLibrary, makeTempDir, makeTrack, mediaForTests, quietLogger, snapshotFolder } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };
const DAY = 24 * 60 * 60 * 1000;

test("the path guard only allows strictly inside WaveMint's folders", () => {
  const roots = ["C:\\Data\\WaveMint\\library\\backups", "D:\\Music\\WaveMint Library\\.wavemint-archive"];
  assert.equal(isInsideRoots("C:\\Data\\WaveMint\\library\\backups\\op-3\\song.mp3", roots), true);
  assert.equal(isInsideRoots("d:\\music\\wavemint library\\.wavemint-archive\\upgrades\\a.mp3", roots), true, "case-insensitive");
  assert.equal(isInsideRoots("C:\\Data\\WaveMint\\library\\backups", roots), false, "never the folder itself");
  assert.equal(isInsideRoots("C:\\Data\\WaveMint\\library\\backups2\\x", roots), false, "a sibling with the same prefix");
  assert.equal(isInsideRoots("C:\\Data\\WaveMint\\library\\backups\\..\\wavemint-library.db", roots), false, "no climbing out");
  assert.equal(isInsideRoots("D:\\Music\\WaveMint Library\\Artist\\Album\\01 Song.mp3", roots), false, "never the library's songs");
  assert.equal(isInsideRoots("", roots), false);
});

async function storageLibrary(t, settings = {}) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const managedRoot = path.join(root, "WaveMint Library");
  fs.mkdirSync(managedRoot);
  const dataDir = path.join(makeTempDir(t, "wavemint-data-"), "library");
  const paths = { dataDir, backupsDir: path.join(dataDir, "backups"), stagingDir: path.join(dataDir, "staging"), tempWorkDir: path.join(root, "Temp", "WaveMint") };
  const media = mediaForTests();
  const artStore = createArtStore(path.join(dataDir, "artwork-store"));
  const consolidator = createConsolidator({ db: lib.db, media, artStore, logger: quietLogger });
  consolidator.ensureManagedSource(managedRoot);
  const all = { namingPattern: "{albumArtist}/{album}/{disc-}{track} {title}", lowBitrateKbps: 160, keepPreviousVersions: "3d", autoCleanup: true, ...settings };
  const getSettings = () => all;
  const upgrader = createUpgrader({ db: lib.db, media, artStore, managedSource: consolidator.managedSource, getSettings, logger: quietLogger });
  const importer = createImporter({ db: lib.db, media, artStore, upgrader, managedSource: consolidator.managedSource, getSettings, paths, logger: quietLogger });
  const editor = createAudioEditor({ db: lib.db, media, artStore, upgrader, importer, managedSource: consolidator.managedSource, getSettings, paths, logger: quietLogger });
  const storage = createStorage({ db: lib.db, managedSource: consolidator.managedSource, getSettings, paths, importer, logger: quietLogger });
  const bin = makeTempDir(t, "wavemint-bin-");

  // What the main process does with a plan (Recycle Bin = the `bin` folder).
  const roots = [path.join(managedRoot, ARCHIVE_DIR), ...["backups", "cache", "artwork-store", "staging", "db-backups"].map((name) => path.join(dataDir, name)), paths.tempWorkDir];
  async function cleanUp({ now, categories } = {}) {
    const { actions } = await storage.plan({ now, categories });
    const results = actions.map((action) => {
      if (!isInsideRoots(action.path, roots)) return { ...action, ok: false, error: "outside" };
      if (action.action === "trash") fs.renameSync(action.path, path.join(bin, `${Math.random()}-${path.basename(action.path)}`));
      else fs.rmSync(action.path, { recursive: true, force: true });
      return { ...action, ok: true };
    });
    return { actions, summary: storage.finish({ results, now }) };
  }

  async function addSong(title) {
    const { token, folder } = editor.prepareExtraction();
    makeTrack(folder, `${title}.mp3`, { base: "noise_320", tags: { title, artist: "Band", album: "Record" }, cover: "teal" });
    return (await editor.commitExtraction({ token })).trackId;
  }
  return { ...lib, root, managedRoot, dataDir, paths, artStore, upgrader, importer, editor, storage, cleanUp, addSong, bin };
}

const activePath = (db, trackId) => db.prepare("SELECT f.path FROM tracks t JOIN files f ON f.id = t.active_file_id WHERE t.id = ?").get(trackId).path;

test("previous versions are kept for the retention period, then cleaned up and their undo retired", needsAudio, async (t) => {
  const lib = await storageLibrary(t);
  const trackId = await lib.addSong("Keeper");
  await lib.editor.editTrackJob({ trackId, edits: { startMs: 500 } });
  await lib.editor.editTrackJob({ trackId, edits: { startMs: 500 } });
  const archived = lib.db.prepare("SELECT id, path FROM files WHERE track_id = ? AND role = 'archived'").all(trackId);
  assert.equal(archived.length, 2);
  const current = activePath(lib.db, trackId);
  const edits2 = lib.db.prepare("SELECT id FROM operations WHERE kind = 'upgrade' ORDER BY id").all().map((row) => row.id);

  // Within the retention period nothing is planned.
  const now = Date.now();
  assert.equal((await lib.storage.plan({ now })).actions.filter((action) => action.category === "versions").length, 0);
  const report = await lib.storage.report({ now });
  assert.ok(report.categories.find((item) => item.id === "versions").bytes > 0);
  assert.equal(report.categories.find((item) => item.id === "library").kept, true);

  // Four days later both previous versions go (to the "Recycle Bin").
  const { actions, summary } = await lib.cleanUp({ now: now + 4 * DAY });
  const versions = actions.filter((action) => action.category === "versions");
  assert.deepEqual(versions.map((action) => action.path).sort(), archived.map((row) => row.path).sort());
  assert.ok(versions.every((action) => action.action === "trash"));
  assert.ok(fs.existsSync(current), "the song's current file stays");
  assert.ok(!versions.some((action) => action.path === current));
  assert.equal(summary.removed.versions, 2);
  assert.ok(summary.freedBytes > 0);
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM files WHERE track_id = ? AND role = 'archived'").get(trackId).n, 0);
  for (const id of edits2) {
    const operation = lib.db.prepare("SELECT undoable, summary FROM operations WHERE id = ?").get(id);
    assert.equal(operation.undoable, 0, "the edit can no longer be undone");
    assert.match(JSON.parse(operation.summary).expired.reason, /cleaned up/);
  }
  assert.equal(lib.db.prepare("SELECT state FROM tracks WHERE id = ?").get(trackId).state, "active");
});

test("songs from the user's own folders, and files in use, are never planned", needsAudio, async (t) => {
  const lib = await storageLibrary(t, { keepPreviousVersions: "1d" });
  const legacy = path.join(lib.root, "Legacy");
  makeTrack(legacy, "Band/Old.mp3", { tags: { title: "Old", artist: "Band" } });
  await addAndScan(lib.db, lib.scanner, legacy, { role: "legacy" });
  const legacyTrack = lib.db.prepare("SELECT id FROM tracks WHERE title = 'Old'").get().id;
  await lib.editor.editTrackJob({ trackId: legacyTrack, edits: { startMs: 500 } });
  const before = snapshotFolder(legacy);

  const { actions } = await lib.cleanUp({ now: Date.now() + 365 * DAY });
  assert.deepEqual(snapshotFolder(legacy), before, "the legacy folder is untouched");
  assert.ok(actions.every((action) => !action.path.startsWith(legacy)));
  assert.ok(fs.existsSync(activePath(lib.db, legacyTrack)));
  // The original in the legacy folder is still the song's earlier version.
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM files WHERE track_id = ? AND role = 'archived'").get(legacyTrack).n, 1);
});

test("retention 'never' keeps previous versions and backups", needsAudio, async (t) => {
  const lib = await storageLibrary(t, { keepPreviousVersions: "never" });
  const trackId = await lib.addSong("Forever");
  await lib.editor.editTrackJob({ trackId, edits: { startMs: 500 } });
  const { actions } = await lib.storage.plan({ now: Date.now() + 1000 * DAY });
  assert.equal(actions.filter((action) => ["versions", "tagBackups"].includes(action.category)).length, 0);
});

test("unused artwork is cleaned up; artwork in use or still needed for undo stays", needsAudio, async (t) => {
  const lib = await storageLibrary(t);
  const trackId = await lib.addSong("Covered");
  const old = Date.now() / 1000 - 2 * 86400;
  const unused = lib.artStore.save(coverBytes("red")).hash; // e.g. an unapplied MusicBrainz cover
  const first = lib.artStore.save(coverBytes("navy")).hash;
  const second = lib.artStore.save(coverBytes("purple")).hash;
  edits.setTrackArtwork(lib.db, [trackId], first);
  edits.setTrackArtwork(lib.db, [trackId], second); // replaces "first" (undoable)
  for (const hash of [unused, first, second]) fs.utimesSync(lib.artStore.locate(hash).path, old, old);

  const now = Date.now();
  let planned = (await lib.storage.plan({ now })).actions.filter((action) => action.category === "artwork").map((action) => action.ref?.hash);
  assert.deepEqual(planned, [unused], "replaced artwork is kept while its change can be undone");

  // After the retention period the replaced cover goes too, and its undo is retired.
  const { summary } = await lib.cleanUp({ now: now + 4 * DAY, categories: ["artwork"] });
  assert.equal(summary.removed.artwork, 2);
  assert.ok(lib.artStore.locate(second), "the cover in use stays");
  assert.equal(lib.artStore.locate(first), null);
  const replacing = lib.db.prepare("SELECT undoable FROM operations WHERE kind = 'artwork' ORDER BY id DESC LIMIT 1").get();
  assert.equal(replacing.undoable, 0);
  planned = (await lib.storage.plan({ now: now + 10 * DAY })).actions.filter((action) => action.category === "artwork");
  assert.equal(planned.length, 0);
});

test("tag-write backups, stale caches, abandoned imports and old database backups", needsAudio, async (t) => {
  const lib = await storageLibrary(t);
  const now = Date.now();
  const trackId = await lib.addSong("Cached");
  const fileId = lib.db.prepare("SELECT active_file_id AS id FROM tracks WHERE id = ?").get(trackId).id;
  const file = lib.db.prepare("SELECT mtime_ms FROM files WHERE id = ?").get(fileId);
  const write = (target, bytes = 1000, ageDays = 2) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(bytes));
    const time = (now - ageDays * DAY) / 1000;
    fs.utimesSync(target, time, time);
    return target;
  };

  // A Write Tags backup from 5 days ago.
  const operationId = startOperation(lib.db, { kind: "tag-write", label: "Write tags to 1 file" });
  finishOperation(lib.db, operationId, "completed", {});
  lib.db.prepare("UPDATE operations SET created_at = ?, finished_at = ? WHERE id = ?").run(new Date(now - 5 * DAY).toISOString(), new Date(now - 5 * DAY).toISOString(), operationId);
  write(path.join(lib.paths.backupsDir, `op-${operationId}`, "1-Cached.mp3"), 5000);

  // Playable copies: one of a song that no longer exists, one in use.
  const stale = write(path.join(lib.dataDir, "cache", "previews", `99999-123.flac`), 4000);
  const fresh = write(path.join(lib.dataDir, "cache", "previews", `${fileId}-${Math.round(file.mtime_ms)}.flac`), 4000, 0);
  const oldSpectrum = write(path.join(lib.dataDir, "cache", "spectra", "f99999-1.png"), 100);

  // An album import left open 10 days ago, with its extracted files.
  const session = lib.importer.startSession({ title: "Old import", entries: [{ key: "a", title: "A" }] });
  lib.db.prepare("UPDATE import_sessions SET created_at = ? WHERE id = ?").run(new Date(now - 10 * DAY).toISOString(), session.id);
  const { folder } = lib.importer.prepareStaging({ sessionId: session.id, entryKey: "a" });
  write(path.join(folder, "A.mp3"), 3000);

  // Five database backups: the newest three stay.
  const dbBackups = [1, 2, 3, 4, 5].map((day) => write(path.join(lib.dataDir, "db-backups", `library-v${day}.db`), 200, day));

  const plan = await lib.storage.plan({ now });
  const byCategory = (category) => plan.actions.filter((action) => action.category === category);
  assert.deepEqual(byCategory("tagBackups").map((action) => action.ref.operationId), [operationId]);
  assert.deepEqual(byCategory("playback").map((action) => action.path), [stale], "the copy in use stays");
  assert.deepEqual(byCategory("caches").map((action) => action.path), [oldSpectrum]);
  assert.deepEqual(byCategory("dbBackups").map((action) => path.basename(action.path)).sort(), ["library-v4.db", "library-v5.db"]);
  assert.ok(byCategory("dbBackups").every((action) => action.action === "trash"));
  const abandoned = byCategory("temporary");
  assert.deepEqual(abandoned.map((action) => action.ref.sessionId), [session.id]);

  const { summary } = await lib.cleanUp({ now });
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(dbBackups[0]) && fs.existsSync(dbBackups[2]) && !fs.existsSync(dbBackups[4]));
  assert.equal(lib.db.prepare("SELECT undoable FROM operations WHERE id = ?").get(operationId).undoable, 0);
  assert.equal(lib.db.prepare("SELECT status FROM import_sessions WHERE id = ?").get(session.id).status, "discarded");
  assert.ok(!fs.existsSync(folder));
  assert.equal(summary.failed, 0);
  assert.ok(fs.existsSync(activePath(lib.db, trackId)), "the song itself is untouched");
});
