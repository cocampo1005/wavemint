// Library worker thread entry point. Owns the SQLite database and runs all
// library work off the Electron main thread.
//
// Messages from the host:  { type: "call", id, method, params }
// Replies:                 { type: "result", id, result } | { type: "error", id, error }
// Events:                  { type: "event", name, data }

const path = require("path");
const { parentPort, workerData } = require("worker_threads");
const { migrate, openDatabase } = require("./db.cjs");
const { createJobManager } = require("./jobs.cjs");
const { createMedia } = require("./media.cjs");
const { createLibraryService } = require("./service.cjs");

const logger = {
  log: (...args) => parentPort.postMessage({ type: "log", level: "log", message: args.join(" ") }),
  warn: (...args) => parentPort.postMessage({ type: "log", level: "warn", message: args.join(" ") }),
  error: (...args) => parentPort.postMessage({ type: "log", level: "error", message: args.join(" ") }),
};

function emit(name, data) {
  parentPort.postMessage({ type: "event", name, data });
}

function serializeError(error) {
  return { message: error?.message || String(error), code: error?.code || "" };
}

async function start() {
  const { dataDir, ffmpegPath, ffprobePath, childEnv } = workerData;
  const dbPath = path.join(dataDir, "wavemint-library.db");
  const { db, existed } = openDatabase(dbPath, { logger });
  await migrate(db, { filePath: dbPath, backupDir: path.join(dataDir, "db-backups"), logger, existed });

  const media = createMedia({ ffmpegPath, ffprobePath, cacheDir: path.join(dataDir, "cache"), env: childEnv });
  const jobs = createJobManager({ emit, logger });
  const paths = {
    dataDir,
    backupsDir: path.join(dataDir, "backups"),
    stagingDir: path.join(dataDir, "staging"),
  };
  const service = createLibraryService({ db, media, jobs, paths, logger, emit });

  parentPort.on("message", async (message) => {
    if (message?.type === "shutdown") {
      jobs.cancelAll();
      try {
        db.close();
      } catch {}
      parentPort.postMessage({ type: "closed" });
      return;
    }
    if (message?.type !== "call") return;

    const handler = service.methods[message.method];
    if (!handler) {
      parentPort.postMessage({ type: "error", id: message.id, error: { message: "Unknown library operation" } });
      return;
    }

    try {
      const result = await handler(message.params || {});
      parentPort.postMessage({ type: "result", id: message.id, result: result ?? null });
    } catch (error) {
      parentPort.postMessage({ type: "error", id: message.id, error: serializeError(error) });
    }
  });

  parentPort.postMessage({ type: "ready" });
}

start().catch((error) => {
  parentPort.postMessage({ type: "fatal", error: serializeError(error) });
});
