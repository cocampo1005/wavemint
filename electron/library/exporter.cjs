// Prepare for iPhone: a stable export folder for Apple Music / iTunes.
//
// WaveMint never talks to the iPhone or edits Apple's library. It keeps a
// folder of finished files (curated tags and artwork written in) that the
// user imports into Apple Music / iTunes, which then syncs the iPhone:
//
//   - formats Apple's apps play (MP3, AAC, Apple Lossless) are copied as
//     they are; FLAC is converted to Apple Lossless (lossless, required);
//     WAV/AIFF optionally too (so tags travel). Never lossy to lossy.
//   - each song keeps its path in the folder across exports; unchanged
//     songs aren't copied again; songs whose file or details changed are
//     refreshed, and the report says what to refresh in Apple Music;
//   - a manifest, a report and M3U8 playlists are written alongside;
//   - optionally, new and changed files are copied into Apple's
//     "Automatically Add to iTunes/Music" folder (Apple's own import path).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { nowIso, parseJson } = require("./db.cjs");
const { TAG_FIELDS, freeBytes } = require("./consolidate.cjs");
const { siblingPath } = require("./fileops.cjs");
const { pathKey } = require("./normalize.cjs");
const { DEFAULT_PATTERN, planPaths, safeSegment } = require("./organize.cjs");
const { m3u8For, playlistTracks } = require("./playlists.cjs");
const { canWriteTags, writeTags } = require("./tags.cjs");

const APPLE_CODECS = new Set(["mp3", "aac", "alac"]);
const NEEDS_ALAC = new Set(["flac"]);
const OPTIONAL_ALAC = new Set(["pcm", "wav", "aiff"]);
const MUSIC_DIR = "Music";
const AUTO_ADD = /^Automatically Add to (?:iTunes|Music|Apple Music)$/i;

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function createExporter({ db, media, artStore, getSettings = () => ({}), logger = console }) {
  function checkRoot(root) {
    const resolved = path.resolve(String(root || ""));
    if (!root || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("Choose an export folder first.");
    // The export folder must not overlap a library source (it would be scanned).
    const key = pathKey(resolved);
    for (const source of db.prepare("SELECT name, root_path FROM sources").all()) {
      const other = pathKey(source.root_path);
      if (key === other || key.startsWith(`${other}\\`) || other.startsWith(`${key}\\`)) {
        throw new Error(`The export folder can't overlap "${source.name}". Choose a separate folder.`);
      }
    }
    return resolved;
  }

  /** Song IDs for a scope: everything, songs, playlists, genres or albums. */
  function scopeTrackIds(scope = {}) {
    const ids = new Set();
    if (scope.all) for (const row of db.prepare("SELECT id FROM tracks WHERE state = 'active'").all()) ids.add(row.id);
    for (const id of scope.trackIds || []) ids.add(Number(id));
    for (const id of scope.playlistIds || []) for (const row of playlistTracks(db, id)) ids.add(row.id);
    for (const genre of scope.genres || []) {
      for (const row of db.prepare("SELECT id FROM tracks WHERE state = 'active' AND genre = ? COLLATE NOCASE").all(genre)) ids.add(row.id);
    }
    for (const releaseId of scope.releaseIds || []) {
      for (const row of db.prepare("SELECT id FROM tracks WHERE state = 'active' AND release_id = ?").all(Number(releaseId))) ids.add(row.id);
    }
    return [...ids];
  }

  function metaSig(track) {
    return sha1(JSON.stringify([...TAG_FIELDS.map(([, def]) => track[def.column] ?? null), track.artwork_hash || null]));
  }

  /** What exporting the scope would do. Nothing is written. */
  function plan({ root, scope, options = {} }) {
    const resolved = checkRoot(root);
    const rootKey = pathKey(resolved);
    const convertPcm = options.convertWavAiff !== false;
    const ids = scopeTrackIds(scope);
    const state = new Map(db.prepare("SELECT * FROM export_state WHERE root_key = ?").all(rootKey).map((row) => [row.track_id, row]));
    const takenByOthers = new Set([...state.values()].map((row) => row.rel_path.toLowerCase()));
    const pattern = getSettings().namingPattern || DEFAULT_PATTERN;

    const tracks = ids.length
      ? db
          .prepare(
            `SELECT t.*, COALESCE(t.artwork_hash, f.artwork_hash) AS effective_art, f.id AS file_id, f.path, f.ext, f.size, f.mtime_ms,
                    f.codec, f.lossless, f.bitrate, f.status AS file_status
             FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id
             WHERE t.state = 'active' AND t.id IN (${ids.map(() => "?").join(",")})
             ORDER BY t.album_artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no`,
          )
          .all(...ids)
      : [];

    const items = [];
    const fresh = [];
    for (const track of tracks) {
      const problems = [];
      const warnings = [];
      if (!track.file_id || track.file_status !== "ok") problems.push(track.file_status === "missing" ? "The file is missing" : "The file can't be read");
      const codec = String(track.codec || "").toLowerCase();
      let action = "copy";
      if (NEEDS_ALAC.has(codec)) action = "convert";
      else if (OPTIONAL_ALAC.has(codec) || [".wav", ".aif", ".aiff"].includes(track.ext)) action = convertPcm ? "convert" : "copy";
      else if (!APPLE_CODECS.has(codec)) problems.push(`${codec || "This format"} isn't supported by Apple Music`);
      if (!track.title) warnings.push("No title");
      if (!track.artist) warnings.push("No artist");
      if (!track.album) warnings.push("No album");
      if (!track.effective_art) warnings.push("No artwork");
      const ext = action === "convert" ? ".m4a" : track.ext;
      const format = action === "convert" ? "alac" : codec;
      const previous = state.get(track.id);
      const fileSig = `${track.file_id}:${track.size}:${Math.round(track.mtime_ms || 0)}`;
      const sig = metaSig({ ...track, artwork_hash: track.artwork_hash });
      let status = "new";
      if (previous) {
        const missing = !fs.existsSync(path.join(resolved, previous.rel_path));
        if (missing) status = "new";
        else if (previous.file_sig !== fileSig || previous.format !== format) status = "replace";
        else if (previous.meta_sig !== sig) status = "refresh";
        else status = "unchanged";
      }
      const item = {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        format,
        action,
        status: problems.length ? "problem" : status,
        problems,
        warnings,
        size: track.size || 0,
        sourcePath: track.path,
        fileSig,
        metaSig: sig,
        track,
        ext,
        relPath: previous && path.extname(previous.rel_path).toLowerCase() === ext ? previous.rel_path : null,
        previousRelPath: previous?.rel_path || null,
      };
      if (!item.relPath && !problems.length) fresh.push(item);
      items.push(item);
    }

    // New paths (stable from then on), unique among everything exported.
    const planned = planPaths(
      fresh.map((item) => ({ track: item.track, ext: item.ext, item })),
      { root: path.join(resolved, MUSIC_DIR), pattern, exists: (target) => fs.existsSync(target) || takenByOthers.has(path.relative(resolved, target).toLowerCase()) },
    );
    for (const entry of planned) entry.item.relPath = path.join(MUSIC_DIR, entry.relPath);

    const selected = new Set(ids);
    const removed = [...state.values()]
      .filter((row) => !selected.has(row.track_id) || !tracks.some((track) => track.id === row.track_id))
      .map((row) => ({ trackId: row.track_id, relPath: row.rel_path, title: db.prepare("SELECT title FROM tracks WHERE id = ?").get(row.track_id)?.title || null }));
    return { root: resolved, items, removed };
  }

  function summarize(result) {
    const count = (status) => result.items.filter((item) => item.status === status).length;
    const work = result.items.filter((item) => ["new", "replace", "refresh"].includes(item.status));
    return {
      root: result.root,
      total: result.items.length,
      new: count("new"),
      replace: count("replace"),
      refresh: count("refresh"),
      unchanged: count("unchanged"),
      problems: count("problem"),
      conversions: work.filter((item) => item.action === "convert").length,
      bytes: work.reduce((sum, item) => sum + item.size, 0),
      freeBytes: freeBytes(result.root),
      warnings: result.items.filter((item) => item.warnings.length).length,
      removed: result.removed.length,
    };
  }

  function preview(params) {
    const result = plan(params);
    const strip = (item) => {
      const { track: _track, sourcePath: _source, fileSig: _file, metaSig: _meta, ...rest } = item;
      return rest;
    };
    return {
      summary: summarize(result),
      items: result.items.filter((item) => item.status !== "unchanged").slice(0, 400).map(strip),
      removed: result.removed.slice(0, 200),
    };
  }

  async function produce(item, target, { signal }) {
    const temp = siblingPath(target, "wmtmp");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(temp, { force: true });
    if (item.action === "convert") await media.convertToAlac(item.sourcePath, temp, { signal });
    else fs.copyFileSync(item.sourcePath, temp);

    if (canWriteTags(temp)) {
      const fields = Object.fromEntries(TAG_FIELDS.map(([field, def]) => [field, item.track[def.column]]));
      const art = item.track.artwork_hash ? artStore.read(item.track.artwork_hash, db) : null;
      if (art) fields.artwork = art;
      else if (item.action === "convert" && item.track.effective_art) {
        const embedded = artStore.read(item.track.effective_art, db);
        if (embedded) fields.artwork = embedded;
      }
      const before = await media.audioStreamHash(temp);
      writeTags(temp, fields);
      if ((await media.audioStreamHash(temp)) !== before) throw new Error("The audio stream changed while writing tags");
    }

    // Replacing WaveMint's own earlier export file: keep it until the new one is in place.
    const old = fs.existsSync(target) ? siblingPath(target, "wmold") : null;
    if (old) fs.renameSync(target, old);
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      if (old) fs.renameSync(old, target);
      throw error;
    }
    if (old) fs.rmSync(old, { force: true });
  }

  function writeSidecars(root, result, done, playlistIds) {
    const exported = new Map(db.prepare("SELECT track_id, rel_path FROM export_state WHERE root_key = ?").all(pathKey(root)).map((row) => [row.track_id, row.rel_path]));
    const playlistsDir = path.join(root, "Playlists");
    const playlists = [];
    for (const id of playlistIds) {
      const playlist = db.prepare("SELECT id, name FROM playlists WHERE id = ?").get(id);
      if (!playlist) continue;
      const rows = playlistTracks(db, id).filter((row) => exported.has(row.id));
      fs.mkdirSync(playlistsDir, { recursive: true });
      const file = path.join(playlistsDir, `${safeSegment(playlist.name, "Playlist")}.m3u8`);
      fs.writeFileSync(file, m3u8For(playlist.name, rows, (row) => path.join(root, exported.get(row.id))), "utf8");
      playlists.push({ name: playlist.name, file: path.relative(root, file), tracks: rows.length });
    }

    const manifest = {
      app: "WaveMint",
      version: 1,
      exportedAt: nowIso(),
      tracks: [...exported.entries()].map(([trackId, relPath]) => {
        const track = db.prepare("SELECT title, artist, album FROM tracks WHERE id = ?").get(trackId) || {};
        return { trackId, relPath, title: track.title, artist: track.artist, album: track.album };
      }),
      playlists,
    };
    fs.writeFileSync(path.join(root, "wavemint-export.json"), JSON.stringify(manifest, null, 2), "utf8");

    const list = (label, items, hint) =>
      items.length ? [`${label} (${items.length})${hint ? ` — ${hint}` : ""}`, ...items.map((item) => `  ${item.relPath}`), ""] : [];
    const lines = [
      "WaveMint export report",
      `Folder: ${root}`,
      `Date: ${new Date().toLocaleString()}`,
      "",
      ...list("New", done.new, "add these files to Apple Music"),
      ...list("Replaced", done.replace, "the audio changed (e.g. an upgrade): delete the old entry in Apple Music, then add this file"),
      ...list("Details refreshed", done.refresh, "the tags changed: Apple Music keeps its own copy of song details, so update them there or remove and re-add the song"),
      ...list("No longer selected", result.removed, "left in the folder; remove them in Apple Music if you don't want them"),
      ...(playlists.length ? ["Playlists (M3U8, in the Playlists folder):", ...playlists.map((item) => `  ${item.file} (${item.tracks} songs)`), ""] : []),
      "WaveMint doesn't change Apple Music's library or the iPhone. Import these files into Apple Music (or iTunes), then sync the iPhone with the Apple Devices app (or iTunes).",
    ];
    fs.writeFileSync(path.join(root, "WaveMint Export Report.txt"), `${lines.join("\r\n")}\r\n`, "utf8");
    return { playlists };
  }

  /** Writes new and changed songs into the export folder. */
  async function exportJob({ root, scope, options = {}, signal, progress }) {
    const result = plan({ root, scope, options });
    const resolved = result.root;
    const rootKey = pathKey(resolved);
    const work = result.items.filter((item) => ["new", "replace", "refresh"].includes(item.status));
    const free = freeBytes(resolved);
    const needed = work.reduce((sum, item) => sum + item.size, 0);
    if (free !== null && free < needed * 1.05) throw new Error("There isn't enough free space in the export folder.");

    const done = { new: [], replace: [], refresh: [], failed: [] };
    for (const [index, item] of work.entries()) {
      if (signal?.aborted) break;
      progress?.({ phase: "exporting", done: index, total: work.length, current: item.title });
      try {
        const target = path.join(resolved, item.relPath);
        // A replaced song whose format changed gets a new name; the old
        // file is kept aside, never deleted.
        if (item.previousRelPath && item.previousRelPath !== item.relPath && fs.existsSync(path.join(resolved, item.previousRelPath))) {
          const aside = path.join(resolved, ".replaced", item.previousRelPath);
          fs.mkdirSync(path.dirname(aside), { recursive: true });
          fs.renameSync(path.join(resolved, item.previousRelPath), aside);
        }
        await produce(item, target, { signal });
        db.prepare(
          `INSERT INTO export_state (root_key, track_id, rel_path, file_id, file_sig, meta_sig, format, exported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(root_key, track_id) DO UPDATE SET rel_path = excluded.rel_path, file_id = excluded.file_id, file_sig = excluded.file_sig,
             meta_sig = excluded.meta_sig, format = excluded.format, exported_at = excluded.exported_at`,
        ).run(rootKey, item.trackId, item.relPath, item.track.file_id, item.fileSig, item.metaSig, item.format, nowIso());
        done[item.status].push({ trackId: item.trackId, relPath: item.relPath, title: item.title });
      } catch (error) {
        done.failed.push({ trackId: item.trackId, title: item.title, error: error.message });
        logger.warn(`[library] Export of "${item.title}" failed: ${error.message}`);
      }
    }

    const playlistIds = options.playlists === "all" ? db.prepare("SELECT id FROM playlists").all().map((row) => row.id) : scope.playlistIds || [];
    const sidecars = writeSidecars(resolved, result, done, playlistIds);
    const report = {
      root: resolved,
      new: done.new.length,
      replace: done.replace.length,
      refresh: done.refresh.length,
      unchanged: result.items.filter((item) => item.status === "unchanged").length,
      problems: result.items.filter((item) => item.status === "problem").map((item) => ({ title: item.title, problems: item.problems })).slice(0, 100),
      failed: done.failed,
      removed: result.removed.length,
      playlists: sidecars.playlists,
      changedFiles: [...done.new, ...done.replace, ...done.refresh].map((item) => item.relPath),
      cancelled: !!signal?.aborted,
    };
    const id = Number(
      db.prepare("INSERT INTO exports (root_path, created_at, status, report) VALUES (?, ?, ?, ?)").run(resolved, nowIso(), done.failed.length ? "partial" : "completed", JSON.stringify(report)).lastInsertRowid,
    );
    return { exportId: id, ...report };
  }

  function lastExport({ root }) {
    const resolved = root ? path.resolve(root) : null;
    const row = resolved
      ? db.prepare("SELECT * FROM exports WHERE root_path = ? ORDER BY id DESC LIMIT 1").get(resolved)
      : db.prepare("SELECT * FROM exports ORDER BY id DESC LIMIT 1").get();
    return row ? { id: row.id, root: row.root_path, createdAt: row.created_at, status: row.status, report: parseJson(row.report, {}) } : null;
  }

  /** Apple's "Automatically Add to …" folders that exist on this PC. */
  function findAutoAddFolders() {
    const home = os.homedir();
    const candidates = [
      path.join(home, "Music", "iTunes", "iTunes Media", "Automatically Add to iTunes"),
      path.join(home, "Music", "Music", "Media", "Automatically Add to Music"),
      path.join(home, "Music", "Apple Music", "Media", "Automatically Add to Apple Music"),
    ];
    for (const source of db.prepare("SELECT root_path FROM sources").all()) {
      for (const base of [source.root_path, path.dirname(source.root_path)]) {
        try {
          for (const name of fs.readdirSync(base)) if (AUTO_ADD.test(name)) candidates.push(path.join(base, name));
        } catch {
          // Unreachable folders are skipped.
        }
      }
    }
    const seen = new Set();
    return candidates.filter((folder) => {
      const key = pathKey(folder);
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(folder);
    });
  }

  /**
   * Copies the last export's new and changed files into an "Automatically
   * Add to iTunes/Music" folder, from which Apple's app imports them itself.
   */
  function handOff({ exportId, folder }) {
    const resolved = path.resolve(String(folder || ""));
    if (!AUTO_ADD.test(path.basename(resolved)) || !fs.existsSync(resolved)) {
      throw new Error('Choose Apple\'s "Automatically Add to iTunes" (or "…to Music") folder.');
    }
    const row = db.prepare("SELECT * FROM exports WHERE id = ?").get(Number(exportId));
    if (!row) throw new Error("Prepare the export first.");
    const report = parseJson(row.report, {});
    let copied = 0;
    const failures = [];
    for (const relPath of report.changedFiles || []) {
      const source = path.join(row.root_path, relPath);
      try {
        let target = path.join(resolved, path.basename(relPath));
        for (let counter = 2; fs.existsSync(target); counter += 1) {
          target = path.join(resolved, `${path.basename(relPath, path.extname(relPath))} (${counter})${path.extname(relPath)}`);
        }
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        copied += 1;
      } catch (error) {
        failures.push({ file: relPath, error: error.message });
      }
    }
    return { copied, failures, folder: resolved };
  }

  return { checkRoot, exportJob, findAutoAddFolders, handOff, lastExport, plan, preview, scopeTrackIds };
}

module.exports = { AUTO_ADD, createExporter };
