// Interpreting yt-dlp's JSON for YouTube videos and playlists: song details
// (title, artist, album, genre), thumbnails, and the shape the Add Music UI
// receives after an analysis. Pure functions, no I/O.
//
// Metadata comes from, in order of trust: yt-dlp's music fields (track,
// artist, album), the "Provided to YouTube by …" description block that
// YouTube Music uploads carry, then the video's own title and uploader.
// Fields that fall back to the video title/uploader are "provisional": if the
// user doesn't edit them, the full extraction's better data replaces them
// (resolveFinalMetadata).

const METADATA_FIELDS = ["title", "artist", "album", "genre"];

function normalizeMetadataText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** A Windows-safe file name segment (no reserved characters or control codes). */
function sanitizeFileName(value) {
  return (value || "")
    // eslint-disable-next-line no-control-regex -- strips control characters
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFinalFileName(metadata) {
  const artist = sanitizeFileName(metadata?.artist || "Unknown Artist");
  const title = sanitizeFileName(metadata?.title || "Unknown Title");
  return `${artist} - ${title}.mp3`;
}

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || ""));

function getYouTubeEntryUrl(entry) {
  const fullUrl = [entry?.webpage_url, entry?.original_url, entry?.url].find(isHttpUrl);
  if (fullUrl) return fullUrl;
  const videoId = entry?.id || entry?.url;
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

function getYouTubeVideoId(info) {
  if (!info) return null;
  if (info.id) return String(info.id);
  if (typeof info.url === "string" && !isHttpUrl(info.url)) return info.url;

  for (const candidate of [info.webpage_url, info.original_url, info.url]) {
    if (!isHttpUrl(candidate)) continue;
    try {
      const parsedUrl = new URL(candidate);
      const queryId = parsedUrl.searchParams.get("v");
      if (queryId) return queryId;
      const shortMatch = parsedUrl.pathname.match(/^\/([^/?#]+)/);
      if (/youtu\.be$/i.test(parsedUrl.hostname) && shortMatch?.[1]) return shortMatch[1];
    } catch {
      // Not a URL after all.
    }
  }
  return null;
}

/** Thumbnails, not storyboard sprites (which yt-dlp also lists). */
function isUsableThumbnailUrl(value) {
  const url = String(value || "").trim();
  return isHttpUrl(url) && !/\/sb\//i.test(url) && !/storyboard/i.test(url);
}

function getThumbnailUrlQualityRank(url) {
  const value = String(url || "").toLowerCase();
  if (value.includes("maxresdefault")) return 60;
  if (value.includes("hq720")) return 55;
  if (value.includes("sddefault")) return 50;
  if (value.includes("hqdefault")) return 40;
  if (value.includes("mqdefault")) return 30;
  if (value.includes("default")) return 20;
  return 10;
}

function compareThumbnailCandidates(left, right) {
  const leftArea = Number(left?.width || 0) * Number(left?.height || 0);
  const rightArea = Number(right?.width || 0) * Number(right?.height || 0);
  const leftQuality = getThumbnailUrlQualityRank(left?.url);
  const rightQuality = getThumbnailUrlQualityRank(right?.url);

  // When both candidates report dimensions, trust the larger image. When a
  // candidate omits dimensions, recognizable YouTube quality names such as
  // maxresdefault still provide a useful quality signal.
  if (leftArea > 0 && rightArea > 0 && leftArea !== rightArea) return rightArea - leftArea;
  if (leftQuality !== rightQuality) return rightQuality - leftQuality;
  if (leftArea !== rightArea) return rightArea - leftArea;
  const preferenceDifference = Number(right?.preference || 0) - Number(left?.preference || 0);
  if (preferenceDifference !== 0) return preferenceDifference;
  return Number(right?._index || 0) - Number(left?._index || 0);
}

function getExplicitThumbnailCandidates(info) {
  if (!info) return [];
  const candidates = Array.isArray(info.thumbnails)
    ? info.thumbnails
        .map((thumbnail, index) => ({ ...thumbnail, _index: index }))
        .filter((thumbnail) => isUsableThumbnailUrl(thumbnail?.url))
        .sort(compareThumbnailCandidates)
    : [];

  if (isUsableThumbnailUrl(info.thumbnail)) {
    candidates.push({
      url: info.thumbnail.trim(),
      width: Number(info.thumbnail_width || 0),
      height: Number(info.thumbnail_height || 0),
      preference: -1,
      _index: -1,
    });
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const url = String(candidate.url || "").trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

/** The thumbnail shown after an analysis (and used for the artwork preview). */
function getBestThumbnailUrl(info) {
  // Preserve the thumbnail yt-dlp selected; another one reporting larger
  // dimensions is not necessarily the better picture.
  if (isUsableThumbnailUrl(info?.thumbnail)) return info.thumbnail.trim();
  const explicitCandidates = getExplicitThumbnailCandidates(info);
  if (explicitCandidates.length) return explicitCandidates[0].url;
  // Only construct a YouTube thumbnail URL when yt-dlp did not provide one.
  const videoId = getYouTubeVideoId(info);
  return videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg` : null;
}

/**
 * Images to try, in order, for the final artwork. The thumbnail the user saw
 * comes first, so the embedded artwork uses the exact same source image as
 * the preview.
 */
function getArtworkThumbnailCandidates(info, shownThumbnail = "") {
  const candidates = [];
  if (isUsableThumbnailUrl(shownThumbnail)) candidates.push(shownThumbnail.trim());
  if (isUsableThumbnailUrl(info?.thumbnail)) candidates.push(info.thumbnail.trim());
  candidates.push(...getExplicitThumbnailCandidates(info).map((thumbnail) => thumbnail.url));

  // Constructed YouTube URLs are only last-resort fallbacks.
  const videoId = getYouTubeVideoId(info);
  if (videoId) {
    const encodedId = encodeURIComponent(videoId);
    candidates.push(
      `https://i.ytimg.com/vi/${encodedId}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${encodedId}/hq720.jpg`,
      `https://i.ytimg.com/vi/${encodedId}/sddefault.jpg`,
      `https://i.ytimg.com/vi/${encodedId}/hqdefault.jpg`,
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

/** "Artist - Album (Full Album)" → "Album". */
function cleanAlbumName(value, artist = "") {
  let album = normalizeMetadataText(value);
  if (!album) return "";

  const normalizedArtist = normalizeMetadataText(artist);
  const artistCandidates = [normalizedArtist, normalizedArtist.replace(/\s*-\s*Topic$/i, ""), normalizedArtist.split(/\s*[,;&]\s*/)[0]].filter(Boolean);
  for (const artistCandidate of new Set(artistCandidates)) {
    album = album.replace(new RegExp(`^${RegExp.escape(artistCandidate)}\\s*[-–—|:]\\s*`, "i"), "");
  }

  return album
    .replace(/\s*(?:\(|\[)\s*(?:(?:full|official|complete)\s+)*album(?:\s+(?:playlist|audio|stream))?(?:\s+\d{4})?\s*(?:\)|\])\s*$/i, "")
    .replace(/\s*[-–—|:]\s*(?:(?:full|official|complete)\s+)*album(?:\s+\d{4})?\s*$/i, "")
    .trim();
}

/**
 * YouTube Music's auto-generated descriptions:
 *   Provided to YouTube by <label>
 *   <title> · <artist>
 *   <album>
 */
function extractYouTubeMusicDescriptionMetadata(info) {
  const lines = String(info?.description || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const providedIndex = lines.findIndex((line) => /^Provided to YouTube by\b/i.test(line));
  if (providedIndex < 0) return { title: "", artist: "", album: "" };

  const credits = (lines[providedIndex + 1] || "")
    .split(/\s*[·•]\s*/)
    .map(normalizeMetadataText)
    .filter(Boolean);
  const albumCandidate = lines[providedIndex + 2] || "";
  const invalidAlbumLine =
    !albumCandidate || /^(?:℗|©|Released on:|Producer:|Composer:|Mastering Engineer:|Music Publisher:|Auto-generated by YouTube)/i.test(albumCandidate);

  return { title: credits[0] || "", artist: credits[1] || "", album: invalidAlbumLine ? "" : normalizeMetadataText(albumCandidate) };
}

/** YouTube's video categories ("Music", "Entertainment") aren't genres. */
function getUsefulGenre(value) {
  const genre = normalizeMetadataText(value);
  return !genre || /^(?:music|entertainment|people\s*&\s*blogs)$/i.test(genre) ? "" : genre;
}

function getExtractedMetadata(info, fallback = {}) {
  const description = extractYouTubeMusicDescriptionMetadata(info);
  const artist = normalizeMetadataText(info?.artist || info?.album_artist || description.artist || info?.uploader || info?.channel || fallback.artist || "");
  return {
    title: normalizeMetadataText(info?.track || description.title || info?.title || fallback.title),
    artist,
    album: cleanAlbumName(info?.album || description.album || fallback.album || info?.playlist_title || "", artist),
    genre: getUsefulGenre(info?.genre) || getUsefulGenre(fallback.genre),
  };
}

/**
 * The editable metadata sent to the UI. It remembers its initial values and
 * which fields are only guesses, so resolveFinalMetadata() can tell user
 * edits from untouched guesses.
 */
function createEditableMetadata(values, provisional = {}) {
  const normalized = Object.fromEntries(METADATA_FIELDS.map((field) => [field, normalizeMetadataText(values?.[field])]));
  return {
    ...normalized,
    __wavemintInitial: { ...normalized },
    __wavemintProvisional: Object.fromEntries(METADATA_FIELDS.map((field) => [field, !!provisional[field]])),
  };
}

/** Editable metadata for one video, with the guessed fields marked. */
function describeVideo(info, fallback = {}) {
  const description = extractYouTubeMusicDescriptionMetadata(info);
  return createEditableMetadata(getExtractedMetadata(info, fallback), {
    title: !info?.track && !description.title,
    artist: !info?.artist && !info?.album_artist && !description.artist,
    album: !info?.album && !description.album,
    genre: !getUsefulGenre(info?.genre),
  });
}

/**
 * The values written into the file: what the user edited wins; untouched
 * fields take the full extraction's data (which can be better than the
 * flat-playlist analysis), falling back to what was shown.
 */
function resolveFinalMetadata(submittedMetadata, extractedInfo) {
  const submitted = Object.fromEntries(METADATA_FIELDS.map((field) => [field, normalizeMetadataText(submittedMetadata?.[field])]));
  const initial = submittedMetadata?.__wavemintInitial || null;
  const provisional = submittedMetadata?.__wavemintProvisional || {};
  const extracted = getExtractedMetadata(extractedInfo, submitted);

  return Object.fromEntries(
    METADATA_FIELDS.map((field) => {
      const wasEdited = initial ? submitted[field] !== normalizeMetadataText(initial[field]) : provisional[field] === false;
      return [field, wasEdited ? submitted[field] : extracted[field] || submitted[field]];
    }),
  );
}

/** What the renderer receives after analyzing a video or playlist URL. */
function buildAnalysisResult(parsed) {
  const entries = (parsed.entries || []).map((entry) => {
    const artistFallback = entry.artist || entry.album_artist || entry.uploader || parsed.uploader || parsed.channel || "";
    return {
      id: entry.id,
      title: entry.title,
      uploader: entry.uploader || parsed.uploader,
      duration: entry.duration,
      thumbnail: getBestThumbnailUrl(entry),
      webpage_url: getYouTubeEntryUrl(entry),
      selected: true,
      metadata: describeVideo(entry, { artist: artistFallback, album: cleanAlbumName(parsed.title || parsed.playlist_title || "", artistFallback) }),
    };
  });

  return {
    id: parsed.id,
    title: parsed.title,
    uploader: parsed.uploader,
    duration: parsed.duration,
    thumbnail: getBestThumbnailUrl(parsed),
    webpage_url: parsed.webpage_url,
    isPlaylist: !!parsed.entries,
    metadata: describeVideo(parsed, { album: parsed.playlist_title || parsed.title || "" }),
    entries,
  };
}

module.exports = {
  buildAnalysisResult,
  buildFinalFileName,
  cleanAlbumName,
  createEditableMetadata,
  extractYouTubeMusicDescriptionMetadata,
  getArtworkThumbnailCandidates,
  getBestThumbnailUrl,
  getExtractedMetadata,
  getUsefulGenre,
  getYouTubeEntryUrl,
  isUsableThumbnailUrl,
  normalizeMetadataText,
  resolveFinalMetadata,
  sanitizeFileName,
};
