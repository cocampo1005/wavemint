// Safe, journaled file operations: writing tags into audio files, undoing
// those writes, and recovering after an interruption.
//
// Writing tags to one file:
//   1. Precheck: the source is writable, the format is editable, and the file
//      is unchanged since it was scanned.
//   2. Back up the original into <library>/backups/op-<id>/ (verified copy).
//   3. Copy it to "<name>.wmtmp<ext>" next to the original and write the tags
//      there (never into the original).
//   4. Verify: the tags read back as intended and the audio stream hash is
//      identical to the original's.
//   5. Swap: original -> "<name>.wmold<ext>", staged -> original, remove .wmold.
//   6. Update the database.
// Each step is recorded in operation_steps. If WaveMint stops in the middle,
// recover() puts the original back (or keeps the finished new file) and
// removes temporary files. Undo restores the backups.
//
// Saving an edit writes it through (service.cjs, writeThrough): only the
// changed fields are written, and a save within a day of an earlier one
// reuses that save's backup of the same file instead of copying it again.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { nowIso, parseJson, transaction } = require("./db.cjs");
const { FIELDS } = require("./edits.cjs");
const { addStep, finishOperation, startOperation, updateStep } = require("./operations.cjs");
const { quickSignature } = require("./scanner.cjs");
const { canWriteTags, readTags, writeTags } = require("./tags.cjs");

const TAG_FIELDS = Object.entries(FIELDS).filter(([, def]) => def.tag);

/** SHA-256 of a file's contents (hex); copies are verified with it. */
function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("close", () => resolve(hash.digest("hex")));
  });
}

/** Renames `from` to `to`, never overwriting an existing file. */
function moveFile(from, to) {
  if (fs.existsSync(to)) throw new Error(`"${path.basename(to)}" already exists; nothing was overwritten`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

// Windows scanners and players can briefly deny renames even after our own
// handles have closed. Retry only access/sharing errors, without overwriting
// destinations or changing permissions. Keep the worker responsive while waiting.
async function moveTagFile(from, to, validate = () => {}) {
  const delays = [100, 200, 400, 800, 1000];
  for (let attempt = 0; ; attempt += 1) {
    validate();
    try {
      moveFile(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      if (attempt === delays.length) {
        throw new Error(`Windows wouldn't allow replacing "${path.basename(from)}". The file may be in use or its folder may restrict changes. Close any player or file preview using this song, then try saving again.`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** `target`, or "name (2).ext", "name (3).ext"… if it's taken. */
function freePath(target) {
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  let candidate = target;
  for (let counter = 2; fs.existsSync(candidate); counter += 1) candidate = `${base} (${counter})${ext}`;
  return candidate;
}

function siblingPath(filePath, marker) {
  const ext = path.extname(filePath);
  return path.join(path.dirname(filePath), `${path.basename(filePath, ext)}.${marker}${ext}`);
}

function comparable(field, value) {
  if (value === null || value === undefined || value === "") return null;
  if (field === "compilation") return value ? 1 : 0;
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  return value;
}

/** Tag fields where the track (WaveMint) differs from the file's tags. */
function tagDifferences(track, snapshot) {
  const changes = [];
  for (const [field, def] of TAG_FIELDS) {
    const want = comparable(field, track[def.column]);
    const have = comparable(field, snapshot?.[field]);
    if (want !== have) changes.push({ field, file: snapshot?.[field] ?? null, track: track[def.column] ?? null });
  }
  if (track.artwork_hash && track.artwork_hash !== (snapshot?.artworkHash || null)) {
    changes.push({ field: "artwork", file: snapshot?.artworkHash || null, track: track.artwork_hash });
  }
  return changes;
}

function createFileOps({ db, media, artStore, backupsRoot, logger = console }) {
  function candidates(trackIds) {
    const where = trackIds?.length
      ? `t.id IN (${trackIds.map(() => "?").join(",")})`
      : "t.tags_dirty = 1";
    return db
      .prepare(
        `SELECT t.*, f.id AS file_id, f.path, f.ext, f.size, f.mtime_ms, f.status AS file_status, f.tag_snapshot,
                s.read_only, s.name AS source_name, s.role AS source_role
         FROM tracks t
         LEFT JOIN files f ON f.id = t.active_file_id
         LEFT JOIN sources s ON s.id = f.source_id
         WHERE t.state = 'active' AND ${where}
         LIMIT 20000`,
      )
      .all(...(trackIds || []));
  }

  /**
   * What writing tags would do. Returns { writable, blocked } where each
   * writable item lists its field changes and blocked items say why.
   */
  function previewTagWrite(trackIds = null) {
    const writable = [];
    const blocked = [];

    for (const row of candidates(trackIds)) {
      const snapshot = parseJson(row.tag_snapshot, {});
      const changes = tagDifferences(row, snapshot);
      const base = { trackId: row.id, title: row.title, artist: row.artist, fileId: row.file_id, path: row.path, source: row.source_name };
      if (!changes.length) continue;

      let reason = "";
      if (!row.file_id) reason = "No file";
      else if (row.file_status !== "ok") reason = row.file_status === "missing" ? "File is missing" : "File can't be read";
      else if (row.read_only) reason = `"${row.source_name}" is read-only. Changes stay in WaveMint and are written when you consolidate into your managed library.`;
      else if (!canWriteTags(row.path)) reason = `WaveMint doesn't edit ${row.ext.toUpperCase().slice(1)} tags`;

      if (reason) blocked.push({ ...base, reason, changes });
      else writable.push({ ...base, changes });
    }

    return { writable, blocked };
  }

  /**
   * A verified backup of this file made by an earlier save within
   * `withinMs` that is still on disk, or null. Saving the same song again
   * shortly after doesn't copy the whole file again: the earliest copy is the
   * recovery point, and every later state is in the database's change log.
   */
  function recentBackup(fileId, withinMs) {
    if (!withinMs) return null;
    const since = new Date(Date.now() - withinMs).toISOString();
    const rows = db
      .prepare(
        `SELECT s.backup_path, s.details FROM operation_steps s JOIN operations o ON o.id = s.operation_id
         WHERE s.file_id = ? AND s.action = 'write-tags' AND s.state = 'done' AND o.created_at >= ?
           AND json_extract(s.details, '$.backupReused') IS NULL
         ORDER BY s.id DESC LIMIT 5`,
      )
      .all(fileId, since);
    return rows.find((row) => row.backup_path && fs.existsSync(row.backup_path))?.backup_path || null;
  }

  async function writeOne(operationId, item, backupDir, { reuseBackupMs = 0 } = {}) {
    const file = db
      .prepare("SELECT f.*, s.read_only FROM files f JOIN sources s ON s.id = f.source_id WHERE f.id = ?")
      .get(item.fileId);
    const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(item.trackId);
    const target = file.path;
    const staged = siblingPath(target, "wmtmp");
    // A previous save may have left a copy held open by a Windows player.
    // Never require deleting that copy to save again, or overwrite it.
    const old = freePath(siblingPath(target, "wmold"));
    const reused = recentBackup(file.id, reuseBackupMs);
    const backup = reused || path.join(backupDir, `${file.id}-${path.basename(target)}`);
    const stepId = addStep(db, operationId, {
      action: "write-tags",
      fileId: file.id,
      trackId: track.id,
      targetPath: target,
      stagedPath: staged,
      backupPath: backup,
      details: { oldPath: old },
    });

    try {
      // 1. Precheck: the song still uses this file, and it's unchanged since the scan.
      if (track.active_file_id !== file.id) throw new Error("The song's file changed while saving; nothing was written");
      if (file.read_only) throw new Error("The source is read-only");
      if (!canWriteTags(target)) throw new Error("This format isn't edited by WaveMint");
      const stat = fs.statSync(target);
      if (stat.size !== file.size || Math.round(stat.mtimeMs) !== file.mtime_ms) {
        throw new Error("The file changed since it was scanned. Rescan the source, then try again.");
      }

      // 2. Verified backup (or a recent one of the same file, still on disk).
      const originalHash = await sha256(target);
      if (!reused) {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
        if ((await sha256(backup)) !== originalHash) throw new Error("The backup copy didn't match the original");
      }
      updateStep(db, stepId, { state: "backed_up", details: { oldPath: old, originalHash, ...(reused ? { backupReused: true } : {}) } });

      // 3. Stage and write. Only the fields that differ are written, so
      // everything else in the file's tags (extra genres, other frames) stays
      // exactly as it was.
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(target, staged);
      const differences = new Set(tagDifferences(track, parseJson(file.tag_snapshot, {})).map((change) => change.field));
      const fields = {};
      for (const [field, def] of TAG_FIELDS) if (differences.has(field)) fields[field] = track[def.column];
      if (track.artwork_hash && differences.has("artwork")) {
        const art = artStore.read(track.artwork_hash, db);
        if (!art) throw new Error("The chosen artwork image is no longer available");
        fields.artwork = art;
      }
      writeTags(staged, fields);
      updateStep(db, stepId, { state: "staged" });

      // 4. Verify tags and audio.
      const written = readTags(staged, { size: fs.statSync(staged).size });
      const mismatched = tagDifferences({ ...track, artwork_hash: track.artwork_hash }, written).map((change) => change.field);
      if (mismatched.length) throw new Error(`The new tags didn't read back correctly (${mismatched.join(", ")})`);
      const [audioBefore, audioAfter] = await Promise.all([media.audioStreamHash(target), media.audioStreamHash(staged)]);
      if (audioBefore !== audioAfter) throw new Error("The audio stream changed while writing tags; the original was kept");
      updateStep(db, stepId, { state: "verified" });

      // 5. Swap with a way back at every point.
      await moveTagFile(target, old, () => {
        const current = fs.statSync(target);
        if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
          throw new Error("The file changed while saving. Rescan the source, then try again.");
        }
      });
      try {
        await moveTagFile(staged, target);
      } catch (error) {
        await moveTagFile(old, target);
        throw error;
      }
      // Windows players/virus scanners can keep the renamed file open.
      // Cleanup failure must not roll back the database after a successful swap.
      try { fs.rmSync(old, { force: true }); } catch (error) {
        logger.warn(`[library] Old tag copy retained for cleanup: ${error.code}`);
      }
      const newHash = await sha256(target);
      updateStep(db, stepId, { state: "swapped", details: { oldPath: old, originalHash, newHash, ...(reused ? { backupReused: true } : {}) } });

      // 6. Database. The audio stream is verified unchanged, so a quality
      // check of the file stays valid for the new size and time.
      const newStat = fs.statSync(target);
      const snapshot = readTags(target, { size: newStat.size });
      transaction(db, () => {
        db.prepare("UPDATE quality_checks SET size = ?, mtime_ms = ? WHERE file_id = ? AND size = ? AND mtime_ms = ?").run(
          newStat.size,
          Math.round(newStat.mtimeMs),
          file.id,
          file.size,
          Math.round(file.mtime_ms),
        );
        db.prepare(
          `UPDATE files SET size = ?, mtime_ms = ?, quick_sig = ?, content_hash = ?, audio_hash = ?, tag_snapshot = ?,
             artwork_hash = ?, artwork_count = ?, last_seen_at = ? WHERE id = ?`,
        ).run(
          newStat.size,
          Math.round(newStat.mtimeMs),
          null,
          newHash,
          audioAfter,
          JSON.stringify(snapshot),
          snapshot.artworkHash,
          snapshot.artworkCount,
          nowIso(),
          file.id,
        );
        db.prepare("UPDATE tracks SET tags_dirty = 0 WHERE id = ?").run(track.id);
        updateStep(db, stepId, { state: "done" });
      });
      await quickSignature(target, newStat.size)
        .then((sig) => db.prepare("UPDATE files SET quick_sig = ? WHERE id = ?").run(sig, file.id))
        .catch(() => {});
      return { ok: true };
    } catch (error) {
      fs.rmSync(staged, { force: true });
      updateStep(db, stepId, { state: "failed", error: error.message });
      logger.warn(`[library] Tag write failed for ${path.basename(target)}: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  /**
   * Writes WaveMint's tags into the files of `trackIds` (every song with
   * unsaved tags when null). Write Tags is its own undoable operation; a save
   * passes `partOf` (the edit it belongs to: undoing that edit writes the old
   * values back), which makes this one a non-undoable record of the file step
   * and lets it reuse a recent backup of the same file.
   * Returns { written, failed, blocked, operationId, results: [{ trackId, ok, error? }] }.
   */
  async function writeTagsJob({ trackIds = null, signal, progress, partOf = null, reuseBackupMs = 0 } = {}) {
    const { writable, blocked } = previewTagWrite(trackIds);
    if (!writable.length) return { written: 0, failed: 0, blocked: blocked.length, operationId: null, results: [] };

    const files = `${writable.length} file${writable.length === 1 ? "" : "s"}`;
    const operationId = startOperation(db, {
      kind: "tag-write",
      label: partOf ? `Save to ${files}` : `Write tags to ${files}`,
      undoable: !partOf,
    });
    const backupDir = path.join(backupsRoot, `op-${operationId}`);
    const results = [];

    for (const [index, item] of writable.entries()) {
      if (signal?.aborted) break;
      progress?.({ phase: "writing", done: index, total: writable.length, current: item.title });
      const result = await writeOne(operationId, item, backupDir, { reuseBackupMs });
      results.push({ trackId: item.trackId, ...result });
    }

    const written = results.filter((result) => result.ok).length;
    const failed = results.length - written;
    const status = signal?.aborted ? "partial" : failed ? (written ? "partial" : "failed") : "completed";
    finishOperation(db, operationId, status, { written, failed, blocked: blocked.length, backupDir, ...(partOf ? { partOf } : {}) });
    return { written, failed, blocked: blocked.length, operationId, results };
  }

  /** Restores the files changed by a tag-write operation from its backups. */
  async function undoTagWrite(operationId) {
    const operation = db.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'tag-write'").get(Number(operationId));
    if (!operation) throw new Error("This file change can't be undone.");
    if (db.prepare("SELECT 1 FROM operations WHERE undo_of = ? AND status IN ('completed', 'partial')").get(operation.id)) {
      throw new Error("This change was already undone.");
    }

    const steps = db.prepare("SELECT * FROM operation_steps WHERE operation_id = ? AND state = 'done' ORDER BY seq DESC").all(operation.id);
    const undoId = startOperation(db, { kind: "tag-restore", label: `Undo: ${operation.label}`, undoOf: operation.id, undoable: false });
    let restored = 0;
    const conflicts = [];

    for (const step of steps) {
      const details = parseJson(step.details, {});
      const target = step.target_path;
      try {
        if (!fs.existsSync(step.backup_path)) throw new Error("The backup is missing");
        if (!fs.existsSync(target)) throw new Error("The file is no longer there");
        if ((await sha256(target)) !== details.newHash) throw new Error("The file was changed again after WaveMint wrote it");

        const staged = siblingPath(target, "wmtmp");
        const old = freePath(siblingPath(target, "wmold"));
        fs.copyFileSync(step.backup_path, staged);
        if ((await sha256(staged)) !== details.originalHash) throw new Error("The backup didn't verify");
        moveFile(target, old);
        try {
          fs.renameSync(staged, target);
        } catch (error) {
          fs.renameSync(old, target);
          throw error;
        }
        try { fs.rmSync(old, { force: true }); } catch (error) {
          logger.warn(`[library] Old tag copy retained for cleanup: ${error.code}`);
        }

        const stat = fs.statSync(target);
        const snapshot = readTags(target, { size: stat.size });
        db.prepare(
          `UPDATE files SET size = ?, mtime_ms = ?, content_hash = ?, tag_snapshot = ?, artwork_hash = ?, artwork_count = ? WHERE id = ?`,
        ).run(stat.size, Math.round(stat.mtimeMs), details.originalHash, JSON.stringify(snapshot), snapshot.artworkHash, snapshot.artworkCount, step.file_id);
        // The database still holds the edited values, so the tags are now
        // "unsaved" again until written (or the edit itself is undone).
        db.prepare("UPDATE tracks SET tags_dirty = 1 WHERE id = ?").run(step.track_id);
        restored += 1;
      } catch (error) {
        fs.rmSync(siblingPath(target, "wmtmp"), { force: true });
        conflicts.push({ fileId: step.file_id, error: error.message });
      }
    }

    finishOperation(db, undoId, conflicts.length ? (restored ? "partial" : "failed") : "completed", { restored, conflicts: conflicts.length });
    return { operationId: undoId, restored, conflicts };
  }

  /**
   * Called when the worker starts. Any file operation left "running" was
   * interrupted (crash, power loss): restore originals and clean up.
   */
  function recover() {
    // Consolidations are recovered by consolidate.cjs.
    const interrupted = db
      .prepare("SELECT * FROM operations WHERE status = 'running' AND kind IN ('tag-write', 'tag-restore')")
      .all();
    const report = [];

    for (const operation of interrupted) {
      const steps = db
        .prepare("SELECT * FROM operation_steps WHERE operation_id = ? AND state NOT IN ('done', 'failed', 'rolled_back')")
        .all(operation.id);

      for (const step of steps) {
        const target = step.target_path;
        if (!target) continue;
        const old = parseJson(step.details, {}).oldPath || siblingPath(target, "wmold");
        const staged = step.staged_path || siblingPath(target, "wmtmp");
        let outcome = "rolled_back";
        try {
          if (fs.existsSync(old) && !fs.existsSync(target)) {
            fs.renameSync(old, target); // the swap stopped half-way: put the original back
          } else if (fs.existsSync(old) && fs.existsSync(target)) {
            fs.rmSync(old, { force: true }); // the new file was in place; the original is in backups
            outcome = "recovered";
          }
          fs.rmSync(staged, { force: true });
        } catch (error) {
          outcome = "failed";
          updateStep(db, step.id, { error: `Recovery: ${error.message}` });
        }
        updateStep(db, step.id, { state: outcome });
        report.push({ operationId: operation.id, fileId: step.file_id, outcome });
      }

      finishOperation(db, operation.id, "interrupted", { recoveredSteps: steps.length });
      logger.warn(`[library] Recovered interrupted operation ${operation.id} (${operation.label})`);
    }

    return report;
  }

  return { previewTagWrite, recover, undoTagWrite, writeTagsJob };
}

module.exports = { TAG_FIELDS, createFileOps, freePath, moveFile, sha256, siblingPath, tagDifferences };
