// IPC for Add Music and Upgrade Track: analyzing a URL, artwork previews,
// extracting a song, and cancelling.
//
// Each request may carry a `requestId` chosen by the renderer. Progress
// events echo it, and "cancel-operations" with a requestId stops only that
// request, so Add Music and an upgrade running at the same time never see
// (or cancel) each other's work.
//
// Paths and URLs the renderer hands back are checked against what the main
// process gave it: custom artwork files only enter through the main-process
// dialog, thumbnails only through an analysis.

const path = require("path");
const { getAuthFingerprint } = require("../auth.cjs");
const { normalizeArtworkMode } = require("../artwork.cjs");
const { CATEGORIES, ExtractionError } = require("../errors.cjs");
const { validateMediaUrl } = require("../extraction.cjs");
const { normalizeRequestId } = require("../operationRegistry.cjs");
const { buildAnalysisResult, isUsableThumbnailUrl } = require("../youtubeMetadata.cjs");

// Analysis results (titles, artwork URLs, editable metadata; never media
// URLs or cookies) are reused for a while, so analyzing the same link again
// doesn't send YouTube the same requests twice.
const ANALYSIS_CACHE_TTL_MS = 15 * 60 * 1000;
const ANALYSIS_CACHE_MAX_ENTRIES = 20;
const KNOWN_THUMBNAILS_MAX = 5000;

function boundedAdd(set, value, max) {
  set.delete(value);
  set.add(value);
  while (set.size > max) set.delete(set.values().next().value);
}

function registerExtractionHandlers({ ipc, dialog, BrowserWindow, extraction, artwork, songExtractor, libraryHost, getAuthSettings, assertBundledToolsPresent, operations, logger = console }) {
  const analysisCache = new Map();
  const approvedArtworkFiles = new Set();
  const knownThumbnails = new Set();

  const send = (sender, channel, data) => {
    if (sender && !sender.isDestroyed()) sender.send(channel, data);
  };

  function readCache(key) {
    const entry = analysisCache.get(key);
    if (!entry || Date.now() - entry.storedAt > ANALYSIS_CACHE_TTL_MS) {
      analysisCache.delete(key);
      return null;
    }
    return entry.value;
  }

  function writeCache(key, value) {
    analysisCache.delete(key);
    analysisCache.set(key, { value, storedAt: Date.now() });
    while (analysisCache.size > ANALYSIS_CACHE_MAX_ENTRIES) analysisCache.delete(analysisCache.keys().next().value);
  }

  // Thumbnails the renderer may ask WaveMint to download.
  function rememberThumbnails(analysis) {
    for (const url of [analysis.thumbnail, ...analysis.entries.map((entry) => entry.thumbnail)]) {
      if (isUsableThumbnailUrl(url)) boundedAdd(knownThumbnails, url, KNOWN_THUMBNAILS_MAX);
    }
    return analysis;
  }

  const isKnownThumbnail = (url) => knownThumbnails.has(String(url || "").trim());

  ipc.handle("analyze-url", async (event, payload) => {
    const url = validateMediaUrl(payload?.url);
    const mode = payload?.mode === "video" ? "video" : "playlist";
    const requestId = normalizeRequestId(payload?.requestId);
    const cacheKey = [mode, url, getAuthFingerprint(getAuthSettings())].join("|");
    const cached = readCache(cacheKey);
    if (cached) {
      logger.log("[analyze] Using this session's earlier analysis");
      return rememberThumbnails(cached);
    }

    extraction.assertAvailable();
    assertBundledToolsPresent();

    const operation = operations.begin(event.sender.id, requestId);
    let parsed;
    try {
      parsed = await extraction.analyze({
        url,
        mode,
        signal: operation.signal,
        onStatus: (status) => send(event.sender, "analyze-progress", { ...status, requestId }),
      });
    } finally {
      operation.end();
    }

    let analysis;
    try {
      analysis = buildAnalysisResult(parsed);
    } catch (error) {
      logger.error(`[analyze] Could not interpret yt-dlp's response: ${error?.message}`);
      throw new ExtractionError({ category: CATEGORIES.EXTRACTOR_OUTDATED, message: "WaveMint couldn't read YouTube's response. Its YouTube extraction components may need an update." });
    }
    send(event.sender, "analyze-progress", { phase: "complete", requestId });
    writeCache(cacheKey, analysis);
    return rememberThumbnails(analysis);
  });

  ipc.handle("choose-artwork-file", async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      properties: ["openFile"],
      filters: [{ name: "Artwork Images", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    approvedArtworkFiles.add(path.resolve(filePath));
    return { filePath, previewUrl: await artwork.customPreview(filePath) };
  });

  ipc.handle("generate-square-crop-preview", async (_event, payload) => {
    const thumbnail = String(payload?.thumbnail || "").trim();
    if (!isUsableThumbnailUrl(thumbnail) || !isKnownThumbnail(thumbnail)) {
      throw new Error("No valid thumbnail was provided for the square preview");
    }
    return { previewUrl: await artwork.squarePreview(thumbnail) };
  });

  /**
   * Extracts one song. Where the finished MP3 goes is decided by the library
   * (never by the renderer):
   * - album import (importSessionId): the import session's folder; the
   *   library checks it and the user reviews the whole import first;
   * - Upgrade Track (upgradeTrackId): a one-song staging folder; the file
   *   becomes that song's replacement candidate;
   * - Add to Library: a one-song staging folder, added to the library right
   *   away, or (holdForEditing) kept until the user has edited it.
   */
  ipc.handle("download-mp3", async (event, payload) => {
    const { metadata, thumbnail, artwork: artworkChoice, importSessionId, importEntryKey, holdForEditing, upgradeTrackId } = payload || {};
    const url = validateMediaUrl(payload?.url);
    const requestId = normalizeRequestId(payload?.requestId);
    const artworkMode = normalizeArtworkMode(artworkChoice?.mode);
    const customFilePath = artworkChoice?.customFilePath || "";
    if (artworkMode === "custom_file" && !approvedArtworkFiles.has(path.resolve(String(customFilePath)))) {
      throw new Error("Choose the custom artwork image again before extracting");
    }
    // Every check that can fail runs before a staging folder is made.
    extraction.assertAvailable();
    assertBundledToolsPresent();

    const albumImport = importSessionId !== undefined && importSessionId !== null;
    const upgradeTrack = !albumImport && Number.isInteger(Number(upgradeTrackId)) && Number(upgradeTrackId) > 0 ? Number(upgradeTrackId) : null;
    const staging = albumImport
      ? await libraryHost.call("prepareImportStaging", { sessionId: Number(importSessionId), entryKey: String(importEntryKey || "") })
      : await libraryHost.call("prepareExtractionStaging", {});
    const stagedToken = albumImport ? null : staging.token;
    let keepStaged = false; // removed unless added, held for editing, or a replacement

    const operation = operations.begin(event.sender.id, requestId);
    const progress = (status) => send(event.sender, "download-progress", { ...status, requestId });

    try {
      const song = await songExtractor.extract({
        url,
        metadata: metadata || {},
        thumbnail: isKnownThumbnail(thumbnail) ? thumbnail : "",
        artworkMode,
        customFilePath,
        outputFolder: staging.folder,
        signal: operation.signal,
        onProgress: progress,
      });
      const done = (extra) => {
        progress({ phase: "complete", title: song.metadata.title });
        return { success: true, metadata: song.metadata, artworkMode, ...extra };
      };

      if (albumImport) {
        progress({ phase: "checking", title: song.metadata.title });
        const staged = await libraryHost.call("addStagedImport", { sessionId: Number(importSessionId), entryKey: String(importEntryKey || ""), filePath: song.filePath });
        return done({ staged });
      }

      if (upgradeTrack) {
        progress({ phase: "checking", title: song.metadata.title });
        let upgrade;
        try {
          upgrade = await libraryHost.call("prepareStagedUpgrade", {
            token: stagedToken,
            trackId: upgradeTrack,
            source: { title: song.info?.title || "", uploader: song.info?.uploader || song.info?.channel || "", url: song.info?.webpage_url || url },
          });
        } catch (error) {
          throw songExtractor.postProcessingError(`WaveMint extracted the audio but couldn't prepare it as the replacement: ${error.message}`, error, url);
        }
        keepStaged = true; // removed when the replacement is used or discarded
        return done({ upgrade });
      }

      if (holdForEditing) {
        keepStaged = true;
        return done({ held: true, token: stagedToken });
      }

      progress({ phase: "saving", title: song.metadata.title });
      let added;
      try {
        added = await libraryHost.call("commitStagedExtraction", { token: stagedToken });
      } catch (error) {
        throw songExtractor.postProcessingError(`WaveMint extracted the song but couldn't add it to your library: ${error.message}`, error, url);
      }
      keepStaged = true; // already removed by the library
      return done({ added });
    } finally {
      operation.end();
      if (stagedToken && !keepStaged) libraryHost.call("discardStagedExtraction", { token: stagedToken }).catch(() => {});
    }
  });

  // Stops the window's running analyses/extractions (only `requestId`'s, if
  // given). The interrupted operations reject with a "cancelled" error.
  ipc.handle("cancel-operations", async (event, payload) => ({ cancelled: operations.cancel(event.sender.id, payload?.requestId) }));

  return { clearAnalysisCache: () => analysisCache.clear() };
}

module.exports = { registerExtractionHandlers };
