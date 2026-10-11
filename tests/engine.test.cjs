const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const {
  EngineUpdateError,
  YT_DLP_SIGNING_KEY_FINGERPRINT,
  assertAllowedUrl,
  compareVersions,
  createEngineStore,
  createEngineUpdater,
  fetchAllowed,
  isValidVersion,
  parseChecksums,
  parseVerboseHeader,
} = require("../electron/engine.cjs");
const { createBinaryResolver } = require("../electron/binaries.cjs");
const { SignatureError, parsePublicKey, verifyDetachedSignature } = require("../electron/pgp.cjs");
const { makeTempDir, writeFile } = require("./helpers.cjs");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures", "yt-dlp-release");
const SUMS = fs.readFileSync(path.join(FIXTURES, "SHA2-256SUMS"));
const SIGNATURE = fs.readFileSync(path.join(FIXTURES, "SHA2-256SUMS.sig"));
const SIGNING_KEY = fs.readFileSync(path.join(ROOT, "electron", "trust", "yt-dlp-signing-key.asc"), "utf8");
const RELEASE = "2026.08.19";
const RELEASE_HASH = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a";

const quiet = { log() {}, warn() {}, error() {} };

// Header printed by `yt-dlp -v` (no URL) for the bundled 2026.08.19 build.
const VERBOSE_HEADER = `[debug] Command-line config: ['-v', '--ignore-config']
[debug] yt-dlp version stable@2026.08.19 from yt-dlp/yt-dlp [594bd50c2] (win_exe)
[debug] Optional libraries: Cryptodome-3.23.0, brotli-1.2.0, certifi-2026.07.22, curl_cffi-0.16.0, mutagen-1.48.1, requests-2.34.2, sqlite3-3.40.1, urllib3-2.7.0, websockets-16.1.1, yt_dlp_ejs-0.8.0
[debug] JS runtimes: deno-2.9.7
[debug] Plugin directories: none (disabled)`;

// --- OpenPGP verification ------------------------------------------------

test("the pinned yt-dlp key and a real release signature verify", () => {
  assert.equal(parsePublicKey(SIGNING_KEY).fingerprint, YT_DLP_SIGNING_KEY_FINGERPRINT);

  const result = verifyDetachedSignature({
    document: SUMS,
    signature: SIGNATURE,
    publicKey: SIGNING_KEY,
    expectedFingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT,
  });
  assert.equal(result.createdAt.toISOString(), "2026-08-19T23:48:09.000Z");
});

test("a modified checksum file or a different key is rejected", () => {
  const tampered = Buffer.from(SUMS);
  tampered[0] = tampered[0] === 0x61 ? 0x62 : 0x61;

  assert.throws(
    () =>
      verifyDetachedSignature({
        document: tampered,
        signature: SIGNATURE,
        publicKey: SIGNING_KEY,
        expectedFingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT,
      }),
    SignatureError,
  );

  assert.throws(
    () =>
      verifyDetachedSignature({
        document: SUMS,
        signature: SIGNATURE,
        publicKey: SIGNING_KEY,
        expectedFingerprint: "0".repeat(40),
      }),
    /pinned fingerprint/,
  );

  assert.throws(
    () =>
      verifyDetachedSignature({
        document: SUMS,
        signature: Buffer.from("not a signature"),
        publicKey: SIGNING_KEY,
        expectedFingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT,
      }),
    SignatureError,
  );
});

// --- Parsing helpers -----------------------------------------------------

test("versions are validated and compared numerically", () => {
  assert.equal(isValidVersion("2026.08.19"), true);
  assert.equal(isValidVersion("2026.10.10.233141"), true);
  for (const bad of ["latest", "v2026.08.19", "2026.8.19", "../2026.08.19", "", null]) {
    assert.equal(isValidVersion(bad), false, String(bad));
  }

  assert.equal(compareVersions("2026.10.10.233141", "2026.08.19"), 1);
  assert.equal(compareVersions("2026.08.19", "2026.08.19"), 0);
  assert.equal(compareVersions("2026.08.19", "2026.08.19.1"), -1);
  assert.equal(compareVersions("2025.12.31", "2026.01.01"), -1);
});

test("the signed checksum list yields yt-dlp.exe's hash", () => {
  assert.equal(parseChecksums(SUMS.toString("utf8"), "yt-dlp.exe"), RELEASE_HASH);
  assert.equal(parseChecksums(SUMS.toString("utf8"), "missing.exe"), null);
});

test("the verbose header reports version, JS runtime and EJS", () => {
  assert.deepEqual(parseVerboseHeader(VERBOSE_HEADER), {
    channel: "stable",
    version: "2026.08.19",
    jsRuntimes: ["deno-2.9.7"],
    ejsVersion: "0.8.0",
  });

  const noRuntime = parseVerboseHeader(VERBOSE_HEADER.replace("deno-2.9.7", "none"));
  assert.deepEqual(noRuntime.jsRuntimes, []);
});

test("downloads are limited to official https release locations", () => {
  assert.doesNotThrow(() => assertAllowedUrl("https://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp.exe"));
  assert.doesNotThrow(() => assertAllowedUrl("https://release-assets.githubusercontent.com/abc"));
  for (const url of [
    "http://github.com/yt-dlp/yt-dlp",
    "https://example.com/yt-dlp.exe",
    "https://github.com.evil.example/x",
    "file:///C:/yt-dlp.exe",
    "not a url",
  ]) {
    assert.throws(() => assertAllowedUrl(url), EngineUpdateError, url);
  }
});

// --- Fake release server ---------------------------------------------------

function respond(status, body = null, headers = {}) {
  return new Response(body, { status, headers });
}

function createFakeGitHub({ tag = RELEASE, sums = SUMS, signature = SIGNATURE, exe = Buffer.from("fake exe") } = {}) {
  const requests = [];
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;

  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, "manual");

    if (url === "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest") {
      return respond(200, JSON.stringify({ tag_name: tag }), { "content-type": "application/json" });
    }
    if (url === `${base}/SHA2-256SUMS`) return respond(200, sums);
    if (url === `${base}/SHA2-256SUMS.sig`) return respond(200, signature);
    if (url === `${base}/yt-dlp.exe`) {
      return respond(302, null, { location: "https://release-assets.githubusercontent.com/asset/yt-dlp.exe" });
    }
    if (url === "https://release-assets.githubusercontent.com/asset/yt-dlp.exe") {
      return respond(200, exe, { "content-length": String(exe.length) });
    }
    return respond(404);
  };

  return { fetchImpl, requests };
}

function createUpdater(t, { fake, current = "2026.07.04", selfTest } = {}) {
  const dir = makeTempDir(t, "wavemint-engine-");
  const store = createEngineStore({ dir, logger: quiet });
  const updater = createEngineUpdater({
    store,
    fetchImpl: fake.fetchImpl,
    publicKey: () => SIGNING_KEY,
    getCurrentVersion: () => store.getActive()?.version || current,
    selfTest: selfTest || (async () => parseVerboseHeader(VERBOSE_HEADER)),
    logger: quiet,
  });
  return { dir, store, updater };
}

test("redirects to hosts outside the allowlist are refused", async () => {
  const fetchImpl = async () => respond(302, null, { location: "https://evil.example/yt-dlp.exe" });
  await assert.rejects(
    fetchAllowed(fetchImpl, "https://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp.exe"),
    (error) => error instanceof EngineUpdateError && error.code === "blocked_url",
  );
});

test("update checks report newer versions and never fail loudly", async (t) => {
  const { updater, store } = createUpdater(t, { fake: createFakeGitHub() });

  const result = await updater.check({ channel: "stable" });
  assert.equal(result.status, "available");
  assert.equal(result.latest, RELEASE);
  assert.equal(store.getState().lastCheck.status, "available");

  const offline = createUpdater(t, {
    fake: { fetchImpl: async () => Promise.reject(new TypeError("fetch failed")) },
  });
  const failed = await offline.updater.check({ channel: "stable" });
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /couldn't reach the update server/);
});

test("an older or equal version is never offered or installed", async (t) => {
  const { updater } = createUpdater(t, { fake: createFakeGitHub(), current: RELEASE });
  assert.equal((await updater.check({ channel: "stable" })).status, "up-to-date");
  await assert.rejects(updater.install({ channel: "stable" }), /already up to date/);

  const newer = createUpdater(t, { fake: createFakeGitHub(), current: "2026.10.10.233141" });
  assert.equal((await newer.updater.check({ channel: "stable" })).status, "up-to-date");
});

test("a download that doesn't match the signed checksum is rejected and cleaned up", async (t) => {
  const { updater, store, dir } = createUpdater(t, { fake: createFakeGitHub() });

  await assert.rejects(updater.install({ channel: "stable" }), (error) => error.code === "hash_mismatch");
  assert.equal(store.getActive(), null);
  assert.deepEqual(fs.readdirSync(path.join(dir, "staging")), []);
});

test("checksums with a bad signature are rejected before anything is downloaded", async (t) => {
  const tampered = Buffer.from(SUMS.toString("utf8").replace(RELEASE_HASH, "0".repeat(64)));
  const fake = createFakeGitHub({ sums: tampered });
  const { updater, store } = createUpdater(t, { fake });

  await assert.rejects(updater.install({ channel: "stable" }), /signature could not be verified/);
  assert.equal(store.getActive(), null);
  assert.ok(!fake.requests.some((url) => url.endsWith("yt-dlp.exe")));
});

test("only one update can run at a time", async (t) => {
  const { updater } = createUpdater(t, { fake: createFakeGitHub() });
  const first = updater.install({ channel: "stable" });
  await assert.rejects(updater.install({ channel: "stable" }), (error) => error.code === "busy");
  await first.catch(() => {});
  assert.equal(updater.isInstalling(), false);
});

// The full success path needs a file whose hash is in the signed list: the
// real yt-dlp.exe fetched by `npm run binaries:fetch`.
const realExePath = path.join(ROOT, "resources", "bin", "win32-x64", "yt-dlp.exe");
const realExe =
  fs.existsSync(realExePath) &&
  crypto.createHash("sha256").update(fs.readFileSync(realExePath)).digest("hex") === RELEASE_HASH
    ? fs.readFileSync(realExePath)
    : null;
const needsRealExe = { skip: !realExe && 'run "npm run binaries:fetch" first' };

test("a verified, tested update is activated, and older ones can be restored", needsRealExe, async (t) => {
  const fake = createFakeGitHub({ exe: realExe });
  const stages = [];
  const { updater, store, dir } = createUpdater(t, { fake });

  const record = await updater.install({ channel: "stable", onProgress: (p) => stages.push(p.stage) });

  assert.equal(record.version, RELEASE);
  assert.equal(record.sha256, RELEASE_HASH);
  assert.equal(record.ejsVersion, "0.8.0");
  assert.deepEqual([...new Set(stages)], ["checking", "verifying", "downloading", "testing", "installing", "done"]);

  const active = store.getActive();
  assert.equal(active.command, path.join(dir, "versions", RELEASE, "yt-dlp.exe"));
  assert.ok(fs.existsSync(active.command));

  // State survives a restart, after re-verifying the file's hash.
  const reloaded = createEngineStore({ dir, logger: quiet });
  await reloaded.load();
  assert.equal(reloaded.getActive().version, RELEASE);

  // Back to the built-in copy, then forward again with rollback.
  reloaded.useBundled();
  assert.equal(reloaded.getActive(), null);
  assert.equal(reloaded.rollback(), true);
  assert.equal(reloaded.getActive().version, RELEASE);
});

test("an update incompatible with the bundled Deno is not activated", needsRealExe, async (t) => {
  const { updater, store } = createUpdater(t, {
    fake: createFakeGitHub({ exe: realExe }),
    selfTest: async () => parseVerboseHeader(VERBOSE_HEADER.replace("deno-2.9.7", "none")),
  });

  await assert.rejects(updater.install({ channel: "stable" }), /newer JavaScript runtime/);
  assert.equal(store.getActive(), null);
});

test("an update reporting the wrong version is not activated", needsRealExe, async (t) => {
  const { updater, store } = createUpdater(t, {
    fake: createFakeGitHub({ exe: realExe }),
    selfTest: async () => parseVerboseHeader(VERBOSE_HEADER.replace("2026.08.19", "2026.01.01")),
  });

  await assert.rejects(updater.install({ channel: "stable" }), /unexpected version/);
  assert.equal(store.getActive(), null);
});

// --- Store ----------------------------------------------------------------

function installFakeVersion(dir, version, contents) {
  const exe = writeFile(path.join(dir, "versions", version, "yt-dlp.exe"), contents);
  return {
    version,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
    channel: "stable",
    ejsVersion: "0.8.0",
    installedAt: new Date().toISOString(),
    exe,
  };
}

test("a modified or missing updated engine is ignored at startup", async (t) => {
  const dir = makeTempDir(t);
  const store = createEngineStore({ dir, logger: quiet });
  const record = installFakeVersion(dir, "2026.09.01", "engine one");
  store.activate(record);

  fs.writeFileSync(record.exe, "tampered");
  const reloaded = createEngineStore({ dir, logger: quiet });
  await reloaded.load();
  assert.equal(reloaded.getActive(), null);
});

test("a broken version is retired and old versions are pruned", async (t) => {
  const dir = makeTempDir(t);
  const store = createEngineStore({ dir, logger: quiet });
  const first = installFakeVersion(dir, "2026.09.01", "one");
  const second = installFakeVersion(dir, "2026.09.15", "two");
  const third = installFakeVersion(dir, "2026.10.01", "three");

  store.activate(first);
  store.activate(second);
  store.activate(third);
  assert.equal(store.getState().previous.version, "2026.09.15");

  store.prune();
  assert.deepEqual(fs.readdirSync(path.join(dir, "versions")).sort(), ["2026.09.15", "2026.10.01"]);

  store.markBroken("2026.10.01");
  assert.equal(store.getActive(), null);
  assert.ok(store.getState().broken.includes("2026.10.01"));
});

test("corrupted engine state falls back to the built-in engine", async (t) => {
  const dir = makeTempDir(t);
  writeFile(path.join(dir, "state.json"), "{ not json");
  const store = createEngineStore({ dir, logger: quiet });
  await store.load();
  assert.equal(store.getActive(), null);

  writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ active: { version: "../../evil", sha256: "x" } }),
  );
  await store.load();
  assert.equal(store.getActive(), null);
});

// --- Resolver priority ----------------------------------------------------

test("yt-dlp resolves to a validated update first and the bundled copy otherwise", (t) => {
  const resourcesPath = makeTempDir(t);
  const resolver = createBinaryResolver({
    isPackaged: true,
    resourcesPath,
    appRoot: ROOT,
    platform: "win32",
    arch: "x64",
  });
  const bundled = path.join(resourcesPath, "bin", "yt-dlp.exe");

  assert.equal(resolver.resolve("yt-dlp").command, bundled);
  assert.equal(resolver.resolve("yt-dlp").source, "bundled");

  resolver.setYtDlpOverride({ command: "C:\\Data\\engine\\versions\\2026.10.01\\yt-dlp.exe", version: "2026.10.01" });
  const updated = resolver.resolve("yt-dlp");
  assert.equal(updated.source, "updated");
  assert.equal(updated.bundled, true);
  assert.equal(updated.version, "2026.10.01");
  // Only yt-dlp is ever updated; the other tools stay bundled.
  assert.equal(resolver.resolve("deno").source, "bundled");
  assert.equal(resolver.resolveDefault("yt-dlp").command, bundled);

  resolver.setYtDlpOverride(null);
  assert.equal(resolver.resolve("yt-dlp").command, bundled);
});
