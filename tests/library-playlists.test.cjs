const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createArtStore } = require("../electron/library/artstore.cjs");
const edits = require("../electron/library/edits.cjs");
const { createExporter } = require("../electron/library/exporter.cjs");
const playlists = require("../electron/library/playlists.cjs");
const { readTags } = require("../electron/library/tags.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, makeTempDir, makeTrack, mediaForTests, quietLogger, snapshotFolder } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

async function playlistLibrary(t) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  const music = path.join(root, "Music");
  makeTrack(music, "A/One/01 Alpha.mp3", { tags: { title: "Alpha", artist: "A", album: "One", genre: "Rock", year: 1999, trackNo: 1 }, cover: "navy" });
  makeTrack(music, "A/One/02 Beta.m4a", { base: "m4a", tags: { title: "Beta", artist: "A", album: "One", genre: "Rock", year: 1999, trackNo: 2 } });
  makeTrack(music, "B/Two/01 Gamma.flac", { base: "flac", tags: { title: "Gamma", artist: "B", album: "Two", genre: "Jazz", year: 2015, trackNo: 1 }, cover: "teal" });
  makeTrack(music, "B/Two/02 Café Δ.mp3", { tags: { title: "Café Δ", artist: "B", album: "Two", genre: "Jazz", year: 2015, trackNo: 2 } });
  await addAndScan(lib.db, lib.scanner, music, { role: "curated" });
  const id = (title) => lib.db.prepare("SELECT id FROM tracks WHERE title = ?").get(title).id;
  return { ...lib, root, music, id };
}

test("manual playlists keep their order and follow songs through merges", needsAudio, async (t) => {
  const lib = await playlistLibrary(t);
  const list = playlists.createPlaylist(lib.db, { name: "  Road Trip ", trackIds: [lib.id("Gamma"), lib.id("Alpha"), lib.id("Beta")] });
  assert.equal(list.name, "Road Trip");
  assert.deepEqual(list.tracks.map((row) => row.title), ["Gamma", "Alpha", "Beta"]);

  playlists.addTracks(lib.db, { id: list.id, trackIds: [lib.id("Alpha"), lib.id("Café Δ")] });
  assert.deepEqual(playlists.getPlaylist(lib.db, { id: list.id }).tracks.map((row) => row.title), ["Gamma", "Alpha", "Beta", "Café Δ"], "no duplicates");
  const moved = playlists.moveTrack(lib.db, { id: list.id, trackId: lib.id("Café Δ"), toPosition: 1 });
  assert.deepEqual(moved.tracks.map((row) => row.title), ["Café Δ", "Gamma", "Alpha", "Beta"]);
  playlists.removeTracks(lib.db, { id: list.id, trackIds: [lib.id("Gamma")] });

  // Beta is merged into Alpha: the playlist shows Alpha once.
  lib.db.prepare("UPDATE tracks SET state = 'merged', merged_into = ? WHERE id = ?").run(lib.id("Alpha"), lib.id("Beta"));
  assert.deepEqual(playlists.getPlaylist(lib.db, { id: list.id }).tracks.map((row) => row.title), ["Café Δ", "Alpha"]);
  // An upgrade only changes the active file: the song stays.
  const alpha = lib.id("Alpha");
  const otherFile = lib.db.prepare("SELECT id FROM files WHERE track_id = ?").get(lib.id("Café Δ")).id;
  lib.db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(otherFile, alpha);
  assert.ok(playlists.getPlaylist(lib.db, { id: list.id }).tracks.some((row) => row.id === alpha));

  assert.throws(() => playlists.createPlaylist(lib.db, { name: "   " }), /name/);
  const smart = playlists.createPlaylist(lib.db, { name: "Jazz", kind: "smart", rules: { conditions: [{ field: "genre", op: "is", value: "jazz" }] } });
  assert.throws(() => playlists.addTracks(lib.db, { id: smart.id, trackIds: [alpha] }), /rules/);
});

test("smart playlists follow their rules", needsAudio, async (t) => {
  const lib = await playlistLibrary(t);
  const titles = (rules) => playlists.createPlaylist(lib.db, { name: "x", kind: "smart", rules }).tracks.map((row) => row.title).sort();
  assert.deepEqual(titles({ conditions: [{ field: "genre", op: "is", value: "JAZZ" }] }), ["Café Δ", "Gamma"]);
  assert.deepEqual(titles({ conditions: [{ field: "year", op: "lte", value: 2000 }, { field: "format", op: "lossy" }] }), ["Alpha", "Beta"]);
  assert.deepEqual(titles({ match: "any", conditions: [{ field: "format", op: "lossless" }, { field: "artist", op: "contains", value: "a" }] }).length, 3);
  assert.deepEqual(titles({ conditions: [{ field: "added", op: "within_days", value: 7 }] }).length, 4);
  assert.deepEqual(titles({ conditions: [{ field: "genre", op: "is_not", value: "rock" }, { field: "source", op: "is", value: "curated" }] }), ["Café Δ", "Gamma"]);
  edits.applyEdits(lib.db, [{ trackId: lib.id("Alpha"), fields: { rating: 5 } }]);
  assert.deepEqual(titles({ conditions: [{ field: "rating", op: "gte", value: 4 }] }), ["Alpha"]);
  assert.deepEqual(playlists.createPlaylist(lib.db, { name: "y", kind: "smart", rules: { conditions: [{ field: "genre", op: "contains", value: "" }], limit: 2, sort: "title" } }).tracks.length, 2);
  assert.throws(() => playlists.validateRules({ conditions: [{ field: "path", op: "is", value: "x" }] }), /Unknown/);
  assert.throws(() => playlists.validateRules({ conditions: [{ field: "year", op: "gte", value: "soon" }] }), /number/);
  assert.throws(() => playlists.validateRules({ conditions: [] }), /at least one/);
});

test("M3U8 export and import round-trip, with paths and titles", needsAudio, async (t) => {
  const lib = await playlistLibrary(t);
  const list = playlists.createPlaylist(lib.db, { name: "Mix", trackIds: [lib.id("Café Δ"), lib.id("Alpha")] });
  const out = makeTempDir(t, "wavemint-m3u-");
  const absolute = path.join(out, "Mix.m3u8");
  assert.equal(playlists.exportM3U8(lib.db, { id: list.id, filePath: absolute }).written, 2);
  const text = fs.readFileSync(absolute, "utf8");
  assert.match(text, /^#EXTM3U\r\n#PLAYLIST:Mix\r\n#EXTINF:3,B - Café Δ\r\n/);
  assert.ok(text.includes(path.join(lib.music, "B", "Two", "02 Café Δ.mp3")));

  const relative = path.join(lib.root, "Mix (relative).m3u8");
  playlists.exportM3U8(lib.db, { id: list.id, filePath: relative, relative: true });
  assert.ok(fs.readFileSync(relative, "utf8").includes(path.join("Music", "A", "One", "01 Alpha.mp3")));

  const imported = playlists.importM3U(lib.db, { filePath: relative });
  assert.equal(imported.matched, 2);
  assert.deepEqual(playlists.getPlaylist(lib.db, { id: imported.playlist.id }).tracks.map((row) => row.title), ["Café Δ", "Alpha"]);

  // A playlist from elsewhere: matched by artist and title when paths differ.
  const foreign = path.join(out, "foreign.m3u");
  fs.writeFileSync(foreign, "#EXTM3U\n#EXTINF:3,A - Beta\nC:\\Elsewhere\\beta.mp3\n#EXTINF:3,Nobody - Unknown Song\nC:\\Elsewhere\\x.mp3\n");
  const second = playlists.importM3U(lib.db, { filePath: foreign, name: "Foreign" });
  assert.equal(second.matched, 1);
  assert.deepEqual(second.unmatched, ["Nobody - Unknown Song"]);
});

// --- Prepare for iPhone -----------------------------------------------------------------

function exporterFor(t, db) {
  return createExporter({ db, media: mediaForTests(), artStore: createArtStore(makeTempDir(t, "wavemint-art-")), getSettings: () => ({}), logger: quietLogger });
}

test("preparing for iPhone copies Apple formats, converts FLAC, and only redoes what changed", needsAudio, async (t) => {
  const lib = await playlistLibrary(t);
  const before = snapshotFolder(lib.music);
  const exporter = exporterFor(t, lib.db);
  const root = makeTempDir(t, "wavemint-export-");
  const list = playlists.createPlaylist(lib.db, { name: "Mix/Best", trackIds: [lib.id("Gamma"), lib.id("Alpha")] });
  assert.throws(() => exporter.plan({ root: lib.music, scope: { all: true } }), /can't overlap/);

  const preview = exporter.preview({ root, scope: { all: true } });
  assert.equal(preview.summary.new, 4);
  assert.equal(preview.summary.conversions, 1);
  assert.equal(preview.items.find((item) => item.title === "Gamma").format, "alac");
  assert.equal(preview.items.find((item) => item.title === "Beta").action, "copy", "AAC isn't converted");
  assert.ok(preview.items.find((item) => item.title === "Beta").warnings.includes("No artwork"));

  const first = await exporter.exportJob({ root, scope: { all: true, playlistIds: [list.id] } });
  assert.equal(first.new, 4);
  assert.deepEqual(snapshotFolder(lib.music), before, "the library's files are untouched");
  const gamma = path.join(root, "Music", "B", "Two", "01 Gamma.m4a");
  const tags = readTags(gamma);
  assert.equal(tags.codec, "alac");
  assert.equal(tags.title, "Gamma");
  assert.equal(tags.artworkCount, 1, "the cover travels with the converted file");
  assert.ok(fs.existsSync(path.join(root, "Music", "B", "Two", "02 Café Δ.mp3")));
  const m3u = fs.readFileSync(path.join(root, "Playlists", "Mix Best.m3u8"), "utf8");
  assert.ok(m3u.includes(gamma));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "wavemint-export.json"), "utf8"));
  assert.equal(manifest.tracks.length, 4);
  assert.match(fs.readFileSync(path.join(root, "WaveMint Export Report.txt"), "utf8"), /New \(4\)/);

  // Nothing changed: nothing is copied again.
  const snapshot = snapshotFolder(path.join(root, "Music"));
  const second = await exporter.exportJob({ root, scope: { all: true } });
  assert.equal(second.unchanged, 4);
  assert.equal(second.new + second.replace + second.refresh, 0);
  assert.deepEqual(snapshotFolder(path.join(root, "Music")), snapshot);

  // Edited details are refreshed in place; the path stays stable.
  edits.applyEdits(lib.db, [{ trackId: lib.id("Alpha"), fields: { album: "One (Remastered)", genre: "Classic Rock" } }]);
  const third = await exporter.exportJob({ root, scope: { all: true } });
  assert.equal(third.refresh, 1);
  const alphaPath = path.join(root, "Music", "A", "One", "01 Alpha.mp3");
  assert.equal(readTags(alphaPath).genre, "Classic Rock");
  assert.deepEqual(third.changedFiles, [path.join("Music", "A", "One", "01 Alpha.mp3")]);

  // An upgrade to another format gets a new file; the old one is set aside.
  const flacFile = lib.db.prepare("SELECT id FROM files WHERE ext = '.flac'").get().id;
  lib.db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(flacFile, lib.id("Alpha"));
  const fourth = await exporter.exportJob({ root, scope: { all: true } });
  assert.equal(fourth.replace, 1);
  assert.ok(fs.existsSync(path.join(root, "Music", "A", "One (Remastered)", "01 Alpha.m4a")), "a new file is named from the current details");
  assert.ok(fs.existsSync(path.join(root, ".replaced", "Music", "A", "One", "01 Alpha.mp3")));
  assert.equal(fs.existsSync(alphaPath), false);

  // Songs no longer selected are reported, not deleted.
  const fifth = exporter.preview({ root, scope: { genres: ["Jazz"] } });
  assert.equal(fifth.summary.removed, 2);
  assert.ok(fs.existsSync(path.join(root, "Music", "A", "One", "02 Beta.m4a")));
});

test("new and changed files can be handed to Apple's Automatically Add folder", needsAudio, async (t) => {
  const lib = await playlistLibrary(t);
  const exporter = exporterFor(t, lib.db);
  const root = makeTempDir(t, "wavemint-export-");
  const result = await exporter.exportJob({ root, scope: { releaseIds: [lib.db.prepare("SELECT release_id FROM tracks WHERE album = 'One'").get().release_id] } });
  assert.equal(result.new, 2);

  const itunes = makeTempDir(t, "wavemint-itunes-");
  assert.throws(() => exporter.handOff({ exportId: result.exportId, folder: itunes }), /Automatically Add/);
  const autoAdd = path.join(itunes, "Automatically Add to iTunes");
  fs.mkdirSync(autoAdd);
  const handed = exporter.handOff({ exportId: result.exportId, folder: autoAdd });
  assert.equal(handed.copied, 2);
  assert.deepEqual(fs.readdirSync(autoAdd).sort(), ["01 Alpha.mp3", "02 Beta.m4a"]);
  assert.ok(fs.existsSync(path.join(root, "Music", "A", "One", "01 Alpha.mp3")), "copied, not moved");
});
