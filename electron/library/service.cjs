// The library service: every operation the UI can request, implemented on
// top of the database and the domain modules. Runs inside the library
// worker. Methods receive already-validated parameters (see host.cjs).

const { getSetting, setSetting } = require("./db.cjs");
const queries = require("./queries.cjs");
const sources = require("./sources.cjs");
const { createScanner } = require("./scanner.cjs");

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

  function getSettings() {
    return { ...SETTINGS_DEFAULTS, ...getSetting(db, "library", {}) };
  }

  const methods = {
    // --- overview and browsing -------------------------------------------
    getOverview: () => queries.getDashboard(db),
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
        return { results };
      });
    },

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
      const file = db
        .prepare("SELECT path FROM files WHERE artwork_hash = ? AND status = 'ok' ORDER BY id LIMIT 1")
        .get(String(hash));
      if (!file) return null;
      return { path: await media.thumbnail(String(hash), Number(size), file.path) };
    },
    getPaths: () => paths,
  };

  return { methods, getSettings };
}

module.exports = { SETTINGS_DEFAULTS, createLibraryService };
