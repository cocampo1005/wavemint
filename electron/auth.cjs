// YouTube authentication for yt-dlp: browser allowlist + discovery, cookies
// file validation, safe argument construction, and error classification.
//
// Security notes:
// - WaveMint never decrypts or reads browser cookie databases itself. In
//   browser mode it only checks that profile folders exist and reads profile
//   *names* (Chromium "Local State" profile list, Firefox profiles.ini); the
//   actual cookie extraction is done by yt-dlp's --cookies-from-browser.
// - Cookie files are read locally to validate their format. Only counts,
//   cookie *names* and expiry times are inspected; values are never returned,
//   logged, or sent to the renderer.
// - Browser mode and file mode are never combined, so yt-dlp never dumps
//   browser cookies into a file.

const fs = require("fs");
const path = require("path");

const AUTH_MODES = ["none", "browser", "cookies_file"];

const BROWSERS = [
  {
    id: "chrome",
    label: "Google Chrome",
    engine: "chromium",
    base: "LOCALAPPDATA",
    relative: ["Google", "Chrome", "User Data"],
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    engine: "chromium",
    base: "LOCALAPPDATA",
    relative: ["Microsoft", "Edge", "User Data"],
  },
  { id: "firefox", label: "Mozilla Firefox", engine: "firefox" },
  {
    id: "brave",
    label: "Brave",
    engine: "chromium",
    base: "LOCALAPPDATA",
    relative: ["BraveSoftware", "Brave-Browser", "User Data"],
  },
  {
    id: "opera",
    label: "Opera",
    engine: "chromium",
    base: "APPDATA",
    relative: ["Opera Software", "Opera Stable"],
    // yt-dlp does not support named profiles for Opera; only the default
    // location or an explicit folder path.
    supportsProfiles: false,
  },
  {
    id: "vivaldi",
    label: "Vivaldi",
    engine: "chromium",
    base: "LOCALAPPDATA",
    relative: ["Vivaldi", "User Data"],
  },
  {
    id: "chromium",
    label: "Chromium",
    engine: "chromium",
    base: "LOCALAPPDATA",
    relative: ["Chromium", "User Data"],
  },
  {
    id: "whale",
    label: "Naver Whale",
    engine: "chromium",
    base: "LOCALAPPDATA",
    relative: ["Naver", "Naver Whale", "User Data"],
  },
];

const BROWSER_IDS = new Set(BROWSERS.map((browser) => browser.id));

// Mirrors yt-dlp's YouTube login check: LOGIN_INFO plus one SAPISID variant.
const YOUTUBE_LOGIN_COOKIE = "LOGIN_INFO";
const YOUTUBE_SAPISID_COOKIES = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"];

const MAX_COOKIES_FILE_BYTES = 5 * 1024 * 1024;

// Signed-out sessions cannot open the Watch Later list, so a single flat
// request for its first entry confirms a real signed-in session without
// downloading anything.
const AUTH_PROBE_URL = "https://www.youtube.com/playlist?list=WL";

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

function getBrowser(id) {
  return BROWSERS.find((browser) => browser.id === id) || null;
}

function isSupportedBrowser(id) {
  return typeof id === "string" && BROWSER_IDS.has(id);
}

function getBrowserLabel(id) {
  return getBrowser(id)?.label || "The browser";
}

function getShortBrowserLabel(id) {
  const label = getBrowserLabel(id);
  return label.replace(/^(Google|Microsoft|Mozilla|Naver)\s+/, "");
}

// A profile is either "" (yt-dlp's default: the most recently used profile),
// a profile folder name such as "Default" or "Profile 1", or an absolute
// folder path chosen by the user.
function sanitizeProfileValue(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024 || trimmed.includes("::")) return "";

  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }

  // eslint-disable-next-line no-control-regex -- rejects control characters
  if (/^[^\\/:*?"<>|\x00-\x1F]{1,255}$/.test(trimmed) && !/^\.+$/.test(trimmed)) {
    return trimmed;
  }

  return "";
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function getChromiumUserDataDir(browser, env = process.env) {
  const base = env[browser.base];
  return base ? path.join(base, ...browser.relative) : "";
}

function getFirefoxRoots(env = process.env) {
  return [
    env.APPDATA && path.join(env.APPDATA, "Mozilla", "Firefox"),
    env.LOCALAPPDATA &&
      path.join(
        env.LOCALAPPDATA,
        "Packages",
        "Mozilla.Firefox_n80bbvh6b1yt2",
        "LocalCache",
        "Roaming",
        "Mozilla",
        "Firefox",
      ),
  ].filter(Boolean);
}

function chromiumFolderHasCookies(folder) {
  return (
    exists(path.join(folder, "Network", "Cookies")) ||
    exists(path.join(folder, "Cookies"))
  );
}

function compareChromiumProfileNames(left, right) {
  const rank = (name) => {
    if (name === "Default") return -1;
    const match = /^Profile (\d+)$/.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };

  return rank(left) - rank(right) || left.localeCompare(right);
}

function discoverChromiumProfiles(browser, userDataDir) {
  if (browser.supportsProfiles === false) {
    const hasCookies =
      chromiumFolderHasCookies(userDataDir) ||
      chromiumFolderHasCookies(path.join(userDataDir, "Default"));
    return hasCookies ? [] : null;
  }

  // Local State also holds the browser's encrypted cookie key; only the
  // profile list is used here and nothing else from the file is kept.
  let infoCache = {};
  let lastUsed = "";
  try {
    const localState = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "Local State"), "utf8"),
    );
    infoCache = localState?.profile?.info_cache || {};
    lastUsed = String(localState?.profile?.last_used || "");
  } catch {
    // Fall back to scanning folder names below.
  }

  const names = new Set(Object.keys(infoCache));
  try {
    for (const entry of fs.readdirSync(userDataDir)) {
      if (/^(Default|Profile \d+)$/.test(entry)) names.add(entry);
    }
  } catch {
    // Unreadable directory: return what Local State listed.
  }

  return [...names]
    .filter((name) => sanitizeProfileValue(name) === name)
    .sort(compareChromiumProfileNames)
    .map((name) => {
      const displayName = String(infoCache[name]?.name || "").slice(0, 120);
      return {
        value: name,
        label: displayName && displayName !== name ? `${displayName} (${name})` : name,
        hasCookies: chromiumFolderHasCookies(path.join(userDataDir, name)),
        isDefault: name === (lastUsed || "Default"),
      };
    });
}

function parseIni(text) {
  const sections = [];
  let current = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = { name: header[1], values: {} };
      sections.push(current);
      continue;
    }

    const separator = line.indexOf("=");
    if (current && separator > 0) {
      current.values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }

  return sections;
}

function discoverFirefoxProfiles(env = process.env) {
  const profiles = [];
  let foundRoot = false;

  for (const root of getFirefoxRoots(env)) {
    let sections;
    try {
      sections = parseIni(fs.readFileSync(path.join(root, "profiles.ini"), "utf8"));
      foundRoot = true;
    } catch {
      if (isDirectory(path.join(root, "Profiles"))) foundRoot = true;
      continue;
    }

    const installDefaults = new Set(
      sections
        .filter((section) => section.name.startsWith("Install") && section.values.Default)
        .map((section) => path.normalize(path.join(root, section.values.Default))),
    );

    for (const section of sections) {
      if (!section.name.startsWith("Profile") || !section.values.Path) continue;

      const folder =
        section.values.IsRelative === "0"
          ? path.normalize(section.values.Path)
          : path.normalize(path.join(root, section.values.Path));

      profiles.push({
        value: folder,
        label: String(section.values.Name || path.basename(folder)).slice(0, 120),
        hasCookies: exists(path.join(folder, "cookies.sqlite")),
        isDefault:
          installDefaults.has(folder) ||
          (!installDefaults.size && section.values.Default === "1"),
      });
    }
  }

  return foundRoot ? profiles : null;
}

/**
 * Lists the supported browsers with what WaveMint can see of them locally.
 * status: "available" (cookie store found), "no_cookies" (browser data
 * found but no cookie store yet), or "not_found".
 */
function detectBrowsers(env = process.env) {
  return BROWSERS.map((browser) => {
    let profiles = null;
    let dataDir = "";

    if (browser.engine === "firefox") {
      profiles = discoverFirefoxProfiles(env);
    } else {
      dataDir = getChromiumUserDataDir(browser, env);
      if (dataDir && isDirectory(dataDir)) {
        profiles = discoverChromiumProfiles(browser, dataDir);
        if (profiles === null) profiles = [];
      }
    }

    let status = "not_found";
    if (profiles !== null) {
      const hasCookieStore =
        browser.supportsProfiles === false
          ? chromiumFolderHasCookies(dataDir) ||
            chromiumFolderHasCookies(path.join(dataDir, "Default"))
          : profiles.some((profile) => profile.hasCookies);
      status = hasCookieStore ? "available" : "no_cookies";
    }

    return {
      id: browser.id,
      label: browser.label,
      engine: browser.engine,
      supportsProfiles: browser.supportsProfiles !== false,
      status,
      profiles: profiles || [],
    };
  });
}

/**
 * Validates a folder the user picked manually as a browser profile.
 * Returns the normalized folder path or throws an AuthError.
 */
function validateCustomProfileFolder(browserId, folder) {
  const browser = getBrowser(browserId);
  if (!browser) {
    throw new AuthError("browser_not_supported", "Choose a supported browser first.");
  }

  const normalized = sanitizeProfileValue(folder);
  if (!normalized || !path.isAbsolute(normalized) || !isDirectory(normalized)) {
    throw new AuthError("profile_not_found", "This browser profile could not be accessed.");
  }

  if (browser.engine === "firefox") {
    if (!exists(path.join(normalized, "cookies.sqlite"))) {
      throw new AuthError(
        "profile_invalid",
        "This folder isn't a Firefox profile. Choose the profile folder that contains cookies.sqlite.",
      );
    }
    return normalized;
  }

  if (browser.supportsProfiles === false) {
    if (
      !chromiumFolderHasCookies(normalized) &&
      !chromiumFolderHasCookies(path.join(normalized, "Default"))
    ) {
      throw new AuthError(
        "profile_invalid",
        `This folder doesn't contain ${browser.label} cookies. Choose the browser's data folder.`,
      );
    }
    return normalized;
  }

  if (!chromiumFolderHasCookies(normalized)) {
    throw new AuthError(
      "profile_invalid",
      `This folder isn't a ${browser.label} profile. Choose a profile folder such as "…\\User Data\\Profile 1".`,
    );
  }

  if (!exists(path.join(path.dirname(normalized), "Local State"))) {
    throw new AuthError(
      "profile_invalid",
      `This profile's parent folder is missing ${browser.label}'s "Local State" file, which is needed to read its cookies.`,
    );
  }

  return normalized;
}

/**
 * Builds the yt-dlp authentication arguments for the saved settings. Throws
 * an AuthError when the configuration cannot be used, rather than silently
 * continuing without authentication.
 */
function buildYtDlpAuthArgs(auth, { env = process.env } = {}) {
  const mode = AUTH_MODES.includes(auth?.mode) ? auth.mode : "none";

  if (mode === "none") return [];

  if (mode === "browser") {
    const browser = getBrowser(auth.browser);
    if (!browser) {
      throw new AuthError(
        "browser_not_selected",
        "No browser is selected for YouTube authentication. Choose one in Settings, or turn authentication off.",
      );
    }

    const profile = sanitizeProfileValue(auth.browserProfile);
    if (profile && path.isAbsolute(profile) && !isDirectory(profile)) {
      throw new AuthError(
        "profile_not_found",
        "This browser profile could not be accessed. Choose the profile again in Settings.",
      );
    }

    if (!profile) {
      const installed =
        browser.engine === "firefox"
          ? discoverFirefoxProfiles(env) !== null
          : isDirectory(getChromiumUserDataDir(browser, env));
      if (!installed) {
        throw new AuthError(
          "browser_not_found",
          `${browser.label} doesn't appear to be installed for this Windows user. Choose a different browser in Settings or import a cookies.txt file.`,
        );
      }
    }

    // Opera only accepts the default location or an explicit folder path.
    const useProfile =
      profile && (browser.supportsProfiles !== false || path.isAbsolute(profile));
    return ["--cookies-from-browser", useProfile ? `${browser.id}:${profile}` : browser.id];
  }

  const filePath = typeof auth.cookiesFilePath === "string" ? auth.cookiesFilePath : "";
  if (!filePath) {
    throw new AuthError(
      "cookies_file_missing",
      "No cookie file is selected. Choose one in Settings, or turn authentication off.",
    );
  }

  if (!exists(filePath)) {
    throw new AuthError(
      "cookies_file_missing",
      "The selected cookie file was not found. Choose it again in Settings, or turn authentication off.",
    );
  }

  return ["--cookies", filePath];
}

/**
 * Validates a Netscape/Mozilla cookies.txt file locally (the format yt-dlp
 * reads) without exposing any cookie values.
 */
function inspectCookiesFile(filePath, { now = Date.now() } = {}) {
  const failure = (code, message) => ({ ok: false, code, message });

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return failure("cookies_file_missing", "The selected cookie file was not found.");
  }

  if (!stat.isFile()) {
    return failure("cookies_file_invalid", "The selected item is not a file.");
  }

  if (stat.size === 0) {
    return failure("cookies_file_invalid", "The selected cookie file is empty.");
  }

  if (stat.size > MAX_COOKIES_FILE_BYTES) {
    return failure(
      "cookies_file_invalid",
      "The selected file is too large to be a cookies.txt export.",
    );
  }

  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte-order mark
  } catch {
    return failure(
      "cookies_file_unreadable",
      "WaveMint doesn't have permission to read the selected cookie file.",
    );
  }

  const firstCharacter = text.trimStart()[0];
  if (firstCharacter === "[" || firstCharacter === "{") {
    return failure(
      "cookies_file_json",
      "The cookie file format is invalid. This file is JSON; export cookies in Netscape \"cookies.txt\" format instead.",
    );
  }

  let cookieCount = 0;
  let skippedLines = 0;
  let youtubeCookieCount = 0;
  const signInExpiry = new Map();

  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    if (!line.trim() || line.startsWith("#")) continue;

    const fields = line.split("\t");
    if (fields.length !== 7 || (fields[4] && !/^\d+(?:\.\d+)?$/.test(fields[4]))) {
      skippedLines += 1;
      continue;
    }

    cookieCount += 1;
    const domain = fields[0].trim().toLowerCase().replace(/^\./, "");
    if (domain !== "youtube.com" && !domain.endsWith(".youtube.com")) continue;

    youtubeCookieCount += 1;
    const name = fields[5];
    if (name === YOUTUBE_LOGIN_COOKIE || YOUTUBE_SAPISID_COOKIES.includes(name)) {
      const expires = Number(fields[4]) || 0; // 0 = session cookie
      const previous = signInExpiry.get(name);
      signInExpiry.set(name, previous === undefined ? expires : Math.max(previous, expires));
    }
  }

  if (cookieCount === 0) {
    return failure(
      "cookies_file_invalid",
      "The cookie file format is invalid. Export cookies in Netscape \"cookies.txt\" format.",
    );
  }

  const sapisidExpiries = YOUTUBE_SAPISID_COOKIES.filter((name) =>
    signInExpiry.has(name),
  ).map((name) => signInExpiry.get(name));
  const hasSignInCookies = signInExpiry.has(YOUTUBE_LOGIN_COOKIE) && sapisidExpiries.length > 0;

  const isExpired = (expires) => expires > 0 && expires * 1000 < now;
  const signInExpired =
    hasSignInCookies &&
    (isExpired(signInExpiry.get(YOUTUBE_LOGIN_COOKIE)) || sapisidExpiries.every(isExpired));

  const persistentExpiries = hasSignInCookies
    ? [signInExpiry.get(YOUTUBE_LOGIN_COOKIE), Math.max(...sapisidExpiries)].filter(
        (value) => value > 0,
      )
    : [];

  return {
    ok: true,
    code: !hasSignInCookies ? "no_sign_in" : signInExpired ? "expired" : "ok",
    stats: {
      cookieCount,
      youtubeCookieCount,
      skippedLines,
      hasSignInCookies,
      signInExpiresAt: persistentExpiries.length
        ? new Date(Math.min(...persistentExpiries) * 1000).toISOString()
        : null,
    },
  };
}

// Removes anything that could carry cookie values from tool output before it
// is logged or shown. yt-dlp echoes malformed cookie-file lines verbatim in
// its "skipping cookie file entry" warning, for example.
function redactSensitiveText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      if (/skipping cookie file entry/i.test(line)) {
        return "WARNING: skipped an invalid cookie file entry [details redacted]";
      }

      if ((line.match(/\t/g) || []).length >= 5) {
        return "[redacted]";
      }

      return line
        .replace(/\b((?:set-)?cookie|authorization)\b(\s*[:=]\s*).+$/gi, "$1$2[redacted]")
        .replace(
          /\b(LOGIN_INFO|SAPISID|APISID|HSID|SSID|SID|SIDCC|__Secure-[\w-]+|__Host-[\w-]+)=([^;\s'"]+)/g,
          "$1=[redacted]",
        );
    })
    .join("\n");
}

/**
 * Maps yt-dlp output to an actionable authentication problem, or null when
 * the failure is unrelated to authentication.
 * stage "source": the cookies could not be loaded at all.
 * stage "session": cookies loaded, but YouTube did not accept the session.
 */
function classifyAuthFailure(text, auth) {
  const output = String(text || "");
  const mode = auth?.mode;
  if (mode !== "browser" && mode !== "cookies_file") return null;

  const label = getShortBrowserLabel(auth.browser);
  const source = (code, message) => ({ code, stage: "source", message });

  if (mode === "browser") {
    if (/Could not copy Chrome cookie database/i.test(output)) {
      return source(
        "browser_locked",
        `${label} cookies could not be accessed because ${label} is using them. Close ${label} completely (including any background windows) and try again, or import a cookies.txt file.`,
      );
    }

    if (/Failed to decrypt with DPAPI/i.test(output)) {
      return source(
        "browser_encrypted",
        `${label} cookies could not be accessed. ${label} protects its cookies with app-bound encryption, so other apps can't read them directly. Import a cookies.txt file instead.`,
      );
    }

    if (
      /cannot decrypt v1[01] cookies|failed to decrypt cookie|could not find local state file|no encrypted key in Local State/i.test(
        output,
      )
    ) {
      return source(
        "browser_unreadable",
        `${label} cookies could not be decrypted. Try closing ${label}, or import a cookies.txt file.`,
      );
    }

    if (/could not find \S+ cookies database|could not find firefox container/i.test(output)) {
      return source(
        "profile_not_found",
        `This browser profile could not be accessed. Make sure ${label} has been opened at least once with this profile, or choose a different profile.`,
      );
    }

    if (/failed to load cookies|invalid cookies from browser arguments/i.test(output)) {
      return source(
        "browser_unreadable",
        `${label} cookies could not be accessed. Try closing ${label} or importing a cookies.txt file.`,
      );
    }
  } else {
    if (/Cookies file must be Netscape formatted, not JSON/i.test(output)) {
      return source(
        "cookies_file_json",
        "The cookie file format is invalid. Export cookies in Netscape \"cookies.txt\" format, not JSON.",
      );
    }

    const fileName = path.basename(String(auth.cookiesFilePath || ""));
    if (fileName && /No such file or directory/i.test(output) && output.includes(fileName)) {
      return source("cookies_file_missing", "The selected cookie file was not found.");
    }

    if (
      /does not look like a Netscape format cookies file|invalid length \d+|invalid expires at|failed to load cookies/i.test(
        output,
      )
    ) {
      return source("cookies_file_invalid", "The cookie file format is invalid.");
    }
  }

  if (/cookies are no longer valid/i.test(output)) {
    return {
      code: "session_rejected",
      stage: "session",
      message:
        mode === "browser"
          ? `YouTube rejected the selected authentication session. Your cookies may have expired. Sign in to YouTube again in ${label}, then retry.`
          : "YouTube rejected the selected authentication session. Your cookies may have expired. Export a fresh cookies.txt while signed in to YouTube.",
    };
  }

  return null;
}

/**
 * Interprets the Watch Later probe run by the "Test Authentication" button.
 * Returns { status, sourceAccessible, code, message }.
 */
function interpretAuthProbe({ code, stdout, stderr, timedOut }, auth) {
  const label = getShortBrowserLabel(auth.browser);
  const sourceName = auth.mode === "browser" ? `${label} cookies` : "the cookie file";

  if (timedOut) {
    return {
      status: "failed",
      sourceAccessible: false,
      code: "timeout",
      message: "The authentication test took too long and was stopped. Check your connection and try again.",
    };
  }

  const output = `${stderr || ""}\n${code === 0 ? "" : stdout || ""}`;
  const problem = classifyAuthFailure(output, auth);

  if (problem?.stage === "source") {
    return { status: "failed", sourceAccessible: false, code: problem.code, message: problem.message };
  }

  if (problem?.stage === "session") {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: problem.code,
      message: problem.message,
    };
  }

  if (code === 0) {
    try {
      const info = JSON.parse(stdout);
      if (info?.id === "WL" || info?._type === "playlist") {
        return {
          status: "authenticated",
          sourceAccessible: true,
          code: "ok",
          message: `YouTube accepted the signed-in session from ${sourceName}.`,
        };
      }
    } catch {
      // Fall through to the generic failure below.
    }
  }

  // Printed by yt-dlp's --verbose output; counts only, never values.
  const extracted = /Extracted (\d+) cookies from \S+/i.exec(output);
  if (auth.mode === "browser" && extracted && Number(extracted[1]) === 0) {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: "profile_empty",
      message: `WaveMint opened this ${label} profile, but it doesn't contain any cookies. Choose the profile you use for YouTube.`,
    };
  }

  if (/playlist does not exist|Login details are needed|requires authentication/i.test(output)) {
    return {
      status: "not_signed_in",
      sourceAccessible: true,
      code: "not_signed_in",
      message:
        auth.mode === "browser"
          ? `WaveMint read ${label} cookies, but YouTube didn't see a signed-in account. Sign in to YouTube in ${label}, or choose the profile you use for YouTube.`
          : "WaveMint read the cookie file, but YouTube didn't see a signed-in account. Export cookies again while signed in to YouTube.",
    };
  }

  return {
    status: "failed",
    sourceAccessible: code === 0,
    code: "unknown",
    message: "The authentication test could not be completed. Check your connection and try again.",
  };
}

function getAuthFingerprint(auth) {
  if (!auth || auth.mode === "none") return "none";
  if (auth.mode === "browser") return `browser|${auth.browser}|${auth.browserProfile || ""}`;
  return `cookies_file|${auth.cookiesFilePath || ""}`;
}

module.exports = {
  AUTH_MODES,
  AUTH_PROBE_URL,
  AuthError,
  BROWSERS,
  buildYtDlpAuthArgs,
  classifyAuthFailure,
  detectBrowsers,
  getAuthFingerprint,
  getBrowser,
  getBrowserLabel,
  getShortBrowserLabel,
  inspectCookiesFile,
  interpretAuthProbe,
  isSupportedBrowser,
  parseIni,
  redactSensitiveText,
  sanitizeProfileValue,
  validateCustomProfileFolder,
};
