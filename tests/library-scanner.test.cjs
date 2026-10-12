const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { migrate, openDatabase, getSchemaVersion } = require("../electron/library/db.cjs");
const { MIGRATIONS } = require("../electron/library/migrations.cjs");
const { createScanner, guessFromPath } = require("../electron/library/scanner.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { addSource, removeSource, updateSource } = require("../electron/library/sources.cjs");
const queries = require("../electron/library/queries.cjs");
const { HAVE_FFMPEG, SKIP_REASON, makeTempDir, makeTrack, snapshotFolder } = require("./library-fixtures.cjs");

const quiet = { log() {}, warn() {}, error() {} };
const needsAudio = { skip: SKIP_REASON };

async function createLibrary(t) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "wavemint-db-"));
  const file = path.join(dir, "library.db");
  const { db, existed } = openDatabase(file, { logger: quiet });
  // Close the database before deleting its folder (Windows locks open files).
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await migrate(db, { filePath: file, backupDir: path.join(dir, "backups"), logger: quiet, existed });
  return { db, dir, scanner: createScanner({ db, logger: quiet }) };
}

test("migrations create the schema once and record their version", async (t) => {
  const { db, dir } = await createLibrary(t);
  assert.equal(getSchemaVersion(db), MIGRATIONS.length);
  for (const table of ["sources", "tracks", "files", "releases", "track_search"]) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table), table);
  }
  // Re-running is a no-op.
  const again = await migrate(db, { filePath: path.join(dir, "library.db"), logger: quiet, existed: true });
  assert.deepEqual(again.applied, []);
});

function makeDbDir(t) {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "wavemint-db-"));
  const handles = [];
  t.after(() => {
    for (const handle of handles) {
      try {
        handle.close();
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, track: (db) => handles.push(db) && db };
}

test("an existing database is backed up before a new migration runs", async (t) => {
  const { dir, track } = makeDbDir(t);
  const file = path.join(dir, "library.db");
  const first = openDatabase(file, { logger: quiet }).db;
  await migrate(first, { filePath: file, logger: quiet });
  first.close();

  const extra = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: "test", up: (d) => d.exec("CREATE TABLE extra_test (id INTEGER)") }];
  const db = track(openDatabase(file, { migrations: extra, logger: quiet }).db);
  const result = await migrate(db, { filePath: file, backupDir: path.join(dir, "backups"), migrations: extra, logger: quiet, existed: true });

  assert.deepEqual(result.applied, [MIGRATIONS.length + 1]);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));
});

test("a failed migration rolls back completely", async (t) => {
  const { dir, track } = makeDbDir(t);
  const file = path.join(dir, "library.db");
  const broken = [...MIGRATIONS, { version: 99, name: "broken", up: (d) => { d.exec("CREATE TABLE half_done (id INTEGER)"); throw new Error("boom"); } }];
  const db = track(openDatabase(file, { migrations: broken, logger: quiet }).db);

  await assert.rejects(migrate(db, { filePath: file, migrations: broken, logger: quiet }), /boom/);
  assert.equal(getSchemaVersion(db), MIGRATIONS.length);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get(), undefined);
});

test("filenames and folders give sensible guesses for untagged files", () => {
  assert.deepEqual(guessFromPath("Utada Hikaru\\Kingdom Hearts\\03 Simple and Clean.mp3"), {
    title: "Simple and Clean",
    trackNo: 3,
    discNo: null,
    album: "Kingdom Hearts",
    artist: "Utada Hikaru",
  });
  assert.equal(guessFromPath("Artist/Album/1-07 Song.m4a").discNo, 1);
  assert.equal(guessFromPath("Loose Song.mp3").title, "Loose Song");
});

test("sources can't overlap and are validated", async (t) => {
  const { db } = await createLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  fs.mkdirSync(path.join(music, "Legacy"));
  fs.mkdirSync(path.join(music, "Curated"));

  addSource(db, { rootPath: path.join(music, "Legacy"), role: "legacy" });
  addSource(db, { rootPath: path.join(music, "Curated"), role: "curated" });

  assert.throws(() => addSource(db, { rootPath: path.join(music, "Legacy") }), /already in your library/);
  assert.throws(() => addSource(db, { rootPath: path.join(music, "LEGACY") }), /already in your library/);
  assert.throws(() => addSource(db, { rootPath: music }), /contains/);
  fs.mkdirSync(path.join(music, "Legacy", "Sub"));
  assert.throws(() => addSource(db, { rootPath: path.join(music, "Legacy", "Sub") }), /inside/);
  assert.throws(() => addSource(db, { rootPath: path.join(music, "nope") }), /can't be opened/);

  const curated = db.prepare("SELECT * FROM sources WHERE role = 'curated'").get();
  const legacy = db.prepare("SELECT * FROM sources WHERE role = 'legacy'").get();
  assert.ok(curated.priority > legacy.priority, "curated sources are preferred by default");
  assert.equal(curated.read_only, 1);
});

test("scanning reads tags, groups albums, and never modifies the source", needsAudio, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  makeTrack(music, "Utada Hikaru/Kingdom Hearts/01 Simple and Clean.mp3", {
    tags: { title: "Simple and Clean", artist: "Utada Hikaru", albumArtist: "Utada Hikaru", album: "Kingdom Hearts", trackNo: 1, genre: "J-Pop", year: 2002 },
    cover: "navy",
  });
  makeTrack(music, "Utada Hikaru/Kingdom Hearts/02 Hikari.m4a", {
    base: "m4a",
    tags: { title: "Hikari", artist: "Utada Hikaru", albumArtist: "Utada Hikaru", album: "Kingdom Hearts", trackNo: 2 },
    cover: "navy",
  });
  makeTrack(music, "Björk/Homogenic/03 Jóga.flac", { base: "flac", tags: { title: "Jóga", artist: "Björk", album: "Homogenic", trackNo: 3 } });
  makeTrack(music, "Unknown Band/Old Album/05 Untagged Song.mp3"); // no tags at all
  makeTrack(music, "Loose/Sample.wav", { base: "wav" });
  fs.writeFileSync(path.join(music, "Loose", "broken.mp3"), "this is not audio");
  fs.mkdirSync(path.join(music, "Empty Folder"));
  fs.writeFileSync(path.join(music, "Utada Hikaru", "Kingdom Hearts", "cover.jpg"), "not audio, ignored");

  const before = snapshotFolder(music);
  const { id } = addSource(db, { rootPath: music, role: "legacy" });
  const result = await scanner.scanSource(id);
  assert.deepEqual(snapshotFolder(music), before, "the scanned folder is byte-for-byte unchanged");

  assert.equal(result.status, "completed");
  assert.equal(result.stats.found, 6);
  assert.equal(result.stats.added, 5);
  assert.equal(result.stats.unreadable, 1);

  const tracks = queries.listTracks(db, { limit: 50 }).rows;
  assert.equal(tracks.length, 6, "unreadable files are still cataloged");

  const simple = tracks.find((track) => track.title === "Simple and Clean");
  assert.equal(simple.artist, "Utada Hikaru");
  assert.equal(simple.genre, "J-Pop");
  assert.equal(simple.codec, "mp3");
  assert.equal(simple.bitrate, 128);
  assert.match(simple.artwork_hash, /^[a-f0-9]{40}$/);

  const hikari = tracks.find((track) => track.title === "Hikari");
  assert.equal(hikari.codec, "aac");
  assert.equal(hikari.release_id, simple.release_id, "same album, one release");

  const joga = tracks.find((track) => track.title === "Jóga");
  assert.equal(joga.lossless, 1);

  const untagged = tracks.find((track) => track.title === "Untagged Song");
  assert.equal(untagged.artist, "Unknown Band", "artist from the folder layout");
  assert.equal(untagged.album, "Old Album");
  assert.equal(untagged.track_no, 5);

  const broken = db.prepare("SELECT status, read_error FROM files WHERE path LIKE '%broken.mp3'").get();
  assert.equal(broken.status, "unreadable");
  assert.ok(broken.read_error);

  // Search ignores accents and matches prefixes.
  assert.equal(queries.listTracks(db, { search: "joga" }).total, 1);
  assert.equal(queries.listTracks(db, { search: "simp clea" }).total, 1);
  assert.equal(queries.listTracks(db, { search: "utada" }).total, 2);
  assert.equal(queries.listAlbums(db, {}).total, 3);

  const overview = queries.getDashboard(db);
  assert.equal(overview.totals.tracks, 6);
  assert.equal(overview.issues.missing_genre, 5);
});

test("rescans are incremental, notice edits, and respect curated fields", needsAudio, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  const file = makeTrack(music, "A/B/01 One.mp3", { tags: { title: "One", artist: "A", album: "B", genre: "Rock" } });
  makeTrack(music, "A/B/02 Two.mp3", { tags: { title: "Two", artist: "A", album: "B" } });
  const { id } = addSource(db, { rootPath: music });
  await scanner.scanSource(id);

  const second = await scanner.scanSource(id);
  assert.equal(second.stats.unchanged, 2);
  assert.equal(second.stats.added, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 2);

  // The user curated the genre in WaveMint; the file is then re-tagged elsewhere.
  const track = db.prepare("SELECT id FROM tracks WHERE title = 'One'").get();
  db.prepare(`UPDATE tracks SET genre = 'Alternative Rock', curated_fields = '["genre"]' WHERE id = ?`).run(track.id);
  makeTrack(music, "A/B/01 One.mp3", { tags: { title: "One (Remastered)", artist: "A", album: "B", genre: "Pop" } });
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);

  const third = await scanner.scanSource(id);
  assert.equal(third.stats.updated, 1);
  const updated = db.prepare("SELECT title, genre FROM tracks WHERE id = ?").get(track.id);
  assert.equal(updated.title, "One (Remastered)", "uncurated fields follow the file");
  assert.equal(updated.genre, "Alternative Rock", "curated fields are kept");
});

test("deleted files become missing; a disconnected drive changes nothing", needsAudio, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const parent = makeTempDir(t, "wavemint-music-");
  const music = path.join(parent, "Library");
  makeTrack(music, "A/B/01 One.mp3", { tags: { title: "One", artist: "A" } });
  const two = makeTrack(music, "A/B/02 Two.mp3", { tags: { title: "Two", artist: "A" } });
  const { id } = addSource(db, { rootPath: music });
  await scanner.scanSource(id);

  fs.rmSync(two);
  const afterDelete = await scanner.scanSource(id);
  assert.equal(afterDelete.stats.missing, 1);
  const missing = db.prepare("SELECT f.status, t.state FROM files f JOIN tracks t ON t.id = f.track_id WHERE f.path LIKE '%Two.mp3'").get();
  assert.deepEqual({ ...missing }, { status: "missing", state: "active" }, "the catalog keeps the track");

  // Simulate a disconnected drive.
  fs.renameSync(music, `${music}-offline`);
  const offline = await scanner.scanSource(id);
  assert.equal(offline.status, "unavailable");
  assert.equal(db.prepare("SELECT status FROM sources WHERE id = ?").get(id).status, "unavailable");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE status = 'missing'").get().n, 1, "nothing else marked missing");

  fs.renameSync(`${music}-offline`, music);
  const back = await scanner.scanSource(id);
  assert.equal(back.status, "completed");
  assert.equal(db.prepare("SELECT status FROM sources WHERE id = ?").get(id).status, "ok");
});

test("a moved folder can be relinked without losing the catalog", needsAudio, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const parent = makeTempDir(t, "wavemint-music-");
  const music = path.join(parent, "Old Place");
  makeTrack(music, "A/B/01 One.mp3", { tags: { title: "One", artist: "A" } });
  const { id } = addSource(db, { rootPath: music });
  await scanner.scanSource(id);
  const trackId = db.prepare("SELECT id FROM tracks").get().id;

  const moved = path.join(parent, "New Place");
  fs.renameSync(music, moved);
  updateSource(db, id, { rootPath: moved });
  const result = await scanner.scanSource(id);

  assert.equal(result.stats.unchanged, 1);
  assert.equal(db.prepare("SELECT id FROM tracks").get().id, trackId, "same logical track");
  assert.match(db.prepare("SELECT path FROM files").get().path, /New Place/);
});

test("Unicode names, long paths and junction loops are handled", needsAudio, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  makeTrack(music, "宇多田ヒカル/初恋/01 初恋 ♪ & «Love».mp3", { tags: { title: "初恋" } });
  const deep = path.join(...Array.from({ length: 12 }, (_, i) => `Nested folder number ${i} with a long name`));
  makeTrack(music, path.join(deep, "Deep Song.mp3"), { tags: { title: "Deep Song" } });
  assert.ok(path.join(music, deep).length > 260, "the test path is longer than MAX_PATH");

  // A junction pointing back to the root would loop forever if followed.
  fs.symlinkSync(music, path.join(music, "loop"), "junction");

  const { id } = addSource(db, { rootPath: music });
  const result = await scanner.scanSource(id);
  assert.equal(result.status, "completed");
  assert.equal(result.stats.added, 2);
  assert.ok(result.stats.skipped >= 1, "the junction was skipped");
  assert.equal(queries.listTracks(db, { search: "初恋" }).total, 1);
});

test("a cancelled scan can be restarted safely", needsAudio, async (t) => {
  const { db } = await createLibrary(t);
  const controller = new AbortController();
  let reads = 0;
  // Cancels after the tenth file has been read.
  const scanner = createScanner({
    db,
    logger: quiet,
    readTagsImpl: (...args) => {
      reads += 1;
      if (reads === 10) controller.abort();
      return readTags(...args);
    },
  });
  const music = makeTempDir(t, "wavemint-music-");
  for (let i = 0; i < 40; i += 1) makeTrack(music, `Artist/Album/${String(i).padStart(2, "0")} Song.mp3`, { tags: { title: `Song ${i}` } });
  const { id } = addSource(db, { rootPath: music });

  const cancelled = await scanner.scanSource(id, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE status = 'missing'").get().n, 0, "a cancelled scan marks nothing missing");

  const resumed = await scanner.scanSource(id);
  assert.equal(resumed.status, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 40);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 40, "no duplicate tracks after restarting");
});

test("removing a source keeps files on disk and other sources intact", needsAudio, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  const a = path.join(music, "A");
  const b = path.join(music, "B");
  makeTrack(a, "x/y/01 One.mp3", { tags: { title: "One" } });
  makeTrack(b, "x/y/01 Two.mp3", { tags: { title: "Two" } });
  const sa = addSource(db, { rootPath: a }).id;
  const sb = addSource(db, { rootPath: b }).id;
  await scanner.scanSource(sa);
  await scanner.scanSource(sb);

  removeSource(db, sa);
  assert.ok(fs.existsSync(path.join(a, "x/y/01 One.mp3")));
  assert.equal(queries.listTracks(db, {}).total, 1);
  assert.equal(queries.listTracks(db, {}).rows[0].title, "Two");
});

test("a larger library scans in reasonable time", { skip: SKIP_REASON || (process.env.WAVEMINT_SKIP_SLOW && "slow") }, async (t) => {
  const { db, scanner } = await createLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  const count = 1500;
  for (let i = 0; i < count; i += 1) {
    makeTrack(music, `Artist ${i % 60}/Album ${i % 150}/${i} Track.mp3`, {
      tags: { title: `Track ${i}`, artist: `Artist ${i % 60}`, album: `Album ${i % 150}`, trackNo: (i % 12) + 1 },
    });
  }
  const { id } = addSource(db, { rootPath: music });

  const started = Date.now();
  const first = await scanner.scanSource(id);
  const firstMs = Date.now() - started;
  const again = Date.now();
  const second = await scanner.scanSource(id);
  const secondMs = Date.now() - again;

  assert.equal(first.stats.added, count);
  assert.equal(second.stats.unchanged, count);
  t.diagnostic(`first scan ${firstMs} ms (${(firstMs / count).toFixed(2)} ms/file), rescan ${secondMs} ms`);
  assert.ok(secondMs < firstMs, "an unchanged rescan is faster than the first scan");
  assert.equal(queries.listTracks(db, { limit: 100, offset: 1400 }).rows.length, 100);
});

test("HAVE_FFMPEG reflects the fetched binaries", () => {
  assert.equal(typeof HAVE_FFMPEG, "boolean");
});
