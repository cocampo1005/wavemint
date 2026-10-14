// WaveMint's main process: creates the services, registers the IPC handlers,
// and owns the window and the app's lifecycle. The work itself lives in the
// modules wired together here:
//
//   binaries.cjs          where yt-dlp, FFmpeg, FFprobe and Deno live
//   extraction.cjs        every yt-dlp run (retries, rate limits, cancellation)
//   songExtraction.cjs    URL → finished, tagged MP3 (with artwork.cjs)
//   engine.cjs            verified in-app yt-dlp updates
//   auth.cjs / settings.cjs   YouTube sign-in options, persisted settings
//   library/host.cjs      the music library (a worker thread owning SQLite)
//   ipc/*.cjs             the renderer-facing handlers, all behind trustedIpc

const { app, BrowserWindow, clipboard, ipcMain, dialog, protocol, session, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { createArtworkProcessor } = require("./artwork.cjs");
const { buildYtDlpAuthArgs } = require("./auth.cjs");
const { createBinaryResolver, selfTestYtDlp, verifyDependencies } = require("./binaries.cjs");
const { createDiagnosticsStore, formatDiagnostics } = require("./diagnostics.cjs");
const { createEngineStore, createEngineUpdater } = require("./engine.cjs");
const { CATEGORIES, ExtractionError } = require("./errors.cjs");
const { createExtractionManager } = require("./extraction.cjs");
const { registerAuthHandlers } = require("./ipc/authHandlers.cjs");
const { registerEngineHandlers } = require("./ipc/engineHandlers.cjs");
const { registerExtractionHandlers } = require("./ipc/extractionHandlers.cjs");
const { createAppUrlCheck, createTrustedIpc } = require("./ipc/trustedIpc.cjs");
const { createLibraryHost, registerLibrarySchemes } = require("./library/host.cjs");
const { createOperationRegistry } = require("./operationRegistry.cjs");
const { killAllChildren, runCommand } = require("./processes.cjs");
const { createSettingsStore } = require("./settings.cjs");
const { createSongExtractor, removeStaleWorkFolders } = require("./songExtraction.cjs");

// Must match appId in electron-builder.yml.
const APP_USER_MODEL_ID = "com.wavemint.app";
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
const INDEX_FILE = path.join(__dirname, "..", "dist", "index.html");
const USE_BUILT_RENDERER = app.isPackaged || process.env.WAVEMINT_RENDERER === "dist";
// The only browser permission the UI uses (Listen Mode). Everything else
// (camera, microphone, notifications, location…) is refused.
const ALLOWED_PERMISSIONS = new Set(["fullscreen"]);

// Development runs keep their own settings so experimenting never touches an
// installed copy's configuration (an explicit --user-data-dir, as tests use,
// wins). Must run before the app is ready.
if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), "WaveMint-Dev"));
}

// Custom protocols for library audio and artwork (before the app is ready).
registerLibrarySchemes(protocol);

// --- services ------------------------------------------------------------------

const userData = (...parts) => path.join(app.getPath("userData"), ...parts);
const workRoot = () => path.join(app.getPath("temp"), "WaveMint");

const binaries = createBinaryResolver({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appRoot: path.join(__dirname, ".."),
  cacheDir: userData("yt-dlp-cache"),
});

let settingsStore = null;
function getSettingsStore() {
  settingsStore ??= createSettingsStore(userData("settings.json"));
  return settingsStore;
}

const diagnostics = createDiagnosticsStore();
const engineStore = createEngineStore({ dir: userData("engine") });
const getBundledYtDlpVersion = () => binaries.readBundledVersions()?.binaries?.find((item) => item.id === "yt-dlp")?.version || "";

function describeEngine() {
  const active = engineStore.getActive();
  return active ? `yt-dlp ${active.version} (updated, ${active.channel})` : `yt-dlp ${getBundledYtDlpVersion() || "unknown"} (built-in)`;
}

function applyEngineOverride() {
  const active = engineStore.getActive();
  binaries.setYtDlpOverride(active ? { command: active.command, version: active.version } : null);
}

const extraction = createExtractionManager({
  binaries,
  runCommand,
  getAuthSettings: () => getSettingsStore().get().auth,
  buildAuthArgs: buildYtDlpAuthArgs,
  diagnostics,
  getEngineDescription: describeEngine,
});

const engineUpdater = createEngineUpdater({
  store: engineStore,
  getCurrentVersion: () => engineStore.getActive()?.version || getBundledYtDlpVersion(),
  selfTest: (command) => selfTestYtDlp(binaries, command, { timeoutMs: 60000 }),
  isBusy: () => extraction.isBusy(),
});

const artwork = createArtworkProcessor({ runChecked: extraction.runChecked, getTempDir: () => app.getPath("temp") });
const songExtractor = createSongExtractor({ extraction, artwork, workRoot: workRoot(), diagnostics, describeEngine });
const operations = createOperationRegistry();

let dependencyStatusPromise = null;

/** The startup check of the bundled tools (cached; `refresh` re-runs it). */
function getDependencyStatus({ refresh = false } = {}) {
  if (dependencyStatusPromise && !refresh) return dependencyStatusPromise;
  dependencyStatusPromise = verifyDependencies(binaries).then(async (status) => {
    // An updated engine that fails its check is retired and the built-in
    // copy takes over, so a bad update can never break WaveMint.
    const ytDlp = status.tools.find((tool) => tool.tool === "yt-dlp");
    if (ytDlp && !ytDlp.ok && ytDlp.source === "updated") {
      const active = engineStore.getActive();
      console.error(`[engine] Updated yt-dlp ${active?.version} failed its check; reverting to the built-in version`);
      if (active) engineStore.markBroken(active.version);
      applyEngineOverride();
      status = await verifyDependencies(binaries);
    }
    for (const tool of status.tools) {
      if (tool.ok) {
        const extra = tool.ejsVersion ? ` (EJS ${tool.ejsVersion}, JS runtime ${tool.jsRuntimes.join(", ") || "none"})` : "";
        console.log(`[dependencies] ${tool.label}: ${tool.version}${extra}`);
      } else {
        console.error(`[dependencies] ${tool.label}: ${tool.message}`);
      }
    }
    return status;
  });
  return dependencyStatusPromise;
}

// Cheap per-operation guard (a file-exists check, no process launch) so a
// missing bundled tool produces a clear message instead of a spawn error.
function assertBundledToolsPresent() {
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
    const resolved = binaries.resolve(tool);
    if (!resolved.bundled || fs.existsSync(resolved.command)) continue;
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

// --- IPC -----------------------------------------------------------------------

const ipc = createTrustedIpc({
  ipcMain,
  isAppUrl: createAppUrlCheck(USE_BUILT_RENDERER ? { indexFile: INDEX_FILE } : { devServerUrl: DEV_SERVER_URL }),
});

const libraryHost = createLibraryHost({
  app,
  ipcMain: ipc,
  dialog,
  shell,
  BrowserWindow,
  protocol,
  binaries,
  // Storage cleanup never runs during an extraction.
  isExtractionBusy: () => extraction.isBusy(),
});
libraryHost.register();

const { clearAnalysisCache } = registerExtractionHandlers({
  ipc,
  dialog,
  BrowserWindow,
  extraction,
  artwork,
  songExtractor,
  libraryHost,
  getAuthSettings: () => getSettingsStore().get().auth,
  assertBundledToolsPresent,
  operations,
});

const { scheduleAutoCheck } = registerEngineHandlers({
  ipc,
  BrowserWindow,
  engineStore,
  engineUpdater,
  getSettingsStore,
  getBundledYtDlpVersion,
  isExtractionBusy: () => extraction.isBusy(),
  // A different engine: earlier analyses and the startup check are stale.
  onEngineChanged: () => {
    applyEngineOverride();
    clearAnalysisCache();
    return getDependencyStatus({ refresh: true });
  },
});

registerAuthHandlers({ ipc, dialog, BrowserWindow, getSettingsStore, extraction, assertBundledToolsPresent, clearAnalysisCache });

ipc.handle("get-app-status", async (_event, payload) => {
  const dependencies = await getDependencyStatus({ refresh: !!payload?.refresh });
  const active = engineStore.getActive();
  return {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    dependencies,
    components: (binaries.readBundledVersions()?.binaries || []).map((item) => ({
      id: item.id,
      version: item.id === "yt-dlp" && active ? active.version : item.version,
    })),
  };
});

// Sanitized technical details of a failed operation (diagnostics.cjs).
function formattedDiagnostics(id) {
  const entry = diagnostics.get(id);
  return entry ? formatDiagnostics(entry, { appVersion: app.getVersion() }) : "";
}

ipc.handle("get-error-details", async (_event, id) => formattedDiagnostics(id));

ipc.handle("copy-error-details", async (_event, id) => {
  const text = formattedDiagnostics(id);
  if (!text) return { copied: false };
  clipboard.writeText(text);
  return { copied: true };
});

// --- window and lifecycle --------------------------------------------------------

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
    if (targetUrl !== win.webContents.getURL()) event.preventDefault();
  });

  if (USE_BUILT_RENDERER) win.loadFile(INDEX_FILE);
  else win.loadURL(DEV_SERVER_URL);
}

app.whenReady().then(async () => {
  app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : process.execPath);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
  getSettingsStore().load();

  // Re-verifies any updated engine (hash) before it can be used.
  try {
    await engineStore.load();
    engineStore.prune();
  } catch (error) {
    console.error(`[engine] Could not load engine state: ${error.message}`);
  }
  applyEngineOverride();

  removeStaleWorkFolders(workRoot());
  getDependencyStatus();
  createWindow();
  scheduleAutoCheck();

  // The library worker itself starts on first use.
  libraryHost.registerProtocols();
  libraryHost.startStorageMaintenance();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let libraryShutDown = false;

app.on("before-quit", (event) => {
  // Stop the library worker first (running library jobs are given a moment
  // to stop; anything interrupted is recovered at the next start).
  if (!libraryShutDown) {
    libraryShutDown = true;
    event.preventDefault();
    libraryHost.shutdown().finally(() => app.quit());
    return;
  }
  operations.cancelAll();
  killAllChildren();
});
