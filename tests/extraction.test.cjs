const assert = require("node:assert/strict");
const test = require("node:test");

const { AuthError } = require("../electron/auth.cjs");
const { CATEGORIES, ExtractionError } = require("../electron/errors.cjs");
const { createDiagnosticsStore } = require("../electron/diagnostics.cjs");
const {
  MAX_ATTEMPTS,
  MAX_NETWORK_RETRIES,
  RATE_LIMIT_COOLDOWN_MS,
  SLOW_FAILURE_MS,
  STRATEGIES,
  buildAnalyzeArgs,
  buildDownloadArgs,
  createExtractionManager,
  decideNextAttempt,
  getRetryDelayMs,
  parseDownloadProgressLine,
} = require("../electron/extraction.cjs");

const RUNTIME_ARGS = ["--ignore-config", "--no-plugin-dirs"];

const OUTPUT = {
  ok: { code: 0, stdout: '{"id":"abc","title":"Song"}', stderr: "" },
  network: {
    code: 1,
    stdout: "",
    stderr: "ERROR: [youtube] abc: Unable to download API page: [Errno 11001] getaddrinfo failed",
  },
  forbidden: { code: 1, stdout: "", stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" },
  unavailable: { code: 1, stdout: "", stderr: "ERROR: [youtube] abc: This video is unavailable" },
  age: { code: 1, stdout: "", stderr: "ERROR: [youtube] abc: Sign in to confirm your age." },
  rateLimited: {
    code: 1,
    stdout: "",
    stderr: "ERROR: [youtube] abc: The current session has been rate-limited by YouTube for up to an hour.",
  },
  secret: {
    code: 1,
    stdout: "",
    stderr:
      "WARNING: skipping cookie file entry due to invalid length 6: '.youtube.com\\tTRUE\\t/\\tTRUE\\t0\\tSAPISID'\nERROR: [youtube] abc: This video is unavailable",
  },
};

// Builds a manager whose yt-dlp runs return the scripted results in order.
function setup({ script = [], auth = { mode: "none" }, authArgs = [], now = () => 1000 } = {}) {
  const calls = [];
  const sleeps = [];
  const runCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const next = script.length ? script.shift() : OUTPUT.ok;
    if (typeof next === "function") return next(options);
    return { timedOut: false, cancelled: false, ...next };
  };

  const diagnostics = createDiagnosticsStore({ homeDir: "C:\\Users\\Someone" });
  const manager = createExtractionManager({
    binaries: {
      resolve: (tool) => ({ tool, label: tool, command: `${tool}.exe`, bundled: true }),
      getYtDlpRuntimeArgs: () => RUNTIME_ARGS,
      getChildEnv: () => ({}),
    },
    runCommand,
    getAuthSettings: () => auth,
    buildAuthArgs: () => {
      if (authArgs instanceof Error) throw authArgs;
      return authArgs;
    },
    diagnostics,
    getEngineDescription: () => "yt-dlp test",
    logger: { log() {}, warn() {}, error() {} },
    now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });

  return { manager, calls, sleeps, diagnostics };
}

async function expectExtractionError(promise, category) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExtractionError, `expected ExtractionError, got ${error}`);
    assert.equal(error.category, category);
    return error;
  }
  assert.fail(`expected a ${category} error`);
}

test("analysis arguments: flat playlists, single videos, pacing, URL after --", () => {
  assert.deepEqual(buildAnalyzeArgs({ url: " https://youtu.be/abc ", mode: "video" }), [
    "--sleep-requests",
    "1",
    "--dump-single-json",
    "--no-playlist",
    "--",
    "https://youtu.be/abc",
  ]);

  const playlist = buildAnalyzeArgs({ url: "https://www.youtube.com/playlist?list=PL1", mode: "playlist" });
  assert.ok(playlist.includes("--flat-playlist"));
  assert.ok(!playlist.includes("--no-playlist"));

  // A URL that looks like an option can never be read as one.
  const hostile = buildAnalyzeArgs({ url: "--exec=calc", mode: "video" });
  assert.deepEqual(hostile.slice(-2), ["--", "--exec=calc"]);
});

test("download arguments: MP3, info JSON, pacing, and the mweb fallback client", () => {
  const args = buildDownloadArgs({ url: "https://youtu.be/abc", outputTemplate: "C:\\Music\\t.%(ext)s" });
  for (const expected of ["--no-update", "--write-info-json", "-x", "mp3", "--no-playlist", "--newline"]) {
    assert.ok(args.includes(expected), expected);
  }
  assert.deepEqual(args.slice(args.indexOf("--sleep-interval"), args.indexOf("--sleep-interval") + 4), [
    "--sleep-interval",
    "5",
    "--max-sleep-interval",
    "10",
  ]);
  assert.ok(!args.includes("--extractor-args"));
  assert.deepEqual(args.slice(-2), ["--", "https://youtu.be/abc"]);

  const mweb = buildDownloadArgs({ url: "u", outputTemplate: "o", strategy: STRATEGIES.MWEB });
  assert.deepEqual(mweb.slice(-4), ["--extractor-args", "youtube:player_client=mweb", "--", "u"]);
});

test("runtime and authentication arguments come first, in that order", async () => {
  const { manager, calls } = setup({
    auth: { mode: "cookies_file" },
    authArgs: ["--cookies", "C:\\cookies.txt"],
  });

  await manager.analyze({ url: "https://youtu.be/abc", mode: "video" });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 4), [...RUNTIME_ARGS, "--cookies", "C:\\cookies.txt"]);
});

test("a misconfigured authentication method fails clearly instead of being dropped", async () => {
  const { manager, calls } = setup({
    auth: { mode: "cookies_file" },
    authArgs: new AuthError("cookies_file_missing", "The selected cookie file was not found."),
  });

  const error = await expectExtractionError(
    manager.analyze({ url: "u", mode: "video" }),
    CATEGORIES.AUTH_UNAVAILABLE,
  );
  assert.match(error.message, /cookie file was not found/);
  assert.equal(calls.length, 0);
});

test("transient network failures retry with bounded backoff, then stop", async () => {
  const { manager, calls, sleeps, diagnostics } = setup({
    script: [OUTPUT.network, OUTPUT.network, OUTPUT.network, OUTPUT.network],
  });
  const statuses = [];

  const error = await expectExtractionError(
    manager.analyze({ url: "u", mode: "video", onStatus: (status) => statuses.push(status) }),
    CATEGORIES.NETWORK_UNAVAILABLE,
  );

  assert.equal(calls.length, 1 + MAX_NETWORK_RETRIES);
  assert.deepEqual(sleeps, [2500, 4500]);
  assert.equal(statuses.filter((status) => status.phase === "retrying").length, MAX_NETWORK_RETRIES);
  assert.ok(statuses.every((status) => status.phase !== "retrying" || status.reason === "network"));

  const entry = diagnostics.get(error.diagnosticsId);
  assert.equal(entry.attempts.length, 3);
  assert.equal(entry.category, CATEGORIES.NETWORK_UNAVAILABLE);
});

test("a retry that succeeds returns the result", async () => {
  const { manager, calls } = setup({ script: [OUTPUT.network, OUTPUT.ok] });
  const info = await manager.analyze({ url: "u", mode: "video" });
  assert.equal(info.title, "Song");
  assert.equal(calls.length, 2);
});

test("unavailable, private and sign-in failures stop after one attempt", async () => {
  for (const [output, category] of [
    [OUTPUT.unavailable, CATEGORIES.VIDEO_UNAVAILABLE],
    [OUTPUT.age, CATEGORIES.AUTH_REQUIRED],
  ]) {
    const { manager, calls, sleeps } = setup({ script: [output] });
    await expectExtractionError(manager.download({ url: "u", outputTemplate: "o" }), category);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test("rate limits stop immediately and start a session-wide cooldown", async () => {
  let clock = 1_000_000;
  const { manager, calls } = setup({ script: [OUTPUT.rateLimited], now: () => clock });

  await expectExtractionError(manager.download({ url: "u", outputTemplate: "o" }), CATEGORIES.RATE_LIMITED);
  assert.equal(calls.length, 1);

  // Every further request is refused without contacting YouTube.
  const blocked = await expectExtractionError(
    manager.analyze({ url: "u", mode: "video" }),
    CATEGORIES.RATE_LIMITED,
  );
  assert.match(blocked.message, /about 60 minutes/);
  assert.equal(calls.length, 1);

  clock += RATE_LIMIT_COOLDOWN_MS - 60_000;
  assert.throws(() => manager.assertAvailable(), /about 1 minute\b/);

  clock += 60_000;
  assert.doesNotThrow(() => manager.assertAvailable());
});

test("HTTP 403 without authentication tries the mweb client once", async () => {
  let cleanups = 0;
  const { manager, calls } = setup({ script: [OUTPUT.forbidden, OUTPUT.ok] });

  await manager.download({ url: "u", outputTemplate: "o", onBeforeRetry: () => (cleanups += 1) });

  assert.equal(calls.length, 2);
  assert.ok(!calls[0].args.includes("youtube:player_client=mweb"));
  assert.ok(calls[1].args.includes("youtube:player_client=mweb"));
  assert.equal(cleanups, 1);
});

test("HTTP 403 with authentication: without cookies, then mweb, then stop", async () => {
  const { manager, calls } = setup({
    auth: { mode: "browser", browser: "firefox" },
    authArgs: ["--cookies-from-browser", "firefox"],
    script: [OUTPUT.forbidden, OUTPUT.forbidden, OUTPUT.forbidden, OUTPUT.ok],
  });

  await expectExtractionError(manager.download({ url: "u", outputTemplate: "o" }), CATEGORIES.MEDIA_FORBIDDEN);

  assert.equal(calls.length, 3);
  assert.ok(calls[0].args.includes("--cookies-from-browser"));
  assert.ok(!calls[1].args.includes("--cookies-from-browser"));
  assert.ok(!calls[1].args.includes("youtube:player_client=mweb"));
  assert.ok(calls[2].args.includes("youtube:player_client=mweb"));
});

test("a fallback failing for another reason doesn't hide the original 403", async () => {
  const { manager } = setup({
    auth: { mode: "cookies_file" },
    authArgs: ["--cookies", "c.txt"],
    script: [OUTPUT.forbidden, OUTPUT.age, OUTPUT.unavailable],
  });

  await expectExtractionError(manager.download({ url: "u", outputTemplate: "o" }), CATEGORIES.MEDIA_FORBIDDEN);
});

test("analysis never uses the download fallback ladder", async () => {
  const { manager, calls } = setup({ script: [OUTPUT.forbidden] });
  await expectExtractionError(manager.analyze({ url: "u", mode: "video" }), CATEGORIES.MEDIA_FORBIDDEN);
  assert.equal(calls.length, 1);
});

test("the retry policy never exceeds the attempt limit or repeats a strategy", () => {
  const network = { category: CATEGORIES.NETWORK_TIMEOUT, transient: true };
  const forbidden = { category: CATEGORIES.MEDIA_FORBIDDEN, transient: false };

  assert.deepEqual(
    decideNextAttempt({
      operation: "download",
      classification: network,
      attempts: MAX_ATTEMPTS,
      usedStrategies: new Set(),
      networkRetries: 0,
      authConfigured: false,
    }),
    { action: "stop" },
  );

  assert.equal(
    decideNextAttempt({
      operation: "download",
      classification: forbidden,
      attempts: 2,
      usedStrategies: new Set([STRATEGIES.DEFAULT, STRATEGIES.WITHOUT_AUTH, STRATEGIES.MWEB]),
      networkRetries: 0,
      authConfigured: true,
    }).action,
    "stop",
  );

  const delays = [1, 2, 3, 4, 5].map((retry) => getRetryDelayMs(retry, () => 0.999));
  assert.ok(delays.every((delay) => delay <= 11000));
  assert.ok(getRetryDelayMs(1, () => 0) >= 2000);
});

test("cancellation stops the process and reports 'cancelled'", async () => {
  const controller = new AbortController();
  const { manager, calls } = setup({
    script: [
      (options) => {
        assert.equal(options.signal, controller.signal);
        controller.abort();
        return { code: null, stdout: "", stderr: "", cancelled: true, timedOut: false };
      },
    ],
  });

  await expectExtractionError(
    manager.download({ url: "u", outputTemplate: "o", signal: controller.signal }),
    CATEGORIES.CANCELLED,
  );
  assert.equal(calls.length, 1);

  // An already-cancelled operation never starts a process.
  await expectExtractionError(
    manager.analyze({ url: "u", mode: "video", signal: controller.signal }),
    CATEGORIES.CANCELLED,
  );
  assert.equal(calls.length, 1);
});

test("download progress comes only from real yt-dlp output", () => {
  assert.deepEqual(parseDownloadProgressLine("[download]  42.5% of 3.10MiB at 1.2MiB/s"), {
    phase: "downloading",
    percent: 42.5,
  });
  assert.deepEqual(parseDownloadProgressLine("[download] Sleeping 7.00 seconds as required by the site..."), {
    phase: "waiting",
  });
  assert.deepEqual(parseDownloadProgressLine("[ExtractAudio] Destination: C:\\t.mp3"), { phase: "converting" });
  assert.equal(parseDownloadProgressLine("[youtube] abc: Downloading webpage"), null);
});

test("diagnostics never keep cookie contents from tool output", async () => {
  const { manager, diagnostics } = setup({ script: [OUTPUT.secret] });
  const error = await expectExtractionError(
    manager.download({ url: "u", outputTemplate: "o" }),
    CATEGORIES.VIDEO_UNAVAILABLE,
  );
  const entry = diagnostics.get(error.diagnosticsId);
  assert.doesNotMatch(entry.technical, /SAPISID'|TRUE\\t/);
  assert.match(entry.technical, /redacted/);
});

test("the manager reports whether yt-dlp is running", async () => {
  let release;
  const { manager } = setup({
    script: [() => new Promise((resolve) => (release = () => resolve(OUTPUT.ok)))],
  });

  const pending = manager.analyze({ url: "u", mode: "video" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isBusy(), true);
  release();
  await pending;
  assert.equal(manager.isBusy(), false);
});

test("a slow network failure isn't retried: yt-dlp already retried it", async () => {
  let clock = 0;
  const { manager, calls } = setup({
    now: () => clock,
    script: [
      () => {
        clock += SLOW_FAILURE_MS + 1;
        return { ...OUTPUT.network, timedOut: false, cancelled: false };
      },
    ],
  });

  await expectExtractionError(manager.analyze({ url: "u", mode: "video" }), CATEGORIES.NETWORK_UNAVAILABLE);
  assert.equal(calls.length, 1);
});
