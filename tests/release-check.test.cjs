const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SENSITIVE_CONTENT_PATTERNS,
  SENSITIVE_NAME_PATTERNS,
} = require("../scripts/check-release.cjs");

function flaggedContent(text) {
  return SENSITIVE_CONTENT_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ reason }) => reason,
  );
}

function flaggedName(name) {
  return SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

test("the old hardcoded cookies path would fail the release check", () => {
  assert.deepEqual(flaggedContent('const YT_DLP_COOKIES_PATH = "D:\\\\yt-dlp\\\\cookies.txt";'), [
    "a hardcoded path to a cookies file",
  ]);
  assert.equal(flaggedContent("C:\\Users\\me\\Downloads\\youtube-cookies.txt").length, 1);
  assert.equal(flaggedContent("D:/exports/cookies.txt").length, 1);
});

test("cookie file contents and session values are detected", () => {
  assert.ok(flaggedContent("# Netscape HTTP Cookie File\n").length);
  assert.ok(
    flaggedContent(".youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\tf6=40000000\n").length,
  );
  assert.ok(flaggedContent("SAPISID=AbCdEfGhIjKlMnOpQrStUv/123").length);
});

test("ordinary UI text and URLs are not flagged", () => {
  assert.deepEqual(flaggedContent('"Choose cookies.txt…"'), []);
  assert.deepEqual(flaggedContent("https://example.com/help/cookies.txt"), []);
  assert.deepEqual(flaggedContent("--cookies-from-browser chrome"), []);
  assert.deepEqual(flaggedContent('const LOGIN_COOKIE = "LOGIN_INFO";'), []);
});

test("sensitive file names are detected", () => {
  for (const name of [
    "cookies.txt",
    "dist/youtube-cookies.txt",
    "resources\\bin\\cookie.json",
    "export.cookies",
    "Default\\Network\\Cookies",
    "Local State",
    ".env.production",
    "signing.pfx",
    "settings.json",
  ]) {
    assert.equal(flaggedName(name), true, name);
  }

  for (const name of [
    "licenses/yt-dlp-LICENSE.txt",
    "dist/assets/index-abc.js",
    "electron/auth.cjs",
    "versions.json",
  ]) {
    assert.equal(flaggedName(name), false, name);
  }
});
