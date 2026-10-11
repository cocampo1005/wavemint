const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const {
  AuthError,
  buildYtDlpAuthArgs,
  classifyAuthFailure,
  detectBrowsers,
  inspectCookiesFile,
  interpretAuthProbe,
  isSupportedBrowser,
  redactSensitiveText,
  sanitizeProfileValue,
  validateCustomProfileFolder,
} = require("../electron/auth.cjs");
const {
  FUTURE,
  PAST,
  cookieLine,
  makeFakeAppData,
  makeTempDir,
  writeFile,
} = require("./helpers.cjs");

const SECRET = "SECRETVALUE1234567890abcdef";

function makeChrome(env, profiles = ["Default", "Profile 1"]) {
  const userData = path.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data");
  const infoCache = {};
  for (const name of profiles) {
    writeFile(path.join(userData, name, "Network", "Cookies"), "sqlite");
    infoCache[name] = { name: name === "Default" ? "Personal" : "Work" };
  }
  writeFile(
    path.join(userData, "Local State"),
    JSON.stringify({
      os_crypt: { encrypted_key: "never-read" },
      profile: { info_cache: infoCache, last_used: "Profile 1" },
    }),
  );
  return userData;
}

function makeFirefox(env) {
  const root = path.join(env.APPDATA, "Mozilla", "Firefox");
  writeFile(path.join(root, "Profiles", "abc.default-release", "cookies.sqlite"), "db");
  fs.mkdirSync(path.join(root, "Profiles", "xyz.default"), { recursive: true });
  writeFile(
    path.join(root, "profiles.ini"),
    [
      "[Install308046B0AF4A39CB]",
      "Default=Profiles/abc.default-release",
      "",
      "[Profile1]",
      "Name=default",
      "IsRelative=1",
      "Path=Profiles/xyz.default",
      "",
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=Profiles/abc.default-release",
    ].join("\r\n"),
  );
  return root;
}

test("browser allowlist accepts only supported Windows browsers", () => {
  for (const id of ["chrome", "edge", "firefox", "brave", "opera", "vivaldi", "chromium", "whale"]) {
    assert.equal(isSupportedBrowser(id), true, id);
  }
  for (const id of ["safari", "Chrome", "chrome;calc", "", null, "chrome:Default", "../chrome"]) {
    assert.equal(isSupportedBrowser(id), false, String(id));
  }
});

test("profile values are restricted to names or absolute paths", () => {
  assert.equal(sanitizeProfileValue("Profile 1"), "Profile 1");
  assert.equal(sanitizeProfileValue("abc.default-release"), "abc.default-release");
  assert.equal(sanitizeProfileValue(""), "");
  assert.equal(sanitizeProfileValue(".."), "");
  assert.equal(sanitizeProfileValue("../Default"), "");
  assert.equal(sanitizeProfileValue("a::container"), "");
  assert.equal(sanitizeProfileValue("bad\nname"), "");
  assert.equal(sanitizeProfileValue(42), "");
  const absolute = path.resolve("some", "profile");
  assert.equal(sanitizeProfileValue(absolute), path.normalize(absolute));
});

test("no authentication produces no arguments", () => {
  assert.deepEqual(buildYtDlpAuthArgs({ mode: "none" }), []);
  assert.deepEqual(buildYtDlpAuthArgs({ mode: "unexpected" }), []);
  assert.deepEqual(buildYtDlpAuthArgs(undefined), []);
});

test("browser mode builds --cookies-from-browser arguments", (t) => {
  const { env } = makeFakeAppData(t);
  const userData = makeChrome(env);

  assert.deepEqual(buildYtDlpAuthArgs({ mode: "browser", browser: "chrome" }, { env }), [
    "--cookies-from-browser",
    "chrome",
  ]);
  assert.deepEqual(
    buildYtDlpAuthArgs({ mode: "browser", browser: "chrome", browserProfile: "Profile 1" }, { env }),
    ["--cookies-from-browser", "chrome:Profile 1"],
  );

  const customProfile = path.join(userData, "Profile 1");
  assert.deepEqual(
    buildYtDlpAuthArgs({ mode: "browser", browser: "chrome", browserProfile: customProfile }, { env }),
    ["--cookies-from-browser", `chrome:${customProfile}`],
  );
});

test("Opera ignores named profiles (yt-dlp does not support them)", (t) => {
  const { env } = makeFakeAppData(t);
  writeFile(path.join(env.APPDATA, "Opera Software", "Opera Stable", "Network", "Cookies"));

  assert.deepEqual(
    buildYtDlpAuthArgs({ mode: "browser", browser: "opera", browserProfile: "Default" }, { env }),
    ["--cookies-from-browser", "opera"],
  );
});

test("misconfigured browser mode fails loudly instead of dropping auth", (t) => {
  const { env } = makeFakeAppData(t);

  assert.throws(
    () => buildYtDlpAuthArgs({ mode: "browser", browser: "" }, { env }),
    (error) => error instanceof AuthError && error.code === "browser_not_selected",
  );
  assert.throws(
    () => buildYtDlpAuthArgs({ mode: "browser", browser: "safari" }, { env }),
    (error) => error instanceof AuthError && error.code === "browser_not_selected",
  );
  assert.throws(
    () => buildYtDlpAuthArgs({ mode: "browser", browser: "brave" }, { env }),
    (error) => error instanceof AuthError && error.code === "browser_not_found",
  );
  assert.throws(
    () =>
      buildYtDlpAuthArgs(
        { mode: "browser", browser: "chrome", browserProfile: path.join(env.LOCALAPPDATA, "missing") },
        { env },
      ),
    (error) => error instanceof AuthError && error.code === "profile_not_found",
  );
});

test("cookies file mode passes the file path and requires it to exist", (t) => {
  const dir = makeTempDir(t);
  const filePath = writeFile(path.join(dir, "my cookies & stuff.txt"), "# Netscape HTTP Cookie File\n");

  assert.deepEqual(buildYtDlpAuthArgs({ mode: "cookies_file", cookiesFilePath: filePath }), [
    "--cookies",
    filePath,
  ]);
  assert.throws(
    () => buildYtDlpAuthArgs({ mode: "cookies_file", cookiesFilePath: path.join(dir, "gone.txt") }),
    (error) => error.code === "cookies_file_missing" && /not found/.test(error.message),
  );
  assert.throws(
    () => buildYtDlpAuthArgs({ mode: "cookies_file", cookiesFilePath: "" }),
    (error) => error.code === "cookies_file_missing",
  );
});

test("cookie file inspection reports sign-in state without exposing values", (t) => {
  const dir = makeTempDir(t);
  const valid = writeFile(
    path.join(dir, "valid.txt"),
    [
      "\uFEFF# Netscape HTTP Cookie File",
      cookieLine(".youtube.com", "LOGIN_INFO", SECRET),
      `#HttpOnly_${cookieLine(".youtube.com", "__Secure-3PAPISID", SECRET)}`,
      cookieLine(".youtube.com", "PREF", "hl=en"),
      cookieLine(".google.com", "SID", SECRET),
      "",
    ].join("\n"),
  );

  const result = inspectCookiesFile(valid);
  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.equal(result.stats.cookieCount, 4);
  assert.equal(result.stats.youtubeCookieCount, 3);
  assert.equal(result.stats.hasSignInCookies, true);
  assert.ok(result.stats.signInExpiresAt);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("cookie file inspection detects missing, expired and invalid files", (t) => {
  const dir = makeTempDir(t);

  const noSignIn = writeFile(
    path.join(dir, "signed-out.txt"),
    `# Netscape HTTP Cookie File\n${cookieLine(".youtube.com", "PREF", "hl=en")}\n`,
  );
  assert.equal(inspectCookiesFile(noSignIn).code, "no_sign_in");

  const expired = writeFile(
    path.join(dir, "expired.txt"),
    [
      cookieLine(".youtube.com", "LOGIN_INFO", SECRET, PAST),
      cookieLine(".youtube.com", "SAPISID", SECRET, PAST),
    ].join("\n"),
  );
  assert.equal(inspectCookiesFile(expired).code, "expired");

  const sessionOnly = writeFile(
    path.join(dir, "session.txt"),
    [
      cookieLine(".youtube.com", "LOGIN_INFO", SECRET, 0),
      cookieLine(".youtube.com", "SAPISID", SECRET, FUTURE),
    ].join("\n"),
  );
  assert.equal(inspectCookiesFile(sessionOnly).code, "ok");

  const json = writeFile(path.join(dir, "cookies.json"), '[{"name":"SID","value":"x"}]');
  assert.equal(inspectCookiesFile(json).code, "cookies_file_json");
  assert.equal(inspectCookiesFile(json).ok, false);

  const garbage = writeFile(path.join(dir, "notes.txt"), "hello world\nnot cookies\n");
  assert.equal(inspectCookiesFile(garbage).code, "cookies_file_invalid");

  const empty = writeFile(path.join(dir, "empty.txt"), "");
  assert.equal(inspectCookiesFile(empty).code, "cookies_file_invalid");

  assert.equal(inspectCookiesFile(path.join(dir, "missing.txt")).code, "cookies_file_missing");
  assert.equal(inspectCookiesFile(dir).code, "cookies_file_invalid");
});

test("redaction strips cookie lines, headers and session values", () => {
  const output = [
    "WARNING: skipping cookie file entry due to invalid length 3: '.youtube.com\\tTRUE\\tSID'",
    `.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\t${SECRET}`,
    `[debug] Cookie: SAPISID=${SECRET}; PREF=hl=en`,
    `Authorization: SAPISIDHASH ${SECRET}`,
    `found __Secure-3PSID=${SECRET} in jar`,
    "ERROR: [youtube] abc: Video unavailable",
  ].join("\n");

  const redacted = redactSensitiveText(output);
  assert.equal(redacted.includes(SECRET), false);
  assert.match(redacted, /ERROR: \[youtube\] abc: Video unavailable/);
  assert.match(redacted, /skipped an invalid cookie file entry/);
});

test("authentication failures map to actionable messages", () => {
  const chrome = { mode: "browser", browser: "chrome" };
  const edge = { mode: "browser", browser: "edge" };
  const file = { mode: "cookies_file", cookiesFilePath: "C:\\x.txt" };

  const locked = classifyAuthFailure(
    "ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info",
    edge,
  );
  assert.equal(locked.code, "browser_locked");
  assert.equal(locked.stage, "source");
  assert.match(locked.message, /^Edge cookies could not be accessed/);
  assert.match(locked.message, /Close Edge/);

  const encrypted = classifyAuthFailure("ERROR: Failed to decrypt with DPAPI. See ...", chrome);
  assert.equal(encrypted.code, "browser_encrypted");
  assert.match(encrypted.message, /cookies\.txt/);

  assert.equal(
    classifyAuthFailure('could not find chrome cookies database in "C:\\x"', chrome).code,
    "profile_not_found",
  );
  assert.equal(
    classifyAuthFailure("Cookies file must be Netscape formatted, not JSON", file).code,
    "cookies_file_json",
  );
  assert.equal(
    classifyAuthFailure("http.cookiejar.LoadError: invalid length 3", file).code,
    "cookies_file_invalid",
  );

  const rejected = classifyAuthFailure(
    "WARNING: [youtube] The provided YouTube account cookies are no longer valid.",
    file,
  );
  assert.equal(rejected.code, "session_rejected");
  assert.equal(rejected.stage, "session");
  assert.match(rejected.message, /YouTube rejected the selected authentication session/);

  assert.equal(
    classifyAuthFailure("FileNotFoundError: [Errno 2] No such file or directory: 'C:\\x.txt'", file).code,
    "cookies_file_missing",
  );
  // Unrelated missing files (e.g. a temp file) are not blamed on cookies.
  assert.equal(
    classifyAuthFailure(
      "ERROR: Postprocessing: [Errno 2] No such file or directory: 'C:\\out\\wavemint-temp.webm' (cookies loaded)",
      file,
    ),
    null,
  );

  assert.equal(classifyAuthFailure("ERROR: Video unavailable", chrome), null);
  assert.equal(classifyAuthFailure("Could not copy Chrome cookie database", { mode: "none" }), null);
});

test("authentication probe distinguishes source access from a signed-in session", () => {
  const firefox = { mode: "browser", browser: "firefox" };

  assert.equal(
    interpretAuthProbe({ code: 0, stdout: JSON.stringify({ _type: "playlist", id: "WL" }), stderr: "" }, firefox)
      .status,
    "authenticated",
  );

  const signedOut = interpretAuthProbe(
    { code: 1, stdout: "", stderr: "ERROR: [youtube:tab] WL: YouTube said: The playlist does not exist." },
    firefox,
  );
  assert.equal(signedOut.status, "not_signed_in");
  assert.equal(signedOut.sourceAccessible, true);

  const rejected = interpretAuthProbe(
    {
      code: 1,
      stdout: "",
      stderr:
        "WARNING: [youtube:tab] The provided YouTube account cookies are no longer valid.\nERROR: [youtube:tab] WL: YouTube said: The playlist does not exist.",
    },
    firefox,
  );
  assert.equal(rejected.code, "session_rejected");
  assert.equal(rejected.status, "not_signed_in");

  const blocked = interpretAuthProbe(
    { code: 1, stdout: "", stderr: "ERROR: Failed to decrypt with DPAPI." },
    { mode: "browser", browser: "chrome" },
  );
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.sourceAccessible, false);

  assert.equal(interpretAuthProbe({ timedOut: true }, firefox).code, "timeout");

  const empty = interpretAuthProbe(
    {
      code: 1,
      stdout: "",
      stderr:
        "Extracted 0 cookies from chrome\nERROR: [youtube:tab] WL: YouTube said: The playlist does not exist.",
    },
    { mode: "browser", browser: "chrome" },
  );
  assert.equal(empty.code, "profile_empty");
  assert.match(empty.message, /doesn't contain any cookies/);
});

test("browser detection finds profiles without reading cookies", (t) => {
  const { env } = makeFakeAppData(t);
  makeChrome(env);
  const firefoxRoot = makeFirefox(env);

  const browsers = detectBrowsers(env);
  const chrome = browsers.find((item) => item.id === "chrome");
  const firefox = browsers.find((item) => item.id === "firefox");
  const brave = browsers.find((item) => item.id === "brave");

  assert.equal(chrome.status, "available");
  assert.deepEqual(
    chrome.profiles.map((item) => [item.value, item.label, item.isDefault]),
    [
      ["Default", "Personal (Default)", false],
      ["Profile 1", "Work (Profile 1)", true],
    ],
  );
  assert.equal(JSON.stringify(chrome).includes("never-read"), false);

  assert.equal(firefox.status, "available");
  const defaultRelease = firefox.profiles.find((item) => item.label === "default-release");
  assert.equal(defaultRelease.value, path.join(firefoxRoot, "Profiles", "abc.default-release"));
  assert.equal(defaultRelease.isDefault, true);
  assert.equal(defaultRelease.hasCookies, true);
  assert.equal(firefox.profiles.find((item) => item.label === "default").hasCookies, false);

  assert.equal(brave.status, "not_found");
});

test("custom profile folders are validated per browser engine", (t) => {
  const { env } = makeFakeAppData(t);
  const userData = makeChrome(env);
  const firefoxRoot = makeFirefox(env);

  assert.equal(
    validateCustomProfileFolder("chrome", path.join(userData, "Profile 1")),
    path.join(userData, "Profile 1"),
  );
  assert.throws(() => validateCustomProfileFolder("chrome", userData), /isn't a Google Chrome profile/);
  assert.throws(
    () => validateCustomProfileFolder("firefox", path.join(firefoxRoot, "Profiles", "xyz.default")),
    /isn't a Firefox profile/,
  );
  assert.throws(() => validateCustomProfileFolder("chrome", "relative\\path"), /could not be accessed/);
  assert.throws(() => validateCustomProfileFolder("safari", userData), /supported browser/);
});
