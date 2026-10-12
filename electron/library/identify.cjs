// Identifying songs with MusicBrainz and suggesting metadata.
//
// For a song with an album, the album is looked up first (release search →
// tracklist), which finds the studio recording far more reliably than a
// title search; otherwise recordings are searched by title, artist and
// length. The recording's releases are grouped by release group (original
// album, other albums, singles, soundtracks, compilations, live) so the user
// can pick the album the song should belong to.
//
// Confidence is computed from title, artist and length agreement (shown with
// its parts); it is never taken from, or presented as, anything else.
// Suggestions are stored and only applied when the user approves them.

const { nowIso, parseJson, transaction } = require("./db.cjs");
const { applyEdits } = require("./edits.cjs");
const { levenshtein } = require("./genres.cjs");
const { artistKey, artistParts, normalizeKey, parseAlbum, parseTitle } = require("./normalize.cjs");

const SUGGESTED_FIELDS = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["albumArtist", "Album artist"],
  ["year", "Year"],
  ["trackNo", "Track"],
  ["trackTotal", "Tracks on disc"],
  ["discNo", "Disc"],
  ["discTotal", "Discs"],
  ["genre", "Genre"],
  ["mbRecordingId", "MusicBrainz recording"],
  ["mbReleaseId", "MusicBrainz release"],
  ["mbReleaseGroupId", "MusicBrainz release group"],
];
const FIELD_COLUMNS = {
  title: "title",
  artist: "artist",
  album: "album",
  albumArtist: "album_artist",
  year: "year",
  trackNo: "track_no",
  trackTotal: "track_total",
  discNo: "disc_no",
  discTotal: "disc_total",
  genre: "genre",
  mbRecordingId: "mb_recording_id",
  mbReleaseId: "mb_release_id",
  mbReleaseGroupId: "mb_release_group_id",
};
const ID_FIELDS = new Set(["mbRecordingId", "mbReleaseId", "mbReleaseGroupId"]);
// Fields that only fill gaps by default (changing them is a curation choice).
const GAP_ONLY = new Set(["title", "artist", "genre"]);

const MATCHED = 0.85;
const UNCERTAIN = 0.6;

function ratio(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Version markers of an MB recording: its title plus its disambiguation. */
function versionsOf(title, disambiguation = "") {
  const versions = new Set(parseTitle(title).versions);
  if (disambiguation) for (const version of parseTitle(`x (${disambiguation})`).versions) versions.add(version);
  versions.delete("remaster"); // remasters are usually the same recording in MusicBrainz
  return versions;
}

/** How well an MB track/recording fits a local song: { score, parts, notes }. */
function scoreMatch(local, candidate) {
  const notes = [];
  const lt = parseTitle(local.title);
  const ct = parseTitle(candidate.title);
  let title = lt.key && lt.key === ct.key ? 1 : ratio(lt.key, ct.key) >= 0.8 ? ratio(lt.key, ct.key) * 0.9 : 0;
  notes.push(title === 1 ? "Same title" : title ? "Similar title" : "Different title");

  let artist = 0;
  if (!local.artist) artist = 0.5;
  else if (artistKey(local.artist) === artistKey(candidate.artist) || artistParts(local.artist).some((part) => artistParts(candidate.artist).includes(part))) artist = 1;
  else if (ratio(artistKey(local.artist), artistKey(candidate.artist)) >= 0.85) artist = 0.8;
  notes.push(artist === 1 ? "Same artist" : artist >= 0.8 ? "Similar artist" : local.artist ? "Different artist" : "No artist to compare");

  let duration = 0.6;
  if (local.durationMs && candidate.lengthMs) {
    const diff = Math.abs(local.durationMs - candidate.lengthMs) / 1000;
    duration = diff <= 3 ? 1 : diff <= 7 ? 0.8 : diff <= 15 ? 0.4 : 0;
    notes.push(`Length differs by ${diff.toFixed(1)} s`);
  } else {
    notes.push("Length not available to compare");
  }

  const localVersions = versionsOf(local.title);
  const candidateVersions = versionsOf(candidate.title, candidate.disambiguation);
  const mismatch = [...localVersions].some((v) => !candidateVersions.has(v)) || [...candidateVersions].some((v) => !localVersions.has(v));
  if (mismatch) notes.push(`Different version (${[...candidateVersions].join(", ") || "studio"} vs ${[...localVersions].join(", ") || "studio"})`);

  let score = 0.4 * title + 0.35 * artist + 0.25 * duration;
  if (mismatch) score *= 0.5;
  if (title === 0) score = Math.min(score, 0.3);
  return { score: Math.round(score * 100) / 100, parts: { title, artist, duration, version: mismatch ? 0 : 1 }, notes };
}

const KIND_ORDER = ["original", "album", "single", "ep", "soundtrack", "live", "compilation", "other"];
const KIND_LABELS = {
  original: "Original album",
  album: "Album",
  single: "Single",
  ep: "EP",
  soundtrack: "Soundtrack",
  live: "Live",
  compilation: "Compilation",
  other: "Other release",
};

function kindOf(release) {
  const secondary = (release.secondaryTypes || []).map((type) => String(type).toLowerCase());
  if (secondary.includes("live")) return "live";
  if (secondary.includes("soundtrack")) return "soundtrack";
  if (secondary.includes("compilation") || secondary.includes("dj-mix") || secondary.includes("mixtape/street")) return "compilation";
  if (secondary.length) return "other";
  switch (String(release.primaryType || "").toLowerCase()) {
    case "album":
      return "album";
    case "single":
      return "single";
    case "ep":
      return "ep";
    default:
      return "other";
  }
}

const STATUS_RANK = { official: 0, promotion: 1, null: 2, withdrawn: 3, bootleg: 4 };

/**
 * Groups a recording's releases by release group; each group gets a
 * representative release (official, matching track count, earliest).
 */
function groupReleases(releases, { trackCount = null } = {}) {
  const groups = new Map();
  for (const release of releases) {
    const key = release.releaseGroupId || release.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(release);
  }

  const list = [...groups.entries()].map(([id, members]) => {
    const sorted = [...members].sort(
      (a, b) =>
        (STATUS_RANK[String(a.status).toLowerCase()] ?? 2) - (STATUS_RANK[String(b.status).toLowerCase()] ?? 2) ||
        (trackCount ? Number(b.trackCount === trackCount) - Number(a.trackCount === trackCount) : 0) ||
        (a.year ?? 9999) - (b.year ?? 9999) ||
        Number(!["XW", "US", "GB"].includes(b.country)) - Number(!["XW", "US", "GB"].includes(a.country)),
    );
    const representative = sorted[0];
    const years = members.map((member) => member.year).filter(Boolean);
    const kind = kindOf(representative);
    return {
      releaseGroupId: id,
      title: representative.title,
      artist: representative.artist,
      kind,
      edition: parseAlbum(representative.title).edition,
      year: years.length ? Math.min(...years) : null,
      releaseCount: members.length,
      bootlegOnly: members.every((member) => String(member.status).toLowerCase() === "bootleg"),
      representative,
    };
  });

  // The earliest album group without edition words is the original album.
  const albums = list.filter((group) => group.kind === "album" && !group.bootlegOnly).sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  const original = albums.find((group) => !group.edition) || albums[0];
  if (original) original.kind = "original";

  return list
    .filter((group) => !group.bootlegOnly)
    .map((group) => ({ ...group, kindLabel: KIND_LABELS[group.kind] }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.year ?? 9999) - (b.year ?? 9999));
}

/** The group to suggest: the song's current album if listed, else the original album. */
function pickGroup(groups, { album = "", preferOriginal = true } = {}) {
  if (!groups.length) return null;
  const albumKey = parseAlbum(album).key;
  const current = albumKey && groups.find((group) => parseAlbum(group.title).key === albumKey && group.kind !== "compilation");
  if (current) return current;
  if (preferOriginal) return groups.find((group) => group.kind === "original") || groups[0];
  return groups.find((group) => group.kind === "original" || group.kind === "album") || groups[0];
}

/** Maps MusicBrainz genres/tags to the user's own genre names (or nothing). */
function mapGenre(db, tags) {
  const genres = new Map(db.prepare("SELECT name FROM genres").all().map((row) => [normalizeKey(row.name), row.name]));
  const aliases = new Map(db.prepare("SELECT a.alias_key, g.name FROM genre_aliases a JOIN genres g ON g.id = a.genre_id").all().map((row) => [row.alias_key, row.name]));
  for (const tag of [...tags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
    const key = normalizeKey(tag.name);
    if (genres.has(key)) return genres.get(key);
    if (aliases.has(key)) return aliases.get(key);
  }
  return null;
}

function createIdentifier({ db, mb, artStore, getSettings = () => ({}), logger = console }) {
  function localTrack(trackId) {
    const track = db
      .prepare(
        `SELECT t.*, f.duration_ms AS file_duration_ms,
                (SELECT COUNT(*) FROM tracks o WHERE o.release_id = t.release_id AND o.state = 'active') AS album_size
         FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id WHERE t.id = ? AND t.state = 'active'`,
      )
      .get(Number(trackId));
    if (!track) throw new Error("This song no longer exists.");
    return { ...track, durationMs: track.duration_ms || track.file_duration_ms || null };
  }

  /** Finds the recording: album first when the song has one, else a recording search. */
  async function findRecording(track, { signal }) {
    const local = { title: track.title, artist: track.artist, durationMs: track.durationMs };

    if (track.mb_recording_id) {
      const [recording] = await mb.searchRecordings({ recordingId: track.mb_recording_id }, { signal });
      if (recording) return { recording, method: "mbid", match: scoreMatch(local, recording), via: null };
    }

    if (track.album) {
      const releases = (await mb.searchReleases({ album: track.album, artist: track.album_artist || track.artist }, { signal }))
        .filter((release) => (release.searchScore ?? 0) >= 80)
        .sort(
          (a, b) =>
            (STATUS_RANK[String(a.status).toLowerCase()] ?? 2) - (STATUS_RANK[String(b.status).toLowerCase()] ?? 2) ||
            Number(b.trackCount === (track.track_total || track.album_size)) - Number(a.trackCount === (track.track_total || track.album_size)),
        );
      for (const release of releases.slice(0, 2)) {
        const full = await mb.lookupRelease(release.id, { signal });
        const best = (full?.tracks || [])
          .map((item) => ({ item, match: scoreMatch(local, item) }))
          .sort((a, b) => b.match.score - a.match.score)[0];
        if (best && best.match.score >= UNCERTAIN && best.item.recordingId) {
          const [recording] = await mb.searchRecordings({ recordingId: best.item.recordingId }, { signal });
          if (recording) return { recording, method: "album", match: scoreMatch(local, recording), via: full };
        }
      }
    }

    // MusicBrainz keeps "(Live)", "(Remastered)" etc. out of most titles
    // (in the disambiguation instead): search the base title, then score
    // versions against the full one.
    const title = track.title.replace(/\s*[([][^)\]]*[)\]]/g, "").trim() || track.title;
    const recordings = await mb.searchRecordings({ title, artist: track.artist }, { signal });
    const scored = recordings
      .map((recording) => ({ recording, match: scoreMatch(local, recording), groups: groupReleases(recording.releases) }))
      // Prefer recordings released on a real album over one-off live/bootleg ones.
      .sort((a, b) => b.match.score - a.match.score || Number(b.groups.some((g) => g.kind === "original")) - Number(a.groups.some((g) => g.kind === "original")) || b.recording.releases.length - a.recording.releases.length);
    if (!scored.length) return null;
    return { recording: scored[0].recording, method: "search", match: scored[0].match, via: null, alternatives: scored.slice(1, 5) };
  }

  function suggestionFor(track, recording, group, fullRelease = null) {
    const release = group?.representative || null;
    const albumTrack = fullRelease?.tracks?.find((item) => item.recordingId === recording.id) || null;
    const fields = {
      title: recording.title,
      artist: recording.artist,
      mbRecordingId: recording.id,
    };
    if (release) {
      fields.album = release.title;
      fields.albumArtist = release.artist;
      fields.year = group.kind === "original" ? group.year ?? release.year : release.year ?? group.year;
      fields.trackNo = albumTrack?.trackNo ?? release.trackNo;
      fields.trackTotal = albumTrack?.discTrackCount ?? release.trackCount;
      const discNo = albumTrack?.discNo ?? release.discNo;
      const discCount = fullRelease?.id === release.id ? fullRelease.discCount : null;
      if (discCount) {
        fields.discNo = discNo;
        fields.discTotal = discCount;
      } else if (discNo > 1) {
        fields.discNo = discNo;
      }
      fields.mbReleaseId = release.id;
      fields.mbReleaseGroupId = group.releaseGroupId;
    }
    const tags = [...recording.tags, ...(fullRelease?.tags || [])];
    const genre = mapGenre(db, tags);
    if (genre) fields.genre = genre;
    for (const [key, value] of Object.entries(fields)) if (value === null || value === undefined || value === "") delete fields[key];
    return { fields, tags: [...new Set(tags.sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((tag) => tag.name))].slice(0, 8) };
  }

  /** Identifies one song and stores the result. */
  async function identifyTrack(trackId, { signal } = {}) {
    const track = localTrack(trackId);
    let row;
    try {
      const found = await findRecording(track, { signal });
      if (!found) {
        row = { status: "no_match", method: "search", confidence: null, recordings: [], releases: [], chosen: null, suggestion: null };
      } else {
        const groups = groupReleases(found.recording.releases, { trackCount: track.track_total || track.album_size || null });
        const group = (found.via && groups.find((item) => item.releaseGroupId === found.via.releaseGroupId)) || pickGroup(groups, { album: track.album, preferOriginal: getSettings().preferOriginalReleases !== false });
        const suggestion = suggestionFor(track, found.recording, group, found.via && group && found.via.id === group.representative.id ? found.via : null);
        const score = found.match.score;
        row = {
          status: score >= MATCHED ? "matched" : score >= UNCERTAIN ? "uncertain" : "no_match",
          method: found.method,
          confidence: score,
          recordings: [
            { id: found.recording.id, title: found.recording.title, artist: found.recording.artist, lengthMs: found.recording.lengthMs, disambiguation: found.recording.disambiguation, match: found.match },
            ...(found.alternatives || []).map((item) => ({ id: item.recording.id, title: item.recording.title, artist: item.recording.artist, lengthMs: item.recording.lengthMs, disambiguation: item.recording.disambiguation, match: item.match })),
          ],
          releases: groups.slice(0, 60),
          chosen: group?.releaseGroupId || null,
          suggestion: { ...suggestion, via: found.via ? { id: found.via.id, discCount: found.via.discCount, tracks: found.via.tracks.filter((item) => item.recordingId === found.recording.id) } : null, recording: found.recording.id },
        };
      }
    } catch (error) {
      if (signal?.aborted || error.code === "cancelled") throw error;
      row = { status: "error", method: "search", confidence: null, recordings: [], releases: [], chosen: null, suggestion: null, error: error.message };
    }

    db.prepare(
      `INSERT INTO identifications (track_id, status, method, confidence, recordings, releases, chosen_release_id, suggestion, error, checked_at, operation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(track_id) DO UPDATE SET status = excluded.status, method = excluded.method, confidence = excluded.confidence,
         recordings = excluded.recordings, releases = excluded.releases, chosen_release_id = excluded.chosen_release_id,
         suggestion = excluded.suggestion, error = excluded.error, checked_at = excluded.checked_at, operation_id = NULL`,
    ).run(
      track.id,
      row.status,
      row.method,
      row.confidence,
      JSON.stringify(row.recordings),
      JSON.stringify(row.releases),
      row.chosen,
      row.suggestion ? JSON.stringify(row.suggestion) : null,
      row.error || null,
      nowIso(),
    );
    return view(track.id);
  }

  /** The stored identification with current values and default choices. */
  function view(trackId) {
    const row = db.prepare("SELECT * FROM identifications WHERE track_id = ?").get(Number(trackId));
    if (!row) return null;
    const track = localTrack(trackId);
    const suggestion = parseJson(row.suggestion, null);
    const curated = new Set(parseJson(track.curated_fields, []));
    const fields = suggestion
      ? SUGGESTED_FIELDS.filter(([field]) => suggestion.fields[field] !== undefined).map(([field, label]) => {
          const current = track[FIELD_COLUMNS[field]] ?? null;
          const suggested = suggestion.fields[field];
          const same = String(current ?? "").trim().toLowerCase() === String(suggested ?? "").trim().toLowerCase();
          const empty = current === null || current === "";
          let selected = !same && (ID_FIELDS.has(field) || empty || (!GAP_ONLY.has(field) && !curated.has(FIELD_COLUMNS[field])));
          if (same) selected = false;
          return { field, label, current, suggested, same, curated: curated.has(FIELD_COLUMNS[field]), selected, identifier: ID_FIELDS.has(field) };
        })
      : [];
    return {
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      status: row.status,
      method: row.method,
      confidence: row.confidence,
      checkedAt: row.checked_at,
      error: row.error,
      recordings: parseJson(row.recordings, []),
      releases: parseJson(row.releases, []),
      chosenReleaseGroupId: row.chosen_release_id,
      fields,
      tags: suggestion?.tags || [],
      operationId: row.operation_id,
    };
  }

  /** Switches the suggestion to another release group of the same recording. */
  function chooseRelease({ trackId, releaseGroupId }) {
    const row = db.prepare("SELECT * FROM identifications WHERE track_id = ?").get(Number(trackId));
    if (!row) throw new Error("Identify this song first.");
    const groups = parseJson(row.releases, []);
    const group = groups.find((item) => item.releaseGroupId === releaseGroupId);
    if (!group) throw new Error("That release isn't one of the candidates.");
    const suggestion = parseJson(row.suggestion, {});
    const recording = parseJson(row.recordings, [])[0];
    const track = localTrack(trackId);
    const via = suggestion.via && suggestion.via.id === group.representative.id ? suggestion.via : null;
    const next = suggestionFor(
      track,
      { id: recording.id, title: recording.title, artist: recording.artist, tags: (suggestion.tags || []).map((name) => ({ name, count: 0 })) },
      group,
      via ? { id: via.id, discCount: via.discCount, tracks: via.tracks, tags: [] } : null,
    );
    db.prepare("UPDATE identifications SET chosen_release_id = ?, suggestion = ? WHERE track_id = ?").run(
      releaseGroupId,
      JSON.stringify({ ...suggestion, fields: next.fields }),
      track.id,
    );
    return view(track.id);
  }

  /** The chosen release's front cover from the Cover Art Archive (stored locally). */
  async function cover({ trackId }, { signal } = {}) {
    const row = db.prepare("SELECT suggestion FROM identifications WHERE track_id = ?").get(Number(trackId));
    const fields = parseJson(row?.suggestion, {}).fields || {};
    if (!fields.mbReleaseId && !fields.mbReleaseGroupId) return null;
    const key = `cover:${fields.mbReleaseId || ""}:${fields.mbReleaseGroupId || ""}`;
    const known = db.prepare("SELECT status, body FROM web_cache WHERE key = ?").get(key);
    if (known?.status === 404) return null;
    if (known?.status === 200 && artStore.locate(known.body)) return { hash: known.body };
    const image = await mb.frontCover({ releaseId: fields.mbReleaseId, releaseGroupId: fields.mbReleaseGroupId }, { signal });
    if (!image) {
      db.prepare("INSERT OR REPLACE INTO web_cache (key, status, body, fetched_at) VALUES (?, 404, NULL, ?)").run(key, nowIso());
      return null;
    }
    const { hash } = artStore.save(image.data);
    db.prepare("INSERT OR REPLACE INTO web_cache (key, status, body, fetched_at) VALUES (?, 200, ?, ?)").run(key, hash, nowIso());
    return { hash };
  }

  /** Applies the selected suggested fields (and optionally the cover) as one undoable edit. */
  function apply({ trackId, fields: selected, coverHash = null }) {
    const item = view(trackId);
    if (!item || !item.fields.length) throw new Error("There's no suggestion to apply.");
    const chosen = new Set(selected);
    const values = Object.fromEntries(item.fields.filter((field) => chosen.has(field.field) && !field.same).map((field) => [field.field, field.suggested]));
    if (coverHash) values.artworkHash = coverHash;
    if (!Object.keys(values).length) throw new Error("Choose at least one change to apply.");
    const result = applyEdits(db, [{ trackId: item.trackId, fields: values }], { label: `MusicBrainz: ${item.title || "song"}` });
    db.prepare("UPDATE identifications SET status = 'applied', operation_id = ? WHERE track_id = ?").run(result.operationId, item.trackId);
    return result;
  }

  function dismiss({ trackIds }) {
    const result = db.prepare(`UPDATE identifications SET status = 'dismissed' WHERE track_id IN (${trackIds.map(() => "?").join(",")})`).run(...trackIds);
    return { dismissed: Number(result.changes) };
  }

  /** Applies every stored suggestion at or above `minConfidence` with default choices. */
  function applyConfident({ minConfidence = 0.9 }) {
    const rows = db.prepare("SELECT track_id FROM identifications WHERE status = 'matched' AND confidence >= ?").all(minConfidence);
    const edits = [];
    for (const row of rows) {
      const item = view(row.track_id);
      const values = Object.fromEntries(item.fields.filter((field) => field.selected).map((field) => [field.field, field.suggested]));
      if (Object.keys(values).length) edits.push({ trackId: item.trackId, fields: values });
    }
    if (!edits.length) return { operationId: null, tracks: 0 };
    const result = applyEdits(db, edits, { label: `MusicBrainz: ${edits.length} confident match${edits.length === 1 ? "" : "es"}` });
    transaction(db, () => {
      for (const edit of edits) db.prepare("UPDATE identifications SET status = 'applied', operation_id = ? WHERE track_id = ?").run(result.operationId, edit.trackId);
    });
    return result;
  }

  /** Background identification of many songs (one MusicBrainz request at a time). */
  async function identifyJob({ trackIds = null, onlyNew = true, signal, progress }) {
    const ids = trackIds?.length
      ? trackIds
      : db
          .prepare(
            `SELECT t.id FROM tracks t LEFT JOIN identifications i ON i.track_id = t.id
             WHERE t.state = 'active' ${onlyNew ? "AND i.track_id IS NULL AND t.mb_recording_id IS NULL" : ""} ORDER BY t.album_artist, t.album, t.track_no`,
          )
          .all()
          .map((row) => row.id);
    const report = { total: ids.length, matched: 0, uncertain: 0, noMatch: 0, errors: 0 };
    for (const [index, id] of ids.entries()) {
      if (signal?.aborted) break;
      const track = db.prepare("SELECT title FROM tracks WHERE id = ?").get(id);
      progress?.({ phase: "identifying", done: index, total: ids.length, current: track?.title || "" });
      try {
        const result = await identifyTrack(id, { signal });
        if (result.status === "matched") report.matched += 1;
        else if (result.status === "uncertain") report.uncertain += 1;
        else if (result.status === "error") report.errors += 1;
        else report.noMatch += 1;
      } catch (error) {
        if (signal?.aborted) break;
        report.errors += 1;
        logger.warn(`[library] Identification failed: ${error.message}`);
      }
    }
    return report;
  }

  function list({ status = "suggested", offset = 0, limit = 100 }) {
    const where = {
      suggested: "i.status = 'matched'",
      uncertain: "i.status = 'uncertain'",
      no_match: "i.status IN ('no_match', 'error')",
      applied: "i.status = 'applied'",
      dismissed: "i.status = 'dismissed'",
    }[status] || "i.status = 'matched'";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM identifications i JOIN tracks t ON t.id = i.track_id AND t.state = 'active' WHERE ${where}`).get().n;
    const rows = db
      .prepare(
        `SELECT i.track_id FROM identifications i JOIN tracks t ON t.id = i.track_id AND t.state = 'active'
         WHERE ${where} ORDER BY i.confidence DESC, t.artist, t.album, t.track_no LIMIT ? OFFSET ?`,
      )
      .all(Math.min(500, limit), Math.max(0, offset));
    return { total, rows: rows.map((row) => view(row.track_id)) };
  }

  function summary() {
    const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM identifications GROUP BY status").all().map((row) => [row.status, row.n]));
    const unidentified = db
      .prepare("SELECT COUNT(*) AS n FROM tracks t LEFT JOIN identifications i ON i.track_id = t.id WHERE t.state = 'active' AND i.track_id IS NULL AND t.mb_recording_id IS NULL")
      .get().n;
    const confident = db.prepare("SELECT COUNT(*) AS n FROM identifications WHERE status = 'matched' AND confidence >= 0.9").get().n;
    return { counts, unidentified, confident };
  }

  // --- whole albums -----------------------------------------------------------------

  function albumTracks(releaseId) {
    return db
      .prepare(
        `SELECT t.*, COALESCE(t.duration_ms, f.duration_ms) AS length_ms FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id
         WHERE t.release_id = ? AND t.state = 'active' ORDER BY t.disc_no, t.track_no, t.title`,
      )
      .all(Number(releaseId));
  }

  /** Release candidates for a local album. */
  async function albumCandidates({ releaseId }, { signal } = {}) {
    const release = db.prepare("SELECT * FROM releases WHERE id = ?").get(Number(releaseId));
    if (!release) throw new Error("This album no longer exists.");
    const tracks = albumTracks(release.id);
    const found = await mb.searchReleases({ album: release.title, artist: release.album_artist || tracks[0]?.artist }, { signal });
    return {
      album: { id: release.id, title: release.title, artist: release.album_artist, tracks: tracks.length },
      candidates: found
        .filter((item) => (item.searchScore ?? 0) >= 60)
        .map((item) => ({ ...item, kind: kindOf(item), kindLabel: KIND_LABELS[kindOf(item)], trackCountMatches: item.trackCount === tracks.length }))
        .sort(
          (a, b) =>
            Math.round((b.searchScore ?? 0) / 10) - Math.round((a.searchScore ?? 0) / 10) ||
            (STATUS_RANK[String(a.status).toLowerCase()] ?? 2) - (STATUS_RANK[String(b.status).toLowerCase()] ?? 2) ||
            Number(b.trackCountMatches) - Number(a.trackCountMatches) ||
            Number(b.kind === "album") - Number(a.kind === "album") ||
            (a.year ?? 9999) - (b.year ?? 9999) ||
            Number(["XW", "US", "GB"].includes(b.country)) - Number(["XW", "US", "GB"].includes(a.country)),
        ),
    };
  }

  /** Matches a local album's songs to a MusicBrainz release's tracklist. */
  async function albumProposal({ releaseId, mbReleaseId }, { signal } = {}) {
    const full = await mb.lookupRelease(mbReleaseId, { signal });
    if (!full) throw new Error("MusicBrainz doesn't know that release anymore.");
    const tracks = albumTracks(releaseId);
    const used = new Set();
    const rows = tracks.map((track) => {
      const local = { title: track.title, artist: track.artist, durationMs: track.length_ms };
      const scored = full.tracks
        .filter((item) => !used.has(item.id))
        .map((item) => ({ item, match: scoreMatch(local, item) }))
        .sort((a, b) => b.match.score - a.match.score || Number(b.item.trackNo === track.track_no) - Number(a.item.trackNo === track.track_no));
      const best = scored[0];
      if (!best || best.match.score < UNCERTAIN) return { trackId: track.id, title: track.title, match: null };
      used.add(best.item.id);
      const fields = {
        title: best.item.title,
        artist: best.item.artist || full.artist,
        album: full.title,
        albumArtist: full.artist,
        year: full.year ?? full.originalYear,
        trackNo: best.item.trackNo,
        trackTotal: best.item.discTrackCount,
        discNo: best.item.discNo,
        discTotal: full.discCount,
        mbRecordingId: best.item.recordingId,
        mbReleaseId: full.id,
        mbReleaseGroupId: full.releaseGroupId,
      };
      const genre = mapGenre(db, full.tags);
      if (genre && !track.genre) fields.genre = genre;
      for (const [key, value] of Object.entries(fields)) if (value === null || value === undefined || value === "") delete fields[key];
      return {
        trackId: track.id,
        title: track.title,
        current: Object.fromEntries(Object.keys(fields).map((field) => [field, track[FIELD_COLUMNS[field]] ?? null])),
        match: { title: best.item.title, trackNo: best.item.trackNo, discNo: best.item.discNo, score: best.match.score, notes: best.match.notes },
        fields,
      };
    });
    return {
      release: { id: full.id, title: full.title, artist: full.artist, year: full.year, originalYear: full.originalYear, country: full.country, discCount: full.discCount, trackCount: full.trackCount, kindLabel: KIND_LABELS[kindOf(full)], releaseGroupId: full.releaseGroupId },
      rows,
      unmatchedRelease: full.tracks.filter((item) => !used.has(item.id)).map((item) => ({ title: item.title, trackNo: item.trackNo, discNo: item.discNo })),
      tags: full.tags.map((tag) => tag.name).slice(0, 8),
    };
  }

  /** Applies an album proposal to the matched songs, as one undoable edit. */
  async function applyAlbum({ releaseId, mbReleaseId, fields: selected, exclude = [], useCover = false }, { signal } = {}) {
    const proposal = await albumProposal({ releaseId, mbReleaseId }, { signal });
    const chosen = new Set(selected);
    const skip = new Set(exclude.map(Number));
    let coverHash = null;
    if (useCover) {
      const image = await mb.frontCover({ releaseId: proposal.release.id, releaseGroupId: proposal.release.releaseGroupId }, { signal });
      if (image) coverHash = artStore.save(image.data).hash;
    }
    const edits = proposal.rows
      .filter((row) => row.match && !skip.has(row.trackId))
      .map((row) => ({
        trackId: row.trackId,
        fields: {
          ...Object.fromEntries(Object.entries(row.fields).filter(([field]) => chosen.has(field) || ID_FIELDS.has(field))),
          ...(coverHash ? { artworkHash: coverHash } : {}),
        },
      }))
      .filter((edit) => Object.keys(edit.fields).length);
    if (!edits.length) throw new Error("Nothing to apply.");
    const result = applyEdits(db, edits, { label: `MusicBrainz album: ${proposal.release.title}` });
    transaction(db, () => {
      for (const edit of edits) {
        db.prepare(
          `INSERT INTO identifications (track_id, status, method, confidence, checked_at, operation_id) VALUES (?, 'applied', 'album', NULL, ?, ?)
           ON CONFLICT(track_id) DO UPDATE SET status = 'applied', method = 'album', operation_id = excluded.operation_id`,
        ).run(edit.trackId, nowIso(), result.operationId);
      }
    });
    return result;
  }

  return { albumCandidates, albumProposal, apply, applyAlbum, applyConfident, chooseRelease, cover, dismiss, identifyJob, identifyTrack, list, summary, view };
}

module.exports = { KIND_LABELS, createIdentifier, groupReleases, kindOf, mapGenre, pickGroup, scoreMatch, versionsOf };
