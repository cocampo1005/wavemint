const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const edits = require("../electron/library/edits.cjs");
const { createFileOps, siblingPath } = require("../electron/library/fileops.cjs");
const genres = require("../electron/library/genres.cjs");
const { addStep, listOperations, startOperation } = require("../electron/library/operations.cjs");
const queries = require("../electron/library/queries.cjs");
const review = require("../electron/library/review.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const {
  SKIP_REASON,
  addAndScan,
  coverBytes,
  createTestLibrary,
  makeTempDir,
  makeTrack,
  mediaForTests,
  quietLogger,
  snapshotFolder,
} = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

async function sampleLibrary(t, { writable = false } = {}) {
  const lib = await createTestLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  makeTrack(music, "Coldplay/Parachutes/01 Don't Panic.mp3", { tags: { title: "don't panic", artist: "Coldplay", album: "Parachutes", genre: "Rock", trackNo: 1, year: 2000 } });
  makeTrack(music, "Coldplay/Parachutes/02 Shiver.mp3", { tags: { title: "Shiver", artist: "Coldplay", album: "Parachutes", genre: "Alt Rock", trackNo: 2, year: 2000 } });
  makeTrack(music, "Coldplay/Parachutes/03 Spies.m4a", { base: "m4a", tags: { title: "Spies", artist: "Coldplay", album: "Parachutes", genre: "Rock", trackNo: 2, year: 2001 } });
  makeTrack(music, "Coldplay/Parachutes Album/04 Sparks.flac", { base: "flac", tags: { title: "Sparks", artist: "Coldplay", album: "Parachute", trackNo: 4 } });
  makeTrack(music, "Daft Punk/Discovery/01 One More Time.mp3", { tags: { title: "One More Time", artist: "Daft Punk", album: "Discovery", genre: "Electronic" }, cover: "navy" });
  makeTrack(music, "Loose/Untitled.wav", { base: "wav" });
  const sourceId = await addAndScan(lib.db, lib.scanner, music, { writable });
  const id = (title) => lib.db.prepare("SELECT id FROM tracks WHERE title = ?").get(title).id;
  return { ...lib, music, sourceId, id };
}

test("title case keeps acronyms and small words", () => {
  assert.equal(edits.titleCase("don't panic"), "Don't Panic");
  assert.equal(edits.titleCase("the sound of silence"), "The Sound of Silence");
  assert.equal(edits.titleCase("live at the BBC"), "Live at the BBC");
  assert.equal(edits.titleCase("hey jude (remastered)"), "Hey Jude (Remastered)");
});

test("bulk edits preview real changes and never blank out differing values", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  const ids = [id("Shiver"), id("Spies")];

  // Only the album artist is given: titles, genres and years stay as they are.
  const preview = edits.previewEdits(db, ids.map((trackId) => ({ trackId, fields: { albumArtist: "Coldplay" } })));
  assert.equal(preview.length, 2);
  assert.deepEqual(preview[0].changes, [{ field: "albumArtist", from: "", to: "Coldplay" }]);

  const result = edits.applyEdits(db, ids.map((trackId) => ({ trackId, fields: { albumArtist: "Coldplay", genre: "Alternative Rock" } })), {
    exclude: [{ trackId: ids[1], field: "genre" }],
  });
  assert.equal(result.tracks, 2);
  const shiver = db.prepare("SELECT * FROM tracks WHERE id = ?").get(ids[0]);
  const spies = db.prepare("SELECT * FROM tracks WHERE id = ?").get(ids[1]);
  assert.equal(shiver.genre, "Alternative Rock");
  assert.equal(spies.genre, "Rock", "the excluded field was left alone");
  assert.equal(spies.year, 2001);
  assert.equal(shiver.tags_dirty, 1);
  assert.deepEqual(JSON.parse(shiver.curated_fields).sort(), ["album_artist", "genre"]);

  // A no-op edit creates nothing.
  assert.equal(edits.applyEdits(db, [{ trackId: ids[0], fields: { genre: "Alternative Rock" } }]).operationId, null);
});

test("editing album details moves tracks between albums and keeps search current", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  const sparks = id("Sparks");
  const before = db.prepare("SELECT release_id FROM tracks WHERE id = ?").get(sparks).release_id;
  edits.applyEdits(db, [{ trackId: sparks, fields: { album: "Parachutes", title: "Sparks (Live)" } }]);

  const after = db.prepare("SELECT release_id, title_key FROM tracks WHERE id = ?").get(sparks);
  assert.notEqual(after.release_id, before);
  assert.equal(after.release_id, db.prepare("SELECT release_id FROM tracks WHERE id = ?").get(id("Shiver")).release_id);
  assert.equal(after.title_key, "sparks [live]");
  assert.equal(queries.listTracks(db, { search: "sparks live" }).total, 1);
});

test("undo restores old values and reports later conflicts", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  const shiver = id("Shiver");
  const spies = id("Spies");
  const first = edits.applyEdits(db, [
    { trackId: shiver, fields: { genre: "Alternative Rock" } },
    { trackId: spies, fields: { genre: "Alternative Rock" } },
  ]);
  // The user changes one of them again afterwards.
  edits.applyEdits(db, [{ trackId: spies, fields: { genre: "Britpop" } }]);

  const undo = edits.undoMetadataOperation(db, first.operationId);
  assert.equal(db.prepare("SELECT genre FROM tracks WHERE id = ?").get(shiver).genre, "Alt Rock");
  assert.equal(db.prepare("SELECT genre FROM tracks WHERE id = ?").get(spies).genre, "Britpop", "a newer edit is not overwritten");
  assert.equal(undo.conflicts.length, 1);
  assert.throws(() => edits.undoMetadataOperation(db, first.operationId), /already undone/);

  const history = listOperations(db, {});
  assert.equal(history[0].label.startsWith("Undo:"), true);
  assert.equal(history.find((op) => op.id === first.operationId).was_undone, true);
});

test("curated fields survive a rescan; rule results don't count as curated", needsAudio, async (t) => {
  const { db, scanner, sourceId, id } = await sampleLibrary(t);
  edits.applyEdits(db, [{ trackId: id("Shiver"), fields: { genre: "Alternative Rock" } }]);
  await scanner.scanSource(sourceId);
  assert.equal(db.prepare("SELECT genre FROM tracks WHERE id = ?").get(id("Shiver")).genre, "Alternative Rock");

  const rock = genres.createGenre(db, { name: "Indie Rock" });
  genres.addRule(db, { kind: "artist", artist: "Coldplay", genreId: rock.id });
  genres.applyRules(db);
  const spies = db.prepare("SELECT genre, curated_fields FROM tracks WHERE id = ?").get(id("Spies"));
  assert.equal(spies.genre, "Indie Rock");
  assert.equal(JSON.parse(spies.curated_fields).includes("genre"), false);
});

test("genre rules: manual genres win, album rules beat artist rules, aliases map labels", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  const alternative = genres.createGenre(db, { name: "Alternative Rock" });
  const britpop = genres.createGenre(db, { name: "Britpop" });
  const house = genres.createGenre(db, { name: "French House" });
  genres.addAlias(db, { alias: "Electronic", genreId: house.id });
  genres.addRule(db, { kind: "artist", artist: "Coldplay", genreId: alternative.id });
  const parachutes = db.prepare("SELECT release_id FROM tracks WHERE id = ?").get(id("Shiver")).release_id;
  genres.addRule(db, { kind: "album", releaseId: parachutes, genreId: britpop.id });
  edits.applyEdits(db, [{ trackId: id("Spies"), fields: { genre: "Dream Pop" } }]); // manual

  const proposals = genres.previewRules(db);
  const byTitle = Object.fromEntries(proposals.map((item) => [item.title, item]));
  assert.equal(byTitle.Shiver.to, "Britpop", "album rule wins over artist rule");
  assert.match(byTitle.Shiver.reason, /Album rule/);
  assert.equal(byTitle.Sparks.to, "Alternative Rock", "artist rule for a track on another album");
  assert.equal(byTitle["One More Time"].to, "French House", "alias mapping");
  assert.equal(byTitle.Spies, undefined, "a manually set genre is never touched");

  const applied = genres.applyRules(db, { exclude: [id("Sparks")] });
  assert.equal(applied.tracks, proposals.length - 1);
  assert.equal(db.prepare("SELECT genre FROM tracks WHERE id = ?").get(id("Sparks")).genre, "");
});

test("renaming and merging genres retags songs and keeps old names as aliases", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  genres.adoptLabels(db);
  const taxonomy = genres.listTaxonomy(db);
  assert.deepEqual(taxonomy.map((genre) => genre.name).sort(), ["Alt Rock", "Electronic", "Rock"]);

  const altRock = taxonomy.find((genre) => genre.name === "Alt Rock");
  genres.renameGenre(db, { id: altRock.id, name: "Alternative Rock" });
  assert.equal(db.prepare("SELECT genre FROM tracks WHERE id = ?").get(id("Shiver")).genre, "Alternative Rock");

  const rock = taxonomy.find((genre) => genre.name === "Rock");
  genres.mergeGenres(db, { targetId: altRock.id, genreIds: [rock.id] });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE genre = 'Rock'").get().n, 0);
  assert.deepEqual(genres.listTaxonomy(db).find((genre) => genre.id === altRock.id).aliases.sort(), ["Alt Rock", "Rock"]);
  assert.throws(() => genres.createGenre(db, { name: "alternative rock" }), /already/);
});

test("the genre report finds unknown labels and near-duplicates", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  genres.createGenre(db, { name: "Hip-Hop" });
  edits.applyEdits(db, [
    { trackId: id("Spies"), fields: { genre: "Hip Hop" } },
    { trackId: id("Sparks"), fields: { genre: "HipHop" } },
  ]);
  const report = genres.genreReport(db);
  const hipHop = report.unrecognized.find((row) => row.label === "Hip Hop");
  assert.equal(hipHop.suggestion.name, "Hip-Hop");
  assert.ok(report.similar.some((group) => group.includes("Hip-Hop") && group.includes("HipHop")));
  assert.equal(genres.similar("Alternative Rock", "Alternatve Rock"), true);
  assert.equal(genres.similar("Pop", "Rock"), false);
});

test("the review queue persists decisions and resolves fixed issues", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t);
  review.refreshReview(db);

  const all = review.listReviewItems(db, { status: "open", limit: 200 }).rows;
  const kinds = new Set(all.map((item) => item.kind));
  for (const kind of ["missing_album", "missing_artwork", "missing_album_artist", "track_numbering", "inconsistent_album", "similar_albums", "unclassified_genre"]) {
    assert.ok(kinds.has(kind), kind);
  }

  // Ignore one, then refresh: still ignored.
  const artworkItem = all.find((item) => item.kind === "missing_artwork");
  review.setReviewStatus(db, { ids: [artworkItem.id], status: "ignored" });
  review.refreshReview(db);
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(artworkItem.id).status, "ignored");

  // Approving the suggestion fixes the album; the item resolves.
  const similarItem = all.find((item) => item.kind === "similar_albums");
  assert.equal(similarItem.status, "suggested");
  review.approveSuggestions(db, { ids: [similarItem.id] });
  assert.equal(db.prepare("SELECT album FROM tracks WHERE id = ?").get(id("Sparks")).album, "Parachutes");
  review.refreshReview(db);
  assert.notEqual(db.prepare("SELECT status FROM review_items WHERE id = ?").get(similarItem.id).status, "suggested");

  // Fixing a missing album resolves it; breaking it again reopens the item.
  const missing = all.find((item) => item.kind === "missing_album" && item.entity_id === id("Untitled"));
  edits.applyEdits(db, [{ trackId: id("Untitled"), fields: { album: "Samples" } }]);
  review.refreshReview(db);
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(missing.id).status, "resolved");
  edits.applyEdits(db, [{ trackId: id("Untitled"), fields: { album: "" } }]);
  review.refreshReview(db);
  assert.equal(db.prepare("SELECT status FROM review_items WHERE id = ?").get(missing.id).status, "needs_review");
});

test("artwork store keeps original bytes and accepts only JPEG/PNG", (t) => {
  const store = createArtStore(makeTempDir(t));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);
  const saved = store.save(jpeg);
  assert.equal(saved.mime, "image/jpeg");
  assert.deepEqual(store.read(saved.hash).data, jpeg);
  assert.equal(store.save(jpeg).hash, saved.hash, "stored once per image");
  assert.throws(() => store.save(Buffer.from("GIF89a....")), /JPEG or PNG/);
});

// --- Safe tag writing ---------------------------------------------------------

function fileOpsFor(t, db) {
  const dir = makeTempDir(t, "wavemint-ops-");
  const artStore = createArtStore(path.join(dir, "art"));
  return { artStore, ops: createFileOps({ db, media: mediaForTests(), artStore, backupsRoot: path.join(dir, "backups"), logger: quietLogger }), dir };
}

test("read-only sources and WAV files are never written", needsAudio, async (t) => {
  const { db, music, id } = await sampleLibrary(t, { writable: false });
  const { ops } = fileOpsFor(t, db);
  edits.applyEdits(db, [
    { trackId: id("Shiver"), fields: { genre: "Alternative Rock" } },
    { trackId: id("Untitled"), fields: { title: "Sample" } },
  ]);
  const before = snapshotFolder(music);

  const preview = ops.previewTagWrite();
  assert.equal(preview.writable.length, 0);
  assert.equal(preview.blocked.length, 2);
  assert.match(preview.blocked.find((item) => item.title === "Shiver").reason, /read-only/);

  const result = await ops.writeTagsJob();
  assert.equal(result.written, 0);
  assert.deepEqual(snapshotFolder(music), before, "nothing on disk changed");
});

test("tags are written safely: backup, verified tags, identical audio", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t, { writable: true });
  const { ops, artStore } = fileOpsFor(t, db);
  const shiver = id("Shiver");
  const spies = id("Spies");
  const art = artStore.save(coverBytes("purple"));
  edits.applyEdits(db, [
    { trackId: shiver, fields: { title: "Shiver", genre: "Alternative Rock", albumArtist: "Coldplay", year: 2000, trackTotal: 10 } },
    { trackId: spies, fields: { genre: "Alternative Rock", year: 2000 } },
  ]);
  edits.setTrackArtwork(db, [spies], art.hash);

  const shiverFile = db.prepare("SELECT f.* FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(shiver);
  const audioBefore = await mediaForTests().audioStreamHash(shiverFile.path);

  const preview = ops.previewTagWrite();
  assert.equal(preview.writable.length, 2);
  assert.ok(preview.writable.find((item) => item.trackId === spies).changes.some((change) => change.field === "artwork"));

  const result = await ops.writeTagsJob();
  assert.deepEqual({ written: result.written, failed: result.failed }, { written: 2, failed: 0 });

  const tags = readTags(shiverFile.path);
  assert.equal(tags.genre, "Alternative Rock");
  assert.equal(tags.albumArtist, "Coldplay");
  assert.equal(tags.trackTotal, 10);
  assert.equal(await mediaForTests().audioStreamHash(shiverFile.path), audioBefore, "audio stream untouched");
  assert.equal(fs.readFileSync(shiverFile.path).subarray(0, 4).toString("latin1").slice(0, 3), "ID3");
  assert.equal(fs.readFileSync(shiverFile.path)[3], 3, "ID3v2.3 for Apple compatibility");

  const spiesFile = db.prepare("SELECT f.* FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(spies);
  assert.equal(readTags(spiesFile.path).artworkHash, art.hash, "artwork embedded byte-for-byte");
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(shiver).tags_dirty, 0);
  assert.equal(ops.previewTagWrite().writable.length, 0, "nothing left to write");

  // No temporary files left next to the music.
  for (const name of fs.readdirSync(path.dirname(shiverFile.path))) assert.doesNotMatch(name, /wmtmp|wmold/);

  // Undo restores the original bytes from the verified backup.
  const originalHash = db
    .prepare("SELECT details FROM operation_steps WHERE file_id = ?")
    .all(shiverFile.id)
    .map((row) => JSON.parse(row.details).originalHash)[0];
  const undo = await ops.undoTagWrite(result.operationId);
  assert.equal(undo.restored, 2);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(shiverFile.path)).digest("hex"), originalHash);
  assert.equal(readTags(shiverFile.path).genre, "Alt Rock");
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(shiver).tags_dirty, 1, "edits still pending in WaveMint");
});

test("a failed verification leaves the original file untouched", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t, { writable: true });
  const dir = makeTempDir(t, "wavemint-ops-");
  const realMedia = mediaForTests();
  let calls = 0;
  // Pretend the audio changed while writing.
  const media = { audioStreamHash: async (file) => ((calls += 1) % 2 === 0 ? "different" : realMedia.audioStreamHash(file)) };
  const ops = createFileOps({ db, media, artStore: createArtStore(path.join(dir, "art")), backupsRoot: path.join(dir, "b"), logger: quietLogger });
  const shiver = id("Shiver");
  const file = db.prepare("SELECT f.path FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(shiver).path;
  const before = fs.readFileSync(file);
  edits.applyEdits(db, [{ trackId: shiver, fields: { genre: "Alternative Rock" } }]);

  const result = await ops.writeTagsJob({ trackIds: [shiver] });
  assert.equal(result.failed, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(siblingPath(file, "wmtmp")), false);
  assert.equal(db.prepare("SELECT tags_dirty FROM tracks WHERE id = ?").get(shiver).tags_dirty, 1);
});

test("a file changed outside WaveMint since the scan is not overwritten", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t, { writable: true });
  const { ops } = fileOpsFor(t, db);
  const shiver = id("Shiver");
  const file = db.prepare("SELECT f.path FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(shiver).path;
  edits.applyEdits(db, [{ trackId: shiver, fields: { genre: "Alternative Rock" } }]);
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(file, future, future);

  const result = await ops.writeTagsJob({ trackIds: [shiver] });
  assert.equal(result.failed, 1);
  assert.match(db.prepare("SELECT error FROM operation_steps ORDER BY id DESC").get().error, /changed since it was scanned/);
});

test("an interrupted write is rolled back at the next start", needsAudio, async (t) => {
  const { db, id } = await sampleLibrary(t, { writable: true });
  const { ops } = fileOpsFor(t, db);
  const shiver = id("Shiver");
  const file = db.prepare("SELECT f.id, f.path FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(shiver);
  const original = fs.readFileSync(file.path);

  // Simulate a crash in the middle of the swap: original renamed away, the
  // staged copy not yet in place.
  const operationId = startOperation(db, { kind: "tag-write", label: "Write tags" });
  addStep(db, operationId, { action: "write-tags", fileId: file.id, trackId: shiver, targetPath: file.path, stagedPath: siblingPath(file.path, "wmtmp") });
  fs.copyFileSync(file.path, siblingPath(file.path, "wmtmp"));
  fs.renameSync(file.path, siblingPath(file.path, "wmold"));

  const report = ops.recover();
  assert.equal(report.length, 1);
  assert.deepEqual(fs.readFileSync(file.path), original, "the original is back");
  assert.equal(fs.existsSync(siblingPath(file.path, "wmold")), false);
  assert.equal(fs.existsSync(siblingPath(file.path, "wmtmp")), false);
  assert.equal(db.prepare("SELECT status FROM operations WHERE id = ?").get(operationId).status, "interrupted");
});
