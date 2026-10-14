const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const { createAudioEditor, encodingFor, mp3Bitrate, normalizeEdits } = require("../electron/library/audioedit.cjs");
const { ARCHIVE_DIR, createConsolidator } = require("../electron/library/consolidate.cjs");
const { createImporter } = require("../electron/library/importer.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { createUpgrader } = require("../electron/library/upgrade.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, makeTempDir, makeTrack, mediaForTests, quietLogger, snapshotFolder } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

test("edits are validated against the song's length", () => {
  assert.deepEqual(normalizeEdits({}, 180000), { startMs: 0, endMs: 180000, fadeInMs: 0, fadeOutMs: 0, changed: false });
  // 15 s off the start, 20 s off the end, 2 s fade in, 4 s fade out.
  assert.deepEqual(normalizeEdits({ startMs: 15000, endMs: 160000, fadeInMs: 2000, fadeOutMs: 4000 }, 180000), {
    startMs: 15000,
    endMs: 160000,
    fadeInMs: 2000,
    fadeOutMs: 4000,
    changed: true,
  });
  // Out-of-range values are clamped; handles a hair from the edge count as untouched.
  assert.deepEqual(normalizeEdits({ startMs: -5, endMs: 999999 }, 180000).changed, false);
  assert.equal(normalizeEdits({ startMs: 30, endMs: 179970 }, 180000).changed, false);
  assert.equal(normalizeEdits({ fadeOutMs: 1 }, 180000).changed, true);
  assert.throws(() => normalizeEdits({ startMs: 5000, endMs: 5500 }, 180000), /at least one second/);
  assert.throws(() => normalizeEdits({ startMs: 0, endMs: 10000, fadeInMs: 6000, fadeOutMs: 5000 }, 180000), /fades are longer/);
  assert.throws(() => normalizeEdits({}, 0), /length is unknown/);
});

test("re-encoding keeps the original's quality class", () => {
  assert.equal(mp3Bitrate(320), 320);
  assert.equal(mp3Bitrate(245), 256); // a V0 extraction
  assert.equal(mp3Bitrate(128), 128);
  assert.equal(mp3Bitrate(96), 128);
  assert.equal(mp3Bitrate(0), 256);
  assert.deepEqual(encodingFor("a.mp3", { bitrate: 192 }), { lossless: false, codecArgs: ["-c:a", "libmp3lame", "-b:a", "192k"] });
  assert.equal(encodingFor("a.m4a", { codec: "alac" }).lossless, true);
  assert.deepEqual(encodingFor("a.m4a", { codec: "aac", bitrate: 128 }).codecArgs, ["-c:a", "aac", "-b:a", "192k"]);
  assert.deepEqual(encodingFor("a.flac", { bitDepth: 24 }).codecArgs, ["-c:a", "flac", "-sample_fmt", "s32"]);
  assert.deepEqual(encodingFor("a.wav", { bitDepth: 16 }).codecArgs, ["-c:a", "pcm_s16le"]);
  assert.throws(() => encodingFor("a.ogg", {}), /can't edit OGG/);
});

async function editorLibrary(t) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const managedRoot = path.join(root, "WaveMint Library");
  fs.mkdirSync(managedRoot);
  const media = mediaForTests();
  const artStore = createArtStore(makeTempDir(t, "wavemint-art-"));
  const consolidator = createConsolidator({ db: lib.db, media, artStore, logger: quietLogger });
  const settings = { namingPattern: "{albumArtist}/{album}/{disc-}{track} {title}", lowBitrateKbps: 160 };
  const getSettings = () => settings;
  const upgrader = createUpgrader({ db: lib.db, media, artStore, managedSource: consolidator.managedSource, getSettings, logger: quietLogger });
  const paths = { stagingDir: path.join(makeTempDir(t, "wavemint-data-"), "staging") };
  const importer = createImporter({ db: lib.db, media, artStore, upgrader, managedSource: consolidator.managedSource, getSettings, paths, logger: quietLogger });
  const editor = createAudioEditor({ db: lib.db, media, artStore, upgrader, importer, managedSource: consolidator.managedSource, getSettings, paths, logger: quietLogger });
  const useLibraryFolder = () => consolidator.ensureManagedSource(managedRoot);

  // What the main process does for an extraction: save the finished MP3 in
  // the token's staging folder.
  function stageExtraction(tags = {}) {
    const { token, folder } = editor.prepareExtraction();
    makeTrack(folder, "Artist - Song.mp3", { base: "noise_320", tags: { title: "Fresh Song", artist: "New Artist", album: "Singles", genre: "Pop", ...tags }, cover: "teal" });
    return token;
  }

  const track = (id) => lib.db.prepare("SELECT t.*, f.path, f.rel_path, f.source_id, f.duration_ms AS file_duration FROM tracks t JOIN files f ON f.id = t.active_file_id WHERE t.id = ?").get(id);
  return { ...lib, root, managedRoot, media, artStore, consolidator, upgrader, importer, editor, paths, useLibraryFolder, stageExtraction, track };
}

test("a fresh extraction is added to the library only when committed", needsAudio, async (t) => {
  const lib = await editorLibrary(t);
  assert.throws(() => lib.editor.prepareExtraction(), (error) => error.code === "no-library");
  lib.useLibraryFolder();

  const token = lib.stageExtraction();
  const info = lib.editor.extractionInfo({ token });
  assert.equal(info.title, "Fresh Song");
  assert.ok(info.artworkHash, "the staged artwork is available for the editor");
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 0, "nothing is in the library before commit");
  const wave = await lib.editor.waveform({ token });
  assert.ok(wave.peaks.length > 100 && wave.peaks.every((peak) => peak >= 0 && peak <= 1));
  assert.ok(Math.abs(wave.durationMs - 6000) < 200);

  const added = await lib.editor.commitExtraction({ token });
  assert.equal(added.edited, false);
  const row = lib.track(added.trackId);
  assert.equal(row.title, "Fresh Song");
  assert.equal(row.artist, "New Artist");
  assert.equal(row.album, "Singles");
  assert.equal(row.genre, "Pop");
  assert.ok(row.path.startsWith(lib.managedRoot), "the song is in the WaveMint Library folder");
  assert.ok(readTags(row.path).artworkHash, "artwork kept");
  const operation = lib.db.prepare("SELECT kind, status, label FROM operations ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...operation }, { kind: "import", status: "completed", label: 'Add "Fresh Song"' });

  // The staging folder is gone: the token can't add the song a second time.
  await assert.rejects(lib.editor.commitExtraction({ token }), /no longer available/);
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 1);

  // Like any import, it can be undone from History.
  lib.importer.undoImport(lib.db.prepare("SELECT id FROM operations WHERE kind = 'import' ORDER BY id LIMIT 1").get().id);
  assert.equal(lib.db.prepare("SELECT state FROM tracks WHERE id = ?").get(added.trackId).state, "removed");
});

test("an extraction can replace a library song (Upgrade Track from a URL)", needsAudio, async (t) => {
  const playlists = require("../electron/library/playlists.cjs");
  const lib = await editorLibrary(t);
  lib.useLibraryFolder();
  const { trackId } = await lib.editor.commitExtraction({ token: lib.stageExtraction() });
  const before = lib.track(trackId);
  const playlist = playlists.createPlaylist(lib.db, { name: "Mix", trackIds: [trackId] });

  // What download-mp3 does with upgradeTrackId: extract into staging, then
  // hand the file to the upgrader as an "extraction" replacement.
  const token = lib.stageExtraction({ title: "New Artist - Fresh Song (Official Video)", artist: "New Artist VEVO", album: "", genre: "" });
  const staged = lib.editor.resolveExtraction({ token });
  const comparison = await lib.upgrader.prepare({ trackId, filePath: staged.path, kind: "extraction", source: { title: "Fresh Song (Official Video)", url: "https://example.com/v" } });
  assert.equal(comparison.current.fileId, before.active_file_id);

  const metadata = { title: before.title, artist: before.artist, album: "Singles (2024)", genre: before.genre, albumArtist: "", composer: "", comment: "" };
  await lib.upgrader.applyJob({ candidateId: comparison.candidateId, metadata, artwork: "current" });
  assert.equal(lib.editor.releaseStagedPath(staged.path), true, "the staged extraction is removed once used");
  assert.equal(fs.existsSync(path.dirname(staged.path)), false);
  // Paths outside WaveMint's staging are never removed.
  assert.equal(lib.editor.releaseStagedPath(path.join(lib.root, "elsewhere", "x.mp3")), false);
  assert.equal(lib.editor.releaseStagedPath(before.path), false);

  const after = lib.track(trackId);
  assert.notEqual(after.active_file_id, before.active_file_id);
  assert.equal(after.title, "Fresh Song", "the curated title wasn't replaced by the video title");
  assert.equal(after.artist, "New Artist");
  assert.equal(after.album, "Singles (2024)");
  const written = readTags(after.path);
  assert.equal(written.title, "Fresh Song");
  assert.equal(written.album, "Singles (2024)");
  assert.ok(written.artworkHash, "the song's artwork was written into the new file");
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE state = 'active'").get().n, 1, "no duplicate song");
  assert.deepEqual(
    playlists.getPlaylist(lib.db, { id: playlist.id }).tracks.map((row) => row.id),
    [trackId],
    "playlist membership is kept",
  );
  // The previous file is archived inside the library, not deleted.
  assert.ok(fs.existsSync(lib.db.prepare("SELECT path FROM files WHERE id = ?").get(before.active_file_id).path));
});

test("removing a used extraction never fails while its file is still open (Windows)", needsAudio, async (t) => {
  const lib = await editorLibrary(t);
  lib.useLibraryFolder();
  const token = lib.stageExtraction();
  const staged = lib.editor.resolveExtraction({ token });
  // A preview still streaming the file keeps a handle open; on Windows the
  // file is then "delete pending" and its folder can't be removed yet.
  const handle = fs.openSync(staged.path, "r");
  let released;
  try {
    assert.doesNotThrow(() => {
      released = lib.editor.releaseStagedPath(staged.path, { retryDelaysMs: [100, 300] });
    });
  } finally {
    fs.closeSync(handle);
  }
  assert.equal(released, true);
  // Once the handle is closed, a retry removes the folder.
  const folder = path.dirname(staged.path);
  for (let i = 0; i < 20 && fs.existsSync(folder); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(folder), false);
});

test("an extraction can be trimmed and faded before it is added", needsAudio, async (t) => {
  const lib = await editorLibrary(t);
  lib.useLibraryFolder();
  const token = lib.stageExtraction({ title: "Edited Before Adding" });

  await assert.rejects(lib.editor.commitExtraction({ token, edits: { startMs: 0, endMs: 6000, fadeInMs: 4000, fadeOutMs: 4000 } }), /fades are longer/);
  const added = await lib.editor.commitExtraction({ token, edits: { startMs: 1000, endMs: 5000, fadeInMs: 500, fadeOutMs: 1000 } });
  assert.equal(added.edited, true);
  assert.equal(added.reencoded, true);
  const row = lib.track(added.trackId);
  assert.ok(Math.abs(row.duration_ms - 4000) < 150, `duration ${row.duration_ms}`);
  const tags = readTags(row.path);
  assert.equal(tags.title, "Edited Before Adding");
  assert.equal(tags.genre, "Pop");
  assert.ok(tags.artworkHash, "artwork carried over");
  assert.ok(tags.bitrate >= 300, `re-encoded at the original's bitrate (${tags.bitrate})`);

  // Discarding a held extraction removes it.
  const other = lib.stageExtraction();
  assert.deepEqual(lib.editor.discardExtraction({ token: other }), { discarded: true });
  assert.throws(() => lib.editor.extractionInfo({ token: other }), /no longer available/);
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 1);
});

test("editing a library song replaces its audio in place and can be undone", needsAudio, async (t) => {
  const lib = await editorLibrary(t);
  lib.useLibraryFolder();
  const token = lib.stageExtraction({ title: "Keeper" });
  const { trackId } = await lib.editor.commitExtraction({ token });
  lib.db.prepare("INSERT INTO playlists (name, kind, created_at, updated_at) VALUES ('Mix', 'manual', '', '')").run();
  lib.db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (1, ?, 1, '')").run(trackId);
  lib.db.prepare("UPDATE tracks SET rating = 4 WHERE id = ?").run(trackId);
  const before = lib.track(trackId);

  // Trim only: a stream copy, no re-encoding.
  const first = await lib.editor.editTrackJob({ trackId, edits: { startMs: 1000, endMs: 6000 } });
  assert.equal(first.reencoded, false);
  let row = lib.track(trackId);
  assert.notEqual(row.active_file_id, before.active_file_id);
  assert.equal(row.rel_path, before.rel_path, "same place in the library");
  assert.ok(Math.abs(row.duration_ms - 5000) < 150, `duration ${row.duration_ms}`);
  assert.equal(row.rating, 4);
  assert.equal(row.quality_status, before.quality_status);
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 1, "no duplicate song");
  assert.equal(lib.db.prepare("SELECT track_id FROM playlist_tracks").get().track_id, trackId);
  const archived = lib.db.prepare("SELECT path, role FROM files WHERE id = ?").get(before.active_file_id);
  assert.equal(archived.role, "archived");
  assert.ok(archived.path.includes(ARCHIVE_DIR) && fs.existsSync(archived.path), "the original is kept in the archive");
  const tags = readTags(row.path);
  assert.equal(tags.title, "Keeper");
  assert.ok(tags.artworkHash);

  // A second edit of the same song (fades, so re-encoded) keeps both earlier versions.
  const second = await lib.editor.editTrackJob({ trackId, edits: { startMs: 0, endMs: 5000, fadeInMs: 1000, fadeOutMs: 2000 } });
  assert.equal(second.reencoded, true);
  row = lib.track(trackId);
  assert.ok(Math.abs(row.duration_ms - 5000) < 150);
  const archive = lib.db.prepare("SELECT COUNT(*) AS n FROM files WHERE track_id = ? AND role = 'archived'").get(trackId).n;
  assert.equal(archive, 2);

  const operation = lib.db.prepare("SELECT id, label FROM operations WHERE kind = 'upgrade' ORDER BY id DESC LIMIT 1").get();
  assert.equal(operation.label, 'Edit audio of "Keeper"');
  lib.upgrader.undoUpgrade(operation.id);
  row = lib.track(trackId);
  assert.ok(Math.abs(row.duration_ms - 5000) < 150, "undo restores the previous version");
  assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 1);

  await assert.rejects(lib.editor.editTrackJob({ trackId, edits: {} }), /no changes/);
});

test("editing a song from a read-only folder never touches the original", needsAudio, async (t) => {
  const lib = await editorLibrary(t);
  const legacy = path.join(lib.root, "Legacy");
  makeTrack(legacy, "Band/Record/01 Old Song.mp3", { base: "noise_128", tags: { title: "Old Song", artist: "Band", album: "Record", trackNo: 1 }, cover: "navy" });
  await addAndScan(lib.db, lib.scanner, legacy, { role: "legacy" });
  const trackId = lib.db.prepare("SELECT id FROM tracks").get().id;
  const legacyBefore = snapshotFolder(legacy);

  assert.equal(lib.editor.editSource({ trackId }).hasLibraryFolder, false);
  await assert.rejects(lib.editor.editTrackJob({ trackId, edits: { startMs: 1000 } }), /Choose a folder for your WaveMint Library/);

  lib.useLibraryFolder();
  const source = lib.editor.editSource({ trackId });
  assert.equal(source.inLibraryFolder, false);
  assert.equal(source.editable, true);
  await lib.editor.editTrackJob({ trackId, edits: { startMs: 500, endMs: 6000, fadeOutMs: 1000 } });

  assert.deepEqual(snapshotFolder(legacy), legacyBefore, "the read-only folder is unchanged");
  const row = lib.track(trackId);
  assert.ok(row.path.startsWith(lib.managedRoot));
  assert.ok(Math.abs(row.duration_ms - 5500) < 150);
  const tags = readTags(row.path);
  assert.equal(tags.trackNo, 1);
  assert.equal(tags.album, "Record");
  assert.ok(tags.artworkHash);
  assert.ok(tags.bitrate <= 160, `a 128 kbps original isn't inflated (${tags.bitrate})`);
  assert.equal(fs.readdirSync(lib.paths.stagingDir).flatMap((dir) => fs.readdirSync(path.join(lib.paths.stagingDir, dir))).length, 0, "no temporary files left");
});

test("genres with slashes and other punctuation survive edits (ID3v2.3 read-back)", needsAudio, async (t) => {
  const { writeTags } = require("../electron/library/tags.cjs");
  const lib = await editorLibrary(t);
  lib.useLibraryFolder();
  for (const genre of ["Hip Hop/R&B", "AC/DC Covers", "Drum & Bass", "(Indie)", "Rock"]) {
    // As it comes back from a file WaveMint wrote (ID3v2.3).
    const probe = makeTrack(lib.root, `probe/${Math.random()}.mp3`, { tags: { title: "x" } });
    writeTags(probe, { genre });
    assert.equal(readTags(probe).genre, genre);

    const token = lib.stageExtraction({ title: `Song ${genre}`, genre });
    const { trackId } = await lib.editor.commitExtraction({ token });
    assert.equal(lib.track(trackId).genre, genre);
    // An edit re-verifies the tags it wrote; a split genre used to fail here.
    await lib.editor.editTrackJob({ trackId, edits: { startMs: 500, fadeOutMs: 500 } });
    const row = lib.track(trackId);
    assert.equal(row.genre, genre);
    assert.equal(readTags(row.path).genre, genre);
  }
});
