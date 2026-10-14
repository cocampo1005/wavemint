// Taking songs out of the library.
//
// Remove from Library: the songs leave the library (state "removed"); their
// files and file records stay, so a rescan doesn't bring them back, and
// History can undo it (playlists keep their entries and show the songs
// again). Nothing on disk changes.
//
// Delete File: the main process moves the song's files to the Recycle Bin
// (shell.trashItem) and the songs leave the library. Only files of the
// chosen songs, only in folders WaveMint may change (the WaveMint Library
// folder, or a source the user allowed writing to), and only audio files.
// A song whose current file is in a read-only folder isn't deleted at all.
// Artwork lives in WaveMint's own store and is never touched.

const fs = require("fs");
const path = require("path");
const { nowIso, transaction } = require("./db.cjs");
const { finishOperation, logChange, startOperation } = require("./operations.cjs");
const { refreshTrackSearch } = require("./search.cjs");
const { isAudioFile } = require("./tags.cjs");

function createRemoval({ db }) {
  function activeTracks(trackIds) {
    const ids = [...new Set(trackIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return [];
    return db.prepare(`SELECT id, title, artist, active_file_id FROM tracks WHERE state = 'active' AND id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  }

  const describe = (rows, verb) => (rows.length === 1 ? `${verb} "${rows[0].title || "Untitled"}"` : `${verb} ${rows.length} songs`);

  function markRemoved(operationId, rows) {
    const now = nowIso();
    for (const row of rows) {
      db.prepare("UPDATE tracks SET state = 'removed', updated_at = ? WHERE id = ?").run(now, row.id);
      logChange(db, operationId, { entityId: row.id, field: "state", oldValue: "active", newValue: "removed" });
    }
  }

  /** Remove from Library (files untouched; undoable from History). */
  function removeFromLibrary({ trackIds }) {
    const rows = activeTracks(trackIds);
    if (!rows.length) return { removed: 0, trackIds: [] };
    const operationId = transaction(db, () => {
      const id = startOperation(db, { kind: "remove", label: `${describe(rows, "Remove")} from the library` });
      markRemoved(id, rows);
      finishOperation(db, id, "completed", { removed: rows.length });
      return id;
    });
    refreshTrackSearch(db, rows.map((row) => row.id));
    return { removed: rows.length, trackIds: rows.map((row) => row.id), operationId };
  }

  /**
   * What Delete File would do. `items` lists each song's files that would go
   * to the Recycle Bin; `blocked` the songs that can't be deleted, and why.
   * Paths are included only for the host (`withPaths`).
   */
  function deletionPlan({ trackIds, withPaths = false }) {
    const items = [];
    const blocked = [];
    const filesOf = db.prepare(
      `SELECT f.id, f.path, f.rel_path, f.status, s.name AS source_name, s.read_only
       FROM files f JOIN sources s ON s.id = f.source_id WHERE f.track_id = ? ORDER BY f.id`,
    );
    for (const track of activeTracks(trackIds)) {
      const files = filesOf.all(track.id);
      const active = files.find((file) => file.id === track.active_file_id);
      if (active?.read_only) {
        blocked.push({
          trackId: track.id,
          title: track.title,
          reason: `Its file is in "${active.source_name}", which WaveMint only reads. Use Remove from Library, or allow changes to that folder in Sources.`,
        });
        continue;
      }
      const deletable = files.filter((file) => !file.read_only && isAudioFile(file.path));
      items.push({
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        files: deletable.map((file) => ({
          fileId: file.id,
          name: path.basename(file.path),
          sourceName: file.source_name,
          missing: file.status === "missing" || !fs.existsSync(file.path),
          ...(withPaths ? { path: file.path } : {}),
        })),
        keptElsewhere: files.length - deletable.length,
      });
    }
    return { items, blocked };
  }

  /**
   * Host only, after the files were moved to the Recycle Bin. `results` has
   * per song the file ids that were trashed or already missing, and failures.
   * A song leaves the library once its current file is gone.
   */
  function finishDeletion({ results }) {
    const removed = [];
    const failures = [];
    transaction(db, () => {
      const rows = activeTracks(results.map((result) => result.trackId));
      if (!rows.length) return;
      const operationId = startOperation(db, { kind: "delete", label: `${describe(rows, "Delete")} (moved to the Recycle Bin)`, undoable: false });
      for (const row of rows) {
        const result = results.find((item) => Number(item.trackId) === row.id);
        const gone = new Set([...(result.trashed || []), ...(result.missing || [])].map(Number));
        // Only this song's own files.
        const owned = db.prepare("SELECT id, path FROM files WHERE track_id = ?").all(row.id).filter((file) => gone.has(file.id));
        for (const failure of result.failed || []) failures.push({ trackId: row.id, title: row.title, ...failure });
        if (!owned.some((file) => file.id === row.active_file_id) && row.active_file_id) continue;
        markRemoved(operationId, [row]);
        for (const file of owned) {
          logChange(db, operationId, { entityType: "file", entityId: file.id, field: "deleted", oldValue: file.path, newValue: null });
          db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
        }
        removed.push(row.id);
      }
      finishOperation(db, operationId, failures.length ? (removed.length ? "partial" : "failed") : "completed", { deleted: removed.length, failed: failures.length });
    });
    refreshTrackSearch(db, removed);
    return { deleted: removed.length, trackIds: removed, failures };
  }

  return { deletionPlan, finishDeletion, removeFromLibrary };
}

module.exports = { createRemoval };
