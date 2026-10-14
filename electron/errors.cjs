// Structured classification of extraction failures.
//
// yt-dlp reports problems as free text on stderr. classifyFailure() turns
// that text into one of a fixed set of categories, each with a plain-language
// message, the actions the UI may offer, and whether an automatic retry is
// ever appropriate. The UI only ever sees the category and the friendly
// message; the raw text stays in the main process as sanitized diagnostics.
//
// Order matters: more specific signals are checked first. yt-dlp appends
// "please report this issue … yt-dlp -U" to many errors, including plain
// connection failures, so that text alone never means the engine is outdated.

const { classifyAuthFailure } = require("./auth.cjs");

const CATEGORIES = {
  NETWORK_UNAVAILABLE: "network-unavailable",
  NETWORK_TIMEOUT: "network-timeout",
  SERVER_ERROR: "server-error",
  RATE_LIMITED: "rate-limit",
  AUTH_REQUIRED: "auth-required",
  AUTH_EXPIRED: "auth-expired",
  AUTH_UNAVAILABLE: "auth-unavailable",
  BOT_CHECK: "bot-check",
  VIDEO_UNAVAILABLE: "unavailable",
  PRIVATE_CONTENT: "private",
  GEO_RESTRICTED: "geo-restricted",
  UNSUPPORTED_URL: "unsupported-url",
  EXTRACTOR_OUTDATED: "extractor-outdated",
  MEDIA_FORBIDDEN: "media-forbidden",
  MISSING_DEPENDENCY: "dependency",
  POST_PROCESSING: "post-processing",
  CANCELLED: "cancelled",
  UNKNOWN: "unknown",
};

// What the UI may offer for each category. "retry" re-runs the operation,
// "settings" opens YouTube Access settings, "updates" opens the extraction
// engine section. Categories without actions are final for that video.
const CATEGORY_ACTIONS = {
  [CATEGORIES.NETWORK_UNAVAILABLE]: ["retry"],
  [CATEGORIES.NETWORK_TIMEOUT]: ["retry"],
  [CATEGORIES.SERVER_ERROR]: ["retry"],
  [CATEGORIES.RATE_LIMITED]: [],
  [CATEGORIES.AUTH_REQUIRED]: ["settings"],
  [CATEGORIES.AUTH_EXPIRED]: ["settings"],
  [CATEGORIES.AUTH_UNAVAILABLE]: ["settings"],
  [CATEGORIES.BOT_CHECK]: ["retry", "settings"],
  [CATEGORIES.VIDEO_UNAVAILABLE]: [],
  [CATEGORIES.PRIVATE_CONTENT]: ["settings"],
  [CATEGORIES.GEO_RESTRICTED]: [],
  [CATEGORIES.UNSUPPORTED_URL]: [],
  [CATEGORIES.EXTRACTOR_OUTDATED]: ["updates", "retry"],
  [CATEGORIES.MEDIA_FORBIDDEN]: ["updates", "retry"],
  [CATEGORIES.MISSING_DEPENDENCY]: [],
  [CATEGORIES.POST_PROCESSING]: ["retry"],
  [CATEGORIES.CANCELLED]: [],
  [CATEGORIES.UNKNOWN]: ["retry"],
};

// Categories where WaveMint itself may retry automatically (see
// extraction.cjs for the bounded policy). Everything else stops at once.
const TRANSIENT_CATEGORIES = new Set([
  CATEGORIES.NETWORK_UNAVAILABLE,
  CATEGORIES.NETWORK_TIMEOUT,
  CATEGORIES.SERVER_ERROR,
]);

function isYouTubeRateLimitMessage(text) {
  const value = String(text || "");

  return (
    /current session has been rate-limited/i.test(value) ||
    /This content isn[’']t available, try again later/i.test(value) ||
    /exceed(?:ed|ing) the (?:YouTube )?(?:video request )?rate limit/i.test(value) ||
    /HTTP Error 429|429:? Too Many Requests/i.test(value)
  );
}

function isHttp403Text(text) {
  return /HTTP(?: Error)? 403|403:\s*Forbidden/i.test(String(text || ""));
}

// The last "ERROR:" line without the "[extractor] id:" prefix.
function summarizeYtDlpError(text) {
  const errorLines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^ERROR:/i.test(line));
  const lastError = errorLines[errorLines.length - 1];

  if (!lastError) return "";

  const summary = lastError
    .replace(/^ERROR:\s*/i, "")
    .replace(/^\[[^\]]+\]\s*[^:\s]+:\s*/, "")
    .trim();

  return summary.length > 300 ? `${summary.slice(0, 297)}…` : summary;
}

function errorLinesOf(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => /^ERROR:/i.test(line.trim()));
  // When yt-dlp printed no ERROR line (crash, killed process), fall back to
  // the whole output so nothing is missed.
  return lines.length ? lines.join("\n") : String(text || "");
}

const MESSAGES = {
  [CATEGORIES.NETWORK_UNAVAILABLE]:
    "WaveMint couldn't connect to YouTube. Check your internet connection and try again.",
  [CATEGORIES.NETWORK_TIMEOUT]:
    "The connection to YouTube timed out. Check your internet connection and try again.",
  [CATEGORIES.SERVER_ERROR]:
    "YouTube had a temporary problem responding. Try again in a moment.",
  [CATEGORIES.BOT_CHECK]:
    "YouTube asked WaveMint to confirm it isn't a bot. Wait a while and try again. If this keeps happening, signing in under Settings → YouTube Access can help.",
  [CATEGORIES.VIDEO_UNAVAILABLE]: "This video isn't available for extraction.",
  [CATEGORIES.GEO_RESTRICTED]: "This video isn't available in your country.",
  [CATEGORIES.UNSUPPORTED_URL]:
    "This doesn't look like a supported YouTube link. Check the URL and try again.",
  [CATEGORIES.EXTRACTOR_OUTDATED]:
    "WaveMint's YouTube extraction components may need an update.",
  [CATEGORIES.MEDIA_FORBIDDEN]:
    "YouTube refused to send the audio for this video. Checking for an extraction engine update may help; you can also try again later.",
  [CATEGORIES.MISSING_DEPENDENCY]:
    "One of WaveMint's built-in components isn't working. Reinstall WaveMint to repair it.",
  [CATEGORIES.POST_PROCESSING]:
    "WaveMint downloaded the audio but couldn't convert it to MP3. Try again; if it keeps failing, reinstall WaveMint.",
  [CATEGORIES.CANCELLED]: "Cancelled.",
};

function result(category, message, extra = {}) {
  return {
    category,
    message: message || MESSAGES[category] || "",
    actions: CATEGORY_ACTIONS[category] || [],
    transient: TRANSIENT_CATEGORIES.has(category),
    ...extra,
  };
}

/**
 * Classifies yt-dlp output into { category, message, actions, transient }.
 * `auth` is the saved authentication settings (only its mode/browser/path
 * are read) so authentication failures can be explained precisely.
 */
function classifyFailure(text, { auth = null, timedOut = false } = {}) {
  const output = String(text || "");
  const errors = errorLinesOf(output);
  const usingAuth = !!auth && auth.mode && auth.mode !== "none";

  if (timedOut) {
    return result(
      CATEGORIES.NETWORK_TIMEOUT,
      "YouTube took too long to respond and the request was stopped. Check your internet connection and try again.",
    );
  }

  if (isYouTubeRateLimitMessage(output)) {
    return result(
      CATEGORIES.RATE_LIMITED,
      "YouTube is temporarily limiting requests. WaveMint has paused to avoid repeated failures.",
    );
  }

  // Cookie source problems: the configured authentication couldn't be used.
  const authProblem = classifyAuthFailure(output, auth);
  if (authProblem) {
    return result(
      authProblem.stage === "session" ? CATEGORIES.AUTH_EXPIRED : CATEGORIES.AUTH_UNAVAILABLE,
      authProblem.message,
      { authCode: authProblem.code },
    );
  }

  if (/No supported JavaScript runtime|ffprobe and ffmpeg not found|ffmpeg not found|ffprobe not found|ffmpeg-location .* does not exist/i.test(output)) {
    return result(CATEGORIES.MISSING_DEPENDENCY);
  }

  // Connectivity (checked before content errors: a failed connection can
  // surface as "Unable to download webpage" for any URL).
  if (/timed out|TimeoutError|WinError 10060|Read timeout/i.test(errors)) {
    return result(CATEGORIES.NETWORK_TIMEOUT);
  }

  if (
    /getaddrinfo failed|Failed to resolve|Name or service not known|No address associated|nodename nor servname|Temporary failure in name resolution|Network is unreachable|No route to host|WinError 1006[15]|WinError 10051|actively refused|Connection refused|Unable to connect to proxy|NewConnectionError/i.test(
      errors,
    )
  ) {
    return result(CATEGORIES.NETWORK_UNAVAILABLE);
  }

  if (
    /HTTP Error 5\d\d|5\d\d:\s*(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)|Connection reset|WinError 10054|Remote end closed connection|RemoteDisconnected|IncompleteRead|Connection aborted|ConnectionResetError|SSL: UNEXPECTED_EOF|EOF occurred in violation of protocol/i.test(
      errors,
    )
  ) {
    return result(CATEGORIES.SERVER_ERROR);
  }

  if (/is not a valid URL|Unsupported URL|Incomplete YouTube ID|Invalid URL/i.test(errors)) {
    return result(CATEGORIES.UNSUPPORTED_URL);
  }

  if (/This video is private|Private video|This playlist is private|The playlist does not exist|playlist does not exist/i.test(errors)) {
    const isPlaylist = /playlist/i.test(errors);
    return result(
      CATEGORIES.PRIVATE_CONTENT,
      isPlaylist
        ? usingAuth
          ? "This playlist is private or doesn't exist, and the YouTube account WaveMint is using can't open it."
          : "This playlist is private or doesn't exist. If your YouTube account can open it, set up YouTube Access in Settings."
        : usingAuth
          ? "This video is private and the YouTube account WaveMint is using doesn't have access to it."
          : "This video is private. If your YouTube account has access, set up YouTube Access in Settings.",
    );
  }

  if (/members-only content|Join this channel to get access|available to this channel's members/i.test(errors)) {
    return result(
      CATEGORIES.AUTH_REQUIRED,
      "This video is for channel members only. It needs a signed-in YouTube session from an account with access.",
    );
  }

  if (/Sign in to confirm your age|age-restricted|inappropriate for some users/i.test(errors)) {
    return usingAuth
      ? result(
          CATEGORIES.AUTH_EXPIRED,
          "This video requires a signed-in YouTube session, and YouTube didn't accept the current one. Your sign-in may have expired; use Test Authentication in Settings.",
        )
      : result(CATEGORIES.AUTH_REQUIRED, "This video requires a signed-in YouTube session.");
  }

  if (/Sign in to confirm you[’']re not a bot|confirm you[’']re not a bot/i.test(errors)) {
    return usingAuth
      ? result(
          CATEGORIES.AUTH_EXPIRED,
          "YouTube asked for a signed-in session and didn't accept the current one. Refresh your YouTube sign-in in Settings and try again.",
        )
      : result(CATEGORIES.BOT_CHECK);
  }

  if (/not made this video available in your country|not available in your country|geo.?restrict|blocked it in your country/i.test(errors)) {
    return result(CATEGORIES.GEO_RESTRICTED);
  }

  if (
    /Video unavailable|This video is unavailable|This video has been removed|has been terminated|no longer available|This video is no longer|does not exist|This live event will begin|Premieres in|not available yet|This live stream recording is not available|Video is not available/i.test(
      errors,
    )
  ) {
    return result(CATEGORIES.VIDEO_UNAVAILABLE);
  }

  if (isHttp403Text(errors)) {
    return result(CATEGORIES.MEDIA_FORBIDDEN);
  }

  if (/^ERROR: Postprocessing:|ERROR: ffmpeg exited|Conversion failed|audio conversion failed/im.test(output)) {
    return result(CATEGORIES.POST_PROCESSING);
  }

  if (
    /Unable to extract|Failed to extract any player response|Signature extraction failed|nsig extraction failed|n challenge solving failed|Unable to decode n|challenge solving failed|Requested format is not available|No video formats found|Some formats may be missing|jsc.*failed/i.test(
      errors,
    )
  ) {
    return result(CATEGORIES.EXTRACTOR_OUTDATED);
  }

  const summary = summarizeYtDlpError(output);
  return result(
    CATEGORIES.UNKNOWN,
    summary
      ? `WaveMint couldn't process this video. YouTube reported: ${summary}`
      : "WaveMint couldn't process this video.",
  );
}

/**
 * Error thrown to the renderer. Its message carries a "[category:diagId]"
 * tag that the UI strips (see src/ipcErrors.js); diagId identifies the
 * sanitized technical details kept in the main process.
 */
class ExtractionError extends Error {
  constructor(classification, { diagnosticsId = "" } = {}) {
    const tag = diagnosticsId
      ? `${classification.category}:${diagnosticsId}`
      : classification.category;
    super(`[${tag}] ${classification.message}`);
    this.name = "ExtractionError";
    this.category = classification.category;
    this.friendlyMessage = classification.message;
    this.diagnosticsId = diagnosticsId;
  }
}

/**
 * An error whose message carries a "[code]" tag for the UI (see
 * src/ipcErrors.js), for problems outside extraction (engine updates,
 * authentication settings).
 */
function taggedError(code, message) {
  return new Error(`[${code}] ${message}`);
}

module.exports = {
  CATEGORIES,
  CATEGORY_ACTIONS,
  ExtractionError,
  TRANSIENT_CATEGORIES,
  classifyFailure,
  isHttp403Text,
  isYouTubeRateLimitMessage,
  summarizeYtDlpError,
  taggedError,
};
