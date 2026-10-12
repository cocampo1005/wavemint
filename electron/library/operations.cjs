// The operations journal: every change WaveMint makes to the library
// (database edits and file operations) is recorded as an operation, so it can
// be reviewed in History and, where possible, undone.

const { nowIso, parseJson } = require("./db.cjs");

function startOperation(db, { kind, label, undoable = true, undoOf = null }) {
  return Number(
    db
      .prepare(
        `INSERT INTO operations (kind, label, status, undoable, undo_of, created_at)
         VALUES (?, ?, 'running', ?, ?, ?)`,
      )
      .run(kind, String(label).slice(0, 300), undoable ? 1 : 0, undoOf, nowIso()).lastInsertRowid,
  );
}

function finishOperation(db, id, status, summary = null) {
  db.prepare("UPDATE operations SET status = ?, summary = ?, finished_at = ? WHERE id = ?").run(
    status,
    summary === null ? null : JSON.stringify(summary),
    nowIso(),
    id,
  );
}

function addStep(db, operationId, step) {
  const seq =
    db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM operation_steps WHERE operation_id = ?").get(operationId).next;
  return Number(
    db
      .prepare(
        `INSERT INTO operation_steps (operation_id, seq, action, state, file_id, track_id, target_path, staged_path, backup_path, details, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        seq,
        step.action,
        step.fileId ?? null,
        step.trackId ?? null,
        step.targetPath ?? null,
        step.stagedPath ?? null,
        step.backupPath ?? null,
        step.details ? JSON.stringify(step.details) : null,
        nowIso(),
      ).lastInsertRowid,
  );
}

function updateStep(db, stepId, patch) {
  const columns = Object.keys(patch);
  if (!columns.length) return;
  const values = columns.map((column) => (column === "details" && patch[column] !== null ? JSON.stringify(patch[column]) : patch[column]));
  db.prepare(`UPDATE operation_steps SET ${columns.map((column) => `${column} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...values,
    nowIso(),
    stepId,
  );
}

function logChange(db, operationId, { entityType = "track", entityId, field, oldValue, newValue }) {
  db.prepare(
    `INSERT INTO change_log (operation_id, entity_type, entity_id, field, old_value, new_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(operationId, entityType, entityId, field, JSON.stringify(oldValue ?? null), JSON.stringify(newValue ?? null), nowIso());
}

function listOperations(db, { limit = 100, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM change_log c WHERE c.operation_id = o.id) AS change_count,
              (SELECT COUNT(DISTINCT c.entity_id) FROM change_log c WHERE c.operation_id = o.id) AS entity_count,
              (SELECT COUNT(*) FROM operation_steps s WHERE s.operation_id = o.id) AS step_count,
              (SELECT COUNT(*) FROM operation_steps s WHERE s.operation_id = o.id AND s.state = 'done') AS steps_done,
              (SELECT COUNT(*) FROM operation_steps s WHERE s.operation_id = o.id AND s.state = 'failed') AS steps_failed,
              EXISTS (SELECT 1 FROM operations u WHERE u.undo_of = o.id AND u.status IN ('completed', 'partial')) AS was_undone
       FROM operations o ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(Math.min(500, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0))
    .map((row) => ({ ...row, summary: parseJson(row.summary, null), was_undone: !!row.was_undone }));
}

function getOperationDetail(db, id) {
  const operation = db.prepare("SELECT * FROM operations WHERE id = ?").get(Number(id));
  if (!operation) return null;
  return {
    ...operation,
    summary: parseJson(operation.summary, null),
    changes: db
      .prepare(
        `SELECT c.*, COALESCE(t.title, ft.title) AS track_title, COALESCE(t.artist, ft.artist) AS track_artist, other.title AS other_title
         FROM change_log c
         LEFT JOIN tracks t ON c.entity_type IN ('track', 'decision') AND t.id = c.entity_id
         LEFT JOIN files f ON c.entity_type = 'file' AND f.id = c.entity_id
         LEFT JOIN tracks ft ON ft.id = f.track_id
         LEFT JOIN tracks other ON other.id = CASE
           WHEN c.field = 'merged_into' THEN CAST(c.new_value AS INTEGER)
           WHEN c.entity_type = 'decision' THEN json_extract(c.new_value, '$.other')
         END
         WHERE c.operation_id = ? ORDER BY c.id LIMIT 500`,
      )
      .all(operation.id)
      .map((row) => ({ ...row, old_value: parseJson(row.old_value), new_value: parseJson(row.new_value) })),
    steps: db
      .prepare("SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY seq LIMIT 500")
      .all(operation.id)
      .map((row) => ({ ...row, details: parseJson(row.details, null) })),
  };
}

module.exports = { addStep, finishOperation, getOperationDetail, listOperations, logChange, startOperation, updateStep };
