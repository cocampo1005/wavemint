// The library service: every operation the UI can request, implemented on
// top of the database and the domain modules. Runs inside the library
// worker. Methods receive already-validated parameters (see host.cjs).

const fs = require("fs");
const path = require("path");
const { createArtStore } = require("./artstore.cjs");
const { getSetting, setSetting } = require("./db.cjs");
const queries = require("./queries.cjs");
const sources = require("./sources.cjs");
const { contentHash, createScanner } = require("./scanner.cjs");
const { createConsolidator } = require("./consolidate.cjs");
const { createMerge } = require("./merge.cjs");
const { DEFAULT_PATTERN, relativePathFor, validatePattern } = require("./organize.cjs");
const edits = require("./edits.cjs");
const { createFileOps } = require("./fileops.cjs");
const genres = require("./genres.cjs");
const operations = require("./operations.cjs");
const quality = require("./quality.cjs");
const review = require("./review.cjs");
const { createUpgrader } = require("./upgrade.cjs");
const { createIdentifier } = require("./identify.cjs");
const { createImporter } = require("./importer.cjs");
const { createExporter } = require("./exporter.cjs");
const playlists = require("./playlists.cjs");
const { createMusicBrainz } = require("./musicbrainz.cjs");
const { createWebClient } = require("./webclient.cjs");
const { readArtwork } = require("./tags.cjs");

const SETTINGS_DEFAULTS = {
  managedRoot: "",
  namingPattern: DEFAULT_PATTERN,
  preferOriginalReleases: true,
  lowBitrateKbps: queries.LOW_BITRATE_KBPS,
  exportRoot: "",
  convertWavAiff: true,
  appleAutoAddFolder: "",
  musicBrainzEnabled: false,
};

function createLibraryService({ db, media, jobs, paths, logger = console, appVersion = "dev", fetchImpl }) {
  const scanner = createScanner({ db, probe: media?.probe, logger });
  const artStore = createArtStore(path.join(paths.dataDir, "artwork-store"));
  const fileOps = createFileOps({ db, media, artStore, backupsRoot: paths.backupsDir, logger });
  const merge = createMerge({ db, contentHash, logger });
  const consolidator = createConsolidator({ db, media, artStore, logger });
  const upgrader = createUpgrader({ db, media, artStore, managedSource: consolidator.managedSource, getSettings, logger });
  // MusicBrainz asks every application to identify itself with a contact URL.
  const web = createWebClient({ db, userAgent: `WaveMint/${appVersion} ( https://github.com/cocampo1005/wavemint )`, fetchImpl, logger });
  const identifier = createIdentifier({ db, mb: createMusicBrainz({ web }), artStore, getSettings, logger });
  const importer = createImporter({ db, media, artStore, upgrader, managedSource: consolidator.managedSource, getSettings, paths, logger });
  const exporter = createExporter({ db, media, artStore, getSettings, logger });

  // Anything interrupted last time (crash, power loss) is finished or rolled
  // back before any new work starts.
  const recovered = [...fileOps.recover(), ...consolidator.recover(), ...upgrader.recover(), ...importer.recover()];
  if (recovered.length) logger.warn(`[library] Recovered ${recovered.length} interrupted file step(s)`);

  // Online lookups only happen after the user turned them on.
  function requireOnline() {
    if (!getSettings().musicBrainzEnabled) {
      const error = new Error("Turn on MusicBrainz lookups first (Library → Identify).");
      error.code = "musicbrainz-off";
      throw error;
    }
  }

  function requireIdle() {
    if (jobs.isBusy()) throw new Error("Wait for the current library task to finish first.");
  }

  function managedRoot() {
    const root = consolidator.managedSource()?.root_path || getSettings().managedRoot;
    if (!root) throw new Error("Choose a folder for the WaveMint Library first.");
    return root;
  }

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

  const refreshQuality = (trackIds = null) => quality.refreshQuality(db, { trackIds, lowBitrateKbps: getSettings().lowBitrateKbps });

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
      requireIdle();
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
        // Fresh findings for the review queue and quality statuses.
        const reviewResult = review.refreshReview(db);
        refreshQuality();
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
      requireIdle();
      const operation = db.prepare("SELECT kind FROM operations WHERE id = ?").get(Number(id));
      if (!operation) throw new Error("This change no longer exists.");
      if (operation.kind === "tag-write") return fileOps.undoTagWrite(id);
      if (operation.kind === "merge") return merge.undoMerge(id);
      if (operation.kind === "consolidate") {
        const result = consolidator.undoConsolidation(id);
        refreshQuality();
        return result;
      }
      if (operation.kind === "upgrade") return upgrader.undoUpgrade(id);
      if (operation.kind === "import") {
        const result = importer.undoImport(id);
        review.refreshReview(db);
        return result;
      }
      if (operation.kind === "quality") {
        const result = edits.undoMetadataOperation(db, id);
        refreshQuality();
        return result;
      }
      return edits.undoMetadataOperation(db, id);
    },

    // --- merging libraries ----------------------------------------------------
    analyzeMerge: () =>
      jobs.start("merge-analysis", "Comparing libraries", ({ signal, progress }) => merge.analyze({ signal, progress })),
    currentMergeSession: () => merge.currentSession(),
    listMergeGroups: (params) => merge.listGroups(params),
    setMergeGroupAction: (params) => merge.setGroupAction(params),
    acceptMergeSuggestions: (params) => merge.acceptSuggestions(params),
    applyMerge: (params) => {
      requireIdle();
      const result = merge.apply(params);
      review.refreshReview(db);
      refreshQuality();
      return result;
    },

    // --- Managed Library -------------------------------------------------------
    getManagedLibrary: () => {
      const source = consolidator.managedSource();
      const settings = getSettings();
      return { source: source || null, root: source?.root_path || settings.managedRoot || "", pattern: settings.namingPattern };
    },
    // Host-only: the folder always comes from a main-process dialog.
    setManagedRoot: ({ rootPath }) => {
      requireIdle();
      const source = consolidator.ensureManagedSource(rootPath);
      setSetting(db, "library", { ...getSettings(), managedRoot: source.root_path });
      const entries = fs.readdirSync(source.root_path).filter((name) => !name.startsWith("."));
      return { source, empty: entries.length === 0 };
    },
    previewNamingPattern: ({ pattern }) => {
      validatePattern(pattern);
      const rows = db
        .prepare(
          `SELECT t.*, f.ext FROM tracks t JOIN files f ON f.id = t.active_file_id
           WHERE t.state = 'active' ORDER BY (t.album IS NULL), t.disc_total DESC, t.id LIMIT 6`,
        )
        .all();
      return rows.map((row) => ({ trackId: row.id, title: row.title, relPath: `${relativePathFor(row, pattern)}${row.ext}` }));
    },
    previewConsolidation: ({ trackIds }) =>
      consolidator.preview({ root: managedRoot(), pattern: getSettings().namingPattern, trackIds: trackIds?.length ? trackIds : null }),
    consolidate: ({ trackIds }) => {
      const root = managedRoot();
      const pattern = getSettings().namingPattern;
      return jobs.start("consolidate", "Copying into the WaveMint Library", async ({ signal, progress }) => {
        const result = await consolidator.consolidateJob({ root, pattern, trackIds: trackIds?.length ? trackIds : null, signal, progress });
        refreshQuality();
        return result;
      });
    },

    // --- audio quality and upgrades -------------------------------------------
    qualitySummary: () => quality.qualitySummary(db),
    listQualityQueue: (params) => quality.listQueue(db, params),
    refreshQuality: () => ({ updated: refreshQuality() }),
    checkQuality: ({ trackIds, force }) =>
      jobs.start("quality-check", "Checking audio quality", ({ signal, progress }) =>
        quality.checkJob(db, media, {
          trackIds: trackIds?.length ? trackIds : null,
          force: !!force,
          lowBitrateKbps: getSettings().lowBitrateKbps,
          signal,
          progress,
          logger,
        }),
      ),
    setQualityStatus: ({ trackIds, status }) => quality.setQualityStatus(db, { trackIds, status, lowBitrateKbps: getSettings().lowBitrateKbps }),
    // filePath only from the host (a main-process dialog); the renderer can pick versions.
    prepareUpgrade: ({ trackId, fileId, filePath }) => {
      requireIdle();
      return upgrader.prepare({ trackId, fileId, filePath });
    },
    compareUpgrade: (params) => upgrader.compare(params),
    discardUpgrade: (params) => upgrader.discard(params),
    listUpgradeCandidates: (params) => upgrader.listCandidates(params),
    applyUpgrade: ({ candidateId, choices, artwork }) =>
      jobs.start("upgrade", "Upgrading song", ({ signal, progress }) => upgrader.applyJob({ candidateId, choices, artwork, signal, progress })),

    // --- identification (MusicBrainz) ---------------------------------------------
    identifySong: async ({ trackId }) => {
      requireOnline();
      const result = await identifier.identifyTrack(trackId);
      review.refreshReview(db);
      return result;
    },
    identifySongs: ({ trackIds, onlyNew }) => {
      requireOnline();
      return jobs.start("identify", "Identifying songs with MusicBrainz", async ({ signal, progress }) => {
        const report = await identifier.identifyJob({ trackIds: trackIds?.length ? trackIds : null, onlyNew: onlyNew !== false, signal, progress });
        review.refreshReview(db);
        return report;
      });
    },
    getIdentification: ({ trackId }) => identifier.view(trackId),
    chooseIdentificationRelease: (params) => identifier.chooseRelease(params),
    identificationCover: async ({ trackId }) => {
      requireOnline();
      return identifier.cover({ trackId });
    },
    applyIdentification: ({ trackId, fields, coverHash }) => {
      // Only covers WaveMint itself stored can be used.
      if (coverHash && !artStore.locate(coverHash)) throw new Error("That cover isn't available anymore. Load it again.");
      const result = identifier.apply({ trackId, fields, coverHash: coverHash || null });
      review.refreshReview(db);
      return result;
    },
    dismissIdentifications: (params) => {
      const result = identifier.dismiss(params);
      review.refreshReview(db);
      return result;
    },
    applyConfidentIdentifications: ({ minConfidence }) => {
      const result = identifier.applyConfident({ minConfidence: minConfidence || 0.9 });
      review.refreshReview(db);
      return result;
    },
    listIdentifications: (params) => identifier.list(params),
    identificationSummary: () => ({ ...identifier.summary(), enabled: !!getSettings().musicBrainzEnabled }),
    identifyAlbumCandidates: async (params) => {
      requireOnline();
      return identifier.albumCandidates(params);
    },
    identifyAlbumProposal: async (params) => {
      requireOnline();
      return identifier.albumProposal(params);
    },
    applyAlbumIdentification: async (params) => {
      requireOnline();
      const result = await identifier.applyAlbum({ ...params, exclude: params.exclude || [] });
      review.refreshReview(db);
      return result;
    },

    // --- playlist import ------------------------------------------------------------
    startImport: (params) => importer.startSession(params),
    updateImport: (params) => importer.updateSession(params),
    getImport: ({ sessionId }) => importer.view(sessionId),
    listImports: () => importer.listSessions(),
    commitImport: ({ sessionId, decisions }) =>
      jobs.start("import", "Importing into the WaveMint Library", async ({ signal, progress }) => {
        const report = await importer.commitJob({ sessionId, decisions, signal, progress });
        review.refreshReview(db);
        refreshQuality();
        return report;
      }),
    discardImport: (params) => importer.discard(params),
    // Host only: the main process saves extractions into staging.
    prepareImportStaging: (params) => importer.prepareStaging(params),
    addStagedImport: (params) => importer.addStaged(params),

    // --- playlists -------------------------------------------------------------------
    listPlaylists: () => playlists.listPlaylists(db),
    getPlaylist: (params) => playlists.getPlaylist(db, params),
    createPlaylist: (params) => playlists.createPlaylist(db, params),
    updatePlaylist: (params) => playlists.updatePlaylist(db, params),
    deletePlaylist: (params) => playlists.deletePlaylist(db, params),
    addToPlaylist: (params) => playlists.addTracks(db, params),
    removeFromPlaylist: (params) => playlists.removeTracks(db, params),
    movePlaylistTrack: (params) => playlists.moveTrack(db, params),
    // Host only (paths from main-process dialogs).
    exportPlaylistM3U8: (params) => playlists.exportM3U8(db, params),
    importPlaylistM3U: (params) => playlists.importM3U(db, params),

    // --- Prepare for iPhone ------------------------------------------------------------
    getExportSetup: () => {
      const settings = getSettings();
      const detected = exporter.findAutoAddFolders();
      const autoAdd = [...new Set([settings.appleAutoAddFolder, ...detected].filter(Boolean))];
      return { root: settings.exportRoot || "", convertWavAiff: settings.convertWavAiff !== false, autoAddFolders: autoAdd, last: exporter.lastExport({ root: settings.exportRoot || null }) };
    },
    previewExport: ({ scope }) => exporter.preview({ root: getSettings().exportRoot, scope, options: { convertWavAiff: getSettings().convertWavAiff !== false } }),
    exportForIphone: ({ scope, allPlaylists }) => {
      const settings = getSettings();
      exporter.checkRoot(settings.exportRoot);
      return jobs.start("export", "Preparing songs for iPhone", ({ signal, progress }) =>
        exporter.exportJob({
          root: settings.exportRoot,
          scope,
          options: { convertWavAiff: settings.convertWavAiff !== false, playlists: allPlaylists ? "all" : "selected" },
          signal,
          progress,
        }),
      );
    },
    handOffToApple: ({ exportId, folder }) => {
      // Only Apple's own folders that WaveMint found or the user chose.
      const settings = getSettings();
      const allowed = [settings.appleAutoAddFolder, ...exporter.findAutoAddFolders()].filter(Boolean).map((item) => path.resolve(item).toLowerCase());
      if (!allowed.includes(path.resolve(String(folder || "")).toLowerCase())) throw new Error("Choose Apple's Automatically Add folder first.");
      return exporter.handOff({ exportId, folder });
    },
    // Host only.
    setExportRoot: ({ rootPath }) => {
      const root = exporter.checkRoot(rootPath);
      setSetting(db, "library", { ...getSettings(), exportRoot: root });
      return { root };
    },
    setAutoAddFolder: ({ folder }) => {
      if (!/^Automatically Add to (?:iTunes|Music|Apple Music)$/i.test(path.basename(folder))) {
        throw new Error('That isn\'t an "Automatically Add to iTunes/Music" folder.');
      }
      setSetting(db, "library", { ...getSettings(), appleAutoAddFolder: path.resolve(folder) });
      return { folder: path.resolve(folder) };
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
      if (patch.namingPattern !== undefined) patch = { ...patch, namingPattern: validatePattern(patch.namingPattern) };
      const before = getSettings();
      const next = { ...before, ...patch };
      setSetting(db, "library", next);
      if (next.lowBitrateKbps !== before.lowBitrateKbps) refreshQuality();
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
    resolveCandidatePreview: async ({ candidateId }) => {
      const candidate = upgrader.resolveCandidateFile({ candidateId });
      if (!candidate) return null;
      const ext = path.extname(candidate.path).toLowerCase();
      const codec = JSON.parse(db.prepare("SELECT info FROM upgrade_candidates WHERE id = ?").get(candidate.id).info || "{}").tags?.codec;
      if (![".aif", ".aiff"].includes(ext) && codec !== "alac") return { path: candidate.path };
      const stat = fs.statSync(candidate.path);
      return { path: await media.previewFile({ fileId: `c${candidate.id}`, filePath: candidate.path, mtimeMs: stat.mtimeMs }) };
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
