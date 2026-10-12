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

// Editable fields (values are normalized again in edits.cjs).
const editFields = v.obj(
  {
    title: text(500),
    artist: text(500),
    albumArtist: text(500),
    album: text(500),
    genre: text(200),
    year: v.int({ min: 0, max: 9999, optional: true }),
    trackNo: v.int({ min: 0, max: 999, optional: true }),
    trackTotal: v.int({ min: 0, max: 999, optional: true }),
    discNo: v.int({ min: 0, max: 99, optional: true }),
    discTotal: v.int({ min: 0, max: 99, optional: true }),
    composer: text(500),
    comment: text(2000),
    compilation: v.bool(),
    rating: v.int({ min: 0, max: 5, optional: true }),
    notes: text(2000),
  },
  { optional: false },
);
const editList = v.array(v.obj({ trackId: id(), fields: editFields }, { optional: false }), { max: 20000, optional: false });
const fieldNames = v.oneOf(["title", "artist", "albumArtist", "album", "genre", "year", "trackNo", "trackTotal", "discNo", "discTotal", "composer", "comment", "compilation", "rating", "notes"], { optional: false });
const trackIdList = (options = {}) => v.array(id(), { max: 20000, ...options });
const mergeCategories = v.oneOf(["already_curated", "legacy_only", "curated_only", "other_only", "conflict"]);
const importEntries = v.array(
  v.obj(
    {
      key: v.str({ max: 200, optional: false, allowEmpty: false }),
      title: text(500),
      artist: text(500),
      album: text(500),
      genre: text(200),
      durationMs: v.int({ min: 0, max: 24 * 3600 * 1000, optional: true }),
    },
    { optional: false },
  ),
  { max: 1000 },
);
const reviewKinds = v.oneOf(["missing_album", "missing_artist", "missing_album_artist", "unclassified_genre", "missing_artwork", "track_numbering", "inconsistent_album", "similar_albums", "file_problem", "possible_duplicate", "uncertain_match"]);

/** Renderer-callable worker methods and their parameter schemas. */
const WORKER_METHODS = {
  getOverview: {},
  getStatus: {},
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

  // Metadata editing.
  previewEdits: { edits: editList },
  applyEdits: { edits: editList, exclude: v.array(v.obj({ trackId: id(), field: fieldNames }, { optional: false }), { max: 50000 }), label: text(200) },
  suggestTitleCase: { trackIds: trackIdList({ optional: false }) },
  editAlbum: { releaseId: id(), fields: editFields, label: text(200) },
  copyArtwork: { trackIds: trackIdList({ optional: false }), fromTrackId: id() },
  clearArtwork: { trackIds: trackIdList({ optional: false }) },
  albumTrackIds: { releaseId: id() },
  previewTagWrite: { trackIds: trackIdList() },
  writeTags: { trackIds: trackIdList() },

  // History.
  listOperations: { limit: v.int({ min: 1, max: 500, optional: true }), offset: v.int({ min: 0, optional: true }) },
  getOperation: { id: id() },
  undoOperation: { id: id() },

  // Genres.
  listGenreTaxonomy: {},
  genreReport: {},
  createGenre: { name: v.str({ max: 80, optional: false, allowEmpty: false }), parentId: id({ optional: true }), description: text(300) },
  renameGenre: { id: id(), name: v.str({ max: 80, optional: false, allowEmpty: false }) },
  mergeGenres: { targetId: id(), genreIds: v.array(id(), { max: 500 }), labels: v.array(text(200), { max: 500 }) },
  deleteGenre: { id: id() },
  setGenreParent: { id: id(), parentId: id({ optional: true }) },
  addGenreAlias: { alias: v.str({ max: 80, optional: false, allowEmpty: false }), genreId: id() },
  removeGenreAlias: { alias: v.str({ max: 200, optional: false }) },
  adoptGenreLabels: { labels: v.array(text(200), { max: 2000 }) },
  listGenreRules: {},
  addGenreRule: { kind: v.oneOf(["artist", "album"], { optional: false }), artist: text(300), releaseId: id({ optional: true }), genreId: id() },
  updateGenreRule: { id: id(), enabled: v.bool({ optional: false }) },
  removeGenreRule: { id: id() },
  previewGenreRules: {},
  applyGenreRules: { exclude: trackIdList() },

  // Review queue.
  refreshReview: {},
  reviewSummary: {},
  listReviewItems: { kind: reviewKinds, status: v.oneOf(["open", "needs_review", "suggested", "approved", "ignored", "resolved"]), offset: v.int({ min: 0, optional: true }), limit: v.int({ min: 1, max: 500, optional: true }) },
  setReviewStatus: { ids: v.array(id(), { max: 5000, optional: false }), status: v.oneOf(["needs_review", "ignored", "resolved"], { optional: false }) },
  approveSuggestions: { ids: v.array(id(), { max: 5000, optional: false }) },

  // Merging libraries.
  analyzeMerge: {},
  currentMergeSession: {},
  listMergeGroups: {
    sessionId: id(),
    category: mergeCategories,
    onlyMulti: v.bool(),
    offset: v.int({ min: 0, optional: true }),
    limit: v.int({ min: 1, max: 500, optional: true }),
  },
  setMergeGroupAction: { groupId: id(), action: v.oneOf(["keep_preferred", "merge_metadata", "keep_both", "skip", "keep", "review"], { optional: false }), preferredTrackId: id({ optional: true }) },
  acceptMergeSuggestions: { sessionId: id(), categories: v.array(mergeCategories, { max: 5 }) },
  applyMerge: { sessionId: id(), acceptedAlbums: v.array(id(), { max: 5000 }) },

  // Managed Library (its folder is chosen with chooseManagedRoot).
  getManagedLibrary: {},
  previewNamingPattern: { pattern: v.str({ max: 300, optional: false, allowEmpty: false }) },
  previewConsolidation: { trackIds: trackIdList() },
  consolidate: { trackIds: trackIdList() },
  updateSettings: {
    patch: v.obj(
      {
        namingPattern: v.str({ max: 300, allowEmpty: false }),
        lowBitrateKbps: v.int({ min: 32, max: 512, optional: true }),
        musicBrainzEnabled: v.bool(),
        preferOriginalReleases: v.bool(),
      },
      { optional: false },
    ),
  },

  // Audio quality and upgrades (replacement files are chosen with chooseUpgradeFile).
  qualitySummary: {},
  listQualityQueue: {
    view: v.oneOf(["attention", "review_suggested", "user_marked_poor", "upgrade_available", "keep_original", "upgraded", "acceptable", "unknown", "all"]),
    search: text(200),
    artist: text(300),
    genre: text(200),
    releaseId: id({ optional: true }),
    maxBitrate: v.int({ min: 32, max: 512, optional: true }),
    sort: v.oneOf(["severity", "bitrate", "artist", "album", "title"]),
    offset: v.int({ min: 0, optional: true }),
    limit: v.int({ min: 1, max: 500, optional: true }),
  },
  refreshQuality: {},
  checkQuality: { trackIds: trackIdList(), force: v.bool() },
  setQualityStatus: {
    trackIds: trackIdList({ optional: false }),
    status: v.oneOf(["auto", "user_marked_poor", "keep_original", "acceptable", "upgraded"], { optional: false }),
  },
  prepareUpgrade: { trackId: id(), fileId: id() },
  compareUpgrade: { candidateId: id() },
  discardUpgrade: { candidateId: id() },
  listUpgradeCandidates: { trackId: id() },
  // Identification (MusicBrainz / Cover Art Archive; only when enabled).
  identifySong: { trackId: id() },
  identifySongs: { trackIds: trackIdList(), onlyNew: v.bool() },
  getIdentification: { trackId: id() },
  chooseIdentificationRelease: { trackId: id(), releaseGroupId: v.str({ max: 36, optional: false, allowEmpty: false }) },
  identificationCover: { trackId: id() },
  applyIdentification: {
    trackId: id(),
    fields: v.array(v.oneOf(["title", "artist", "album", "albumArtist", "year", "trackNo", "trackTotal", "discNo", "discTotal", "genre", "mbRecordingId", "mbReleaseId", "mbReleaseGroupId"], { optional: false }), { max: 20, optional: false }),
    coverHash: v.str({ max: 40 }),
  },
  dismissIdentifications: { trackIds: trackIdList({ optional: false }) },
  applyConfidentIdentifications: { minConfidence: v.oneOf([0.9, 0.95]) },
  listIdentifications: {
    status: v.oneOf(["suggested", "uncertain", "no_match", "applied", "dismissed"]),
    offset: v.int({ min: 0, optional: true }),
    limit: v.int({ min: 1, max: 500, optional: true }),
  },
  identificationSummary: {},
  identifyAlbumCandidates: { releaseId: id() },
  identifyAlbumProposal: { releaseId: id(), mbReleaseId: v.str({ max: 36, optional: false, allowEmpty: false }) },
  applyAlbumIdentification: {
    releaseId: id(),
    mbReleaseId: v.str({ max: 36, optional: false, allowEmpty: false }),
    fields: v.array(v.oneOf(["title", "artist", "album", "albumArtist", "year", "trackNo", "trackTotal", "discNo", "discTotal", "genre"], { optional: false }), { max: 20, optional: false }),
    exclude: trackIdList(),
    useCover: v.bool(),
  },

  // Playlist import (files reach staging only through the main process).
  startImport: { title: text(300), url: text(2000), entries: importEntries },
  updateImport: {
    sessionId: id(),
    albumFields: v.obj({
      album: text(500),
      albumArtist: text(500),
      year: v.int({ min: 1000, max: 9999, optional: true }),
      genre: text(200),
      edition: text(100),
      numberTracks: v.bool(),
      artworkKey: text(200),
    }),
    actions: v.array(v.obj({ itemId: id(), action: v.oneOf(["add", "compare", "keep_existing", "keep_both", "skip"], { optional: false }) }, { optional: false }), { max: 1000 }),
    entries: importEntries,
  },
  getImport: { sessionId: id() },
  listImports: {},
  commitImport: {
    sessionId: id(),
    decisions: v.array(v.obj({ itemId: id(), decision: v.oneOf(["add", "upgrade", "keep_existing", "keep_both", "skip"], { optional: false }) }, { optional: false }), { max: 1000, optional: false }),
  },
  discardImport: { sessionId: id() },

  applyUpgrade: {
    candidateId: id(),
    choices: v.obj(Object.fromEntries(["title", "artist", "albumArtist", "album", "genre", "year", "trackNo", "trackTotal", "discNo", "discTotal", "composer"].map((field) => [field, v.oneOf(["current", "candidate"])]))),
    artwork: v.oneOf(["current", "candidate"]),
  },
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
          appVersion: app.getVersion(),
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
    setArtworkFromDialog: {
      schema: { trackIds: trackIdList({ optional: false }) },
      run: async (sender, params) => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), {
          title: "Choose cover art",
          properties: ["openFile", "dontAddToRecent"],
          filters: [{ name: "Images (JPEG or PNG)", extensions: ["jpg", "jpeg", "png"] }],
        });
        if (result.canceled || !result.filePaths.length) return null;
        return call("setArtworkFromPath", { trackIds: params.trackIds, filePath: result.filePaths[0] });
      },
    },
    chooseManagedRoot: {
      schema: {},
      run: async (sender) => {
        const rootPath = await chooseFolder(sender, "Choose a folder for your WaveMint Library");
        if (!rootPath) return null;
        return call("setManagedRoot", { rootPath });
      },
    },
    chooseUpgradeFile: {
      schema: { trackId: id() },
      run: async (sender, params) => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), {
          title: "Choose the replacement audio file",
          properties: ["openFile", "dontAddToRecent"],
          filters: [{ name: "Audio files", extensions: ["mp3", "m4a", "flac", "wav", "aif", "aiff", "aac"] }],
        });
        if (result.canceled || !result.filePaths.length) return null;
        return call("prepareUpgrade", { trackId: params.trackId, filePath: result.filePaths[0] });
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
    // wavemint-media://file/<fileId> and wavemint-media://candidate/<candidateId>
    protocol.handle(MEDIA_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const itemId = Number(url.pathname.replace(/^\/+/, ""));
        if (!["file", "candidate"].includes(url.hostname) || !Number.isInteger(itemId) || itemId < 1) return new Response(null, { status: 400 });
        const file =
          url.hostname === "file" ? await call("resolvePreview", { fileId: itemId }) : await call("resolveCandidatePreview", { candidateId: itemId });
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

// Host methods (dialogs, shell) handled in the main process itself.
const HOST_METHOD_NAMES = ["addSourceFromDialog", "chooseManagedRoot", "chooseUpgradeFile", "relinkSource", "setArtworkFromDialog", "showFileInFolder"];

module.exports = { HOST_METHOD_NAMES, HOST_SCHEMES: [MEDIA_SCHEME, ART_SCHEME], WORKER_METHODS, createLibraryHost, registerLibrarySchemes };
