// Reading and writing audio tags with node-taglib-sharp (pure JS port of
// TagLib#). Writes change only the tag areas; the audio stream is left
// byte-identical (verified for MP3, AAC/M4A, ALAC and FLAC).

const crypto = require("crypto");
const path = require("path");
const {
  ByteVector,
  File,
  Id3v2Settings,
  Picture,
  PictureType,
  ReadStyle,
} = require("node-taglib-sharp");

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".m4b", ".aac", ".mp4", ".flac", ".wav", ".aif", ".aiff", ".alac"]);

// Formats whose tags WaveMint writes. WAV and AIFF are scanned and played but
// not edited: their tag support is inconsistent across players (and a test
// write to AIFF dropped the year).
const WRITABLE_EXTENSIONS = new Set([".mp3", ".m4a", ".m4b", ".flac"]);

const EDITABLE_FIELDS = [
  "title",
  "artist",
  "albumArtist",
  "album",
  "genre",
  "year",
  "trackNo",
  "trackTotal",
  "discNo",
  "discTotal",
  "composer",
  "comment",
  "compilation",
];

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function canWriteTags(filePath) {
  return WRITABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function clean(value) {
  // RIFF INFO strings can carry trailing NULs.
  return typeof value === "string" ? value.replace(/\0+$/g, "").replace(/\0/g, " ").trim() : "";
}

function joinList(values) {
  return (Array.isArray(values) ? values : [])
    .map(clean)
    .filter(Boolean)
    .join("; ");
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function describeCodec(description, ext) {
  const text = String(description || "").toLowerCase();
  if (text.includes("alac")) return { codec: "alac", lossless: 1 };
  if (text.includes("mp4a") || text.includes("aac")) return { codec: "aac", lossless: 0 };
  if (text.includes("layer 3") || ext === ".mp3") return { codec: "mp3", lossless: 0 };
  if (text.includes("flac")) return { codec: "flac", lossless: 1 };
  if (text.includes("pcm") || text.includes("aiff")) return { codec: "pcm", lossless: 1 };
  return { codec: text || ext.replace(".", ""), lossless: null };
}

function hashBytes(bytes) {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

/**
 * Reads tags and audio properties. Returns a plain object; throws when the
 * file can't be parsed (callers fall back to FFprobe).
 */
function readTags(filePath, { size = 0 } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  // ID3v2.3 is only forced while writing; forcing it while reading breaks
  // some WAV files.
  Id3v2Settings.forceDefaultVersion = false;
  const file = File.createFromPath(filePath, undefined, ReadStyle.Average);

  try {
    const tag = file.tag;
    const properties = file.properties;
    const durationMs = positiveOrNull(properties?.durationMilliseconds);
    const { codec, lossless } = describeCodec(properties?.description, ext);
    let bitrate = positiveOrNull(properties?.audioBitrate);
    if (!bitrate && durationMs && size) bitrate = Math.round((size * 8) / durationMs);

    let artworkHash = null;
    let artworkMime = null;
    const pictures = tag.pictures || [];
    const front = pictures.find((item) => item.type === PictureType.FrontCover) || pictures[0];
    if (front?.data?.length) {
      artworkHash = hashBytes(front.data.toByteArray());
      artworkMime = front.mimeType || "image/jpeg";
    }

    const year = positiveOrNull(tag.year);

    return {
      title: clean(tag.title),
      artist: joinList(tag.performers),
      albumArtist: joinList(tag.albumArtists),
      album: clean(tag.album),
      genre: clean((tag.genres || [])[0]),
      genres: (tag.genres || []).map(clean).filter(Boolean),
      year: year && year < 10000 ? year : null,
      trackNo: positiveOrNull(tag.track),
      trackTotal: positiveOrNull(tag.trackCount),
      discNo: positiveOrNull(tag.disc),
      discTotal: positiveOrNull(tag.discCount),
      composer: joinList(tag.composers),
      comment: clean(tag.comment),
      compilation: tag.isCompilation ? 1 : 0,
      durationMs,
      bitrate,
      sampleRate: positiveOrNull(properties?.audioSampleRate),
      bitDepth: positiveOrNull(properties?.bitsPerSample),
      channels: positiveOrNull(properties?.audioChannels),
      codec,
      lossless,
      container: ext.replace(".", ""),
      artworkHash,
      artworkMime,
      artworkCount: pictures.length,
      possiblyCorrupt: !!file.isPossiblyCorrupt,
    };
  } finally {
    file.dispose();
  }
}

/** Returns the embedded front cover (or first picture) as bytes, or null. */
function readArtwork(filePath) {
  Id3v2Settings.forceDefaultVersion = false;
  const file = File.createFromPath(filePath, undefined, ReadStyle.None);
  try {
    const pictures = file.tag.pictures || [];
    const front = pictures.find((item) => item.type === PictureType.FrontCover) || pictures[0];
    if (!front?.data?.length) return null;
    return { data: Buffer.from(front.data.toByteArray()), mime: front.mimeType || "image/jpeg" };
  } finally {
    file.dispose();
  }
}

function splitList(value) {
  return String(value || "")
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Writes the given fields (a subset of EDITABLE_FIELDS, plus optional
 * `artwork: { data, mime }` or `artwork: null` to remove pictures) into the
 * file in place. Callers must work on a staged copy (see fileops.cjs).
 */
function writeTags(filePath, fields) {
  if (!canWriteTags(filePath)) {
    throw new Error(`WaveMint doesn't edit tags in ${path.extname(filePath)} files`);
  }

  Id3v2Settings.defaultVersion = 3;
  Id3v2Settings.forceDefaultVersion = true;
  const file = File.createFromPath(filePath, undefined, ReadStyle.None);

  try {
    const tag = file.tag;
    const has = (key) => Object.prototype.hasOwnProperty.call(fields, key);

    if (has("title")) tag.title = fields.title || undefined;
    if (has("artist")) tag.performers = splitList(fields.artist);
    if (has("albumArtist")) tag.albumArtists = splitList(fields.albumArtist);
    if (has("album")) tag.album = fields.album || undefined;
    if (has("genre")) tag.genres = fields.genre ? [fields.genre] : [];
    if (has("year")) tag.year = positiveOrNull(fields.year) || 0;
    if (has("trackNo")) tag.track = positiveOrNull(fields.trackNo) || 0;
    if (has("trackTotal")) tag.trackCount = positiveOrNull(fields.trackTotal) || 0;
    if (has("discNo")) tag.disc = positiveOrNull(fields.discNo) || 0;
    if (has("discTotal")) tag.discCount = positiveOrNull(fields.discTotal) || 0;
    if (has("composer")) tag.composers = splitList(fields.composer);
    if (has("comment")) tag.comment = fields.comment || undefined;
    if (has("compilation")) tag.isCompilation = !!fields.compilation;

    if (has("artwork")) {
      if (fields.artwork?.data) {
        const picture = Picture.fromData(ByteVector.fromByteArray(new Uint8Array(fields.artwork.data)));
        picture.type = PictureType.FrontCover;
        picture.mimeType = fields.artwork.mime || picture.mimeType || "image/jpeg";
        // Other picture types (back cover, artist…) are kept.
        const others = (tag.pictures || []).filter((item) => item.type !== PictureType.FrontCover);
        tag.pictures = [picture, ...others];
      } else {
        tag.pictures = [];
      }
    }

    file.save();
  } finally {
    file.dispose();
    Id3v2Settings.forceDefaultVersion = false;
  }
}

module.exports = {
  AUDIO_EXTENSIONS,
  EDITABLE_FIELDS,
  WRITABLE_EXTENSIONS,
  canWriteTags,
  hashBytes,
  isAudioFile,
  readArtwork,
  readTags,
  writeTags,
};
