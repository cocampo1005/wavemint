// Saving an edit writes it into the song's file (one action), and only where
// WaveMint may write. A failed write takes the edit back; undo writes the old
// values back into the file.

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const TagLib = require("node-taglib-sharp");

const { createJobManager } = require("../electron/library/jobs.cjs");
const { listOperations } = require("../electron/library/operations.cjs");
const { createLibraryService } = require("../electron/library/service.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { SKIP_REASON, addAndScan, coverBytes, createTestLibrary, makeTempDir, makeTrack, mediaForTests, quietLogger } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

for (const persistent of [false, true]) test(`artwork save handles a ${persistent ? "persistent" : "temporary"} active-file rename lock`, needsAudio, async (t) => {
  const { methods, id, fileOf, db, data } = await savingLibrary(t);
  const trackId = id("Shiver");
  await methods.saveTrack({ trackId, fields: { album: "Saved album" } });
  const file = fileOf(trackId);
  const before = fs.readFileSync(file.path);
  const trackBefore = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
  const { createArtStore } = require("../electron/library/artstore.cjs");
  const art = createArtStore(path.join(data, "artwork-store")).save(coverBytes("purple"));
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from === file.path && String(to).includes(".wmold")) {
      attempts += 1;
      if (persistent || attempts <= 2) throw Object.assign(new Error("Sharing violation"), { code: "EPERM" });
    }
    return rename(from, to);
  });
  const save = methods.saveTrack({ trackId, fields: {}, artworkHash: art.hash });
  if (persistent) {
    await assert.rejects(save, /Windows wouldn't allow replacing.*Close any player/);
    assert.equal(attempts, 6, "retries are bounded");
    assert.deepEqual(fs.readFileSync(file.path), before, "the original file is untouched");
    const after = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
    assert.equal(after.artwork_hash, trackBefore.artwork_hash);
    assert.equal(after.album, "Saved album");
    assert.equal(after.tags_dirty, trackBefore.tags_dirty);
  } else {
    assert.equal((await save).files.written, 1);
    assert.equal(attempts, 3);
    assert.equal(readTags(file.path).artworkHash, art.hash);
    assert.equal(readTags(file.path).album, "Saved album");
  }
  assert.equal(fs.readdirSync(path.dirname(file.path)).some((name) => /\.wm(?:old|tmp)/.test(name)), false);
});

test("a first album save preserves a 30-character ID3v1.0 comment", needsAudio, async (t) => {
  const { methods, id, fileOf, scanner } = await savingLibrary(t);
  const trackId = id("Shiver");
  const file = fileOf(trackId);
  // Build the legacy tag directly: TagLib's writer always emits v1.1.
  const tagged = TagLib.File.createFromPath(file.path);
  tagged.removeTags(TagLib.TagTypes.Id3v1);
  tagged.save();
  tagged.dispose();
  const comment = "123456789012345678901234567890";
  const legacy = Buffer.alloc(128);
  legacy.write("TAG", 0, "ascii");
  legacy.write(comment, 97, "ascii");
  fs.appendFileSync(file.path, legacy);
  await scanner.scanSource(file.source_id);
  assert.equal(readTags(file.path).comment, comment);
  const result = await methods.saveTrack({ trackId, fields: { album: "Renamed album" } });
  assert.equal(result.files.written, 1);
  assert.equal(readTags(file.path).album, "Renamed album");
  assert.equal(readTags(file.path).comment, comment);
  await methods.saveTrack({ trackId, fields: { comment: "An intentional comment edit" } });
  assert.equal(readTags(file.path).comment, "An intentional comment edit");
});

async function savingLibrary(t, { writable = true } = {}) {
  const lib = await createTestLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  makeTrack(music, "Coldplay/Parachutes/02 Shiver.mp3", { tags: { title: "Shiver", artist: "Coldplay", album: "Parachutes", genre: "Alt Rock", trackNo: 2, year: 2000 } });
  makeTrack(music, "Daft Punk/Discovery/01 One More Time.mp3", { tags: { title: "One More Time", artist: "Daft Punk", album: "Discovery", genre: "Electronic" }, cover: "navy" });
  makeTrack(music, "Loose/Untitled.wav", { base: "wav" });

  // Lyrics in the file: saving other fields must keep them.
  const shiverPath = path.join(music, "Coldplay/Parachutes/02 Shiver.mp3");
  const file = TagLib.File.createFromPath(shiverPath);
  file.tag.lyrics = "Look at the stars";
  file.save();
  file.dispose();

  await addAndScan(lib.db, lib.scanner, music, { writable });
  const data = makeTempDir(t, "wavemint-data-");
  const events = [];
  const jobs = createJobManager({ emit: () => {}, logger: quietLogger });
  const { methods } = createLibraryService({
    db: lib.db,
    media: mediaForTests(),
    jobs,
    paths: { dataDir: data, backupsDir: path.join(data, "backups"), stagingDir: path.join(data, "staging") },
    logger: quietLogger,
    emit: (name, value) => events.push({ name, value }),
  });
  const id = (title) => lib.db.prepare("SELECT id FROM tracks WHERE title = ?").get(title).id;
  const fileOf = (trackId) => lib.db.prepare("SELECT f.* FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(trackId);
  return { ...lib, music, methods, jobs, data, id, fileOf, events };
}

const backupFiles = (data) => {
  const root = path.join(data, "backups");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((folder) => fs.readdirSync(path.join(root, folder)));
};

test("saving a song writes the changed fields into its file in one step", needsAudio, async (t) => {
  const { db, methods, id, fileOf, data } = await savingLibrary(t);
  const shiver = id("Shiver");
  const file = fileOf(shiver);
  const audioBefore = await mediaForTests().audioStreamHash(file.path);

  const result = await methods.saveTrack({ trackId: shiver, fields: { title: "Shiver (Remastered)", album: "Parachutes (Deluxe)" } });
  assert.equal(result.files.written, 1);
  assert.deepEqual(result.files.failed, []);

  const tags = readTags(file.path);
  assert.equal(tags.title, "Shiver (Remastered)");
  assert.equal(tags.album, "Parachutes (Deluxe)");
  assert.equal(tags.genre, "Alt Rock");
  const check = TagLib.File.createFromPath(file.path);
  assert.equal(check.tag.lyrics, "Look at the stars", "tags that weren't edited stay as they were");
  check.dispose();
  assert.equal(await mediaForTests().audioStreamHash(file.path), audioBefore, "the audio stream is untouched");
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(shiver).tags_dirty, 0, "nothing left to write");
  assert.equal(backupFiles(data).length, 1, "a verified backup of the original was kept");

  // History lists the edit once; its file step is part of it.
  const listed = listOperations(db).map((operation) => operation.kind);
  assert.deepEqual(listed, ["metadata"]);

  // Saving the same song again shortly after reuses that backup.
  await methods.saveTrack({ trackId: shiver, fields: { year: 2001 } });
  assert.equal(readTags(file.path).year, 2001);
  assert.equal(backupFiles(data).length, 1, "no second full copy for a small follow-up edit");
});

test("a save that can't be written to the file is taken back and reported", needsAudio, async (t) => {
  const { db, methods, id, fileOf } = await savingLibrary(t);
  const shiver = id("Shiver");
  const file = fileOf(shiver);
  // Changed outside WaveMint since the scan: never overwritten.
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(file.path, future, future);

  await assert.rejects(methods.saveTrack({ trackId: shiver, fields: { title: "Changed" } }), /weren't saved: The file changed since it was scanned/);
  const track = db.prepare("SELECT title, tags_dirty, curated_fields FROM tracks WHERE id = ?").get(shiver);
  assert.equal(track.title, "Shiver", "the database keeps the old value");
  assert.equal(track.tags_dirty, 0);
  assert.equal(JSON.parse(track.curated_fields).includes("title"), false);
  assert.equal(readTags(file.path).title, "Shiver");
  assert.equal(listOperations(db).filter((operation) => operation.kind === "metadata").length, 0, "nothing half-saved in History");
});

test("songs in read-only folders keep the edit in WaveMint; WAV files are never written", needsAudio, async (t) => {
  const { db, methods, id, fileOf, music } = await savingLibrary(t, { writable: false });
  const shiver = id("Shiver");
  const before = fs.readFileSync(fileOf(shiver).path);

  const result = await methods.saveTrack({ trackId: shiver, fields: { genre: "Rock" } });
  assert.equal(result.files.written, 0);
  assert.equal(result.files.blocked, 1);
  assert.equal(db.prepare("SELECT genre, tags_dirty FROM tracks WHERE id = ?").get(shiver).genre, "Rock");
  assert.deepEqual(fs.readFileSync(fileOf(shiver).path), before, "the read-only file is untouched");
  assert.ok(fs.existsSync(path.join(music, "Loose/Untitled.wav")));
});

test("undoing a save writes the old values and artwork back into the file", needsAudio, async (t) => {
  const { db, methods, id, fileOf, data } = await savingLibrary(t);
  const song = id("One More Time");
  const file = fileOf(song);
  const originalArt = readTags(file.path).artworkHash;
  assert.ok(originalArt, "the fixture has embedded artwork");

  const { createArtStore } = require("../electron/library/artstore.cjs");
  const art = createArtStore(path.join(data, "artwork-store")).save(coverBytes("purple"));
  const saved = await methods.saveTrack({ trackId: song, fields: { genre: "House" }, artworkHash: art.hash });
  assert.equal(readTags(file.path).artworkHash, art.hash, "the new cover is embedded");
  assert.equal(readTags(file.path).genre, "House");

  const undo = await methods.undoOperation({ id: saved.operationId });
  assert.equal(undo.files.written, 1);
  const tags = readTags(file.path);
  assert.equal(tags.genre, "Electronic");
  assert.equal(tags.artworkHash, originalArt, "the file's own cover is back");
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(song).tags_dirty, 0);
});

test("bulk edits are written through too, and wait for a running file task", needsAudio, async (t) => {
  const { db, methods, jobs, id, fileOf } = await savingLibrary(t);
  const shiver = id("Shiver");
  const song = id("One More Time");

  // While a file-moving task runs, the write waits for it.
  let release;
  jobs.start("consolidate", "Copying", () => new Promise((resolve) => (release = resolve)));
  const result = await methods.applyEdits({ edits: [shiver, song].map((trackId) => ({ trackId, fields: { albumArtist: "Various" } })) });
  assert.equal(result.files.deferred, 2);
  assert.equal(readTags(fileOf(shiver).path).albumArtist, "");
  release();
  for (let tries = 0; tries < 100 && db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE tags_dirty = 1").get().n; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(readTags(fileOf(shiver).path).albumArtist, "Various");
  assert.equal(readTags(fileOf(song).path).albumArtist, "Various");
});

test("a locked old copy does not block a second save with identified artwork", needsAudio, async (t) => {
  const { methods, id, fileOf, db, data, scanner } = await savingLibrary(t);
  const trackId = id("Shiver");
  const file = fileOf(trackId);
  const originalRm = fs.rmSync;
  let blocked = false;
  t.mock.method(fs, "rmSync", (target, options) => {
    if (String(target).includes(".wmold") && fs.existsSync(target)) {
      blocked = true;
      throw Object.assign(new Error("File is in use"), { code: "EPERM" });
    }
    return originalRm(target, options);
  });
  const result = await methods.saveTrack({ trackId, fields: { genre: "Synth-Pop" } });
  assert.equal(blocked, true);
  assert.equal(result.files.written, 1);
  assert.equal(readTags(file.path).genre, "Synth-Pop");
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(trackId).tags_dirty, 0);
  const { createArtStore } = require("../electron/library/artstore.cjs");
  const art = createArtStore(path.join(data, "artwork-store")).save(coverBytes("purple"));
  const second = await methods.saveTrack({ trackId, fields: { album: "Follow-up" }, artworkHash: art.hash });
  assert.equal(second.files.written, 1);
  assert.equal(readTags(file.path).album, "Follow-up");
  assert.equal(readTags(file.path).genre, "Synth-Pop");
  assert.equal(readTags(file.path).artworkHash, art.hash);
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(trackId).tags_dirty, 0);
  assert.equal(fs.readdirSync(path.dirname(file.path)).filter((name) => name.includes(".wmold")).length, 2);
  fs.rmSync.mock.restore();
  await scanner.scanSource(file.source_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '%wmold%'").get().n, 0, "retained copies aren't imported as songs");
});

// Genres typed in a picker join the genre list when the save succeeds.
const genreNames = (db) => db.prepare("SELECT name FROM genres ORDER BY name").all().map((row) => row.name);

test("a saved new genre joins the genre list once; equivalent names keep the list's spelling", needsAudio, async (t) => {
  const { db, methods, id } = await savingLibrary(t);
  const shiver = id("Shiver");
  const one = id("One More Time");
  await methods.saveTrack({ trackId: shiver, fields: { genre: "Dark  Synthwave " } });
  assert.deepEqual(genreNames(db), ["Dark Synthwave"], "spacing normalized");

  // A bulk edit giving two songs an equivalent spelling adds nothing.
  await methods.applyEdits({ edits: [shiver, one].map((trackId) => ({ trackId, fields: { genre: "dark synthwave" } })) });
  assert.deepEqual(genreNames(db), ["Dark Synthwave"]);
  // A new one for several songs is added once.
  await methods.applyEdits({ edits: [shiver, one].map((trackId) => ({ trackId, fields: { genre: "Chillwave" } })) });
  assert.deepEqual(genreNames(db), ["Chillwave", "Dark Synthwave"]);
  // A change left out in the preview isn't saved, so its genre isn't added.
  await methods.applyEdits({ edits: [{ trackId: one, fields: { genre: "Vaporwave", title: "OMT" } }], exclude: [{ trackId: one, field: "genre" }] });
  assert.equal(genreNames(db).includes("Vaporwave"), false);
  // Edits without a genre leave the list alone.
  await methods.saveTrack({ trackId: shiver, fields: { title: "Shiver!" } });
  assert.deepEqual(genreNames(db), ["Chillwave", "Dark Synthwave"]);
});

test("a failed save adds no genre", needsAudio, async (t) => {
  const { db, methods, id, fileOf } = await savingLibrary(t);
  const shiver = id("Shiver");
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(fileOf(shiver).path, future, future);
  await assert.rejects(methods.saveTrack({ trackId: shiver, fields: { genre: "Never Saved" } }));
  assert.deepEqual(genreNames(db), []);
});

test("undoing the save that added a genre takes it back unless something uses it", needsAudio, async (t) => {
  const { db, methods, id } = await savingLibrary(t);
  const shiver = id("Shiver");
  const one = id("One More Time");
  const saved = await methods.saveTrack({ trackId: shiver, fields: { genre: "Dark Synthwave" } });
  await methods.undoOperation({ id: saved.operationId });
  assert.equal(db.prepare("SELECT genre FROM tracks WHERE id = ?").get(shiver).genre, "Alt Rock");
  assert.deepEqual(genreNames(db), [], "unused after the undo: removed");

  // Still used by another song after the undo: kept.
  const first = await methods.applyEdits({ edits: [{ trackId: shiver, fields: { genre: "Chillwave" } }] });
  await methods.saveTrack({ trackId: one, fields: { genre: "chillwave" } });
  await methods.undoOperation({ id: first.operationId });
  assert.deepEqual(genreNames(db), ["Chillwave"]);
  // Genres that were already in the list are never removed by an undo.
  const again = await methods.saveTrack({ trackId: shiver, fields: { genre: "Chillwave" } });
  await methods.undoOperation({ id: again.operationId });
  assert.deepEqual(genreNames(db), ["Chillwave"]);
});

test("a song added from Add Music registers its genre", needsAudio, async (t) => {
  const { db, methods, music } = await savingLibrary(t);
  const managedRoot = path.join(music, "..", `${path.basename(music)}-library`);
  fs.mkdirSync(managedRoot);
  t.after(() => fs.rmSync(managedRoot, { recursive: true, force: true }));
  methods.setManagedRoot({ rootPath: managedRoot });
  const add = async (genre, title) => {
    const { token, folder } = methods.prepareExtractionStaging();
    makeTrack(folder, `${title}.mp3`, { tags: { title, artist: "New Artist", genre } });
    return methods.commitStagedExtraction({ token });
  };
  await add("Hyperpop", "First");
  assert.deepEqual(genreNames(db), ["Hyperpop"]);
  await add("HYPERPOP", "Second");
  assert.deepEqual(genreNames(db), ["Hyperpop"], "an equivalent spelling isn't added again");
});
