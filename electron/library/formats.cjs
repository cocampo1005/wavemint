// Audio formats in the library: what each song's file actually is (the codec
// read from the audio stream, not just its extension), how the library
// breaks down by format, whether iTunes can play a file as it is, and the
// files WaveMint can no longer find.
//
// Everything here works from the library database (filled by scans and kept
// current by every operation that adds, replaces or removes files), so
// nothing is re-read from disk to show the statistics.

const fs = require("fs");
const path = require("path");
const { nowIso, transaction } = require("./db.cjs");
const { pathKey } = require("./normalize.cjs");
const { readTags } = require("./tags.cjs");

const FORMAT_LABELS = { mp3: "MP3", aac: "AAC", alac: "Apple Lossless (ALAC)", flac: "FLAC", pcm: "WAV / AIFF" };
// iTunes plays these as they are, in these containers.
const DIRECT = { mp3: [".mp3"], aac: [".m4a", ".m4b", ".mp4"], alac: [".m4a", ".m4b", ".mp4"] };
const PCM_EXTS = [".wav", ".aif", ".aiff"];

const formatLabel = (codec) => FORMAT_LABELS[codec] || (codec ? codec.toUpperCase() : "Unknown");

/**
 * How iTunes can use a file: "direct" (as it is), "convert" (lossless to
 * Apple Lossless, kept in the compatibility cache) or "unsupported", with a
 * reason. Lossy audio is never converted to another lossy format.
 */
function appleCompatibility({ codec, ext }, { convertWavAiff = true } = {}) {
  const kind = String(codec || "").toLowerCase();
  const extension = String(ext || "").toLowerCase();
  if (DIRECT[kind]) {
    if (DIRECT[kind].includes(extension)) return { mode: "direct", format: kind };
    if (kind === "aac" && extension === ".aac") return { mode: "unsupported", format: kind, reason: "Raw AAC (.aac) files need an .m4a container for iTunes" };
    return { mode: "unsupported", format: kind, reason: `The ${extension || "file"} extension doesn't match its ${formatLabel(kind)} audio` };
  }
  if (kind === "flac") return { mode: "convert", format: "alac", reason: "iTunes can't play FLAC: converted to Apple Lossless (no quality loss)" };
  if (kind === "pcm" || PCM_EXTS.includes(extension)) {
    return convertWavAiff
      ? { mode: "convert", format: "alac", reason: "WAV/AIFF converted to Apple Lossless so tags and artwork travel" }
      : { mode: "direct", format: "pcm" };
  }
  return { mode: "unsupported", format: kind || null, reason: `${kind ? formatLabel(kind) : "This format"} isn't supported by iTunes` };
}

/** The library by format: the current file of every song in the library. */
function formatStats(db, { convertWavAiff = true } = {}) {
  const rows = db
    .prepare(
      `SELECT COALESCE(f.codec, '') AS codec, f.ext, f.status, COUNT(*) AS files, COALESCE(SUM(f.size), 0) AS bytes
       FROM tracks t JOIN files f ON f.id = t.active_file_id
       WHERE t.state = 'active'
       GROUP BY f.codec, f.ext, f.status`,
    )
    .all();
  const byCodec = new Map();
  const apple = { direct: 0, convert: 0, unsupported: 0, missing: 0 };
  for (const row of rows) {
    const key = row.codec || "unknown";
    const entry = byCodec.get(key) || { codec: row.codec || null, label: formatLabel(row.codec), files: 0, bytes: 0, missing: 0, extensions: {} };
    entry.files += row.files;
    entry.bytes += row.bytes;
    if (row.status !== "ok") entry.missing += row.files;
    entry.extensions[row.ext] = (entry.extensions[row.ext] || 0) + row.files;
    byCodec.set(key, entry);
    if (row.status !== "ok") apple.missing += row.files;
    else apple[appleCompatibility(row, { convertWavAiff }).mode] += row.files;
  }
  const totalFiles = [...byCodec.values()].reduce((sum, entry) => sum + entry.files, 0);
  const totalBytes = [...byCodec.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const formats = [...byCodec.values()]
    .sort((a, b) => b.files - a.files)
    .map((entry) => ({
      ...entry,
      extensions: Object.entries(entry.extensions)
        .sort((a, b) => b[1] - a[1])
        .map(([ext, files]) => ({ ext, files })),
      fileShare: totalFiles ? entry.files / totalFiles : 0,
      byteShare: totalBytes ? entry.bytes / totalBytes : 0,
      lossless: ["alac", "flac", "pcm"].includes(entry.codec),
    }));

  // What else is on disk for the library: earlier versions, and files of
  // songs that are no longer in the library.
  const other = db
    .prepare(
      `SELECT CASE WHEN f.role = 'archived' OR (t.state = 'active' AND f.id != t.active_file_id) THEN 'versions' ELSE 'removed' END AS kind,
              COUNT(*) AS files, COALESCE(SUM(f.size), 0) AS bytes
       FROM files f LEFT JOIN tracks t ON t.id = f.track_id
       WHERE NOT (t.state = 'active' AND f.id = t.active_file_id)
       GROUP BY kind`,
    )
    .all();
  const kept = Object.fromEntries(other.map((row) => [row.kind, { files: row.files, bytes: row.bytes }]));
  return {
    totalFiles,
    totalBytes,
    formats,
    apple,
    earlierVersions: kept.versions || { files: 0, bytes: 0 },
    removedSongs: kept.removed || { files: 0, bytes: 0 },
  };
}

// --- missing files --------------------------------------------------------------

function sourceAvailable(source) {
  try {
    return !!source?.root_path && fs.statSync(source.root_path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file WaveMint expects but can't find (or read), with what it belongs
 * to, why it is reported, whether it is back or another copy exists, and
 * which repairs are safe. Besides what the last scan found, every file the
 * scan last saw is checked for still being at its path (a quick existence
 * check, nothing is read), so a moved file shows up, and can be located,
 * before a rescan would add it again as a new song.
 */
function listMissingFiles(db) {
  // Files of available folders that are no longer at their path since the last scan.
  const vanished = db
    .prepare("SELECT f.id, f.path, s.root_path FROM files f JOIN sources s ON s.id = f.source_id WHERE f.status = 'ok'")
    .all()
    .filter((row) => sourceAvailable(row) && !fs.existsSync(row.path))
    .map((row) => row.id);
  const rows = db
    .prepare(
      `SELECT f.id AS fileId, f.path, f.rel_path, f.ext, f.size, f.status, f.role, f.read_error, f.last_seen_at, f.source_id,
              s.name AS sourceName, s.root_path AS sourceRoot,
              t.id AS trackId, t.title, t.artist, t.album, t.state AS trackState, t.active_file_id, t.title_key, t.artist_key, t.updated_at AS trackUpdatedAt,
              (SELECT title FROM tracks WHERE id = t.merged_into) AS mergedInto
       FROM files f LEFT JOIN sources s ON s.id = f.source_id LEFT JOIN tracks t ON t.id = f.track_id
       WHERE f.status != 'ok' OR f.id IN (${vanished.map(() => "?").join(",") || "NULL"})
       ORDER BY (t.state = 'active' AND f.id = t.active_file_id) DESC, t.artist COLLATE NOCASE, t.title COLLATE NOCASE`,
    )
    .all(...vanished);
  const sameName = db.prepare("SELECT f.path, t.title, t.state FROM files f LEFT JOIN tracks t ON t.id = f.track_id WHERE f.status = 'ok' AND f.id != ? AND lower(f.path) LIKE ? LIMIT 20");
  const sameSong = db.prepare(
    `SELECT t.id, t.title, t.artist, f.path FROM tracks t JOIN files f ON f.id = t.active_file_id
     WHERE t.state = 'active' AND t.id != ? AND t.title_key = ? AND t.artist_key = ? AND f.status = 'ok' LIMIT 5`,
  );

  return rows.map((row) => {
    const current = row.trackState === "active" && row.active_file_id === row.fileId;
    const available = sourceAvailable({ root_path: row.sourceRoot });
    const back = fs.existsSync(row.path);
    let reason;
    const sinceScan = row.status === "ok";
    if (back) reason = "The file is back at this path. Rescan the library folder to use it again.";
    else if (sinceScan) reason = "The file isn't at this path anymore: it was moved, renamed or deleted since the last scan. Locate it before rescanning, so it stays the same song.";
    else if (!available) reason = `Its library folder "${row.sourceName || "?"}" isn't available (is the drive connected?).`;
    else if (row.status === "unreadable") reason = `The file can't be read${row.read_error ? `: ${row.read_error}` : ""}.`;
    else reason = "The file was moved, renamed or deleted outside WaveMint.";

    // What kind of problem this is. Only a song's current file is a problem to
    // solve; a leftover reference (a removed or merged song, an earlier version
    // whose file was cleaned up) is just something WaveMint can forget.
    let kind;
    if (!current) kind = row.trackState === "active" ? "earlier" : "leftover";
    else if (back) kind = "back";
    else if (sinceScan) kind = "moved";
    else if (!available) kind = "drive";
    else kind = row.status === "unreadable" ? "unreadable" : "missing";

    let belongsTo;
    if (!row.trackId) belongsTo = "A file that no longer belongs to any song.";
    else if (current) belongsTo = "This song's current file.";
    else if (row.trackState === "removed") belongsTo = "A song you removed from the library: this is a leftover reference.";
    else if (row.trackState === "merged") belongsTo = `A song merged into "${row.mergedInto || "another song"}": a leftover reference.`;
    else belongsTo = "An earlier version of the song, kept after an upgrade or edit.";

    // Another file with the same name (a wildcard in the name only widens the search; names are compared exactly).
    const name = path.basename(row.path).toLowerCase();
    const elsewhere = sameName
      .all(row.fileId, `%${name}`)
      .filter((entry) => path.basename(entry.path).toLowerCase() === name && fs.existsSync(entry.path))
      .slice(0, 5);
    const copies = row.trackId && row.title_key ? sameSong.all(row.trackId, row.title_key, row.artist_key) : [];
    return {
      fileId: row.fileId,
      kind,
      trackId: row.trackId,
      title: row.title,
      artist: row.artist,
      album: row.album,
      path: row.path,
      status: row.status === "ok" ? "missing" : row.status,
      sinceScan: row.status === "ok",
      sourceName: row.sourceName,
      lastSeenAt: row.last_seen_at,
      current,
      reason,
      belongsTo,
      backAtPath: back,
      elsewhere: elsewhere.map((entry) => ({ path: entry.path, title: entry.title, inLibrary: entry.state === "active" })),
      otherCopies: copies.map((entry) => ({ trackId: entry.id, title: entry.title, artist: entry.artist, path: entry.path })),
      // A stale reference (not the current file of a song in the library) can be forgotten.
      canForget: !current,
    };
  });
}

/**
 * Forgets a file reference WaveMint can't find, in the database only. Only
 * for stale references: never a song's current file (remove the song or
 * replace its file instead). Nothing on disk changes.
 */
function forgetMissingFile(db, { fileId }) {
  const row = db.prepare("SELECT f.id, f.status, f.path, t.state, t.active_file_id FROM files f LEFT JOIN tracks t ON t.id = f.track_id WHERE f.id = ?").get(Number(fileId));
  if (!row) throw new Error("That file reference no longer exists.");
  if (fs.existsSync(row.path)) throw new Error(row.status === "ok" ? "WaveMint can find this file, so its reference is kept." : "The file is back at its path. Rescan the library folder instead.");
  if (row.state === "active" && row.active_file_id === row.id) throw new Error("This is the song's current file. Replace the file or remove the song instead.");
  transaction(db, () => {
    db.prepare("UPDATE tracks SET active_file_id = NULL WHERE active_file_id = ?").run(row.id);
    db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
  });
  return { forgotten: true };
}

/**
 * Forgets several leftover references at once (Review → Diagnostics, "Forget
 * All"): only references that aren't a song's current file and whose file is
 * still gone. Database only: nothing on disk is touched.
 */
function forgetLeftoverReferences(db, { fileIds }) {
  let forgotten = 0;
  const skipped = [];
  for (const fileId of fileIds) {
    try {
      forgetMissingFile(db, { fileId });
      forgotten += 1;
    } catch (error) {
      skipped.push({ fileId: Number(fileId), reason: error.message });
    }
  }
  return { forgotten, skipped };
}

/**
 * Points a missing file's reference at the file the user found (chosen in a
 * main-process dialog). It must be an audio file of the same type inside a
 * library folder that WaveMint isn't already tracking.
 */
function relinkMissingFile(db, { fileId, filePath }) {
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(Number(fileId));
  if (!row) throw new Error("That file reference no longer exists.");
  if (row.status === "ok" && fs.existsSync(row.path)) throw new Error("WaveMint can already find this file.");
  const resolved = path.resolve(String(filePath || ""));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("That file isn't available.");
  if (path.extname(resolved).toLowerCase() !== row.ext) throw new Error(`Choose a ${row.ext} file: the reference is for that kind of file.`);
  const key = pathKey(resolved);
  const source = db
    .prepare("SELECT id, root_path FROM sources")
    .all()
    .find((item) => key.startsWith(`${pathKey(item.root_path)}\\`));
  if (!source) throw new Error("Choose a file inside one of your library folders.");
  const taken = db.prepare("SELECT id FROM files WHERE path_key = ? AND id != ?").get(key, row.id);
  if (taken) throw new Error("WaveMint already tracks that file (it belongs to another song or version).");

  const stat = fs.statSync(resolved);
  let tags = null;
  try {
    tags = readTags(resolved, { size: stat.size });
  } catch {
    tags = null;
  }
  db.prepare(
    `UPDATE files SET path = ?, path_key = ?, rel_path = ?, source_id = ?, size = ?, mtime_ms = ?, quick_sig = NULL, content_hash = NULL, audio_hash = NULL,
       codec = COALESCE(?, codec), status = 'ok', read_error = NULL, last_seen_at = ? WHERE id = ?`,
  ).run(resolved, key, path.relative(source.root_path, resolved), source.id, stat.size, Math.round(stat.mtimeMs), tags?.codec || null, nowIso(), row.id);
  return { relinked: true, path: resolved, sizeChanged: stat.size !== row.size };
}

// --- genres stored as numeric codes ------------------------------------------------

/**
 * The raw genre text of an MP3's ID3v2 tag (TCON), read straight from the
 * bytes: tag libraries translate "(145)" into "Anime" when reading, which hides
 * how the genre is actually stored. Null when there is no ID3v2 tag.
 */
function rawId3Genre(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(10);
    if (fs.readSync(fd, head, 0, 10, 0) < 10 || head.toString("latin1", 0, 3) !== "ID3") return null;
    const version = head[3];
    const syncsafe = (bytes, at) => ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
    const buffer = Buffer.alloc(Math.min(syncsafe(head, 6), 8 * 1024 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, 10);
    for (let offset = 0; offset + 10 <= buffer.length; ) {
      const id = buffer.toString("latin1", offset, offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const length = version === 4 ? syncsafe(buffer, offset + 4) : buffer.readUInt32BE(offset + 4);
      if (id === "TCON") {
        const body = buffer.subarray(offset + 10, offset + 10 + length);
        const text = body[0] === 1 || body[0] === 2 ? body.subarray(1).toString("utf16le") : body[0] === 3 ? body.subarray(1).toString("utf8") : body.subarray(1).toString("latin1");
        return text.split(String.fromCharCode(0)).join("").split(String.fromCharCode(0xfeff)).join("").trim();
      }
      offset += 10 + length;
    }
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Songs whose MP3 stores its genre as an ID3v1 number ("(145)" or "145")
 * instead of text. iTunes names codes 0–125 and shows higher ones as numbers;
 * bare numbers aren't standard ID3v2.3 at all. Rewriting the song's tags
 * (Write Tags) stores the genre as text. Read-only.
 */
async function numericGenreScan(db, { signal, progress } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.genre, f.path FROM tracks t JOIN files f ON f.id = t.active_file_id
       WHERE t.state = 'active' AND f.ext = '.mp3' AND f.status = 'ok' ORDER BY t.artist COLLATE NOCASE, t.title COLLATE NOCASE`,
    )
    .all();
  const found = [];
  let unreadable = 0;
  for (const [index, row] of rows.entries()) {
    if (signal?.aborted) break;
    if (index % 200 === 0) {
      progress?.({ phase: "checking", done: index, total: rows.length });
      await new Promise((resolve) => setImmediate(resolve));
    }
    let raw;
    try {
      raw = rawId3Genre(row.path);
    } catch {
      unreadable += 1;
      continue;
    }
    const match = raw && (/^\((\d+)\)/.exec(raw) || /^(\d+)$/.exec(raw));
    if (!match) continue;
    const code = Number(match[1]);
    found.push({ trackId: row.id, title: row.title, artist: row.artist, genre: row.genre, stored: raw, itunesShowsNumber: code > 125, nonStandard: !raw.startsWith("(") });
  }
  return {
    checked: rows.length,
    unreadable,
    numeric: found.length,
    shownAsNumbers: found.filter((item) => item.itunesShowsNumber).length,
    nonStandard: found.filter((item) => item.nonStandard).length,
    trackIds: found.map((item) => item.trackId),
    songs: found.slice(0, 500),
  };
}

module.exports = {
  FORMAT_LABELS, appleCompatibility, numericGenreScan, rawId3Genre, forgetLeftoverReferences, forgetMissingFile, formatLabel, formatStats, listMissingFiles, relinkMissingFile };
