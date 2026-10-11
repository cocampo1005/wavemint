// The extraction manager: the single place that runs yt-dlp.
//
// Responsibilities:
// - building yt-dlp command lines for analysis and downloads (on top of the
//   runtime options from binaries.cjs and the auth options from auth.cjs);
// - running them through processes.cjs with cancellation and timeouts;
// - classifying failures (errors.cjs) and deciding, conservatively, whether
//   another attempt is worthwhile;
// - honoring YouTube rate limits with a session-wide cooldown;
// - reporting progress phases and recording sanitized diagnostics.
//
// Retry policy (see docs/ENGINEERING.md):
// - Transient network/server failures: at most MAX_NETWORK_RETRIES extra
//   attempts with bounded exponential backoff and jitter, and only when the
//   failed attempt ended quickly. yt-dlp already retries connections itself
//   (about 25 s when offline), so retrying a slow failure would only make
//   the user wait several times as long for the same answer.
// - HTTP 403 on the media stream (downloads only): the long-standing ladder
//   "configured auth → without auth (only if auth is configured) → mweb
//   client", each step at most once.
// - Rate limits: stop immediately and start the cooldown.
// - Everything else (private, unavailable, auth, unsupported URL, outdated
//   extractor, missing component): stop immediately.
// - Never more than MAX_ATTEMPTS yt-dlp runs per operation.

const { AuthError, redactSensitiveText } = require("./auth.cjs");
const {
  CATEGORIES,
  ExtractionError,
  classifyFailure,
} = require("./errors.cjs");

// Explicit pacing options are used instead of yt-dlp's `-t sleep` preset so
// the arguments stay valid across yt-dlp versions. YouTube currently
// recommends a 5-10 second delay between downloads for rate-limited sessions.
const REQUEST_SLEEP_SECONDS = "1";
const DOWNLOAD_SLEEP_MIN_SECONDS = "5";
const DOWNLOAD_SLEEP_MAX_SECONDS = "10";

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const MAX_NETWORK_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 10000;
const RETRY_JITTER_MS = 1000;
const SLOW_FAILURE_MS = 15000;

const ANALYZE_VIDEO_TIMEOUT_MS = 3 * 60 * 1000;
const ANALYZE_PLAYLIST_TIMEOUT_MS = 15 * 60 * 1000;

const STRATEGIES = {
  DEFAULT: "default",
  WITHOUT_AUTH: "without-auth",
  MWEB: "mweb-client",
};

function getPacingArgs({ beforeDownload = false } = {}) {
  const args = ["--sleep-requests", REQUEST_SLEEP_SECONDS];

  if (beforeDownload) {
    args.push(
      "--sleep-interval",
      DOWNLOAD_SLEEP_MIN_SECONDS,
      "--max-sleep-interval",
      DOWNLOAD_SLEEP_MAX_SECONDS,
    );
  }

  return args;
}

/** yt-dlp arguments (after runtime + auth options) for URL analysis. */
function buildAnalyzeArgs({ url, mode }) {
  const args = [...getPacingArgs(), "--dump-single-json"];

  if (mode === "video") {
    args.push("--no-playlist");
  } else {
    // Listing a playlist should not fully resolve every video before the
    // user has selected tracks. This dramatically reduces YouTube requests.
    args.push("--flat-playlist");
  }

  // "--" ends option parsing so a URL can never be read as a yt-dlp option.
  args.push("--", String(url).trim());
  return args;
}

/** yt-dlp arguments (after runtime + auth options) for an MP3 download. */
function buildDownloadArgs({ url, outputTemplate, strategy = STRATEGIES.DEFAULT }) {
  const args = [
    "--no-update",
    ...getPacingArgs({ beforeDownload: true }),
    "--newline",
    "--progress",
    "--write-info-json",
    "-x",
    "--audio-format",
    "mp3",
    "--audio-quality",
    "0",
    "--no-playlist",
    "-o",
    outputTemplate,
  ];

  if (strategy === STRATEGIES.MWEB) {
    // yt-dlp's PO Token guide recommends the mweb client; without a token
    // provider it still offers HLS audio, which sometimes succeeds when the
    // default clients' streams are refused.
    args.push("--extractor-args", "youtube:player_client=mweb");
  }

  args.push("--", String(url).trim());
  return args;
}

function parseDownloadPercent(line) {
  const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(String(line || ""));
  return match ? Number(match[1]) : null;
}

function isSleepLine(line) {
  return /\bSleeping\s+\d+(?:\.\d+)?\s+seconds/i.test(String(line || ""));
}

// Maps a line of yt-dlp download output to a progress update, or null.
function parseDownloadProgressLine(line) {
  if (isSleepLine(line)) return { phase: "waiting" };

  const percent = parseDownloadPercent(line);
  if (percent !== null) return { phase: "downloading", percent };

  if (/^\[ExtractAudio\]/.test(String(line || "").trim())) return { phase: "converting" };

  return null;
}

function getRetryDelayMs(retryNumber, random = Math.random) {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryNumber - 1);
  return Math.min(RETRY_MAX_DELAY_MS, exponential) + Math.floor(random() * RETRY_JITTER_MS);
}

/**
 * Decides what to do after a failed attempt. Returns
 * { action: "stop" } or { action: "retry", strategy, delayMs, reason }.
 * Pure function so the policy can be tested exhaustively.
 */
function decideNextAttempt({
  operation,
  classification,
  attempts,
  usedStrategies,
  networkRetries,
  authConfigured,
  attemptDurationMs = 0,
  random = Math.random,
}) {
  if (attempts >= MAX_ATTEMPTS) return { action: "stop" };

  const { category } = classification;

  if (classification.transient) {
    if (networkRetries >= MAX_NETWORK_RETRIES || attemptDurationMs > SLOW_FAILURE_MS) {
      return { action: "stop" };
    }
    return {
      action: "retry",
      strategy: null, // same strategy again
      delayMs: getRetryDelayMs(networkRetries + 1, random),
      reason: "network",
    };
  }

  if (operation === "download" && category === CATEGORIES.MEDIA_FORBIDDEN) {
    if (authConfigured && !usedStrategies.has(STRATEGIES.WITHOUT_AUTH)) {
      return { action: "retry", strategy: STRATEGIES.WITHOUT_AUTH, delayMs: 0, reason: "fallback" };
    }

    if (!usedStrategies.has(STRATEGIES.MWEB)) {
      return { action: "retry", strategy: STRATEGIES.MWEB, delayMs: 0, reason: "fallback" };
    }
  }

  return { action: "stop" };
}

// Which failure to report when several attempts failed differently. A
// fallback that fails for an unrelated reason (for example "sign-in
// required" after dropping cookies) must not hide the original problem.
function chooseReportedFailure(failures) {
  const rateLimited = failures.find((item) => item.category === CATEGORIES.RATE_LIMITED);
  if (rateLimited) return rateLimited;

  const last = failures[failures.length - 1];
  const first = failures[0];

  if (
    first.category === CATEGORIES.MEDIA_FORBIDDEN &&
    last.category !== CATEGORIES.MEDIA_FORBIDDEN &&
    !last.transient
  ) {
    return first;
  }

  return last;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }

    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function createExtractionManager({
  binaries,
  runCommand,
  getAuthSettings,
  buildAuthArgs,
  diagnostics,
  getEngineDescription = () => "",
  logger = console,
  now = Date.now,
  sleep = defaultSleep,
  random = Math.random,
}) {
  let rateLimitedUntil = 0;
  let activeJobs = 0;

  function getRateLimitRemainingMs() {
    return Math.max(0, rateLimitedUntil - now());
  }

  function markRateLimited() {
    rateLimitedUntil = Math.max(rateLimitedUntil, now() + RATE_LIMIT_COOLDOWN_MS);
  }

  function assertAvailable() {
    const remainingMs = getRateLimitRemainingMs();
    if (remainingMs <= 0) return;

    const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
    throw new ExtractionError({
      category: CATEGORIES.RATE_LIMITED,
      message: `YouTube is temporarily limiting requests, so WaveMint has paused. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    });
  }

  function getAuthArgs() {
    try {
      return buildAuthArgs(getAuthSettings());
    } catch (error) {
      if (error instanceof AuthError) {
        throw new ExtractionError({ category: CATEGORIES.AUTH_UNAVAILABLE, message: error.message });
      }
      throw error;
    }
  }

  function isAuthConfigured() {
    const mode = getAuthSettings()?.mode;
    return !!mode && mode !== "none";
  }

  /**
   * Runs one of WaveMint's tools once. Resolves with the process result plus
   * durationMs; throws ExtractionError("dependency") if it can't start.
   */
  async function runTool(tool, args, options = {}) {
    const resolved = binaries.resolve(tool);
    const finalArgs = tool === "yt-dlp" ? [...binaries.getYtDlpRuntimeArgs(), ...args] : args;
    const startedAt = now();

    logger.log(`[extraction] Starting ${tool}`);
    if (tool === "yt-dlp") activeJobs += 1;

    try {
      const result = await runCommand(resolved.command, finalArgs, {
        ...options,
        label: resolved.label,
        env: binaries.getChildEnv(),
      });
      return { ...result, durationMs: now() - startedAt };
    } catch (error) {
      logger.error(`[extraction] ${tool} could not start: ${error.message}`);
      throw new ExtractionError({ category: CATEGORIES.MISSING_DEPENDENCY, message: error.message });
    } finally {
      if (tool === "yt-dlp") activeJobs -= 1;
    }
  }

  function throwIfCancelled(signal) {
    if (signal?.aborted) {
      throw new ExtractionError({ category: CATEGORIES.CANCELLED, message: "Cancelled." });
    }
  }

  // Shared attempt loop for analysis and downloads.
  async function execute({ operation, buildArgs, signal, timeoutMs = 0, onStatus, onLine, onBeforeRetry, context }) {
    assertAvailable();
    throwIfCancelled(signal);

    const authArgs = getAuthArgs();
    const authConfigured = authArgs.length > 0 && isAuthConfigured();
    const usedStrategies = new Set();
    const failures = [];
    const attemptLog = [];
    let strategy = STRATEGIES.DEFAULT;
    let networkRetries = 0;

    while (true) {
      usedStrategies.add(strategy);
      const args = [
        ...(strategy === STRATEGIES.DEFAULT ? authArgs : []),
        ...buildArgs(strategy),
      ];

      const result = await runTool("yt-dlp", args, {
        signal,
        timeoutMs,
        onStdoutLine: onLine,
        onStderrLine: onLine,
      });

      if (result.cancelled || signal?.aborted) {
        throw new ExtractionError({ category: CATEGORIES.CANCELLED, message: "Cancelled." });
      }

      if (result.code === 0 && !result.timedOut) {
        if (failures.length) {
          logger.log(`[extraction] ${operation} succeeded after ${failures.length + 1} attempts (${strategy})`);
        }
        return result;
      }

      // Redacted before anything is classified, logged or stored, since tool
      // output can echo cookie-file lines.
      const output = redactSensitiveText(result.stderr || result.stdout || "");
      const classification = classifyFailure(output, {
        auth: strategy === STRATEGIES.DEFAULT ? getAuthSettings() : null,
        timedOut: result.timedOut,
      });

      logger.error(`[extraction] ${operation} attempt ${failures.length + 1} (${strategy}) failed: ${classification.category}`);
      failures.push({ ...classification, output });
      attemptLog.push({
        strategy,
        category: classification.category,
        exitCode: result.code,
        durationMs: result.durationMs,
      });

      if (classification.category === CATEGORIES.RATE_LIMITED) {
        markRateLimited();
      }

      const decision = decideNextAttempt({
        operation,
        classification,
        attempts: failures.length,
        usedStrategies,
        networkRetries,
        authConfigured,
        attemptDurationMs: result.durationMs,
        random,
      });

      if (decision.action === "stop") break;

      if (decision.reason === "network") networkRetries += 1;
      if (decision.strategy) strategy = decision.strategy;

      await onBeforeRetry?.();
      onStatus?.({ phase: "retrying", reason: decision.reason });
      await sleep(decision.delayMs, signal);
      throwIfCancelled(signal);
    }

    const reported = chooseReportedFailure(failures);
    const diagnosticsId = diagnostics?.record({
      operation,
      category: reported.category,
      message: reported.message,
      attempts: attemptLog,
      technical: reported.output,
      context: {
        URL: context?.url || "",
        "Engine": getEngineDescription(),
        "YouTube access": authConfigured ? `signed in (${getAuthSettings().mode})` : "automatic (no sign-in)",
      },
    });

    throw new ExtractionError(reported, { diagnosticsId });
  }

  async function analyze({ url, mode, signal, onStatus }) {
    onStatus?.({ phase: mode === "video" ? "analyzing" : "loading-playlist" });

    const result = await execute({
      operation: mode === "video" ? "analyze-video" : "analyze-playlist",
      buildArgs: () => buildAnalyzeArgs({ url, mode }),
      signal,
      timeoutMs: mode === "video" ? ANALYZE_VIDEO_TIMEOUT_MS : ANALYZE_PLAYLIST_TIMEOUT_MS,
      onStatus,
      onLine: (line) => {
        if (isSleepLine(line)) onStatus?.({ phase: "waiting" });
      },
      context: { url },
    });

    try {
      return JSON.parse(result.stdout);
    } catch {
      const diagnosticsId = diagnostics?.record({
        operation: "analyze",
        category: CATEGORIES.UNKNOWN,
        message: "yt-dlp returned data WaveMint could not read",
        technical: result.stderr,
        context: { URL: url, Engine: getEngineDescription() },
      });
      throw new ExtractionError(
        {
          category: CATEGORIES.EXTRACTOR_OUTDATED,
          message: "WaveMint couldn't read YouTube's response. Its YouTube extraction components may need an update.",
        },
        { diagnosticsId },
      );
    }
  }

  async function download({ url, outputTemplate, signal, onStatus, onBeforeRetry }) {
    onStatus?.({ phase: "preparing" });

    await execute({
      operation: "download",
      buildArgs: (strategy) => buildDownloadArgs({ url, outputTemplate, strategy }),
      signal,
      onStatus,
      onBeforeRetry,
      onLine: (line) => {
        const update = parseDownloadProgressLine(line);
        if (update) onStatus?.(update);
      },
      context: { url },
    });
  }

  return {
    analyze,
    assertAvailable,
    download,
    getRateLimitRemainingMs,
    isBusy: () => activeJobs > 0,
    markRateLimited,
    runTool,
  };
}

module.exports = {
  MAX_ATTEMPTS,
  MAX_NETWORK_RETRIES,
  RATE_LIMIT_COOLDOWN_MS,
  SLOW_FAILURE_MS,
  STRATEGIES,
  buildAnalyzeArgs,
  buildDownloadArgs,
  chooseReportedFailure,
  createExtractionManager,
  decideNextAttempt,
  getPacingArgs,
  getRetryDelayMs,
  parseDownloadProgressLine,
};
