// Read-only library scanner.
//
// Walks a source folder, reads tags and audio properties of every supported
// file, and records them as file versions and logical tracks. It never
// writes, moves, renames or deletes anything in the scanned folder.
//
// - Incremental: files whose size and modification time are unchanged are
//   only marked as seen.
// - Restartable: a cancelled or interrupted scan leaves the catalog
//   consistent; the next scan simply continues where data is stale.
// - Missing files are marked "missing", never deleted from the catalog, and
//   nothing is marked missing when the source folder itself is unreachable
//   (disconnected drive).
// - Symbolic links and junctions are not followed (no loops, no scanning
//   outside the chosen folder).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { nowIso, transaction } = require("./db.cjs");
const { isAudioFile, readTags } = require("./tags.cjs");
const { artistKey, parseAlbum, pathKey, titleKey } = require("./normalize.cjs");
const { refreshTrackSearch } = require("./search.cjs");

const SKIPPED_DIRECTORIES = new Set([
  "$recycle.bin",
  "system volume information",
  ".wavemint-staging",
  ".wavemint-archive",
  "node_modules",
]);
const SIGNATURE_CHUNK = 64 * 1024;
const BATCH_SIZE = 100;
const PROGRESS_INTERVAL_MS = 250;

class ScanCancelled extends Error {}

/** size + first and last 64 KB: cheap identity for duplicate pre-filtering. */
async function quickSignature(filePath, size) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const hash = crypto.createHash("sha1");
    hash.update(String(size));
    const head = Buffer.alloc(Math.min(SIGNATURE_CHUNK, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > SIGNATURE_CHUNK * 2) {
      const tail = Buffer.alloc(SIGNATURE_CHUNK);
      await handle.read(tail, 0, SIGNATURE_CHUNK, size - SIGNATURE_CHUNK);
      hash.update(tail);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Full SHA-256 of a file (computed only when needed). */
function contentHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Title and artist/album guesses for untagged files, using the common
// "Artist/Album/01 Title.ext" layout (iTunes Media and most managers).
function guessFromPath(relPath) {
  const parts = relPath.split(/[\\/]/);
  const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const trackMatch = /^(?:(\d{1,2})-)?(\d{1,3})[\s._-]+(.+)$/.exec(fileName);

  return {
    title: (trackMatch ? trackMatch[3] : fileName).trim(),
    trackNo: trackMatch ? Number(trackMatch[2]) : null,
    discNo: trackMatch && trackMatch[1] ? Number(trackMatch[1]) : null,
    album: parts.length >= 3 ? parts[parts.length - 2] : "",
    artist: parts.length >= 3 ? parts[parts.length - 3] : parts.length === 2 ? parts[0] : "",
  };
}

async function* walk(root, { signal, onSkip }) {
  const stack = [root];
  const visited = new Set();

  while (stack.length) {
    if (signal?.aborted) throw new ScanCancelled();
    const directory = stack.pop();

    let real;
    try {
      real = (await fs.promises.realpath(directory)).toLowerCase();
    } catch (error) {
      onSkip?.(directory, error);
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);

    let dir;
    try {
      dir = await fs.promises.opendir(directory);
    } catch (error) {
      onSkip?.(directory, error);
      continue;
    }

    const subdirectories = [];
    try {
      for await (const entry of dir) {
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          onSkip?.(full, { code: "SYMLINK" });
        } else if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name.toLowerCase()) && !entry.name.startsWith(".")) {
            subdirectories.push(full);
          }
        } else if (entry.isFile() && isAudioFile(entry.name) && !entry.name.includes(".wmtmp")) {
          yield full;
        }
      }
    } catch (error) {
      onSkip?.(directory, error);
    }

    // Depth-first, alphabetical order (stack pops the last pushed).
    subdirectories.sort((a, b) => b.localeCompare(a));
    stack.push(...subdirectories);
  }
}

function releaseFor(db, { album, albumArtist, artist, compilation, year }) {
  const title = String(album || "").trim();
  if (!title) return null;

  const displayArtist = (albumArtist || (compilation ? "Various Artists" : artist) || "").trim();
  const parsed = parseAlbum(title);
  const key = parsed.key || title.toLowerCase();
  const aKey = artistKey(displayArtist) || "";
  const existing = db
    .prepare("SELECT id, year FROM releases WHERE title_key = ? AND artist_key = ? AND edition = ?")
    .get(key, aKey, parsed.edition);

  if (existing) {
    if (!existing.year && year) db.prepare("UPDATE releases SET year = ? WHERE id = ?").run(year, existing.id);
    return existing.id;
  }

  const now = nowIso();
  return Number(
    db
      .prepare(
        `INSERT INTO releases (title, album_artist, title_key, artist_key, edition, year, release_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(title, displayArtist, key, aKey, parsed.edition, year || null, compilation ? "compilation" : "album", now, now)
      .lastInsertRowid,
  );
}

// node:sqlite can't bind undefined, so every value is a string, number or null.
function trackValuesFrom(meta, guess) {
  const title = meta.title || guess.title || "";
  const artist = meta.artist || meta.albumArtist || guess.artist || "";
  return {
    title,
    artist,
    album_artist: meta.albumArtist || "",
    album: meta.album || guess.album || "",
    track_no: meta.trackNo ?? guess.trackNo ?? null,
    track_total: meta.trackTotal ?? null,
    disc_no: meta.discNo ?? guess.discNo ?? null,
    disc_total: meta.discTotal ?? null,
    year: meta.year ?? null,
    genre: meta.genre || "",
    composer: meta.composer || "",
    comment: meta.comment || "",
    compilation: meta.compilation ? 1 : 0,
    duration_ms: meta.durationMs ?? null,
    title_key: titleKey(title),
    artist_key: artistKey(artist),
  };
}

const TRACK_FIELDS = [
  "title",
  "artist",
  "album_artist",
  "album",
  "track_no",
  "track_total",
  "disc_no",
  "disc_total",
  "year",
  "genre",
  "composer",
  "comment",
  "compilation",
];

function createScanner({ db, readTagsImpl = readTags, probe = null, logger = console }) {
  const statements = {
    fileByKey: db.prepare("SELECT id, track_id, size, mtime_ms, status FROM files WHERE path_key = ?"),
    markSeen: db.prepare(
      "UPDATE files SET last_seen_scan_id = ?, last_seen_at = ?, status = CASE WHEN read_error IS NULL THEN 'ok' ELSE 'unreadable' END WHERE id = ?",
    ),
    insertFile: db.prepare(`
      INSERT INTO files (track_id, source_id, path, path_key, rel_path, ext, size, mtime_ms, quick_sig,
        container, codec, lossless, bitrate, sample_rate, bit_depth, channels, duration_ms, tag_snapshot,
        artwork_hash, artwork_count, status, role, read_error, first_seen_at, last_seen_at, last_seen_scan_id)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`),
    updateFile: db.prepare(`
      UPDATE files SET path = ?, rel_path = ?, size = ?, mtime_ms = ?, quick_sig = ?, content_hash = NULL, audio_hash = NULL,
        container = ?, codec = ?, lossless = ?, bitrate = ?, sample_rate = ?, bit_depth = ?, channels = ?,
        duration_ms = ?, tag_snapshot = ?, artwork_hash = ?, artwork_count = ?, status = ?, read_error = ?,
        last_seen_at = ?, last_seen_scan_id = ?
      WHERE id = ?`),
    insertTrack: db.prepare(`
      INSERT INTO tracks (title, artist, album_artist, album, release_id, track_no, track_total, disc_no, disc_total,
        year, genre, composer, comment, compilation, duration_ms, active_file_id, title_key, artist_key,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    linkFile: db.prepare("UPDATE files SET track_id = ? WHERE id = ?"),
    trackById: db.prepare("SELECT * FROM tracks WHERE id = ?"),
  };

  function createTrackForFile(fileId, values) {
    const now = nowIso();
    const releaseId = releaseFor(db, {
      album: values.album,
      albumArtist: values.album_artist,
      artist: values.artist,
      compilation: values.compilation,
      year: values.year,
    });
    const trackId = Number(
      statements.insertTrack.run(
        values.title,
        values.artist,
        values.album_artist,
        values.album,
        releaseId,
        values.track_no,
        values.track_total,
        values.disc_no,
        values.disc_total,
        values.year,
        values.genre,
        values.composer,
        values.comment,
        values.compilation,
        values.duration_ms,
        fileId,
        values.title_key,
        values.artist_key,
        now,
        now,
      ).lastInsertRowid,
    );
    statements.linkFile.run(trackId, fileId);
    return trackId;
  }

  // A file was re-tagged outside WaveMint: refresh the track's fields that
  // the user hasn't curated in WaveMint, when this file is its active version.
  function refreshTrackFromFile(trackId, fileId, values) {
    const track = statements.trackById.get(trackId);
    if (!track || track.active_file_id !== fileId) return false;

    let curated = [];
    try {
      curated = JSON.parse(track.curated_fields || "[]");
    } catch {
      curated = [];
    }

    const updates = {};
    for (const field of TRACK_FIELDS) {
      if (!curated.includes(field) && values[field] !== undefined && track[field] !== values[field]) {
        updates[field] = values[field];
      }
    }
    if (values.duration_ms && values.duration_ms !== track.duration_ms) updates.duration_ms = values.duration_ms;
    if (!Object.keys(updates).length) return false;

    const merged = { ...track, ...updates };
    updates.title_key = titleKey(merged.title);
    updates.artist_key = artistKey(merged.artist);
    updates.release_id = releaseFor(db, {
      album: merged.album,
      albumArtist: merged.album_artist,
      artist: merged.artist,
      compilation: merged.compilation,
      year: merged.year,
    });
    updates.updated_at = nowIso();

    const columns = Object.keys(updates);
    db.prepare(`UPDATE tracks SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
      ...columns.map((column) => updates[column]),
      trackId,
    );
    return true;
  }

  async function readFileMetadata(filePath, size) {
    try {
      return { meta: readTagsImpl(filePath, { size }), error: null };
    } catch (error) {
      if (probe) {
        try {
          return { meta: await probe(filePath, { size }), error: null };
        } catch (probeError) {
          return { meta: null, error: probeError.message || String(probeError) };
        }
      }
      return { meta: null, error: error.message || String(error) };
    }
  }

  /**
   * Scans one source. Returns stats. `onProgress` receives throttled
   * progress objects; `signal` cancels.
   */
  async function scanSource(sourceId, { signal, onProgress } = {}) {
    const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId);
    if (!source) throw new Error("This library source no longer exists");

    const startedAt = nowIso();
    const stats = {
      found: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      unreadable: 0,
      missing: 0,
      restored: 0,
      skipped: 0,
    };

    let rootOk = false;
    try {
      rootOk = (await fs.promises.stat(source.root_path)).isDirectory();
    } catch {
      rootOk = false;
    }

    if (!rootOk) {
      db.prepare("UPDATE sources SET status = 'unavailable' WHERE id = ?").run(sourceId);
      db.prepare("INSERT INTO scans (source_id, status, started_at, finished_at, stats) VALUES (?, 'unavailable', ?, ?, ?)").run(
        sourceId,
        startedAt,
        nowIso(),
        JSON.stringify(stats),
      );
      return { status: "unavailable", stats };
    }

    const scanId = Number(
      db
        .prepare("INSERT INTO scans (source_id, status, started_at) VALUES (?, 'running', ?)")
        .run(sourceId, startedAt).lastInsertRowid,
    );
    db.prepare("UPDATE sources SET status = 'ok', last_scan_started_at = ? WHERE id = ?").run(startedAt, sourceId);

    let lastProgress = 0;
    let currentPath = "";
    const report = (phase, force = false) => {
      const now = Date.now();
      if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      onProgress?.({ phase, sourceId, sourceName: source.name, currentPath, ...stats });
    };

    const changedTracks = new Set();
    let batch = [];
    let seen = [];

    // Unchanged files are only marked as seen, in batches (one commit per
    // few hundred files instead of one per file).
    const flushSeen = () => {
      if (!seen.length) return;
      const ids = seen;
      seen = [];
      const at = nowIso();
      transaction(db, () => {
        for (const fileId of ids) statements.markSeen.run(scanId, at, fileId);
      });
    };
    const restoredIds = [];

    const flush = () => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      transaction(db, () => {
        for (const item of items) applyItem(item);
      });
    };

    const applyItem = ({ filePath, relPath, stat, existing, meta, error, quickSig }) => {
      const now = nowIso();
      const ext = path.extname(filePath).toLowerCase();
      const guess = guessFromPath(relPath);
      const snapshot = meta ? JSON.stringify(meta) : null;
      const fileValues = [
        meta?.container || ext.replace(".", ""),
        meta?.codec || null,
        meta?.lossless ?? null,
        meta?.bitrate || null,
        meta?.sampleRate || null,
        meta?.bitDepth || null,
        meta?.channels || null,
        meta?.durationMs || null,
        snapshot,
        meta?.artworkHash || null,
        meta?.artworkCount || 0,
        meta ? "ok" : "unreadable",
        error,
      ];

      if (existing) {
        statements.updateFile.run(
          filePath,
          relPath,
          stat.size,
          Math.round(stat.mtimeMs),
          quickSig,
          ...fileValues,
          now,
          scanId,
          existing.id,
        );
        if (existing.track_id) {
          if (meta && refreshTrackFromFile(existing.track_id, existing.id, trackValuesFrom(meta, guess))) {
            changedTracks.add(existing.track_id);
          }
        } else {
          changedTracks.add(createTrackForFile(existing.id, trackValuesFrom(meta || {}, guess)));
        }
        return;
      }

      const fileId = Number(
        statements.insertFile.run(
          sourceId,
          filePath,
          pathKey(filePath),
          relPath,
          ext,
          stat.size,
          Math.round(stat.mtimeMs),
          quickSig,
          ...fileValues,
          now,
          now,
          scanId,
        ).lastInsertRowid,
      );
      // Every new file starts as its own logical track. Duplicates and
      // versions are linked later only through explicit matching decisions.
      changedTracks.add(createTrackForFile(fileId, trackValuesFrom(meta || {}, guess)));
    };

    let status = "completed";
    try {
      report("walking", true);
      for await (const filePath of walk(source.root_path, {
        signal,
        onSkip: () => {
          stats.skipped += 1;
        },
      })) {
        if (signal?.aborted) throw new ScanCancelled();
        stats.found += 1;
        currentPath = path.relative(source.root_path, filePath);

        let stat;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          stats.skipped += 1;
          continue;
        }

        const existing = statements.fileByKey.get(pathKey(filePath));
        // Unchanged files (including unreadable ones) are not parsed again.
        if (existing && existing.size === stat.size && existing.mtime_ms === Math.round(stat.mtimeMs)) {
          if (existing.status === "missing") restoredIds.push(existing.id);
          seen.push(existing.id);
          if (seen.length >= 500) flushSeen();
          stats.unchanged += 1;
          report("reading");
          if (stats.unchanged % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
          continue;
        }

        let quickSig = null;
        try {
          quickSig = await quickSignature(filePath, stat.size);
        } catch {
          quickSig = null;
        }

        const { meta, error } = await readFileMetadata(filePath, stat.size);
        if (!meta) stats.unreadable += 1;
        else if (existing) stats.updated += 1;
        else stats.added += 1;

        batch.push({ filePath, relPath: currentPath, stat, existing, meta, error, quickSig });
        if (batch.length >= BATCH_SIZE) flush();
        flushSeen();
        report("reading");

        // Let other requests (browsing while scanning) through.
        await new Promise((resolve) => setImmediate(resolve));
      }
      flush();
      flushSeen();

      report("finalizing", true);
      transaction(db, () => {
        stats.restored = restoredIds.length;
        // Only a completed walk of a reachable folder can declare files missing.
        const missing = db
          .prepare(
            `UPDATE files SET status = 'missing'
             WHERE source_id = ? AND status != 'missing' AND (last_seen_scan_id IS NULL OR last_seen_scan_id != ?)`,
          )
          .run(sourceId, scanId);
        stats.missing = Number(missing.changes);
      });
    } catch (error) {
      flush();
      flushSeen();
      if (error instanceof ScanCancelled || signal?.aborted) {
        status = "cancelled";
      } else {
        status = "failed";
        logger.error(`[library] Scan of ${source.name} failed: ${error.message}`);
        stats.error = error.message;
      }
    }

    refreshTrackSearch(db, [...changedTracks]);

    const finishedAt = nowIso();
    db.prepare("UPDATE scans SET status = ?, finished_at = ?, stats = ? WHERE id = ?").run(status, finishedAt, JSON.stringify(stats), scanId);
    db.prepare(
      `UPDATE sources SET last_scan_stats = ?, ${status === "completed" ? "last_scan_completed_at = ?," : ""} status = 'ok' WHERE id = ?`,
    ).run(...(status === "completed" ? [JSON.stringify(stats), finishedAt, sourceId] : [JSON.stringify(stats), sourceId]));

    onProgress?.({ phase: status, sourceId, sourceName: source.name, currentPath: "", ...stats });
    return { status, stats, scanId };
  }

  return { scanSource };
}

module.exports = {
  ScanCancelled,
  contentHash,
  createScanner,
  guessFromPath,
  quickSignature,
  releaseFor,
  walk,
};
