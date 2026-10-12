// Audio quality: diagnostic signals per file, a quality status per song, and
// the upgrade queue.
//
// Nothing here claims that one file sounds better than another. Bitrate,
// sample rate and size are technical facts; the FFmpeg measurements are
// hints. Statuses the user chose (and "Upgraded") are never recomputed.

const { nowIso, parseJson, transaction } = require("./db.cjs");
const { finishOperation, logChange, startOperation } = require("./operations.cjs");
const { LOW_BITRATE_KBPS } = require("./queries.cjs");

const STATUSES = ["unknown", "review_suggested", "acceptable", "user_marked_poor", "upgrade_available", "upgraded", "keep_original"];
const USER_STATUSES = new Set(["user_marked_poor", "keep_original", "acceptable", "upgraded"]);
const STATUS_LABELS = {
  unknown: "Quality unknown",
  review_suggested: "Quality review suggested",
  acceptable: "Acceptable",
  user_marked_poor: "Marked poor quality",
  upgrade_available: "Upgrade candidate available",
  upgraded: "Upgraded",
  keep_original: "Kept in original form",
};

const CODEC_NAMES = { mp3: "MP3", aac: "AAC", alac: "ALAC", flac: "FLAC", pcm: "PCM", vorbis: "Vorbis", opus: "Opus", wav: "WAV", aiff: "AIFF" };

function describeFile(file) {
  const codec = CODEC_NAMES[file.codec] || String(file.codec || "unknown format").toUpperCase();
  if (file.lossless) {
    const parts = [file.bit_depth ? `${file.bit_depth}-bit` : "", file.sample_rate ? `${(file.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : ""].filter(Boolean);
    return parts.length ? `${codec} ${parts.join("/")}` : codec;
  }
  return file.bitrate ? `${codec} ${file.bitrate} kbps` : codec;
}

/**
 * A coarse technical resolution tier, used only to point out that another
 * version *may* be worth comparing. 0 = unknown.
 */
function technicalTier(file) {
  if (!file || !file.codec) return 0;
  if (file.lossless) return file.bit_depth > 16 || file.sample_rate > 48000 ? 6 : 5;
  const kbps = Number(file.bitrate) || 0;
  if (!kbps) return 0;
  const efficient = file.codec === "aac" || file.codec === "opus" || file.codec === "vorbis";
  const effective = efficient ? kbps * 1.3 : kbps;
  if (effective >= 256) return 4;
  if (effective >= 192) return 3;
  if (effective >= 128) return 2;
  return 1;
}

const reason = (code, level, text) => ({ code, level, text });

/** Signals for one file (technical facts plus, if checked, FFmpeg measurements). */
function fileSignals(file, check, { lowBitrateKbps = LOW_BITRATE_KBPS } = {}) {
  const reasons = [];
  if (!file) return reasons;
  if (file.status === "missing") return [reason("missing", 3, "The file is missing")];
  if (file.status === "unreadable") return [reason("unreadable", 3, "The file couldn't be read")];

  if (!file.lossless && file.bitrate > 0 && file.bitrate < lowBitrateKbps) {
    reasons.push(reason("low_bitrate", 2, `Lossy at ${file.bitrate} kbps`));
  }
  if (file.sample_rate && file.sample_rate < 44100) {
    reasons.push(reason("low_sample_rate", 2, `Sample rate ${(file.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`));
  }
  if (!file.duration_ms) reasons.push(reason("no_duration", 1, "Length unknown"));

  if (check) {
    if (check.decode_errors > 0) {
      reasons.push(reason("decode_errors", 3, `${check.decode_errors} decoding error${check.decode_errors === 1 ? "" : "s"} (the file may be damaged)`));
    }
    if (check.truncated) reasons.push(reason("truncated", 3, "The audio ends before the file's stated length (it may be incomplete)"));

    const drop = check.band_high_db !== null && check.band_mid_db !== null ? check.band_high_db - check.band_mid_db : null;
    if (drop !== null && check.band_mid_db > -80 && drop < -10 && (file.sample_rate || 44100) >= 44100) {
      if (file.lossless) {
        reasons.push(reason("lossless_cutoff", 2, "Lossless file, but almost nothing above 16 kHz: it may have been made from a lossy copy (some recordings are simply like this)"));
      } else if (file.bitrate >= 256) {
        reasons.push(reason("hidden_cutoff", 2, `Almost nothing above 16 kHz for ${file.bitrate} kbps: it may have been re-encoded from a lower-quality file`));
      } else {
        reasons.push(reason("cutoff", 1, "Almost nothing above 16 kHz (typical of lower-bitrate encodes)"));
      }
    }
    if (check.peak_db !== null && check.peak_db >= -0.1 && check.peak_count && check.sample_count) {
      const ratio = check.peak_count / check.sample_count;
      if (ratio > 0.0005) reasons.push(reason("clipping", 1, "Many samples at full scale (possible clipping; common in loud masters)"));
    }
  }
  return reasons;
}

/** Computed status for a song from its active file's signals and its other versions. */
function computedStatus({ reasons, checked, betterVersion }) {
  if (betterVersion) return "upgrade_available";
  if (reasons.some((item) => item.level >= 2)) return "review_suggested";
  if (checked) return "acceptable";
  return "unknown";
}

const FILE_COLUMNS = "f.id, f.track_id, f.path, f.codec, f.lossless, f.bitrate, f.sample_rate, f.bit_depth, f.duration_ms, f.size, f.mtime_ms, f.status, f.role, f.source_id";

function currentCheck(db, file) {
  const check = db.prepare("SELECT * FROM quality_checks WHERE file_id = ?").get(file.id);
  if (!check || check.size !== file.size || check.mtime_ms !== Math.round(file.mtime_ms)) return null;
  return check;
}

/**
 * Recomputes reasons for songs (all active songs by default) and the status
 * of those whose status is computed. Returns the number of songs updated.
 */
function refreshQuality(db, { trackIds = null, lowBitrateKbps = LOW_BITRATE_KBPS } = {}) {
  const filter = trackIds?.length ? `AND t.id IN (${trackIds.map(() => "?").join(",")})` : "";
  const tracks = db
    .prepare(
      `SELECT t.id, t.quality_status, t.quality_set_by, t.quality_reasons, t.active_file_id FROM tracks t
       WHERE t.state = 'active' ${filter}`,
    )
    .all(...(trackIds || []));
  const filesOf = db.prepare(`SELECT ${FILE_COLUMNS} FROM files f WHERE f.track_id = ?`);
  const update = db.prepare("UPDATE tracks SET quality_status = ?, quality_reasons = ? WHERE id = ?");
  let changed = 0;

  transaction(db, () => {
    for (const track of tracks) {
      const files = filesOf.all(track.id);
      const active = files.find((file) => file.id === track.active_file_id);
      const check = active ? currentCheck(db, active) : null;
      const reasons = fileSignals(active, check, { lowBitrateKbps });

      // Another version of this song that is technically higher resolution
      // (and not known to be damaged) is worth comparing. Archived versions
      // were set aside deliberately.
      const activeTier = technicalTier(active);
      const better = files
        .filter((file) => file.id !== track.active_file_id && file.status === "ok" && file.role !== "archived")
        .map((file) => ({ file, tier: technicalTier(file), check: currentCheck(db, file) }))
        .filter((item) => item.tier > activeTier && !(item.check && (item.check.decode_errors > 0 || item.check.truncated)))
        .sort((a, b) => b.tier - a.tier)[0];
      if (better) {
        reasons.push({ ...reason("better_version", 2, `Another version in your library is ${describeFile(better.file)}`), fileId: better.file.id });
      }

      const status = track.quality_set_by === "auto" ? computedStatus({ reasons, checked: !!check, betterVersion: !!better }) : track.quality_status;
      const json = JSON.stringify({ reasons, checked: !!check, file: active ? describeFile(active) : null });
      if (status !== track.quality_status || json !== track.quality_reasons) {
        update.run(status, json, track.id);
        changed += 1;
      }
    }
  });
  return changed;
}

/** Stores an FFmpeg quality check for a file. */
function saveCheck(db, file, result) {
  db.prepare(
    `INSERT INTO quality_checks (file_id, size, mtime_ms, checked_at, decode_errors, decode_sample, truncated, peak_db, rms_db, peak_count,
       sample_count, band_mid_db, band_high_db)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, checked_at = excluded.checked_at,
       decode_errors = excluded.decode_errors, decode_sample = excluded.decode_sample, truncated = excluded.truncated,
       peak_db = excluded.peak_db, rms_db = excluded.rms_db, peak_count = excluded.peak_count, sample_count = excluded.sample_count,
       band_mid_db = excluded.band_mid_db, band_high_db = excluded.band_high_db`,
  ).run(
    file.id,
    file.size,
    Math.round(file.mtime_ms),
    nowIso(),
    result.decodeErrors || 0,
    JSON.stringify(result.decodeSample || []),
    result.truncated ? 1 : 0,
    result.peakDb ?? null,
    result.rmsDb ?? null,
    result.peakCount ?? null,
    result.sampleCount ?? null,
    result.bandMidDb ?? null,
    result.bandHighDb ?? null,
  );
}

/**
 * Runs quality checks on the active files of the given songs (or every song
 * not checked yet). Unchanged files that were already checked are skipped
 * unless `force`.
 */
async function checkJob(db, media, { trackIds = null, force = false, lowBitrateKbps, signal, progress, logger = console }) {
  const filter = trackIds?.length ? `AND t.id IN (${trackIds.map(() => "?").join(",")})` : "";
  const files = db
    .prepare(
      `SELECT ${FILE_COLUMNS}, t.id AS song_id, t.title FROM tracks t JOIN files f ON f.id = t.active_file_id
       WHERE t.state = 'active' AND f.status = 'ok' ${filter} ORDER BY t.id`,
    )
    .all(...(trackIds || []))
    .filter((file) => force || !currentCheck(db, file));

  const report = { checked: 0, failed: 0, total: files.length };
  const done = [];
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) break;
    progress?.({ phase: "checking", done: index, total: files.length, current: file.title });
    try {
      const result = await media.qualityCheck(file.path, { durationMs: file.duration_ms, sampleRate: file.sample_rate });
      saveCheck(db, file, result);
      report.checked += 1;
      done.push(file.song_id);
    } catch (error) {
      report.failed += 1;
      logger.warn(`[library] Quality check failed for ${file.path}: ${error.message}`);
    }
    // Statuses follow along in batches, so the queue fills while it runs.
    if (done.length >= 50) refreshQuality(db, { trackIds: done.splice(0), lowBitrateKbps });
  }
  if (done.length) refreshQuality(db, { trackIds: done, lowBitrateKbps });
  return report;
}

/**
 * Sets the user's quality decision for songs ("auto" hands the status back
 * to WaveMint). Journaled and undoable like other metadata changes.
 */
function setQualityStatus(db, { trackIds, status, lowBitrateKbps }) {
  if (status !== "auto" && !USER_STATUSES.has(status)) throw new Error("Unknown quality status");
  const rows = db
    .prepare(`SELECT id, quality_status, quality_set_by FROM tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`)
    .all(...trackIds);
  if (!rows.length) return { operationId: null, tracks: 0 };

  let operationId = null;
  transaction(db, () => {
    operationId = startOperation(db, {
      kind: "quality",
      label: status === "auto" ? "Reset quality status" : `Mark ${rows.length === 1 ? "song" : `${rows.length} songs`}: ${STATUS_LABELS[status]}`,
    });
    for (const row of rows) {
      const setBy = status === "auto" ? "auto" : "user";
      const next = status === "auto" ? row.quality_status : status;
      if (row.quality_set_by !== setBy) {
        db.prepare("UPDATE tracks SET quality_set_by = ? WHERE id = ?").run(setBy, row.id);
        logChange(db, operationId, { entityId: row.id, field: "quality_set_by", oldValue: row.quality_set_by, newValue: setBy });
      }
      if (next !== row.quality_status) {
        db.prepare("UPDATE tracks SET quality_status = ? WHERE id = ?").run(next, row.id);
        logChange(db, operationId, { entityId: row.id, field: "quality_status", oldValue: row.quality_status, newValue: next });
      }
    }
    finishOperation(db, operationId, "completed", { tracks: rows.length });
  });
  if (status === "auto") refreshQuality(db, { trackIds, lowBitrateKbps });
  return { operationId, tracks: rows.length };
}

const QUEUE_VIEWS = {
  attention: "t.quality_status IN ('review_suggested', 'user_marked_poor', 'upgrade_available')",
  review_suggested: "t.quality_status = 'review_suggested'",
  user_marked_poor: "t.quality_status = 'user_marked_poor'",
  upgrade_available: "t.quality_status = 'upgrade_available'",
  keep_original: "t.quality_status = 'keep_original'",
  upgraded: "t.quality_status = 'upgraded'",
  acceptable: "t.quality_status = 'acceptable'",
  unknown: "t.quality_status = 'unknown'",
  all: "1 = 1",
};

const QUEUE_SORTS = {
  severity: `CASE t.quality_status WHEN 'user_marked_poor' THEN 0 WHEN 'upgrade_available' THEN 1 WHEN 'review_suggested' THEN 2 ELSE 3 END,
             COALESCE(f.lossless, 0), COALESCE(f.bitrate, 0)`,
  bitrate: "COALESCE(f.lossless, 0), COALESCE(f.bitrate, 0)",
  artist: "t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.track_no",
  album: "t.album COLLATE NOCASE, t.disc_no, t.track_no",
  title: "t.title COLLATE NOCASE",
};

/** The upgrade queue: songs by quality status with filters. */
function listQueue(db, { view = "attention", search = "", artist, genre, releaseId, maxBitrate, sort = "severity", offset = 0, limit = 100 } = {}) {
  const where = ["t.state = 'active'", QUEUE_VIEWS[view] || QUEUE_VIEWS.attention];
  const params = [];
  if (search) {
    where.push("(t.title LIKE ? OR t.artist LIKE ? OR t.album LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (artist) {
    where.push("(t.artist = ? COLLATE NOCASE OR t.album_artist = ? COLLATE NOCASE)");
    params.push(artist, artist);
  }
  if (genre) {
    where.push("t.genre = ? COLLATE NOCASE");
    params.push(genre);
  }
  if (releaseId) {
    where.push("t.release_id = ?");
    params.push(releaseId);
  }
  if (maxBitrate) {
    where.push("f.lossless = 0 AND f.bitrate > 0 AND f.bitrate <= ?");
    params.push(maxBitrate);
  }
  const from = "FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id";
  const total = db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(" AND ")}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.genre, t.year, t.release_id, t.quality_status, t.quality_set_by, t.quality_reasons,
              t.duration_ms, COALESCE(t.artwork_hash, f.artwork_hash) AS artwork_hash,
              f.id AS file_id, f.codec, f.lossless, f.bitrate, f.sample_rate, f.bit_depth, f.size, f.status AS file_status,
              (SELECT COUNT(*) FROM files v WHERE v.track_id = t.id) AS version_count,
              (SELECT COUNT(*) FROM upgrade_candidates c WHERE c.track_id = t.id AND c.status = 'pending') AS pending_candidates
       ${from} WHERE ${where.join(" AND ")}
       ORDER BY ${QUEUE_SORTS[sort] || QUEUE_SORTS.severity}, t.id LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(500, limit), Math.max(0, offset))
    .map((row) => ({ ...row, quality: parseJson(row.quality_reasons, { reasons: [], checked: false }) }));
  return { total, rows };
}

function qualitySummary(db) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of db.prepare("SELECT quality_status AS status, COUNT(*) AS n FROM tracks WHERE state = 'active' GROUP BY quality_status").all()) {
    counts[row.status] = row.n;
  }
  const checked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tracks t JOIN files f ON f.id = t.active_file_id JOIN quality_checks q ON q.file_id = f.id
       WHERE t.state = 'active' AND q.size = f.size AND q.mtime_ms = CAST(ROUND(f.mtime_ms) AS INTEGER)`,
    )
    .get().n;
  const total = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE state = 'active'").get().n;
  return { counts, labels: STATUS_LABELS, checked, total };
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  USER_STATUSES,
  checkJob,
  computedStatus,
  describeFile,
  fileSignals,
  listQueue,
  qualitySummary,
  refreshQuality,
  saveCheck,
  setQualityStatus,
  technicalTier,
};
