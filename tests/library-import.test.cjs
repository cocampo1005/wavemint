const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const { ARCHIVE_DIR, createConsolidator } = require("../electron/library/consolidate.cjs");
const { createImporter } = require("../electron/library/importer.cjs");
const queries = require("../electron/library/queries.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { createUpgrader } = require("../electron/library/upgrade.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, makeTempDir, makeTrack, mediaForTests, quietLogger, snapshotFolder } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };
const TITLES = ["Opening", "Second Song", "Owned Already", "Finale"];

async function importLibrary(t) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const legacy = path.join(root, "Legacy");
  // The one song of the album the user already owns (an old 128 kbps copy).
  makeTrack(legacy, "Band/Record/03 Owned Already.mp3", { base: "noise_128", tags: { title: "Owned Already", artist: "Band", album: "Record", trackNo: 3, genre: "Indie" } });
  await addAndScan(lib.db, lib.scanner, legacy, { role: "legacy" });

  const managedRoot = path.join(root, "WaveMint Library");
  fs.mkdirSync(managedRoot);
  const media = mediaForTests();
  const artStore = createArtStore(makeTempDir(t, "wavemint-art-"));
  const consolidator = createConsolidator({ db: lib.db, media, artStore, logger: quietLogger });
  consolidator.ensureManagedSource(managedRoot);
  const settings = { namingPattern: "{albumArtist}/{album}/{disc-}{track} {title}", lowBitrateKbps: 160 };
  const upgrader = createUpgrader({ db: lib.db, media, artStore, managedSource: consolidator.managedSource, getSettings: () => settings, logger: quietLogger });
  const dataDir = makeTempDir(t, "wavemint-data-");
  const importer = createImporter({
    db: lib.db,
    media,
    artStore,
    upgrader,
    managedSource: consolidator.managedSource,
    getSettings: () => settings,
    paths: { stagingDir: path.join(dataDir, "staging") },
    logger: quietLogger,
  });

  const entries = TITLES.map((title, index) => ({ key: `vid${index}`, title, artist: "Band", album: "Record", genre: "", durationMs: 6000 }));
  // What the main process does for each extraction: save the finished MP3
  // in the entry's staging folder and hand it over.
  async function extract(sessionId, entryKey, { base = "noise_320", tags = {} } = {}) {
    const { folder } = importer.prepareStaging({ sessionId, entryKey });
    const entry = entries.find((item) => item.key === entryKey);
    const file = makeTrack(folder, `${entry.title}.mp3`, { base, tags: { title: entry.title, artist: entry.artist, album: entry.album, ...tags }, cover: "teal" });
    return importer.addStaged({ sessionId, entryKey, filePath: file });
  }
  return { ...lib, legacy, managedRoot, importer, upgrader, entries, extract, dataDir };
}

test("playlist entries are matched against the library before anything is downloaded", needsAudio, async (t) => {
  const lib = await importLibrary(t);
  const session = lib.importer.startSession({ title: "Band - Record (Full Album)", url: "https://example.invalid/playlist", entries: lib.entries });
  assert.deepEqual(session.items.map((item) => item.match.status), ["new", "new", "existing", "new"]);
  assert.deepEqual(session.items.map((item) => item.action), ["add", "add", "compare", "add"]);
  const owned = session.items[2].match;
  assert.equal(owned.quality, "MP3 128 kbps");
  assert.ok(!/better/i.test(JSON.stringify(owned)), "nothing is claimed about quality before downloading");

  // Edited details in the Extract view are matched again.
  const renamed = lib.importer.updateSession({ sessionId: session.id, entries: [{ key: "vid0", title: "Owned Already", artist: "Band" }] });
  assert.equal(renamed.items[0].match.status, "existing");
  assert.equal(renamed.items[0].action, "compare");
});

test("a full album import adds the new songs, upgrades the owned one, and can be undone", needsAudio, async (t) => {
  const lib = await importLibrary(t);
  const legacyBefore = snapshotFolder(lib.legacy);
  const session = lib.importer.startSession({ title: "Band - Record", entries: lib.entries });
  lib.importer.updateSession({ sessionId: session.id, albumFields: { album: "Record", albumArtist: "Band", year: 2021, genre: "Indie", numberTracks: true, artworkKey: "vid0" } });

  for (const entry of lib.entries) await lib.extract(session.id, entry.key);
  const staged = lib.importer.view(session.id);
  assert.ok(staged.items.every((item) => item.status === "staged" && item.staged.intact));
  const owned = staged.items[2];
  assert.ok(owned.candidateId, "the owned song gets an upgrade candidate");
  assert.equal(owned.staged.comparison.verdict, "same");
  assert.equal(owned.staged.comparison.current, "MP3 128 kbps");
  assert.equal(owned.staged.comparison.candidate, "MP3 320 kbps");
  assert.equal(staged.items[0].staged.libraryMatch.status, "new");

  const decisions = staged.items.map((item) => ({ itemId: item.id, decision: item.candidateId ? "upgrade" : "add" }));
  const report = await lib.importer.commitJob({ sessionId: session.id, decisions });
  assert.deepEqual({ added: report.added, upgraded: report.upgraded, skipped: report.skipped, failed: report.failed }, { added: 3, upgraded: 1, skipped: 0, failed: 0 });
  assert.deepEqual(snapshotFolder(lib.legacy), legacyBefore, "the legacy file is untouched");
  assert.equal(fs.existsSync(path.join(lib.dataDir, "staging", "imports", `session-${session.id}`)), false, "staging is cleaned up");

  // The album is complete, in playlist order, with album-level details.
  const albumTracks = lib.db
    .prepare("SELECT title, track_no, track_total, year, album_artist, genre FROM tracks WHERE state = 'active' AND album = 'Record' ORDER BY track_no")
    .all();
  assert.deepEqual(albumTracks.map((row) => row.title), ["Opening", "Second Song", "Owned Already", "Finale"]);
  const added = albumTracks.filter((row) => row.title !== "Owned Already");
  assert.ok(added.every((row) => row.track_total === 4 && row.year === 2021 && row.album_artist === "Band" && row.genre === "Indie"));
  const ownedTrack = lib.db.prepare("SELECT * FROM tracks WHERE title = 'Owned Already' AND state = 'active'").get();
  assert.equal(ownedTrack.quality_status, "upgraded");
  assert.equal(ownedTrack.track_no, 3, "the upgraded song keeps its curated details");
  assert.equal(queries.listTracks(lib.db, {}).total, 4);

  const finale = path.join(lib.managedRoot, "Band", "Record", "04 Finale.mp3");
  assert.equal(readTags(finale).year, 2021);
  assert.equal(readTags(finale).trackTotal, 4);

  lib.importer.undoImport(report.operationId);
  assert.equal(queries.listTracks(lib.db, {}).total, 1);
  const remaining = Object.keys(snapshotFolder(lib.managedRoot)).filter((name) => !name.startsWith(ARCHIVE_DIR));
  assert.deepEqual(remaining, [path.join("Band", "Record", "03 Owned Already.mp3")], "only the upgrade (undone separately) stays");
});

test("keep, skip and failed extractions are reported, and nothing outside staging is accepted", needsAudio, async (t) => {
  const lib = await importLibrary(t);
  const session = lib.importer.startSession({ title: "Record", entries: lib.entries });
  const [first, second, owned, last] = session.items;
  lib.importer.updateSession({ sessionId: session.id, actions: [{ itemId: last.id, action: "skip" }] });
  assert.throws(() => lib.importer.prepareStaging({ sessionId: session.id, entryKey: "vid3" }), /isn't set to be imported/);

  await lib.extract(session.id, "vid0");
  // A damaged extraction fails its integrity check.
  const { folder } = lib.importer.prepareStaging({ sessionId: session.id, entryKey: "vid1" });
  const damaged = makeTrack(folder, "Second Song.mp3", { base: "noise_320", tags: { title: "Second Song", artist: "Band" } });
  const bytes = fs.readFileSync(damaged);
  for (let i = Math.floor(bytes.length * 0.4); i < Math.floor(bytes.length * 0.7); i += 1) bytes[i] = (i * 31) & 255;
  fs.writeFileSync(damaged, bytes);
  const failed = await lib.importer.addStaged({ sessionId: session.id, entryKey: "vid1", filePath: damaged });
  assert.equal(failed.status, "failed");
  await lib.extract(session.id, "vid2");

  const outside = makeTrack(makeTempDir(t, "wavemint-elsewhere-"), "x.mp3", { tags: { title: "x" } });
  await assert.rejects(lib.importer.addStaged({ sessionId: session.id, entryKey: "vid0", filePath: outside }), /staging folder/);

  const report = await lib.importer.commitJob({
    sessionId: session.id,
    decisions: [
      { itemId: first.id, decision: "add" },
      { itemId: owned.id, decision: "keep_existing" },
    ],
  });
  assert.equal(report.added, 1);
  assert.equal(report.kept, 1);
  assert.equal(report.skipped, 2, "the failed and the skipped entry");
  assert.equal(second.id && lib.importer.view(session.id).items[1].status, "failed");
  assert.equal(queries.listTracks(lib.db, {}).total, 2);
});
