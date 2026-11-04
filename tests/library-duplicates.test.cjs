const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { findDuplicates } = require("../electron/library/duplicates.cjs");
const formats = require("../electron/library/formats.cjs");
const { createMerge } = require("../electron/library/merge.cjs");
const playlists = require("../electron/library/playlists.cjs");
const review = require("../electron/library/review.cjs");
const { contentHash } = require("../electron/library/scanner.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, makeTempDir, makeTrack, quietLogger, snapshotFolder } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

// --- Matching rules (no audio needed) ----------------------------------------------

let nextId = 1;
const song = (title, artist, extra = {}) => ({ id: nextId++, title, artist, album: "", duration_ms: 200000, size: 1000 + nextId, ...extra });
const tiersOf = (result) => [...result.strong, ...result.possible].map((group) => ({ tier: group.tier, ids: group.trackIds }));

test("identical files and same-title, same-length songs are duplicates", () => {
  const a = song("Blinding Lights", "The Weeknd", { content_hash: "x" });
  const b = song("Blinding Lights (Radio Edit)", "Someone Else", { content_hash: "x" });
  const c = song("Halo", "Beyoncé", { duration_ms: 261000 });
  const d = song("Halo", "Beyonce", { duration_ms: 261400, album: "I Am... Sasha Fierce" });
  const result = findDuplicates([a, b, c, d]);
  assert.deepEqual(tiersOf(result), [
    { tier: "identical", ids: [a.id, b.id] },
    { tier: "likely", ids: [c.id, d.id] },
  ]);
  assert.ok(result.strong[1].reasons.includes("Same artist and title"));
});

test("nearly identical titles by the same artist are possible duplicates", () => {
  const a = song("Blinding Lights", "The Weeknd");
  const b = song("The Blinding Lights", "The Weeknd", { duration_ms: 200800 });
  const c = song("Somewhere Only We Know", "Keane");
  const d = song("Somewhere Only We Knew", "Keane", { duration_ms: 199500 });
  const result = findDuplicates([a, b, c, d]);
  assert.deepEqual(tiersOf(result), [
    { tier: "possible", ids: [a.id, b.id] },
    { tier: "possible", ids: [c.id, d.id] },
  ]);
});

test("versions, other artists, other lengths and look-alike titles are not duplicates", () => {
  const cases = [
    [song("Blinding Lights", "The Weeknd"), song("Blinding Lights (Live)", "The Weeknd")],
    [song("Blinding Lights", "The Weeknd"), song("Blinding Lights - Chromatics Remix", "The Weeknd")],
    [song("Hurt", "Nine Inch Nails"), song("Hurt", "Johnny Cash")],
    [song("Halo", "Beyoncé"), song("Halo", "Beyoncé", { duration_ms: 290000 })],
    [song("Symphony Part 1", "A"), song("Symphony Part 2", "A")],
    [song("Home", "A"), song("Hope", "A")],
    [song("Creep", "Radiohead"), song("Creep (Acoustic)", "Radiohead")],
    [song("Smells Like Teen Spirit", "Nirvana"), song("Smells Like Teen Spirit (Instrumental)", "Nirvana")],
    [song("The Night We Met", "Lord Huron", { duration_ms: null }), song("The Night We Met", "Lord Huron", { duration_ms: 208000, album: "B" })],
  ];
  for (const pair of cases) {
    const result = findDuplicates(pair);
    assert.deepEqual(tiersOf(result), [], pair.map((item) => `${item.title} / ${item.artist}`).join(" vs "));
  }
});

test("a remaster label or a few seconds' difference is only a possible match", () => {
  const a = song("Paint It Black", "The Rolling Stones");
  const b = song("Paint It Black (Remastered)", "The Rolling Stones", { duration_ms: 200300 });
  const c = song("Dreams", "Fleetwood Mac", { duration_ms: 257000 });
  const d = song("Dreams", "Fleetwood Mac", { duration_ms: 263000 });
  assert.deepEqual(tiersOf(findDuplicates([a, b, c, d])).map((group) => group.tier), ["possible", "possible"]);
});

test("Keep Both decisions are final", () => {
  const a = song("Halo", "Beyoncé");
  const b = song("Halo", "Beyoncé", { duration_ms: 200100 });
  const decisions = new Map([[`${a.id}:${b.id}`, "different"]]);
  assert.deepEqual(tiersOf(findDuplicates([a, b], { decisions })), []);
});

// --- Review and resolution (real files) -------------------------------------------

async function duplicateLibrary(t) {
  const lib = await createTestLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  makeTrack(music, "A/Album/01 Song.mp3", { tags: { title: "Song", artist: "A", album: "Album", genre: "Pop" } });
  makeTrack(music, "A/Singles/Song.mp3", { tags: { title: "Song", artist: "A", year: 2020 } });
  makeTrack(music, "A/Album/02 Song (Live).mp3", { tags: { title: "Song (Live)", artist: "A", album: "Album" } });
  makeTrack(music, "B/Other.mp3", { base: "mp3_other", tags: { title: "Other", artist: "B", album: "X" } });
  await addAndScan(lib.db, lib.scanner, music);
  const id = (title, album) =>
    lib.db.prepare("SELECT id FROM tracks WHERE title = ? AND (? IS NULL OR album = ?) AND state = 'active'").get(title, album ?? null, album ?? null)?.id;
  const merge = createMerge({ db: lib.db, contentHash, logger: quietLogger });
  return { ...lib, music, id, merge };
}

const duplicates = (db) => review.listReviewItems(db, { group: "duplicates" }).rows;

test("duplicates appear in Review with both songs to compare; a dismissal sticks until the files change", needsAudio, async (t) => {
  const lib = await duplicateLibrary(t);
  review.refreshReview(lib.db);
  const [item] = duplicates(lib.db);
  assert.equal(duplicates(lib.db).length, 1, "the live version is a different recording");
  assert.equal(item.kind, "duplicate");
  assert.equal(item.details.tier, "likely");
  assert.deepEqual(item.members.map((member) => member.album).sort(), ["Album", "Singles"]);
  assert.ok(item.members.every((member) => member.path && member.duration_ms));
  assert.equal(review.reviewSummary(lib.db).groups.duplicates, 1);

  review.setReviewStatus(lib.db, { ids: [item.id], status: "ignored" });
  review.refreshReview(lib.db);
  assert.equal(duplicates(lib.db).length, 0, "dismissed");
  assert.equal(review.listReviewItems(lib.db, { group: "duplicates", status: "ignored" }).total, 1);

  // One of the files changes (replaced or re-tagged outside WaveMint): the warning returns.
  lib.db.prepare("UPDATE files SET size = size + 1 WHERE id = ?").run(item.members[0].file_id);
  review.refreshReview(lib.db);
  assert.equal(duplicates(lib.db)[0]?.id, item.id, "reopened");
});

test("Keep Both removes the warning for good and can be undone", needsAudio, async (t) => {
  const lib = await duplicateLibrary(t);
  review.refreshReview(lib.db);
  const [item] = duplicates(lib.db);
  const kept = lib.merge.keepSeparate({ trackIds: item.details.trackIds });
  review.refreshReview(lib.db);
  assert.equal(duplicates(lib.db).length, 0);
  assert.equal(lib.db.prepare("SELECT status FROM review_items WHERE id = ?").get(item.id).status, "resolved");

  lib.merge.undoMerge(kept.operationId);
  review.refreshReview(lib.db);
  assert.equal(duplicates(lib.db).length, 1);
});

test("merging duplicates links the files, keeps playlists and favorites, never touches a file, and undoes", needsAudio, async (t) => {
  const lib = await duplicateLibrary(t);
  const albumSong = lib.id("Song", "Album");
  const single = lib.id("Song", "Singles");
  lib.db.prepare("UPDATE tracks SET favorite = 1 WHERE id = ?").run(single);
  const list = playlists.createPlaylist(lib.db, { name: "Mix", trackIds: [single] });
  const before = snapshotFolder(lib.music);

  const result = lib.merge.mergeDuplicates({ keepTrackId: albumSong, trackIds: [albumSong, single], fillMetadata: true });
  assert.equal(result.merged, 1);
  assert.deepEqual(snapshotFolder(lib.music), before, "no file is copied, moved, renamed or deleted");

  const kept = lib.db.prepare("SELECT * FROM tracks WHERE id = ?").get(albumSong);
  assert.equal(kept.favorite, 1, "a favorite stays a favorite");
  assert.equal(kept.year, 2020, "empty fields are filled from the other song");
  assert.equal(kept.genre, "Pop", "the kept song's own values stay");
  assert.equal(lib.db.prepare("SELECT state, merged_into FROM tracks WHERE id = ?").get(single).merged_into, albumSong);
  const files = lib.db.prepare("SELECT role FROM files WHERE track_id = ? ORDER BY id").all(albumSong).map((row) => row.role);
  assert.equal(files.length, 2);
  assert.ok(files.includes("alternate"));
  assert.deepEqual(playlists.getPlaylist(lib.db, { id: list.id }).tracks.map((row) => row.id), [albumSong], "the playlist follows the merge");
  review.refreshReview(lib.db);
  assert.equal(duplicates(lib.db).length, 0);

  lib.merge.undoMerge(result.operationId);
  assert.equal(lib.db.prepare("SELECT state FROM tracks WHERE id = ?").get(single).state, "active");
  assert.equal(lib.db.prepare("SELECT favorite, year FROM tracks WHERE id = ?").get(albumSong).year, null);
  assert.equal(lib.db.prepare("SELECT favorite FROM tracks WHERE id = ?").get(albumSong).favorite, 0);
  assert.deepEqual(playlists.getPlaylist(lib.db, { id: list.id }).tracks.map((row) => row.id), [single]);
});

test("Forget Reference only forgets leftovers, and never deletes audio", needsAudio, async (t) => {
  const lib = await duplicateLibrary(t);
  const live = lib.id("Song (Live)");
  const other = lib.id("Other");
  const pathOf = (trackId) => lib.db.prepare("SELECT f.path FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.id = ?").get(trackId).path;
  const livePath = pathOf(live);
  const otherPath = pathOf(other);

  // A removed song whose file was deleted outside WaveMint: a leftover reference.
  lib.db.prepare("UPDATE tracks SET state = 'removed' WHERE id = ?").run(live);
  fs.rmSync(livePath);
  // A song in the library whose file went missing: a real problem, never forgotten.
  const parked = path.join(makeTempDir(t, "wavemint-parked-"), "Other.mp3");
  fs.renameSync(otherPath, parked);

  const listed = formats.listMissingFiles(lib.db);
  const byTrack = Object.fromEntries(listed.map((item) => [item.trackId, item]));
  assert.equal(byTrack[live].kind, "leftover");
  assert.equal(byTrack[live].canForget, true);
  assert.equal(byTrack[other].kind, "moved");
  assert.equal(byTrack[other].canForget, false);

  const before = snapshotFolder(lib.music);
  const result = formats.forgetLeftoverReferences(lib.db, { fileIds: listed.map((item) => item.fileId) });
  assert.equal(result.forgotten, 1);
  assert.match(result.skipped[0].reason, /current file/);
  assert.deepEqual(snapshotFolder(lib.music), before, "nothing on disk changes");
  assert.ok(fs.existsSync(parked));
  assert.deepEqual(formats.listMissingFiles(lib.db).map((item) => item.trackId), [other]);
  assert.throws(() => formats.forgetMissingFile(lib.db, { fileId: byTrack[other].fileId }), /current file/);
});
