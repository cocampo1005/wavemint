// In-app updates for the extraction engine (yt-dlp).
//
// WaveMint ships a pinned yt-dlp.exe in its read-only install folder. YouTube
// changes often, so users can install a newer official yt-dlp release without
// reinstalling WaveMint. Updated copies live in the per-user data folder:
//
//   <userData>/engine/state.json              active + previous version
//   <userData>/engine/versions/<v>/yt-dlp.exe  one folder per version
//   <userData>/engine/staging/                 downloads in progress
//
// Trust model (see docs/ENGINEERING.md):
// - Release metadata (the latest tag) comes from the GitHub API and is only
//   used to build URLs on an allowlist of official yt-dlp release locations.
// - SHA2-256SUMS must carry a valid OpenPGP signature from yt-dlp's release
//   signing key, whose fingerprint is pinned in WaveMint (electron/trust/).
// - yt-dlp.exe must match the signed SHA-256, report the expected version, and
//   pass an offline self-test with WaveMint's bundled Deno (EJS challenge
//   solving) and FFmpeg before it is activated.
// - Versions never go backwards, so an old signed release can't be replayed.
// - Executables are never overwritten: each version gets its own folder and
//   activation only switches state.json (written atomically). The previous
//   version is kept for rollback; the bundled copy is always the fallback.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SignatureError, verifyDetachedSignature } = require("./pgp.cjs");

const YT_DLP_SIGNING_KEY_FINGERPRINT = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";
const SIGNING_KEY_PATH = path.join(__dirname, "trust", "yt-dlp-signing-key.asc");

const CHANNELS = {
  stable: { repo: "yt-dlp/yt-dlp", label: "Stable" },
  nightly: { repo: "yt-dlp/yt-dlp-nightly-builds", label: "Nightly" },
};

const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 80 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const METADATA_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const STATE_VERSION = 1;
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(?:\.\d{1,8})?$/;

class EngineUpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EngineUpdateError";
    this.code = code;
  }
}

function isValidVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

/** Compares yt-dlp versions such as 2026.08.19 and 2026.10.10.233141. */
function compareVersions(left, right) {
  const a = String(left || "").split(".").map(Number);
  const b = String(right || "").split(".").map(Number);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }

  return 0;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Reads the hash for `fileName` from a SHA2-256SUMS file. */
function parseChecksums(text, fileName) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S.*)$/i.exec(line.trim());
    if (match && match[2].trim() === fileName) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Parses yt-dlp's verbose header (`yt-dlp -v` without a URL, which makes no
 * network requests) into what the compatibility check needs.
 */
function parseVerboseHeader(text) {
  const output = String(text || "");
  const version = /yt-dlp version (?:(\w+)@)?(\S+)/.exec(output);
  const runtimes = /JS runtimes:\s*(.+)/.exec(output)?.[1]?.trim() || "";
  const libraries = /Optional libraries:\s*(.+)/.exec(output)?.[1] || "";
  const ejs = /yt_dlp_ejs-([\w.]+)/.exec(libraries)?.[1] || "";

  return {
    channel: version?.[1] || "",
    version: version?.[2] || "",
    jsRuntimes: runtimes && runtimes !== "none" ? runtimes.split(/,\s*/) : [],
    ejsVersion: ejs,
  };
}

function assertAllowedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new EngineUpdateError("blocked_url", "The update location is invalid.");
  }

  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new EngineUpdateError(
      "blocked_url",
      "The update was redirected to an unexpected location and was stopped.",
    );
  }

  return parsed;
}

/**
 * Fetches a URL on the allowlist, following redirects manually so every hop
 * is checked. Returns the final Response.
 */
async function fetchAllowed(fetchImpl, url, { timeoutMs, signal } = {}) {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertAllowedUrl(current);
    const timeout = AbortSignal.timeout(timeoutMs || METADATA_TIMEOUT_MS);
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: { "User-Agent": "WaveMint", Accept: "application/octet-stream, application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel?.().catch(() => {});
      if (!location) break;
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) {
      throw new EngineUpdateError(
        response.status === 403 || response.status === 429 ? "rate_limited" : "http_error",
        response.status === 403 || response.status === 429
          ? "GitHub is limiting update checks right now. Try again later."
          : `The update server responded with HTTP ${response.status}.`,
      );
    }

    return response;
  }

  throw new EngineUpdateError("blocked_url", "Too many redirects while downloading the update.");
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new EngineUpdateError("too_large", "The update file is larger than expected.");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new EngineUpdateError("too_large", "The update file is larger than expected.");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadToFile(response, destination, { maxBytes, onProgress }) {
  const total = Number(response.headers.get("content-length") || 0);
  if (total > maxBytes) {
    throw new EngineUpdateError("too_large", "The update file is larger than expected.");
  }

  const hash = crypto.createHash("sha256");
  const handle = await fs.promises.open(destination, "w");
  let size = 0;

  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new EngineUpdateError("too_large", "The update file is larger than expected.");
      }
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      await handle.write(buffer);
      if (total) onProgress?.(Math.min(100, (size / total) * 100));
    }
  } finally {
    await handle.close();
  }

  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Installed-engine state
// ---------------------------------------------------------------------------

function sanitizeRecord(value) {
  if (!value || typeof value !== "object") return null;
  if (!isValidVersion(value.version)) return null;
  if (!/^[a-f0-9]{64}$/.test(String(value.sha256 || ""))) return null;

  return {
    version: value.version,
    sha256: value.sha256,
    channel: CHANNELS[value.channel] ? value.channel : "stable",
    ejsVersion: typeof value.ejsVersion === "string" ? value.ejsVersion.slice(0, 32) : "",
    installedAt: typeof value.installedAt === "string" ? value.installedAt.slice(0, 64) : "",
  };
}

function sanitizeLastCheck(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["up-to-date", "available", "failed"].includes(value.status) ? value.status : null;
  if (!status) return null;

  return {
    status,
    channel: CHANNELS[value.channel] ? value.channel : "stable",
    latest: isValidVersion(value.latest) ? value.latest : "",
    message: typeof value.message === "string" ? value.message.slice(0, 300) : "",
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt.slice(0, 64) : "",
  };
}

function createEngineStore({ dir, logger = console }) {
  const statePath = path.join(dir, "state.json");
  const versionsDir = path.join(dir, "versions");
  let state = { version: STATE_VERSION, active: null, previous: null, broken: [], lastCheck: null };

  function executablePath(version) {
    return path.join(versionsDir, version, "yt-dlp.exe");
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, statePath);
  }

  // Confirms a recorded version is still the file that was verified.
  async function isIntact(record) {
    if (!record) return false;
    try {
      return (await sha256File(executablePath(record.version))) === record.sha256;
    } catch {
      return false;
    }
  }

  /** Loads and re-verifies the installed versions. Call once at startup. */
  async function load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    } catch {
      // Missing or unreadable: no updated engine, use the bundled one.
    }

    state = {
      version: STATE_VERSION,
      active: sanitizeRecord(raw?.active),
      previous: sanitizeRecord(raw?.previous),
      broken: Array.isArray(raw?.broken) ? raw.broken.filter(isValidVersion).slice(-10) : [],
      lastCheck: sanitizeLastCheck(raw?.lastCheck),
    };

    if (state.active && !(await isIntact(state.active))) {
      logger.warn(`[engine] Updated yt-dlp ${state.active.version} is missing or modified; using the built-in version`);
      state.active = null;
    }

    if (state.previous && !(await isIntact(state.previous))) {
      state.previous = null;
    }

    return getState();
  }

  function getState() {
    return JSON.parse(JSON.stringify(state));
  }

  function getActive() {
    return state.active ? { ...state.active, command: executablePath(state.active.version) } : null;
  }

  function activate(record) {
    const previous = state.active;
    state.active = sanitizeRecord(record);
    if (previous && previous.version !== record.version) state.previous = previous;
    save();
  }

  function useBundled() {
    if (state.active) state.previous = state.active;
    state.active = null;
    save();
  }

  function rollback() {
    if (!state.previous) return false;
    const current = state.active;
    state.active = state.previous;
    state.previous = current;
    save();
    return true;
  }

  // Called when an activated version fails its startup check.
  function markBroken(version) {
    if (!state.broken.includes(version)) state.broken.push(version);
    if (state.active?.version === version) state.active = null;
    if (state.previous?.version === version) state.previous = null;
    save();
  }

  function setLastCheck(lastCheck) {
    state.lastCheck = sanitizeLastCheck(lastCheck);
    save();
  }

  // Removes version folders that are neither active nor kept for rollback.
  function prune() {
    const keep = new Set([state.active?.version, state.previous?.version].filter(Boolean));
    let entries = [];
    try {
      entries = fs.readdirSync(versionsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (keep.has(entry)) continue;
      try {
        fs.rmSync(path.join(versionsDir, entry), { recursive: true, force: true });
      } catch (error) {
        // A version that is still running can't be deleted on Windows; it
        // is removed on a later start.
        logger.warn(`[engine] Could not remove old engine ${entry}: ${error.message}`);
      }
    }
  }

  return {
    dir,
    versionsDir,
    stagingDir: path.join(dir, "staging"),
    activate,
    executablePath,
    getActive,
    getState,
    load,
    markBroken,
    prune,
    rollback,
    setLastCheck,
    useBundled,
  };
}

// ---------------------------------------------------------------------------
// Update checks and installation
// ---------------------------------------------------------------------------

function createEngineUpdater({
  store,
  fetchImpl = globalThis.fetch,
  publicKey = () => fs.readFileSync(SIGNING_KEY_PATH, "utf8"),
  getCurrentVersion,
  selfTest,
  isBusy = () => false,
  logger = console,
  now = () => new Date(),
}) {
  let inFlight = null;

  async function fetchLatestRelease(channel, signal) {
    const config = CHANNELS[channel];
    if (!config) throw new EngineUpdateError("bad_channel", "Unknown update channel.");

    const response = await fetchAllowed(
      fetchImpl,
      `https://api.github.com/repos/${config.repo}/releases/latest`,
      { timeoutMs: METADATA_TIMEOUT_MS, signal },
    );

    let release;
    try {
      release = JSON.parse((await readLimited(response, MAX_METADATA_BYTES)).toString("utf8"));
    } catch (error) {
      if (error instanceof EngineUpdateError) throw error;
      throw new EngineUpdateError("bad_metadata", "The update information could not be read.");
    }

    const version = String(release?.tag_name || "");
    if (!isValidVersion(version)) {
      throw new EngineUpdateError("bad_metadata", "The update information could not be read.");
    }

    const base = `https://github.com/${config.repo}/releases/download/${version}`;
    return {
      version,
      channel,
      executableUrl: `${base}/yt-dlp.exe`,
      checksumsUrl: `${base}/SHA2-256SUMS`,
      signatureUrl: `${base}/SHA2-256SUMS.sig`,
    };
  }

  function describeError(error) {
    if (error instanceof EngineUpdateError) return error.message;
    if (error instanceof SignatureError) {
      return "The update's signature could not be verified, so it was not installed.";
    }
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return "The update server took too long to respond. Check your connection and try again.";
    }
    if (error?.syscall) {
      return `WaveMint couldn't save the update on this computer (${error.code || "file error"}). Check that there is free disk space and try again.`;
    }
    if (error instanceof TypeError) {
      return "WaveMint couldn't reach the update server. Check your internet connection and try again.";
    }
    return "The update couldn't be installed.";
  }

  /** Checks for a newer engine. Never throws; returns the check result. */
  async function check({ channel = "stable", signal } = {}) {
    const checkedAt = now().toISOString();
    const current = getCurrentVersion();

    try {
      const latest = await fetchLatestRelease(channel, signal);
      const broken = store.getState().broken.includes(latest.version);
      const status =
        compareVersions(latest.version, current) > 0 && !broken ? "available" : "up-to-date";
      const result = { status, channel, latest: latest.version, current, checkedAt, message: "" };
      store.setLastCheck(result);
      return result;
    } catch (error) {
      const result = {
        status: "failed",
        channel,
        latest: "",
        current,
        checkedAt,
        message: describeError(error),
      };
      logger.warn(`[engine] Update check failed: ${error.message}`);
      store.setLastCheck(result);
      return result;
    }
  }

  async function runInstall({ channel, onProgress, signal }) {
    const report = (stage, percent = null) => onProgress?.({ stage, percent });
    const current = getCurrentVersion();

    report("checking");
    const latest = await fetchLatestRelease(channel, signal);

    if (compareVersions(latest.version, current) <= 0) {
      throw new EngineUpdateError("up_to_date", "The extraction engine is already up to date.");
    }

    if (store.getState().broken.includes(latest.version)) {
      throw new EngineUpdateError(
        "known_broken",
        `yt-dlp ${latest.version} didn't work with this version of WaveMint, so it won't be installed again.`,
      );
    }

    report("verifying");
    const [checksums, signature] = await Promise.all([
      fetchAllowed(fetchImpl, latest.checksumsUrl, { signal }).then((response) =>
        readLimited(response, MAX_SUMS_BYTES),
      ),
      fetchAllowed(fetchImpl, latest.signatureUrl, { signal }).then((response) =>
        readLimited(response, MAX_SUMS_BYTES),
      ),
    ]);

    verifyDetachedSignature({
      document: checksums,
      signature,
      publicKey: publicKey(),
      expectedFingerprint: YT_DLP_SIGNING_KEY_FINGERPRINT,
    });

    const expectedHash = parseChecksums(checksums.toString("utf8"), "yt-dlp.exe");
    if (!expectedHash) {
      throw new EngineUpdateError("bad_metadata", "The signed checksum list doesn't include yt-dlp.exe.");
    }

    const stagingDir = path.join(store.stagingDir, `${latest.version}-${process.pid}-${Date.now()}`);
    const stagedExe = path.join(stagingDir, "yt-dlp.exe");
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
      report("downloading", 0);
      const response = await fetchAllowed(fetchImpl, latest.executableUrl, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        signal,
      });
      const actualHash = await downloadToFile(response, stagedExe, {
        maxBytes: MAX_EXECUTABLE_BYTES,
        onProgress: (percent) => report("downloading", percent),
      });

      if (actualHash !== expectedHash) {
        throw new EngineUpdateError(
          "hash_mismatch",
          "The downloaded file didn't match yt-dlp's signed checksum, so it was not installed.",
        );
      }

      report("testing");
      const header = await selfTest(stagedExe);

      if (header.version !== latest.version) {
        throw new EngineUpdateError(
          "version_mismatch",
          "The downloaded engine reported an unexpected version, so it was not installed.",
        );
      }

      if (!header.jsRuntimes.some((runtime) => runtime.startsWith("deno"))) {
        throw new EngineUpdateError(
          "incompatible",
          `yt-dlp ${latest.version} needs a newer JavaScript runtime than this version of WaveMint includes. Update WaveMint instead.`,
        );
      }

      if (!header.ejsVersion) {
        throw new EngineUpdateError(
          "incompatible",
          `yt-dlp ${latest.version} doesn't include its YouTube challenge solver, so it can't be used.`,
        );
      }

      report("installing");
      const targetDir = path.dirname(store.executablePath(latest.version));
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.renameSync(stagingDir, targetDir);

      const record = {
        version: latest.version,
        sha256: actualHash,
        channel,
        ejsVersion: header.ejsVersion,
        installedAt: now().toISOString(),
      };
      store.activate(record);

      // Old versions may still be running an extraction; prune them later.
      if (!isBusy()) store.prune();

      store.setLastCheck({
        status: "up-to-date",
        channel,
        latest: latest.version,
        checkedAt: now().toISOString(),
      });

      logger.log(`[engine] Installed yt-dlp ${latest.version} (${channel}, EJS ${header.ejsVersion})`);
      report("done", 100);
      return record;
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  /** Downloads, verifies, tests and activates the newest engine. */
  function install({ channel = "stable", onProgress, signal } = {}) {
    if (inFlight) {
      return Promise.reject(new EngineUpdateError("busy", "An update is already being installed."));
    }

    inFlight = runInstall({ channel, onProgress, signal })
      .catch((error) => {
        logger.warn(`[engine] Update failed: ${error.message}`);
        throw new EngineUpdateError(error.code || "failed", describeError(error));
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  return { check, install, isInstalling: () => !!inFlight };
}

module.exports = {
  ALLOWED_HOSTS,
  CHANNELS,
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
  sha256File,
};
