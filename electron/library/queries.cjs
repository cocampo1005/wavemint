// Read-only queries for browsing and the dashboard. Only allowlisted sort
// fields and filters are accepted; user text goes through bound parameters
// or toFtsQuery().

const { parseJson } = require("./db.cjs");
const { toFtsQuery } = require("./search.cjs");

// A lossy file under this bitrate is a "quality review suggested" signal,
// never a verdict (see docs/LIBRARY.md, Audio quality).
const LOW_BITRATE_KBPS = 160;

const TRACK_SORTS = {
  title: "t.title COLLATE NOCASE",
  artist: "t.artist COLLATE NOCASE",
  album: "t.album COLLATE NOCASE",
  genre: "t.genre COLLATE NOCASE",
  year: "t.year",
  duration: "t.duration_ms",
  bitrate: "f.bitrate",
  format: "f.codec",
  // When the song entered the WaveMint library (scan or import).
  added: "t.created_at",
  size: "f.size",
  favorite: "t.favorite",
  track: "t.disc_no, t.track_no",
};

const TRACK_COLUMNS = `
  t.id, t.title, t.artist, t.album_artist, t.album, t.release_id, t.track_no, t.track_total, t.disc_no,
  t.disc_total, t.year, t.genre, t.composer, t.compilation, t.duration_ms, t.review_status, t.quality_status,
  t.rating, t.favorite, t.tags_dirty, t.created_at,
  f.id AS file_id, f.codec, f.container, f.lossless, f.bitrate, f.sample_rate, f.bit_depth, f.size,
  f.status AS file_status, COALESCE(t.artwork_hash, f.artwork_hash) AS artwork_hash, f.source_id, s.name AS source_name, s.role AS source_role, s.read_only AS source_read_only,
  (SELECT COUNT(*) FROM files v WHERE v.track_id = t.id) AS version_count`;

const TRACK_FROM = `
  FROM tracks t
  LEFT JOIN files f ON f.id = t.active_file_id
  LEFT JOIN sources s ON s.id = f.source_id`;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

/** Builds WHERE clauses for track filters. */
function trackFilterSql(filters = {}, search = "") {
  const where = ["t.state = 'active'"];
  const params = [];

  const fts = toFtsQuery(search);
  if (fts) {
    where.push("t.id IN (SELECT rowid FROM track_search WHERE track_search MATCH ?)");
    params.push(fts);
  }

  if (filters.sourceId) {
    where.push("EXISTS (SELECT 1 FROM files sf WHERE sf.track_id = t.id AND sf.source_id = ?)");
    params.push(Number(filters.sourceId));
  }
  if (filters.releaseId) {
    where.push("t.release_id = ?");
    params.push(Number(filters.releaseId));
  }
  if (typeof filters.artist === "string") {
    where.push("t.artist_key = ?");
    params.push(filters.artist);
  }
  if (typeof filters.genre === "string") {
    where.push("t.genre = ? COLLATE NOCASE");
    params.push(filters.genre);
  }
  if (typeof filters.codec === "string") {
    where.push("f.codec = ?");
    params.push(filters.codec);
  }
  if (filters.lowBitrate) {
    where.push(`f.lossless = 0 AND f.bitrate > 0 AND f.bitrate < ${LOW_BITRATE_KBPS}`);
  }
  if (filters.missingArtwork) where.push("(t.artwork_hash IS NULL AND f.artwork_hash IS NULL)");
  if (filters.missingAlbum) where.push("t.album = ''");
  if (filters.missingAlbumArtist) where.push("t.album != '' AND t.album_artist = '' AND t.compilation = 0");
  if (filters.possibleDuplicates) {
    where.push(`t.title_key != '' AND EXISTS (SELECT 1 FROM tracks d WHERE d.state = 'active' AND d.id != t.id
      AND d.artist_key = t.artist_key AND d.title_key = t.title_key)`);
  }
  if (filters.missingFile) where.push("(f.id IS NULL OR f.status != 'ok')");
  if (filters.favorite) where.push("t.favorite = 1");
  if (typeof filters.reviewStatus === "string") {
    where.push("t.review_status = ?");
    params.push(filters.reviewStatus);
  }
  if (typeof filters.qualityStatus === "string") {
    where.push("t.quality_status = ?");
    params.push(filters.qualityStatus);
  }
  if (filters.multipleVersions) {
    where.push("(SELECT COUNT(*) FROM files v WHERE v.track_id = t.id) > 1");
  }
  if (Array.isArray(filters.ids)) {
    const ids = filters.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 5000);
    where.push(ids.length ? `t.id IN (${ids.map(() => "?").join(",")})` : "0");
    params.push(...ids);
  }

  return { where: where.join(" AND "), params };
}

function orderBy(sort, direction) {
  const dir = direction === "desc" ? "DESC" : "ASC";
  // Songs added together keep the order they were added in.
  if (sort === "added") return `t.created_at ${dir}, t.id ${dir}`;
  return `${TRACK_SORTS[sort] || TRACK_SORTS.artist} ${dir}, t.album COLLATE NOCASE, t.disc_no, t.track_no, t.id`;
}

function listTracks(db, { search = "", filters = {}, sort = "artist", direction = "asc", offset = 0, limit = 200 } = {}) {
  const { where, params } = trackFilterSql(filters, search);
  const safeLimit = clampInt(limit, 1, 1000, 200);
  const safeOffset = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);

  const total = db.prepare(`SELECT COUNT(*) AS n ${TRACK_FROM} WHERE ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT ${TRACK_COLUMNS} ${TRACK_FROM} WHERE ${where}
       ORDER BY ${orderBy(sort, direction)}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, safeLimit, safeOffset);

  return { total, offset: safeOffset, rows };
}

/** IDs only, in list order (bulk actions, and playing a whole list). */
function listTrackIds(db, { search = "", filters = {}, sort = "artist", direction = "asc" } = {}) {
  const { where, params } = trackFilterSql(filters, search);
  return db
    .prepare(`SELECT t.id ${TRACK_FROM} WHERE ${where} ORDER BY ${orderBy(sort, direction)} LIMIT 50000`)
    .all(...params)
    .map((row) => row.id);
}

function listAlbums(db, { search = "", sort = "artist", offset = 0, limit = 200, filters = {} } = {}) {
  const where = ["EXISTS (SELECT 1 FROM tracks t WHERE t.release_id = r.id AND t.state = 'active')"];
  const params = [];
  const text = String(search || "").trim();
  if (text) {
    where.push("(r.title LIKE ? ESCAPE '\\' OR r.album_artist LIKE ? ESCAPE '\\')");
    const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(like, like);
  }
  if (typeof filters.artist === "string") {
    where.push("(r.artist_key = ? OR EXISTS (SELECT 1 FROM tracks t2 WHERE t2.release_id = r.id AND t2.artist_key = ?))");
    params.push(filters.artist, filters.artist);
  }
  if (typeof filters.genre === "string") {
    where.push("EXISTS (SELECT 1 FROM tracks t3 WHERE t3.release_id = r.id AND t3.genre = ? COLLATE NOCASE AND t3.state = 'active')");
    params.push(filters.genre);
  }

  const orders = {
    artist: "r.album_artist COLLATE NOCASE, r.year, r.title COLLATE NOCASE",
    title: "r.title COLLATE NOCASE",
    year: "r.year DESC, r.title COLLATE NOCASE",
    added: "r.created_at DESC",
  };

  const total = db.prepare(`SELECT COUNT(*) AS n FROM releases r WHERE ${where.join(" AND ")}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT r.id, r.title, r.album_artist, r.year, r.edition, r.release_type, r.mb_release_id,
              COALESCE(r.artwork_hash,
                (SELECT COALESCE(t.artwork_hash, f.artwork_hash) FROM tracks t JOIN files f ON f.id = t.active_file_id
                 WHERE t.release_id = r.id AND t.state = 'active' AND COALESCE(t.artwork_hash, f.artwork_hash) IS NOT NULL LIMIT 1)) AS artwork_hash,
              (SELECT COUNT(*) FROM tracks t WHERE t.release_id = r.id AND t.state = 'active') AS track_count,
              (SELECT SUM(t.duration_ms) FROM tracks t WHERE t.release_id = r.id AND t.state = 'active') AS duration_ms,
              (SELECT GROUP_CONCAT(DISTINCT t.genre) FROM tracks t WHERE t.release_id = r.id AND t.state = 'active' AND t.genre != '') AS genres
       FROM releases r WHERE ${where.join(" AND ")}
       ORDER BY ${orders[sort] || orders.artist} LIMIT ? OFFSET ?`,
    )
    .all(...params, clampInt(limit, 1, 1000, 200), clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0));

  return { total, rows };
}

function getAlbum(db, id) {
  return (
    db
      .prepare(
        `SELECT r.*,
                COALESCE(r.artwork_hash,
                  (SELECT COALESCE(t.artwork_hash, f.artwork_hash) FROM tracks t JOIN files f ON f.id = t.active_file_id
                   WHERE t.release_id = r.id AND t.state = 'active' AND COALESCE(t.artwork_hash, f.artwork_hash) IS NOT NULL LIMIT 1)) AS artwork_hash,
                (SELECT COUNT(*) FROM tracks t WHERE t.release_id = r.id AND t.state = 'active') AS track_count,
                (SELECT SUM(t.duration_ms) FROM tracks t WHERE t.release_id = r.id AND t.state = 'active') AS duration_ms,
                (SELECT GROUP_CONCAT(DISTINCT t.genre) FROM tracks t WHERE t.release_id = r.id AND t.state = 'active' AND t.genre != '') AS genres
         FROM releases r WHERE r.id = ?`,
      )
      .get(Number(id)) || null
  );
}

function listArtists(db, { search = "", offset = 0, limit = 500 } = {}) {
  const params = [];
  let filter = "";
  const text = String(search || "").trim();
  if (text) {
    filter = "AND t.artist LIKE ? ESCAPE '\\'";
    params.push(`%${text.replace(/[\\%_]/g, "\\$&")}%`);
  }

  const total = db
    .prepare(`SELECT COUNT(DISTINCT t.artist_key) AS n FROM tracks t WHERE t.state = 'active' AND t.artist_key != '' ${filter}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT t.artist_key AS key,
              (SELECT t2.artist FROM tracks t2 WHERE t2.artist_key = t.artist_key AND t2.state = 'active'
               GROUP BY t2.artist ORDER BY COUNT(*) DESC LIMIT 1) AS name,
              COUNT(*) AS track_count,
              COUNT(DISTINCT t.release_id) AS album_count,
              (SELECT COALESCE(t3.artwork_hash, f.artwork_hash) FROM tracks t3 JOIN files f ON f.id = t3.active_file_id
               WHERE t3.artist_key = t.artist_key AND COALESCE(t3.artwork_hash, f.artwork_hash) IS NOT NULL LIMIT 1) AS artwork_hash
       FROM tracks t WHERE t.state = 'active' AND t.artist_key != '' ${filter}
       GROUP BY t.artist_key ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    )
    .all(...params, clampInt(limit, 1, 2000, 500), clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0));
  return { total, rows };
}

function listGenres(db) {
  return db
    .prepare(
      `SELECT t.genre AS name, COUNT(*) AS track_count, COUNT(DISTINCT t.artist_key) AS artist_count
       FROM tracks t WHERE t.state = 'active'
       GROUP BY t.genre COLLATE NOCASE ORDER BY (t.genre = '') DESC, t.genre COLLATE NOCASE`,
    )
    .all();
}

function getTrack(db, id) {
  const track = db
    .prepare(`SELECT t.*, r.title AS release_title, r.album_artist AS release_artist, r.year AS release_year,
                     r.edition AS release_edition, r.release_type
              FROM tracks t LEFT JOIN releases r ON r.id = t.release_id WHERE t.id = ?`)
    .get(Number(id));
  if (!track) return null;

  const files = db
    .prepare(
      `SELECT f.id, f.path, f.rel_path, f.ext, f.size, f.mtime_ms, f.container, f.codec, f.lossless, f.bitrate,
              f.sample_rate, f.bit_depth, f.channels, f.duration_ms, f.artwork_hash, f.artwork_count, f.status,
              f.role, f.read_error, f.first_seen_at, f.tag_snapshot, f.content_hash,
              s.id AS source_id, s.name AS source_name, s.role AS source_role, s.read_only AS source_read_only,
              s.status AS source_status
       FROM files f JOIN sources s ON s.id = f.source_id
       WHERE f.track_id = ? ORDER BY (f.id = ?) DESC, s.priority DESC, f.id`,
    )
    .all(track.id, track.active_file_id || 0)
    .map((file) => ({ ...file, tag_snapshot: parseJson(file.tag_snapshot, null) }));

  return { ...track, curated_fields: parseJson(track.curated_fields, []), files };
}

function listSources(db) {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id) AS file_count,
              (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id AND f.status = 'missing') AS missing_count,
              (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id AND f.status = 'unreadable') AS unreadable_count,
              (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.source_id = s.id AND f.status = 'ok') AS total_size
       FROM sources s ORDER BY s.priority DESC, s.name COLLATE NOCASE`,
    )
    .all()
    .map((source) => ({ ...source, last_scan_stats: parseJson(source.last_scan_stats, null) }));
}

/** Small counts for navigation badges (cheap; called after every change). */
function getStatus(db) {
  const unsaved = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tracks t
       JOIN files f ON f.id = t.active_file_id JOIN sources s ON s.id = f.source_id
       WHERE t.state = 'active' AND t.tags_dirty = 1 AND s.read_only = 0 AND f.status = 'ok'
         AND f.ext IN ('.mp3', '.m4a', '.m4b', '.flac')`,
    )
    .get().n;
  const review = db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE status IN ('needs_review', 'suggested')").get().n;
  const sources = db.prepare("SELECT COUNT(*) AS n FROM sources").get().n;
  const qualityAttention = db
    .prepare("SELECT COUNT(*) AS n FROM tracks WHERE state = 'active' AND quality_status IN ('user_marked_poor', 'upgrade_available')")
    .get().n;
  const tracks = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE state = 'active'").get().n;
  return { unsavedWritable: unsaved, reviewOpen: review, qualityAttention, sources, tracks };
}

function getDashboard(db) {
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const totals = one(`
    SELECT COUNT(*) AS tracks,
           COUNT(DISTINCT t.release_id) AS albums,
           COUNT(DISTINCT NULLIF(t.artist_key, '')) AS artists,
           COUNT(DISTINCT NULLIF(LOWER(t.genre), '')) AS genres,
           COALESCE(SUM(t.duration_ms), 0) AS duration_ms,
           COALESCE(SUM(f.size), 0) AS active_size
    FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id
    WHERE t.state = 'active'`);

  // What the collection is made of. File formats and sources stay out of
  // the overview (Sources and Quality show them).
  const genres = db
    .prepare(
      `SELECT CASE WHEN t.genre = '' THEN '' ELSE MIN(t.genre) END AS name, COUNT(*) AS count,
              COUNT(DISTINCT NULLIF(t.artist_key, '')) AS artists, COALESCE(SUM(t.duration_ms), 0) AS duration_ms
       FROM tracks t WHERE t.state = 'active'
       GROUP BY LOWER(t.genre) ORDER BY (t.genre = ''), count DESC LIMIT 200`,
    )
    .all();

  const recent = db
    .prepare(`SELECT ${TRACK_COLUMNS} ${TRACK_FROM} WHERE t.state = 'active' ORDER BY t.created_at DESC, t.id DESC LIMIT 18`)
    .all();

  const topArtists = db
    .prepare(
      `SELECT t.artist_key AS key,
              (SELECT t2.artist FROM tracks t2 WHERE t2.artist_key = t.artist_key AND t2.state = 'active'
               GROUP BY t2.artist ORDER BY COUNT(*) DESC LIMIT 1) AS name,
              COUNT(*) AS track_count, COUNT(DISTINCT t.release_id) AS album_count,
              (SELECT COALESCE(t3.artwork_hash, f.artwork_hash) FROM tracks t3 JOIN files f ON f.id = t3.active_file_id
               WHERE t3.artist_key = t.artist_key AND t3.state = 'active' AND COALESCE(t3.artwork_hash, f.artwork_hash) IS NOT NULL LIMIT 1) AS artwork_hash
       FROM tracks t WHERE t.state = 'active' AND t.artist_key != ''
       GROUP BY t.artist_key ORDER BY track_count DESC, name COLLATE NOCASE LIMIT 8`,
    )
    .all();

  const favorites = one("SELECT COUNT(*) AS n FROM tracks WHERE state = 'active' AND favorite = 1").n;

  const issues = one(`
    SELECT
      SUM(CASE WHEN t.album = '' THEN 1 ELSE 0 END) AS missing_album,
      SUM(CASE WHEN t.artist = '' THEN 1 ELSE 0 END) AS missing_artist,
      SUM(CASE WHEN t.genre = '' THEN 1 ELSE 0 END) AS missing_genre,
      SUM(CASE WHEN t.album != '' AND t.album_artist = '' AND t.compilation = 0 THEN 1 ELSE 0 END) AS missing_album_artist,
      SUM(CASE WHEN t.artwork_hash IS NULL AND f.artwork_hash IS NULL THEN 1 ELSE 0 END) AS missing_artwork,
      SUM(CASE WHEN f.id IS NULL OR f.status != 'ok' THEN 1 ELSE 0 END) AS missing_files,
      SUM(CASE WHEN f.lossless = 0 AND f.bitrate > 0 AND f.bitrate < ${LOW_BITRATE_KBPS} THEN 1 ELSE 0 END) AS low_bitrate,
      SUM(CASE WHEN t.review_status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
      SUM(CASE WHEN t.quality_status IN ('user_marked_poor', 'upgrade_available') THEN 1 ELSE 0 END) AS upgrade_queue,
      SUM(CASE WHEN t.tags_dirty = 1 THEN 1 ELSE 0 END) AS unsaved_tags,
      SUM(CASE WHEN t.tags_dirty = 1 AND s.read_only = 0 AND f.status = 'ok'
               AND f.ext IN ('.mp3', '.m4a', '.m4b', '.flac') THEN 1 ELSE 0 END) AS unsaved_writable
    FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id LEFT JOIN sources s ON s.id = f.source_id
    WHERE t.state = 'active'`);

  // Same artist + title (including version markers) more than once. These
  // are candidates only; matching decides what is really the same recording.
  const duplicates = one(`
    SELECT COUNT(*) AS groups, COALESCE(SUM(n), 0) AS tracks FROM (
      SELECT COUNT(*) AS n FROM tracks
      WHERE state = 'active' AND title_key != '' AND artist_key != ''
      GROUP BY artist_key, title_key HAVING COUNT(*) > 1)`);

  return {
    totals: { ...totals, favorites },
    genres,
    recent,
    topArtists,
    issues: Object.fromEntries(Object.entries(issues).map(([key, value]) => [key, value || 0])),
    duplicates,
    sourceCount: one("SELECT COUNT(*) AS n FROM sources").n,
    lowBitrateKbps: LOW_BITRATE_KBPS,
  };
}

module.exports = {
  LOW_BITRATE_KBPS,
  getAlbum,
  getDashboard,
  getStatus,
  getTrack,
  listAlbums,
  listArtists,
  listGenres,
  listSources,
  listTrackIds,
  listTracks,
  trackFilterSql,
};
