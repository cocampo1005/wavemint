// Multi-source merge: analysis, review decisions and applying the result.
//
// Analysis never changes anything except cached content hashes. Applying a
// merge only links file versions under one logical track in the database —
// no file is copied, moved, renamed or deleted (copying into the Managed
// Library is a separate, explicit step; see consolidate.cjs).

const { nowIso, parseJson, transaction } = require("./db.cjs");
const { applyEdits } = require("./edits.cjs");
const { similar } = require("./genres.cjs");
const { albumConsolidation, buildGroups, pairKey } = require("./match.cjs");
const { finishOperation, logChange, startOperation } = require("./operations.cjs");
const { refreshTrackSearch } = require("./search.cjs");

const ACTIONS = ["keep_preferred", "merge_metadata", "keep_both", "skip", "keep", "review"];
const MERGE_ACTIONS = new Set(["keep_preferred", "merge_metadata"]);
const FILL_FIELDS = ["album_artist", "album", "genre", "year", "track_no", "track_total", "disc_no", "disc_total", "composer"];

function loadTracks(db) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.release_id, t.duration_ms, t.track_no, t.disc_no,
              t.mb_recording_id, t.genre, t.year,
              f.id AS file_id, f.path, f.size, f.quick_sig, f.content_hash, f.codec, f.bitrate, f.lossless, f.status AS file_status,
              s.id AS source_id, s.name AS source_name, s.role AS source_role, s.priority AS source_priority
       FROM tracks t
       JOIN files f ON f.id = t.active_file_id
       JOIN sources s ON s.id = f.source_id
       WHERE t.state = 'active'`,
    )
    .all();
}

function loadDecisions(db) {
  return new Map(db.prepare("SELECT track_a, track_b, decision FROM match_decisions").all().map((row) => [pairKey(row.track_a, row.track_b), row.decision]));
}

function recordDecision(db, a, b, decision) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT INTO match_decisions (track_a, track_b, decision, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(track_a, track_b) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
  ).run(x, y, decision, nowIso());
}

/** Records a decision as part of an operation, so undo can restore the previous one. */
function logDecision(db, operationId, a, b, decision) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const previous = db.prepare("SELECT decision FROM match_decisions WHERE track_a = ? AND track_b = ?").get(x, y)?.decision ?? null;
  if (previous === decision) return;
  recordDecision(db, x, y, decision);
  logChange(db, operationId, { entityType: "decision", entityId: x, field: "decision", oldValue: { other: y, decision: previous }, newValue: { other: y, decision } });
}

function createMerge({ db, contentHash, logger = console }) {
  /** Full hashes only where cheap signatures collide (possible exact copies). */
  async function hashCollisions(tracks, { signal, progress } = {}) {
    const bySig = new Map();
    for (const track of tracks) {
      if (!track.quick_sig || track.content_hash || track.file_status !== "ok") continue;
      if (!bySig.has(track.quick_sig)) bySig.set(track.quick_sig, []);
      bySig.get(track.quick_sig).push(track);
    }
    const collisions = [...bySig.values()].filter((list) => list.length > 1).flat();
    for (const [index, track] of collisions.entries()) {
      if (signal?.aborted) return;
      progress?.({ phase: "hashing", done: index, total: collisions.length });
      try {
        track.content_hash = await contentHash(track.path);
        db.prepare("UPDATE files SET content_hash = ? WHERE id = ?").run(track.content_hash, track.file_id);
      } catch (error) {
        logger.warn(`[library] Could not hash ${track.path}: ${error.message}`);
      }
    }
  }

  async function analyze({ signal, progress } = {}) {
    progress?.({ phase: "loading" });
    const tracks = loadTracks(db);
    await hashCollisions(tracks, { signal, progress });
    if (signal?.aborted) throw new Error("Cancelled");

    progress?.({ phase: "matching", total: tracks.length });
    const { groups, conflicts } = buildGroups(tracks, { decisions: loadDecisions(db) });
    const tracksById = new Map(tracks.map((track) => [track.id, track]));

    const sessionId = transaction(db, () => {
      db.prepare("UPDATE merge_sessions SET status = 'discarded' WHERE status = 'analyzed'").run();
      const id = Number(db.prepare("INSERT INTO merge_sessions (status, created_at) VALUES ('analyzed', ?)").run(nowIso()).lastInsertRowid);
      const insert = db.prepare(
        `INSERT INTO merge_groups (session_id, category, confidence, track_ids, preferred_track_id, suggested_action, action, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const group of [...groups, ...conflicts]) {
        const suggested = group.category === "conflict" ? "review" : group.trackIds.length > 1 ? "keep_preferred" : "keep";
        insert.run(
          id,
          group.category,
          group.confidence,
          JSON.stringify(group.trackIds),
          group.preferredTrackId,
          suggested,
          suggested,
          JSON.stringify({ exact: !!group.exact, pairs: group.evidence }),
        );
      }
      return id;
    });

    const summary = summarize(sessionId, tracksById);
    db.prepare("UPDATE merge_sessions SET summary = ? WHERE id = ?").run(JSON.stringify(summary), sessionId);
    return { sessionId, summary };
  }

  function sessionGroups(sessionId) {
    return db
      .prepare("SELECT * FROM merge_groups WHERE session_id = ?")
      .all(sessionId)
      .map((row) => ({ ...row, trackIds: JSON.parse(row.track_ids), evidence: parseJson(row.evidence, {}) }));
  }

  function summarize(sessionId, tracksById = new Map(loadTracks(db).map((track) => [track.id, track]))) {
    const groups = sessionGroups(sessionId);
    const recordings = groups.filter((group) => group.category !== "conflict");
    const conflicts = groups.filter((group) => group.category === "conflict");
    const count = (category) => recordings.filter((group) => group.category === category).length;

    // Each conflict resolved as "keep_preferred" merges two recordings.
    const mergedConflicts = conflicts.filter((group) => MERGE_ACTIONS.has(group.action)).length;
    const splitGroups = recordings.filter((group) => group.trackIds.length > 1 && (group.action === "keep_both" || group.action === "skip"));
    const expected = recordings.length - mergedConflicts + splitGroups.reduce((sum, group) => sum + group.trackIds.length - 1, 0);

    let storage = 0;
    for (const group of recordings) {
      if (group.trackIds.length > 1 && !MERGE_ACTIONS.has(group.action)) {
        for (const id of group.trackIds) storage += tracksById.get(id)?.size || 0;
      } else {
        storage += tracksById.get(group.preferred_track_id)?.size || 0;
      }
    }

    const releases = new Map(db.prepare("SELECT * FROM releases").all().map((release) => [release.id, release]));
    const albums = albumConsolidation({
      groups: recordings.map((group) => ({ ...group, trackIds: group.trackIds, preferredTrackId: group.preferred_track_id, action: group.action })),
      tracksById,
      releasesById: releases,
      similarTitles: similar,
    });

    return {
      sourceTracks: tracksById.size,
      recordings: recordings.length,
      alreadyCurated: count("already_curated"),
      legacyOnly: count("legacy_only"),
      curatedOnly: count("curated_only"),
      otherOnly: count("other_only"),
      exactDuplicateGroups: recordings.filter((group) => group.evidence?.exact || group.evidence?.pairs?.some((pair) => pair.verdict === "exact")).length,
      duplicateGroups: recordings.filter((group) => group.trackIds.length > 1).length,
      conflicts: conflicts.length,
      undecidedConflicts: conflicts.filter((group) => group.action === "review").length,
      expectedTracks: expected,
      storageBytes: storage,
      albumProposals: albums.proposals,
      albumNotes: albums.notes,
      sources: db
        .prepare(
          `SELECT s.id, s.name, s.role, s.priority, COUNT(t.id) AS tracks FROM sources s
           LEFT JOIN files f ON f.source_id = s.id LEFT JOIN tracks t ON t.active_file_id = f.id AND t.state = 'active'
           GROUP BY s.id ORDER BY s.priority DESC`,
        )
        .all(),
    };
  }

  function currentSession() {
    const session = db.prepare("SELECT * FROM merge_sessions WHERE status IN ('analyzed', 'applied') ORDER BY id DESC LIMIT 1").get();
    if (!session) return null;
    return { ...session, summary: session.status === "analyzed" ? summarize(session.id) : parseJson(session.summary, {}) };
  }

  function listGroups({ sessionId, category, onlyMulti = false, offset = 0, limit = 50 }) {
    const where = ["session_id = ?"];
    const params = [sessionId];
    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    if (onlyMulti) where.push("json_array_length(track_ids) > 1");
    const total = db.prepare(`SELECT COUNT(*) AS n FROM merge_groups WHERE ${where.join(" AND ")}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT * FROM merge_groups WHERE ${where.join(" AND ")}
         ORDER BY category = 'conflict' DESC, json_array_length(track_ids) DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...params, Math.min(500, limit), Math.max(0, offset));

    const memberQuery = db.prepare(
      `SELECT t.id, t.title, t.artist, t.album, t.year, t.genre, t.duration_ms, t.track_no,
              COALESCE(t.artwork_hash, f.artwork_hash) AS artwork_hash,
              f.id AS file_id, f.codec, f.bitrate, f.lossless, f.sample_rate, f.bit_depth, f.size, f.rel_path,
              s.name AS source_name, s.role AS source_role
       FROM tracks t JOIN files f ON f.id = t.active_file_id JOIN sources s ON s.id = f.source_id WHERE t.id = ?`,
    );

    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        trackIds: JSON.parse(row.track_ids),
        evidence: parseJson(row.evidence, {}),
        members: JSON.parse(row.track_ids).map((id) => memberQuery.get(id)).filter(Boolean),
      })),
    };
  }

  function setGroupAction({ groupId, action, preferredTrackId }) {
    if (!ACTIONS.includes(action)) throw new Error("Unknown merge action");
    const group = db.prepare("SELECT * FROM merge_groups WHERE id = ?").get(Number(groupId));
    if (!group) throw new Error("This group no longer exists. Analyze again.");
    const ids = JSON.parse(group.track_ids);
    const preferred = preferredTrackId ?? group.preferred_track_id;
    if (!ids.includes(Number(preferred))) throw new Error("The preferred song must be one of the group's songs.");
    db.prepare("UPDATE merge_groups SET action = ?, preferred_track_id = ?, decided = 1 WHERE id = ?").run(action, Number(preferred), group.id);
    return { id: group.id, action };
  }

  /** Accepts the suggested action for undecided groups in the given categories. */
  function acceptSuggestions({ sessionId, categories }) {
    const allowed = categories.filter((category) => category !== "conflict");
    const result = db
      .prepare(
        `UPDATE merge_groups SET action = suggested_action, decided = 1
         WHERE session_id = ? AND decided = 0 AND category IN (${allowed.map(() => "?").join(",") || "''"})`,
      )
      .run(sessionId, ...allowed);
    return { updated: Number(result.changes) };
  }

  /**
   * Applies the session: links file versions of merged recordings under the
   * preferred track, records decisions, and (optionally) applies accepted
   * album consolidations. One undoable operation.
   */
  function apply({ sessionId, acceptedAlbums = [] }) {
    const session = db.prepare("SELECT * FROM merge_sessions WHERE id = ? AND status = 'analyzed'").get(Number(sessionId));
    if (!session) throw new Error("This analysis is out of date. Analyze again.");
    const groups = sessionGroups(session.id);
    const summary = summarize(session.id);

    let operationId = null;
    let linked = 0;
    let decisions = 0;
    const touched = new Set();

    transaction(db, () => {
      operationId = startOperation(db, { kind: "merge", label: "Merge library sources" });

      for (const group of groups) {
        const ids = group.trackIds;
        const preferred = group.preferred_track_id;

        if (MERGE_ACTIONS.has(group.action) && ids.length > 1) {
          const keep = db.prepare("SELECT * FROM tracks WHERE id = ? AND state = 'active'").get(preferred);
          if (!keep) continue;

          for (const id of ids) {
            if (id === preferred) continue;
            const other = db.prepare("SELECT * FROM tracks WHERE id = ? AND state = 'active'").get(id);
            if (!other) continue;

            if (group.action === "merge_metadata") {
              // Fill only what the preferred track is missing.
              for (const field of FILL_FIELDS) {
                const current = db.prepare(`SELECT ${field} AS value FROM tracks WHERE id = ?`).get(preferred).value;
                if ((current === null || current === "") && other[field] !== null && other[field] !== "") {
                  db.prepare(`UPDATE tracks SET ${field} = ? WHERE id = ?`).run(other[field], preferred);
                  logChange(db, operationId, { entityId: preferred, field, oldValue: current, newValue: other[field] });
                }
              }
            }

            for (const file of db.prepare("SELECT id, role FROM files WHERE track_id = ?").all(id)) {
              db.prepare("UPDATE files SET track_id = ?, role = 'alternate' WHERE id = ?").run(preferred, file.id);
              logChange(db, operationId, { entityType: "file", entityId: file.id, field: "track_id", oldValue: id, newValue: preferred });
              logChange(db, operationId, { entityType: "file", entityId: file.id, field: "role", oldValue: file.role, newValue: "alternate" });
            }
            db.prepare("UPDATE tracks SET state = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(preferred, nowIso(), id);
            logChange(db, operationId, { entityId: id, field: "state", oldValue: "active", newValue: "merged" });
            logChange(db, operationId, { entityId: id, field: "merged_into", oldValue: other.merged_into, newValue: preferred });
            logDecision(db, operationId, preferred, id, "same");
            decisions += 1;
            linked += 1;
            touched.add(id);
          }
          touched.add(preferred);
        } else if (group.action === "keep_both" && ids.length > 1) {
          for (let i = 0; i < ids.length; i += 1) {
            for (let j = i + 1; j < ids.length; j += 1) {
              logDecision(db, operationId, ids[i], ids[j], "different");
              decisions += 1;
            }
          }
        }
      }

      db.prepare("UPDATE merge_sessions SET status = 'applied', applied_at = ?, operation_id = ?, summary = ? WHERE id = ?").run(
        nowIso(),
        operationId,
        JSON.stringify(summary),
        session.id,
      );
      finishOperation(db, operationId, "completed", { linked, decisions, recordings: summary.expectedTracks });
    });

    refreshTrackSearch(db, [...touched]);

    // Album consolidation is a separate, ordinary (undoable) metadata edit.
    let albumResult = null;
    const proposals = summary.albumProposals.filter((proposal) => acceptedAlbums.includes(proposal.fromReleaseId));
    if (proposals.length) {
      albumResult = applyEdits(
        db,
        proposals.flatMap((proposal) =>
          proposal.trackIds.map((trackId) => ({
            trackId,
            fields: Object.fromEntries(Object.entries(proposal.fields).filter(([, value]) => value !== undefined)),
          })),
        ),
        { label: `Consolidate ${proposals.length} album${proposals.length === 1 ? "" : "s"} after merge` },
      );
    }

    return { operationId, linked, decisions, album: albumResult };
  }

  /** Reverses a merge operation (unlinks versions, restores tracks). */
  function undoMerge(operationId) {
    const operation = db.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'merge'").get(Number(operationId));
    if (!operation) throw new Error("This merge can't be undone.");
    if (db.prepare("SELECT 1 FROM operations WHERE undo_of = ? AND status IN ('completed', 'partial')").get(operation.id)) {
      throw new Error("This merge was already undone.");
    }

    const changes = db.prepare("SELECT * FROM change_log WHERE operation_id = ? ORDER BY id DESC").all(operation.id);
    let undoId = null;
    const touched = new Set();
    transaction(db, () => {
      undoId = startOperation(db, { kind: "merge", label: `Undo: ${operation.label}`, undoOf: operation.id, undoable: false });
      for (const change of changes) {
        if (change.entity_type === "decision") {
          const { other, decision } = parseJson(change.old_value, {});
          if (decision) recordDecision(db, change.entity_id, other, decision);
          else db.prepare("DELETE FROM match_decisions WHERE track_a = ? AND track_b = ?").run(change.entity_id, other);
          continue;
        }
        const table = change.entity_type === "file" ? "files" : "tracks";
        if (!/^[a-z_]+$/.test(change.field)) continue;
        db.prepare(`UPDATE ${table} SET ${change.field} = ? WHERE id = ?`).run(parseJson(change.old_value), change.entity_id);
        if (table === "tracks") touched.add(change.entity_id);
        else {
          const file = db.prepare("SELECT track_id FROM files WHERE id = ?").get(change.entity_id);
          if (file?.track_id) touched.add(file.track_id);
        }
      }
      db.prepare("UPDATE merge_sessions SET status = 'discarded' WHERE operation_id = ?").run(operation.id);
      finishOperation(db, undoId, "completed", { tracks: touched.size });
    });
    refreshTrackSearch(db, [...touched]);
    return { operationId: undoId, tracks: touched.size };
  }

  return { acceptSuggestions, analyze, apply, currentSession, listGroups, setGroupAction, summarize, undoMerge };
}

module.exports = { ACTIONS, createMerge, recordDecision };
