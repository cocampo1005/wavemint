// IPC for Settings → YouTube Access: the authentication mode, browser and
// profile choice, a cookies.txt location, and the sign-in test.
//
// Cookie values never cross this boundary: the renderer only receives the
// state below (mode, browser, profile, the cookie file's name and checks).
// Files and folders are always chosen in main-process dialogs.

const path = require("path");
const {
  AUTH_MODES,
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
} = require("../auth.cjs");
const { isYouTubeRateLimitMessage, taggedError } = require("../errors.cjs");

const TEST_MIN_INTERVAL_MS = 10000;
const TEST_TIMEOUT_MS = 120000;

/** A verdict on a cookies.txt file that needs no network request, or null. */
function localCookiesFileVerdict(authSettings) {
  const inspection = inspectCookiesFile(authSettings.cookiesFilePath);
  if (!inspection.ok) return { status: "failed", sourceAccessible: false, code: inspection.code, message: inspection.message };
  if (inspection.code === "no_sign_in") {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: "no_sign_in",
      message: "This cookie file doesn't contain a YouTube sign-in session. Export cookies from youtube.com while signed in.",
    };
  }
  if (inspection.code === "expired") {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: "expired",
      message: "The YouTube sign-in cookies in this file have expired. Export a fresh cookies.txt while signed in to YouTube.",
    };
  }
  return null;
}

function registerAuthHandlers({ ipc, dialog, BrowserWindow, getSettingsStore, extraction, assertBundledToolsPresent, clearAnalysisCache, logger = console }) {
  const getAuthSettings = () => getSettingsStore().get().auth;
  const updateAuth = (patch) => getSettingsStore().updateAuth(patch);
  let testInFlight = false;
  let lastTestStartedAt = 0;

  // Everything the settings screen needs, without any cookie contents.
  function buildState() {
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
      lastTest: authSettings.lastTest?.fingerprint === fingerprint ? authSettings.lastTest : null,
    };
  }

  function validatedProfileFolder(browserId, folder) {
    try {
      return validateCustomProfileFolder(browserId, folder);
    } catch (error) {
      throw taggedError("auth", error.message);
    }
  }

  ipc.handle("auth-get-state", async () => buildState());

  ipc.handle("auth-set-mode", async (_event, mode) => {
    if (!AUTH_MODES.includes(mode)) throw new Error("Unknown authentication method");
    updateAuth({ mode });
    return buildState();
  });

  // Browser detection only looks at folder layout and profile names.
  ipc.handle("auth-detect-browsers", async () => detectBrowsers());

  ipc.handle("auth-set-browser", async (_event, payload) => {
    const browser = payload?.browser;
    const requestedProfile = sanitizeProfileValue(payload?.profile);
    if (!isSupportedBrowser(browser)) throw new Error("Choose a supported browser");

    let profile = "";
    if (requestedProfile && path.isAbsolute(requestedProfile)) {
      profile = validatedProfileFolder(browser, requestedProfile);
    } else if (requestedProfile) {
      const detected = detectBrowsers().find((item) => item.id === browser);
      if (!detected?.profiles.some((item) => item.value === requestedProfile)) throw taggedError("auth", "This browser profile could not be accessed.");
      profile = requestedProfile;
    }
    updateAuth({ mode: "browser", browser, browserProfile: profile });
    return buildState();
  });

  ipc.handle("auth-choose-profile-folder", async (event, browserId) => {
    const browser = getBrowser(browserId);
    if (!browser) throw new Error("Choose a supported browser first");
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: `Choose a ${browser.label} profile folder`,
      properties: ["openDirectory", "dontAddToRecent"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    updateAuth({ mode: "browser", browser: browser.id, browserProfile: validatedProfileFolder(browser.id, result.filePaths[0]) });
    return buildState();
  });

  // The file stays where the user keeps it; WaveMint stores only its path.
  ipc.handle("auth-choose-cookies-file", async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "Choose a cookies.txt file",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "Cookie files", extensions: ["txt", "cookies"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    const inspection = inspectCookiesFile(filePath);
    if (!inspection.ok) throw taggedError("auth", inspection.message);
    updateAuth({ mode: "cookies_file", cookiesFilePath: filePath });
    return buildState();
  });

  // Turns authentication off and forgets every saved choice (browser,
  // profile, cookie file location, test result). Files are never touched.
  ipc.handle("auth-remove", async () => {
    updateAuth({ mode: "none", browser: "", browserProfile: "", cookiesFilePath: "", lastTest: null });
    clearAnalysisCache();
    return buildState();
  });

  // WaveMint never copies the user's file, so forgetting its location is the
  // whole cleanup.
  ipc.handle("auth-remove-cookies-file", async () => {
    const authSettings = getAuthSettings();
    updateAuth({
      cookiesFilePath: "",
      mode: authSettings.mode === "cookies_file" ? "none" : authSettings.mode,
      lastTest: authSettings.lastTest?.fingerprint?.startsWith("cookies_file|") ? null : authSettings.lastTest,
    });
    return buildState();
  });

  // Confirms the cookie source can be read and that YouTube accepts it as a
  // signed-in session, with one lightweight request (no media is
  // downloaded). Cookie values never leave the main process.
  async function probe(authSettings) {
    let authArgs;
    try {
      authArgs = buildYtDlpAuthArgs(authSettings);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return { status: "failed", sourceAccessible: false, code: error.code, message: error.message };
    }

    // WaveMint's runtime options are added by extraction.runTool. --verbose
    // adds cookie counts to stderr (never values); stderr is redacted and
    // only classified, not logged.
    const args = [...authArgs, "--flat-playlist", "--playlist-items", "1", "--dump-single-json", "--verbose", "--", AUTH_PROBE_URL];
    logger.log(`[auth] Testing authentication (${authSettings.mode})`);
    // Runs through the extraction manager so it counts as a running job.
    const result = await extraction.runTool("yt-dlp", args, { timeoutMs: TEST_TIMEOUT_MS });
    const stderr = redactSensitiveText(result.stderr);
    if (result.code !== 0 && isYouTubeRateLimitMessage(stderr)) {
      extraction.markRateLimited();
      return { status: "failed", sourceAccessible: true, code: "rate_limited", message: "YouTube has temporarily rate-limited requests. Try again later." };
    }
    // stdout holds the account's Watch Later data; only its id is read and
    // it is never logged.
    return interpretAuthProbe({ ...result, stdout: result.code === 0 ? result.stdout : "", stderr }, authSettings);
  }

  ipc.handle("auth-test", async () => {
    const authSettings = getAuthSettings();
    if (authSettings.mode === "none") throw new Error("Choose an authentication method to test");
    if (testInFlight) throw new Error("An authentication test is already running");
    if (extraction.isBusy()) throw new Error("Wait for the current analysis or extraction to finish before testing authentication");
    const waitMs = lastTestStartedAt + TEST_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) throw new Error(`Please wait ${Math.ceil(waitMs / 1000)} seconds before testing again`);
    extraction.assertAvailable();
    assertBundledToolsPresent();

    testInFlight = true;
    lastTestStartedAt = Date.now();
    try {
      const outcome = (authSettings.mode === "cookies_file" && localCookiesFileVerdict(authSettings)) || (await probe(authSettings));
      logger.log(`[auth] Test result: ${outcome.status} (${outcome.code})`);
      const testedAt = new Date().toISOString();
      updateAuth({ lastTest: { status: outcome.status, fingerprint: getAuthFingerprint(authSettings), code: outcome.code, message: outcome.message, testedAt } });
      return { ...outcome, testedAt, state: buildState() };
    } finally {
      testInFlight = false;
    }
  });
}

module.exports = { registerAuthHandlers };
