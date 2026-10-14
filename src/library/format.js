// Display helpers for the Library UI.

export function formatDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!total) return "–";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatLongDuration(ms) {
  const hours = (Number(ms) || 0) / 3600000;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  const minutes = Math.round(hours * 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)} TB`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`;
  return `${value} B`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

const CODEC_LABELS = {
  mp3: "MP3",
  aac: "AAC",
  alac: "ALAC",
  flac: "FLAC",
  pcm: "PCM",
  unknown: "Unknown",
};

export function codecLabel(codec) {
  return CODEC_LABELS[codec] || String(codec || "Unknown").toUpperCase();
}

/** "MP3 · 128 kbps" / "FLAC · 16-bit/44.1 kHz" */
export function formatQuality(file) {
  if (!file) return "";
  const codec = codecLabel(file.codec);
  if (file.lossless) {
    const depth = file.bit_depth ? `${file.bit_depth}-bit` : "";
    const rate = file.sample_rate ? `${(file.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : "";
    return [codec, [depth, rate].filter(Boolean).join("/")].filter(Boolean).join(" · ");
  }
  return file.bitrate ? `${codec} · ${file.bitrate} kbps` : codec;
}

export function artworkUrl(hash, size = 160) {
  return hash ? `wavemint-art://art/${hash}?size=${size}` : "";
}

export function mediaUrl(fileId) {
  return fileId ? `wavemint-media://file/${fileId}` : "";
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatNumber(count)} ${Number(count) === 1 ? singular : plural}`;
}

export function formatDate(iso) {
  const time = Date.parse(iso || "");
  return time
    ? new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";
}

/** "Oct 13, 2026" */
export function formatShortDate(iso) {
  const time = Date.parse(iso || "");
  return time ? new Date(time).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
}

/** "Today", "Yesterday", "3 days ago", or the date. */
export function formatAddedAgo(iso) {
  const time = Date.parse(iso || "");
  if (!time) return "";
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday - new Date(time).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return "Added today";
  if (days === 1) return "Added yesterday";
  if (days < 7) return `Added ${days} days ago`;
  return `Added ${formatShortDate(iso)}`;
}
