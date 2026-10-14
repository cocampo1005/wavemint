// Disk space: what WaveMint keeps, and cleaning up what's no longer needed.
//
// Most library changes are database rows. What takes space over time:
//   - previous versions: the full audio file an Edit Audio or Upgrade
//     replaced, in <WaveMint Library>/.wavemint-archive (plus undone imports
//     and copies parked after a failure);
//   - tag-write backups: a full copy of every file before Write Tags, in
//     <userData>/library/backups/op-N;
//   - caches: playable FLAC copies of ALAC/AIFF songs, artwork thumbnails,
//     spectrograms;
//   - artwork no song uses anymore (replaced covers, unused MusicBrainz
//     covers), abandoned album-import staging, old database backups.
//
// Previous versions and backups are kept for the retention period
// (`keepPreviousVersions`, default 3 days), so recent changes can be undone;
// afterwards they can be cleaned up and History marks those changes as no
// longer undoable. Caches are bounded or dropped when stale.
//
// This module only measures and plans (worker side). The main process
// carries out the plan: audio and backups go to the Recycle Bin, generated
// files are deleted, and every path is checked to be inside WaveMint's own
// folders first (isInsideRoots). Then finish() updates the database. Songs
// in use, and anything in the user's own music folders, are never planned.

const fs = require("fs");
const path = require("path");
const { getSetting, parseJson, setSetting, transaction } = require("./db.cjs");
const { ARCHIVE_DIR } = require("./consolidate.cjs");
const { pathKey } = require("./normalize.cjs");

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = { "1d": DAY, "3d": 3 * DAY, "7d": 7 * DAY, "30d": 30 * DAY, never: Infinity };
const DEFAULT_RETENTION = "3d";
const PREVIEW_CACHE_LIMIT = 1024 * 1024 * 1024; // 1 GB of playable copies
const RECENTLY_USED_MS = 2 * 60 * 60 * 1000; // a playable copy used this recently stays
const STALE_CACHE_MS = 30 * DAY;
const ARTWORK_GRACE_MS = DAY; // new images may not be referenced yet
const ABANDONED_IMPORT_MS = 7 * DAY;
const TEMP_WORK_MS = DAY;
const DB_BACKUPS_KEPT = 3;

const CATEGORY_IDS = ["versions", "tagBackups", "playback", "artwork", "caches", "temporary", "dbBackups"];

/** True when `target` is strictly inside one of `roots` (both already resolved). */
function isInsideRoots(target, roots) {
  const key = path.resolve(String(target || "")).toLowerCase();
  return roots.some((root) => {
    const base = path.resolve(String(root || "")).toLowerCase();
    if (!root || key === base) return false;
    const relative = path.relative(base, key);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

/** Files under `dir` (symbolic links are never followed). */
async function walk(dir, { depth = 12 } = {}) {
  const out = [];
  let seen = 0;
  async function visit(folder, level) {
    let entries;
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (level < depth) await visit(full, level + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.lstat(full);
        out.push({ path: full, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs || stat.mtimeMs });
      } catch {
        // Gone or inaccessible: not counted.
      }
      seen += 1;
      if (seen % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await visit(dir, 0);
  return out;
}

const sum = (files) => files.reduce((total, file) => total + file.size, 0);

async function birthtime(target) {
  try {
    const stat = await fs.promises.stat(target);
    return stat.birthtimeMs || stat.mtimeMs;
  } catch {
    return 0;
  }
}

function retentionLabel(key) {
  return { "1d": "1 day", "3d": "3 days", "7d": "7 days", "30d": "30 days", never: "until you clean up" }[key] || "3 days";
}

function createStorage({ db, managedSource, getSettings, paths, importer, logger = console }) {
  const userData = path.dirname(paths.dataDir);
  const dirs = {
    backups: paths.backupsDir,
    cache: path.join(paths.dataDir, "cache"),
    artworkStore: path.join(paths.dataDir, "artwork-store"),
    staging: paths.stagingDir,
    dbBackups: path.join(paths.dataDir, "db-backups"),
    engine: path.join(userData, "engine"),
    tempWork: paths.tempWorkDir || null,
  };

  const retentionKey = () => (RETENTION[getSettings().keepPreviousVersions] !== undefined ? getSettings().keepPreviousVersions : DEFAULT_RETENTION);
  const status = () => getSetting(db, "storage", {}) || {};

  /** Artwork hashes something still uses (songs, albums, files, pending work, undo). */
  function artworkInUse(now, retentionMs) {
    const used = new Set();
    const add = (hash) => typeof hash === "string" && /^[a-f0-9]{40}$/.test(hash) && used.add(hash);
    for (const sql of [
      "SELECT DISTINCT artwork_hash AS h FROM tracks WHERE artwork_hash IS NOT NULL",
      "SELECT DISTINCT artwork_hash AS h FROM releases WHERE artwork_hash IS NOT NULL",
      "SELECT DISTINCT artwork_hash AS h FROM files WHERE artwork_hash IS NOT NULL",
    ]) {
      for (const row of db.prepare(sql).all()) add(row.h);
    }
    for (const row of db.prepare("SELECT info FROM upgrade_candidates WHERE status = 'pending'").all()) add(parseJson(row.info, {}).artworkHash);
    for (const row of db.prepare("SELECT i.staged_info FROM import_items i JOIN import_sessions s ON s.id = i.session_id WHERE s.status = 'open'").all()) {
      add(parseJson(row.staged_info, {})?.artworkHash);
    }
    // Recent artwork changes can still be undone: keep both sides.
    const since = Number.isFinite(retentionMs) ? new Date(now - retentionMs).toISOString() : "";
    const changes = db
      .prepare(
        `SELECT c.old_value, c.new_value FROM change_log c JOIN operations o ON o.id = c.operation_id
         WHERE c.field = 'artwork_hash' AND o.undoable = 1 AND o.created_at >= ?`,
      )
      .all(since);
    for (const change of changes) {
      add(parseJson(change.old_value));
      add(parseJson(change.new_value));
    }
    return used;
  }

  /**
   * What can be cleaned up now. Returns { actions, sizes } where each action
   * is { category, path, action: "trash" | "delete", bytes, ref }.
   */
  async function plan({ categories = CATEGORY_IDS, now = Date.now() } = {}) {
    const wanted = new Set(categories);
    const key = retentionKey();
    const retentionMs = RETENTION[key];
    const actions = [];
    const sizes = {};
    const push = (category, entry) => actions.push({ category, ...entry });

    // Previous versions (only inside the WaveMint Library's archive folder).
    const managed = managedSource();
    if (managed) {
      const archiveRoot = path.join(managed.root_path, ARCHIVE_DIR);
      const files = await walk(archiveRoot);
      sizes.versions = sum(files);
      if (wanted.has("versions") && Number.isFinite(retentionMs)) {
        const rows = new Map(
          db
            .prepare(
              `SELECT f.id, f.path_key, f.role,
                      EXISTS (SELECT 1 FROM tracks t WHERE t.active_file_id = f.id AND t.state = 'active') AS in_use,
                      (SELECT MAX(o.finished_at) FROM change_log c JOIN operations o ON o.id = c.operation_id
                       WHERE c.entity_type = 'file' AND c.entity_id = f.id AND c.field IN ('role', 'path')) AS archived_at
               FROM files f WHERE f.source_id = ?`,
            )
            .all(managed.id)
            .map((row) => [row.path_key, row]),
        );
        for (const file of files) {
          const row = rows.get(pathKey(file.path));
          // Never a version a song is using, or one that isn't archived.
          if (row && (row.in_use || row.role !== "archived")) continue;
          // When it was put aside; the latest known time wins (keeps longer).
          const times = [file.birthtimeMs, await birthtime(path.dirname(file.path))];
          if (row?.archived_at) times.push(Date.parse(row.archived_at));
          if (now - Math.max(...times) < retentionMs) continue;
          push("versions", { path: file.path, action: "trash", bytes: file.size, ref: { fileId: row?.id ?? null } });
        }
      }
    } else {
      sizes.versions = 0;
    }

    // Tag-write backups: one folder per Write Tags operation.
    sizes.tagBackups = 0;
    let backupFolders = [];
    try {
      backupFolders = (await fs.promises.readdir(dirs.backups, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^op-\d+$/.test(entry.name));
    } catch {
      backupFolders = [];
    }
    for (const entry of backupFolders) {
      const folder = path.join(dirs.backups, entry.name);
      const bytes = sum(await walk(folder));
      sizes.tagBackups += bytes;
      if (!wanted.has("tagBackups") || !Number.isFinite(retentionMs)) continue;
      const operationId = Number(entry.name.slice(3));
      const operation = db.prepare("SELECT created_at, finished_at FROM operations WHERE id = ?").get(operationId);
      // The operation's own time; the folder's only when there's no record.
      const at = Date.parse(operation?.finished_at || operation?.created_at || "") || (await birthtime(folder));
      if (now - at >= retentionMs) push("tagBackups", { path: folder, action: "trash", bytes, ref: { operationId } });
    }

    // Playable copies of ALAC/AIFF songs: drop stale ones, then keep the
    // total under the limit (least recently used first; recent ones stay).
    const previews = await walk(path.join(dirs.cache, "previews"));
    sizes.playback = sum(previews);
    if (wanted.has("playback")) {
      const keep = [];
      for (const file of previews) {
        const match = /^(c?)(\d+)-(\d+)\.flac$/.exec(file.name);
        let stale = !match;
        if (match && !match[1]) {
          const row = db.prepare("SELECT mtime_ms, status FROM files WHERE id = ?").get(Number(match[2]));
          stale = !row || row.status === "missing" || Math.round(row.mtime_ms) !== Number(match[3]);
        } else if (match) {
          stale = !db.prepare("SELECT 1 FROM upgrade_candidates WHERE id = ? AND status = 'pending'").get(Number(match[2]));
        }
        if (stale && now - file.mtimeMs > RECENTLY_USED_MS) push("playback", { path: file.path, action: "delete", bytes: file.size });
        else keep.push(file);
      }
      let total = sum(keep);
      for (const file of keep.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= PREVIEW_CACHE_LIMIT) break;
        if (now - file.mtimeMs < RECENTLY_USED_MS) continue;
        push("playback", { path: file.path, action: "delete", bytes: file.size });
        total -= file.size;
      }
    }

    // Artwork no longer used, and thumbnails of it.
    const stored = await walk(dirs.artworkStore, { depth: 2 });
    const thumbs = await walk(path.join(dirs.cache, "artwork"), { depth: 2 });
    sizes.artwork = sum(stored) + sum(thumbs);
    if (wanted.has("artwork")) {
      const used = artworkInUse(now, retentionMs);
      for (const file of stored) {
        const hash = /^([a-f0-9]{40})\.(jpg|png)$/.exec(file.name)?.[1];
        if (!hash || used.has(hash) || now - file.mtimeMs < ARTWORK_GRACE_MS) continue;
        push("artwork", { path: file.path, action: "delete", bytes: file.size, ref: { hash } });
      }
      for (const file of thumbs) {
        const hash = /^([a-f0-9]{40})-\d+\.jpg$/.exec(file.name)?.[1];
        const leftover = !hash && now - file.mtimeMs > DAY; // an interrupted conversion
        if ((hash && !used.has(hash) && now - file.mtimeMs > ARTWORK_GRACE_MS) || leftover) {
          push("artwork", { path: file.path, action: "delete", bytes: file.size });
        }
      }
    }

    // Other caches: spectrograms of files that changed or weren't looked at
    // for a month, and leftover waveform buffers.
    const spectra = await walk(path.join(dirs.cache, "spectra"), { depth: 0 });
    const waveforms = await walk(path.join(dirs.cache, "waveforms"), { depth: 0 });
    sizes.caches = sum(spectra) + sum(waveforms);
    if (wanted.has("caches")) {
      for (const file of spectra) {
        const match = /^f(\d+)-(\d+)\.png$/.exec(file.name);
        const row = match ? db.prepare("SELECT mtime_ms FROM files WHERE id = ?").get(Number(match[1])) : null;
        const stale = match ? !row || Math.round(row.mtime_ms) !== Number(match[2]) : true;
        if ((stale && now - file.mtimeMs > DAY) || now - file.mtimeMs > STALE_CACHE_MS) push("caches", { path: file.path, action: "delete", bytes: file.size });
      }
      for (const file of waveforms) if (now - file.mtimeMs > DAY) push("caches", { path: file.path, action: "delete", bytes: file.size });
    }

    // Temporary files: abandoned album imports and old extraction work folders.
    // (Edit and single-song staging is cleared each time the library starts.)
    const stagingFiles = await walk(dirs.staging);
    const tempFiles = dirs.tempWork ? await walk(dirs.tempWork) : [];
    sizes.temporary = sum(stagingFiles) + sum(tempFiles);
    if (wanted.has("temporary")) {
      let importFolders = [];
      try {
        importFolders = (await fs.promises.readdir(path.join(dirs.staging, "imports"), { withFileTypes: true })).filter((entry) => entry.isDirectory());
      } catch {
        importFolders = [];
      }
      for (const entry of importFolders) {
        const sessionId = Number(/^session-(\d+)$/.exec(entry.name)?.[1]);
        const folder = path.join(dirs.staging, "imports", entry.name);
        const session = sessionId ? db.prepare("SELECT status, created_at FROM import_sessions WHERE id = ?").get(sessionId) : null;
        // Open imports are given a week; folders without an open import, a day.
        const abandoned = session?.status === "open" ? now - Date.parse(session.created_at) > ABANDONED_IMPORT_MS : now - (await birthtime(folder)) > DAY;
        if (abandoned) {
          push("temporary", { path: folder, action: "delete", bytes: sum(stagingFiles.filter((file) => isInsideRoots(file.path, [folder]))), ref: { sessionId: session?.status === "open" ? sessionId : null } });
        }
      }
      if (dirs.tempWork) {
        let work = [];
        try {
          work = (await fs.promises.readdir(dirs.tempWork, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("wavemint-temp-"));
        } catch {
          work = [];
        }
        for (const entry of work) {
          const folder = path.join(dirs.tempWork, entry.name);
          const stat = await fs.promises.stat(folder).catch(() => null);
          if (stat && now - stat.mtimeMs > TEMP_WORK_MS) {
            push("temporary", { path: folder, action: "delete", bytes: sum(tempFiles.filter((file) => isInsideRoots(file.path, [folder]))) });
          }
        }
      }
    }

    // Database backups made before upgrades: the newest few are kept.
    const dbBackups = (await walk(dirs.dbBackups, { depth: 0 })).filter((file) => file.name.endsWith(".db"));
    sizes.dbBackups = sum(dbBackups);
    if (wanted.has("dbBackups")) {
      for (const file of dbBackups.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(DB_BACKUPS_KEPT)) {
        push("dbBackups", { path: file.path, action: "trash", bytes: file.size });
      }
    }

    return { actions, sizes, retention: key };
  }

  /** Sizes, what can be reclaimed, the settings and the last cleanup. */
  async function report({ now = Date.now() } = {}) {
    const { actions, sizes, retention } = await plan({ now });
    const reclaimable = {};
    for (const action of actions) reclaimable[action.category] = (reclaimable[action.category] || 0) + action.bytes;

    const managed = managedSource();
    const library = managed
      ? db
          .prepare(
            `SELECT COALESCE(SUM(f.size), 0) AS bytes, COUNT(*) AS files FROM files f
             WHERE f.source_id = ? AND f.status = 'ok' AND f.rel_path NOT LIKE ?`,
          )
          .get(managed.id, `${ARCHIVE_DIR}%`)
      : { bytes: 0, files: 0 };
    // The user's own folders: WaveMint only reads them, and never cleans them up.
    const external = db
      .prepare(
        `SELECT COALESCE(SUM(f.size), 0) AS bytes, COUNT(*) AS files FROM files f JOIN sources s ON s.id = f.source_id
         WHERE s.role != 'managed' AND f.status = 'ok'`,
      )
      .get();
    // Of those, copies of songs that now play from the WaveMint Library.
    const duplicated = managed
      ? db
          .prepare(
            `SELECT COALESCE(SUM(f.size), 0) AS bytes, COUNT(*) AS files FROM files f JOIN sources s ON s.id = f.source_id
             JOIN tracks t ON t.id = f.track_id JOIN files a ON a.id = t.active_file_id
             WHERE s.role != 'managed' AND f.status = 'ok' AND t.state = 'active' AND a.source_id = ?`,
          )
          .get(managed.id)
      : { bytes: 0, files: 0 };

    let database = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        database += fs.statSync(path.join(paths.dataDir, `wavemint-library.db${suffix}`)).size;
      } catch {
        // Not present.
      }
    }
    const engine = sum(await walk(dirs.engine, { depth: 3 }));

    const categories = [
      { id: "library", bytes: library.bytes, files: library.files, kept: true },
      ...CATEGORY_IDS.map((id) => ({ id, bytes: sizes[id] || 0, reclaimable: reclaimable[id] || 0 })),
      { id: "database", bytes: database, kept: true },
      { id: "engine", bytes: engine, kept: true },
    ];
    const settings = getSettings();
    return {
      categories,
      external: { bytes: external.bytes, files: external.files, duplicatedBytes: duplicated.bytes, duplicatedFiles: duplicated.files },
      totalBytes: categories.reduce((total, item) => total + item.bytes, 0),
      reclaimableBytes: Object.values(reclaimable).reduce((total, bytes) => total + bytes, 0),
      retention,
      retentionLabel: retentionLabel(retention),
      autoCleanup: settings.autoCleanup !== false,
      lastCleanup: status().lastCleanup || null,
      libraryFolder: managed?.root_path || null,
    };
  }

  /**
   * After the main process carried out a plan: database records follow what
   * was actually removed. `results` are the planned actions with `ok`.
   */
  function finish({ results = [], auto = false, now = Date.now() }) {
    const done = results.filter((item) => item.ok);
    const at = new Date(now).toISOString();
    const expired = (operationId, reason) => {
      const row = db.prepare("SELECT undoable, summary FROM operations WHERE id = ?").get(operationId);
      if (!row || !row.undoable) return;
      db.prepare("UPDATE operations SET undoable = 0, summary = ? WHERE id = ?").run(JSON.stringify({ ...parseJson(row.summary, {}), expired: { at, reason } }), operationId);
    };
    const sessions = [];

    transaction(db, () => {
      // Previous versions: their records go, and so does the undo that needed them.
      const removedFiles = new Set(done.filter((item) => item.category === "versions" && item.ref?.fileId).map((item) => Number(item.ref.fileId)));
      if (removedFiles.size) {
        for (const operation of db.prepare("SELECT id, summary FROM operations WHERE kind = 'upgrade' AND undoable = 1").all()) {
          const summary = parseJson(operation.summary, {});
          if (removedFiles.has(Number(summary.previousFileId))) expired(operation.id, "The previous version was cleaned up after the recovery period.");
        }
        for (const fileId of removedFiles) {
          db.prepare("DELETE FROM files WHERE id = ? AND role = 'archived' AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.active_file_id = files.id)").run(fileId);
        }
      }
      for (const item of done.filter((entry) => entry.category === "tagBackups" && entry.ref?.operationId)) {
        expired(item.ref.operationId, "The backups of the original files were cleaned up after the recovery period.");
      }
      const removedArt = new Set(done.filter((item) => item.category === "artwork" && item.ref?.hash).map((item) => item.ref.hash));
      if (removedArt.size) {
        const changes = db
          .prepare("SELECT DISTINCT c.operation_id, c.old_value FROM change_log c JOIN operations o ON o.id = c.operation_id WHERE c.field = 'artwork_hash' AND o.undoable = 1")
          .all();
        for (const change of changes) {
          if (removedArt.has(parseJson(change.old_value))) expired(change.operation_id, "The earlier artwork was cleaned up after the recovery period.");
        }
      }
      for (const item of done.filter((entry) => entry.category === "temporary" && entry.ref?.sessionId)) sessions.push(item.ref.sessionId);

      const removed = {};
      for (const item of done) removed[item.category] = (removed[item.category] || 0) + 1;
      const failed = results.filter((item) => !item.ok);
      const lastCleanup = {
        at,
        auto,
        freedBytes: done.reduce((total, item) => total + (item.bytes || 0), 0),
        removed,
        failed: failed.length,
        failures: failed.slice(0, 5).map((item) => ({ name: path.basename(item.path), error: item.error || "" })),
      };
      setSetting(db, "storage", { ...status(), lastCleanup });
    });
    for (const sessionId of sessions) {
      try {
        importer.discard({ sessionId });
      } catch (error) {
        logger.warn(`[library] Couldn't close abandoned import ${sessionId}: ${error.message}`);
      }
    }
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Busy: SQLite checkpoints on its own later.
    }
    return status().lastCleanup;
  }

  /** For the automatic run: is it on, and when did it last run? */
  function schedule() {
    return { autoCleanup: getSettings().autoCleanup !== false, lastCleanupAt: status().lastCleanup?.at || null };
  }

  return { finish, plan, report, schedule };
}

module.exports = { CATEGORY_IDS, DEFAULT_RETENTION, RETENTION, createStorage, isInsideRoots, retentionLabel, walk };
