const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const { createConsolidator } = require("../electron/library/consolidate.cjs");
const edits = require("../electron/library/edits.cjs");
const { createMerge } = require("../electron/library/merge.cjs");
const { addStep, startOperation, updateStep } = require("../electron/library/operations.cjs");
const { planPaths, relativePathFor, safeSegment, validatePattern } = require("../electron/library/organize.cjs");
const queries = require("../electron/library/queries.cjs");
const { contentHash } = require("../electron/library/scanner.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const {
  SKIP_REASON,
  addAndScan,
  createTestLibrary,
  makeTempDir,
  makeTrack,
  mediaForTests,
  quietLogger,
  snapshotFolder,
} = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

// --- Naming -------------------------------------------------------------------

test("the naming pattern builds tidy, Windows-safe paths", () => {
  const sep = path.sep;
  assert.equal(
    relativePathFor({ album_artist: "Coldplay", artist: "Coldplay", album: "Parachutes", track_no: 5, title: "Yellow" }),
    `Coldplay${sep}Parachutes${sep}05 Yellow`,
  );
  assert.equal(
    relativePathFor({ artist: "Various", album: "Now 47", compilation: 1, track_no: 3, title: "Song" }),
    `Various Artists${sep}Now 47${sep}03 Song`,
  );
  assert.equal(relativePathFor({ artist: "Solo", title: "Single" }), `Solo${sep}Singles${sep}Single`);
  assert.equal(
    relativePathFor({ album_artist: "Pink Floyd", album: "The Wall", disc_no: 2, disc_total: 2, track_no: 1, title: "Hey You" }),
    `Pink Floyd${sep}The Wall${sep}2-01 Hey You`,
  );
  assert.equal(
    relativePathFor({ artist: "A", album: "B", year: 2001, title: "C" }, "{artist}/{album} ({year})/{title}"),
    `A${sep}B (2001)${sep}C`,
  );
  assert.equal(relativePathFor({ artist: "A", album: "B", title: "C" }, "{artist}/{album} ({year})/{title}"), `A${sep}B${sep}C`);

  assert.equal(safeSegment('AC/DC: "Back" <In> Black?'), "AC DC Back In Black");
  assert.equal(safeSegment("CON"), "CON_");
  assert.equal(safeSegment("Title..."), "Title");
  assert.equal(safeSegment("   "), "Unknown");
  assert.ok(safeSegment("x".repeat(300)).length <= 100);
  assert.throws(() => validatePattern("{artist}/{album}"), /\{title\}/);
  assert.throws(() => validatePattern("../{title}"), /drive letters/);
  assert.throws(() => validatePattern("{title}{nope}"), /Unknown naming token/);
});

test("planned paths never collide, even case-insensitively, and avoid existing files", () => {
  const items = [
    { track: { artist: "A", album: "B", title: "Song" }, ext: ".mp3" },
    { track: { artist: "a", album: "b", title: "song" }, ext: ".MP3" },
    { track: { artist: "A", album: "B", title: "Other" }, ext: ".m4a" },
  ];
  const existing = new Set([path.join("C:\\Lib", "A", "B", "Other.m4a").toLowerCase()]);
  const planned = planPaths(items, { root: "C:\\Lib", exists: (target) => existing.has(target.toLowerCase()) });
  assert.equal(planned[0].relPath, path.join("A", "B", "Song.mp3"));
  assert.equal(planned[1].relPath, path.join("a", "b", "song (2).mp3"));
  assert.equal(planned[2].relPath, path.join("A", "B", "Other (2).m4a"));
});

// --- Merge ----------------------------------------------------------------------

async function twoLibraries(t) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const legacy = path.join(root, "iTunes Media");
  const curated = path.join(root, "Curated");

  // Legacy: a 6-song album, a duplicate copy, a live version, a legacy-only single.
  for (let i = 1; i <= 6; i += 1) {
    makeTrack(legacy, `Coldplay/Parachutes/0${i} Song ${i}.mp3`, { tags: { title: `Song ${i}`, artist: "Coldplay", album: "Parachute", trackNo: i, genre: "Rock" } });
  }
  fs.copyFileSync(path.join(legacy, "Coldplay/Parachutes/05 Song 5.mp3"), path.join(legacy, "Coldplay/Parachutes/05 Song 5 1.mp3"));
  makeTrack(legacy, "Coldplay/Live/01 Song 1 (Live).mp3", { base: "mp3_other", tags: { title: "Song 1 (Live)", artist: "Coldplay", album: "Live 2003" } });
  makeTrack(legacy, "Daft Punk/Discovery/01 One More Time.mp3", { tags: { title: "One More Time", artist: "Daft Punk", album: "Discovery" } });

  // Curated: better copies of songs 2 and 3, a remaster of song 4, a curated-only song.
  makeTrack(curated, "Coldplay/Parachutes/02 Song 2.m4a", { base: "m4a", tags: { title: "Song 2", artist: "Coldplay", albumArtist: "Coldplay", album: "Parachutes", trackNo: 2, year: 2000, genre: "Alternative Rock" } });
  makeTrack(curated, "Coldplay/Parachutes/03 Song 3.flac", { base: "flac", tags: { title: "Song 3", artist: "Coldplay", albumArtist: "Coldplay", album: "Parachutes", trackNo: 3, year: 2000, genre: "Alternative Rock" } });
  makeTrack(curated, "Coldplay/Parachutes/04 Song 4 (Remastered).flac", { base: "flac", tags: { title: "Song 4 (Remastered)", artist: "Coldplay", albumArtist: "Coldplay", album: "Parachutes", trackNo: 4 } });
  makeTrack(curated, "Florence/Lungs/01 Dog Days.m4a", { base: "m4a", tags: { title: "Dog Days", artist: "Florence + The Machine", album: "Lungs" } });

  const legacyId = await addAndScan(lib.db, lib.scanner, legacy, { role: "legacy" });
  const curatedId = await addAndScan(lib.db, lib.scanner, curated, { role: "curated" });
  const merge = createMerge({ db: lib.db, contentHash, logger: quietLogger });
  const id = (title, sourceId) =>
    lib.db
      .prepare("SELECT t.id FROM tracks t JOIN files f ON f.id = t.active_file_id WHERE t.title = ? AND f.source_id = ? ORDER BY t.id")
      .get(title, sourceId)?.id;
  return { ...lib, root, legacy, curated, legacyId, curatedId, merge, id };
}

test("merge analysis classifies recordings and changes no files", needsAudio, async (t) => {
  const lib = await twoLibraries(t);
  const before = { legacy: snapshotFolder(lib.legacy), curated: snapshotFolder(lib.curated) };

  const { sessionId, summary } = await lib.merge.analyze();
  assert.deepEqual(snapshotFolder(lib.legacy), before.legacy);
  assert.deepEqual(snapshotFolder(lib.curated), before.curated);

  assert.equal(summary.sourceTracks, 13);
  assert.equal(summary.alreadyCurated, 2, "songs 2 and 3");
  assert.equal(summary.curatedOnly, 2, "the remaster and the curated-only song");
  assert.equal(summary.conflicts, 1, "the remaster needs a decision");
  assert.equal(summary.exactDuplicateGroups, 1, "the copied legacy file");
  assert.equal(summary.expectedTracks, 10);

  const groups = lib.merge.listGroups({ sessionId, onlyMulti: true }).rows;
  const song2 = groups.find((group) => group.members.some((member) => member.title === "Song 2"));
  assert.equal(song2.category, "already_curated");
  assert.equal(song2.preferred_track_id, lib.id("Song 2", lib.curatedId), "the curated copy is preferred");
  const live = groups.find((group) => group.members.some((member) => member.title === "Song 1 (Live)"));
  assert.equal(live, undefined, "the live version is not grouped with the studio song");
});

test("applying a merge links versions, remembers decisions, and can be undone", needsAudio, async (t) => {
  const lib = await twoLibraries(t);
  const before = { legacy: snapshotFolder(lib.legacy), curated: snapshotFolder(lib.curated) };
  const { sessionId } = await lib.merge.analyze();

  const conflict = lib.merge.listGroups({ sessionId, category: "conflict" }).rows[0];
  lib.merge.setGroupAction({ groupId: conflict.id, action: "keep_both" });
  lib.merge.acceptSuggestions({ sessionId, categories: ["already_curated", "legacy_only", "curated_only"] });
  const result = lib.merge.apply({ sessionId });

  assert.deepEqual(snapshotFolder(lib.legacy), before.legacy, "merging never touches files");
  assert.deepEqual(snapshotFolder(lib.curated), before.curated);
  assert.equal(result.linked, 3, "songs 2 and 3, and the duplicate copy");
  assert.equal(queries.listTracks(lib.db, {}).total, 10);

  const song2 = queries.getTrack(lib.db, lib.id("Song 2", lib.curatedId));
  assert.equal(song2.files.length, 2, "the legacy file is now an alternate version");
  assert.equal(song2.files[0].source_role, "curated", "the curated file stays active");
  assert.equal(song2.genre, "Alternative Rock", "curated metadata is kept");

  // A new analysis doesn't propose the same merges or the rejected remaster again.
  const second = await lib.merge.analyze();
  assert.equal(second.summary.alreadyCurated, 0);
  assert.equal(second.summary.conflicts, 0);

  lib.merge.undoMerge(result.operationId);
  assert.equal(queries.listTracks(lib.db, {}).total, 13);
  assert.equal(queries.getTrack(lib.db, lib.id("Song 2", lib.curatedId)).files.length, 1);
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM match_decisions").get().n, 0, "undo forgets the merge's decisions");
  const third = await lib.merge.analyze();
  assert.equal(third.summary.conflicts, 1, "the remaster is offered again");
  assert.throws(() => lib.merge.undoMerge(result.operationId), /already undone/);
});

test("a partial album is consolidated into the curated album", needsAudio, async (t) => {
  const lib = await twoLibraries(t);
  // The legacy album is tagged "Parachute", so it is a separate release.
  const { sessionId, summary } = await lib.merge.analyze();
  const proposal = summary.albumProposals.find((item) => item.toTitle === "Parachutes");
  assert.ok(proposal, "a consolidation is proposed");
  assert.equal(proposal.fromTitle, "Parachute");
  assert.equal(proposal.trackIds.length, 5, "songs 1, 4, 5, 6 and the copy of 5 stay legacy and join the album");

  lib.merge.acceptSuggestions({ sessionId, categories: ["already_curated", "legacy_only", "curated_only"] });
  lib.merge.apply({ sessionId, acceptedAlbums: [proposal.fromReleaseId] });

  const album = lib.db.prepare("SELECT release_id FROM tracks WHERE id = ?").get(lib.id("Song 2", lib.curatedId)).release_id;
  const members = lib.db.prepare("SELECT title, album, album_artist, year FROM tracks WHERE release_id = ? AND state = 'active' ORDER BY track_no, title").all(album);
  assert.deepEqual(members.map((member) => member.title), ["Song 1", "Song 2", "Song 3", "Song 4", "Song 4 (Remastered)", "Song 5", "Song 6"]);
  const moved = members.filter((member) => ["Song 1", "Song 4", "Song 5", "Song 6"].includes(member.title));
  assert.ok(moved.every((member) => member.album === "Parachutes" && member.album_artist === "Coldplay" && member.year === 2000));
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE album = 'Parachute' AND state = 'active'").get().n, 0);
});

// --- Managed Library ------------------------------------------------------------

function consolidatorFor(t, db) {
  const dir = makeTempDir(t, "wavemint-art-");
  return createConsolidator({ db, media: mediaForTests(), artStore: createArtStore(dir), logger: quietLogger });
}

test("consolidation copies, tags the copies, verifies, and never touches sources", needsAudio, async (t) => {
  const lib = await twoLibraries(t);
  const { sessionId } = await lib.merge.analyze();
  lib.merge.acceptSuggestions({ sessionId, categories: ["already_curated", "legacy_only", "curated_only"] });
  lib.merge.apply({ sessionId });

  // A curated edit that exists only in WaveMint so far.
  const song6 = lib.id("Song 6", lib.legacyId);
  edits.applyEdits(lib.db, [{ trackId: song6, fields: { genre: "Britpop", albumArtist: "Coldplay" } }]);

  const before = { legacy: snapshotFolder(lib.legacy), curated: snapshotFolder(lib.curated) };
  const managedRoot = path.join(lib.root, "WaveMint Library");
  fs.mkdirSync(managedRoot);
  const consolidator = consolidatorFor(t, lib.db);

  const preview = consolidator.preview({ root: managedRoot });
  assert.equal(preview.toCopy, 10);
  assert.ok(preview.bytes > 0);
  assert.ok(preview.tagsWritten >= 1);
  assert.ok(preview.samples.some((sample) => sample.relPath === path.join("Coldplay", "Parachute", "06 Song 6.mp3")));
  assert.equal(fs.readdirSync(managedRoot).length, 0, "previewing copies nothing");

  const report = await consolidator.consolidateJob({ root: managedRoot });
  assert.equal(report.copied, 10);
  assert.equal(report.failed, 0);
  assert.deepEqual(snapshotFolder(lib.legacy), before.legacy, "legacy files untouched");
  assert.deepEqual(snapshotFolder(lib.curated), before.curated, "curated files untouched");

  const copy = path.join(managedRoot, "Coldplay", "Parachute", "06 Song 6.mp3");
  assert.equal(readTags(copy).genre, "Britpop", "WaveMint's metadata is in the copy");
  assert.equal(readTags(path.join(lib.legacy, "Coldplay/Parachutes/06 Song 6.mp3")).genre, "Rock", "and not in the source");
  assert.ok(fs.existsSync(path.join(managedRoot, "Coldplay", "Parachutes", "03 Song 3.flac")), "the curated FLAC was kept as FLAC");
  const allCopies = Object.keys(snapshotFolder(managedRoot));
  assert.equal(allCopies.length, 10);
  assert.ok(allCopies.every((name) => !/wmtmp/.test(name)));

  const track = queries.getTrack(lib.db, song6);
  const active = track.files.find((file) => file.id === track.active_file_id);
  assert.equal(active.source_role, "managed");
  assert.equal(track.tags_dirty, 0);

  // Rescanning the managed folder recognizes the copies instead of adding songs.
  const totalBefore = queries.listTracks(lib.db, {}).total;
  const rescan = await lib.scanner.scanSource(consolidator.managedSource().id);
  assert.equal(rescan.status, "completed");
  assert.equal(rescan.stats.added, 0);
  assert.equal(queries.listTracks(lib.db, {}).total, totalBefore);

  // Running again copies nothing; undo switches back without deleting copies.
  assert.equal((await consolidator.consolidateJob({ root: managedRoot })).copied, 0);
  consolidator.undoConsolidation(report.operationId);
  const restored = queries.getTrack(lib.db, song6);
  assert.equal(restored.files.find((file) => file.id === restored.active_file_id).source_role, "legacy");
  assert.ok(fs.existsSync(copy), "copies are kept on disk");

  // Copying again reuses those copies instead of making "(2)" duplicates.
  const again = await consolidator.consolidateJob({ root: managedRoot });
  assert.equal(again.copied, 0);
  assert.equal(again.reused, 10);
  assert.equal(Object.keys(snapshotFolder(managedRoot)).length, 10);
  const reactivated = queries.getTrack(lib.db, song6);
  assert.equal(reactivated.files.find((file) => file.id === reactivated.active_file_id).path, copy);
});

test("consolidation never overwrites an existing file", needsAudio, async (t) => {
  const lib = await twoLibraries(t);
  const managedRoot = path.join(lib.root, "Managed");
  const occupied = path.join(managedRoot, "Daft Punk", "Discovery", "01 One More Time.mp3");
  fs.mkdirSync(path.dirname(occupied), { recursive: true });
  fs.writeFileSync(occupied, "someone else's file");

  const consolidator = consolidatorFor(t, lib.db);
  await consolidator.consolidateJob({ root: managedRoot, trackIds: [lib.id("One More Time", lib.legacyId)] });
  assert.equal(fs.readFileSync(occupied, "utf8"), "someone else's file");
  assert.ok(fs.existsSync(path.join(managedRoot, "Daft Punk", "Discovery", "01 One More Time (2).mp3")));
});

test("an interrupted consolidation is finished or cleaned up at the next start", needsAudio, async (t) => {
  const lib = await twoLibraries(t);
  const managedRoot = path.join(lib.root, "Managed");
  fs.mkdirSync(managedRoot);
  const consolidator = consolidatorFor(t, lib.db);
  consolidator.ensureManagedSource(managedRoot);

  const placedTrack = lib.id("One More Time", lib.legacyId);
  const stagedTrack = lib.id("Dog Days", lib.curatedId);
  const operationId = startOperation(lib.db, { kind: "consolidate", label: "Copy" });

  // One copy was renamed into place but not yet recorded…
  const placedTarget = path.join(managedRoot, "Daft Punk", "Discovery", "01 One More Time.mp3");
  fs.mkdirSync(path.dirname(placedTarget), { recursive: true });
  fs.copyFileSync(path.join(lib.legacy, "Daft Punk/Discovery/01 One More Time.mp3"), placedTarget);
  const placedStep = addStep(lib.db, operationId, { action: "consolidate", trackId: placedTrack, targetPath: placedTarget });
  updateStep(lib.db, placedStep, { state: "placed" });

  // …another was still a temporary copy.
  const stagedTarget = path.join(managedRoot, "Florence", "Lungs", "Dog Days.m4a");
  const stagedPath = path.join(managedRoot, "Florence", "Lungs", "Dog Days.wmtmp.m4a");
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
  fs.writeFileSync(stagedPath, "partial");
  const stagedStep = addStep(lib.db, operationId, { action: "consolidate", trackId: stagedTrack, targetPath: stagedTarget, stagedPath });
  updateStep(lib.db, stagedStep, { state: "copied" });

  const report = consolidator.recover();
  assert.equal(report.find((item) => item.trackId === placedTrack).outcome, "done");
  assert.equal(report.find((item) => item.trackId === stagedTrack).outcome, "rolled_back");
  assert.equal(fs.existsSync(stagedPath), false);
  const track = queries.getTrack(lib.db, placedTrack);
  assert.equal(track.files.find((file) => file.id === track.active_file_id).path, placedTarget);
  assert.equal(lib.db.prepare("SELECT status FROM operations WHERE id = ?").get(operationId).status, "interrupted");
});
