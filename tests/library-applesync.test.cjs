// Apple library synchronization (direct reference): the sync engine against
// an in-memory iTunes (tests/apple-fake.cjs) and synthetic libraries in temp
// folders. Nothing here touches a real iTunes or a real music library. How
// the real iTunes COM interface behaves is covered by docs/APPLE_SYNC.md
// ("What is verified").

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const edits = require("../electron/library/edits.cjs");
const { createAppleMigration } = require("../electron/library/applemigrate.cjs");
const { createAppleSync } = require("../electron/library/applesync.cjs");
const { createExporter } = require("../electron/library/exporter.cjs");
const { createFileOps } = require("../electron/library/fileops.cjs");
const formats = require("../electron/library/formats.cjs");
const playlists = require("../electron/library/playlists.cjs");
const queries = require("../electron/library/queries.cjs");
const { createRemoval } = require("../electron/library/removal.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { SKIP_REASON, addAndScan, coverBytes, createTestLibrary, makeTempDir, makeTrack, mediaForTests, quietLogger, snapshotFolder } = require("./library-fixtures.cjs");
const { createFakeItunes } = require("./apple-fake.cjs");

const needsAudio = { skip: SKIP_REASON };

const LOSSY = [
  ["A/One/01 Alpha.mp3", { tags: { title: "Alpha", artist: "A", album: "One", genre: "Rock", year: 1999, trackNo: 1 }, cover: "navy" }],
  ["A/One/02 Beta.m4a", { base: "m4a", tags: { title: "Beta", artist: "A", album: "One", genre: "Rock", year: 1999, trackNo: 2 } }],
  ["B/Two/02 Café Δ.mp3", { tags: { title: "Café Δ", artist: "B", album: "Two", genre: "Jazz", year: 2015, trackNo: 2 } }],
];
const FLAC = ["B/Two/01 Gamma.flac", { base: "flac", tags: { title: "Gamma", artist: "B", album: "Two", genre: "Jazz", year: 2015, trackNo: 1 }, cover: "teal" }];

/**
 * A writable curated library (by default three MP3/AAC songs and one FLAC),
 * a not-yet-created compatibility cache and a fake iTunes.
 */
async function harness(t, { fake = {}, flac = true, songs = null, settings = {} } = {}) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const music = path.join(root, "Music");
  const list = songs ? Array.from({ length: songs }, (_, index) => [`A/Song ${index + 1}.mp3`, { tags: { title: `Song ${index + 1}`, artist: "A", album: "Many", genre: "Rock", trackNo: index + 1 } }]) : [...LOSSY, ...(flac ? [FLAC] : [])];
  for (const [relPath, options] of list) makeTrack(music, relPath, options);
  await addAndScan(lib.db, lib.scanner, music, { role: "curated", writable: true });

  const itunesDir = makeTempDir(t, "wavemint-itunes-");
  fs.writeFileSync(path.join(itunesDir, "iTunes Library.itl"), "fake database");
  const cache = path.join(makeTempDir(t, "wavemint-data-"), "apple-compat");
  const media = mediaForTests();
  const counters = { conversions: 0, failConversionFor: null };
  const convert = media.convertToAlac;
  media.convertToAlac = async (input, ...rest) => {
    counters.conversions += 1;
    if (counters.failConversionFor && input.includes(counters.failConversionFor)) throw new Error("The conversion to Apple Lossless failed");
    return convert(input, ...rest);
  };
  const artStore = createArtStore(makeTempDir(t, "wavemint-art-"));
  const fileOps = createFileOps({ db: lib.db, media, artStore, backupsRoot: makeTempDir(t, "wavemint-backups-"), logger: quietLogger });
  const config = { appleRemovalPolicy: "confirm", ...settings };
  const exporter = createExporter({ db: lib.db, media, artStore, getSettings: () => config, logger: quietLogger });
  const itunes = createFakeItunes({ libraryDir: itunesDir, ...fake });
  const sync = createAppleSync({ db: lib.db, exporter, getAdapter: () => itunes, getSettings: () => config, getLibraryRoot: () => music, defaultCacheRoot: cache, logger: quietLogger });
  const migration = createAppleMigration({ db: lib.db, sync, getAdapter: () => itunes, paths: { dataDir: makeTempDir(t, "wavemint-data-") }, logger: quietLogger });
  const id = (title) => lib.db.prepare("SELECT id FROM tracks WHERE title = ?").get(title).id;
  const row = (title) => sync.rowsFor(itunes.state.libraryId).get(id(title));
  const master = (title) => lib.db.prepare("SELECT f.path FROM tracks t JOIN files f ON f.id = t.active_file_id WHERE t.title = ?").get(title).path;
  const synced = (extra = {}) => sync.run({ mode: "manual", ...extra });
  // WaveMint's own save: the edit, then the tags written into the song's file.
  const save = async (list) => {
    edits.applyEdits(lib.db, list);
    const written = await fileOps.writeTagsJob({ trackIds: list.map((edit) => edit.trackId) });
    assert.equal(written.written, list.length, "the edit was saved into the file");
  };
  return { ...lib, root, music, cache, itunesDir, itunes, sync, migration, exporter, fileOps, config, artStore, counters, id, row, master, synced, save };
}

const entryFor = (h, title) => h.itunes.state.tracks.get(h.row(title).pid);
const doNothing = (report) => {
  for (const key of ["added", "adopted", "updated", "relinked", "recreated", "removed", "unmanaged", "playlists"]) assert.equal(report[key], 0, key);
  assert.equal(report.failed.length, 0);
};

test("MP3 and AAC songs are played from the library's own files: nothing is copied or converted, and a second sync does nothing", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  const before = snapshotFolder(h.music);
  const first = await h.synced();
  assert.equal(first.status, "completed");
  assert.equal(first.added, 3);
  assert.equal(h.itunes.state.tracks.size, 3);
  for (const title of ["Alpha", "Beta", "Café Δ"]) {
    assert.equal(entryFor(h, title).location, h.master(title), `${title}: iTunes plays the library file itself`);
    assert.equal(h.row(title).mode, "direct");
    assert.equal(h.row(title).target_path, h.master(title));
  }
  assert.equal(h.row("Beta").format, "aac");
  assert.equal(h.counters.conversions, 0);
  assert.equal(fs.existsSync(h.cache), false, "no compatibility cache is created when nothing needs converting");
  assert.deepEqual(snapshotFolder(h.music), before, "sync didn't write, move or copy a single library file");
  assert.equal(h.sync.meta().baselineDone, true);

  h.itunes.clearCalls();
  const runs = h.db.prepare("SELECT COUNT(*) AS n FROM apple_sync_runs").get().n;
  doNothing(await h.synced());
  assert.deepEqual(h.itunes.mutations(), []);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM apple_sync_runs").get().n, runs);
  assert.deepEqual(snapshotFolder(h.music), before);
  const status = h.sync.status();
  assert.equal(status.counts.unchanged, 3);
  assert.equal(status.counts.converted, 0);
  assert.equal(status.syncMode, "direct");
  assert.equal(status.libraryRoot, h.music);
  assert.equal(status.cache.files, 0);
});

test("the audio codec, not the extension, decides what iTunes can play", () => {
  const check = (codec, ext, options) => formats.appleCompatibility({ codec, ext }, options).mode;
  assert.equal(check("mp3", ".mp3"), "direct");
  assert.equal(check("aac", ".m4a"), "direct");
  assert.equal(check("alac", ".m4a"), "direct", "Apple Lossless in .m4a plays as it is");
  assert.equal(check("aac", ".mp3"), "unsupported", "a mislabelled file isn't trusted");
  assert.equal(check("mp3", ".m4a"), "unsupported");
  assert.equal(check("aac", ".aac"), "unsupported");
  assert.equal(check("flac", ".flac"), "convert");
  assert.equal(check("pcm", ".wav"), "convert");
  assert.equal(check("pcm", ".wav", { convertWavAiff: false }), "direct");
  assert.equal(check("vorbis", ".ogg"), "unsupported");
  assert.equal(check(null, ".mp3"), "unsupported");
});

test("only a FLAC song gets a converted copy; it is reused, and saved tag changes don't convert again", needsAudio, async (t) => {
  const h = await harness(t);
  const first = await h.synced();
  assert.equal(first.added, 4);
  assert.equal(h.counters.conversions, 1, "only the FLAC song was converted");
  const gamma = entryFor(h, "Gamma");
  assert.ok(gamma.location.startsWith(h.cache), "the FLAC song plays a converted copy in the cache");
  assert.equal(readTags(gamma.location).codec, "alac");
  assert.equal(h.row("Gamma").mode, "converted");
  assert.equal(entryFor(h, "Alpha").location, h.master("Alpha"));
  assert.equal(h.sync.status().cache.files, 1);
  assert.equal(h.sync.status().counts.converted, 1);

  // A saved tag change: the copy is re-tagged, not converted again; same iTunes entry.
  const pid = h.row("Gamma").pid;
  await h.save([{ trackId: h.id("Gamma"), fields: { title: "Gamma (Live)" } }]);
  const updated = await h.synced();
  assert.equal(updated.updated, 1);
  assert.equal(h.counters.conversions, 1);
  assert.equal(h.row("Gamma (Live)").pid, pid);
  assert.equal(entryFor(h, "Gamma (Live)").name, "Gamma (Live)");
  doNothing(await h.synced());
  assert.equal(h.counters.conversions, 1);
});

test("saved metadata and artwork changes refresh the same iTunes entry; unsaved ones wait", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  const pid = h.row("Alpha").pid;

  await h.save([{ trackId: h.id("Alpha"), fields: { album: "One (Remastered)", genre: "Classic Rock", year: 2001 } }]);
  h.itunes.clearCalls();
  const report = await h.synced();
  assert.equal(report.updated, 1);
  assert.deepEqual(h.itunes.mutations().map((call) => call.name), ["update"]);
  assert.equal(h.row("Alpha").pid, pid);
  assert.equal(entryFor(h, "Alpha").genre, "Classic Rock");
  assert.equal(entryFor(h, "Alpha").album, "One (Remastered)");
  assert.equal(h.itunes.state.tracks.size, 3);

  // New artwork, saved into the file.
  const { hash } = h.artStore.save(coverBytes("red"));
  edits.setTrackArtwork(h.db, [h.id("Alpha")], hash);
  await h.fileOps.writeTagsJob({ trackIds: [h.id("Alpha")] });
  assert.equal((await h.synced()).updated, 1);
  assert.equal(entryFor(h, "Alpha").artworkCount, 1);
  assert.equal(h.row("Alpha").pid, pid);

  // An edit not yet written into the file isn't sent to iTunes (iTunes reads the file).
  edits.applyEdits(h.db, [{ trackId: h.id("Beta"), fields: { genre: "Folk" } }]);
  assert.equal(h.sync.status().counts.waiting, 1);
  const waiting = await h.synced();
  assert.equal(waiting.updated, 0);
  assert.ok(h.sync.meta().dirtyAt, "the change stays pending");
  await h.fileOps.writeTagsJob({ trackIds: [h.id("Beta")] });
  assert.equal((await h.synced()).updated, 1);
  assert.equal(entryFor(h, "Beta").genre, "Folk");
});

test("a renamed or reorganized library file is relinked in place, even when the old path is gone", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  const pid = h.row("Café Δ").pid;
  const old = h.master("Café Δ");
  // WaveMint moves the file (organizing by a new naming pattern).
  const moved = path.join(h.music, "B", "Two (2015)", "02 - Café Δ.mp3");
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(old, moved);
  h.db.prepare("UPDATE files SET path = ?, path_key = lower(?), rel_path = ? WHERE path = ?").run(moved, moved, path.relative(h.music, moved), old);

  h.itunes.clearCalls();
  const report = await h.synced();
  assert.equal(report.relinked, 1);
  assert.equal(report.added, 0);
  assert.equal(h.row("Café Δ").pid, pid, "same iTunes entry");
  assert.equal(entryFor(h, "Café Δ").location, moved);
  assert.equal(h.itunes.state.tracks.size, 3);
  assert.deepEqual(h.itunes.mutations().map((call) => call.name), ["setLocation"]);
  doNothing(await h.synced());
});

test("an upgrade points the same iTunes entry at the better file, and never touches the old one", needsAudio, async (t) => {
  const h = await harness(t);
  await h.synced();
  const pid = h.row("Alpha").pid;
  const old = h.master("Alpha");
  entryFor(h, "Alpha").rating = 80;

  // A better MP3 replaces the song's file (Upgrade Track).
  const better = makeTrack(h.music, "A/One/01 Alpha [320].mp3", { base: "mp3_320", tags: { title: "Alpha", artist: "A", album: "One", genre: "Rock", year: 1999, trackNo: 1 } });
  await h.scanner.scanSource(h.db.prepare("SELECT id FROM sources").get().id);
  const betterId = h.db.prepare("SELECT id FROM files WHERE path = ?").get(better).id;
  h.db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(betterId, h.id("Alpha"));
  h.db.prepare("UPDATE tracks SET state = 'merged', merged_into = ? WHERE id != ? AND title = 'Alpha'").run(h.id("Alpha"), h.id("Alpha"));
  h.db.prepare("UPDATE files SET track_id = ?, role = 'archived' WHERE path = ?").run(h.id("Alpha"), old);

  const report = await h.synced();
  assert.equal(report.relinked, 1);
  assert.equal(report.recreated, 0);
  assert.equal(h.row("Alpha").pid, pid);
  assert.equal(entryFor(h, "Alpha").location, better);
  assert.equal(entryFor(h, "Alpha").rating, 80, "rating and history stay with the entry");
  assert.ok(fs.existsSync(old), "the previous file is left where it is");
  assert.equal(h.counters.conversions, 1, "only the FLAC song was ever converted");

  // An upgrade to FLAC plays through a converted copy, same entry.
  const flacFile = h.db.prepare("SELECT id FROM files WHERE ext = '.flac'").get().id;
  h.db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(flacFile, h.id("Alpha"));
  const lossless = await h.synced();
  assert.equal(lossless.relinked, 1);
  assert.equal(h.row("Alpha").pid, pid);
  assert.ok(entryFor(h, "Alpha").location.startsWith(h.cache));
  assert.ok(fs.existsSync(better), "the library file is untouched");
});

test("when iTunes can't re-point an entry, replacement needs a go-ahead and carries history and playlists over", needsAudio, async (t) => {
  const h = await harness(t, { flac: false, fake: { locationSettable: false } });
  await h.synced();
  const before = h.row("Alpha");
  Object.assign(h.itunes.state.tracks.get(before.pid), { rating: 100, playedCount: 12 });
  playlists.createPlaylist(h.db, { name: "Faves", trackIds: [h.id("Alpha"), h.id("Beta")] });
  await h.synced();

  const better = makeTrack(h.music, "A/One/01 Alpha [320].mp3", { base: "mp3_320", tags: { title: "Alpha 320", artist: "A" } });
  await h.scanner.scanSource(h.db.prepare("SELECT id FROM sources").get().id);
  h.db.prepare("UPDATE tracks SET active_file_id = (SELECT id FROM files WHERE path = ?) WHERE id = ?").run(better, h.id("Alpha"));
  h.db.prepare("UPDATE tracks SET state = 'removed' WHERE title = 'Alpha 320'").run();

  const held = await h.synced();
  assert.equal(held.recreated, 0);
  assert.ok(held.review >= 1);
  assert.ok(h.itunes.state.tracks.has(before.pid));

  const done = await h.synced({ confirm: { recreate: true } });
  assert.equal(done.recreated, 1);
  assert.equal(h.itunes.state.tracks.size, 3);
  assert.equal(h.itunes.state.tracks.has(before.pid), false);
  const fresh = entryFor(h, "Alpha");
  assert.equal(fresh.location, better);
  assert.equal(fresh.rating, 100);
  assert.equal(fresh.playedCount, 12);
  const playlist = [...h.itunes.state.playlists.values()].find((item) => item.name === "Faves");
  assert.deepEqual(playlist.tracks, [fresh.pid, h.row("Beta").pid]);
  assert.ok(fs.existsSync(h.db.prepare("SELECT path FROM files WHERE ext = '.mp3' AND path LIKE '%01 Alpha.mp3'").get().path), "the previous file is never deleted");
  doNothing(await h.synced());
});

test("removing a song removes only its iTunes entry: the library file always stays", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  const stranger = h.itunes.seed(h.master("Alpha"), { name: "Not mine" });
  await h.synced({ confirm: { baseline: true } });
  const removal = createRemoval({ db: h.db });
  const betaPid = h.row("Beta").pid;
  const betaFile = h.master("Beta");

  removal.removeFromLibrary({ trackIds: [h.id("Beta")] });
  assert.equal((await h.synced()).removed, 0, "the default policy asks first");
  assert.equal((await h.sync.run({ mode: "auto" })).removed, 0, "automatic sync never removes");
  const done = await h.synced({ confirm: { removals: true } });
  assert.equal(done.removed, 1);
  assert.equal(h.itunes.state.tracks.has(betaPid), false);
  assert.ok(fs.existsSync(betaFile), "the master file is still there");
  assert.ok(h.itunes.state.tracks.has(stranger), "an entry WaveMint doesn't manage is untouched");
  assert.equal(fs.existsSync(path.join(h.music, ".wavemint-guard")), false, "the temporary guard name and its folder are gone");

  h.config.appleRemovalPolicy = "keep";
  const cafePid = h.row("Café Δ").pid;
  removal.removeFromLibrary({ trackIds: [h.id("Café Δ")] });
  assert.equal((await h.synced()).unmanaged, 1);
  assert.ok(h.itunes.state.tracks.has(cafePid));
});

test("if iTunes deletes a file along with its entry, WaveMint puts it back and stops removing", needsAudio, async (t) => {
  const h = await harness(t, { flac: false, fake: { deleteRemovesFile: true } });
  await h.synced();
  const removal = createRemoval({ db: h.db });
  const betaFile = h.master("Beta");
  const original = fs.readFileSync(betaFile);
  removal.removeFromLibrary({ trackIds: [h.id("Beta"), h.id("Café Δ")] });
  const report = await h.synced({ confirm: { removals: true } });
  assert.ok(fs.existsSync(betaFile), "the file was put back");
  assert.deepEqual(fs.readFileSync(betaFile), original, "byte for byte");
  assert.ok(report.failed.some((item) => /put the file back/.test(item.error)));
  assert.equal(h.sync.meta().deleteRemovesFiles, true);
  assert.equal(h.sync.status().deleteRemovesFiles, true);
  // Further removals are refused outright.
  const again = await h.synced({ confirm: { removals: true } });
  assert.equal(again.removed, 0);
  assert.ok(fs.existsSync(h.master("Café Δ")));
});

test("if iTunes moves the files it is given, the sync stops after the first few songs", needsAudio, async (t) => {
  const media = makeTempDir(t, "wavemint-itunes-media-");
  const h = await harness(t, { songs: 12, fake: { mediaFolder: media, moveOnAdd: true } });
  const report = await h.synced();
  assert.equal(report.status, "stopped");
  assert.equal(report.code, "itunes-moved-files");
  assert.ok(h.itunes.state.tracks.size <= 5, "stopped after the first small batch");
  assert.equal(h.sync.meta().organizeDetected, true);
});

test("files copied into iTunes' media folder are noticed and pointed back at the library files", needsAudio, async (t) => {
  const media = makeTempDir(t, "wavemint-itunes-media-");
  const h = await harness(t, { flac: false, fake: { mediaFolder: media } });
  await h.synced();
  assert.equal(h.sync.meta().copyDetected, true);
  const fixed = await h.synced();
  assert.equal(fixed.relinked, 3);
  for (const title of ["Alpha", "Beta", "Café Δ"]) assert.equal(entryFor(h, title).location, h.master(title));
});

test("moved files and drift in iTunes are repaired without duplicates; missing files are reported, not removed", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();

  // Someone pointed the iTunes entry at another file: it is pointed back.
  const stray = path.join(h.itunesDir, "stray.mp3");
  fs.copyFileSync(h.master("Alpha"), stray);
  h.itunes.userEdit(h.row("Alpha").pid, { location: stray });
  assert.equal((await h.synced()).relinked, 1);
  assert.equal(entryFor(h, "Alpha").location, h.master("Alpha"));

  // Deleted in iTunes: added again (a small number), never twice.
  h.itunes.userDelete(h.row("Beta").pid);
  assert.equal((await h.synced()).added, 1);
  assert.equal(h.itunes.state.tracks.size, 3);

  // A library file goes missing: the song can't sync, its entry stays.
  const cafePid = h.row("Café Δ").pid;
  fs.renameSync(h.master("Café Δ"), path.join(h.root, "elsewhere.mp3"));
  const report = await h.synced();
  assert.equal(report.removed, 0);
  assert.ok(h.itunes.state.tracks.has(cafePid));
  assert.equal(h.sync.buildPlan({ libraryId: h.itunes.state.libraryId, checkFiles: true }).items.find((item) => item.trackId === h.id("Café Δ")).kind, "blocked");
});

test("details edited in iTunes are never overwritten without a decision", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  const pid = h.row("Alpha").pid;
  h.itunes.userEdit(pid, { name: "Alpha (my edit)" });
  assert.equal((await h.sync.preview({ launch: false })).counts.drift, 1);
  assert.equal((await h.synced()).updated, 0);

  await h.save([{ trackId: h.id("Alpha"), fields: { genre: "Folk" } }]);
  const held = await h.synced();
  assert.equal(held.updated, 0);
  assert.equal(held.review, 1);
  assert.equal((await h.synced({ confirm: { conflicts: true } })).updated, 1);
  assert.equal(entryFor(h, "Alpha").name, "Alpha");
  assert.equal(entryFor(h, "Alpha").genre, "Folk");

  h.itunes.userEdit(pid, { name: "Alpha (again)" });
  await h.sync.acceptItunesDetails([h.id("Alpha")]);
  assert.equal((await h.sync.preview({ launch: false })).counts.drift, 0);
});

test("an unusually large batch of removals needs an extra confirmation", needsAudio, async (t) => {
  const h = await harness(t, { songs: 12, settings: { appleRemovalPolicy: "auto" } });
  // Every song is added in one run, across the small first batch and the next one.
  assert.equal((await h.synced()).added, 12);
  const removal = createRemoval({ db: h.db });
  const active = () => h.db.prepare("SELECT id FROM tracks WHERE state = 'active' ORDER BY id").all().map((item) => item.id);
  removal.removeFromLibrary({ trackIds: active().slice(0, 2) });
  assert.equal((await h.sync.run({ mode: "auto" })).removed, 2, "small batches follow the 'auto' policy");
  removal.removeFromLibrary({ trackIds: active().slice(0, 7) });
  assert.equal((await h.sync.run({ mode: "auto" })).removed, 0);
  assert.equal((await h.synced({ confirm: { removals: true } })).removed, 0);
  assert.equal((await h.synced({ confirm: { removals: true, bulk: true } })).removed, 7);
  assert.equal(h.itunes.state.tracks.size, 3);
  for (const name of fs.readdirSync(path.join(h.music, "A"))) assert.ok(name.endsWith(".mp3"));
  assert.equal(fs.readdirSync(path.join(h.music, "A")).length, 12, "every library file is still there");
});

test("playlists are created, reordered, renamed and deleted without duplicates or touching other playlists", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  h.itunes.state.playlists.set("MINE", { pid: "MINE", name: "My Own List", tracks: [] });
  h.itunes.state.playlists.set("SAME", { pid: "SAME", name: "Road Trip", tracks: [] });
  const list = playlists.createPlaylist(h.db, { name: "Road Trip", trackIds: [] });
  playlists.addTracks(h.db, { id: list.id, trackIds: [h.id("Café Δ"), h.id("Alpha")] });
  await h.synced();
  const managed = () => [...h.itunes.state.playlists.values()].filter((item) => !["MINE", "SAME"].includes(item.pid));
  assert.equal(managed().length, 1);
  assert.equal(managed()[0].name, "Road Trip (WaveMint)");
  assert.deepEqual(managed()[0].tracks, [h.row("Café Δ").pid, h.row("Alpha").pid]);

  h.itunes.clearCalls();
  doNothing(await h.synced());
  assert.deepEqual(h.itunes.mutations(), [], "playlists aren't rebuilt when nothing changed");

  playlists.moveTrack(h.db, { id: list.id, trackId: h.id("Alpha"), toPosition: 1 });
  await h.synced();
  assert.deepEqual(managed()[0].tracks, [h.row("Alpha").pid, h.row("Café Δ").pid]);
  playlists.updatePlaylist(h.db, { id: list.id, name: "Drive" });
  await h.synced();
  assert.equal(managed()[0].name, "Drive");
  playlists.deletePlaylist(h.db, { id: list.id });
  await h.synced();
  assert.equal(managed().length, 1, "deleting needs confirmation");
  await h.synced({ confirm: { removals: true } });
  assert.equal(managed().length, 0);
  assert.equal(h.itunes.state.playlists.size, 2);
});

test("an interrupted sync resumes without duplicates, and failed songs are retried", needsAudio, async (t) => {
  // A previous run added the entries but never saved what it had done.
  const h = await harness(t, { flac: false });
  for (const title of ["Alpha", "Beta", "Café Δ"]) h.itunes.seed(h.master(title));
  const report = await h.synced({ confirm: { baseline: true } });
  assert.equal(report.added, 0);
  assert.equal(report.adopted, 3);
  assert.equal(h.itunes.state.tracks.size, 3);

  // A FLAC song that can't be converted doesn't hold up the others.
  const h2 = await harness(t);
  h2.counters.failConversionFor = "Gamma";
  const partial = await h2.synced();
  assert.equal(partial.status, "partial");
  assert.equal(partial.added, 3);
  h2.counters.failConversionFor = null;
  assert.equal((await h2.synced()).added, 1);
  assert.equal(h2.itunes.state.tracks.size, 4);

  // Repeated failures wait for a manual retry.
  const h3 = await harness(t, { flac: false });
  h3.itunes.state.failAdds = true;
  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await h3.synced()).status, "partial");
  h3.itunes.state.failAdds = false;
  assert.equal((await h3.synced()).added, 0);
  h3.sync.resetFailures();
  assert.equal((await h3.synced()).added, 3);
});

test("when iTunes is closed or unreachable the work is kept and resumes later", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  await h.save([{ trackId: h.id("Alpha"), fields: { genre: "Blues" } }]);
  h.itunes.state.running = false;
  const waiting = await h.sync.run({ mode: "auto" });
  assert.equal(waiting.status, "waiting");
  assert.ok(h.sync.meta().dirtyAt);
  assert.equal(h.sync.status().counts.metadata, 1);
  h.itunes.state.available = false;
  assert.equal((await h.synced()).code, "unavailable");
  h.itunes.state.available = true;
  h.itunes.state.running = true;
  assert.equal((await h.sync.run({ mode: "auto" })).updated, 1);
  assert.equal(entryFor(h, "Alpha").genre, "Blues");
  assert.equal(h.sync.meta().dirtyAt, null);
});

test("entries from the earlier export-folder sync are moved over to the library files, keeping their identity", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  // Before direct reference: iTunes played a copy in an export folder.
  const exportDir = makeTempDir(t, "wavemint-old-export-");
  const copy = path.join(exportDir, "Music", "A", "One", "01 Alpha.mp3");
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(h.master("Alpha"), copy);
  const pid = h.itunes.seed(copy, { rating: 60 });
  h.sync.patchMeta({ libraryId: h.itunes.state.libraryId, baselineDone: true });
  h.sync.saveRow(h.itunes.state.libraryId, h.id("Alpha"), { pid, location: copy, rel_path: path.join("Music", "A", "One", "01 Alpha.mp3"), format: "mp3", file_sig: "old", meta_sig: "old", status: "synced" });
  const columns = h.db.prepare("PRAGMA table_info(apple_sync_tracks)").all().map((column) => column.name);
  assert.ok(["target_path", "mode", "source_file_id"].every((name) => columns.includes(name)));

  const report = await h.synced();
  assert.equal(report.relinked, 1);
  assert.equal(report.added, 2);
  assert.equal(h.row("Alpha").pid, pid, "the same entry, now playing the library file");
  assert.equal(entryFor(h, "Alpha").location, h.master("Alpha"));
  assert.equal(entryFor(h, "Alpha").rating, 60);
  assert.equal(h.itunes.state.tracks.size, 3, "no duplicate");
  assert.ok(fs.existsSync(copy), "the old export copy isn't deleted by sync");
  doNothing(await h.synced());
});

test("a test with a few songs, then the full sync, then verification of an empty iTunes", needsAudio, async (t) => {
  const h = await harness(t, { songs: 8 });
  const ids = h.db.prepare("SELECT id FROM tracks ORDER BY id LIMIT 2").all().map((item) => item.id);
  const preview = await h.sync.preview({ launch: false });
  assert.equal(preview.itunesEmpty, true);
  assert.equal(preview.needsMigration, false);

  const trial = await h.synced({ only: ids });
  assert.equal(trial.added, 2);
  assert.equal(h.itunes.state.tracks.size, 2);
  assert.equal(h.sync.meta().baselineDone, undefined, "a test doesn't count as the first full sync");
  const trialCheck = await h.migration.verify();
  assert.equal(trialCheck.ok, true);
  assert.equal(trialCheck.direct, 2);

  const full = await h.synced();
  assert.equal(full.added, 6, JSON.stringify(full));
  assert.equal(h.sync.meta().baselineDone, true);
  const check = await h.migration.verify();
  assert.equal(check.ok, true);
  assert.equal(check.direct, 8);
  assert.equal(check.converted, 0);
  assert.equal(check.cache.files, 0, "no second copy of the library anywhere");

  // Verification notices what differs.
  h.itunes.userEdit(h.row("Song 3").pid, { name: "Changed" });
  const drift = await h.migration.verify();
  assert.equal(drift.ok, false);
  assert.match(drift.problems[0].problem, /different title/);
});

test("a first sync into an iTunes with songs WaveMint doesn't manage asks for the guided migration", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  const legacy = h.itunes.seed(h.master("Alpha"));
  const blocked = await h.synced();
  assert.equal(blocked.code, "needs-migration");
  assert.equal(h.itunes.state.tracks.size, 1);
  assert.ok(h.itunes.state.tracks.has(legacy));
  assert.equal((await h.sync.preview({ launch: false })).needsMigration, true);
  assert.equal((await h.sync.run({ mode: "auto" })).code, "no-baseline");
});

test("a different iTunes library isn't synced into without confirmation", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  h.itunes.state.libraryId = "00000000000000B2";
  h.itunes.state.tracks.clear();
  assert.equal((await h.synced()).code, "new-library");
  assert.equal(h.itunes.state.tracks.size, 0);
  assert.equal((await h.synced({ confirm: { newLibrary: true } })).added, 3);
});

test("the guided migration adopts entries already playing library files and re-points the rest", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  const exact = h.itunes.seed(h.master("Alpha"), { rating: 60, playedCount: 5 });
  const legacyCopy = path.join(h.itunesDir, "Beta legacy.m4a");
  fs.copyFileSync(h.master("Beta"), legacyCopy);
  const strong = h.itunes.seed(legacyCopy, { rating: 40 });
  const unrelated = h.itunes.seed(h.master("Café Δ"), { name: "Some Other Song", artist: "Someone Else" });
  h.itunes.state.tracks.get(unrelated).location = path.join(h.itunesDir, "gone.mp3");

  const report = await h.migration.analyze();
  assert.equal(report.counts.exact, 1);
  assert.equal(report.counts.strong, 1);
  assert.equal(report.counts.toAdd, 1);
  assert.equal(report.counts.obsolete, 1);

  const dry = await h.migration.apply({ dryRun: true });
  assert.equal(dry.inPlace, 1, "the entry already playing the library file stays as it is");
  assert.equal(dry.relink, 1);
  assert.deepEqual(h.itunes.mutations(), []);
  await assert.rejects(() => h.migration.apply({ dryRun: false }), /Back up/);
  const applied = await h.migration.apply({ dryRun: false, backupAck: true });
  assert.equal(applied.result.relinked, 1);
  assert.equal(applied.result.added, 1);
  assert.equal(applied.verification.ok, true);
  assert.equal(h.row("Alpha").pid, exact);
  assert.equal(h.row("Beta").pid, strong);
  assert.equal(entryFor(h, "Beta").location, h.master("Beta"));
  assert.equal(h.itunes.state.tracks.get(exact).rating, 60);
  assert.ok(fs.existsSync(legacyCopy), "legacy files are untouched");
  doNothing(await h.synced());

  const cleaned = await h.migration.cleanup({ pids: [unrelated], expected: 1, backupAck: true });
  assert.equal(cleaned.removed, 1);
  assert.equal(h.itunes.state.tracks.size, 3);
});

test("with the Apple Music app (files only) a portable export folder is kept, and iTunes isn't contacted", needsAudio, async (t) => {
  const exportRoot = makeTempDir(t, "wavemint-portable-");
  const h = await harness(t, { settings: { appleDestination: "files", exportRoot } });
  const report = await h.synced();
  assert.equal(report.files.new, 4);
  assert.deepEqual(h.itunes.state.calls, []);
  assert.ok(fs.existsSync(path.join(exportRoot, "wavemint-export.json")));
});

test("a portable export still works beside direct sync and doesn't change what iTunes plays", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  const portable = makeTempDir(t, "wavemint-portable-");
  const exported = await h.exporter.exportJob({ root: portable, scope: { all: true } });
  assert.equal(exported.new, 3);
  assert.ok(fs.existsSync(path.join(portable, "Music", "A", "One", "01 Alpha.mp3")));
  doNothing(await h.synced());
  assert.equal(entryFor(h, "Alpha").location, h.master("Alpha"));
});

// --- formats and missing files ----------------------------------------------------------

test("format statistics count the library's current files by codec and follow library changes", needsAudio, async (t) => {
  const h = await harness(t);
  const stats = formats.formatStats(h.db);
  assert.equal(stats.totalFiles, 4);
  const by = (codec) => stats.formats.find((item) => item.codec === codec);
  assert.equal(by("mp3").files, 2);
  assert.equal(by("aac").files, 1);
  assert.deepEqual(by("aac").extensions, [{ ext: ".m4a", files: 1 }]);
  assert.equal(by("flac").files, 1);
  assert.equal(by("flac").lossless, true);
  const total = stats.formats.reduce((sum, item) => sum + item.bytes, 0);
  assert.equal(stats.totalBytes, total);
  assert.ok(Math.abs(stats.formats.reduce((sum, item) => sum + item.fileShare, 0) - 1) < 1e-9);
  assert.deepEqual(stats.apple, { direct: 3, convert: 1, unsupported: 0, missing: 0 });
  // Drill down: the songs of one format.
  assert.equal(queries.listTracks(h.db, { filters: { codec: "aac" } }).total, 1);

  // Adding and removing songs updates the numbers (no rescan of the rest needed).
  makeTrack(h.music, "C/Three/01 Delta.m4a", { base: "m4a", tags: { title: "Delta", artist: "C" } });
  await h.scanner.scanSource(h.db.prepare("SELECT id FROM sources").get().id);
  assert.equal(formats.formatStats(h.db).formats.find((item) => item.codec === "aac").files, 2);
  createRemoval({ db: h.db }).removeFromLibrary({ trackIds: [h.id("Gamma")] });
  const after = formats.formatStats(h.db);
  assert.equal(after.formats.find((item) => item.codec === "flac"), undefined);
  assert.equal(after.removedSongs.files, 1, "the removed song's file is counted separately");
});

test("missing files are explained, can be relinked or forgotten safely, and nothing on disk is deleted", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  const sourceId = h.db.prepare("SELECT id FROM sources").get().id;

  // The current file of a song in the library goes missing (moved outside WaveMint).
  const cafe = h.master("Café Δ");
  const movedTo = path.join(h.music, "Moved", "02 Café Δ.mp3");
  fs.mkdirSync(path.dirname(movedTo), { recursive: true });
  fs.renameSync(cafe, movedTo);
  // A removed song whose file is gone as well (a leftover reference).
  createRemoval({ db: h.db }).removeFromLibrary({ trackIds: [h.id("Beta")] });
  const betaFile = h.master("Beta");
  fs.rmSync(betaFile);
  h.db.prepare("UPDATE files SET status = 'missing' WHERE path IN (?, ?)").run(cafe, betaFile);

  const missing = formats.listMissingFiles(h.db);
  assert.equal(missing.length, 2);
  const current = missing.find((item) => item.title === "Café Δ");
  assert.equal(current.current, true);
  assert.equal(current.canForget, false);
  assert.equal(current.path, cafe);
  assert.match(current.reason, /moved, renamed or deleted/);
  assert.equal(current.elsewhere.length, 0, "the moved copy isn't tracked yet, so only known files are suggested");
  const leftover = missing.find((item) => item.title === "Beta");
  assert.equal(leftover.canForget, true);
  assert.match(leftover.belongsTo, /removed from the library/);

  assert.throws(() => formats.forgetMissingFile(h.db, { fileId: current.fileId }), /current file/);
  assert.throws(() => formats.relinkMissingFile(h.db, { fileId: current.fileId, filePath: path.join(h.root, "outside.mp3") }), /isn't available|library folders/);
  const relinked = formats.relinkMissingFile(h.db, { fileId: current.fileId, filePath: movedTo });
  assert.equal(relinked.relinked, true);
  assert.equal(h.master("Café Δ"), movedTo);
  assert.equal(h.db.prepare("SELECT status FROM files WHERE id = ?").get(current.fileId).status, "ok");

  formats.forgetMissingFile(h.db, { fileId: leftover.fileId });
  assert.equal(formats.listMissingFiles(h.db).length, 0);
  assert.ok(fs.existsSync(movedTo) && fs.existsSync(h.master("Alpha")), "no file was deleted");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM files WHERE source_id = ? AND status = 'missing'").get(sourceId).n, 0);
});

test("the Apple sync calls validate their parameters and drop anything unexpected", () => {
  const { HOST_METHOD_NAMES, WORKER_METHODS } = require("../electron/library/host.cjs");
  const { validate } = require("../electron/library/validate.cjs");
  const confirm = validate(WORKER_METHODS.runAppleSync, { confirm: { removals: [3, 4], recreate: true, bulk: true, evil: "x" }, trackIds: [1], path: "C:/x" });
  assert.deepEqual(confirm, { confirm: { removals: [3, 4], recreate: true, bulk: true }, trackIds: [1] });
  assert.throws(() => validate(WORKER_METHODS.runAppleSync, { confirm: { removals: ["a"] } }), /invalid/);
  const ok = validate(WORKER_METHODS.applyAppleMigration, { resolutions: { 12: "0123456789abcdef", 13: "new" }, dryRun: true });
  assert.deepEqual(ok, { resolutions: { 12: "0123456789ABCDEF", 13: "new" }, dryRun: true });
  assert.throws(() => validate(WORKER_METHODS.applyAppleMigration, { resolutions: { 12: "C:/music/x.mp3" } }), /invalid/);
  assert.throws(() => validate(WORKER_METHODS.updateSettings, { patch: { appleRemovalPolicy: "delete-everything" } }), /invalid/);
  assert.equal(validate(WORKER_METHODS.appleTestSync, { count: 5 }).count, 5);
  assert.throws(() => validate(WORKER_METHODS.appleTestSync, { count: 500 }), /invalid/);
  // Relinking takes a path, so it's only reachable through the host's file dialog.
  assert.equal(Object.hasOwn(WORKER_METHODS, "relinkMissingFile"), false);
  assert.ok(HOST_METHOD_NAMES.includes("locateMissingFile"));
});

test("a test sync that adds nothing says so, and verification never passes with nothing synced", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  // Nothing synced yet: verification is not a success.
  const empty = await h.migration.verify();
  assert.equal(empty.ok, false);
  assert.equal(empty.checked, 0);
  assert.match(empty.problems[0].problem, /nothing to verify/);

  // The chosen songs' files are gone (like a test library whose folder was deleted).
  const ids = [h.id("Alpha"), h.id("Beta")];
  for (const title of ["Alpha", "Beta"]) fs.rmSync(h.master(title));
  const report = await h.synced({ only: ids });
  assert.equal(report.status, "nothing");
  assert.equal(report.added, 0);
  assert.equal(report.skippedCount, 2);
  assert.match(report.reason, /None of the 2 chosen songs could be synced: The file is missing/);
  assert.equal(report.library.bridge, "fake", "the report says which bridge did the work");
  assert.equal(report.library.songsBefore, 0);
  assert.equal(h.itunes.state.tracks.size, 0);
});

test("the host can forbid writing a library into iTunes (a test library), before iTunes is even contacted", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  const guarded = createAppleSync({
    db: h.db,
    exporter: h.exporter,
    getAdapter: () => h.itunes,
    getSettings: () => h.config,
    getLibraryRoot: () => h.music,
    defaultCacheRoot: h.cache,
    assertWritable: () => {
      throw Object.assign(new Error("This WaveMint Library is in the temporary folder"), { code: "test-library" });
    },
    logger: quietLogger,
  });
  const report = await guarded.run({ mode: "manual" });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "test-library");
  assert.deepEqual(h.itunes.state.calls, [], "iTunes wasn't contacted");
});

test("genres are written as text, and genres stored as numbers are found and stored as text on request", needsAudio, async (t) => {
  const { File, Id3v2Settings } = require("node-taglib-sharp");
  const h = await harness(t, { flac: false });
  // WaveMint's own writes store text, even for genres that have an ID3v1 number.
  await h.save([{ trackId: h.id("Alpha"), fields: { genre: "Anime" } }]);
  assert.equal(formats.rawId3Genre(h.master("Alpha")), "Anime");

  // A file written by another tool with a numeric genre: "(145)" reads back as "Anime".
  const cafe = h.master("Café Δ");
  Id3v2Settings.useNumericGenres = true;
  const file = File.createFromPath(cafe);
  file.tag.genres = ["Anime"];
  file.save();
  file.dispose();
  assert.ok(["(145)", "145"].includes(formats.rawId3Genre(cafe)), "stored as a number (v2.3 \"(145)\" or v2.4 \"145\")");
  await h.scanner.scanSource(h.db.prepare("SELECT id FROM sources").get().id);
  h.db.prepare("UPDATE tracks SET genre = 'Anime' WHERE id = ?").run(h.id("Café Δ"));

  const scan = await formats.numericGenreScan(h.db);
  assert.equal(scan.numeric, 1);
  assert.equal(scan.shownAsNumbers, 1);
  assert.deepEqual(scan.trackIds, [h.id("Café Δ")]);
  // A plain Write Tags would skip it (the genre reads the same); the forced genre rewrite doesn't.
  const fixed = await h.fileOps.writeTagsJob({ trackIds: scan.trackIds, forceFields: ["genre"] });
  assert.equal(fixed.written, 1);
  assert.equal(formats.rawId3Genre(cafe), "Anime");
  assert.equal(readTags(cafe).genre, "Anime");
  assert.equal((await formats.numericGenreScan(h.db)).numeric, 0);
});

test("iTunes picking up a saved change by itself isn't mistaken for an edit made in iTunes", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  const pid = h.row("Beta").pid;
  // WaveMint saves a change; iTunes notices the changed file and re-reads it on its own.
  await h.save([{ trackId: h.id("Beta"), fields: { genre: "Pop" } }]);
  h.itunes.userEdit(pid, { genre: "Pop" });
  const report = await h.synced({ only: [h.id("Beta")] });
  assert.equal(report.review, 0, "no decision needed: iTunes already shows WaveMint's details");
  assert.equal(report.updated, 1);
  assert.equal(h.row("Beta").pid, pid);
  // A real edit in iTunes (differs from WaveMint) still asks first, and the message says so.
  h.itunes.userEdit(pid, { genre: "Jazz" });
  await h.save([{ trackId: h.id("Beta"), fields: { genre: "Folk" } }]);
  const held = await h.synced({ only: [h.id("Beta")] });
  assert.equal(held.review, 1);
  assert.match(held.reason, /need a decision/);
});

test("a new cover replaces the old one even when the file stored it as 'Other', and restoring leaves one cover", needsAudio, async (t) => {
  const { File, Picture, PictureType, ByteVector } = require("node-taglib-sharp");
  const { writeTags } = require("../electron/library/tags.cjs");
  const h = await harness(t, { flac: false });
  const song = h.master("Beta");
  // Another tagger stored the cover with picture type "Other".
  const original = coverBytes("navy");
  const file = File.createFromPath(song);
  const picture = Picture.fromData(ByteVector.fromByteArray(new Uint8Array(original)));
  picture.type = PictureType.Other;
  file.tag.pictures = [picture];
  file.save();
  file.dispose();
  assert.equal(readTags(song).artworkCount, 1);

  writeTags(song, { artwork: { data: coverBytes("red"), mime: "image/jpeg" } });
  assert.equal(readTags(song).artworkCount, 1, "the old cover was replaced, not kept beside the new one");
  writeTags(song, { artwork: { data: original, mime: "image/jpeg" } });
  assert.equal(readTags(song).artworkCount, 1, "restoring leaves one cover");
});

test("a song whose file was moved is found before a rescan, located, and its iTunes entry relinked", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  await h.synced();
  const pid = h.row("Beta").pid;
  const old = h.master("Beta");
  const moved = path.join(path.dirname(old), "02 Beta (moved).m4a");
  fs.renameSync(old, moved);

  const missing = formats.listMissingFiles(h.db);
  assert.equal(missing.length, 1, "noticed without a rescan");
  assert.equal(missing[0].sinceScan, true);
  assert.equal(missing[0].current, true);
  formats.relinkMissingFile(h.db, { fileId: missing[0].fileId, filePath: moved });
  assert.equal(h.master("Beta"), moved);
  assert.equal(formats.listMissingFiles(h.db).length, 0);

  const report = await h.synced({ only: [h.id("Beta")] });
  assert.equal(report.relinked, 1);
  assert.equal(h.row("Beta").pid, pid);
  assert.equal(entryFor(h, "Beta").location, moved);
  assert.equal(h.itunes.state.tracks.size, 3);
});

test("a track number of 0 counts as no track number, so saving doesn't fail on it", needsAudio, async (t) => {
  const h = await harness(t, { flac: false });
  h.db.prepare("UPDATE tracks SET track_no = 0 WHERE id = ?").run(h.id("Beta"));
  const fixed = await h.fileOps.writeTagsJob({ trackIds: [h.id("Beta")], forceFields: ["genre"] });
  assert.equal(fixed.written, 1, JSON.stringify(fixed.results));
});
