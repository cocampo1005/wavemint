const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const { ARCHIVE_DIR, createConsolidator } = require("../electron/library/consolidate.cjs");
const edits = require("../electron/library/edits.cjs");
const { createMerge } = require("../electron/library/merge.cjs");
const { addStep, startOperation, updateStep } = require("../electron/library/operations.cjs");
const quality = require("../electron/library/quality.cjs");
const queries = require("../electron/library/queries.cjs");
const { contentHash } = require("../electron/library/scanner.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { createUpgrader } = require("../electron/library/upgrade.cjs");
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

// --- Signals and statuses (no audio needed) ---------------------------------------

test("quality signals are hints, and statuses follow them", () => {
  const mp3 = { codec: "mp3", lossless: 0, bitrate: 128, sample_rate: 44100, duration_ms: 1000, status: "ok" };
  const flac = { codec: "flac", lossless: 1, bitrate: 900, sample_rate: 44100, bit_depth: 16, duration_ms: 1000, status: "ok" };
  assert.deepEqual(quality.fileSignals(mp3, null, { lowBitrateKbps: 160 }).map((item) => item.code), ["low_bitrate"]);
  assert.deepEqual(quality.fileSignals(flac, null).map((item) => item.code), []);
  assert.deepEqual(quality.fileSignals({ ...flac, status: "missing" }, null).map((item) => item.code), ["missing"]);

  const clean = { decode_errors: 0, truncated: 0, peak_db: -3, peak_count: 2, sample_count: 1e6, band_mid_db: -48, band_high_db: -47 };
  const cutoff = { ...clean, band_high_db: -62 };
  assert.deepEqual(quality.fileSignals(flac, cutoff).map((item) => item.code), ["lossless_cutoff"]);
  assert.deepEqual(quality.fileSignals({ ...mp3, bitrate: 320 }, cutoff).map((item) => item.code), ["hidden_cutoff"]);
  assert.deepEqual(quality.fileSignals(flac, { ...clean, decode_errors: 3 }).map((item) => item.code), ["decode_errors"]);
  assert.deepEqual(quality.fileSignals(flac, { ...clean, truncated: 1 }).map((item) => item.code), ["truncated"]);
  assert.deepEqual(quality.fileSignals(flac, { ...clean, peak_db: 0, peak_count: 5000 }).map((item) => item.code), ["clipping"]);
  assert.deepEqual(quality.fileSignals(flac, { ...cutoff, band_mid_db: -95 }).map((item) => item.code), [], "silence says nothing");

  assert.equal(quality.computedStatus({ reasons: [], checked: false }), "unknown");
  assert.equal(quality.computedStatus({ reasons: [], checked: true }), "acceptable");
  assert.equal(quality.computedStatus({ reasons: [{ level: 1 }], checked: true }), "acceptable", "minor hints alone don't ask for review");
  assert.equal(quality.computedStatus({ reasons: [{ level: 2 }], checked: true }), "review_suggested");
  assert.equal(quality.computedStatus({ reasons: [], checked: true, betterVersion: true }), "upgrade_available");

  assert.ok(quality.technicalTier(flac) > quality.technicalTier({ ...mp3, bitrate: 320 }));
  assert.ok(quality.technicalTier({ ...mp3, codec: "aac", bitrate: 256 }) > quality.technicalTier({ ...mp3, bitrate: 192 }));
  assert.equal(quality.describeFile(flac), "FLAC 16-bit/44.1 kHz");
});

// --- Checks on real files -----------------------------------------------------------

async function qualityLibrary(t) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const legacy = path.join(root, "Legacy");
  makeTrack(legacy, "A/Album/01 Low.mp3", { base: "noise_128", tags: { title: "Low", artist: "A", album: "Album", trackNo: 1 } });
  makeTrack(legacy, "A/Album/02 Lossless.flac", { base: "noise_flac", tags: { title: "Lossless", artist: "A", album: "Album", trackNo: 2 } });
  makeTrack(legacy, "A/Album/03 Transcoded.mp3", { base: "noise_transcoded", tags: { title: "Transcoded", artist: "A", album: "Album", trackNo: 3 } });
  makeTrack(legacy, "A/Album/04 Good.mp3", { base: "noise_320", tags: { title: "Good", artist: "A", album: "Album", trackNo: 4 } });
  // A damaged copy: the middle of the file overwritten with junk.
  const damaged = makeTrack(legacy, "A/Album/05 Damaged.mp3", { base: "noise_320", tags: { title: "Damaged", artist: "A", album: "Album", trackNo: 5 } });
  const bytes = fs.readFileSync(damaged);
  for (let i = Math.floor(bytes.length * 0.4); i < Math.floor(bytes.length * 0.6); i += 1) bytes[i] = (i * 31) & 255;
  fs.writeFileSync(damaged, bytes);

  const sourceId = await addAndScan(lib.db, lib.scanner, legacy, { role: "legacy" });
  const id = (title) => lib.db.prepare("SELECT id FROM tracks WHERE title = ?").get(title).id;
  return { ...lib, root, legacy, sourceId, id, media: mediaForTests() };
}

test("quality checks flag low-bitrate, transcoded and damaged files without touching them", needsAudio, async (t) => {
  const lib = await qualityLibrary(t);
  const before = snapshotFolder(lib.legacy);
  quality.refreshQuality(lib.db);
  const status = (title) => lib.db.prepare("SELECT quality_status, quality_reasons FROM tracks WHERE title = ?").get(title);
  assert.equal(status("Low").quality_status, "review_suggested", "low bitrate is known before any check");
  assert.equal(status("Lossless").quality_status, "unknown");

  const report = await quality.checkJob(lib.db, lib.media, { logger: quietLogger });
  assert.equal(report.checked, 5);
  assert.deepEqual(snapshotFolder(lib.legacy), before, "checks only read");

  const codes = (title) => JSON.parse(status(title).quality_reasons).reasons.map((item) => item.code);
  assert.deepEqual(codes("Low"), ["low_bitrate", "cutoff"]);
  assert.equal(status("Lossless").quality_status, "acceptable");
  assert.deepEqual(codes("Transcoded"), ["hidden_cutoff"]);
  assert.equal(status("Transcoded").quality_status, "review_suggested");
  assert.equal(status("Good").quality_status, "acceptable");
  assert.ok(codes("Damaged").includes("decode_errors"));

  // Unchanged files aren't checked twice.
  assert.equal((await quality.checkJob(lib.db, lib.media, { logger: quietLogger })).total, 0);
  const summary = quality.qualitySummary(lib.db);
  assert.equal(summary.checked, 5);
  assert.equal(summary.counts.acceptable, 2);

  const queue = quality.listQueue(lib.db, { view: "attention", sort: "bitrate" });
  assert.deepEqual(queue.rows.map((row) => row.title), ["Low", "Transcoded", "Damaged"]);
  assert.equal(quality.listQueue(lib.db, { view: "all", maxBitrate: 128 }).total, 1);
});

test("the user's quality decisions stick, and can be reset or undone", needsAudio, async (t) => {
  const lib = await qualityLibrary(t);
  quality.refreshQuality(lib.db);
  const low = lib.id("Low");
  const good = lib.id("Good");

  const keep = quality.setQualityStatus(lib.db, { trackIds: [low], status: "keep_original" });
  quality.setQualityStatus(lib.db, { trackIds: [good], status: "user_marked_poor" });
  quality.refreshQuality(lib.db);
  const read = (id) => lib.db.prepare("SELECT quality_status, quality_set_by FROM tracks WHERE id = ?").get(id);
  assert.deepEqual({ ...read(low) }, { quality_status: "keep_original", quality_set_by: "user" });
  assert.equal(read(good).quality_status, "user_marked_poor");
  assert.equal(quality.listQueue(lib.db, { view: "keep_original" }).total, 1);

  edits.undoMetadataOperation(lib.db, keep.operationId);
  quality.refreshQuality(lib.db);
  assert.deepEqual({ ...read(low) }, { quality_status: "review_suggested", quality_set_by: "auto" });

  quality.setQualityStatus(lib.db, { trackIds: [good], status: "auto" });
  assert.equal(read(good).quality_set_by, "auto");
  assert.equal(read(good).quality_status, "unknown");
});

test("a lossless version elsewhere in the library is offered as an upgrade candidate", needsAudio, async (t) => {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  makeTrack(path.join(root, "Curated"), "B/Song.mp3", { base: "noise_128", tags: { title: "Song", artist: "B", album: "X" } });
  makeTrack(path.join(root, "Legacy"), "B/Song.flac", { base: "noise_flac", tags: { title: "Song", artist: "B", album: "X" } });
  await addAndScan(lib.db, lib.scanner, path.join(root, "Curated"), { role: "curated" });
  await addAndScan(lib.db, lib.scanner, path.join(root, "Legacy"), { role: "legacy" });

  const merge = createMerge({ db: lib.db, contentHash, logger: quietLogger });
  const { sessionId } = await merge.analyze();
  merge.acceptSuggestions({ sessionId, categories: ["already_curated"] });
  merge.apply({ sessionId });
  quality.refreshQuality(lib.db);

  const track = lib.db.prepare("SELECT * FROM tracks WHERE state = 'active'").get();
  assert.equal(track.quality_status, "upgrade_available");
  const reasons = JSON.parse(track.quality_reasons).reasons;
  assert.match(reasons.find((item) => item.code === "better_version").text, /FLAC/);
});

// --- Upgrade Track ------------------------------------------------------------------

async function upgradeLibrary(t, { managed = true } = {}) {
  const lib = await qualityLibrary(t);
  const downloads = path.join(lib.root, "Downloads");
  const replacement = makeTrack(downloads, "Low (Remastered Source).flac", {
    base: "noise_flac",
    tags: { title: "Low", artist: "A", album: "Album (Deluxe)", year: 2020, genre: "Electronic" },
    cover: "teal",
  });
  const artStore = createArtStore(makeTempDir(t, "wavemint-art-"));
  const consolidator = createConsolidator({ db: lib.db, media: lib.media, artStore, logger: quietLogger });
  const managedRoot = path.join(lib.root, "WaveMint Library");
  if (managed) {
    fs.mkdirSync(managedRoot);
    consolidator.ensureManagedSource(managedRoot);
  }
  const settings = { namingPattern: "{albumArtist}/{album}/{disc-}{track} {title}", lowBitrateKbps: 160 };
  const upgrader = createUpgrader({
    db: lib.db,
    media: lib.media,
    artStore,
    managedSource: consolidator.managedSource,
    getSettings: () => settings,
    logger: quietLogger,
  });
  return { ...lib, downloads, replacement, managedRoot, consolidator, upgrader, artStore };
}

test("Upgrade Track compares, copies into the library, keeps curated metadata, and undoes", needsAudio, async (t) => {
  const lib = await upgradeLibrary(t);
  const low = lib.id("Low");
  edits.applyEdits(lib.db, [{ trackId: low, fields: { genre: "House", albumArtist: "A" } }]);
  const before = { legacy: snapshotFolder(lib.legacy), downloads: snapshotFolder(lib.downloads) };

  const comparison = await lib.upgrader.prepare({ trackId: low, filePath: lib.replacement });
  assert.equal(comparison.match.verdict, "same");
  assert.equal(comparison.current.description, "MP3 128 kbps");
  assert.equal(comparison.candidate.description, "FLAC 16-bit/44.1 kHz");
  assert.ok(comparison.candidate.checked);
  const field = (name) => comparison.fields.find((item) => item.field === name);
  assert.equal(field("genre").choice, "current", "curated values are kept by default");
  assert.equal(field("year").choice, "candidate", "gaps are filled from the replacement");
  assert.equal(comparison.plan.mode, "copy");
  assert.equal(comparison.plan.relPath, path.join("A", "Album", "01 Low.flac"));
  assert.equal(comparison.plan.currentManaged, false);

  const result = await lib.upgrader.applyJob({ candidateId: comparison.candidateId, choices: { year: "candidate" }, artwork: "candidate" });
  assert.deepEqual(snapshotFolder(lib.legacy), before.legacy, "the legacy file is never touched");
  assert.deepEqual(snapshotFolder(lib.downloads), before.downloads, "the chosen file is never touched");

  const track = queries.getTrack(lib.db, low);
  const active = track.files.find((file) => file.id === track.active_file_id);
  assert.equal(active.path, path.join(lib.managedRoot, "A", "Album", "01 Low.flac"));
  assert.equal(track.files.find((file) => file.source_role === "legacy").role, "archived");
  assert.equal(track.genre, "House");
  assert.equal(track.year, 2020);
  assert.equal(track.quality_status, "upgraded");
  assert.equal(track.tags_dirty, 0);
  const written = readTags(active.path);
  assert.equal(written.genre, "House");
  assert.equal(written.album, "Album", "the album association is kept");
  assert.equal(written.year, 2020);

  lib.upgrader.undoUpgrade(result.operationId);
  const restored = queries.getTrack(lib.db, low);
  assert.equal(restored.files.find((file) => file.id === restored.active_file_id).source_role, "legacy");
  assert.equal(restored.year, null);
  assert.equal(restored.quality_status, "review_suggested");
  assert.equal(fs.existsSync(path.join(lib.managedRoot, "A", "Album", "01 Low.flac")), false, "the copy left the library's folders");
  const parked = Object.keys(snapshotFolder(lib.managedRoot));
  assert.equal(parked.length, 1);
  assert.ok(parked[0].startsWith(ARCHIVE_DIR), "…but was kept in the archive");
  assert.equal(lib.upgrader.listCandidates({ trackId: low }).length, 1, "the replacement can be used again");
});

test("upgrading a managed song archives the previous file and survives a rescan", needsAudio, async (t) => {
  const lib = await upgradeLibrary(t);
  const low = lib.id("Low");
  await lib.consolidator.consolidateJob({ root: lib.managedRoot, trackIds: [low] });
  const managedPath = path.join(lib.managedRoot, "A", "Album", "01 Low.mp3");
  const oldBytes = fs.readFileSync(managedPath);

  const replacement = makeTrack(lib.downloads, "low-320.mp3", { base: "noise_320", tags: { title: "Low", artist: "A" } });
  const comparison = await lib.upgrader.prepare({ trackId: low, filePath: replacement });
  assert.equal(comparison.plan.currentManaged, true);
  assert.equal(comparison.plan.relPath, path.join("A", "Album", "01 Low.mp3"), "same name: the old file moves out first");
  const result = await lib.upgrader.applyJob({ candidateId: comparison.candidateId });

  const files = Object.keys(snapshotFolder(lib.managedRoot));
  assert.equal(files.filter((name) => !name.startsWith(ARCHIVE_DIR)).length, 1);
  const archived = files.find((name) => name.startsWith(ARCHIVE_DIR));
  assert.deepEqual(fs.readFileSync(path.join(lib.managedRoot, archived)), oldBytes, "the previous file is archived unchanged");
  assert.equal(readTags(managedPath).bitrate, 320);

  // A rescan of the managed folder doesn't lose or duplicate anything.
  const managedId = lib.consolidator.managedSource().id;
  const total = queries.listTracks(lib.db, {}).total;
  await lib.scanner.scanSource(managedId);
  assert.equal(queries.listTracks(lib.db, {}).total, total);
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM files WHERE status = 'missing'").get().n, 0);

  lib.upgrader.undoUpgrade(result.operationId);
  assert.deepEqual(fs.readFileSync(managedPath), oldBytes, "the previous file is back in place");
  const track = queries.getTrack(lib.db, low);
  assert.equal(track.files.find((file) => file.id === track.active_file_id).path, managedPath);
});

test("a failed upgrade leaves the current version untouched", needsAudio, async (t) => {
  const lib = await upgradeLibrary(t);
  const low = lib.id("Low");
  await lib.consolidator.consolidateJob({ root: lib.managedRoot, trackIds: [low] });
  const managedPath = path.join(lib.managedRoot, "A", "Album", "01 Low.mp3");
  const before = snapshotFolder(lib.managedRoot);

  const replacement = makeTrack(lib.downloads, "low-320.mp3", { base: "noise_320", tags: { title: "Low", artist: "A" } });
  const comparison = await lib.upgrader.prepare({ trackId: low, filePath: replacement });
  lib.media.audioStreamHash = async () => {
    throw new Error("simulated failure");
  };
  await assert.rejects(lib.upgrader.applyJob({ candidateId: comparison.candidateId, choices: { album: "candidate" } }), /current version is unchanged/);
  assert.deepEqual(snapshotFolder(lib.managedRoot), before);
  const track = queries.getTrack(lib.db, low);
  assert.equal(track.files.find((file) => file.id === track.active_file_id).path, managedPath);
  assert.notEqual(track.quality_status, "upgraded");
});

test("an interrupted upgrade is rolled back at the next start", needsAudio, async (t) => {
  const lib = await upgradeLibrary(t);
  const low = lib.id("Low");
  await lib.consolidator.consolidateJob({ root: lib.managedRoot, trackIds: [low] });
  const managedPath = path.join(lib.managedRoot, "A", "Album", "01 Low.mp3");
  const archivePath = path.join(lib.managedRoot, ARCHIVE_DIR, "upgrades", "x", "01 Low.mp3");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.renameSync(managedPath, archivePath);
  fs.writeFileSync(path.join(lib.managedRoot, "A", "Album", "01 Low.wmtmp.flac"), "partial");

  const operationId = startOperation(lib.db, { kind: "upgrade", label: "Upgrade" });
  const step = addStep(lib.db, operationId, {
    action: "upgrade",
    trackId: low,
    targetPath: path.join(lib.managedRoot, "A", "Album", "01 Low.flac"),
    stagedPath: path.join(lib.managedRoot, "A", "Album", "01 Low.wmtmp.flac"),
  });
  updateStep(lib.db, step, { state: "archived", details: { archivedFrom: managedPath, archivedTo: archivePath } });

  const report = lib.upgrader.recover();
  assert.equal(report[0].outcome, "rolled_back");
  assert.ok(fs.existsSync(managedPath), "the previous file is back");
  assert.deepEqual(Object.keys(snapshotFolder(lib.managedRoot)).filter((name) => !name.startsWith(ARCHIVE_DIR)), [path.join("A", "Album", "01 Low.mp3")]);
});

test("upgrades warn about different versions and refuse files of other songs", needsAudio, async (t) => {
  const lib = await upgradeLibrary(t, { managed: false });
  const low = lib.id("Low");

  const live = makeTrack(lib.downloads, "Low (Live).mp3", { base: "noise_320", tags: { title: "Low (Live)", artist: "A" } });
  const comparison = await lib.upgrader.prepare({ trackId: low, filePath: live });
  assert.equal(comparison.match.verdict, "different");
  assert.ok(comparison.warnings.some((item) => item.level === "strong"));
  assert.equal(comparison.plan.mode, "needs_library");
  await assert.rejects(lib.upgrader.applyJob({ candidateId: comparison.candidateId }), /WaveMint Library/);

  await assert.rejects(lib.upgrader.prepare({ trackId: low, filePath: path.join(lib.legacy, "A/Album/04 Good.mp3") }), /already in your library as "Good"/);
});

test("switching to another version without a managed library only changes the database", needsAudio, async (t) => {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  makeTrack(path.join(root, "Curated"), "B/Song.mp3", { base: "noise_128", tags: { title: "Song", artist: "B", album: "X" } });
  makeTrack(path.join(root, "Legacy"), "B/Song.flac", { base: "noise_flac", tags: { title: "Song", artist: "B", album: "X" } });
  await addAndScan(lib.db, lib.scanner, path.join(root, "Curated"), { role: "curated" });
  await addAndScan(lib.db, lib.scanner, path.join(root, "Legacy"), { role: "legacy" });
  const merge = createMerge({ db: lib.db, contentHash, logger: quietLogger });
  const { sessionId } = await merge.analyze();
  merge.acceptSuggestions({ sessionId, categories: ["already_curated"] });
  merge.apply({ sessionId });
  const before = snapshotFolder(root);

  const artStore = createArtStore(makeTempDir(t, "wavemint-art-"));
  const upgrader = createUpgrader({
    db: lib.db,
    media: mediaForTests(),
    artStore,
    managedSource: () => null,
    getSettings: () => ({ lowBitrateKbps: 160 }),
    logger: quietLogger,
  });
  const track = lib.db.prepare("SELECT * FROM tracks WHERE state = 'active'").get();
  const flac = lib.db.prepare("SELECT id FROM files WHERE ext = '.flac'").get().id;
  const comparison = await upgrader.prepare({ trackId: track.id, fileId: flac });
  assert.equal(comparison.kind, "version");
  assert.equal(comparison.plan.mode, "switch");
  const result = await upgrader.applyJob({ candidateId: comparison.candidateId });
  assert.equal(lib.db.prepare("SELECT active_file_id FROM tracks WHERE id = ?").get(track.id).active_file_id, flac);
  assert.deepEqual(snapshotFolder(root), before);
  upgrader.undoUpgrade(result.operationId);
  assert.equal(lib.db.prepare("SELECT active_file_id FROM tracks WHERE id = ?").get(track.id).active_file_id, track.active_file_id);
});
