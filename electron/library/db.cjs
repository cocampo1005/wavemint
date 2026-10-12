// SQLite access for the music library (node:sqlite, built into Electron's
// Node). Only the library worker opens the database.
//
// - WAL mode so reads stay fast while a scan writes.
// - Foreign keys on.
// - Versioned migrations (migrations.cjs) applied in order inside one
//   transaction each; the database file is backed up before any migration
//   runs on an existing library.

const fs = require("fs");
const path = require("path");
const { DatabaseSync, backup } = require("node:sqlite");
const { MIGRATIONS } = require("./migrations.cjs");

function openDatabase(filePath, { migrations = MIGRATIONS } = {}) {
  if (filePath !== ":memory:") fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const existed = filePath !== ":memory:" && fs.existsSync(filePath);
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  return { db, existed, pendingMigrations: getPendingMigrations(db, migrations) };
}

function getSchemaVersion(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  return db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
}

function getPendingMigrations(db, migrations = MIGRATIONS) {
  const current = getSchemaVersion(db);
  return migrations.filter((migration) => migration.version > current);
}

/**
 * Applies pending migrations. When the database already had data, a copy is
 * written to `backupDir` first so a failed or unwanted upgrade can be undone.
 */
async function migrate(db, { filePath, backupDir, migrations = MIGRATIONS, logger = console, existed = false } = {}) {
  const pending = getPendingMigrations(db, migrations);
  if (!pending.length) return { applied: [], backupPath: null };

  let backupPath = null;
  if (existed && backupDir && filePath && filePath !== ":memory:") {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = path.join(backupDir, `library-v${getSchemaVersion(db)}-${stamp}.db`);
    await backup(db, backupPath);
    logger.log(`[library] Backed up the database before migrating: ${backupPath}`);
  }

  const applied = [];
  for (const migration of pending) {
    transaction(db, () => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    applied.push(migration.version);
    logger.log(`[library] Applied migration ${migration.version} (${migration.name})`);
  }

  return { applied, backupPath };
}

/** Runs `work` inside a transaction; nested calls use savepoints. */
function transaction(db, work) {
  const depth = (db.__wmDepth = (db.__wmDepth || 0) + 1);
  const savepoint = `wm_sp_${depth}`;
  db.exec(depth === 1 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  try {
    const result = work();
    db.exec(depth === 1 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    try {
      db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch {
      // The original error matters more than a failed rollback.
    }
    throw error;
  } finally {
    db.__wmDepth = depth - 1;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? parseJson(row.value, fallback) : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

module.exports = {
  getPendingMigrations,
  getSchemaVersion,
  getSetting,
  migrate,
  nowIso,
  openDatabase,
  parseJson,
  setSetting,
  transaction,
};
