// Playlists: manual (ordered songs) and smart (rules over the library).
//
// Entries store logical song IDs. Upgrades keep a song's ID, so it stays in
// its playlists; a song merged into another is followed through
// merged_into; removed songs are hidden (and come back if restored).
// Smart rules are compiled to SQL from an allowlist only.

const fs = require("fs");
const path = require("path");
const { nowIso, parseJson, transaction } = require("./db.cjs");
const { artistKey, pathKey, titleKey } = require("./normalize.cjs");

class PlaylistError extends Error {}

const SMART_FIELDS = {
  genre: { ops: ["is", "is_not", "contains"], type: "text" },
  artist: { ops: ["is", "contains"], type: "text" },
  album: { ops: ["is", "contains"], type: "text" },
  year: { ops: ["is", "gte", "lte"], type: "number" },
  quality: { ops: ["is"], type: "enum", values: ["unknown", "review_suggested", "acceptable", "user_marked_poor", "upgrade_available", "upgraded", "keep_original"] },
  added: { ops: ["within_days", "before_days"], type: "number" },
  review: { ops: ["has_open", "none_open"], type: "none" },
  rating: { ops: ["gte"], type: "number" },
  format: { ops: ["is", "lossless", "lossy"], type: "text" },
  source: { ops: ["is"], type: "enum", values: ["legacy", "curated", "managed", "other"] },
};
const SMART_SORTS = {
  artist: "t.album_artist COLLATE NOCASE, t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no",
  album: "t.album COLLATE NOCASE, t.disc_no, t.track_no",
  title: "t.title COLLATE NOCASE",
  year: "t.year DESC, t.album COLLATE NOCASE, t.track_no",
  recent: "t.created_at DESC",
  rating: "t.rating DESC, t.title COLLATE NOCASE",
};

function cleanName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!name) throw new PlaylistError("Give the playlist a name.");
  return name;
}

/** Validates smart rules and returns a normalized copy. */
function validateRules(rules) {
  const match = rules?.match === "any" ? "any" : "all";
  const conditions = (rules?.conditions || []).slice(0, 20).map((condition) => {
    const field = SMART_FIELDS[condition.field];
    if (!field) throw new PlaylistError(`Unknown smart playlist field "${condition.field}"`);
    if (!field.ops.includes(condition.op)) throw new PlaylistError(`"${condition.op}" doesn't work with ${condition.field}`);
    let value = condition.value;
    if (field.type === "number" && !["has_open", "none_open"].includes(condition.op)) {
      value = Number(value);
      if (!Number.isFinite(value)) throw new PlaylistError(`Enter a number for ${condition.field}`);
    } else if (field.type === "enum") {
      if (!field.values.includes(value)) throw new PlaylistError(`Choose a value for ${condition.field}`);
    } else if (field.type === "text" && !["lossless", "lossy"].includes(condition.op)) {
      value = String(value ?? "").trim().slice(0, 200);
    } else {
      value = null;
    }
    return { field: condition.field, op: condition.op, value };
  });
  if (!conditions.length) throw new PlaylistError("Add at least one rule.");
  const limit = Number.isInteger(rules?.limit) && rules.limit > 0 ? Math.min(rules.limit, 10000) : null;
  const sort = SMART_SORTS[rules?.sort] ? rules.sort : "artist";
  return { match, conditions, limit, sort };
}

function compileCondition({ field, op, value }, params) {
  const like = (column) => {
    params.push(`%${value}%`);
    return `${column} LIKE ? COLLATE NOCASE`;
  };
  const eq = (column) => {
    params.push(value);
    return `${column} = ? COLLATE NOCASE`;
  };
  switch (field) {
    case "genre":
      if (op === "contains") return like("t.genre");
      if (op === "is_not") {
        params.push(value);
        return "COALESCE(t.genre, '') != ? COLLATE NOCASE";
      }
      return eq("t.genre");
    case "artist":
      if (op === "contains") {
        params.push(`%${value}%`, `%${value}%`);
        return "(t.artist LIKE ? COLLATE NOCASE OR t.album_artist LIKE ? COLLATE NOCASE)";
      }
      params.push(value, value);
      return "(t.artist = ? COLLATE NOCASE OR t.album_artist = ? COLLATE NOCASE)";
    case "album":
      return op === "contains" ? like("t.album") : eq("t.album");
    case "year":
      params.push(value);
      return op === "gte" ? "t.year >= ?" : op === "lte" ? "t.year <= ?" : "t.year = ?";
    case "quality":
      params.push(value);
      return "t.quality_status = ?";
    case "added":
      params.push(`-${Math.max(0, Math.round(value))} days`);
      return op === "within_days" ? "t.created_at >= datetime('now', ?)" : "t.created_at < datetime('now', ?)";
    case "review":
      return `${op === "none_open" ? "NOT " : ""}EXISTS (SELECT 1 FROM review_items r WHERE r.entity_type = 'track' AND r.entity_id = t.id AND r.status IN ('needs_review', 'suggested'))`;
    case "rating":
      params.push(value);
      return "COALESCE(t.rating, 0) >= ?";
    case "format":
      if (op === "lossless") return "f.lossless = 1";
      if (op === "lossy") return "COALESCE(f.lossless, 0) = 0";
      params.push(String(value).toLowerCase());
      return "LOWER(f.codec) = ?";
    case "source":
      params.push(value);
      return "s.role = ?";
    default:
      throw new PlaylistError("Unknown rule");
  }
}

const TRACK_SELECT = `t.id, t.title, t.artist, t.album, t.album_artist, t.genre, t.year, t.track_no, t.disc_no, t.rating, t.quality_status,
  COALESCE(t.duration_ms, f.duration_ms) AS duration_ms, COALESCE(t.artwork_hash, f.artwork_hash) AS artwork_hash,
  f.id AS file_id, f.path, f.ext, f.codec, f.lossless, f.bitrate, f.sample_rate, f.bit_depth, f.status AS file_status, s.role AS source_role`;

function playlistRow(db, id) {
  const row = db.prepare("SELECT * FROM playlists WHERE id = ?").get(Number(id));
  if (!row) throw new PlaylistError("This playlist no longer exists.");
  return { ...row, rules: parseJson(row.rules, null) };
}

/** Follows merges to the active song (or null if it's gone). */
function resolveTrackId(db, trackId) {
  let id = trackId;
  for (let hops = 0; hops < 10; hops += 1) {
    const row = db.prepare("SELECT id, state, merged_into FROM tracks WHERE id = ?").get(id);
    if (!row) return null;
    if (row.state === "active") return row.id;
    if (row.state !== "merged" || !row.merged_into) return null;
    id = row.merged_into;
  }
  return null;
}

/** The songs of a playlist, in order, as active songs. */
function playlistTracks(db, id) {
  const playlist = playlistRow(db, id);
  const from = "FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id LEFT JOIN sources s ON s.id = f.source_id";
  if (playlist.kind === "smart") {
    const rules = validateRules(playlist.rules);
    const params = [];
    const where = rules.conditions.map((condition) => compileCondition(condition, params)).join(rules.match === "any" ? " OR " : " AND ");
    return db
      .prepare(`SELECT ${TRACK_SELECT} ${from} WHERE t.state = 'active' AND (${where}) ORDER BY ${SMART_SORTS[rules.sort]} ${rules.limit ? `LIMIT ${rules.limit}` : ""}`)
      .all(...params);
  }
  const entries = db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlist.id);
  const seen = new Set();
  const byId = db.prepare(`SELECT ${TRACK_SELECT} ${from} WHERE t.id = ?`);
  const rows = [];
  for (const entry of entries) {
    const resolved = resolveTrackId(db, entry.track_id);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    rows.push(byId.get(resolved));
  }
  return rows;
}

function listPlaylists(db) {
  return db
    .prepare("SELECT * FROM playlists ORDER BY name COLLATE NOCASE")
    .all()
    .map((row) => {
      let count = null;
      let error = null;
      try {
        count = playlistTracks(db, row.id).length;
      } catch (err) {
        error = err.message;
      }
      return { id: row.id, name: row.name, description: row.description, kind: row.kind, rules: parseJson(row.rules, null), count, error, updated_at: row.updated_at };
    });
}

function getPlaylist(db, { id }) {
  const playlist = playlistRow(db, id);
  return { ...playlist, tracks: playlistTracks(db, playlist.id) };
}

function createPlaylist(db, { name, description = "", kind = "manual", rules = null, trackIds = [] }) {
  const now = nowIso();
  const normalized = kind === "smart" ? validateRules(rules) : null;
  const id = transaction(db, () => {
    const newId = Number(
      db
        .prepare("INSERT INTO playlists (name, description, kind, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(cleanName(name), String(description || "").slice(0, 1000), kind === "smart" ? "smart" : "manual", normalized ? JSON.stringify(normalized) : null, now, now).lastInsertRowid,
    );
    if (kind !== "smart" && trackIds.length) addTracks(db, { id: newId, trackIds });
    return newId;
  });
  return getPlaylist(db, { id });
}

function updatePlaylist(db, { id, name, description, rules }) {
  const playlist = playlistRow(db, id);
  const next = {
    name: name !== undefined ? cleanName(name) : playlist.name,
    description: description !== undefined ? String(description).slice(0, 1000) : playlist.description,
    rules: playlist.kind === "smart" && rules !== undefined ? JSON.stringify(validateRules(rules)) : playlist.rules ? JSON.stringify(playlist.rules) : null,
  };
  db.prepare("UPDATE playlists SET name = ?, description = ?, rules = ?, updated_at = ? WHERE id = ?").run(next.name, next.description, next.rules, nowIso(), playlist.id);
  return getPlaylist(db, { id: playlist.id });
}

function deletePlaylist(db, { id }) {
  db.prepare("DELETE FROM playlists WHERE id = ?").run(Number(id));
  return { deleted: true };
}

function manual(db, id) {
  const playlist = playlistRow(db, id);
  if (playlist.kind !== "manual") throw new PlaylistError("Smart playlists update themselves; edit their rules instead.");
  return playlist;
}

function renumber(db, playlistId, orderedIds) {
  const update = db.prepare("UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?");
  orderedIds.forEach((trackId, index) => update.run(index + 1, playlistId, trackId));
  db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(nowIso(), playlistId);
}

function addTracks(db, { id, trackIds }) {
  const playlist = manual(db, id);
  let added = 0;
  transaction(db, () => {
    let position = db.prepare("SELECT COALESCE(MAX(position), 0) AS n FROM playlist_tracks WHERE playlist_id = ?").get(playlist.id).n;
    const insert = db.prepare("INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)");
    for (const trackId of trackIds) {
      const resolved = resolveTrackId(db, Number(trackId));
      if (!resolved) continue;
      position += 1;
      added += Number(insert.run(playlist.id, resolved, position, nowIso()).changes);
    }
    db.prepare("UPDATE playlists SET updated_at = ? WHERE id = ?").run(nowIso(), playlist.id);
  });
  return { added };
}

function removeTracks(db, { id, trackIds }) {
  const playlist = manual(db, id);
  transaction(db, () => {
    for (const trackId of trackIds) db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?").run(playlist.id, Number(trackId));
    renumber(db, playlist.id, db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlist.id).map((row) => row.track_id));
  });
  return { removed: trackIds.length };
}

/** Moves one song to a new 1-based position. */
function moveTrack(db, { id, trackId, toPosition }) {
  const playlist = manual(db, id);
  transaction(db, () => {
    const ids = db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position").all(playlist.id).map((row) => row.track_id);
    const from = ids.indexOf(Number(trackId));
    if (from < 0) throw new PlaylistError("That song isn't in this playlist.");
    ids.splice(from, 1);
    ids.splice(Math.max(0, Math.min(ids.length, Number(toPosition) - 1)), 0, Number(trackId));
    renumber(db, playlist.id, ids);
  });
  return getPlaylist(db, { id: playlist.id });
}

// --- M3U8 ----------------------------------------------------------------------------

/** M3U8 text (UTF-8, CRLF) for songs with the given paths. */
function m3u8For(name, rows, pathFor) {
  const lines = ["#EXTM3U", `#PLAYLIST:${name.replace(/[\r\n]/g, " ")}`];
  for (const row of rows) {
    const target = pathFor(row);
    if (!target) continue;
    const seconds = row.duration_ms ? Math.round(row.duration_ms / 1000) : -1;
    lines.push(`#EXTINF:${seconds},${[row.artist, row.title].filter(Boolean).join(" - ").replace(/[\r\n]/g, " ")}`);
    lines.push(target);
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** Writes a playlist as M3U8 pointing at the library's current files. */
function exportM3U8(db, { id, filePath, relative = false }) {
  const playlist = playlistRow(db, id);
  const rows = playlistTracks(db, playlist.id).filter((row) => row.path && row.file_status === "ok");
  const base = path.dirname(filePath);
  const text = m3u8For(playlist.name, rows, (row) => (relative ? path.relative(base, row.path) : row.path));
  const temp = `${filePath}.wmtmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, filePath);
  return { written: rows.length, skipped: playlistTracks(db, playlist.id).length - rows.length, filePath };
}

/** Parses an M3U/M3U8 file: [{ path, title, artist, seconds }]. */
function parseM3U(text, baseDir) {
  const entries = [];
  let info = null;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      const match = /^#EXTINF:(-?\d+)[^,]*,(.*)$/.exec(line);
      if (match) {
        const [artist, ...rest] = match[2].split(" - ");
        info = { seconds: Number(match[1]), artist: rest.length ? artist.trim() : "", title: (rest.length ? rest.join(" - ") : artist).trim() };
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    let target = line;
    if (/^file:\/\//i.test(target)) target = decodeURIComponent(target.replace(/^file:\/\/\/?/i, ""));
    if (!path.isAbsolute(target)) target = path.resolve(baseDir, target);
    entries.push({ path: target, ...(info || {}) });
    info = null;
  }
  return entries;
}

/** Imports an M3U/M3U8 file as a manual playlist, matching songs by path, then by artist and title. */
function importM3U(db, { filePath, name }) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > 20 * 1024 * 1024) throw new PlaylistError("That playlist file is too large.");
  // .m3u8 is UTF-8; old .m3u files are often in the Windows code page.
  let text = buffer.toString("utf8");
  if (path.extname(filePath).toLowerCase() === ".m3u" && text.includes("\uFFFD")) text = buffer.toString("latin1");
  const entries = parseM3U(text, path.dirname(filePath));

  const byPath = db.prepare("SELECT track_id FROM files WHERE path_key = ?");
  const byTitle = db.prepare("SELECT id, artist_key FROM tracks WHERE state = 'active' AND title_key = ?");
  const trackIds = [];
  const unmatched = [];
  for (const entry of entries) {
    let trackId = byPath.get(pathKey(entry.path))?.track_id ?? null;
    if (!trackId && entry.title) {
      const candidates = byTitle.all(titleKey(entry.title));
      const best = candidates.find((row) => entry.artist && row.artist_key === artistKey(entry.artist)) || (candidates.length === 1 && !entry.artist ? candidates[0] : null);
      trackId = best?.id ?? null;
    }
    trackId = trackId ? resolveTrackId(db, trackId) : null;
    if (trackId) trackIds.push(trackId);
    else unmatched.push(entry.title ? `${entry.artist ? `${entry.artist} - ` : ""}${entry.title}` : path.basename(entry.path));
  }
  const playlist = createPlaylist(db, { name: name || path.basename(filePath, path.extname(filePath)), kind: "manual", trackIds });
  return { playlist: { id: playlist.id, name: playlist.name }, matched: playlist.tracks.length, unmatched: unmatched.slice(0, 200), unmatchedCount: unmatched.length, total: entries.length };
}

module.exports = {
  PlaylistError,
  SMART_FIELDS,
  SMART_SORTS,
  addTracks,
  createPlaylist,
  deletePlaylist,
  exportM3U8,
  getPlaylist,
  importM3U,
  listPlaylists,
  m3u8For,
  moveTrack,
  parseM3U,
  playlistTracks,
  removeTracks,
  resolveTrackId,
  updatePlaylist,
  validateRules,
};
