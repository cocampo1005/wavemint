// The library service: every operation the UI can request, implemented on
// top of the database and the domain modules. Runs inside the library
// worker. Methods receive already-validated parameters (see host.cjs).

const path = require("path");
const { createArtStore } = require("./artstore.cjs");
const { getSetting, setSetting } = require("./db.cjs");
const queries = require("./queries.cjs");
const sources = require("./sources.cjs");
const { createScanner } = require("./scanner.cjs");
const edits = require("./edits.cjs");
const { createFileOps } = require("./fileops.cjs");
const genres = require("./genres.cjs");
const operations = require("./operations.cjs");
const review = require("./review.cjs");
const { readArtwork } = require("./tags.cjs");

const SETTINGS_DEFAULTS = {
  managedRoot: "",
  namingPattern: "{albumArtist}/{album}/{disc-}{track} {title}",
  preferOriginalReleases: true,
  lowBitrateKbps: queries.LOW_BITRATE_KBPS,
  exportRoot: "",
  musicBrainzEnabled: false,
};

function createLibraryService({ db, media, jobs, paths, logger = console }) {
  const scanner = createScanner({ db, probe: media?.probe, logger });
  const artStore = createArtStore(path.join(paths.dataDir, "artwork-store"));
  const fileOps = createFileOps({ db, media, artStore, backupsRoot: paths.backupsDir, logger });

  // Anything interrupted last time (crash, power loss) is finished or rolled
  // back before any new work starts.
  const recovered = fileOps.recover();
  if (recovered.length) logger.warn(`[library] Recovered ${recovered.length} interrupted file step(s)`);

  function activeTrackIds(releaseId) {
    return db.prepare("SELECT id FROM tracks WHERE release_id = ? AND state = 'active'").all(Number(releaseId)).map((row) => row.id);
  }

  // Artwork from another song: its WaveMint artwork, or its file's embedded art.
  function artworkFromTrack(trackId) {
    const row = db
      .prepare("SELECT t.artwork_hash, f.path, f.artwork_hash AS file_art FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id WHERE t.id = ?")
      .get(Number(trackId));
    if (!row) throw new Error("That song no longer exists.");
    if (row.artwork_hash) return row.artwork_hash;
    if (!row.file_art || !row.path) throw new Error("That song has no artwork to copy.");
    const art = readArtwork(row.path);
    if (!art) throw new Error("That song's artwork couldn't be read.");
    return artStore.save(art.data).hash;
  }

  function getSettings() {
    return { ...SETTINGS_DEFAULTS, ...getSetting(db, "library", {}) };
  }

  const methods = {
    // --- overview and browsing -------------------------------------------
    getOverview: () => queries.getDashboard(db),
    getStatus: () => queries.getStatus(db),
    listTracks: (params) => queries.listTracks(db, params),
    listTrackIds: (params) => queries.listTrackIds(db, params),
    listAlbums: (params) => queries.listAlbums(db, params),
    listArtists: (params) => queries.listArtists(db, params),
    getAlbum: ({ id }) => queries.getAlbum(db, id),
    listGenres: () => queries.listGenres(db),
    getTrack: ({ id }) => queries.getTrack(db, id),

    // --- sources -----------------------------------------------------------
    listSources: () => queries.listSources(db),
    addSource: ({ rootPath, role, name }) => sources.addSource(db, { rootPath, role, name }),
    updateSource: ({ id, patch }) => sources.updateSource(db, id, patch),
    removeSource: ({ id }) => {
      if (jobs.isBusy()) throw new Error("Wait for the current library task to finish first.");
      return sources.removeSource(db, id);
    },
    detectItunes: ({ rootPath }) => sources.detectItunes(rootPath),

    scanSources: ({ sourceIds }) => {
      const ids = sourceIds?.length
        ? sourceIds
        : db.prepare("SELECT id FROM sources ORDER BY priority DESC").all().map((row) => row.id);
      return jobs.start("scan", ids.length === 1 ? "Scanning library folder" : "Scanning library folders", async ({ signal, progress }) => {
        const results = [];
        for (const [index, id] of ids.entries()) {
          if (signal.aborted) break;
          const result = await scanner.scanSource(id, {
            signal,
            onProgress: (value) => progress({ ...value, sourceIndex: index + 1, sourceCount: ids.length }),
          });
          results.push({ sourceId: id, ...result });
        }
        // Fresh findings for the review queue.
        const reviewResult = review.refreshReview(db);
        return { results, review: reviewResult };
      });
    },

    // --- metadata editing --------------------------------------------------------
    previewEdits: ({ edits: list }) => edits.previewEdits(db, list),
    applyEdits: ({ edits: list, exclude, label }) => edits.applyEdits(db, list, { exclude, label: label || "Edit metadata" }),
    suggestTitleCase: ({ trackIds }) =>
      db
        .prepare(`SELECT id, title FROM tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`)
        .all(...trackIds)
        .map((row) => ({ trackId: row.id, fields: { title: edits.titleCase(row.title) } })),
    editAlbum: ({ releaseId, fields, label }) => {
      const ids = activeTrackIds(releaseId);
      if (!ids.length) throw new Error("This album has no songs.");
      return edits.applyEdits(db, ids.map((trackId) => ({ trackId, fields })), { label: label || "Edit album" });
    },
    setArtworkFromPath: ({ trackIds, filePath }) => {
      const { hash } = artStore.saveFromFile(filePath);
      return { hash, ...edits.setTrackArtwork(db, trackIds, hash, { label: "Change artwork" }) };
    },
    copyArtwork: ({ trackIds, fromTrackId }) => {
      const hash = artworkFromTrack(fromTrackId);
      return { hash, ...edits.setTrackArtwork(db, trackIds, hash, { label: "Use artwork from another song" }) };
    },
    clearArtwork: ({ trackIds }) => edits.setTrackArtwork(db, trackIds, null, { label: "Use the file's own artwork" }),
    albumTrackIds: ({ releaseId }) => activeTrackIds(releaseId),

    // --- writing tags into files ---------------------------------------------
    previewTagWrite: ({ trackIds }) => fileOps.previewTagWrite(trackIds?.length ? trackIds : null),
    writeTags: ({ trackIds }) =>
      jobs.start("write-tags", "Writing tags to files", ({ signal, progress }) =>
        fileOps.writeTagsJob({ trackIds: trackIds?.length ? trackIds : null, signal, progress }),
      ),

    // --- history -------------------------------------------------------------------
    listOperations: (params) => operations.listOperations(db, params),
    getOperation: ({ id }) => operations.getOperationDetail(db, id),
    undoOperation: async ({ id }) => {
      if (jobs.isBusy()) throw new Error("Wait for the current library task to finish first.");
      const operation = db.prepare("SELECT kind FROM operations WHERE id = ?").get(Number(id));
      if (!operation) throw new Error("This change no longer exists.");
      if (operation.kind === "tag-write") return fileOps.undoTagWrite(id);
      return edits.undoMetadataOperation(db, id);
    },

    // --- genres ------------------------------------------------------------------
    listGenreTaxonomy: () => genres.listTaxonomy(db),
    genreReport: () => genres.genreReport(db),
    createGenre: (params) => genres.createGenre(db, params),
    renameGenre: (params) => genres.renameGenre(db, params),
    mergeGenres: (params) => genres.mergeGenres(db, params),
    deleteGenre: (params) => genres.deleteGenre(db, params),
    setGenreParent: (params) => genres.setParent(db, params),
    addGenreAlias: (params) => genres.addAlias(db, params),
    removeGenreAlias: (params) => genres.removeAlias(db, params),
    adoptGenreLabels: (params) => genres.adoptLabels(db, params),
    listGenreRules: () => genres.listRules(db),
    addGenreRule: (params) => genres.addRule(db, params),
    updateGenreRule: (params) => genres.updateRule(db, params),
    removeGenreRule: (params) => genres.removeRule(db, params),
    previewGenreRules: () => genres.previewRules(db),
    applyGenreRules: (params) => genres.applyRules(db, params),

    // --- review queue ----------------------------------------------------------
    refreshReview: () => review.refreshReview(db),
    reviewSummary: () => review.reviewSummary(db),
    listReviewItems: (params) => review.listReviewItems(db, params),
    setReviewStatus: (params) => review.setReviewStatus(db, params),
    approveSuggestions: (params) => review.approveSuggestions(db, params),

    // --- jobs ----------------------------------------------------------------
    listJobs: () => jobs.list(),
    cancelJob: ({ id }) => ({ cancelled: jobs.cancel(id) }),

    // --- settings ------------------------------------------------------------
    getSettings,
    updateSettings: ({ patch }) => {
      const next = { ...getSettings(), ...patch };
      setSetting(db, "library", next);
      return next;
    },

    // --- host-only (never callable from the renderer) -------------------------
    resolvePlayback: ({ fileId }) => {
      const file = db.prepare("SELECT path, ext, status FROM files WHERE id = ?").get(Number(fileId));
      return file && file.status !== "missing" ? { path: file.path, ext: file.ext } : null;
    },
    resolvePreview: async ({ fileId }) => {
      const file = db.prepare("SELECT id, path, ext, codec, mtime_ms, status FROM files WHERE id = ?").get(Number(fileId));
      if (!file || file.status === "missing") return null;
      const needsConversion = file.codec === "alac" || file.ext === ".aif" || file.ext === ".aiff";
      if (!needsConversion) return { path: file.path };
      return { path: await media.previewFile({ fileId: file.id, filePath: file.path, mtimeMs: file.mtime_ms }) };
    },
    resolveArtwork: async ({ hash, size }) => {
      const key = String(hash);
      const available =
        artStore.locate(key) ||
        db.prepare("SELECT 1 FROM files WHERE artwork_hash = ? AND status = 'ok' LIMIT 1").get(key);
      if (!available) return null;
      return { path: await media.thumbnail(key, Number(size), () => artStore.read(key, db)) };
    },
    getPaths: () => paths,
  };

  return { methods, getSettings };
}

module.exports = { SETTINGS_DEFAULTS, createLibraryService };
