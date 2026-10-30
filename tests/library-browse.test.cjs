// Browsing queries: artists grouped in one pass, an artist's details, the
// Songs filters (several artists, albums, genres, decades) and where file
// problems are counted.

const assert = require("node:assert/strict");
const fs = require("fs");
const test = require("node:test");

const queries = require("../electron/library/queries.cjs");
const review = require("../electron/library/review.cjs");
const { SKIP_REASON, addAndScan, createTestLibrary, makeTempDir, makeTrack } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

async function browseLibrary(t) {
  const lib = await createTestLibrary(t);
  const music = makeTempDir(t, "wavemint-music-");
  const T = (rel, tags, cover = "navy") => makeTrack(music, rel, { tags, cover });
  T("Coldplay/Parachutes/01.mp3", { title: "Don't Panic", artist: "Coldplay", album: "Parachutes", genre: "Rock", year: 2000 }, null);
  T("Coldplay/Parachutes/05.mp3", { title: "Yellow", artist: "Coldplay", album: "Parachutes", genre: "Rock", year: 2000 });
  T("Coldplay/Viva/01.mp3", { title: "Viva la Vida", artist: "COLDPLAY", album: "Viva la Vida", genre: "Pop", year: 2008 });
  T("Daft Punk/Discovery/01.mp3", { title: "One More Time", artist: "Daft Punk", album: "Discovery", genre: "Electronic", year: 2001 });
  T("A/Greatest Hits/01.mp3", { title: "One", artist: "Artist A", albumArtist: "Artist A", album: "Greatest Hits", genre: "Pop", year: 1995 });
  T("B/Greatest Hits/01.mp3", { title: "Two", artist: "Artist B", albumArtist: "Artist B", album: "Greatest Hits", genre: "Pop", year: 1998 });
  await addAndScan(lib.db, lib.scanner, music);
  return { ...lib, music };
}

test("artists are grouped with their most common spelling, counts and artwork", needsAudio, async (t) => {
  const { db } = await browseLibrary(t);
  const { total, rows } = queries.listArtists(db, { limit: 100 });
  assert.equal(total, 4);
  const coldplay = rows.find((row) => row.key === "coldplay");
  assert.deepEqual({ name: coldplay.name, songs: coldplay.track_count, albums: coldplay.album_count }, { name: "Coldplay", songs: 3, albums: 2 });
  assert.match(coldplay.artwork_hash, /^[a-f0-9]{40}$/, "artwork from a song that has some");
  assert.deepEqual(queries.listArtists(db, { genre: "Pop", limit: 100 }).rows.map((row) => row.name), ["Artist A", "Artist B", "Coldplay"]);
  assert.deepEqual(queries.getDashboard(db).topArtists[0].name, "Coldplay");

  const artist = queries.getArtist(db, "coldplay");
  assert.equal(artist.track_count, 3);
  assert.deepEqual(artist.genres.map((genre) => genre.name), ["Rock", "Pop"]);
  assert.equal(queries.getArtist(db, "nobody"), null);
});

test("same-named albums by different artists stay separate", needsAudio, async (t) => {
  const { db } = await browseLibrary(t);
  const albums = queries.listAlbums(db, { search: "Greatest Hits" }).rows;
  assert.deepEqual(albums.map((album) => album.album_artist).sort(), ["Artist A", "Artist B"]);
});

test("Songs filters combine artists, albums, genres and decades", needsAudio, async (t) => {
  const { db } = await browseLibrary(t);
  const titles = (filters) => queries.listTracks(db, { filters, sort: "title" }).rows.map((row) => row.title);
  assert.deepEqual(titles({ artists: ["coldplay", "daft punk"] }), ["Don't Panic", "One More Time", "Viva la Vida", "Yellow"]);
  assert.deepEqual(titles({ genres: ["pop", "electronic"], decades: [2000] }), ["One More Time", "Viva la Vida"]);
  const parachutes = queries.listAlbums(db, { search: "Parachutes" }).rows[0].id;
  assert.deepEqual(titles({ releaseIds: [parachutes], artists: ["coldplay"] }), ["Don't Panic", "Yellow"]);
  assert.deepEqual(titles({ decades: [1990] }), ["One", "Two"]);
  assert.deepEqual(
    queries.browseFacets(db).decades.map((row) => [row.decade, row.count]),
    [
      [2000, 4],
      [1990, 2],
    ],
  );
});

test("file problems are counted for File Health, not Review", needsAudio, async (t) => {
  const { db, music } = await browseLibrary(t);
  const file = db.prepare("SELECT f.path FROM files f JOIN tracks t ON t.active_file_id = f.id WHERE t.title = 'Yellow'").get().path;
  fs.rmSync(file);
  db.prepare("UPDATE files SET status = 'missing' WHERE path = ?").run(file);
  review.refreshReview(db);

  const status = queries.getStatus(db);
  assert.equal(status.fileProblems, 1);
  const summary = review.reviewSummary(db);
  assert.equal("file_problem" in summary.kinds, false);
  assert.equal(review.listReviewItems(db).rows.some((item) => item.kind === "file_problem"), false);
  assert.equal(review.listReviewItems(db, { kind: "file_problem" }).total, 1, "still detected (resolves and reopens as usual)");
  assert.equal(status.reviewOpen, summary.open);
  assert.equal(queries.listTracks(db, { filters: { missingFile: true } }).total, 1);
  assert.ok(music);
});

test("the Album picker's suggestions are the albums of the artist typed", needsAudio, async (t) => {
  const { db } = await browseLibrary(t);
  // The renderer finds the typed artist among listArtists' rows, then lists that key's albums.
  const keyOf = (name) => queries.listArtists(db, { limit: 5000 }).rows.find((row) => row.name.toLowerCase() === name.toLowerCase())?.key;
  const albumsOf = (name) => queries.listAlbums(db, { filters: { artist: keyOf(name) }, sort: "title", limit: 1000 }).rows.map((row) => row.title);
  assert.deepEqual(albumsOf("coldplay"), ["Parachutes", "Viva la Vida"], "both spellings of the artist, no other artist's albums");
  assert.deepEqual(albumsOf("Artist B"), ["Greatest Hits"]);
  assert.equal(queries.listAlbums(db, { filters: { artist: keyOf("Artist B") } }).rows[0].album_artist, "Artist B", "not Artist A's album of the same name");
  assert.equal(keyOf("Muse"), undefined, "an artist the library doesn't have suggests no albums");
});

test("a genre added from a picker is kept once, with its own spelling", needsAudio, async (t) => {
  const { db } = await browseLibrary(t);
  const genres = require("../electron/library/genres.cjs");
  assert.deepEqual(genres.adoptLabels(db, { labels: ["Dark Synthwave"] }), { added: 1 });
  assert.deepEqual(genres.adoptLabels(db, { labels: ["  dark synthwave "] }), { added: 0 });
  assert.deepEqual(genres.listTaxonomy(db).map((genre) => genre.name).filter((name) => /synthwave/i.test(name)), ["Dark Synthwave"]);
});
