const assert = require("node:assert/strict");
const test = require("node:test");

const { albumConsolidation, buildGroups, compareTracks, pairKey } = require("../electron/library/match.cjs");
const { similar } = require("../electron/library/genres.cjs");

let nextId = 1;
function track(overrides = {}) {
  return {
    id: nextId++,
    title: "Simple and Clean",
    artist: "Utada Hikaru",
    album: "Kingdom Hearts",
    duration_ms: 261000,
    track_no: 1,
    source_role: "legacy",
    source_priority: 20,
    codec: "mp3",
    bitrate: 128,
    lossless: 0,
    ...overrides,
  };
}

test("identical files are exact duplicates", () => {
  const a = track({ content_hash: "abc" });
  const b = track({ content_hash: "abc", title: "whatever" });
  assert.equal(compareTracks(a, b).verdict, "exact");
});

test("the same recording in different encodings matches", () => {
  const legacy = track({ codec: "mp3", bitrate: 128 });
  const curated = track({ codec: "aac", bitrate: 256, duration_ms: 261400, source_role: "curated" });
  const result = compareTracks(legacy, curated);
  assert.equal(result.verdict, "same");
  assert.ok(result.score >= 0.85);
  assert.ok(result.evidence.some((note) => /Same length/.test(note.text)));
});

test("live, acoustic, remix and radio edits are different recordings", () => {
  const studio = track({ title: "Viva la Vida" });
  for (const title of ["Viva la Vida (Live)", "Viva la Vida - Acoustic", "Viva la Vida (Remix)", "Viva la Vida (Radio Edit)"]) {
    const result = compareTracks(studio, track({ title }));
    assert.equal(result.verdict, "different", title);
    assert.match(result.evidence[0].text, /Different versions/);
  }
});

test("a remaster or a noticeably different length needs review", () => {
  assert.equal(compareTracks(track({ title: "Shiver" }), track({ title: "Shiver (2020 Remaster)" })).verdict, "uncertain");
  const edit = compareTracks(track(), track({ duration_ms: 261000 - 8000 }));
  assert.equal(edit.verdict, "uncertain");
  assert.match(edit.evidence.find((note) => note.type === "duration").text, /different edit/);
  assert.equal(compareTracks(track(), track({ duration_ms: 400000 })).verdict, "different");
  assert.equal(compareTracks(track(), track({ duration_ms: null })).verdict, "uncertain");
});

test("artist spelling variations still match; different artists don't", () => {
  assert.equal(compareTracks(track({ artist: "Utada Hikaru feat. Skrillex" }), track()).verdict, "same");
  assert.equal(compareTracks(track({ artist: "The Beatles", title: "Help!" }), track({ artist: "Beatles", title: "Help" })).verdict, "same");
  assert.equal(compareTracks(track({ artist: "Talent & 2Pac", title: "Changes" }), track({ artist: "2Pac", title: "Changes" })).verdict, "same");
  assert.equal(compareTracks(track({ artist: "Utada" }), track({ artist: "Hikaru Utada Band" })).verdict, "different");
});

test("MusicBrainz IDs confirm or rule out a match", () => {
  assert.equal(compareTracks(track({ mb_recording_id: "x" }), track({ mb_recording_id: "y" })).verdict, "different");
  const same = compareTracks(track({ mb_recording_id: "x", duration_ms: null }), track({ mb_recording_id: "x" }));
  assert.ok(same.evidence.some((note) => note.type === "musicbrainz"));
});

test("a compilation appearance is the same recording on a different album", () => {
  const result = compareTracks(track({ album: "Kingdom Hearts" }), track({ album: "Utada Hikaru Single Collection" }));
  assert.equal(result.verdict, "same");
  assert.ok(result.evidence.some((note) => /Different albums/.test(note.text)));
});

test("grouping prefers the curated copy and classifies each recording", () => {
  const legacy = track({ id: 1001 });
  const curated = track({ id: 1002, source_role: "curated", source_priority: 80, codec: "aac", bitrate: 256 });
  const legacyOnly = track({ id: 1003, title: "Hikari", duration_ms: 290000 });
  const curatedOnly = track({ id: 1004, title: "Dog Days Are Over", artist: "Florence + The Machine", source_role: "curated", source_priority: 80 });
  const dupA = track({ id: 1005, title: "Yellow", artist: "Coldplay", content_hash: "h1" });
  const dupB = track({ id: 1006, title: "Yellow", artist: "Coldplay", content_hash: "h1" });
  const live = track({ id: 1007, title: "Simple and Clean (Live)" });

  const { groups, conflicts } = buildGroups([legacy, curated, legacyOnly, curatedOnly, dupA, dupB, live]);
  const groupOf = (id) => groups.find((group) => group.trackIds.includes(id));

  assert.equal(groupOf(1001), groupOf(1002));
  assert.equal(groupOf(1001).category, "already_curated");
  assert.equal(groupOf(1001).preferredTrackId, 1002);
  assert.equal(groupOf(1003).category, "legacy_only");
  assert.equal(groupOf(1004).category, "curated_only");
  assert.equal(groupOf(1005), groupOf(1006));
  assert.equal(groupOf(1005).exact, true);
  assert.notEqual(groupOf(1007), groupOf(1001), "the live version stays separate");
  assert.equal(conflicts.length, 0);
  assert.equal(groups.length, 5);
});

test("source priority never overrides strong evidence of different recordings", () => {
  const legacy = track({ id: 2001, title: "Viva la Vida" });
  const curatedLive = track({ id: 2002, title: "Viva la Vida (Live)", source_role: "curated", source_priority: 80 });
  const { groups } = buildGroups([legacy, curatedLive]);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.trackIds.includes(2001)).category, "legacy_only");
});

test("uncertain matches become conflicts; decisions are remembered", () => {
  const a = track({ id: 3001, title: "Shiver" });
  const b = track({ id: 3002, title: "Shiver (2020 Remaster)", source_role: "curated", source_priority: 80 });
  let result = buildGroups([a, b]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].preferredTrackId, 3002);

  // The user says they're the same recording.
  result = buildGroups([a, b], { decisions: new Map([[pairKey(3001, 3002), "same"]]) });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].category, "already_curated");

  // Or different: never suggested again, even for an otherwise strong match.
  const c = track({ id: 3003 });
  const d = track({ id: 3004, source_role: "curated", source_priority: 80 });
  result = buildGroups([c, d], { decisions: new Map([[pairKey(3003, 3004), "different"]]) });
  assert.equal(result.groups.length, 2);
  assert.equal(result.conflicts.length, 0);
});

test("missing metadata never produces a match by itself", () => {
  const { groups } = buildGroups([track({ id: 4001, title: "", artist: "" }), track({ id: 4002, title: "", artist: "" })]);
  assert.equal(groups.length, 2);
});

test("partial albums: remaining legacy songs join the curated album, editions stay apart", () => {
  const tracks = [];
  for (let i = 1; i <= 12; i += 1) tracks.push(track({ id: 5000 + i, title: `Song ${i}`, album: "Parachutes", release_id: 1, track_no: i, duration_ms: 200000 + i * 1000 }));
  for (const i of [5, 6, 7, 8]) {
    tracks.push(track({ id: 6000 + i, title: `Song ${i}`, album: "Parachutes", release_id: 2, source_role: "curated", source_priority: 80, track_no: i, duration_ms: 200000 + i * 1000 }));
  }
  const { groups } = buildGroups(tracks);
  const merged = groups.filter((group) => group.category === "already_curated");
  assert.equal(merged.length, 4);
  assert.equal(groups.length, 12, "12 recordings: 4 curated versions and 8 legacy-only songs");

  const releases = new Map([
    [1, { id: 1, title: "Parachutes", album_artist: "", edition: "", year: null }],
    [2, { id: 2, title: "Parachutes", album_artist: "Coldplay", edition: "", year: 2000 }],
  ]);
  const { proposals } = albumConsolidation({
    groups: groups.map((group) => ({ ...group, action: "keep_preferred" })),
    tracksById: new Map(tracks.map((item) => [item.id, item])),
    releasesById: releases,
    similarTitles: similar,
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].trackIds.length, 8, "the 8 legacy-only songs join the curated album");
  assert.deepEqual(proposals[0].fields, { album: "Parachutes", albumArtist: "Coldplay", year: 2000 });

  releases.set(2, { ...releases.get(2), edition: "deluxe edition" });
  const editions = albumConsolidation({
    groups: groups.map((group) => ({ ...group, action: "keep_preferred" })),
    tracksById: new Map(tracks.map((item) => [item.id, item])),
    releasesById: releases,
    similarTitles: similar,
  });
  assert.equal(editions.proposals.length, 0);
  assert.equal(editions.notes.length, 1);
});
