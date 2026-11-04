// The library service: every operation the UI can request, implemented on
// top of the database and the domain modules. Runs inside the library
// worker. Methods receive already-validated parameters (see host.cjs).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createArtStore } = require("./artstore.cjs");
const { createAudioEditor } = require("./audioedit.cjs");
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
const review = require("./review.cjs");
const { createUpgrader } = require("./upgrade.cjs");
const { createIdentifier } = require("./identify.cjs");
const { createImporter } = require("./importer.cjs");
const { createExporter } = require("./exporter.cjs");
const { createAppleMigration } = require("./applemigrate.cjs");
const { createAppleSync } = require("./applesync.cjs");
const { createItunesAdapter } = require("./itunes.cjs");
const formats = require("./formats.cjs");
const { createRemoval } = require("./removal.cjs");
const { DEFAULT_RETENTION, createStorage } = require("./storage.cjs");
const playlists = require("./playlists.cjs");
const { createMusicBrainz } = require("./musicbrainz.cjs");
const { createWebClient } = require("./webclient.cjs");
const { readArtwork } = require("./tags.cjs");

const SETTINGS_DEFAULTS = {
  managedRoot: "",
  namingPattern: DEFAULT_PATTERN,
  preferOriginalReleases: true,
  lowBitrateKbps: queries.LOW_BITRATE_KBPS,
  // Review → Needs Attention flags songs without an album (off for libraries of singles).
  reviewMissingAlbum: true,
  exportRoot: "",
  convertWavAiff: true,
  appleAutoAddFolder: "",
  // Apple synchronization (applesync.cjs): "itunes" drives classic iTunes;
  // "files" only keeps the Apple Library folder (Apple Music for Windows).
  appleDestination: "itunes",
  appleAutoSync: false,
  // What happens to an iTunes entry when its song leaves WaveMint:
  // "confirm" (ask each time), "auto" (small batches only), "keep" (stop managing it).
  appleRemovalPolicy: "confirm",
  // Where converted copies of files iTunes can't play (FLAC…) are kept; empty = WaveMint's data folder.
  appleCompatRoot: "",
  musicBrainzEnabled: false,
  // How long previous versions and tag-write backups are kept (storage.cjs).
  keepPreviousVersions: DEFAULT_RETENTION,
  autoCleanup: true,
};

function createLibraryService({ db, media, jobs, paths, logger = console, emit = () => {}, appVersion = "dev", fetchImpl, appleAdapter = null }) {
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
  const audioEditor = createAudioEditor({ db, media, artStore, upgrader, importer, managedSource: consolidator.managedSource, getSettings, paths, logger });
  audioEditor.cleanup();
  const removal = createRemoval({ db });
  const storage = createStorage({ db, managedSource: consolidator.managedSource, getSettings, paths, importer, logger });

  // Anything interrupted last time (crash, power loss) is finished or rolled
  // back before any new work starts.
  const recovered = [...fileOps.recover(), ...consolidator.recover(), ...upgrader.recover(), ...importer.recover()];
  if (recovered.length) logger.warn(`[library] Recovered ${recovered.length} interrupted file step(s)`);

  // Online lookups only happen after the user turned them on.
  function requireOnline() {
    if (!getSettings().musicBrainzEnabled) {
      const error = new Error("Turn on MusicBrainz lookups first (Library Tools → Identify Songs).");
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

  const refreshReview = () => review.refreshReview(db, { flagMissingAlbum: getSettings().reviewMissingAlbum !== false });

  // --- Saving edits into the files ---------------------------------------------
  // An edit is saved in the database and then written through into the song's
  // file (only where WaveMint may write: the WaveMint Library and folders the
  // user allowed changes to, in MP3/M4A/FLAC). One file write runs at a time.
  // While a task that moves or rescans files runs, writes wait for it and are
  // made as soon as it finishes; the song stays marked as not yet written.
  const DEFERRING_JOBS = new Set(["scan", "write-tags", "consolidate", "upgrade", "import", "audio-edit"]);
  const INLINE_WRITE_LIMIT = 25;
  const SAVE_BACKUP_REUSE_MS = 24 * 60 * 60 * 1000;
  const EDIT_KINDS = ["metadata", "artwork", "genre"];
  let writeChain = Promise.resolve();
  const pendingWrites = new Set();

  function serialWrite(work) {
    const run = writeChain.then(work, work);
    writeChain = run.catch(() => {});
    return run;
  }

  function lastOperationId() {
    return db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM operations").get().id;
  }

  /** Songs changed by metadata/artwork/genre operations newer than `afterId`. */
  function tracksEditedSince(afterId) {
    return db
      .prepare(
        `SELECT DISTINCT c.entity_id AS id FROM change_log c JOIN operations o ON o.id = c.operation_id
         WHERE o.id > ? AND c.entity_type = 'track' AND o.kind IN (${EDIT_KINDS.map(() => "?").join(",")})`,
      )
      .all(afterId, ...EDIT_KINDS)
      .map((row) => row.id);
  }

  /**
   * Writes the tags of `trackIds` into their files. Returns
   * { written, failed: [{ trackId, error }], blocked, deferred, job }.
   * Small sets are written before this returns; large ones run as a
   * background "write-tags" job.
   */
  async function writeThrough(trackIds, { partOf = null, background = true } = {}) {
    const ids = [...new Set(trackIds.map(Number))];
    const empty = { written: 0, failed: [], blocked: 0, deferred: 0, job: null };
    if (!ids.length) return empty;
    const { writable, blocked } = fileOps.previewTagWrite(ids);
    if (!writable.length) return { ...empty, blocked: blocked.length };
    const targets = writable.map((item) => item.trackId);

    if (DEFERRING_JOBS.has(jobs.runningKind?.())) {
      for (const id of targets) pendingWrites.add(id);
      return { ...empty, blocked: blocked.length, deferred: targets.length };
    }
    if (background && targets.length > INLINE_WRITE_LIMIT) {
      try {
        const job = jobs.start("write-tags", "Saving changes to files", ({ signal, progress }) =>
          fileOps.writeTagsJob({ trackIds: targets, signal, progress, partOf, reuseBackupMs: SAVE_BACKUP_REUSE_MS }),
        );
        return { ...empty, blocked: blocked.length, job };
      } catch {
        for (const id of targets) pendingWrites.add(id);
        return { ...empty, blocked: blocked.length, deferred: targets.length };
      }
    }
    const result = await serialWrite(() => fileOps.writeTagsJob({ trackIds: targets, partOf, reuseBackupMs: SAVE_BACKUP_REUSE_MS }));
    return {
      ...empty,
      written: result.written,
      failed: result.results.filter((item) => !item.ok).map((item) => ({ trackId: item.trackId, error: item.error })),
      blocked: blocked.length,
    };
  }

  // --- Apple library synchronization ------------------------------------------------
  // The Apple Library folder is the export folder (exporter.cjs); iTunes follows it
  // (applesync.cjs). A change to the collection only records that sync work exists;
  // the sync itself runs once edits settle, never in the middle of a file operation.
  const adapter = appleAdapter || createItunesAdapter({ workDir: path.join(paths.dataDir, "apple"), logger });
  // iTunes only ever receives the real library: never a test library in the
  // temporary folder (WAVEMINT_ALLOW_TEMP_LIBRARY=1 overrides, for experiments),
  // and never one whose folder isn't there.
  function libraryRootCheck() {
    // The folders the library's songs actually live in (the WaveMint Library and any other source).
    const roots = db
      .prepare(
        `SELECT DISTINCT s.root_path FROM sources s JOIN files f ON f.source_id = s.id JOIN tracks t ON t.active_file_id = f.id
         WHERE t.state = 'active'`,
      )
      .all()
      .map((row) => row.root_path);
    const root = consolidator.managedSource()?.root_path || roots[0] || null;
    if (!roots.length) return { ok: false, root, roots, code: "no-library", reason: "The library has no songs to sync yet." };
    const temp = path.resolve(os.tmpdir()).toLowerCase();
    const inTemp = roots.find((item) => {
      const resolved = path.resolve(item).toLowerCase();
      return resolved === temp || resolved.startsWith(`${temp}${path.sep}`);
    });
    if (inTemp && process.env.WAVEMINT_ALLOW_TEMP_LIBRARY !== "1") {
      return { ok: false, root, roots, code: "test-library", reason: `Songs of this library are in the temporary folder (${inTemp}): it looks like a test library, so it isn't synced into iTunes.` };
    }
    const missing = roots.find((item) => !fs.existsSync(item));
    if (missing) return { ok: false, root, roots, code: "library-unavailable", reason: `A library folder isn't available: ${missing}` };
    return { ok: true, root, roots };
  }
  function assertRealLibrary() {
    const check = libraryRootCheck();
    if (!check.ok) {
      const error = new Error(check.reason);
      error.code = check.code;
      throw error;
    }
  }

  const appleSync = createAppleSync({
    assertWritable: assertRealLibrary,
    db,
    exporter,
    getAdapter: () => adapter,
    getSettings,
    getLibraryRoot: () => consolidator.managedSource()?.root_path || getSettings().managedRoot || null,
    defaultCacheRoot: path.join(paths.dataDir, "apple-compat"),
    isQuiet: () => pendingWrites.size === 0 && !DEFERRING_JOBS.has(jobs.runningKind?.()),
    logger,
    emit,
  });
  const appleMigration = createAppleMigration({ db, sync: appleSync, getAdapter: () => adapter, paths, logger });
  const APPLE_JOB_KINDS = new Set(["scan", "write-tags", "consolidate", "upgrade", "import", "audio-edit", "identify"]);
  appleSync.start();

  // Apple work is never exclusive (it must not block the user's other tasks), but
  // only one piece of it runs at a time.
  let appleJobs = 0;
  function appleJob(kind, label, work) {
    if (appleJobs > 0 || appleSync.isRunning()) {
      const error = new Error("Wait for the current Apple sync task to finish first.");
      error.code = "busy";
      throw error;
    }
    appleJobs += 1;
    try {
      return jobs.start(
        kind,
        label,
        async (context) => {
          try {
            return await work(context);
          } finally {
            appleJobs -= 1;
          }
        },
        { exclusive: false },
      );
    } catch (error) {
      appleJobs -= 1;
      throw error;
    }
  }

  // Writes that waited for a task are made when it finishes.
  jobs.onSettled?.((job) => {
    if (job?.status === "completed" && APPLE_JOB_KINDS.has(job.kind)) appleSync.touch();
    if (!pendingWrites.size || jobs.isBusy()) return;
    const ids = [...pendingWrites];
    pendingWrites.clear();
    writeThrough(ids)
      .then((result) => (result.written || result.failed.length) && emit("library-changed", { written: ids }))
      .catch((error) => logger.warn(`[library] Saving waiting changes failed: ${error.message}`));
  });

  /**
   * Runs `fn` (a method that edits metadata) and writes what it changed into
   * the files. The result gains `files` (see writeThrough).
   */
  async function editAndSave(fn) {
    const before = lastOperationId();
    const result = await fn();
    const ids = tracksEditedSince(before);
    if (!ids.length) return result;
    const operationId = result?.operationId || null;
    const files = await writeThrough(ids, { partOf: operationId });
    scheduleReview();
    return result && typeof result === "object" && !Array.isArray(result) ? { ...result, files } : result;
  }

  /**
   * Saves one song's edited fields and/or artwork in a single step: the
   * database edit, then the file. If the file can't be written the edit is
   * taken back and the error is reported, so nothing is half-saved. Songs
   * WaveMint may not write keep the edit in WaveMint (`files.blocked`).
   */
  async function saveTrack({ trackId, fields = {}, artworkHash }) {
    const id = Number(trackId);
    const track = db.prepare("SELECT id, title, artwork_hash, curated_fields, tags_dirty, active_file_id FROM tracks WHERE id = ? AND state = 'active'").get(id);
    if (!track) throw new Error("This song is no longer in your library.");
    const values = { ...fields };
    if (artworkHash !== undefined) {
      if (artworkHash && !artStore.locate(artworkHash)) throw new Error("That image isn't available anymore. Choose it again.");
      values.artworkHash = artworkHash;
      // Artwork that only lives in the file is stored first, so undoing the
      // change can put it back.
      if (!track.artwork_hash) pinFileArtwork(id);
    }
    const previous = new Map([[id, { curated_fields: track.curated_fields, tags_dirty: track.tags_dirty }]]);
    const result = edits.applyEdits(db, [{ trackId: id, fields: values }], { label: `Edit "${track.title || "song"}"` });
    if (!result.operationId) return { ...result, files: { written: 0, failed: [], blocked: 0, deferred: 0, job: null } };

    let files;
    try {
      files = await writeThrough([id], { partOf: result.operationId, background: false });
    } catch (error) {
      files = { written: 0, failed: [{ trackId: id, error: error.message }] };
    }
    if (files.failed.length) {
      edits.discardOperation(db, result.operationId, previous);
      throw new Error(`Your changes weren't saved: ${files.failed[0].error}`);
    }
    if (fields.genre !== undefined) registerGenres([fields.genre], result.operationId);
    scheduleReview();
    return { ...result, files };
  }

  /** Undoes one operation from History, the way its kind is undone. */
  async function undoOperation(id) {
    requireIdle();
    const operation = db.prepare("SELECT kind, undoable, summary FROM operations WHERE id = ?").get(Number(id));
    if (!operation) throw new Error("This change no longer exists.");
    if (!operation.undoable) {
      const expired = JSON.parse(operation.summary || "{}").expired;
      throw new Error(expired ? `This change can no longer be undone: ${expired.reason}` : "This change can't be undone.");
    }
    if (operation.kind === "tag-write") return fileOps.undoTagWrite(id);
    if (operation.kind === "merge") {
      const result = merge.undoMerge(id);
      refreshReview();
      return result;
    }
    if (operation.kind === "consolidate") return consolidator.undoConsolidation(id);
    if (operation.kind === "upgrade") return upgrader.undoUpgrade(id);
    if (operation.kind === "import") {
      const result = importer.undoImport(id);
      refreshReview();
      return result;
    }
    if (operation.kind === "remove") {
      const result = edits.undoMetadataOperation(db, id);
      emit("library-changed", { restored: true });
      scheduleReview();
      return result;
    }
    // Quality decisions recorded by earlier versions of WaveMint.
    if (operation.kind === "quality") return edits.undoMetadataOperation(db, id);
    // Undoing an edit puts the old values back into the files as well.
    return editAndSave(() => edits.undoMetadataOperation(db, id));
  }

  /**
   * Adds the genres a successful save gave songs to the genre list (see
   * genres.registerLabels). Never fails the save it follows.
   */
  function registerGenres(labels, operationId = null) {
    try {
      genres.registerLabels(db, labels, { operationId });
    } catch (error) {
      logger.warn(`[library] Couldn't add the genre to your genres: ${error.message}`);
    }
  }

  /** The genres `list` (applyEdits' edits) sets, minus the changes left out in the preview. */
  function editedGenres(list, exclude = []) {
    const skipped = new Set(exclude.filter((item) => item.field === "genre").map((item) => Number(item.trackId)));
    return list.filter((edit) => edit.fields?.genre !== undefined && !skipped.has(Number(edit.trackId))).map((edit) => edit.fields.genre);
  }

  /** Stores a song's embedded cover in the artwork store and makes it the song's chosen artwork. */
  function pinFileArtwork(trackId) {
    const row = db.prepare("SELECT t.artwork_hash, f.path, f.artwork_hash AS file_art FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id WHERE t.id = ?").get(trackId);
    if (!row || row.artwork_hash || !row.file_art || !row.path) return;
    try {
      const art = readArtwork(row.path);
      if (!art) return;
      const { hash } = artStore.save(art.data);
      db.prepare("UPDATE tracks SET artwork_hash = ? WHERE id = ? AND artwork_hash IS NULL").run(hash, trackId);
    } catch (error) {
      logger.warn(`[library] Couldn't keep the file's artwork: ${error.message}`);
    }
  }

  // Songs added or removed one at a time refresh the review queue once
  // things settle, not after every song of a playlist.
  let reviewTimer = null;
  function songsAdded(trackIds) {
    emit("library-changed", { added: trackIds });
    scheduleReview();
  }
  function songsRemoved(trackIds) {
    if (!trackIds.length) return;
    emit("library-changed", { removed: trackIds });
    scheduleReview();
  }
  function scheduleReview() {
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => {
      try {
        refreshReview();
        emit("library-changed", { review: true });
      } catch (error) {
        logger.warn(`[library] Review refresh failed: ${error.message}`);
      }
    }, 3000);
    reviewTimer.unref?.();
  }

  const methods = {
    // --- overview and browsing -------------------------------------------
    getOverview: () => ({ ...queries.getDashboard(db), review: review.reviewSummary(db).groups }),
    getStatus: () => ({ ...queries.getStatus(db), reviewOpen: review.openCount(db) }),
    listTracks: (params) => queries.listTracks(db, params),
    listTrackIds: (params) => queries.listTrackIds(db, params),
    listAlbums: (params) => queries.listAlbums(db, params),
    listArtists: (params) => queries.listArtists(db, params),
    getArtist: ({ key }) => queries.getArtist(db, key),
    browseFacets: () => queries.browseFacets(db),
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
        // Fresh findings for the review queue.
        const reviewResult = refreshReview();
        return { results, review: reviewResult };
      });
    },

    // --- metadata editing --------------------------------------------------------
    previewEdits: ({ edits: list }) => edits.previewEdits(db, list),
    // Every edit is saved into the files too (see writeThrough).
    saveTrack: (params) => saveTrack(params),
    applyEdits: async ({ edits: list, exclude = [], label }) => {
      const result = await editAndSave(() => edits.applyEdits(db, list, { exclude, label: label || "Edit metadata" }));
      if (result.operationId) registerGenres(editedGenres(list, exclude), result.operationId);
      return result;
    },
    suggestTitleCase: ({ trackIds }) =>
      db
        .prepare(`SELECT id, title FROM tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`)
        .all(...trackIds)
        .map((row) => ({ trackId: row.id, fields: { title: edits.titleCase(row.title) } })),
    editAlbum: async ({ releaseId, fields, label }) => {
      const ids = activeTrackIds(releaseId);
      if (!ids.length) throw new Error("This album has no songs.");
      const result = await editAndSave(() => edits.applyEdits(db, ids.map((trackId) => ({ trackId, fields })), { label: label || "Edit album" }));
      if (result.operationId && fields.genre !== undefined) registerGenres([fields.genre], result.operationId);
      return result;
    },
    setArtworkFromPath: ({ trackIds, filePath }) => {
      const { hash } = artStore.saveFromFile(filePath);
      for (const id of trackIds) pinFileArtwork(Number(id));
      return editAndSave(() => ({ hash, ...edits.setTrackArtwork(db, trackIds, hash, { label: "Change artwork" }) }));
    },
    copyArtwork: ({ trackIds, fromTrackId }) => {
      const hash = artworkFromTrack(fromTrackId);
      for (const id of trackIds) pinFileArtwork(Number(id));
      return editAndSave(() => ({ hash, ...edits.setTrackArtwork(db, trackIds, hash, { label: "Use artwork from another song" }) }));
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
      const result = await undoOperation(id);
      // Genres the change added to the genre list go too, unless something uses them now.
      try {
        genres.releaseCreated(db, id);
      } catch (error) {
        logger.warn(`[library] Couldn't take back the change's genres: ${error.message}`);
      }
      return result;
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
      return editAndSave(() => {
        const result = merge.apply(params);
        refreshReview();
        return result;
      });
    },
    // Duplicates inside the library: database only, undoable from History.
    mergeDuplicates: (params) => {
      requireIdle();
      return editAndSave(() => {
        const result = merge.mergeDuplicates(params);
        refreshReview();
        emit("library-changed", { merged: params.trackIds });
        return result;
      });
    },
    keepDuplicatesSeparate: (params) => {
      const result = merge.keepSeparate(params);
      refreshReview();
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
        return consolidator.consolidateJob({ root, pattern, trackIds: trackIds?.length ? trackIds : null, signal, progress });
      });
    },

    // --- Upgrade Track ----------------------------------------------------------
    // filePath only from the host (a main-process dialog); the renderer can pick versions.
    prepareUpgrade: ({ trackId, fileId, filePath }) => {
      requireIdle();
      return upgrader.prepare({ trackId, fileId, filePath });
    },
    compareUpgrade: (params) => upgrader.compare(params),
    // Spectrograms of a library file or a replacement, as data URLs.
    spectrogram: async ({ fileId, candidateId }) => {
      let filePath;
      let key;
      if (fileId) {
        const file = db.prepare("SELECT id, path, mtime_ms, status FROM files WHERE id = ?").get(Number(fileId));
        if (!file || file.status !== "ok") throw new Error("This file isn't available.");
        filePath = file.path;
        key = `f${file.id}-${Math.round(file.mtime_ms)}`;
      } else {
        const candidate = upgrader.resolveCandidateFile({ candidateId });
        if (!candidate) throw new Error("This replacement isn't available.");
        filePath = candidate.path;
        key = `c${candidate.id}-${Math.round(fs.statSync(candidate.path).mtimeMs)}`;
      }
      const image = await media.spectrogram(filePath, key);
      return `data:image/png;base64,${fs.readFileSync(image).toString("base64")}`;
    },
    discardUpgrade: (params) => {
      const discarded = upgrader.discard(params);
      // A replacement extracted from a URL only lived in staging.
      if (discarded.kind === "extraction") audioEditor.releaseStagedPath(discarded.path);
      return { discarded: true };
    },
    listUpgradeCandidates: (params) => upgrader.listCandidates(params),
    applyUpgrade: ({ candidateId, metadata, choices, artwork, artworkHash }) => {
      const staged = upgrader.resolveCandidateFile({ candidateId });
      const before = db.prepare("SELECT t.genre FROM upgrade_candidates c JOIN tracks t ON t.id = c.track_id WHERE c.id = ?").get(Number(candidateId));
      return jobs.start("upgrade", "Upgrading song", async ({ signal, progress }) => {
        const result = await upgrader.applyJob({ candidateId, metadata, choices, artwork, artworkHash, signal, progress });
        // The form always sends every field: only a genre the user changed is new.
        if (metadata?.genre !== undefined && metadata.genre !== before?.genre) registerGenres([metadata.genre], result.operationId);
        // WaveMint's copy is in the library now; a staged extraction can go.
        // The upgrade is complete at this point: tidying up must never turn
        // it into a reported failure.
        try {
          if (staged) audioEditor.releaseStagedPath(staged.path);
        } catch (error) {
          logger.warn(`[library] Upgrade cleanup: ${error.message}`);
        }
        return result;
      });
    },
    // Host only: an extraction made for an upgrade (main process, download-mp3
    // with upgradeTrackId) becomes the song's replacement candidate.
    prepareStagedUpgrade: async ({ token, trackId, source }) => {
      requireIdle();
      const staged = audioEditor.resolveExtraction({ token });
      if (!staged) throw new Error("The extracted audio is no longer available. Extract it again.");
      return upgrader.prepare({ trackId, filePath: staged.path, kind: "extraction", source });
    },
    // Host only: an image chosen in a main-process dialog, stored for later use
    // (an upgrade's custom artwork). Nothing is assigned to any song.
    storeArtworkFile: ({ filePath }) => {
      const { hash } = artStore.saveFromFile(filePath);
      return { hash };
    },

    // --- identification (MusicBrainz) ---------------------------------------------
    identifySong: async ({ trackId }) => {
      requireOnline();
      const result = await identifier.identifyTrack(trackId);
      refreshReview();
      return result;
    },
    identifySongs: ({ trackIds, onlyNew }) => {
      requireOnline();
      return jobs.start("identify", "Identifying songs with MusicBrainz", async ({ signal, progress }) => {
        const report = await identifier.identifyJob({ trackIds: trackIds?.length ? trackIds : null, onlyNew: onlyNew !== false, signal, progress });
        refreshReview();
        return report;
      });
    },
    getIdentification: ({ trackId }) => identifier.view(trackId),
    chooseIdentificationRelease: (params) => identifier.chooseRelease(params),
    identificationCover: async ({ trackId }) => {
      requireOnline();
      return identifier.cover({ trackId });
    },
    // A cover for the song (title/artist/album only); assigned when the user saves.
    findArtwork: async ({ trackId }) => {
      requireOnline();
      return identifier.findArtwork({ trackId });
    },
    applyIdentification: ({ trackId, fields, coverHash }) => {
      // Only covers WaveMint itself stored can be used.
      if (coverHash && !artStore.locate(coverHash)) throw new Error("That cover isn't available anymore. Load it again.");
      if (coverHash) pinFileArtwork(Number(trackId));
      return editAndSave(() => {
        const result = identifier.apply({ trackId, fields, coverHash: coverHash || null });
        refreshReview();
        return result;
      });
    },
    dismissIdentifications: (params) => {
      const result = identifier.dismiss(params);
      refreshReview();
      return result;
    },
    applyConfidentIdentifications: ({ minConfidence }) =>
      editAndSave(() => {
        const result = identifier.applyConfident({ minConfidence: minConfidence || 0.9 });
        refreshReview();
        return result;
      }),
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
      return editAndSave(async () => {
        const result = await identifier.applyAlbum({ ...params, exclude: params.exclude || [] });
        refreshReview();
        return result;
      });
    },

    // --- playlist import ------------------------------------------------------------
    startImport: (params) => importer.startSession(params),
    updateImport: (params) => importer.updateSession(params),
    getImport: ({ sessionId }) => importer.view(sessionId),
    listImports: () => importer.listSessions(),
    commitImport: ({ sessionId, decisions }) =>
      jobs.start("import", "Importing into the WaveMint Library", async ({ signal, progress }) => {
        const report = await importer.commitJob({ sessionId, decisions, signal, progress });
        registerGenres(
          db
            .prepare("SELECT t.genre FROM import_items i JOIN tracks t ON t.id = i.result_track_id WHERE i.session_id = ? AND i.outcome = 'added'")
            .all(Number(sessionId))
            .map((row) => row.genre),
          report.operationId,
        );
        refreshReview();
        return report;
      }),
    discardImport: (params) => importer.discard(params),
    // Host only: the main process saves extractions into staging.
    prepareImportStaging: (params) => importer.prepareStaging(params),
    addStagedImport: (params) => importer.addStaged(params),

    // --- adding extractions and editing audio --------------------------------------
    checkLibraryMatches: (params) => audioEditor.checkMatches(params),
    getStagedExtraction: (params) => audioEditor.extractionInfo(params),
    commitStagedExtraction: async (params) => {
      const added = await audioEditor.commitExtraction(params);
      registerGenres([db.prepare("SELECT genre FROM tracks WHERE id = ?").get(added.trackId)?.genre]);
      songsAdded([added.trackId]);
      return added;
    },
    discardStagedExtraction: (params) => audioEditor.discardExtraction(params),
    getAudioEditSource: (params) => audioEditor.editSource(params),
    audioWaveform: (params) => audioEditor.waveform(params),
    applyAudioEdit: ({ trackId, edits }) => {
      // Fail fast (before the job starts) on edits that can't be saved.
      audioEditor.editSource({ trackId });
      return jobs.start("audio-edit", "Saving audio edits", async ({ signal, progress }) => {
        return audioEditor.editTrackJob({ trackId, edits, signal, progress });
      });
    },
    // Host only: the main process saves extractions into staging.
    prepareExtractionStaging: () => audioEditor.prepareExtraction(),
    resolveStagedExtraction: (params) => audioEditor.resolveExtraction(params),

    // --- favorites and removal ------------------------------------------------------
    setFavorite: ({ trackIds, favorite }) => {
      const ids = [...new Set(trackIds)];
      const result = db
        .prepare(`UPDATE tracks SET favorite = ? WHERE state = 'active' AND id IN (${ids.map(() => "?").join(",")})`)
        .run(favorite ? 1 : 0, ...ids);
      return { updated: Number(result.changes) };
    },
    removeFromLibrary: ({ trackIds }) => {
      const result = removal.removeFromLibrary({ trackIds });
      songsRemoved(result.trackIds);
      return result;
    },
    previewFileDeletion: ({ trackIds }) => removal.deletionPlan({ trackIds }),
    // Host only: the main process moves the files to the Recycle Bin in between.
    planFileDeletion: ({ trackIds }) => removal.deletionPlan({ trackIds, withPaths: true }),
    finishFileDeletion: (params) => {
      const result = removal.finishDeletion(params);
      songsRemoved(result.trackIds);
      return result;
    },

    // --- storage -------------------------------------------------------------------
    storageReport: () => storage.report(),
    // Host only: the main process removes what the plan lists, then reports back.
    planStorageCleanup: ({ categories, auto }) => {
      if (jobs.isBusy()) {
        const error = new Error("Wait for the current library task to finish before cleaning up.");
        error.code = "busy";
        throw error;
      }
      return storage.plan({ categories, auto });
    },
    finishStorageCleanup: (params) => storage.finish(params),
    storageSchedule: () => ({ ...storage.schedule(), busy: jobs.isBusy() }),

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

    // --- Apple library synchronization -------------------------------------------------
    // What this app is working with: its profile, its library, and the iTunes bridge (never a stand-in in the app).
    getAppleSync: () => ({ ...appleSync.status(), profileDir: path.dirname(paths.dataDir), libraryCheck: libraryRootCheck(), bridge: adapter.kind }),
    detectApple: () => adapter.detect(),
    // Reading iTunes can take a while: these run as background jobs.
    previewAppleSync: () => appleJob("apple-preview", "Checking iTunes", ({ signal }) => appleSync.preview({ launch: true, signal })),
    runAppleSync: ({ confirm = {}, trackIds }) =>
      appleJob("apple-sync", "Syncing with iTunes", ({ signal, progress }) => appleSync.run({ mode: "manual", confirm, only: trackIds?.length ? trackIds : null, signal, progress })),
    // A first test with a few songs (some MP3, some AAC, with artwork where possible).
    appleTestSync: ({ count }) => {
      assertRealLibrary();
      // Songs whose files really are on disk, some MP3 and some AAC, with artwork where possible.
      const pick = (codec, limit) =>
        db
          .prepare(
            `SELECT t.id, f.path FROM tracks t JOIN files f ON f.id = t.active_file_id
             WHERE t.state = 'active' AND f.status = 'ok' AND f.codec = ? AND t.tags_dirty = 0
             ORDER BY (COALESCE(t.artwork_hash, f.artwork_hash) IS NULL), t.id LIMIT ?`,
          )
          .all(codec, limit * 10)
          .filter((row) => fs.existsSync(row.path))
          .slice(0, limit)
          .map((row) => row.id);
      const wanted = Math.min(Math.max(Number(count) || 5, 1), 25);
      const aac = pick("aac", Math.floor(wanted / 2));
      const ids = [...aac, ...pick("mp3", wanted - aac.length)];
      if (!ids.length) throw new Error("No song in the library has its file on disk to test with. Check Review → Diagnostics.");
      return appleJob("apple-sync", `Testing iTunes sync with ${ids.length} songs`, ({ signal, progress }) =>
        appleSync.run({ mode: "manual", confirm: { baseline: true }, only: ids, signal, progress }).then((report) => ({ ...report, testTrackIds: ids })),
      );
    },
    retryAppleFailures: ({ trackIds }) => appleSync.resetFailures(trackIds?.length ? trackIds : null),
    acceptAppleDetails: ({ trackIds }) => appleSync.acceptItunesDetails(trackIds),
    confirmAppleSetup: ({ confirmed }) => {
      appleSync.patchMeta({ setupConfirmed: !!confirmed });
      return { confirmed: !!confirmed };
    },
    backupItunes: () => appleJob("apple-backup", "Backing up the iTunes library", ({ signal }) => appleMigration.backup({ signal })),
    analyzeAppleMigration: () => appleJob("apple-migration", "Comparing iTunes with your library", ({ signal, progress }) => appleMigration.analyze({ signal, progress })),
    applyAppleMigration: ({ resolutions, dryRun, backupAck }) => {
      if (dryRun === false) assertRealLibrary();
      return appleJob("apple-migration", dryRun === false ? "Migrating to WaveMint-managed iTunes" : "Previewing the migration", ({ signal, progress }) =>
        appleMigration.apply({ resolutions: resolutions || {}, dryRun: dryRun !== false, backupAck: !!backupAck, signal, progress }),
      );
    },
    verifyAppleLibrary: () => appleJob("apple-verify", "Verifying the iTunes library", ({ signal }) => appleMigration.verify({ signal })),
    cleanUpAppleLibrary: ({ pids, includeSuperseded, expected, backupAck }) =>
      appleJob("apple-cleanup", "Removing old iTunes entries", ({ signal, progress }) =>
        appleMigration.cleanup({ pids: pids || [], includeSuperseded: includeSuperseded !== false, expected, backupAck: !!backupAck, signal, progress }),
      ),

    // --- formats and missing files -----------------------------------------------------
    getFormatStats: () => formats.formatStats(db, { convertWavAiff: getSettings().convertWavAiff !== false }),
    listMissingFiles: () => formats.listMissingFiles(db),
    // Stores the genre of these songs' files as text (Write Tags with the genre always rewritten).
    storeGenresAsText: ({ trackIds }) =>
      jobs.start("write-tags", "Storing genres as text", ({ signal, progress }) => fileOps.writeTagsJob({ trackIds, signal, progress, forceFields: ["genre"] })),
    // Read-only: MP3s whose genre is stored as a number.
    scanNumericGenres: () => jobs.start("genre-scan", "Checking how genres are stored", ({ signal, progress }) => formats.numericGenreScan(db, { signal, progress }), { exclusive: false }),
    forgetMissingFile: ({ fileId }) => {
      const result = formats.forgetMissingFile(db, { fileId });
      refreshReview();
      return result;
    },
    // Leftover references (removed or merged songs, earlier versions) only; database only.
    forgetLeftoverReferences: ({ fileIds }) => {
      const result = formats.forgetLeftoverReferences(db, { fileIds });
      refreshReview();
      return result;
    },
    // Host only: the file comes from a main-process dialog.
    relinkMissingFile: ({ fileId, filePath }) => {
      requireIdle();
      return formats.relinkMissingFile(db, { fileId, filePath });
    },

    // --- genres ------------------------------------------------------------------
    listGenreTaxonomy: () => genres.listTaxonomy(db),
    genreReport: () => genres.genreReport(db),
    createGenre: (params) => genres.createGenre(db, params),
    renameGenre: (params) => editAndSave(() => genres.renameGenre(db, params)),
    mergeGenres: (params) => editAndSave(() => genres.mergeGenres(db, params)),
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
    applyGenreRules: (params) => editAndSave(() => genres.applyRules(db, params)),

    // --- review queue ----------------------------------------------------------
    refreshReview: () => refreshReview(),
    reviewSummary: () => review.reviewSummary(db),
    listReviewItems: (params) => review.listReviewItems(db, params),
    setReviewStatus: (params) => review.setReviewStatus(db, params),
    approveSuggestions: (params) => editAndSave(() => review.approveSuggestions(db, params)),

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
      if (next.reviewMissingAlbum !== before.reviewMissingAlbum) refreshReview();
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

  // Every change to the collection tells the Apple sync that there may be work.
  const APPLE_TOUCH_METHODS = [
    "saveTrack", "applyEdits", "editAlbum", "setArtworkFromPath", "copyArtwork", "clearArtwork", "undoOperation", "applyMerge", "mergeDuplicates", "keepDuplicatesSeparate",
    "applyIdentification", "applyConfidentIdentifications", "applyAlbumIdentification", "commitStagedExtraction", "removeFromLibrary",
    "finishFileDeletion", "createPlaylist", "updatePlaylist", "deletePlaylist", "addToPlaylist", "removeFromPlaylist", "movePlaylistTrack",
    "importPlaylistM3U", "renameGenre", "mergeGenres", "applyGenreRules", "approveSuggestions",
    "forgetMissingFile", "forgetLeftoverReferences", "relinkMissingFile",
  ];
  for (const name of APPLE_TOUCH_METHODS) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    methods[name] = async (...args) => {
      const result = await original(...args);
      appleSync.touch();
      return result;
    };
  }

  return { methods, getSettings, appleSync, appleMigration };
}

module.exports = { SETTINGS_DEFAULTS, createLibraryService };
