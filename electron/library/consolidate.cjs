// Copying songs into the WaveMint Managed Library.
//
// For each song:
//   1. plan a destination (naming pattern, unique, never an existing file);
//   2. copy the active file to "<name>.wmtmp<ext>" next to the destination and
//      verify its SHA-256 against the source;
//   3. write WaveMint's curated tags into that copy (editable formats only)
//      and verify the tags and the audio stream;
//   4. rename it into place (refusing to overwrite anything);
//   5. register it as the song's active version (the source file stays as an
//      alternate version and is never modified).
// Every step is journaled; recover() finishes or cleans up after an
// interruption, and re-running skips songs that are already managed.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { nowIso, parseJson, transaction } = require("./db.cjs");
const { tagDifferences, siblingPath } = require("./fileops.cjs");
const { FIELDS } = require("./edits.cjs");
const { addStep, finishOperation, logChange, startOperation, updateStep } = require("./operations.cjs");
const { DEFAULT_PATTERN, planPaths, validatePattern } = require("./organize.cjs");
const { pathKey } = require("./normalize.cjs");
const { quickSignature } = require("./scanner.cjs");
const { canWriteTags, readTags, writeTags } = require("./tags.cjs");
const { validateRoot } = require("./sources.cjs");

const TAG_FIELDS = Object.entries(FIELDS).filter(([, def]) => def.tag);
// Versions replaced by an upgrade are kept here, inside the managed folder
// (hidden folders aren't scanned, so they never show up as songs).
const ARCHIVE_DIR = ".wavemint-archive";

/** Inserts a file version for a track; returns its id. */
function insertFileRow(db, { trackId, sourceId, target, relRoot, snapshot, role = "active" }) {
  const stat = fs.statSync(target);
  const now = nowIso();
  return Number(
    db
      .prepare(
        `INSERT INTO files (track_id, source_id, path, path_key, rel_path, ext, size, mtime_ms, container, codec, lossless, bitrate,
           sample_rate, bit_depth, channels, duration_ms, tag_snapshot, artwork_hash, artwork_count, status, role, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)`,
      )
      .run(
        trackId,
        sourceId,
        target,
        pathKey(target),
        path.relative(relRoot, target),
        path.extname(target).toLowerCase(),
        stat.size,
        Math.round(stat.mtimeMs),
        snapshot.container ?? null,
        snapshot.codec ?? null,
        snapshot.lossless ?? null,
        snapshot.bitrate ?? null,
        snapshot.sampleRate ?? null,
        snapshot.bitDepth ?? null,
        snapshot.channels ?? null,
        snapshot.durationMs ?? null,
        JSON.stringify(snapshot),
        snapshot.artworkHash ?? null,
        snapshot.artworkCount ?? 0,
        role,
        now,
        now,
      ).lastInsertRowid,
  );
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function freeBytes(folder) {
  try {
    const stats = fs.statfsSync(folder);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function createConsolidator({ db, media, artStore, logger = console }) {
  function managedSource() {
    return db.prepare("SELECT * FROM sources WHERE role = 'managed' LIMIT 1").get() || null;
  }

  /** Creates (once) the managed source for `root`. */
  function ensureManagedSource(root) {
    const existing = managedSource();
    const resolved = path.resolve(root);
    if (existing) {
      if (pathKey(existing.root_path) !== pathKey(resolved)) {
        const used = db.prepare("SELECT COUNT(*) AS n FROM files WHERE source_id = ?").get(existing.id).n;
        if (used) {
          throw new Error(`Your managed library is already at "${existing.root_path}". It can't be moved by choosing another folder.`);
        }
        validateRoot(db, resolved, { ignoreId: existing.id });
        db.prepare("UPDATE sources SET root_path = ?, root_key = ? WHERE id = ?").run(resolved, pathKey(resolved), existing.id);
      }
      return db.prepare("SELECT * FROM sources WHERE id = ?").get(existing.id);
    }
    const { key } = validateRoot(db, resolved);
    const id = Number(
      db
        .prepare(
          `INSERT INTO sources (name, root_path, root_key, role, priority, read_only, status, created_at)
           VALUES ('WaveMint Library', ?, ?, 'managed', 90, 0, 'ok', ?)`,
        )
        .run(resolved, key, nowIso()).lastInsertRowid,
    );
    return db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
  }

  function candidates(trackIds) {
    const managed = managedSource();
    const filter = trackIds?.length ? `AND t.id IN (${trackIds.map(() => "?").join(",")})` : "";
    return db
      .prepare(
        `SELECT t.*, f.id AS file_id, f.path, f.ext, f.size, f.status AS file_status, f.tag_snapshot, f.source_id,
                (SELECT m.id FROM files m WHERE m.track_id = t.id AND m.source_id = ? AND m.id != t.active_file_id AND m.status = 'ok'
                   AND m.rel_path NOT LIKE '${ARCHIVE_DIR}%' ORDER BY m.id DESC LIMIT 1) AS reusable_file_id
         FROM tracks t JOIN files f ON f.id = t.active_file_id
         WHERE t.state = 'active' ${filter}
         ORDER BY t.album_artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no, t.title COLLATE NOCASE`,
      )
      .all(managed?.id ?? -1, ...(trackIds || []))
      .map((row) => {
        // A copy made earlier (e.g. before an undo) that still exists is reused.
        const reusable = row.reusable_file_id ? db.prepare("SELECT path FROM files WHERE id = ?").get(row.reusable_file_id) : null;
        return {
          ...row,
          managed: !!managed && row.source_id === managed.id,
          reusable_file_id: reusable && fs.existsSync(reusable.path) ? row.reusable_file_id : null,
        };
      });
  }

  /** Makes an earlier managed copy the active version again (no copying). */
  function reuseCopy({ track, operationId }) {
    const copy = db.prepare("SELECT * FROM files WHERE id = ?").get(track.reusable_file_id);
    transaction(db, () => {
      db.prepare("UPDATE files SET role = 'alternate' WHERE id = ?").run(track.active_file_id);
      db.prepare("UPDATE files SET role = 'active' WHERE id = ?").run(copy.id);
      const stale = tagDifferences(track, parseJson(copy.tag_snapshot, {})).length > 0;
      db.prepare("UPDATE tracks SET active_file_id = ?, tags_dirty = ?, updated_at = ? WHERE id = ?").run(copy.id, stale ? 1 : 0, nowIso(), track.id);
      logChange(db, operationId, { entityId: track.id, field: "active_file_id", oldValue: track.active_file_id, newValue: copy.id });
    });
  }

  /** What copying into `root` would do. Nothing is changed. */
  function preview({ root, pattern = DEFAULT_PATTERN, trackIds = null }) {
    validatePattern(pattern);
    const resolved = path.resolve(root);
    const managed = managedSource();
    if (!managed || pathKey(managed.root_path) !== pathKey(resolved)) validateRoot(db, resolved, { ignoreId: managed?.id ?? null });

    const rows = candidates(trackIds);
    const alreadyManaged = rows.filter((row) => row.managed);
    const unavailable = rows.filter((row) => !row.managed && !row.reusable_file_id && row.file_status !== "ok");
    const reused = rows.filter((row) => !row.managed && row.reusable_file_id);
    const todo = rows.filter((row) => !row.managed && !row.reusable_file_id && row.file_status === "ok");
    const planned = planPaths(
      todo.map((row) => ({ track: row, ext: row.ext })),
      { root: resolved, pattern, exists: (target) => fs.existsSync(target) },
    );
    const bytes = todo.reduce((sum, row) => sum + row.size, 0);
    const withTags = todo.filter((row) => canWriteTags(row.path) && (tagDifferences(row, parseJson(row.tag_snapshot, {})).length > 0));

    return {
      root: resolved,
      pattern,
      toCopy: todo.length,
      bytes,
      freeBytes: freeBytes(resolved),
      alreadyManaged: alreadyManaged.length,
      reused: reused.length,
      unavailable: unavailable.map((row) => ({ trackId: row.id, title: row.title, reason: row.file_status === "missing" ? "File missing" : "File unreadable" })).slice(0, 200),
      unavailableCount: unavailable.length,
      tagsWritten: withTags.length,
      renamedForCollisions: planned.filter((item) => /\(\d+\)\.[^.]+$/.test(item.relPath)).length,
      samples: planned.slice(0, 40).map((item) => ({ trackId: item.track.id, title: item.track.title, relPath: item.relPath })),
    };
  }

  function curatedFields(track) {
    const fields = {};
    for (const [field, def] of TAG_FIELDS) fields[field] = track[def.column];
    if (track.artwork_hash) {
      const art = artStore.read(track.artwork_hash, db);
      if (art) fields.artwork = art;
    }
    return fields;
  }

  function register({ track, sourceId, target, relRoot, operationId, stepId, snapshot }) {
    const now = nowIso();
    transaction(db, () => {
      const fileId = insertFileRow(db, { trackId: track.id, sourceId, target, relRoot, snapshot });
      const previous = db.prepare("SELECT active_file_id, tags_dirty FROM tracks WHERE id = ?").get(track.id);
      db.prepare("UPDATE files SET role = 'alternate' WHERE id = ?").run(previous.active_file_id);
      db.prepare("UPDATE tracks SET active_file_id = ?, tags_dirty = 0, updated_at = ? WHERE id = ?").run(fileId, now, track.id);
      logChange(db, operationId, { entityId: track.id, field: "active_file_id", oldValue: previous.active_file_id, newValue: fileId });
      updateStep(db, stepId, { state: "done", details: { trackId: track.id, newFileId: fileId, previousFileId: previous.active_file_id } });
    });
  }

  async function copyOne({ operationId, item, source, root }) {
    const track = item.track;
    const target = item.target;
    const staged = siblingPath(target, "wmtmp");
    const stepId = addStep(db, operationId, {
      action: "consolidate",
      fileId: track.file_id,
      trackId: track.id,
      targetPath: target,
      stagedPath: staged,
      details: { sourcePath: track.path },
    });

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(track.path, staged, fs.constants.COPYFILE_EXCL);
      const sourceHash = await sha256(track.path);
      if ((await sha256(staged)) !== sourceHash) throw new Error("The copy didn't match the original");
      updateStep(db, stepId, { state: "copied", details: { sourcePath: track.path, sourceHash } });

      // Curated metadata goes into the copy, never into the source.
      if (canWriteTags(staged)) {
        const wanted = { ...track };
        const differences = tagDifferences(wanted, readTags(staged));
        if (differences.length) {
          const audioBefore = await media.audioStreamHash(staged);
          writeTags(staged, curatedFields(track));
          const remaining = tagDifferences(wanted, readTags(staged)).map((change) => change.field);
          if (remaining.length) throw new Error(`Tags didn't read back correctly (${remaining.join(", ")})`);
          if ((await media.audioStreamHash(staged)) !== audioBefore) throw new Error("The audio stream changed while writing tags");
        }
      }
      updateStep(db, stepId, { state: "tagged" });

      if (fs.existsSync(target)) throw new Error("A file with this name appeared while copying; nothing was overwritten");
      fs.renameSync(staged, target);
      updateStep(db, stepId, { state: "placed" });

      const snapshot = readTags(target, { size: fs.statSync(target).size });
      register({ track, sourceId: source.id, target, relRoot: root, operationId, stepId, snapshot });
      quickSignature(target, fs.statSync(target).size)
        .then((sig) => db.prepare("UPDATE files SET quick_sig = ? WHERE path_key = ?").run(sig, pathKey(target)))
        .catch(() => {});
      return { ok: true, bytes: track.size };
    } catch (error) {
      fs.rmSync(staged, { force: true });
      updateStep(db, stepId, { state: "failed", error: error.message });
      logger.warn(`[library] Consolidation failed for ${track.title}: ${error.message}`);
      return { ok: false, error: error.message, title: track.title };
    }
  }

  async function consolidateJob({ root, pattern = DEFAULT_PATTERN, trackIds = null, signal, progress }) {
    validatePattern(pattern);
    const source = ensureManagedSource(root);
    const all = candidates(trackIds);
    const reusable = all.filter((row) => !row.managed && row.reusable_file_id);
    const rows = all.filter((row) => !row.managed && !row.reusable_file_id && row.file_status === "ok");
    const planned = planPaths(rows.map((row) => ({ track: row, ext: row.ext })), {
      root: source.root_path,
      pattern,
      exists: (target) => fs.existsSync(target),
    });

    const needed = rows.reduce((sum, row) => sum + row.size, 0);
    const free = freeBytes(source.root_path);
    if (free !== null && free < needed * 1.02) {
      throw new Error("There isn't enough free space at the destination for these songs.");
    }

    const count = planned.length + reusable.length;
    const operationId = startOperation(db, { kind: "consolidate", label: `Copy ${count} song${count === 1 ? "" : "s"} into the WaveMint Library` });
    const report = { copied: 0, reused: 0, failed: 0, bytes: 0, failures: [] };
    for (const track of reusable) {
      reuseCopy({ track, operationId });
      report.reused += 1;
    }

    for (const [index, item] of planned.entries()) {
      if (signal?.aborted) break;
      progress?.({ phase: "copying", done: index, total: planned.length, current: item.track.title });
      const result = await copyOne({ operationId, item, source, root: source.root_path });
      if (result.ok) {
        report.copied += 1;
        report.bytes += result.bytes;
      } else {
        report.failed += 1;
        if (report.failures.length < 50) report.failures.push({ title: result.title, error: result.error });
      }
    }

    const status = signal?.aborted ? "partial" : report.failed ? (report.copied ? "partial" : "failed") : "completed";
    db.prepare("UPDATE sources SET last_scan_completed_at = ? WHERE id = ?").run(nowIso(), source.id);
    finishOperation(db, operationId, status, { ...report, root: source.root_path, cancelled: !!signal?.aborted });
    return { operationId, status, ...report, root: source.root_path };
  }

  /** Switches songs back to the versions they used before consolidation. */
  function undoConsolidation(operationId) {
    const operation = db.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'consolidate'").get(Number(operationId));
    if (!operation) throw new Error("This change can't be undone.");
    if (db.prepare("SELECT 1 FROM operations WHERE undo_of = ? AND status IN ('completed', 'partial')").get(operation.id)) {
      throw new Error("This change was already undone.");
    }
    const changes = db.prepare("SELECT * FROM change_log WHERE operation_id = ? AND field = 'active_file_id'").all(operation.id);
    let undoId = null;
    transaction(db, () => {
      undoId = startOperation(db, { kind: "consolidate", label: `Undo: ${operation.label}`, undoOf: operation.id, undoable: false });
      for (const change of changes) {
        const previous = parseJson(change.old_value);
        const copy = parseJson(change.new_value);
        db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(previous, change.entity_id);
        db.prepare("UPDATE files SET role = 'active' WHERE id = ?").run(previous);
        // The managed copy stays on disk, kept as an archived version.
        db.prepare("UPDATE files SET role = 'archived' WHERE id = ?").run(copy);
        logChange(db, undoId, { entityId: change.entity_id, field: "active_file_id", oldValue: copy, newValue: previous });
      }
      finishOperation(db, undoId, "completed", { tracks: changes.length });
    });
    return { operationId: undoId, tracks: changes.length };
  }

  /** Finishes or cleans up consolidation steps interrupted by a crash. */
  function recover() {
    const report = [];
    const interrupted = db.prepare("SELECT * FROM operations WHERE kind = 'consolidate' AND status = 'running'").all();
    const source = managedSource();
    for (const operation of interrupted) {
      const steps = db.prepare("SELECT * FROM operation_steps WHERE operation_id = ? AND state NOT IN ('done', 'failed', 'rolled_back')").all(operation.id);
      for (const step of steps) {
        let outcome = "rolled_back";
        try {
          if (step.state === "placed" && source && fs.existsSync(step.target_path)) {
            const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(step.track_id);
            const already = db.prepare("SELECT id FROM files WHERE path_key = ?").get(pathKey(step.target_path));
            if (track && !already) {
              const snapshot = readTags(step.target_path, { size: fs.statSync(step.target_path).size });
              register({ track, sourceId: source.id, target: step.target_path, relRoot: source.root_path, operationId: operation.id, stepId: step.id, snapshot });
              outcome = "done";
            }
          }
          if (step.staged_path) fs.rmSync(step.staged_path, { force: true });
        } catch (error) {
          outcome = "failed";
          updateStep(db, step.id, { error: `Recovery: ${error.message}` });
        }
        if (outcome !== "done") updateStep(db, step.id, { state: outcome });
        report.push({ operationId: operation.id, trackId: step.track_id, outcome });
      }
      finishOperation(db, operation.id, "interrupted", { recoveredSteps: steps.length });
      logger.warn(`[library] Recovered interrupted consolidation ${operation.id}`);
    }
    return report;
  }

  return { consolidateJob, ensureManagedSource, managedSource, preview, recover, undoConsolidation };
}

module.exports = { ARCHIVE_DIR, TAG_FIELDS, createConsolidator, freeBytes, insertFileRow, sha256 };
