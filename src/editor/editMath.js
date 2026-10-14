// Pure helpers for the audio editor: keeping trims and fades valid, the
// fade envelope (the same linear ramps FFmpeg's afade applies when saving),
// and time formatting. Times are in milliseconds.

export const MIN_LENGTH_MS = 1000;
export const MAX_FADE_MS = 30000;
export const PREVIEW_EDGE_MS = 5000;

export function initialEdits(durationMs) {
  return { startMs: 0, endMs: Math.max(0, Math.round(durationMs || 0)), fadeInMs: 0, fadeOutMs: 0 };
}

export function hasChanges(edits, durationMs) {
  return edits.startMs > 0 || edits.endMs < Math.round(durationMs) || edits.fadeInMs > 0 || edits.fadeOutMs > 0;
}

/**
 * Keeps edits valid: start/end inside the song with at least a second
 * between them, and both fades inside the trimmed region. `changed` names the
 * value the user just moved, so the other values give way to it.
 */
export function clampEdits(edits, durationMs, changed = null) {
  const total = Math.max(0, Math.round(durationMs || 0));
  const minLength = Math.min(MIN_LENGTH_MS, total);
  let startMs = Math.round(Math.min(Math.max(0, edits.startMs || 0), total));
  let endMs = Math.round(Math.min(Math.max(0, edits.endMs ?? total), total));
  if (changed === "endMs") {
    endMs = Math.max(endMs, minLength);
    startMs = Math.min(startMs, endMs - minLength);
  } else {
    startMs = Math.min(startMs, total - minLength);
    endMs = Math.max(endMs, startMs + minLength);
  }
  const length = endMs - startMs;
  let fadeInMs = Math.round(Math.min(Math.max(0, edits.fadeInMs || 0), MAX_FADE_MS, length));
  let fadeOutMs = Math.round(Math.min(Math.max(0, edits.fadeOutMs || 0), MAX_FADE_MS, length));
  if (fadeInMs + fadeOutMs > length) {
    if (changed === "fadeOutMs") fadeInMs = length - fadeOutMs;
    else fadeOutMs = length - fadeInMs;
  }
  return { startMs, endMs, fadeInMs, fadeOutMs };
}

/** The largest value a fade may take next to the other one. */
export function maxFade(edits, which) {
  const length = edits.endMs - edits.startMs;
  const other = which === "fadeInMs" ? edits.fadeOutMs : edits.fadeInMs;
  return Math.max(0, Math.min(MAX_FADE_MS, length - other));
}

/** Volume (0–1) at time `ms` of the original audio once the edits apply. */
export function gainAt(ms, edits) {
  if (ms < edits.startMs || ms > edits.endMs) return 0;
  let gain = 1;
  if (edits.fadeInMs > 0) gain = Math.min(gain, (ms - edits.startMs) / edits.fadeInMs);
  if (edits.fadeOutMs > 0) gain = Math.min(gain, (edits.endMs - ms) / edits.fadeOutMs);
  return Math.max(0, Math.min(1, gain));
}

/** "1:05.3" (tenths), "1:05.32" (digits: 2), or "1:05" (tenths: false) */
export function formatTime(ms, { tenths = true, digits = tenths ? 1 : 0 } = {}) {
  const value = Math.max(0, Number(ms) || 0);
  const unit = 10 ** (3 - digits); // ms per smallest shown step
  const steps = Math.round(value / unit);
  const perSecond = 1000 / unit;
  const minutes = Math.floor(steps / (60 * perSecond));
  const seconds = Math.floor((steps % (60 * perSecond)) / perSecond);
  const rest = steps % perSecond;
  return `${minutes}:${String(seconds).padStart(2, "0")}${digits ? `.${String(rest).padStart(digits, "0")}` : ""}`;
}

export const MIN_VIEW_MS = 1000;

/**
 * Zooms the visible window { startMs, spanMs } by `factor` (>1 zooms in)
 * around `anchorMs`, which keeps its place on screen. The window stays
 * inside the song and never shows less than MIN_VIEW_MS.
 */
export function zoomView(view, factor, anchorMs, durationMs) {
  const spanMs = Math.min(durationMs, Math.max(Math.min(MIN_VIEW_MS, durationMs), view.spanMs / factor));
  const anchor = Math.min(Math.max(anchorMs, view.startMs), view.startMs + view.spanMs);
  const startMs = anchor - ((anchor - view.startMs) / view.spanMs) * spanMs;
  return clampView({ startMs, spanMs }, durationMs);
}

export function clampView(view, durationMs) {
  const spanMs = Math.min(durationMs, Math.max(Math.min(MIN_VIEW_MS, durationMs), view.spanMs));
  return { startMs: Math.round(Math.min(Math.max(0, view.startMs), Math.max(0, durationMs - spanMs))), spanMs: Math.round(spanMs) };
}

/** Accepts "1:05.3", "65.3", "1:05" or "0:01:05"; returns ms or null. */
export function parseTime(text) {
  const value = String(text || "").trim();
  if (!/^\d+(:\d{1,2})*(\.\d+)?$/.test(value)) return null;
  const parts = value.split(":");
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/** A timeline step (ms) that gives roughly one label per `minPx` pixels. */
export function tickStep(durationMs, widthPx, minPx = 80) {
  const steps = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
  const wanted = (durationMs / Math.max(1, widthPx)) * minPx;
  return steps.find((step) => step >= wanted) || steps.at(-1);
}
