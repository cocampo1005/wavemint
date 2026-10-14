// IPC for Settings → Extraction Engine: status, checking for and installing
// verified yt-dlp updates (engine.cjs), switching back to the built-in copy,
// rollback, preferences, and the quiet background check.

const { CHANNELS } = require("../engine.cjs");
const { taggedError } = require("../errors.cjs");

const AUTO_CHECK_DELAY_MS = 20 * 1000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function registerEngineHandlers({ ipc, BrowserWindow, engineStore, engineUpdater, getSettingsStore, getBundledYtDlpVersion, isExtractionBusy, onEngineChanged, logger = console }) {
  let lastInstallError = "";

  const currentVersion = () => engineStore.getActive()?.version || getBundledYtDlpVersion();

  function buildStatus() {
    const state = engineStore.getState();
    const active = engineStore.getActive();
    const { engine } = getSettingsStore().get();
    const lastCheck = state.lastCheck?.channel === engine.channel ? state.lastCheck : null;
    const current = currentVersion();
    return {
      current: { version: current, source: active ? "updated" : "bundled", channel: active?.channel || "stable", ejsVersion: active?.ejsVersion || "" },
      bundledVersion: getBundledYtDlpVersion(),
      previousVersion: state.previous?.version || "",
      channel: engine.channel,
      autoCheck: engine.autoCheck,
      channels: Object.entries(CHANNELS).map(([id, item]) => ({ id, label: item.label })),
      // A check made before an install may be stale.
      lastCheck: lastCheck ? { ...lastCheck, status: lastCheck.status === "available" && lastCheck.latest === current ? "up-to-date" : lastCheck.status } : null,
      installing: engineUpdater.isInstalling(),
      lastInstallError,
    };
  }

  function requireIdle(action) {
    if (isExtractionBusy()) throw new Error(`Wait for the current analysis or extraction to finish ${action}`);
  }

  ipc.handle("engine-get-status", async () => buildStatus());

  ipc.handle("engine-check", async () => {
    await engineUpdater.check({ channel: getSettingsStore().get().engine.channel });
    return buildStatus();
  });

  ipc.handle("engine-install", async (event) => {
    requireIdle("before updating");
    lastInstallError = "";
    try {
      await engineUpdater.install({
        channel: getSettingsStore().get().engine.channel,
        onProgress: (progress) => !event.sender.isDestroyed() && event.sender.send("engine-progress", progress),
      });
    } catch (error) {
      lastInstallError = error.message;
      throw taggedError("engine", error.message);
    }
    await onEngineChanged();
    return buildStatus();
  });

  ipc.handle("engine-use-bundled", async () => {
    requireIdle("first");
    engineStore.useBundled();
    await onEngineChanged();
    return buildStatus();
  });

  ipc.handle("engine-rollback", async () => {
    requireIdle("first");
    if (!engineStore.rollback()) throw new Error("There is no previous engine version to go back to");
    await onEngineChanged();
    return buildStatus();
  });

  ipc.handle("engine-set-preferences", async (_event, payload) => {
    const patch = {};
    if (payload && Object.hasOwn(payload, "channel")) {
      if (!CHANNELS[payload.channel]) throw new Error("Unknown update channel");
      patch.channel = payload.channel;
    }
    if (payload && Object.hasOwn(payload, "autoCheck")) patch.autoCheck = !!payload.autoCheck;
    getSettingsStore().updateEngine(patch);
    return buildStatus();
  });

  // A quiet, at-most-daily check after startup. It never installs anything
  // and never blocks startup; failures (offline) are simply recorded.
  function scheduleAutoCheck() {
    const timer = setTimeout(async () => {
      const { engine } = getSettingsStore().get();
      if (!engine.autoCheck || engineUpdater.isInstalling()) return;
      const lastCheck = engineStore.getState().lastCheck;
      if (lastCheck?.channel === engine.channel && Date.now() - (Date.parse(lastCheck?.checkedAt || "") || 0) < AUTO_CHECK_INTERVAL_MS) return;

      const result = await engineUpdater.check({ channel: engine.channel });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) win.webContents.send("engine-status-changed", buildStatus());
      }
      logger.log(`[engine] Background check: ${result.status}${result.latest ? ` (${result.latest})` : ""}`);
    }, AUTO_CHECK_DELAY_MS);
    timer.unref?.();
  }

  return { scheduleAutoCheck };
}

module.exports = { registerEngineHandlers };
