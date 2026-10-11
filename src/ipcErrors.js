// Errors thrown by main-process IPC handlers arrive wrapped as
// "Error invoking remote method '<channel>': Error: <message>". WaveMint's own
// actionable errors also start with a "[code]" or "[code:diagnosticsId]" tag
// (see createUserError in electron/main.cjs and ExtractionError in
// electron/errors.cjs), e.g. "[auth]", "[rate-limit]" or "[network-timeout:x1]".
export function parseIpcError(error, fallback = "Something went wrong") {
  // Electron prefixes the error's class name ("Error:", "ExtractionError:").
  let message = String(error?.message || error || "")
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^[A-Za-z]*Error:\s*/, "");
  const match = /^\[([a-z-]+)(?::([a-z0-9]+))?\]\s*/.exec(message);

  if (match) {
    message = message.slice(match[0].length);
  }

  return {
    message: message || fallback,
    code: match ? match[1] : "",
    diagnosticsId: match?.[2] || "",
  };
}

// Mirrors CATEGORY_ACTIONS in electron/errors.cjs. "retry" re-runs the
// operation, "settings" opens YouTube Access, "updates" opens the extraction
// engine section of Settings.
const ACTIONS_BY_CODE = {
  "network-unavailable": ["retry"],
  "network-timeout": ["retry"],
  "server-error": ["retry"],
  "rate-limit": [],
  "auth-required": ["settings"],
  "auth-expired": ["settings"],
  "auth-unavailable": ["settings"],
  auth: ["settings"],
  "bot-check": ["retry", "settings"],
  unavailable: [],
  private: ["settings"],
  "geo-restricted": [],
  "unsupported-url": [],
  "extractor-outdated": ["updates", "retry"],
  "media-forbidden": ["updates", "retry"],
  dependency: [],
  "post-processing": ["retry"],
  cancelled: [],
  unknown: ["retry"],
};

export function getErrorActions(code) {
  return ACTIONS_BY_CODE[code] || [];
}

// A playlist batch skips tracks with these problems and continues; anything
// else stops the batch because it would affect the remaining tracks too.
const SKIPPABLE_IN_BATCH = new Set([
  "unavailable",
  "private",
  "geo-restricted",
  "auth-required",
  "media-forbidden",
  "post-processing",
  "unsupported-url",
  "unknown",
]);

export function isSkippableInBatch(code) {
  return SKIPPABLE_IN_BATCH.has(code);
}
