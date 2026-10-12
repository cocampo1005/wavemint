// Folder and file naming for the Managed Library.
//
// Pattern tokens (missing values collapse cleanly):
//   {albumArtist}  album artist, else artist; compilations -> "Various Artists"
//   {artist}       track artist
//   {album}        album, else "Singles"
//   {year}         release year
//   {disc-}        "2-" when the album has more than one disc, else nothing
//   {track}        two-digit track number
//   {title}        song title
//   {genre}        primary genre
// "/" separates folders. The extension is always the file's own.

const path = require("path");

const DEFAULT_PATTERN = "{albumArtist}/{album}/{disc-}{track} {title}";
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT = 100;
const MAX_TOTAL = 240; // leaves room for the root and keeps other apps (iTunes) happy

/** A single path segment that Windows (and Apple Music) will accept. */
function safeSegment(value, fallback = "Unknown") {
  let text = String(value ?? "")
    // eslint-disable-next-line no-control-regex -- strips control characters
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .replace(/^[. ]+/g, "");
  if (!text) text = fallback;
  if (RESERVED.test(text) || RESERVED.test(text.split(".")[0])) text = `${text}_`;
  if (text.length > MAX_SEGMENT) text = text.slice(0, MAX_SEGMENT).replace(/[. ]+$/g, "");
  return text;
}

function validatePattern(pattern) {
  const value = String(pattern || "").trim();
  if (!value) throw new Error("Enter a naming pattern.");
  if (!/\{title\}/.test(value)) throw new Error("The naming pattern must include {title}.");
  const unknown = [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((token) => !["albumArtist", "artist", "album", "year", "disc-", "track", "title", "genre"].includes(token));
  if (unknown.length) throw new Error(`Unknown naming token: {${unknown[0]}}`);
  if (/(^|\/)\.\.?(\/|$)|^[/\\]|:/.test(value)) throw new Error("The naming pattern can't contain drive letters or .. folders.");
  return value;
}

/** Relative path (without extension) for a track under the pattern. */
function relativePathFor(track, pattern = DEFAULT_PATTERN) {
  const albumArtist = track.compilation ? "Various Artists" : track.album_artist || track.artist || "Unknown Artist";
  const values = {
    albumArtist,
    artist: track.artist || "Unknown Artist",
    album: track.album || "Singles",
    year: track.year ? String(track.year) : "",
    "disc-": track.disc_total > 1 && track.disc_no ? `${track.disc_no}-` : "",
    track: track.track_no ? String(track.track_no).padStart(2, "0") : "",
    title: track.title || "Untitled",
    genre: track.genre || "",
  };

  const segments = validatePattern(pattern)
    .split("/")
    .map((segment) =>
      segment
        .replace(/\{([^}]+)\}/g, (_, token) => values[token] ?? "")
        .replace(/\(\s*\)|\[\s*\]/g, "") // "Album ()" when the year is missing
        .replace(/\s+-\s*$|^\s*-\s+/g, ""),
    )
    .map((segment, index, all) => safeSegment(segment, index === all.length - 1 ? values.title : "Unknown"));

  // Keep the whole relative path within a conservative length.
  let total = segments.join("\\").length;
  for (let index = 0; total > MAX_TOTAL && index < segments.length; index += 1) {
    const excess = total - MAX_TOTAL;
    const shortened = segments[index].slice(0, Math.max(20, segments[index].length - excess)).trim();
    total -= segments[index].length - shortened.length;
    segments[index] = shortened;
  }
  return segments.join(path.sep);
}

/**
 * Plans destination paths for many tracks: unique (case-insensitively) both
 * among themselves and against files that already exist.
 */
function planPaths(items, { root, pattern = DEFAULT_PATTERN, exists = () => false }) {
  const taken = new Set();
  return items.map((item) => {
    const base = relativePathFor(item.track, pattern);
    const ext = item.ext.toLowerCase();
    let candidate = `${base}${ext}`;
    for (let counter = 2; taken.has(candidate.toLowerCase()) || exists(path.join(root, candidate)); counter += 1) {
      candidate = `${base} (${counter})${ext}`;
    }
    taken.add(candidate.toLowerCase());
    return { ...item, relPath: candidate, target: path.join(root, candidate) };
  });
}

module.exports = { DEFAULT_PATTERN, planPaths, relativePathFor, safeSegment, validatePattern };
