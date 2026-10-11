// Persistent user settings stored as JSON in Electron's per-user data
// directory (never the install folder). Only configuration lives here: the
// authentication mode, the chosen browser/profile, the *path* of a
// user-selected cookies file, and extraction-engine update preferences.
// Cookie values are never written to settings.

const fs = require("fs");
const path = require("path");
const { AUTH_MODES, isSupportedBrowser, sanitizeProfileValue } = require("./auth.cjs");

const SETTINGS_VERSION = 1;
const MAX_MESSAGE_LENGTH = 400;
const ENGINE_CHANNELS = ["stable", "nightly"];

function createDefaultSettings() {
  return {
    version: SETTINGS_VERSION,
    auth: {
      mode: "none",
      browser: "",
      browserProfile: "",
      cookiesFilePath: "",
      lastTest: null,
    },
    engine: {
      // "nightly" is opt-in only; WaveMint never switches channels by itself.
      channel: "stable",
      // A lightweight background check (at most daily, after startup).
      autoCheck: true,
    },
  };
}

function cleanString(value, maxLength = 1024) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function sanitizeLastTest(value) {
  if (!value || typeof value !== "object") return null;

  const status = ["authenticated", "not_signed_in", "failed"].includes(value.status)
    ? value.status
    : null;
  if (!status) return null;

  return {
    status,
    fingerprint: cleanString(value.fingerprint, 2048),
    code: cleanString(value.code, 64),
    message: cleanString(value.message, MAX_MESSAGE_LENGTH),
    testedAt: cleanString(value.testedAt, 64),
  };
}

// Accepts anything (including corrupted or hand-edited JSON) and returns a
// fully valid settings object, falling back to defaults field by field.
function sanitizeSettings(raw) {
  const defaults = createDefaultSettings();
  const auth = raw && typeof raw === "object" ? raw.auth || {} : {};
  const engine = raw && typeof raw === "object" ? raw.engine || {} : {};

  const mode = AUTH_MODES.includes(auth.mode) ? auth.mode : defaults.auth.mode;
  const browser = isSupportedBrowser(auth.browser) ? auth.browser : "";
  const cookiesFilePath = cleanString(auth.cookiesFilePath);

  return {
    version: SETTINGS_VERSION,
    auth: {
      mode,
      browser,
      browserProfile: browser ? sanitizeProfileValue(auth.browserProfile) : "",
      cookiesFilePath:
        cookiesFilePath && path.isAbsolute(cookiesFilePath) ? cookiesFilePath : "",
      lastTest: sanitizeLastTest(auth.lastTest),
    },
    engine: {
      channel: ENGINE_CHANNELS.includes(engine.channel) ? engine.channel : defaults.engine.channel,
      autoCheck: typeof engine.autoCheck === "boolean" ? engine.autoCheck : defaults.engine.autoCheck,
    },
  };
}

function createSettingsStore(filePath, { logger = console } = {}) {
  let current = null;

  function load() {
    let raw = null;

    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Keep the unreadable file for troubleshooting instead of silently
        // overwriting it, then continue with defaults.
        const backupPath = `${filePath}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(filePath, backupPath);
          logger.warn(`[settings] Settings were unreadable; moved to ${backupPath}`);
        } catch {
          logger.warn("[settings] Settings were unreadable; using defaults");
        }
      }
    }

    current = sanitizeSettings(raw);
    return current;
  }

  function get() {
    return current || load();
  }

  function save(next) {
    const sanitized = sanitizeSettings(next);
    const tempPath = `${filePath}.${process.pid}.tmp`;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);

    current = sanitized;
    return current;
  }

  function updateAuth(patch) {
    const settings = get();
    return save({ ...settings, auth: { ...settings.auth, ...patch } });
  }

  function updateEngine(patch) {
    const settings = get();
    return save({ ...settings, engine: { ...settings.engine, ...patch } });
  }

  return { filePath, load, get, save, updateAuth, updateEngine };
}

module.exports = {
  ENGINE_CHANNELS,
  SETTINGS_VERSION,
  createDefaultSettings,
  createSettingsStore,
  sanitizeSettings,
};
