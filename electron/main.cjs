const { app, BrowserWindow, clipboard, ipcMain, dialog, protocol, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const {
  createBinaryResolver,
  selfTestYtDlp,
  verifyDependencies,
} = require("./binaries.cjs");
const { killAllChildren, runCommand } = require("./processes.cjs");
const { createSettingsStore } = require("./settings.cjs");
const {
  AUTH_PROBE_URL,
  AuthError,
  buildYtDlpAuthArgs,
  detectBrowsers,
  getAuthFingerprint,
  getBrowser,
  inspectCookiesFile,
  interpretAuthProbe,
  isSupportedBrowser,
  redactSensitiveText,
  sanitizeProfileValue,
  validateCustomProfileFolder,
} = require("./auth.cjs");
const {
  CATEGORIES,
  ExtractionError,
  isYouTubeRateLimitMessage,
} = require("./errors.cjs");
const { createDiagnosticsStore, formatDiagnostics } = require("./diagnostics.cjs");
const { createExtractionManager } = require("./extraction.cjs");
const { CHANNELS, createEngineStore, createEngineUpdater } = require("./engine.cjs");
const { isAutoImportFolder, moveIntoOutputFolder } = require("./outputFiles.cjs");
const { createLibraryHost, registerLibrarySchemes } = require("./library/host.cjs");

const APP_USER_MODEL_ID = "com.wavemint.app";
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

// Development runs keep their own settings so experimenting never touches an
// installed copy's configuration. Must run before the app is ready.
if (!app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "WaveMint-Dev"));
}

// Custom protocols for library audio previews and artwork (must be
// registered before the app is ready).
registerLibrarySchemes(protocol);

const binaries = createBinaryResolver({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appRoot: path.join(__dirname, ".."),
  cacheDir: path.join(app.getPath("userData"), "yt-dlp-cache"),
});

let settingsStore = null;

function getSettingsStore() {
  if (!settingsStore) {
    settingsStore = createSettingsStore(
      path.join(app.getPath("userData"), "settings.json"),
    );
  }

  return settingsStore;
}

function getAuthSettings() {
  return getSettingsStore().get().auth;
}

// Errors that the renderer should treat specially carry a short "[code]"
// prefix, which the UI strips before display (see src/ipcErrors.js).
function createUserError(code, message) {
  return new Error(`[${code}] ${message}`);
}

const diagnostics = createDiagnosticsStore();

// ---------------------------------------------------------------------------
// Extraction engine (yt-dlp): bundled copy plus optional verified updates
// ---------------------------------------------------------------------------

const engineStore = createEngineStore({
  dir: path.join(app.getPath("userData"), "engine"),
});

function getBundledYtDlpVersion() {
  return (
    binaries.readBundledVersions()?.binaries?.find((item) => item.id === "yt-dlp")?.version || ""
  );
}

function getCurrentEngineVersion() {
  return engineStore.getActive()?.version || getBundledYtDlpVersion();
}

function describeEngine() {
  const active = engineStore.getActive();
  return active
    ? `yt-dlp ${active.version} (updated, ${active.channel})`
    : `yt-dlp ${getBundledYtDlpVersion() || "unknown"} (built-in)`;
}

function applyEngineOverride() {
  const active = engineStore.getActive();
  binaries.setYtDlpOverride(active ? { command: active.command, version: active.version } : null);
}

const extraction = createExtractionManager({
  binaries,
  runCommand,
  getAuthSettings,
  buildAuthArgs: (auth) => buildYtDlpAuthArgs(auth),
  diagnostics,
  getEngineDescription: describeEngine,
});

const engineUpdater = createEngineUpdater({
  store: engineStore,
  getCurrentVersion: getCurrentEngineVersion,
  selfTest: (command) => selfTestYtDlp(binaries, command, { timeoutMs: 60000 }),
  isBusy: () => extraction.isBusy(),
});

let dependencyStatusPromise = null;

function getDependencyStatus({ refresh = false } = {}) {
  if (!dependencyStatusPromise || refresh) {
    dependencyStatusPromise = verifyDependencies(binaries).then(async (status) => {
      const ytDlp = status.tools.find((tool) => tool.tool === "yt-dlp");

      // An updated engine that fails its startup check is retired and the
      // built-in copy takes over, so a bad update can never break WaveMint.
      if (ytDlp && !ytDlp.ok && ytDlp.source === "updated") {
        const active = engineStore.getActive();
        console.error(
          `[engine] Updated yt-dlp ${active?.version} failed its check; reverting to the built-in version`,
        );
        if (active) engineStore.markBroken(active.version);
        applyEngineOverride();
        status = await verifyDependencies(binaries);
      }

      for (const tool of status.tools) {
        if (tool.ok) {
          const extra = tool.ejsVersion
            ? ` (EJS ${tool.ejsVersion}, JS runtime ${tool.jsRuntimes.join(", ") || "none"})`
            : "";
          console.log(`[dependencies] ${tool.label}: ${tool.version}${extra}`);
        } else {
          console.error(`[dependencies] ${tool.label}: ${tool.message}`);
        }
      }

      return status;
    });
  }

  return dependencyStatusPromise;
}

// Cheap per-operation guard (a file-exists check, no process launch) so a
// missing bundled tool produces a clear message instead of a spawn error.
function assertBundledToolsPresent() {
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
    const resolved = binaries.resolve(tool);

    if (resolved.bundled && !fileExists(resolved.command)) {
      // A removed updated engine falls back to the built-in copy.
      if (resolved.source === "updated") {
        engineStore.useBundled();
        applyEngineOverride();
        continue;
      }

      throw new ExtractionError({
        category: CATEGORIES.MISSING_DEPENDENCY,
        message: `WaveMint's ${resolved.label} component is missing. Reinstall WaveMint to restore it.`,
      });
    }
  }
}

function sendToRenderer(sender, channel, data) {
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, data);
  }
}

// ---------------------------------------------------------------------------
// Cancellable operations, tracked per window
// ---------------------------------------------------------------------------

const activeOperations = new Map();

function beginOperation(sender) {
  const controller = new AbortController();
  const key = sender.id;
  if (!activeOperations.has(key)) activeOperations.set(key, new Set());
  activeOperations.get(key).add(controller);

  return {
    signal: controller.signal,
    end: () => activeOperations.get(key)?.delete(controller),
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: "WaveMint",
    // Packaged builds use the multi-resolution icon embedded in WaveMint.exe.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, "assets", "icon.png") }),
    // Matches --wm-bg-base in src/index.css so there's no white flash on load.
    backgroundColor: "#080D24",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The UI is a single local page: never navigate away or open new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== win.webContents.getURL()) {
      event.preventDefault();
    }
  });

  if (app.isPackaged || process.env.WAVEMINT_RENDERER === "dist") {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    win.loadURL(DEV_SERVER_URL);
  }
}

const ENGINE_AUTO_CHECK_DELAY_MS = 20 * 1000;
const ENGINE_AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// A quiet, at-most-daily check after startup. It never installs anything and
// never blocks or slows startup; failures (offline) are simply recorded.
function scheduleEngineAutoCheck() {
  const timer = setTimeout(async () => {
    const { engine } = getSettingsStore().get();
    if (!engine.autoCheck || engineUpdater.isInstalling()) return;

    const lastCheck = engineStore.getState().lastCheck;
    const lastCheckedAt = Date.parse(lastCheck?.checkedAt || "") || 0;
    if (
      lastCheck?.channel === engine.channel &&
      Date.now() - lastCheckedAt < ENGINE_AUTO_CHECK_INTERVAL_MS
    ) {
      return;
    }

    const result = await engineUpdater.check({ channel: engine.channel });
    for (const win of BrowserWindow.getAllWindows()) {
      sendToRenderer(win.webContents, "engine-status-changed", buildEngineStatus());
    }
    console.log(
      `[engine] Background check: ${result.status}${result.latest ? ` (${result.latest})` : ""}`,
    );
  }, ENGINE_AUTO_CHECK_DELAY_MS);

  timer.unref?.();
}

const libraryHost = createLibraryHost({
  app,
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  protocol,
  binaries,
});
libraryHost.register();

app.whenReady().then(async () => {
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
  getSettingsStore().load();

  // Re-verifies any updated engine (hash) before it can be used.
  try {
    await engineStore.load();
    engineStore.prune();
  } catch (error) {
    console.error(`[engine] Could not load engine state: ${error.message}`);
  }
  applyEngineOverride();

  removeStaleWorkFolders();
  getDependencyStatus();
  createWindow();
  scheduleEngineAutoCheck();

  // The library worker starts on first use, so Extract-only sessions never
  // open the database.
  libraryHost.registerProtocols();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let libraryShutDown = false;

app.on("before-quit", (event) => {
  // Close the library database cleanly once (finishes in-flight writes).
  if (!libraryShutDown) {
    libraryShutDown = true;
    event.preventDefault();
    libraryHost.shutdown().finally(() => app.quit());
    return;
  }

  for (const controllers of activeOperations.values()) {
    for (const controller of controllers) controller.abort();
  }
  killAllChildren();
});

function sanitizeFileName(value) {
  return (value || "")
    // eslint-disable-next-line no-control-regex -- strips control characters
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFinalFileName(metadata) {
  const artist = sanitizeFileName(metadata?.artist || "Unknown Artist");
  const title = sanitizeFileName(metadata?.title || "Unknown Title");
  return `${artist} - ${title}.mp3`;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function getUniqueFilePath(filePath) {
  if (!fileExists(filePath)) {
    return filePath;
  }

  const parsed = path.parse(filePath);
  let counter = 1;

  while (true) {
    const candidate = path.join(
      parsed.dir,
      `${parsed.name} (${counter})${parsed.ext}`,
    );

    if (!fileExists(candidate)) {
      return candidate;
    }

    counter += 1;
  }
}

function getYouTubeEntryUrl(entry) {
  const candidates = [entry?.webpage_url, entry?.original_url, entry?.url];
  const fullUrl = candidates.find((value) =>
    /^https?:\/\//i.test(String(value || "")),
  );

  if (fullUrl) {
    return fullUrl;
  }

  const videoId = entry?.id || entry?.url;
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

function getYouTubeVideoId(info) {
  if (!info) return null;

  if (info.id) {
    return String(info.id);
  }

  if (typeof info.url === "string" && !/^https?:\/\//i.test(info.url)) {
    return info.url;
  }

  const urlCandidates = [info.webpage_url, info.original_url, info.url];

  for (const candidate of urlCandidates) {
    if (!candidate || !/^https?:\/\//i.test(String(candidate))) continue;

    try {
      const parsedUrl = new URL(candidate);
      const queryId = parsedUrl.searchParams.get("v");
      if (queryId) return queryId;

      const shortMatch = parsedUrl.pathname.match(/^\/([^/?#]+)/);
      if (/youtu\.be$/i.test(parsedUrl.hostname) && shortMatch?.[1]) {
        return shortMatch[1];
      }
    } catch {}
  }

  return null;
}

function isUsableThumbnailUrl(value) {
  const url = String(value || "").trim();

  return (
    /^https?:\/\//i.test(url) &&
    !/\/sb\//i.test(url) &&
    !/storyboard/i.test(url)
  );
}

function getThumbnailUrlQualityRank(url) {
  const value = String(url || "").toLowerCase();

  if (value.includes("maxresdefault")) return 60;
  if (value.includes("hq720")) return 55;
  if (value.includes("sddefault")) return 50;
  if (value.includes("hqdefault")) return 40;
  if (value.includes("mqdefault")) return 30;
  if (value.includes("default")) return 20;
  return 10;
}

function compareThumbnailCandidates(left, right) {
  const leftArea = Number(left?.width || 0) * Number(left?.height || 0);
  const rightArea = Number(right?.width || 0) * Number(right?.height || 0);
  const leftQuality = getThumbnailUrlQualityRank(left?.url);
  const rightQuality = getThumbnailUrlQualityRank(right?.url);

  // When both candidates report dimensions, trust the larger image. When a
  // candidate omits dimensions, recognizable YouTube quality names such as
  // maxresdefault still provide a useful quality signal.
  if (leftArea > 0 && rightArea > 0 && leftArea !== rightArea) {
    return rightArea - leftArea;
  }

  if (leftQuality !== rightQuality) {
    return rightQuality - leftQuality;
  }

  if (leftArea !== rightArea) {
    return rightArea - leftArea;
  }

  const preferenceDifference =
    Number(right?.preference || 0) - Number(left?.preference || 0);

  if (preferenceDifference !== 0) {
    return preferenceDifference;
  }

  return Number(right?._index || 0) - Number(left?._index || 0);
}

function getExplicitThumbnailCandidates(info) {
  if (!info) return [];

  const candidates = Array.isArray(info.thumbnails)
    ? info.thumbnails
        .map((thumbnail, index) => ({ ...thumbnail, _index: index }))
        .filter((thumbnail) => isUsableThumbnailUrl(thumbnail?.url))
        .sort(compareThumbnailCandidates)
    : [];

  if (isUsableThumbnailUrl(info.thumbnail)) {
    candidates.push({
      url: info.thumbnail.trim(),
      width: Number(info.thumbnail_width || 0),
      height: Number(info.thumbnail_height || 0),
      preference: -1,
      _index: -1,
    });
  }

  const seen = new Set();

  return candidates.filter((candidate) => {
    const normalizedUrl = String(candidate.url || "").trim();
    if (!normalizedUrl || seen.has(normalizedUrl)) return false;
    seen.add(normalizedUrl);
    return true;
  });
}

function getBestThumbnailUrl(info) {
  // Preserve the thumbnail yt-dlp selected.
  // Do not replace it just because another thumbnail reports larger dimensions.
  if (isUsableThumbnailUrl(info?.thumbnail)) {
    return info.thumbnail.trim();
  }

  const explicitCandidates = getExplicitThumbnailCandidates(info);

  if (explicitCandidates.length) {
    return explicitCandidates[0].url;
  }

  // Only construct a YouTube thumbnail URL when yt-dlp did not provide one.
  const videoId = getYouTubeVideoId(info);

  return videoId
    ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`
    : null;
}

function getArtworkThumbnailCandidates(info, fallbackThumbnail = "") {
  const candidates = [];

  // This is the thumbnail that was analyzed and displayed in the UI.
  // Keep it first so the final artwork uses the exact same source image.
  if (isUsableThumbnailUrl(fallbackThumbnail)) {
    candidates.push(fallbackThumbnail.trim());
  }

  // Preserve yt-dlp's selected thumbnail before trying alternative variants.
  if (isUsableThumbnailUrl(info?.thumbnail)) {
    candidates.push(info.thumbnail.trim());
  }

  const explicitCandidates = getExplicitThumbnailCandidates(info);

  candidates.push(...explicitCandidates.map((thumbnail) => thumbnail.url));

  // Constructed YouTube URLs are only last-resort fallbacks.
  const videoId = getYouTubeVideoId(info);

  if (videoId) {
    const encodedId = encodeURIComponent(videoId);

    candidates.push(
      `https://i.ytimg.com/vi/${encodedId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${encodedId}/hq720.jpg`,
      `https://i.ytimg.com/vi/${encodedId}/sddefault.jpg`,
      `https://i.ytimg.com/vi/${encodedId}/hqdefault.jpg`,
    );
  }

  return [...new Set(candidates.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMetadataText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAlbumName(value, artist = "") {
  let album = normalizeMetadataText(value);
  if (!album) return "";

  const artistCandidates = [
    normalizeMetadataText(artist),
    normalizeMetadataText(artist).replace(/\s*-\s*Topic$/i, ""),
    normalizeMetadataText(artist).split(/\s*[,;&]\s*/)[0],
  ].filter(Boolean);

  for (const artistCandidate of [...new Set(artistCandidates)]) {
    album = album.replace(
      new RegExp(`^${escapeRegExp(artistCandidate)}\\s*[-–—|:]\\s*`, "i"),
      "",
    );
  }

  album = album
    .replace(
      /\s*(?:\(|\[)\s*(?:(?:full|official|complete)\s+)*album(?:\s+(?:playlist|audio|stream))?(?:\s+\d{4})?\s*(?:\)|\])\s*$/i,
      "",
    )
    .replace(
      /\s*[-–—|:]\s*(?:(?:full|official|complete)\s+)*album(?:\s+\d{4})?\s*$/i,
      "",
    )
    .trim();

  return album;
}

function extractYouTubeMusicDescriptionMetadata(info) {
  const lines = String(info?.description || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const providedIndex = lines.findIndex((line) =>
    /^Provided to YouTube by\b/i.test(line),
  );

  if (providedIndex < 0) {
    return { title: "", artist: "", album: "" };
  }

  const creditsLine = lines[providedIndex + 1] || "";
  const albumCandidate = lines[providedIndex + 2] || "";
  const credits = creditsLine
    .split(/\s*[·•]\s*/)
    .map((part) => normalizeMetadataText(part))
    .filter(Boolean);

  const invalidAlbumLine =
    !albumCandidate ||
    /^(?:℗|©|Released on:|Producer:|Composer:|Mastering Engineer:|Music Publisher:|Auto-generated by YouTube)/i.test(
      albumCandidate,
    );

  return {
    title: credits[0] || "",
    artist: credits[1] || "",
    album: invalidAlbumLine ? "" : normalizeMetadataText(albumCandidate),
  };
}

function getUsefulGenre(value) {
  const genre = normalizeMetadataText(value);

  if (!genre || /^(?:music|entertainment|people\s*&\s*blogs)$/i.test(genre)) {
    return "";
  }

  return genre;
}

function getExtractedMetadata(info, fallback = {}) {
  const descriptionMetadata = extractYouTubeMusicDescriptionMetadata(info);
  const artist = normalizeMetadataText(
    info?.artist ||
      info?.album_artist ||
      descriptionMetadata.artist ||
      info?.uploader ||
      info?.channel ||
      fallback.artist ||
      "",
  );

  return {
    title: normalizeMetadataText(
      info?.track || descriptionMetadata.title || info?.title || fallback.title,
    ),
    artist,
    album: cleanAlbumName(
      info?.album ||
        descriptionMetadata.album ||
        fallback.album ||
        info?.playlist_title ||
        "",
      artist,
    ),
    genre: getUsefulGenre(info?.genre) || getUsefulGenre(fallback.genre),
  };
}

function createEditableMetadata(values, provisional = {}) {
  const normalizedValues = {
    title: normalizeMetadataText(values?.title),
    artist: normalizeMetadataText(values?.artist),
    album: normalizeMetadataText(values?.album),
    genre: normalizeMetadataText(values?.genre),
  };

  return {
    ...normalizedValues,
    __wavemintInitial: { ...normalizedValues },
    __wavemintProvisional: {
      title: !!provisional.title,
      artist: !!provisional.artist,
      album: !!provisional.album,
      genre: !!provisional.genre,
    },
  };
}

function metadataValuesMatch(left, right) {
  return normalizeMetadataText(left) === normalizeMetadataText(right);
}

function resolveFinalMetadata(submittedMetadata, extractedInfo) {
  const submitted = {
    title: normalizeMetadataText(submittedMetadata?.title),
    artist: normalizeMetadataText(submittedMetadata?.artist),
    album: normalizeMetadataText(submittedMetadata?.album),
    genre: normalizeMetadataText(submittedMetadata?.genre),
  };

  const initial = submittedMetadata?.__wavemintInitial || null;
  const provisional = submittedMetadata?.__wavemintProvisional || {};
  const extracted = getExtractedMetadata(extractedInfo, submitted);
  const resolved = {};

  for (const field of ["title", "artist", "album", "genre"]) {
    const wasEdited = initial
      ? !metadataValuesMatch(submitted[field], initial[field])
      : provisional[field] === false;

    resolved[field] = wasEdited
      ? submitted[field]
      : extracted[field] || submitted[field];
  }

  return resolved;
}

function downloadFile(fileUrl, destinationPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error("Too many redirects while downloading artwork"));
      return;
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(fileUrl);
    } catch {
      reject(new Error("The artwork URL is invalid"));
      return;
    }

    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(
      parsedUrl,
      {
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WaveMint/1.0",
        },
      },
      (response) => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          const redirectUrl = new URL(
            response.headers.location,
            parsedUrl,
          ).toString();
          downloadFile(redirectUrl, destinationPath, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(`Failed to download file: HTTP ${response.statusCode}`),
          );
          return;
        }

        const fileStream = fs.createWriteStream(destinationPath);
        response.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(() => resolve(destinationPath));
        });

        fileStream.on("error", (err) => {
          response.destroy();
          fs.unlink(destinationPath, () => reject(err));
        });
      },
    );

    request.setTimeout(30000, () => {
      request.destroy(new Error("Timed out while downloading artwork"));
    });

    request.on("error", reject);
  });
}

function getImageExtensionFromUrl(fileUrl) {
  try {
    const pathname = new URL(fileUrl).pathname.toLowerCase();
    const ext = path.extname(pathname);

    if (ext === ".jpg" || ext === ".jpeg") return ".jpg";
    if (ext === ".png") return ".png";
    if (ext === ".webp") return ".webp";
    return ".jpg";
  } catch {
    return ".jpg";
  }
}

function fileToDataUrl(filePath, mimeType = "image/jpeg") {
  const fileBuffer = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
}

function createTempToken(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const ARTWORK_MODES = new Set([
  "original_thumbnail",
  "square_crop",
  "custom_file",
]);

function normalizeArtworkMode(value) {
  return ARTWORK_MODES.has(value) ? value : "original_thumbnail";
}

function removeFileQuietly(filePath) {
  if (!filePath) return;

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

async function convertImageToJpeg(inputPath, outputPath, videoFilter = null) {
  const args = ["-y", "-i", inputPath];

  if (videoFilter) {
    args.push("-vf", videoFilter);
  }

  args.push("-frames:v", "1", "-q:v", "2", outputPath);
  await runProcess("ffmpeg", args);

  if (!fileExists(outputPath)) {
    throw new Error("FFmpeg did not create the prepared artwork file");
  }

  return outputPath;
}

async function getImageDimensions(inputPath) {
  try {
    const { stdout } = await runProcess("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      inputPath,
    ]);

    const parsed = JSON.parse(stdout);
    const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;

    const width = Number(stream?.width || 0);
    const height = Number(stream?.height || 0);

    if (width > 0 && height > 0) {
      return { width, height };
    }
  } catch (error) {
    console.warn(
      `[artwork] Unable to read image dimensions for ${inputPath}:`,
      error?.message || error,
    );
  }

  return null;
}

const SQUARE_CROP_FILTER =
  "crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=1000:1000:flags=lanczos";

async function convertImageToSquareCropJpeg(inputPath, outputPath) {
  // Square mode is always a true center crop.
  // No blur, padding, borders, letterboxing, or background layers.
  return convertImageToJpeg(inputPath, outputPath, SQUARE_CROP_FILTER);
}

async function downloadBestAvailableArtwork({
  thumbnailCandidates,
  outputFolder,
  tempBaseName,
}) {
  const candidates = [...new Set((thumbnailCandidates || []).filter(Boolean))];
  let lastError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateUrl = candidates[index];
    const imageExtension = getImageExtensionFromUrl(candidateUrl);
    const destinationPath = path.join(
      outputFolder,
      `${tempBaseName}-downloaded-artwork-${index}${imageExtension}`,
    );

    try {
      await downloadFile(candidateUrl, destinationPath);

      if (fileExists(destinationPath)) {
        const dimensions = await getImageDimensions(destinationPath);

        if (dimensions) {
          return destinationPath;
        }

        lastError = new Error("The downloaded artwork was not a valid image");
        removeFileQuietly(destinationPath);
      }
    } catch (error) {
      lastError = error;
      removeFileQuietly(destinationPath);
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function findInfoJsonPath(folderPath, tempBaseName) {
  try {
    const exactPath = path.join(folderPath, `${tempBaseName}.info.json`);
    if (fileExists(exactPath)) return exactPath;

    const matchingFile = fs
      .readdirSync(folderPath)
      .find(
        (fileName) =>
          fileName.startsWith(tempBaseName) && fileName.endsWith(".info.json"),
      );

    return matchingFile ? path.join(folderPath, matchingFile) : null;
  } catch {
    return null;
  }
}

function readInfoJson(folderPath, tempBaseName) {
  const infoJsonPath = findInfoJsonPath(folderPath, tempBaseName);
  if (!infoJsonPath) return null;

  try {
    return JSON.parse(fs.readFileSync(infoJsonPath, "utf8"));
  } catch {
    return null;
  }
}

async function prepareArtwork({
  artworkMode,
  customArtworkPath,
  thumbnailCandidates,
  outputFolder,
  tempBaseName,
}) {
  const preparedArtworkPath = path.join(
    outputFolder,
    `${tempBaseName}-prepared-artwork.jpg`,
  );

  if (artworkMode === "custom_file") {
    if (!customArtworkPath || !fileExists(customArtworkPath)) {
      throw new Error("The selected custom artwork file could not be found");
    }

    await convertImageToJpeg(customArtworkPath, preparedArtworkPath);
    return preparedArtworkPath;
  }

  const downloadedArtworkPath = await downloadBestAvailableArtwork({
    thumbnailCandidates,
    outputFolder,
    tempBaseName,
  });

  if (!downloadedArtworkPath) {
    return null;
  }

  if (artworkMode === "square_crop") {
    await convertImageToSquareCropJpeg(
      downloadedArtworkPath,
      preparedArtworkPath,
    );
  } else {
    await convertImageToJpeg(downloadedArtworkPath, preparedArtworkPath);
  }

  return preparedArtworkPath;
}

// Runs FFmpeg/FFprobe (artwork and tagging) through the extraction manager's
// tool runner: same resolver, hidden windows and cancellation as yt-dlp.
// The thrown message stays short; the sanitized output is kept on the error
// for diagnostics.
async function runProcess(tool, args, options = {}) {
  const result = await extraction.runTool(tool, args, options);
  const label = binaries.resolve(tool).label;

  if (result.cancelled) {
    throw new ExtractionError({ category: CATEGORIES.CANCELLED, message: "Cancelled." });
  }

  if (result.timedOut || result.code !== 0) {
    const rawMessage = redactSensitiveText(result.stderr || result.stdout || `${tool} failed`);
    console.error(`[runProcess] ${tool} exited with code ${result.code}`);
    console.error(rawMessage);

    const processError = new Error(
      result.timedOut
        ? `${label} took too long to respond and was stopped.`
        : `${label} couldn't process the file.`,
    );
    processError.rawMessage = rawMessage;
    processError.exitCode = result.code;
    throw processError;
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

function cleanupMatchingTempFiles(folderPath, tempBaseName) {
  try {
    const files = fs.readdirSync(folderPath);

    files.forEach((file) => {
      if (file.startsWith(tempBaseName)) {
        const filePath = path.join(folderPath, file);
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
    });
  } catch {}
}

// Analysis results (titles, artwork URLs, editable metadata; never media
// URLs or cookies) are reused for a short time, so analyzing the same link
// again doesn't send YouTube the same requests twice.
const ANALYSIS_CACHE_TTL_MS = 15 * 60 * 1000;
const ANALYSIS_CACHE_MAX_ENTRIES = 20;
const analysisCache = new Map();

function getAnalysisCacheKey(url, mode) {
  return [
    mode === "video" ? "video" : "playlist",
    url.trim(),
    getAuthFingerprint(getAuthSettings()),
  ].join("|");
}

function readAnalysisCache(key) {
  const entry = analysisCache.get(key);
  if (!entry || Date.now() - entry.storedAt > ANALYSIS_CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeAnalysisCache(key, value) {
  analysisCache.delete(key);
  analysisCache.set(key, { value, storedAt: Date.now() });
  while (analysisCache.size > ANALYSIS_CACHE_MAX_ENTRIES) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
}

ipcMain.handle("analyze-url", async (event, payload) => {
  const { url, mode } = payload || {};

  if (!url || !url.trim()) {
    throw new Error("No URL provided");
  }

  const cacheKey = getAnalysisCacheKey(url, mode);
  const cached = readAnalysisCache(cacheKey);
  if (cached) {
    console.log("[analyze] Using this session's earlier analysis");
    return cached;
  }

  extraction.assertAvailable();
  assertBundledToolsPresent();

  const operation = beginOperation(event.sender);
  let parsed;

  try {
    parsed = await extraction.analyze({
      url,
      mode,
      signal: operation.signal,
      onStatus: (status) => sendToRenderer(event.sender, "analyze-progress", status),
    });
  } finally {
    operation.end();
  }

  try {
    const topDescriptionMetadata =
      extractYouTubeMusicDescriptionMetadata(parsed);
    const topMetadataValues = getExtractedMetadata(parsed, {
      album: parsed.playlist_title || parsed.title || "",
    });
    const topMetadata = createEditableMetadata(topMetadataValues, {
      title: !parsed.track && !topDescriptionMetadata.title,
      artist:
        !parsed.artist &&
        !parsed.album_artist &&
        !topDescriptionMetadata.artist,
      album: !parsed.album && !topDescriptionMetadata.album,
      genre: !getUsefulGenre(parsed.genre),
    });

    const entries = parsed.entries
      ? parsed.entries.map((entry) => {
          const entryDescriptionMetadata =
            extractYouTubeMusicDescriptionMetadata(entry);
          const entryArtistFallback =
            entry.artist ||
            entry.album_artist ||
            entry.uploader ||
            parsed.uploader ||
            parsed.channel ||
            "";
          const playlistAlbumFallback = cleanAlbumName(
            parsed.title || parsed.playlist_title || "",
            entryArtistFallback,
          );
          const entryMetadataValues = getExtractedMetadata(entry, {
            artist: entryArtistFallback,
            album: playlistAlbumFallback,
          });

          return {
            id: entry.id,
            title: entry.title,
            uploader: entry.uploader || parsed.uploader,
            duration: entry.duration,
            thumbnail: getBestThumbnailUrl(entry),
            webpage_url: getYouTubeEntryUrl(entry),
            selected: true,
            metadata: createEditableMetadata(entryMetadataValues, {
              title: !entry.track && !entryDescriptionMetadata.title,
              artist:
                !entry.artist &&
                !entry.album_artist &&
                !entryDescriptionMetadata.artist,
              album: !entry.album && !entryDescriptionMetadata.album,
              genre: !getUsefulGenre(entry.genre),
            }),
          };
        })
      : [];

    sendToRenderer(event.sender, "analyze-progress", { phase: "complete" });

    const analysis = {
      id: parsed.id,
      title: parsed.title,
      uploader: parsed.uploader,
      duration: parsed.duration,
      thumbnail: getBestThumbnailUrl(parsed),
      webpage_url: parsed.webpage_url,
      isPlaylist: !!parsed.entries,
      metadata: topMetadata,
      entries,
    };

    writeAnalysisCache(cacheKey, analysis);
    return analysis;
  } catch (error) {
    console.error("[analyze] Could not interpret yt-dlp's response:", error?.message);
    throw new ExtractionError({
      category: CATEGORIES.EXTRACTOR_OUTDATED,
      message:
        "WaveMint couldn't read YouTube's response. Its YouTube extraction components may need an update.",
    });
  }
});

// Paths the renderer may hand back to the main process. They can only enter
// these sets through main-process dialogs or WaveMint's own output, so the UI
// can never direct writes, reads or shell.openPath at arbitrary locations.
const approvedOutputFolders = new Set();
const approvedArtworkFiles = new Set();
const producedFiles = new Set();

function normalizeApprovedPath(value) {
  return typeof value === "string" && value.trim()
    ? path.resolve(value.trim())
    : "";
}

ipcMain.handle("choose-output-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  approvedOutputFolders.add(normalizeApprovedPath(result.filePaths[0]));
  return result.filePaths[0];
});

ipcMain.handle("choose-artwork-file", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      {
        name: "Artwork Images",
        extensions: ["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff"],
      },
    ],
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const filePath = result.filePaths[0];
  approvedArtworkFiles.add(normalizeApprovedPath(filePath));
  const tempFolder = app.getPath("temp");
  const tempBaseName = createTempToken("wavemint-custom-preview");
  const previewPath = path.join(tempFolder, `${tempBaseName}.jpg`);

  try {
    await convertImageToJpeg(
      filePath,
      previewPath,
      "scale=min(1200\\,iw):-2:flags=lanczos",
    );

    return {
      filePath,
      previewUrl: fileToDataUrl(previewPath),
    };
  } finally {
    removeFileQuietly(previewPath);
  }
});

// Square previews are identical for the same thumbnail, so each one is made
// once per session (and concurrent requests for it share the work).
const SQUARE_PREVIEW_CACHE_MAX_ENTRIES = 300;
const squarePreviewCache = new Map();
const squarePreviewsInFlight = new Map();

ipcMain.handle("generate-square-crop-preview", async (_event, payload) => {
  const thumbnailUrl = String(payload?.thumbnail || "").trim();

  if (!isUsableThumbnailUrl(thumbnailUrl)) {
    throw new Error("No valid thumbnail was provided for the square preview");
  }

  if (squarePreviewCache.has(thumbnailUrl)) {
    return { previewUrl: squarePreviewCache.get(thumbnailUrl) };
  }

  if (!squarePreviewsInFlight.has(thumbnailUrl)) {
    squarePreviewsInFlight.set(
      thumbnailUrl,
      generateSquareCropPreview(thumbnailUrl)
        .then((preview) => {
          squarePreviewCache.set(thumbnailUrl, preview.previewUrl);
          while (squarePreviewCache.size > SQUARE_PREVIEW_CACHE_MAX_ENTRIES) {
            squarePreviewCache.delete(squarePreviewCache.keys().next().value);
          }
          return preview;
        })
        .finally(() => squarePreviewsInFlight.delete(thumbnailUrl)),
    );
  }

  return squarePreviewsInFlight.get(thumbnailUrl);
});

async function generateSquareCropPreview(thumbnailUrl) {
  const tempFolder = app.getPath("temp");
  const tempBaseName = createTempToken("wavemint-square-preview");

  const sourcePath = path.join(
    tempFolder,
    `${tempBaseName}-source${getImageExtensionFromUrl(thumbnailUrl)}`,
  );

  const previewPath = path.join(tempFolder, `${tempBaseName}-preview.jpg`);

  try {
    await downloadFile(thumbnailUrl, sourcePath);

    await convertImageToSquareCropJpeg(sourcePath, previewPath);

    return {
      previewUrl: fileToDataUrl(previewPath),
    };
  } catch (error) {
    throw new Error(
      `Failed to generate square artwork preview: ${
        error?.message || "Unknown preview error"
      }`,
    );
  } finally {
    cleanupMatchingTempFiles(tempFolder, tempBaseName);
  }
}

// Every extraction works in its own private folder under %TEMP%WaveMint;
// see electron/outputFiles.cjs for why only the finished MP3 is moved into
// the output folder.
const WORK_ROOT_NAME = "WaveMint";
const STALE_WORK_FOLDER_MS = 24 * 60 * 60 * 1000;

function getWorkRoot() {
  return path.join(app.getPath("temp"), WORK_ROOT_NAME);
}

function createWorkFolder(name) {
  const folder = path.join(getWorkRoot(), name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function removeFolderQuietly(folder) {
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {}
}

// Leftovers from a crash or forced quit; never touches recent folders that
// another WaveMint window could still be using.
function removeStaleWorkFolders() {
  let entries = [];
  try {
    entries = fs.readdirSync(getWorkRoot(), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("wavemint-temp-")) continue;
    const folder = path.join(getWorkRoot(), entry.name);
    try {
      if (Date.now() - fs.statSync(folder).mtimeMs > STALE_WORK_FOLDER_MS) {
        removeFolderQuietly(folder);
      }
    } catch {}
  }
}

// Post-processing failures (artwork, tagging) keep their technical output in
// diagnostics; the UI gets a short explanation.
function createPostProcessingError(message, error, url) {
  const diagnosticsId = diagnostics.record({
    operation: "download",
    category: CATEGORIES.POST_PROCESSING,
    message,
    technical: [error?.message, error?.rawMessage].filter(Boolean).join("\n"),
    context: { URL: url, Engine: describeEngine() },
  });
  return new ExtractionError({ category: CATEGORIES.POST_PROCESSING, message }, { diagnosticsId });
}

ipcMain.handle("download-mp3", async (event, payload) => {
  const { url, outputFolder, metadata, thumbnail, artwork } = payload || {};

  extraction.assertAvailable();

  if (!url || !url.trim()) {
    throw new Error("No URL provided for download");
  }

  if (!outputFolder || !outputFolder.trim()) {
    throw new Error("No output folder selected");
  }

  if (!approvedOutputFolders.has(normalizeApprovedPath(outputFolder))) {
    throw new Error("Choose the output folder again before extracting");
  }

  if (
    artwork?.mode === "custom_file" &&
    !approvedArtworkFiles.has(normalizeApprovedPath(artwork?.customFilePath))
  ) {
    throw new Error("Choose the custom artwork image again before extracting");
  }

  assertBundledToolsPresent();

  const submittedMetadata = metadata || {};
  const progressTitle =
    normalizeMetadataText(submittedMetadata.title) || "Track";
  const tempBaseName = createTempToken("wavemint-temp");
  const workFolder = createWorkFolder(tempBaseName);
  const tempOutputTemplate = path.join(workFolder, `${tempBaseName}.%(ext)s`);
  const tempMp3Path = path.join(workFolder, `${tempBaseName}.mp3`);
  const taggedMp3Path = path.join(workFolder, `${tempBaseName}-tagged.mp3`);

  const artworkMode = normalizeArtworkMode(artwork?.mode);
  const customArtworkPath = artwork?.customFilePath || "";

  const operation = beginOperation(event.sender);
  const sendProgress = (status) =>
    sendToRenderer(event.sender, "download-progress", { title: progressTitle, ...status });

  try {
    // Analysis, the download itself, retries and the 403 fallback ladder are
    // handled by the extraction manager (electron/extraction.cjs).
    await extraction.download({
      url,
      outputTemplate: tempOutputTemplate,
      signal: operation.signal,
      onStatus: sendProgress,
      // Remove partial audio and metadata files before another attempt.
      onBeforeRetry: () => cleanupMatchingTempFiles(workFolder, tempBaseName),
    });

    if (!fileExists(tempMp3Path)) {
      throw createPostProcessingError(
        "WaveMint downloaded the audio but the MP3 file wasn't created. Try again.",
        new Error("Temporary MP3 file was not created"),
        url,
      );
    }

    // --write-info-json uses metadata from the same full extraction that
    // downloaded the audio. It does not add a separate per-track yt-dlp probe.
    const extractedInfo = readInfoJson(workFolder, tempBaseName);
    const finalMetadata = resolveFinalMetadata(
      submittedMetadata,
      extractedInfo,
    );
    const finalFileName = buildFinalFileName(finalMetadata);
    const thumbnailCandidates = getArtworkThumbnailCandidates(
      extractedInfo,
      thumbnail,
    );

    let preparedArtworkPath = null;
    sendProgress({ phase: "artwork" });

    try {
      preparedArtworkPath = await prepareArtwork({
        artworkMode,
        customArtworkPath,
        thumbnailCandidates,
        outputFolder: workFolder,
        tempBaseName,
      });
    } catch (artworkError) {
      if (artworkError instanceof ExtractionError) throw artworkError;
      throw createPostProcessingError(
        `Failed to prepare artwork: ${artworkError?.message || "Unknown artwork error"}`,
        artworkError,
        url,
      );
    }

    const hasCover = preparedArtworkPath && fileExists(preparedArtworkPath);

    sendProgress({ phase: "metadata", title: finalMetadata.title || progressTitle });

    const ffmpegArgs = hasCover
      ? [
          "-y",
          "-i",
          tempMp3Path,
          "-i",
          preparedArtworkPath,
          "-map",
          "0:a",
          "-map",
          "1:v",
          "-c:a",
          "copy",
          "-c:v",
          "copy",
          "-disposition:v",
          "attached_pic",
          "-id3v2_version",
          "3",
          "-metadata",
          `title=${finalMetadata.title}`,
          "-metadata",
          `artist=${finalMetadata.artist}`,
          "-metadata",
          `album=${finalMetadata.album}`,
          "-metadata",
          `genre=${finalMetadata.genre}`,
          "-metadata:s:v",
          "title=Album cover",
          "-metadata:s:v",
          "comment=Cover (front)",
          taggedMp3Path,
        ]
      : [
          "-y",
          "-i",
          tempMp3Path,
          "-map",
          "0:a",
          "-c:a",
          "copy",
          "-id3v2_version",
          "3",
          "-metadata",
          `title=${finalMetadata.title}`,
          "-metadata",
          `artist=${finalMetadata.artist}`,
          "-metadata",
          `album=${finalMetadata.album}`,
          "-metadata",
          `genre=${finalMetadata.genre}`,
          taggedMp3Path,
        ];

    try {
      await runProcess("ffmpeg", ffmpegArgs, { signal: operation.signal });
    } catch (taggingError) {
      if (taggingError instanceof ExtractionError) throw taggingError;
      throw createPostProcessingError(
        "WaveMint couldn't write the song details and cover art into the MP3. Try again.",
        taggingError,
        url,
      );
    }

    // The finished file is the only thing that ever reaches the output folder.
    const finalOutputPath = getUniqueFilePath(path.join(outputFolder, finalFileName));
    try {
      moveIntoOutputFolder(taggedMp3Path, finalOutputPath);
    } catch (saveError) {
      throw createPostProcessingError(
        "WaveMint couldn't save the MP3 to the output folder. Check that the folder still exists and that you can save files there, then try again.",
        saveError,
        url,
      );
    }

    producedFiles.add(normalizeApprovedPath(finalOutputPath));
    const autoImported = isAutoImportFolder(outputFolder);

    sendProgress({ phase: "complete", title: finalMetadata.title || progressTitle });

    return {
      success: true,
      message: "MP3 extraction and metadata tagging completed successfully",
      outputFolder,
      filePath: finalOutputPath,
      fileName: path.basename(finalOutputPath),
      metadata: finalMetadata,
      artworkMode,
      // iTunes/Music takes the file from this folder by itself.
      autoImported,
    };
  } finally {
    removeFolderQuietly(workFolder);
    operation.end();
  }
});

// Stops every running analysis/extraction started by this window. The
// interrupted operation rejects with a "cancelled" error.
ipcMain.handle("cancel-operations", async (event) => {
  const controllers = activeOperations.get(event.sender.id);
  const count = controllers?.size || 0;
  for (const controller of controllers || []) controller.abort();
  return { cancelled: count };
});

ipcMain.handle("open-file", async (_, filePath) => {
  if (!filePath || !filePath.trim()) {
    throw new Error("No file path provided");
  }

  // Only MP3s that WaveMint itself created can be opened from the UI.
  if (!producedFiles.has(normalizeApprovedPath(filePath))) {
    throw new Error("Only files extracted by WaveMint can be opened");
  }

  if (!fileExists(filePath)) {
    throw new Error(
      "This MP3 is no longer where WaveMint saved it. Another app (such as iTunes) may have already moved it into its library.",
    );
  }

  const openError = await shell.openPath(filePath);
  if (openError) {
    throw new Error(openError);
  }

  return { success: true };
});

ipcMain.handle("open-folder", async (_, folderPath) => {
  if (!folderPath || !folderPath.trim()) {
    throw new Error("No folder path provided");
  }

  if (!approvedOutputFolders.has(normalizeApprovedPath(folderPath))) {
    throw new Error("Only the selected output folder can be opened");
  }

  const openError = await shell.openPath(folderPath);
  if (openError) {
    throw new Error(openError);
  }

  return { success: true };
});

// ---------------------------------------------------------------------------
// Application status
// ---------------------------------------------------------------------------

ipcMain.handle("get-app-status", async (_event, payload) => {
  const dependencies = await getDependencyStatus({ refresh: !!payload?.refresh });
  const bundledVersions = binaries.readBundledVersions();
  const active = engineStore.getActive();

  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dependencies,
    components: (bundledVersions?.binaries || []).map((item) => ({
      id: item.id,
      version: item.id === "yt-dlp" && active ? active.version : item.version,
    })),
  };
});

// ---------------------------------------------------------------------------
// Error details (sanitized diagnostics)
// ---------------------------------------------------------------------------

function getFormattedDiagnostics(id) {
  const entry = diagnostics.get(id);
  if (!entry) return "";
  return formatDiagnostics(entry, { appVersion: app.getVersion() });
}

ipcMain.handle("get-error-details", async (_event, id) => getFormattedDiagnostics(id));

ipcMain.handle("copy-error-details", async (_event, id) => {
  const text = getFormattedDiagnostics(id);
  if (!text) return { copied: false };
  clipboard.writeText(text);
  return { copied: true };
});

// ---------------------------------------------------------------------------
// Extraction engine status and updates
// ---------------------------------------------------------------------------

let lastEngineInstallError = "";

function buildEngineStatus() {
  const state = engineStore.getState();
  const active = engineStore.getActive();
  const { engine } = getSettingsStore().get();
  const lastCheck = state.lastCheck?.channel === engine.channel ? state.lastCheck : null;
  const current = getCurrentEngineVersion();

  return {
    current: {
      version: current,
      source: active ? "updated" : "bundled",
      channel: active?.channel || "stable",
      ejsVersion: active?.ejsVersion || "",
    },
    bundledVersion: getBundledYtDlpVersion(),
    previousVersion: state.previous?.version || "",
    channel: engine.channel,
    autoCheck: engine.autoCheck,
    channels: Object.entries(CHANNELS).map(([id, item]) => ({ id, label: item.label })),
    lastCheck: lastCheck
      ? {
          ...lastCheck,
          // A check made before an install may be stale.
          status:
            lastCheck.status === "available" && lastCheck.latest === current
              ? "up-to-date"
              : lastCheck.status,
        }
      : null,
    installing: engineUpdater.isInstalling(),
    lastInstallError: lastEngineInstallError,
  };
}

function refreshEngineAfterChange() {
  applyEngineOverride();
  analysisCache.clear();
  // Re-run the startup check against the newly selected engine.
  return getDependencyStatus({ refresh: true });
}

ipcMain.handle("engine-get-status", async () => buildEngineStatus());

ipcMain.handle("engine-check", async () => {
  const { engine } = getSettingsStore().get();
  await engineUpdater.check({ channel: engine.channel });
  return buildEngineStatus();
});

ipcMain.handle("engine-install", async (event) => {
  if (extraction.isBusy()) {
    throw new Error("Wait for the current analysis or extraction to finish before updating");
  }

  const { engine } = getSettingsStore().get();
  lastEngineInstallError = "";

  try {
    await engineUpdater.install({
      channel: engine.channel,
      onProgress: (progress) => sendToRenderer(event.sender, "engine-progress", progress),
    });
  } catch (error) {
    lastEngineInstallError = error.message;
    throw createUserError("engine", error.message);
  }

  await refreshEngineAfterChange();
  return buildEngineStatus();
});

ipcMain.handle("engine-use-bundled", async () => {
  if (extraction.isBusy()) {
    throw new Error("Wait for the current analysis or extraction to finish first");
  }

  engineStore.useBundled();
  await refreshEngineAfterChange();
  return buildEngineStatus();
});

ipcMain.handle("engine-rollback", async () => {
  if (extraction.isBusy()) {
    throw new Error("Wait for the current analysis or extraction to finish first");
  }

  if (!engineStore.rollback()) {
    throw new Error("There is no previous engine version to go back to");
  }

  await refreshEngineAfterChange();
  return buildEngineStatus();
});

ipcMain.handle("engine-set-preferences", async (_event, payload) => {
  const patch = {};
  if (payload && Object.hasOwn(payload, "channel")) {
    if (!CHANNELS[payload.channel]) throw new Error("Unknown update channel");
    patch.channel = payload.channel;
  }
  if (payload && Object.hasOwn(payload, "autoCheck")) {
    patch.autoCheck = !!payload.autoCheck;
  }

  getSettingsStore().updateEngine(patch);
  return buildEngineStatus();
});

// ---------------------------------------------------------------------------
// YouTube authentication settings
// ---------------------------------------------------------------------------

const AUTH_TEST_MIN_INTERVAL_MS = 10000;
const AUTH_TEST_TIMEOUT_MS = 120000;
let authTestInFlight = false;
let lastAuthTestStartedAt = 0;

// Everything the settings screen needs, without any cookie contents.
function buildAuthState() {
  const authSettings = getAuthSettings();
  const fingerprint = getAuthFingerprint(authSettings);
  let cookiesFile = null;

  if (authSettings.cookiesFilePath) {
    const inspection = inspectCookiesFile(authSettings.cookiesFilePath);
    cookiesFile = {
      path: authSettings.cookiesFilePath,
      name: path.basename(authSettings.cookiesFilePath),
      ok: inspection.ok,
      code: inspection.code,
      message: inspection.message || "",
      stats: inspection.stats || null,
    };
  }

  return {
    mode: authSettings.mode,
    browser: authSettings.browser,
    browserProfile: authSettings.browserProfile,
    cookiesFile,
    lastTest:
      authSettings.lastTest?.fingerprint === fingerprint
        ? authSettings.lastTest
        : null,
  };
}

ipcMain.handle("auth-get-state", async () => buildAuthState());

ipcMain.handle("auth-set-mode", async (_event, mode) => {
  if (!["none", "browser", "cookies_file"].includes(mode)) {
    throw new Error("Unknown authentication method");
  }

  getSettingsStore().updateAuth({ mode });
  return buildAuthState();
});

// Browser detection only looks at folder layout and profile names. The
// settings screen requests it when the user chooses browser cookies.
ipcMain.handle("auth-detect-browsers", async () => detectBrowsers());

ipcMain.handle("auth-set-browser", async (_event, payload) => {
  const browser = payload?.browser;
  const requestedProfile = sanitizeProfileValue(payload?.profile);

  if (!isSupportedBrowser(browser)) {
    throw new Error("Choose a supported browser");
  }

  let profile = "";

  if (requestedProfile && path.isAbsolute(requestedProfile)) {
    try {
      profile = validateCustomProfileFolder(browser, requestedProfile);
    } catch (error) {
      throw createUserError("auth", error.message);
    }
  } else if (requestedProfile) {
    const detected = detectBrowsers().find((item) => item.id === browser);
    const isKnownProfile = detected?.profiles.some(
      (item) => item.value === requestedProfile,
    );

    if (!isKnownProfile) {
      throw createUserError("auth", "This browser profile could not be accessed.");
    }

    profile = requestedProfile;
  }

  getSettingsStore().updateAuth({
    mode: "browser",
    browser,
    browserProfile: profile,
  });

  return buildAuthState();
});

ipcMain.handle("auth-choose-profile-folder", async (event, browserId) => {
  const browser = getBrowser(browserId);
  if (!browser) {
    throw new Error("Choose a supported browser first");
  }

  const result = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: `Choose a ${browser.label} profile folder`,
      properties: ["openDirectory", "dontAddToRecent"],
    },
  );

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  let profile;
  try {
    profile = validateCustomProfileFolder(browser.id, result.filePaths[0]);
  } catch (error) {
    throw createUserError("auth", error.message);
  }

  getSettingsStore().updateAuth({
    mode: "browser",
    browser: browser.id,
    browserProfile: profile,
  });

  return buildAuthState();
});

// The file is used where the user keeps it; WaveMint stores only its path.
ipcMain.handle("auth-choose-cookies-file", async (event) => {
  const result = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender),
    {
      title: "Choose a cookies.txt file",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "Cookie files", extensions: ["txt", "cookies"] },
        { name: "All files", extensions: ["*"] },
      ],
    },
  );

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const filePath = result.filePaths[0];
  const inspection = inspectCookiesFile(filePath);

  if (!inspection.ok) {
    throw createUserError("auth", inspection.message);
  }

  getSettingsStore().updateAuth({
    mode: "cookies_file",
    cookiesFilePath: filePath,
  });

  return buildAuthState();
});

// Turns authentication off and forgets every saved choice (browser, profile,
// cookie file location and test result). Files on disk are never touched.
ipcMain.handle("auth-remove", async () => {
  getSettingsStore().updateAuth({
    mode: "none",
    browser: "",
    browserProfile: "",
    cookiesFilePath: "",
    lastTest: null,
  });
  analysisCache.clear();

  return buildAuthState();
});

ipcMain.handle("auth-remove-cookies-file", async () => {
  const authSettings = getAuthSettings();

  // WaveMint never copies the user's file, so forgetting its location is the
  // whole cleanup.
  getSettingsStore().updateAuth({
    cookiesFilePath: "",
    mode: authSettings.mode === "cookies_file" ? "none" : authSettings.mode,
    lastTest: authSettings.lastTest?.fingerprint?.startsWith("cookies_file|")
      ? null
      : authSettings.lastTest,
  });

  return buildAuthState();
});

function getLocalCookiesFileVerdict(authSettings) {
  const inspection = inspectCookiesFile(authSettings.cookiesFilePath);

  if (!inspection.ok) {
    return {
      status: "failed",
      sourceAccessible: false,
      code: inspection.code,
      message: inspection.message,
    };
  }

  if (inspection.code === "no_sign_in") {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: "no_sign_in",
      message:
        "This cookie file doesn't contain a YouTube sign-in session. Export cookies from youtube.com while signed in.",
    };
  }

  if (inspection.code === "expired") {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: "expired",
      message:
        "The YouTube sign-in cookies in this file have expired. Export a fresh cookies.txt while signed in to YouTube.",
    };
  }

  return null;
}

// User-initiated check: confirms the cookie source can be read and that
// YouTube accepts it as a signed-in session, using one lightweight request
// (no media is downloaded). Cookie values never leave the main process.
ipcMain.handle("auth-test", async () => {
  const authSettings = getAuthSettings();

  if (authSettings.mode === "none") {
    throw new Error("Choose an authentication method to test");
  }

  if (authTestInFlight) {
    throw new Error("An authentication test is already running");
  }

  if (extraction.isBusy()) {
    throw new Error(
      "Wait for the current analysis or extraction to finish before testing authentication",
    );
  }

  const waitMs = lastAuthTestStartedAt + AUTH_TEST_MIN_INTERVAL_MS - Date.now();
  if (waitMs > 0) {
    throw new Error(
      `Please wait ${Math.ceil(waitMs / 1000)} seconds before testing again`,
    );
  }

  extraction.assertAvailable();
  assertBundledToolsPresent();

  authTestInFlight = true;
  lastAuthTestStartedAt = Date.now();

  try {
    let outcome =
      authSettings.mode === "cookies_file"
        ? getLocalCookiesFileVerdict(authSettings)
        : null;

    let authArgs = [];
    if (!outcome) {
      try {
        authArgs = buildYtDlpAuthArgs(authSettings);
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        outcome = {
          status: "failed",
          sourceAccessible: false,
          code: error.code,
          message: error.message,
        };
      }
    }

    if (!outcome) {
      // WaveMint's runtime options are added by extraction.runTool.
      const args = [
        ...authArgs,
        "--flat-playlist",
        "--playlist-items",
        "1",
        "--dump-single-json",
        // Adds cookie counts to stderr (never values); stderr is redacted and
        // only classified, not logged.
        "--verbose",
        "--",
        AUTH_PROBE_URL,
      ];

      console.log(`[auth] Testing authentication (${authSettings.mode})`);

      // Runs through the extraction manager so it counts as a running job
      // and shares its process handling; the probe's output is interpreted
      // here because it differs from analysis or downloads.
      const result = await extraction.runTool("yt-dlp", args, {
        timeoutMs: AUTH_TEST_TIMEOUT_MS,
      });

      // stdout holds the account's Watch Later data; only its id is read and
      // it is never logged.
      const stderr = redactSensitiveText(result.stderr);

      if (result.code !== 0 && isYouTubeRateLimitMessage(stderr)) {
        extraction.markRateLimited();
        outcome = {
          status: "failed",
          sourceAccessible: true,
          code: "rate_limited",
          message: "YouTube has temporarily rate-limited requests. Try again later.",
        };
      } else {
        outcome = interpretAuthProbe(
          { ...result, stdout: result.code === 0 ? result.stdout : "", stderr },
          authSettings,
        );
      }
    }

    console.log(`[auth] Test result: ${outcome.status} (${outcome.code})`);

    const testedAt = new Date().toISOString();
    getSettingsStore().updateAuth({
      lastTest: {
        status: outcome.status,
        fingerprint: getAuthFingerprint(authSettings),
        code: outcome.code,
        message: outcome.message,
        testedAt,
      },
    });

    return { ...outcome, testedAt, state: buildAuthState() };
  } finally {
    authTestInFlight = false;
  }
});
