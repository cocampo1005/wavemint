const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { createSettingsStore, sanitizeSettings } = require("../electron/settings.cjs");
const { makeTempDir } = require("./helpers.cjs");

const quietLogger = { warn() {} };

test("new installations default to no authentication", (t) => {
  const store = createSettingsStore(path.join(makeTempDir(t), "settings.json"));
  const settings = store.load();

  assert.equal(settings.auth.mode, "none");
  assert.equal(settings.auth.browser, "");
  assert.equal(settings.auth.cookiesFilePath, "");
  assert.equal(settings.auth.lastTest, null);
});

test("settings survive a restart", (t) => {
  const filePath = path.join(makeTempDir(t), "nested", "settings.json");
  const cookiesPath = path.resolve(makeTempDir(t), "cookies.txt");

  createSettingsStore(filePath).updateAuth({
    mode: "browser",
    browser: "firefox",
    browserProfile: "abc.default-release",
    cookiesFilePath: cookiesPath,
  });

  const reloaded = createSettingsStore(filePath).load();
  assert.equal(reloaded.auth.mode, "browser");
  assert.equal(reloaded.auth.browser, "firefox");
  assert.equal(reloaded.auth.browserProfile, "abc.default-release");
  // Switching methods keeps the other method's configuration.
  assert.equal(reloaded.auth.cookiesFilePath, cookiesPath);
});

test("corrupted settings fall back to defaults and are kept for inspection", (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, "settings.json");
  fs.writeFileSync(filePath, "{ this is not json");

  const settings = createSettingsStore(filePath, { logger: quietLogger }).load();

  assert.equal(settings.auth.mode, "none");
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith("settings.json.corrupt-")),
    true,
  );
});

test("invalid or unexpected values are discarded on load", () => {
  const settings = sanitizeSettings({
    auth: {
      mode: "steal-everything",
      browser: "safari",
      browserProfile: "../../etc",
      cookiesFilePath: "relative/cookies.txt",
      cookieValues: "SAPISID=secret",
      lastTest: { status: "authenticated", message: 42, extra: "x" },
    },
    somethingElse: true,
  });

  assert.deepEqual(Object.keys(settings), ["version", "auth", "engine"]);
  assert.equal(settings.auth.mode, "none");
  assert.equal(settings.auth.browser, "");
  assert.equal(settings.auth.browserProfile, "");
  assert.equal(settings.auth.cookiesFilePath, "");
  assert.equal("cookieValues" in settings.auth, false);
  assert.equal(settings.auth.lastTest.message, "");
  assert.equal("extra" in settings.auth.lastTest, false);
});

test("a profile is dropped when no valid browser is configured", () => {
  const settings = sanitizeSettings({
    auth: { mode: "browser", browser: "", browserProfile: "Default" },
  });

  assert.equal(settings.auth.browserProfile, "");
});

test("engine preferences default to stable with background checks", (t) => {
  const store = createSettingsStore(path.join(makeTempDir(t), "settings.json"));
  assert.deepEqual(store.load().engine, { channel: "stable", autoCheck: true });
});

test("engine preferences persist and invalid values are discarded", (t) => {
  const filePath = path.join(makeTempDir(t), "settings.json");
  createSettingsStore(filePath).updateEngine({ channel: "nightly", autoCheck: false });

  const reloaded = createSettingsStore(filePath).load();
  assert.deepEqual(reloaded.engine, { channel: "nightly", autoCheck: false });
  // Changing engine preferences never touches authentication.
  assert.equal(reloaded.auth.mode, "none");

  const sanitized = sanitizeSettings({ engine: { channel: "experimental", autoCheck: "yes" } });
  assert.deepEqual(sanitized.engine, { channel: "stable", autoCheck: true });
});
