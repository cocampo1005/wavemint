// Main-process side of the library: starts the worker, exposes a validated,
// allowlisted IPC surface to the renderer, runs folder/file dialogs, and
// serves audio previews and artwork through custom protocols.
//
// The renderer never sends filesystem paths or SQL. Folders and files come
// from main-process dialogs; audio and artwork are addressed by database IDs.

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { Worker } = require("worker_threads");
const { v, validate } = require("./validate.cjs");

const MEDIA_SCHEME = "wavemint-media";
const ART_SCHEME = "wavemint-art";

const MIME_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".m4b": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".jpg": "image/jpeg",
};

const id = (options) => v.int({ min: 1, ...options });
const text = (max = 500) => v.str({ max });

const trackFilters = v.obj({
  sourceId: id({ optional: true }),
  releaseId: id({ optional: true }),
  artist: text(300),
  genre: text(200),
  codec: text(20),
  lowBitrate: v.bool(),
  missingArtwork: v.bool(),
  missingAlbum: v.bool(),
  missingAlbumArtist: v.bool(),
  possibleDuplicates: v.bool(),
  missingFile: v.bool(),
  reviewStatus: v.oneOf(["none", "needs_review", "reviewed"]),
  qualityStatus: v.oneOf(["unknown", "review_suggested", "acceptable", "user_marked_poor", "upgrade_available", "upgraded", "keep_original"]),
  multipleVersions: v.bool(),
  ids: v.array(id(), { max: 5000 }),
});

const listParams = {
  search: text(200),
  filters: trackFilters,
  sort: text(20),
  direction: v.oneOf(["asc", "desc"]),
  offset: v.int({ min: 0, optional: true }),
  limit: v.int({ min: 1, max: 1000, optional: true }),
};

const sourcePatch = v.obj(
  {
    name: text(120),
    role: v.oneOf(["legacy", "curated", "other"]),
    priority: v.int({ min: 0, max: 100, optional: true }),
    readOnly: v.bool(),
  },
  { optional: false },
);

/** Renderer-callable worker methods and their parameter schemas. */
const WORKER_METHODS = {
  getOverview: {},
  listTracks: listParams,
  listTrackIds: { search: text(200), filters: trackFilters },
  listAlbums: { search: text(200), sort: text(20), offset: v.int({ min: 0, optional: true }), limit: v.int({ min: 1, max: 1000, optional: true }), filters: v.obj({ artist: text(300), genre: text(200) }) },
  listArtists: { search: text(200), offset: v.int({ min: 0, optional: true }), limit: v.int({ min: 1, max: 2000, optional: true }) },
  listGenres: {},
  getTrack: { id: id() },
  getAlbum: { id: id() },
  listSources: {},
  updateSource: { id: id(), patch: sourcePatch },
  removeSource: { id: id() },
  scanSources: { sourceIds: v.array(id(), { max: 100 }) },
  listJobs: {},
  cancelJob: { id: id() },
  getSettings: {},
};

function createLibraryHost({ app, ipcMain, dialog, shell, BrowserWindow, protocol, binaries, logger = console }) {
  let worker = null;
  let ready = null;
  let nextCallId = 1;
  const pending = new Map();
  const dataDir = path.join(app.getPath("userData"), "library");

  function broadcast(name, data) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send("library-event", { name, data });
    }
  }

  function startWorker() {
    if (ready) return ready;

    ready = new Promise((resolve, reject) => {
      worker = new Worker(path.join(__dirname, "worker.cjs"), {
        workerData: {
          dataDir,
          ffmpegPath: binaries.resolve("ffmpeg").command,
          ffprobePath: binaries.resolve("ffprobe").command,
          childEnv: binaries.getChildEnv(),
        },
      });

      worker.on("message", (message) => {
        switch (message?.type) {
          case "ready":
            logger.log("[library] Worker ready");
            resolve();
            break;
          case "fatal":
            logger.error(`[library] Worker failed to start: ${message.error?.message}`);
            reject(new Error(message.error?.message || "The music library could not be opened"));
            break;
          case "result":
          case "error": {
            const call = pending.get(message.id);
            if (!call) break;
            pending.delete(message.id);
            if (message.type === "result") call.resolve(message.result);
            else {
              const error = new Error(message.error?.message || "Library operation failed");
              error.code = message.error?.code;
              call.reject(error);
            }
            break;
          }
          case "event":
            broadcast(message.name, message.data);
            break;
          case "log":
            logger[message.level]?.(message.message);
            break;
          default:
            break;
        }
      });

      worker.on("error", (error) => {
        logger.error(`[library] Worker error: ${error.message}`);
      });

      worker.on("exit", (code) => {
        if (code !== 0) logger.error(`[library] Worker exited with code ${code}`);
        for (const call of pending.values()) call.reject(new Error("The music library stopped unexpectedly. Try again."));
        pending.clear();
        worker = null;
        ready = null;
        broadcast("worker-stopped", { code });
      });
    });

    // A failed start can be retried later.
    ready.catch(() => {
      ready = null;
    });
    return ready;
  }

  async function call(method, params = {}) {
    await startWorker();
    return new Promise((resolve, reject) => {
      const callId = nextCallId++;
      pending.set(callId, { resolve, reject });
      worker.postMessage({ type: "call", id: callId, method, params });
    });
  }

  // --- host-level operations (dialogs, shell) --------------------------------

  async function chooseFolder(sender, title) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), {
      title,
      properties: ["openDirectory", "dontAddToRecent"],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  const HOST_METHODS = {
    addSourceFromDialog: {
      schema: { role: v.oneOf(["legacy", "curated", "other"]), name: text(120), scan: v.bool() },
      run: async (sender, params) => {
        const rootPath = await chooseFolder(sender, "Choose a music folder to add to your library");
        if (!rootPath) return null;
        const added = await call("addSource", { rootPath, role: params.role || "other", name: params.name });
        const job = params.scan === false ? null : await call("scanSources", { sourceIds: [added.id] });
        return { ...added, job };
      },
    },
    relinkSource: {
      schema: { id: id() },
      run: async (sender, params) => {
        const rootPath = await chooseFolder(sender, "Choose the folder's new location");
        if (!rootPath) return null;
        return call("updateSource", { id: params.id, patch: { rootPath } });
      },
    },
    showFileInFolder: {
      schema: { fileId: id() },
      run: async (_sender, params) => {
        const file = await call("resolvePlayback", { fileId: params.fileId });
        if (!file || !fs.existsSync(file.path)) throw new Error("This file isn't available right now.");
        shell.showItemInFolder(file.path);
        return { shown: true };
      },
    },
  };

  function register() {
    ipcMain.handle("library", async (event, method, params) => {
      if (typeof method !== "string") throw new Error("Unknown library operation");

      if (Object.hasOwn(HOST_METHODS, method)) {
        const entry = HOST_METHODS[method];
        return entry.run(event.sender, validate(entry.schema, params));
      }

      if (!Object.hasOwn(WORKER_METHODS, method)) throw new Error("Unknown library operation");
      return call(method, validate(WORKER_METHODS[method], params));
    });
  }

  // --- protocols ----------------------------------------------------------------

  function streamFile(filePath, request, contentType) {
    const size = fs.statSync(filePath).size;
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
    const headers = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };

    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.min(start, size - 1);
      end = Math.min(end, size - 1);
      return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
      });
    }

    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: { ...headers, "Content-Length": String(size) },
    });
  }

  function registerProtocols() {
    // wavemint-media://file/<fileId>
    protocol.handle(MEDIA_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const fileId = Number(url.pathname.replace(/^\/+/, ""));
        if (url.hostname !== "file" || !Number.isInteger(fileId) || fileId < 1) return new Response(null, { status: 400 });
        const file = await call("resolvePreview", { fileId });
        if (!file || !fs.existsSync(file.path)) return new Response(null, { status: 404 });
        return streamFile(file.path, request, MIME_TYPES[path.extname(file.path).toLowerCase()] || "application/octet-stream");
      } catch (error) {
        logger.warn(`[library] Preview failed: ${error.message}`);
        return new Response(null, { status: 500 });
      }
    });

    // wavemint-art://art/<sha1>?size=160
    protocol.handle(ART_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const hash = url.pathname.replace(/^\/+/, "");
        const size = Number(url.searchParams.get("size") || 160);
        if (url.hostname !== "art" || !/^[a-f0-9]{40}$/.test(hash)) return new Response(null, { status: 400 });
        const art = await call("resolveArtwork", { hash, size });
        if (!art) return new Response(null, { status: 404 });
        return new Response(Readable.toWeb(fs.createReadStream(art.path)), {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
  }

  async function shutdown() {
    if (!worker) return;
    const current = worker;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      current.once("message", (message) => {
        if (message?.type === "closed") {
          clearTimeout(timer);
          resolve();
        }
      });
      current.postMessage({ type: "shutdown" });
    });
    await current.terminate().catch(() => {});
  }

  return { call, register, registerProtocols, shutdown, startWorker };
}

// Must run before the app is ready.
function registerLibrarySchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

module.exports = { HOST_SCHEMES: [MEDIA_SCHEME, ART_SCHEME], WORKER_METHODS, createLibraryHost, registerLibrarySchemes };
