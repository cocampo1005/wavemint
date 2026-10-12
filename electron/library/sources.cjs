// Library sources: folders imported into WaveMint. Adding a source never
// touches its files; it only records the folder so it can be scanned.

const fs = require("fs");
const path = require("path");
const { nowIso, transaction } = require("./db.cjs");
const { pathKey } = require("./normalize.cjs");
const { refreshTrackSearch } = require("./search.cjs");

const ROLES = ["legacy", "curated", "managed", "other"];
const DEFAULT_PRIORITY = { curated: 80, managed: 90, other: 50, legacy: 20 };

class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Looks for iTunes / Apple Music layouts so the source can be labeled and
 * its library XML (if exported) offered for import later. Read-only.
 */
function detectItunes(root) {
  const found = { isItunes: false, mediaFolder: null, libraryXml: null };
  const candidates = [root, path.dirname(root)];

  for (const folder of candidates) {
    for (const name of ["iTunes Music Library.xml", "iTunes Library.xml", "Library.xml"]) {
      const file = path.join(folder, name);
      if (fs.existsSync(file)) found.libraryXml = file;
    }
  }

  const base = path.basename(root).toLowerCase();
  if (base === "itunes media" || base === "itunes music") {
    found.isItunes = true;
    found.mediaFolder = root;
  } else {
    for (const name of ["iTunes Media", "iTunes Music"]) {
      const media = path.join(root, name);
      if (fs.existsSync(media)) {
        found.isItunes = true;
        found.mediaFolder = media;
      }
    }
  }
  if (found.libraryXml) found.isItunes = true;
  return found;
}

function validateRoot(db, rootPath, { ignoreId = null } = {}) {
  const resolved = path.resolve(rootPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new SourceError("not_found", "That folder can't be opened.");
  }
  if (!stat.isDirectory()) throw new SourceError("not_folder", "Choose a folder, not a file.");

  const key = pathKey(resolved);
  for (const source of db.prepare("SELECT id, name, root_path FROM sources").all()) {
    if (source.id === ignoreId) continue;
    const otherKey = pathKey(source.root_path);
    if (otherKey === key) {
      throw new SourceError("duplicate", `This folder is already in your library as "${source.name}".`);
    }
    if (isInside(key, otherKey)) {
      throw new SourceError("nested", `This folder is inside "${source.name}", which WaveMint already scans.`);
    }
    if (isInside(otherKey, key)) {
      throw new SourceError(
        "contains",
        `This folder contains "${source.name}", which is already a separate source. Choose a folder that doesn't overlap.`,
      );
    }
  }
  return { resolved, key };
}

function addSource(db, { rootPath, name, role = "other", priority, readOnly = true }) {
  const { resolved, key } = validateRoot(db, rootPath);
  const safeRole = ROLES.includes(role) ? role : "other";
  const itunes = detectItunes(resolved);
  const displayName =
    String(name || "").trim().slice(0, 120) ||
    (itunes.isItunes ? "iTunes Library" : path.basename(resolved) || resolved);

  const id = Number(
    db
      .prepare(
        `INSERT INTO sources (name, root_path, root_key, role, priority, read_only, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)`,
      )
      .run(
        displayName,
        resolved,
        key,
        safeRole,
        Number.isInteger(priority) ? priority : DEFAULT_PRIORITY[safeRole],
        safeRole === "managed" ? 0 : readOnly ? 1 : 0,
        nowIso(),
      ).lastInsertRowid,
  );
  return { id, itunes };
}

function updateSource(db, id, patch) {
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
  if (!source) throw new SourceError("not_found", "This source no longer exists.");

  const updates = {};
  if (typeof patch.name === "string" && patch.name.trim()) updates.name = patch.name.trim().slice(0, 120);
  if (ROLES.includes(patch.role) && patch.role !== "managed" && source.role !== "managed") updates.role = patch.role;
  if (Number.isInteger(patch.priority)) updates.priority = Math.max(0, Math.min(100, patch.priority));
  // Imported sources stay read-only unless the user explicitly allows
  // WaveMint to write tags there.
  if (typeof patch.readOnly === "boolean" && source.role !== "managed") updates.read_only = patch.readOnly ? 1 : 0;
  if (typeof patch.rootPath === "string") {
    // Relinking a moved folder: keep the catalog, update paths.
    const { resolved, key } = validateRoot(db, patch.rootPath, { ignoreId: id });
    updates.root_path = resolved;
    updates.root_key = key;
  }

  const columns = Object.keys(updates);
  if (!columns.length) return source;

  transaction(db, () => {
    db.prepare(`UPDATE sources SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`).run(
      ...columns.map((column) => updates[column]),
      id,
    );

    if (updates.root_path) {
      const files = db.prepare("SELECT id, rel_path FROM files WHERE source_id = ?").all(id);
      const update = db.prepare("UPDATE files SET path = ?, path_key = ? WHERE id = ?");
      for (const file of files) {
        const newPath = path.join(updates.root_path, file.rel_path);
        update.run(newPath, pathKey(newPath), file.id);
      }
    }
  });

  return db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
}

/**
 * Removes a source from the catalog (files on disk are untouched). Logical
 * tracks that only had files in this source are removed too; tracks with
 * versions elsewhere keep them.
 */
function removeSource(db, id) {
  const source = db.prepare("SELECT * FROM sources WHERE id = ?").get(id);
  if (!source) return { removed: false };

  const affected = db
    .prepare("SELECT DISTINCT track_id FROM files WHERE source_id = ? AND track_id IS NOT NULL")
    .all(id)
    .map((row) => row.track_id);

  transaction(db, () => {
    db.prepare("DELETE FROM files WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM sources WHERE id = ?").run(id);

    const pickActive = db.prepare(
      `SELECT f.id FROM files f JOIN sources s ON s.id = f.source_id
       WHERE f.track_id = ? ORDER BY (f.status = 'ok') DESC, s.priority DESC, f.id LIMIT 1`,
    );
    for (const trackId of affected) {
      const replacement = pickActive.get(trackId);
      if (replacement) {
        db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ? AND active_file_id IS NULL").run(replacement.id, trackId);
      } else {
        db.prepare("UPDATE tracks SET state = 'removed' WHERE id = ?").run(trackId);
      }
    }
  });

  refreshTrackSearch(db, affected);
  return { removed: true, tracksAffected: affected.length };
}

module.exports = {
  DEFAULT_PRIORITY,
  ROLES,
  SourceError,
  addSource,
  detectItunes,
  removeSource,
  updateSource,
  validateRoot,
};
