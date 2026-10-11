// Technical details for failed operations, kept in the main process.
//
// The UI shows friendly messages only. When the user expands "Technical
// details" or copies them, it asks for a diagnostics entry by id. Everything
// stored here has already been sanitized: cookie values, authentication and
// session tokens, signed media URLs, sensitive headers and the user's home
// folder are removed before the text is kept.

const os = require("os");
const { redactSensitiveText } = require("./auth.cjs");

const MAX_ENTRIES = 25;
const MAX_TECHNICAL_LINES = 80;
const MAX_LINE_LENGTH = 600;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes credentials and personal details from tool output.
 * `homeDir` is replaced by %USERPROFILE% so paths stay readable.
 */
function sanitizeDiagnosticText(text, { homeDir = os.homedir() } = {}) {
  let value = redactSensitiveText(text);

  // Signed media and API URLs: keep the host and path, drop the query.
  value = value.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (url) => {
    const queryIndex = url.indexOf("?");
    if (queryIndex < 0) return url;
    const base = url.slice(0, queryIndex);
    return /googlevideo\.com|youtube\.com\/(?:api|youtubei)|\/videoplayback/i.test(url)
      ? `${base}?[redacted]`
      : /[?&](?:sig|signature|pot|token|key|n|lsig|cpn|ei|ip)=/i.test(url)
        ? `${base}?[redacted]`
        : url;
  });

  value = value
    // PO tokens, visitor data and other session identifiers in any form.
    .replace(/\b(po_?token|pot|visitor_?data|visitorData|x-goog-visitor-id|x-youtube-identity-token|sapisidhash|id_?token|access_?token|refresh_?token|api_?key)(["']?\s*[:=]\s*["']?)[^\s"',;&)]+/gi, "$1$2[redacted]")
    .replace(/\b(mweb|web|tv|android|ios|web_safari|web_music)\.(gvs|player|subs)\+[^\s"',;]+/gi, "$1.$2+[redacted]")
    // HTTP headers that can carry credentials.
    .replace(/(["']?(?:Cookie|Set-Cookie|Authorization|X-Goog-AuthUser|X-Origin)["']?\s*[:=]\s*)(["'])?[^"'\r\n]*\2?/gi, "$1[redacted]")
    // Long base64/url-safe blobs (tokens) that slipped through.
    .replace(/[A-Za-z0-9_-]{120,}={0,2}/g, "[redacted]");

  if (homeDir && homeDir.length > 3) {
    const pattern = new RegExp(escapeRegExp(homeDir).replace(/\\\\/g, "[\\\\/]"), "gi");
    value = value.replace(pattern, "%USERPROFILE%");
    // yt-dlp prints Python reprs, where backslashes are doubled.
    const doubled = homeDir.replace(/\\/g, "\\\\");
    value = value.split(doubled).join("%USERPROFILE%");
  }

  return value;
}

function trimTechnical(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    // Progress lines carry no diagnostic value and crowd out the error.
    .filter((line) => !/^\[download\]\s+\d+(?:\.\d+)?%/.test(line.trim()))
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));

  return lines.slice(-MAX_TECHNICAL_LINES).join("\n");
}

function createDiagnosticsStore({ homeDir = os.homedir(), now = () => new Date(), maxEntries = MAX_ENTRIES } = {}) {
  const entries = new Map();
  let counter = 0;

  function record({ operation, category, message, attempts = [], technical = "", context = {} }) {
    counter += 1;
    const id = `${Date.now().toString(36)}${counter.toString(36)}`;

    entries.set(id, {
      id,
      at: now().toISOString(),
      operation: String(operation || ""),
      category: String(category || ""),
      message: String(message || ""),
      attempts: attempts.map((attempt) => ({
        strategy: String(attempt.strategy || ""),
        category: String(attempt.category || ""),
        exitCode: attempt.exitCode ?? null,
        durationMs: Number(attempt.durationMs) || 0,
      })),
      context: Object.fromEntries(
        Object.entries(context).map(([key, value]) => [
          key,
          sanitizeDiagnosticText(String(value ?? ""), { homeDir }),
        ]),
      ),
      technical: trimTechnical(sanitizeDiagnosticText(technical, { homeDir })),
    });

    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }

    return id;
  }

  function get(id) {
    return entries.get(String(id || "")) || null;
  }

  return { record, get };
}

/** Plain-text report suitable for the clipboard or a support request. */
function formatDiagnostics(entry, { appVersion = "", engine = "" } = {}) {
  if (!entry) return "";

  const lines = [
    "WaveMint error details",
    `Time: ${entry.at}`,
    appVersion && `WaveMint: ${appVersion}`,
    engine && `Extraction engine: ${engine}`,
    `Operation: ${entry.operation}`,
    `Category: ${entry.category}`,
    `Message: ${entry.message}`,
    ...Object.entries(entry.context).map(([key, value]) => `${key}: ${value}`),
  ].filter(Boolean);

  if (entry.attempts.length) {
    lines.push("", "Attempts:");
    entry.attempts.forEach((attempt, index) => {
      lines.push(
        `  ${index + 1}. ${attempt.strategy || "default"} → ${attempt.category || "ok"} (exit ${
          attempt.exitCode ?? "n/a"
        }, ${Math.round(attempt.durationMs / 100) / 10}s)`,
      );
    });
  }

  if (entry.technical) {
    lines.push("", "Output (sanitized):", entry.technical);
  }

  return lines.join("\n");
}

module.exports = {
  createDiagnosticsStore,
  formatDiagnostics,
  sanitizeDiagnosticText,
};
