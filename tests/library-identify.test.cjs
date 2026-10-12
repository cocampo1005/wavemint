const assert = require("node:assert/strict");
const path = require("path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { createArtStore } = require("../electron/library/artstore.cjs");
const edits = require("../electron/library/edits.cjs");
const genres = require("../electron/library/genres.cjs");
const { createIdentifier, groupReleases, kindOf, pickGroup, scoreMatch } = require("../electron/library/identify.cjs");
const { createMusicBrainz, phrase } = require("../electron/library/musicbrainz.cjs");
const queries = require("../electron/library/queries.cjs");
const { createWebClient } = require("../electron/library/webclient.cjs");
const { SKIP_REASON, addAndScan, coverBytes, createTestLibrary, makeTempDir, makeTrack, quietLogger } = require("./library-fixtures.cjs");

const needsAudio = { skip: SKIP_REASON };

// --- A fake MusicBrainz (shapes as returned by the real web service) ----------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COLDPLAY = [{ name: "Coldplay", joinphrase: "", artist: { id: ID(900), name: "Coldplay" } }];
const VARIOUS = [{ name: "Various Artists", joinphrase: "", artist: { id: ID(901), name: "Various Artists" } }];
const PARACHUTES_TITLES = ["Don't Panic", "Shiver", "Spies", "Sparks", "Yellow", "Trouble", "Parachutes", "High Speed", "We Never Change", "Everything's Not Lost"];

const releaseRef = ({ id, title, group, primary = "Album", secondary = [], date, country = "GB", status = "Official", number, count, credit }) => ({
  id,
  title,
  status,
  date,
  country,
  ...(credit ? { "artist-credit": credit } : {}),
  "release-group": { id: group, "primary-type": primary, ...(secondary.length ? { "secondary-types": secondary } : {}) },
  media: [{ position: 1, format: "CD", "track-count": count, track: [{ id: ID(7000 + number), number: String(number), title: "Yellow" }] }],
});

const YELLOW = {
  id: ID(1),
  score: 100,
  title: "Yellow",
  length: 269110,
  "first-release-date": "2000-06-26",
  "artist-credit": COLDPLAY,
  tags: [
    { name: "alternative rock", count: 5 },
    { name: "britpop", count: 2 },
  ],
  releases: [
    releaseRef({ id: ID(11), title: "Parachutes", group: ID(10), date: "2000-07-10", number: 5, count: 10 }),
    releaseRef({ id: ID(12), title: "Parachutes", group: ID(10), date: "2008-01-01", country: "US", number: 5, count: 10 }),
    releaseRef({ id: ID(21), title: "Yellow", group: ID(20), primary: "Single", date: "2000-06-26", number: 1, count: 3 }),
    releaseRef({ id: ID(31), title: "Now That's What I Call Music! 47", group: ID(30), secondary: ["Compilation"], date: "2000-11-01", number: 4, count: 20, credit: VARIOUS }),
    releaseRef({ id: ID(41), title: "Live Somewhere", group: ID(40), status: "Bootleg", date: "2003-01-01", number: 6, count: 12 }),
  ],
};

const YELLOW_LIVE = {
  id: ID(2),
  score: 100,
  title: "Yellow",
  length: 300000,
  disambiguation: "live, 2003-07-20",
  "artist-credit": COLDPLAY,
  releases: [releaseRef({ id: ID(51), title: "Live 2003", group: ID(50), secondary: ["Live"], date: "2003-11-03", number: 9, count: 12 })],
};

const PARACHUTES_RELEASE = {
  id: ID(11),
  title: "Parachutes",
  status: "Official",
  date: "2000-07-10",
  country: "GB",
  "artist-credit": COLDPLAY,
  "release-group": { id: ID(10), "primary-type": "Album", "first-release-date": "2000-07-10", genres: [{ name: "alternative rock", count: 12 }] },
  media: [
    {
      position: 1,
      format: "CD",
      "track-count": 10,
      tracks: PARACHUTES_TITLES.map((title, index) => ({
        id: ID(8000 + index),
        number: String(index + 1),
        position: index + 1,
        title,
        length: title === "Yellow" ? 269000 : 3000 + index,
        recording: { id: title === "Yellow" ? ID(1) : ID(3000 + index), title, length: title === "Yellow" ? 269110 : 3000 + index },
      })),
    },
  ],
};

function fakeMusicBrainz({ failFirst = 0 } = {}) {
  const calls = [];
  let failures = failFirst;
  const json = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (failures > 0) {
      failures -= 1;
      return json({ error: "slow down" }, 503, { "retry-after": "1" });
    }
    const parsed = new URL(url);
    if (parsed.hostname === "coverartarchive.org") {
      if (parsed.pathname.includes(ID(11))) {
        const bytes = coverBytes("teal");
        return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
      }
      return json({}, 404);
    }
    const query = parsed.searchParams.get("query") || "";
    if (parsed.pathname === "/ws/2/release") {
      if (/parachutes/i.test(query)) {
        return json({ releases: [{ ...PARACHUTES_RELEASE, score: 100, "track-count": 10, media: [{ format: "CD", "track-count": 10 }] }] });
      }
      return json({ releases: [] });
    }
    if (parsed.pathname.startsWith("/ws/2/release/")) {
      return parsed.pathname.endsWith(ID(11)) ? json(PARACHUTES_RELEASE) : json({ error: "Not Found" }, 404);
    }
    if (parsed.pathname === "/ws/2/recording") {
      if (query === `rid:${ID(1)}`) return json({ recordings: [YELLOW] });
      if (/recording:"Yellow"/.test(query)) return json({ recordings: [YELLOW_LIVE, YELLOW] });
      return json({ recordings: [] });
    }
    return json({}, 404);
  };
  return { calls, fetchImpl };
}

function clientFor(db, fake, extra = {}) {
  let clock = 1_000_000;
  const sleeps = [];
  const web = createWebClient({
    db,
    userAgent: "WaveMint/test ( https://github.com/cocampo1005/wavemint )",
    fetchImpl: fake.fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    logger: quietLogger,
    ...extra,
  });
  return { web, sleeps, advance: (ms) => (clock += ms) };
}

function cacheDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE web_cache (key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT, fetched_at TEXT NOT NULL)");
  return db;
}

// --- Web client ----------------------------------------------------------------------

test("the web client identifies itself, spaces requests, caches, and retries politely", async () => {
  const db = cacheDb();
  const fake = fakeMusicBrainz({ failFirst: 1 });
  const { web, sleeps } = clientFor(db, fake);
  const mb = createMusicBrainz({ web });

  const first = await mb.searchRecordings({ title: "Yellow", artist: "Coldplay" });
  assert.equal(first.length, 2);
  assert.equal(fake.calls.length, 2, "a 503 is retried");
  assert.ok(sleeps.includes(1000), "Retry-After is honoured");
  assert.match(fake.calls[0].headers["User-Agent"], /^WaveMint\/test \( https:\/\/github\.com/);

  await mb.searchRecordings({ title: "Yellow", artist: "Coldplay" });
  assert.equal(fake.calls.length, 2, "the second identical request comes from the cache");

  await mb.searchReleases({ album: "Parachutes", artist: "Coldplay" });
  await mb.lookupRelease(ID(11));
  assert.ok(sleeps.filter((ms) => ms > 0 && ms <= 1100).length >= 2, "MusicBrainz requests are spaced about a second apart");

  assert.equal(await mb.lookupRelease(ID(99)), null);
  const calls = fake.calls.length;
  assert.equal(await mb.lookupRelease(ID(99)), null);
  assert.equal(fake.calls.length, calls, "not-found answers are cached too");

  assert.equal(phrase('AC/DC "Live"'), '"AC/DC \\"Live\\""');
});

test("timeouts and network failures become clear errors", async () => {
  const db = cacheDb();
  const web = createWebClient({
    db,
    userAgent: "WaveMint/test",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    retries: 1,
    sleep: async () => {},
    logger: quietLogger,
  });
  await assert.rejects(web.getJson("https://musicbrainz.org/ws/2/recording?query=x&fmt=json"), /Couldn't reach musicbrainz\.org/);
});

// --- Matching helpers -------------------------------------------------------------------

test("matching scores title, artist, length and version, and groups releases", () => {
  const local = { title: "Yellow", artist: "Coldplay", durationMs: 266000 };
  assert.ok(scoreMatch(local, { title: "Yellow", artist: "Coldplay", lengthMs: 269110 }).score >= 0.95);
  assert.ok(scoreMatch(local, { title: "Yellow", artist: "Coldplay", lengthMs: 300000, disambiguation: "live, 2003" }).score < 0.6);
  assert.ok(scoreMatch(local, { title: "Shiver", artist: "Coldplay", lengthMs: 266000 }).score <= 0.3);
  assert.ok(scoreMatch({ ...local, title: "Yellow (Remastered 2011)" }, { title: "Yellow", artist: "Coldplay", lengthMs: 266500 }).score >= 0.95, "remasters are the same recording");
  assert.ok(scoreMatch({ title: "Yellow", artist: "Coldplay" }, { title: "Yellow", artist: "Coldplay" }).score < 0.95, "unknown length lowers confidence");

  const groups = groupReleases(createMusicBrainzShapes().releases, { trackCount: 10 });
  assert.deepEqual(groups.map((group) => group.kind), ["original", "single", "compilation"], "bootleg-only groups are dropped");
  assert.equal(groups[0].representative.id, ID(11), "the earliest official release represents the album");
  assert.equal(groups[0].releaseCount, 2);
  assert.equal(groups[2].artist, "Various Artists");

  assert.equal(pickGroup(groups, { album: "" }).kind, "original");
  assert.equal(pickGroup(groups, { album: "Yellow" }).kind, "single", "the song's current album wins when it's a candidate");
  assert.equal(kindOf({ primaryType: "Album", secondaryTypes: ["Soundtrack"] }), "soundtrack");
});

function createMusicBrainzShapes() {
  const { normalizeRecording } = require("../electron/library/musicbrainz.cjs");
  return normalizeRecording(YELLOW);
}

// --- Identification in a library ----------------------------------------------------------

async function identifyLibrary(t, { fake = fakeMusicBrainz() } = {}) {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  makeTrack(root, "Coldplay/Parachutes/05 Yellow.mp3", { tags: { title: "Yellow", artist: "Coldplay", album: "Parachutes", trackNo: 5, genre: "Rock" } });
  makeTrack(root, "Coldplay/Singles/Yellow (Live).mp3", { tags: { title: "Yellow (Live)", artist: "Coldplay" } });
  makeTrack(root, "Loose/yellow.mp3", { tags: { title: "Yellow", artist: "Coldplay" } });
  await addAndScan(lib.db, lib.scanner, root, { role: "curated" });
  const { web } = clientFor(lib.db, fake);
  const artStore = createArtStore(makeTempDir(t, "wavemint-art-"));
  const identifier = createIdentifier({ db: lib.db, mb: createMusicBrainz({ web }), artStore, getSettings: () => ({ preferOriginalReleases: true }), logger: quietLogger });
  const id = (relPath) => lib.db.prepare("SELECT track_id FROM files WHERE rel_path = ?").get(path.normalize(relPath)).track_id;
  return { ...lib, identifier, fake, artStore, id };
}

test("identifying a song via its album suggests the original album's details", needsAudio, async (t) => {
  const lib = await identifyLibrary(t);
  // Durations of the synthetic files are 3 s; give the song its real length.
  const yellow = lib.id("Coldplay/Parachutes/05 Yellow.mp3");
  lib.db.prepare("UPDATE tracks SET duration_ms = 268000 WHERE id = ?").run(yellow);
  genres.createGenre(lib.db, { name: "Alternative Rock" });
  edits.applyEdits(lib.db, [{ trackId: yellow, fields: { genre: "Britpop" } }]);

  const result = await lib.identifier.identifyTrack(yellow);
  assert.equal(result.method, "album");
  assert.equal(result.status, "matched");
  assert.ok(result.confidence >= 0.95);
  assert.deepEqual(result.releases.map((group) => group.kindLabel), ["Original album", "Single", "Compilation"]);
  const field = (name) => result.fields.find((item) => item.field === name);
  assert.equal(field("album").same, true);
  assert.equal(field("year").suggested, 2000);
  assert.equal(field("year").selected, true, "gaps are selected");
  assert.equal(field("trackTotal").suggested, 10);
  assert.equal(field("discTotal").suggested, 1, "disc count is known from the full release");
  assert.equal(field("genre").suggested, "Alternative Rock", "MusicBrainz genres map to your genre list");
  assert.equal(field("genre").selected, false, "a curated genre is never preselected");
  assert.equal(field("mbRecordingId").suggested, ID(1));
  assert.ok(result.tags.includes("britpop"));

  // The cover comes from the Cover Art Archive and is stored locally.
  const cover = await lib.identifier.cover({ trackId: yellow });
  assert.ok(cover && lib.artStore.locate(cover.hash));
  const calls = lib.fake.calls.length;
  await lib.identifier.cover({ trackId: yellow });
  assert.equal(lib.fake.calls.length, calls, "covers are fetched once");

  const applied = lib.identifier.apply({ trackId: yellow, fields: result.fields.filter((item) => item.selected).map((item) => item.field), coverHash: cover.hash });
  const track = queries.getTrack(lib.db, yellow);
  assert.equal(track.year, 2000);
  assert.equal(track.genre, "Britpop");
  assert.equal(track.mb_recording_id, ID(1));
  assert.equal(track.mb_release_group_id, ID(10));
  assert.equal(track.artwork_hash, cover.hash);
  assert.equal(lib.identifier.view(yellow).status, "applied");

  edits.undoMetadataOperation(lib.db, applied.operationId);
  const undone = queries.getTrack(lib.db, yellow);
  assert.equal(undone.year, null);
  assert.equal(undone.mb_recording_id, null);
  assert.equal(undone.artwork_hash, null);
});

test("choosing another release changes the suggested album", needsAudio, async (t) => {
  const lib = await identifyLibrary(t);
  const yellow = lib.id("Coldplay/Parachutes/05 Yellow.mp3");
  await lib.identifier.identifyTrack(yellow);
  const result = lib.identifier.chooseRelease({ trackId: yellow, releaseGroupId: ID(30) });
  const field = (name) => result.fields.find((item) => item.field === name);
  assert.equal(field("album").suggested, "Now That's What I Call Music! 47");
  assert.equal(field("albumArtist").suggested, "Various Artists");
  assert.equal(field("trackNo").suggested, 4);
  assert.throws(() => lib.identifier.chooseRelease({ trackId: yellow, releaseGroupId: ID(77) }), /isn't one of the candidates/);
});

test("songs without an album are found by recording search; live versions stay apart", needsAudio, async (t) => {
  const lib = await identifyLibrary(t);
  const loose = lib.id("Loose/yellow.mp3");
  lib.db.prepare("UPDATE tracks SET duration_ms = 269000 WHERE id = ?").run(loose);
  const result = await lib.identifier.identifyTrack(loose);
  assert.equal(result.method, "search");
  assert.equal(result.recordings[0].id, ID(1), "the studio recording beats the live one");
  assert.equal(result.fields.find((item) => item.field === "album").suggested, "Parachutes");

  const live = lib.id("Coldplay/Singles/Yellow (Live).mp3");
  lib.db.prepare("UPDATE tracks SET duration_ms = 300000 WHERE id = ?").run(live);
  const liveResult = await lib.identifier.identifyTrack(live);
  assert.equal(liveResult.recordings[0].id, ID(2));
  assert.equal(liveResult.fields.find((item) => item.field === "album").suggested, "Live 2003");
});

test("batch identification records results and only confident ones can be bulk-applied", needsAudio, async (t) => {
  const lib = await identifyLibrary(t);
  const report = await lib.identifier.identifyJob({});
  assert.equal(report.total, 3);
  assert.equal(lib.identifier.summary().unidentified, 0);
  assert.equal(report.matched + report.uncertain + report.noMatch + report.errors, 3);
  // Synthetic files are 3 s long, so lengths don't agree: nothing is "confident".
  assert.equal(lib.identifier.applyConfident({ minConfidence: 0.9 }).tracks, 0);
  const listed = lib.identifier.list({ status: "uncertain" });
  assert.ok(listed.total >= 1);
  lib.identifier.dismiss({ trackIds: listed.rows.map((row) => row.trackId) });
  assert.equal(lib.identifier.list({ status: "dismissed" }).total, listed.total);
});

test("a whole album is matched to a release tracklist and applied in one edit", needsAudio, async (t) => {
  const lib = await createTestLibrary(t);
  const root = makeTempDir(t, "wavemint-music-");
  for (const title of PARACHUTES_TITLES.slice(0, 4)) {
    makeTrack(root, `Coldplay/Parachutes/${title}.mp3`, { tags: { title, artist: "Coldplay", album: "Parachutes" } });
  }
  await addAndScan(lib.db, lib.scanner, root, { role: "curated" });
  const fake = fakeMusicBrainz();
  const { web } = clientFor(lib.db, fake);
  const identifier = createIdentifier({ db: lib.db, mb: createMusicBrainz({ web }), artStore: createArtStore(makeTempDir(t, "wavemint-art-")), logger: quietLogger });
  const releaseId = lib.db.prepare("SELECT release_id FROM tracks LIMIT 1").get().release_id;

  const { candidates } = await identifier.albumCandidates({ releaseId });
  assert.equal(candidates[0].id, ID(11));
  const proposal = await identifier.albumProposal({ releaseId, mbReleaseId: ID(11) });
  assert.equal(proposal.rows.filter((row) => row.match).length, 4);
  assert.equal(proposal.unmatchedRelease.length, 6);
  assert.equal(proposal.rows.find((row) => row.title === "Spies").fields.trackNo, 3);

  const result = await identifier.applyAlbum({ releaseId, mbReleaseId: ID(11), fields: ["trackNo", "trackTotal", "year", "albumArtist"], useCover: true });
  assert.equal(result.tracks, 4);
  const rows = lib.db.prepare("SELECT title, track_no, track_total, year, album_artist, mb_recording_id, artwork_hash FROM tracks ORDER BY track_no").all();
  assert.deepEqual(rows.map((row) => row.track_no), [1, 2, 3, 4]);
  assert.ok(rows.every((row) => row.track_total === 10 && row.year === 2000 && row.album_artist === "Coldplay" && row.mb_recording_id && row.artwork_hash));
});
