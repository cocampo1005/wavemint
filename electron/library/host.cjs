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
const { CATEGORY_IDS, isInsideRoots } = require("./storage.cjs");
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
  favorite: v.bool(),
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
const smartRules = v.obj({
  match: v.oneOf(["all", "any"]),
  conditions: v.array(
    v.obj({ field: v.str({ max: 20, optional: false }), op: v.str({ max: 20, optional: false }), value: v.any() }, { optional: false }),
    { max: 20, optional: false },
  ),
  limit: v.int({ min: 1, max: 10000, optional: true }),
  sort: v.oneOf(["artist", "album", "title", "year", "recent", "rating"]),
});
const exportScope = v.obj(
  {
    all: v.bool(),
    trackIds: trackIdList(),
    playlistIds: v.array(id(), { max: 500 }),
    genres: v.array(text(200), { max: 200 }),
    releaseIds: v.array(id(), { max: 5000 }),
  },
  { optional: false },
);
const extractionToken = (options = {}) => v.str({ max: 32, allowEmpty: false, ...options });
const MAX_LENGTH_MS = 24 * 3600 * 1000;
const audioEdits = (options = {}) =>
  v.obj(
    {
      startMs: v.int({ min: 0, max: MAX_LENGTH_MS, optional: true }),
      endMs: v.int({ min: 0, max: MAX_LENGTH_MS, optional: true }),
      fadeInMs: v.int({ min: 0, max: 10 * 60 * 1000, optional: true }),
      fadeOutMs: v.int({ min: 0, max: 10 * 60 * 1000, optional: true }),
    },
    options,
  );
const reviewKinds = v.oneOf(["missing_album", "missing_artist", "missing_album_artist", "unclassified_genre", "missing_artwork", "track_numbering", "inconsistent_album", "similar_albums", "file_problem", "possible_duplicate", "uncertain_match", "incomplete_album"]);

/** Renderer-callable worker methods and their parameter schemas. */
const WORKER_METHODS = {
  getOverview: {},
  getStatus: {},
  listTracks: listParams,
  listTrackIds: { search: text(200), filters: trackFilters, sort: text(20), direction: v.oneOf(["asc", "desc"]) },
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
        keepPreviousVersions: v.oneOf(["1d", "3d", "7d", "30d", "never"]),
        autoCleanup: v.bool(),
        preferOriginalReleases: v.bool(),
        convertWavAiff: v.bool(),
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
  spectrogram: { fileId: id({ optional: true }), candidateId: id({ optional: true }) },
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

  // Adding extractions to the library and editing audio (trim, fades).
  // Extractions are addressed by the random token the main process got when
  // it staged them; the renderer never sends paths.
  checkLibraryMatches: { entries: importEntries },
  getStagedExtraction: { token: extractionToken({ optional: false }) },
  commitStagedExtraction: { token: extractionToken({ optional: false }), edits: audioEdits() },
  discardStagedExtraction: { token: extractionToken({ optional: false }) },
  getAudioEditSource: { trackId: id() },
  audioWaveform: {
    trackId: id({ optional: true }),
    token: extractionToken(),
    startMs: v.int({ min: 0, max: MAX_LENGTH_MS, optional: true }),
    endMs: v.int({ min: 1, max: MAX_LENGTH_MS, optional: true }),
    points: v.int({ min: 16, max: 6000, optional: true }),
  },
  applyAudioEdit: { trackId: id(), edits: audioEdits({ optional: false }) },

  // Favorites and taking songs out of the library (files are deleted only
  // through deleteTrackFiles, a host method).
  setFavorite: { trackIds: trackIdList({ optional: false }), favorite: v.bool({ optional: false }) },
  removeFromLibrary: { trackIds: trackIdList({ optional: false }) },
  previewFileDeletion: { trackIds: trackIdList({ optional: false }) },

  // Storage (cleaning up is a host method: the main process removes files).
  storageReport: {},

  // Playlists.
  listPlaylists: {},
  getPlaylist: { id: id() },
  createPlaylist: {
    name: v.str({ max: 120, optional: false }),
    description: text(1000),
    kind: v.oneOf(["manual", "smart"]),
    rules: smartRules,
    trackIds: trackIdList(),
  },
  updatePlaylist: { id: id(), name: text(120), description: text(1000), rules: smartRules },
  deletePlaylist: { id: id() },
  addToPlaylist: { id: id(), trackIds: trackIdList({ optional: false }) },
  removeFromPlaylist: { id: id(), trackIds: trackIdList({ optional: false }) },
  movePlaylistTrack: { id: id(), trackId: id(), toPosition: v.int({ min: 1, max: 100000 }) },

  // Prepare for iPhone (folders come from dialogs or WaveMint's own detection).
  getExportSetup: {},
  previewExport: { scope: exportScope },
  exportForIphone: { scope: exportScope, allPlaylists: v.bool() },
  handOffToApple: { exportId: id(), folder: v.str({ max: 1000, optional: false }) },

  applyUpgrade: {
    candidateId: id(),
    // The final, edited metadata written into the new file (preferred) …
    metadata: v.obj({
      title: text(500),
      artist: text(500),
      albumArtist: text(500),
      album: text(500),
      genre: text(200),
      year: v.int({ min: 0, max: 9999, optional: true }),
      trackNo: v.int({ min: 0, max: 999, optional: true }),
      trackTotal: v.int({ min: 0, max: 999, optional: true }),
      discNo: v.int({ min: 0, max: 999, optional: true }),
      discTotal: v.int({ min: 0, max: 999, optional: true }),
      composer: text(500),
      comment: text(2000),
      compilation: v.bool(),
    }),
    // … or, per field, the current value or the replacement's.
    choices: v.obj(Object.fromEntries(["title", "artist", "albumArtist", "album", "genre", "year", "trackNo", "trackTotal", "discNo", "discTotal", "composer"].map((field) => [field, v.oneOf(["current", "candidate"])]))),
    artwork: v.oneOf(["current", "candidate", "custom", "none"]),
    artworkHash: v.str({ max: 40 }),
  },
};

// Renderer-callable methods the main process handles itself (dialogs, shell,
// Recycle Bin), with their parameter schemas. Paths never come from the
// renderer: files and folders are chosen in main-process dialogs.
const HOST_METHOD_SCHEMAS = {
  addSourceFromDialog: { role: v.oneOf(["legacy", "curated", "other"]), name: text(120), scan: v.bool() },
  relinkSource: { id: id() },
  setArtworkFromDialog: { trackIds: trackIdList({ optional: false }) },
  chooseManagedRoot: {},
  chooseUpgradeFile: { trackId: id() },
  chooseUpgradeArtwork: {},
  chooseExportRoot: {},
  chooseAutoAddFolder: {},
  openExportFolder: { report: v.bool() },
  exportPlaylistFile: { id: id(), relative: v.bool() },
  importPlaylistFile: {},
  deleteTrackFiles: { trackIds: trackIdList({ optional: false }) },
  cleanUpStorage: { categories: v.array(v.oneOf(CATEGORY_IDS, { optional: false }), { max: CATEGORY_IDS.length }) },
  showFileInFolder: { fileId: id() },
};
const HOST_METHOD_NAMES = Object.keys(HOST_METHOD_SCHEMAS);

// The automatic cleanup looks at most every few hours and acts at most daily.
const CLEANUP_FIRST_CHECK_MS = 3 * 60 * 1000;
const CLEANUP_CHECK_EVERY_MS = 3 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createLibraryHost({ app, ipcMain, dialog, shell, BrowserWindow, protocol, binaries, isExtractionBusy = () => false, logger = console }) {
  let worker = null;
  let ready = null;
  let nextCallId = 1;
  const pending = new Map();
  const dataDir = path.join(app.getPath("userData"), "library");
  const tempWorkDir = path.join(app.getPath("temp"), "WaveMint");
  let cleaning = null;

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
          tempWorkDir,
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

  // --- storage cleanup -------------------------------------------------------------

  /**
   * Runs a cleanup plan from the library: audio and backups to the Recycle
   * Bin, generated files deleted. Every target must resolve (links are never
   * followed) strictly inside one of WaveMint's own folders, never the
   * library's songs or the user's music folders.
   */
  async function cleanUpStorage({ categories = CATEGORY_IDS, auto = false } = {}) {
    if (cleaning) throw new Error("A cleanup is already running.");
    if (isExtractionBusy()) throw new Error("Wait for the current extraction to finish before cleaning up.");
    cleaning = (async () => {
      const managed = await call("getManagedLibrary", {});
      const roots = [
        managed?.source?.root_path ? path.join(managed.source.root_path, ".wavemint-archive") : null,
        path.join(dataDir, "backups"),
        path.join(dataDir, "cache"),
        path.join(dataDir, "artwork-store"),
        path.join(dataDir, "staging"),
        path.join(dataDir, "db-backups"),
        tempWorkDir,
      ].filter(Boolean);
      const { actions } = await call("planStorageCleanup", { categories, auto });
      const results = [];
      for (const action of actions) {
        // Started meanwhile? Leave the rest for the next run.
        if (auto && isExtractionBusy()) break;
        const result = { ...action, ok: false };
        try {
          const target = path.resolve(action.path);
          const stat = await fs.promises.lstat(target).catch(() => null);
          if (!stat) {
            result.ok = true; // already gone
          } else if (stat.isSymbolicLink()) {
            result.error = "Links are never followed.";
          } else {
            const real = await fs.promises.realpath(target);
            if (!isInsideRoots(real, roots)) {
              result.error = "Outside WaveMint's own folders; left alone.";
            } else if (action.action === "trash") {
              await shell.trashItem(real);
              result.ok = true;
            } else {
              await fs.promises.rm(real, { recursive: true, force: true });
              result.ok = true;
            }
          }
        } catch (error) {
          // In use, locked or no Recycle Bin on that drive: kept, reported.
          result.error = error.message;
        }
        if (!result.ok) logger.warn(`[library] Cleanup kept ${action.path}: ${result.error}`);
        results.push(result);
      }
      return call("finishStorageCleanup", { results, auto });
    })();
    try {
      return await cleaning;
    } finally {
      cleaning = null;
    }
  }

  // At most once a day, only when automatic cleanup is on and nothing else
  // (library task or extraction) is running.
  function startStorageMaintenance() {
    const check = async () => {
      try {
        if (cleaning || isExtractionBusy()) return;
        const state = await call("storageSchedule", {});
        if (!state.autoCleanup || state.busy) return;
        if (state.lastCleanupAt && Date.now() - Date.parse(state.lastCleanupAt) < CLEANUP_INTERVAL_MS) return;
        const result = await cleanUpStorage({ auto: true });
        logger.log(`[library] Automatic cleanup freed ${Math.round((result?.freedBytes || 0) / 1048576)} MB`);
        broadcast("library-changed", { storage: true });
      } catch (error) {
        logger.warn(`[library] Automatic cleanup skipped: ${error.message}`);
      }
    };
    setTimeout(check, CLEANUP_FIRST_CHECK_MS).unref?.();
    setInterval(check, CLEANUP_CHECK_EVERY_MS).unref?.();
  }

  // --- host-level operations (dialogs, shell) --------------------------------

  async function chooseFolder(sender, title) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), {
      title,
      properties: ["openDirectory", "dontAddToRecent"],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  /** One file chosen in a main-process dialog, or null. */
  async function chooseFile(sender, title, filter) {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(sender), {
      title,
      properties: ["openFile", "dontAddToRecent"],
      filters: [filter],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  const IMAGE_FILES = { name: "Images (JPEG or PNG)", extensions: ["jpg", "jpeg", "png"] };

  // Host methods run in the main process (dialogs, shell, the Recycle Bin);
  // their parameters are validated against HOST_METHOD_SCHEMAS first.
  const HOST_HANDLERS = {
    addSourceFromDialog: async (sender, params) => {
      const rootPath = await chooseFolder(sender, "Choose a music folder to add to your library");
      if (!rootPath) return null;
      const added = await call("addSource", { rootPath, role: params.role || "other", name: params.name });
      const job = params.scan === false ? null : await call("scanSources", { sourceIds: [added.id] });
      return { ...added, job };
    },
    relinkSource: async (sender, params) => {
      const rootPath = await chooseFolder(sender, "Choose the folder's new location");
      return rootPath ? call("updateSource", { id: params.id, patch: { rootPath } }) : null;
    },
    setArtworkFromDialog: async (sender, params) => {
      const filePath = await chooseFile(sender, "Choose cover art", IMAGE_FILES);
      return filePath ? call("setArtworkFromPath", { trackIds: params.trackIds, filePath }) : null;
    },
    chooseManagedRoot: async (sender) => {
      const rootPath = await chooseFolder(sender, "Choose a folder for your WaveMint Library");
      return rootPath ? call("setManagedRoot", { rootPath }) : null;
    },
    chooseUpgradeFile: async (sender, params) => {
      const filePath = await chooseFile(sender, "Choose the replacement audio file", { name: "Audio files", extensions: ["mp3", "m4a", "flac", "wav", "aif", "aiff", "aac"] });
      return filePath ? call("prepareUpgrade", { trackId: params.trackId, filePath }) : null;
    },
    // Artwork for an upgrade: the image is only stored; the upgrade writes it.
    chooseUpgradeArtwork: async (sender) => {
      const filePath = await chooseFile(sender, "Choose cover art", IMAGE_FILES);
      return filePath ? call("storeArtworkFile", { filePath }) : null;
    },
    chooseExportRoot: async (sender) => {
      const rootPath = await chooseFolder(sender, "Choose a folder for songs prepared for iPhone");
      return rootPath ? call("setExportRoot", { rootPath }) : null;
    },
    chooseAutoAddFolder: async (sender) => {
      const folder = await chooseFolder(sender, 'Choose Apple\'s "Automatically Add to iTunes" (or "to Music") folder');
      return folder ? call("setAutoAddFolder", { folder }) : null;
    },
    openExportFolder: async (_sender, params) => {
      const setup = await call("getExportSetup", {});
      if (!setup.root || !fs.existsSync(setup.root)) throw new Error("The export folder isn't available.");
      const problem = await shell.openPath(params.report ? path.join(setup.root, "WaveMint Export Report.txt") : setup.root);
      if (problem) throw new Error(problem);
      return { opened: true };
    },
    exportPlaylistFile: async (sender, params) => {
      const playlist = await call("getPlaylist", { id: params.id });
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), {
        title: "Export playlist",
        defaultPath: `${playlist.name.replace(/[<>:"/\\|?*]/g, " ").trim() || "Playlist"}.m3u8`,
        filters: [{ name: "M3U8 playlist", extensions: ["m3u8"] }],
      });
      if (result.canceled || !result.filePath) return null;
      return call("exportPlaylistM3U8", { id: params.id, filePath: result.filePath, relative: !!params.relative });
    },
    importPlaylistFile: async (sender) => {
      const filePath = await chooseFile(sender, "Import a playlist", { name: "Playlists", extensions: ["m3u8", "m3u"] });
      return filePath ? call("importPlaylistM3U", { filePath }) : null;
    },
    // Delete File: the songs' files go to the Recycle Bin, then the songs
    // leave the library. Which files is decided by the library (only the
    // songs' own audio files in folders WaveMint may change), never by the
    // renderer.
    deleteTrackFiles: async (_sender, params) => {
      const plan = await call("planFileDeletion", { trackIds: params.trackIds });
      const results = [];
      for (const item of plan.items) {
        const result = { trackId: item.trackId, trashed: [], missing: [], failed: [] };
        for (const file of item.files) {
          if (!file.path || !fs.existsSync(file.path)) {
            result.missing.push(file.fileId);
            continue;
          }
          try {
            await shell.trashItem(path.resolve(file.path));
            result.trashed.push(file.fileId);
          } catch (error) {
            logger.warn(`[library] Couldn't move ${file.name} to the Recycle Bin: ${error.message}`);
            result.failed.push({ name: file.name, error: "It couldn't be moved to the Recycle Bin (it may be open in another app)." });
          }
        }
        results.push(result);
      }
      const finished = await call("finishFileDeletion", { results });
      return { ...finished, blocked: plan.blocked };
    },
    cleanUpStorage: async (_sender, params) => {
      const result = await cleanUpStorage({ categories: params.categories?.length ? params.categories : CATEGORY_IDS });
      broadcast("library-changed", { storage: true });
      return result;
    },
    showFileInFolder: async (_sender, params) => {
      const file = await call("resolvePlayback", { fileId: params.fileId });
      if (!file || !fs.existsSync(file.path)) throw new Error("This file isn't available right now.");
      shell.showItemInFolder(file.path);
      return { shown: true };
    },
  };
  // Every handler has a schema and every schema a handler.
  const unmatched = [...Object.keys(HOST_HANDLERS), ...HOST_METHOD_NAMES].filter((name) => !Object.hasOwn(HOST_HANDLERS, name) || !Object.hasOwn(HOST_METHOD_SCHEMAS, name));
  if (unmatched.length) throw new Error(`Library host methods without a handler or schema: ${unmatched.join(", ")}`);

  function register() {
    ipcMain.handle("library", async (event, method, params) => {
      if (typeof method !== "string") throw new Error("Unknown library operation");

      if (Object.hasOwn(HOST_HANDLERS, method)) return HOST_HANDLERS[method](event.sender, validate(HOST_METHOD_SCHEMAS[method], params));

      if (!Object.hasOwn(WORKER_METHODS, method)) throw new Error("Unknown library operation");
      return call(method, validate(WORKER_METHODS[method], params));
    });
  }

  // --- protocols ----------------------------------------------------------------

  function streamFile(filePath, request, contentType) {
    const size = fs.statSync(filePath).size;
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
    // Only WaveMint's own window can reach this scheme; "*" lets its page
    // (file:// when installed, localhost in development) analyse the audio.
    const headers = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

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
    // wavemint-media://file/<fileId>, wavemint-media://candidate/<candidateId>
    // and wavemint-media://staged/<token> (an extraction waiting to be added).
    protocol.handle(MEDIA_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname === "staged") {
          const token = url.pathname.replace(/^\/+/, "");
          if (!/^[a-f0-9]{32}$/.test(token)) return new Response(null, { status: 400 });
          const staged = await call("resolveStagedExtraction", { token });
          if (!staged || !fs.existsSync(staged.path)) return new Response(null, { status: 404 });
          return streamFile(staged.path, request, MIME_TYPES[path.extname(staged.path).toLowerCase()] || "application/octet-stream");
        }
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

  return { call, register, registerProtocols, shutdown, startStorageMaintenance, startWorker };
}

// Must run before the app is ready.
function registerLibrarySchemes(protocol) {
  protocol.registerSchemesAsPrivileged([
    // corsEnabled: Listen Mode's visualizer reads the playing audio through Web
    // Audio, which needs the media to be CORS-readable by the app's page.
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: ART_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}


module.exports = { HOST_METHOD_NAMES, HOST_SCHEMES: [MEDIA_SCHEME, ART_SCHEME], WORKER_METHODS, createLibraryHost, registerLibrarySchemes };
