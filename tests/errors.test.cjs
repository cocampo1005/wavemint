const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CATEGORIES,
  ExtractionError,
  classifyFailure,
  isHttp403Text,
  isYouTubeRateLimitMessage,
  summarizeYtDlpError,
} = require("../electron/errors.cjs");

// Recorded from the bundled yt-dlp 2026.08.19 (see docs/ENGINEERING.md,
// "Baseline"). yt-dlp appends "please report this issue … yt-dlp -U" even to
// plain connection failures.
const REPORT_SUFFIX =
  "; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template. Confirm you are on the latest version using  yt-dlp -U";

const FIXTURES = {
  refused: `WARNING: [youtube] jNQXAC9IVRw: Unable to download webpage: ('Unable to connect to proxy', NewConnectionError("HTTPSConnection(host='127.0.0.1', port=9): Failed to establish a new connection: [WinError 10061] No connection could be made because the target machine actively refused it"))${REPORT_SUFFIX}
ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: ('Unable to connect to proxy', NewConnectionError("HTTPSConnection(host='127.0.0.1', port=9): Failed to establish a new connection: [WinError 10061] No connection could be made because the target machine actively refused it"))${REPORT_SUFFIX}`,
  dns: `ERROR: [generic] video: Unable to download webpage: HTTPSConnection(host='nonexistent-host.invalid', port=443): Failed to resolve 'nonexistent-host.invalid' ([Errno 11001] getaddrinfo failed) (caused by TransportError("HTTPSConnection(host='nonexistent-host.invalid', port=443): Failed to resolve 'nonexistent-host.invalid' ([Errno 11001] getaddrinfo failed)"))`,
  timeout: `ERROR: [youtube] jNQXAC9IVRw: Unable to download API page: ('Unable to connect to proxy', ConnectTimeoutError(<HTTPSConnection(host='10.255.255.1', port=8080) at 0x1c6458075e0>, 'Connection to 10.255.255.1 timed out. (connect timeout=2.0)'))${REPORT_SUFFIX}`,
  readTimeout: "ERROR: [download] Got error: The read operation timed out",
  serverError: `ERROR: [youtube] abc: Unable to download API page: HTTP Error 503: Service Unavailable${REPORT_SUFFIX}`,
  reset: "ERROR: [download] Got error: ('Connection aborted.', ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host', None, 10054, None))",
  unavailable: "[debug] [youtube] aaaaaaaaaaa: web player response playability status: ERROR\nERROR: [youtube] aaaaaaaaaaa: This video is unavailable",
  removed: "ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader",
  terminated: "ERROR: [youtube] abc: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.",
  private: "ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video. Use --cookies-from-browser or --cookies for the authentication.",
  privatePlaylist: "ERROR: [youtube:tab] PLxyz: The playlist does not exist.",
  age: "ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.",
  bot: "ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.",
  members: "ERROR: [youtube] abc: Join this channel to get access to members-only content like this video, and other exclusive perks.",
  geo: "ERROR: [youtube] abc: The uploader has not made this video available in your country",
  badUrl: "ERROR: [generic] 'not a url' is not a valid URL",
  unsupported: "ERROR: Unsupported URL: https://example.com/",
  forbidden: "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  rateLimited: "ERROR: [youtube] abc: Video unavailable. This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
  tooMany: "ERROR: [youtube] abc: Unable to download API page: HTTP Error 429: Too Many Requests",
  outdated: `ERROR: [youtube] abc: Failed to extract any player response${REPORT_SUFFIX}`,
  signature: "ERROR: [youtube] abc: Signature extraction failed: Some formats may be missing",
  noFormats: "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats",
  noRuntime: "WARNING: [youtube] No supported JavaScript runtime could be found.\nERROR: [youtube] abc: Requested format is not available",
  noFfmpeg: "ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location",
  postprocessing: "ERROR: Postprocessing: audio conversion failed: Error opening output files: Invalid argument",
  cookiesLocked: "ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info",
  cookiesExpired: "WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure.\nERROR: [youtube] abc: Sign in to confirm you’re not a bot.",
  unknown: "ERROR: [youtube] abc: Something entirely new happened",
};

const EXPECTED = {
  refused: CATEGORIES.NETWORK_UNAVAILABLE,
  dns: CATEGORIES.NETWORK_UNAVAILABLE,
  timeout: CATEGORIES.NETWORK_TIMEOUT,
  readTimeout: CATEGORIES.NETWORK_TIMEOUT,
  serverError: CATEGORIES.SERVER_ERROR,
  reset: CATEGORIES.SERVER_ERROR,
  unavailable: CATEGORIES.VIDEO_UNAVAILABLE,
  removed: CATEGORIES.VIDEO_UNAVAILABLE,
  terminated: CATEGORIES.VIDEO_UNAVAILABLE,
  private: CATEGORIES.PRIVATE_CONTENT,
  privatePlaylist: CATEGORIES.PRIVATE_CONTENT,
  age: CATEGORIES.AUTH_REQUIRED,
  bot: CATEGORIES.BOT_CHECK,
  members: CATEGORIES.AUTH_REQUIRED,
  geo: CATEGORIES.GEO_RESTRICTED,
  badUrl: CATEGORIES.UNSUPPORTED_URL,
  unsupported: CATEGORIES.UNSUPPORTED_URL,
  forbidden: CATEGORIES.MEDIA_FORBIDDEN,
  rateLimited: CATEGORIES.RATE_LIMITED,
  tooMany: CATEGORIES.RATE_LIMITED,
  outdated: CATEGORIES.EXTRACTOR_OUTDATED,
  signature: CATEGORIES.EXTRACTOR_OUTDATED,
  noFormats: CATEGORIES.EXTRACTOR_OUTDATED,
  noRuntime: CATEGORIES.MISSING_DEPENDENCY,
  noFfmpeg: CATEGORIES.MISSING_DEPENDENCY,
  postprocessing: CATEGORIES.POST_PROCESSING,
  unknown: CATEGORIES.UNKNOWN,
};

test("yt-dlp failures map to structured categories", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    assert.equal(classifyFailure(FIXTURES[name]).category, expected, name);
  }
});

test("connection failures are never mistaken for an outdated extractor", () => {
  for (const name of ["refused", "dns", "timeout", "serverError"]) {
    const result = classifyFailure(FIXTURES[name]);
    assert.notEqual(result.category, CATEGORIES.EXTRACTOR_OUTDATED, name);
    assert.equal(result.transient, true, name);
    assert.deepEqual(result.actions, ["retry"], name);
  }
});

test("final answers are not retryable and offer no pointless retry", () => {
  for (const name of ["unavailable", "geo", "badUrl", "rateLimited"]) {
    const result = classifyFailure(FIXTURES[name]);
    assert.equal(result.transient, false, name);
    assert.equal(result.actions.includes("retry"), false, name);
  }
});

test("messages are written for people, not copied from yt-dlp", () => {
  for (const name of Object.keys(EXPECTED)) {
    const { message } = classifyFailure(FIXTURES[name]);
    assert.ok(message, name);
    assert.doesNotMatch(message, /yt-dlp -U|--cookies|github\.com|WinError|Traceback/i, name);
  }

  assert.equal(
    classifyFailure(FIXTURES.refused).message,
    "WaveMint couldn't connect to YouTube. Check your internet connection and try again.",
  );
  assert.equal(classifyFailure(FIXTURES.unavailable).message, "This video isn't available for extraction.");
});

test("sign-in problems depend on whether authentication is configured", () => {
  const auth = { mode: "cookies_file", cookiesFilePath: "C:\\Users\\me\\cookies.txt" };

  assert.equal(classifyFailure(FIXTURES.age).category, CATEGORIES.AUTH_REQUIRED);
  assert.equal(classifyFailure(FIXTURES.age, { auth }).category, CATEGORIES.AUTH_EXPIRED);
  assert.equal(classifyFailure(FIXTURES.bot).category, CATEGORIES.BOT_CHECK);
  assert.equal(classifyFailure(FIXTURES.bot, { auth }).category, CATEGORIES.AUTH_EXPIRED);
  assert.match(classifyFailure(FIXTURES.private, { auth }).message, /doesn't have access/);
});

test("cookie source problems are reported as unavailable or expired authentication", () => {
  const browserAuth = { mode: "browser", browser: "edge" };
  const locked = classifyFailure(FIXTURES.cookiesLocked, { auth: browserAuth });
  assert.equal(locked.category, CATEGORIES.AUTH_UNAVAILABLE);
  assert.match(locked.message, /Edge is using them/);

  const expired = classifyFailure(FIXTURES.cookiesExpired, { auth: browserAuth });
  assert.equal(expired.category, CATEGORIES.AUTH_EXPIRED);

  // Without authentication configured, cookie messages aren't about the user.
  assert.notEqual(classifyFailure(FIXTURES.cookiesLocked).category, CATEGORIES.AUTH_UNAVAILABLE);
});

test("a timed-out process is a timeout whatever it printed", () => {
  assert.equal(classifyFailure("", { timedOut: true }).category, CATEGORIES.NETWORK_TIMEOUT);
});

test("403 detection is limited to real HTTP 403 responses", () => {
  assert.equal(isHttp403Text(FIXTURES.forbidden), true);
  assert.equal(isHttp403Text("Downloading 403 formats"), false);
  // A 403 that comes with a clearer explanation is classified by that.
  assert.equal(
    classifyFailure(`${FIXTURES.forbidden}\n${FIXTURES.geo}`).category,
    CATEGORIES.GEO_RESTRICTED,
  );
});

test("rate-limit detection", () => {
  assert.equal(isYouTubeRateLimitMessage(FIXTURES.rateLimited), true);
  assert.equal(isYouTubeRateLimitMessage(FIXTURES.tooMany), true);
  assert.equal(isYouTubeRateLimitMessage(FIXTURES.unavailable), false);
});

test("unknown failures summarize yt-dlp's last error line", () => {
  assert.equal(summarizeYtDlpError(FIXTURES.unknown), "Something entirely new happened");
  assert.match(classifyFailure(FIXTURES.unknown).message, /Something entirely new happened/);
  assert.equal(classifyFailure("").category, CATEGORIES.UNKNOWN);
});

test("ExtractionError tags its message for the renderer", () => {
  const error = new ExtractionError(
    { category: CATEGORIES.VIDEO_UNAVAILABLE, message: "This video isn't available for extraction." },
    { diagnosticsId: "abc1" },
  );
  assert.equal(error.message, "[unavailable:abc1] This video isn't available for extraction.");
  assert.equal(error.category, CATEGORIES.VIDEO_UNAVAILABLE);

  const untagged = new ExtractionError({ category: CATEGORIES.CANCELLED, message: "Cancelled." });
  assert.equal(untagged.message, "[cancelled] Cancelled.");
});
