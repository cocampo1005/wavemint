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
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Renames `from` to `to`, never overwriting an existing file. */
function moveFile(from, to) {
  if (fs.existsSync(to)) throw new Error(`"${path.basename(to)}" already exists; nothing was overwritten`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
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

  async function writeOne(operationId, item, backupDir) {
    const file = db
      .prepare("SELECT f.*, s.read_only FROM files f JOIN sources s ON s.id = f.source_id WHERE f.id = ?")
      .get(item.fileId);
    const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(item.trackId);
    const target = file.path;
    const staged = siblingPath(target, "wmtmp");
    const backup = path.join(backupDir, `${file.id}-${path.basename(target)}`);
    const stepId = addStep(db, operationId, {
      action: "write-tags",
      fileId: file.id,
      trackId: track.id,
      targetPath: target,
      stagedPath: staged,
      backupPath: backup,
    });

    try {
      // 1. Precheck.
      if (file.read_only) throw new Error("The source is read-only");
      if (!canWriteTags(target)) throw new Error("This format isn't edited by WaveMint");
      const stat = fs.statSync(target);
      if (stat.size !== file.size || Math.round(stat.mtimeMs) !== file.mtime_ms) {
        throw new Error("The file changed since it was scanned. Rescan the source, then try again.");
      }

      // 2. Verified backup.
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
      const originalHash = await sha256(target);
      if ((await sha256(backup)) !== originalHash) throw new Error("The backup copy didn't match the original");
      updateStep(db, stepId, { state: "backed_up", details: { originalHash } });

      // 3. Stage and write.
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(target, staged);
      const fields = {};
      for (const [field, def] of TAG_FIELDS) fields[field] = track[def.column];
      if (track.artwork_hash) {
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
      const old = siblingPath(target, "wmold");
      fs.rmSync(old, { force: true });
      fs.renameSync(target, old);
      try {
        fs.renameSync(staged, target);
      } catch (error) {
        fs.renameSync(old, target);
        throw error;
      }
      fs.rmSync(old, { force: true });
      const newHash = await sha256(target);
      updateStep(db, stepId, { state: "swapped", details: { originalHash, newHash } });

      // 6. Database.
      const newStat = fs.statSync(target);
      const snapshot = readTags(target, { size: newStat.size });
      transaction(db, () => {
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
      quickSignature(target, newStat.size)
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

  async function writeTagsJob({ trackIds = null, signal, progress } = {}) {
    const { writable, blocked } = previewTagWrite(trackIds);
    if (!writable.length) return { written: 0, failed: 0, blocked: blocked.length, operationId: null };

    const operationId = startOperation(db, { kind: "tag-write", label: `Write tags to ${writable.length} file${writable.length === 1 ? "" : "s"}` });
    const backupDir = path.join(backupsRoot, `op-${operationId}`);
    let written = 0;
    let failed = 0;

    for (const [index, item] of writable.entries()) {
      if (signal?.aborted) break;
      progress?.({ phase: "writing", done: index, total: writable.length, current: item.title });
      const result = await writeOne(operationId, item, backupDir);
      if (result.ok) written += 1;
      else failed += 1;
    }

    const status = signal?.aborted ? "partial" : failed ? (written ? "partial" : "failed") : "completed";
    finishOperation(db, operationId, status, { written, failed, blocked: blocked.length, backupDir });
    return { written, failed, blocked: blocked.length, operationId };
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
        const old = siblingPath(target, "wmold");
        fs.copyFileSync(step.backup_path, staged);
        if ((await sha256(staged)) !== details.originalHash) throw new Error("The backup didn't verify");
        fs.renameSync(target, old);
        try {
          fs.renameSync(staged, target);
        } catch (error) {
          fs.renameSync(old, target);
          throw error;
        }
        fs.rmSync(old, { force: true });

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
        const old = siblingPath(target, "wmold");
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
