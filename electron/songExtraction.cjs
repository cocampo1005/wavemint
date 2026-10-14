// One song from a URL to a finished, tagged MP3:
//   yt-dlp download (extraction.cjs: retries, rate limits, cancellation)
//   → final metadata (the user's edits + the full extraction's details)
//   → cover image (artwork.cjs)
//   → ID3v2.3 tags and cover written by FFmpeg (stream copy, no re-encoding)
//   → the finished file moved into the folder the caller chose.
//
// Each extraction works in its own private folder under %TEMP%\WaveMint, so
// half-finished files never reach the library; only the finished MP3 leaves
// it (outputFiles.cjs).

const fs = require("fs");
const path = require("path");
const { normalizeArtworkMode } = require("./artwork.cjs");
const { CATEGORIES, ExtractionError } = require("./errors.cjs");
const { moveIntoOutputFolder } = require("./outputFiles.cjs");
const { buildFinalFileName, getArtworkThumbnailCandidates, normalizeMetadataText, resolveFinalMetadata } = require("./youtubeMetadata.cjs");

const WORK_FOLDER_PREFIX = "wavemint-temp-";
const STALE_WORK_FOLDER_MS = 24 * 60 * 60 * 1000;

/** FFmpeg arguments that tag an MP3 (and embed `cover` if given) without re-encoding. */
function buildTaggingArgs({ input, cover = null, output, metadata }) {
  const tags = ["title", "artist", "album", "genre"].flatMap((field) => ["-metadata", `${field}=${metadata[field] || ""}`]);
  if (!cover) return ["-y", "-i", input, "-map", "0:a", "-c:a", "copy", "-id3v2_version", "3", ...tags, output];
  return [
    "-y",
    "-i",
    input,
    "-i",
    cover,
    "-map",
    "0:a",
    "-map",
    "1:v",
    "-c:a",
    "copy",
    "-c:v",
    "copy",
    "-disposition:v",
    "attached_pic",
    "-id3v2_version",
    "3",
    ...tags,
    "-metadata:s:v",
    "title=Album cover",
    "-metadata:s:v",
    "comment=Cover (front)",
    output,
  ];
}

/** `filePath`, or "name (1).ext", "name (2).ext"… if it's taken. */
function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let counter = 1; ; counter += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** Leftovers from a crash or forced quit (never recent folders another window may use). */
function removeStaleWorkFolders(workRoot, { now = Date.now() } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_FOLDER_PREFIX)) continue;
    const folder = path.join(workRoot, entry.name);
    try {
      if (now - fs.statSync(folder).mtimeMs > STALE_WORK_FOLDER_MS) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // In use or already gone.
    }
  }
}

function readInfoJson(folder, baseName) {
  try {
    const name = fs.readdirSync(folder).find((file) => file.startsWith(baseName) && file.endsWith(".info.json"));
    return name ? JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")) : null;
  } catch {
    return null;
  }
}

function createSongExtractor({ extraction, artwork, workRoot, diagnostics, describeEngine = () => "" }) {
  // Post-processing failures keep their technical output in diagnostics; the
  // UI gets a short explanation.
  function postProcessingError(message, error, url) {
    if (error instanceof ExtractionError) return error;
    const diagnosticsId = diagnostics?.record({
      operation: "download",
      category: CATEGORIES.POST_PROCESSING,
      message,
      technical: [error?.message, error?.rawMessage].filter(Boolean).join("\n"),
      context: { URL: url, Engine: describeEngine() },
    });
    return new ExtractionError({ category: CATEGORIES.POST_PROCESSING, message }, { diagnosticsId });
  }

  /**
   * Extracts `url` into `outputFolder`. `metadata` is the editable metadata
   * the user saw (see youtubeMetadata.cjs); `thumbnail` the thumbnail shown.
   * Resolves with { filePath, metadata, info } (info: yt-dlp's details).
   */
  async function extract({ url, metadata = {}, thumbnail = "", artworkMode, customFilePath = "", outputFolder, signal, onProgress = () => {} }) {
    const baseName = `${WORK_FOLDER_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const workFolder = path.join(workRoot, baseName);
    fs.mkdirSync(workFolder, { recursive: true });
    const downloaded = path.join(workFolder, `${baseName}.mp3`);
    const tagged = path.join(workFolder, `${baseName}-tagged.mp3`);
    const title = normalizeMetadataText(metadata.title) || "Track";
    const progress = (status) => onProgress({ title, ...status });

    try {
      await extraction.download({
        url,
        outputTemplate: path.join(workFolder, `${baseName}.%(ext)s`),
        signal,
        onStatus: progress,
        // Partial audio and metadata files go before another attempt.
        onBeforeRetry: () => {
          for (const file of fs.readdirSync(workFolder)) fs.rmSync(path.join(workFolder, file), { force: true });
        },
      });
      if (!fs.existsSync(downloaded)) {
        throw postProcessingError("WaveMint downloaded the audio but the MP3 file wasn't created. Try again.", new Error("Temporary MP3 file was not created"), url);
      }

      // --write-info-json carries the details of the same full extraction
      // that downloaded the audio (no extra request).
      const info = readInfoJson(workFolder, baseName);
      const finalMetadata = resolveFinalMetadata(metadata, info);

      progress({ phase: "artwork" });
      let cover;
      try {
        cover = await artwork.prepareCover({
          mode: normalizeArtworkMode(artworkMode),
          customFilePath,
          thumbnailCandidates: getArtworkThumbnailCandidates(info, thumbnail),
          folder: workFolder,
          baseName,
          signal,
        });
      } catch (error) {
        throw postProcessingError(`Failed to prepare artwork: ${error?.message || "Unknown artwork error"}`, error, url);
      }

      progress({ phase: "metadata", title: finalMetadata.title || title });
      try {
        await extraction.runChecked("ffmpeg", buildTaggingArgs({ input: downloaded, cover, output: tagged, metadata: finalMetadata }), { signal });
      } catch (error) {
        throw postProcessingError("WaveMint couldn't write the song details and cover art into the MP3. Try again.", error, url);
      }

      const filePath = uniqueFilePath(path.join(outputFolder, buildFinalFileName(finalMetadata)));
      try {
        moveIntoOutputFolder(tagged, filePath);
      } catch (error) {
        throw postProcessingError("WaveMint couldn't save the finished MP3. Check that there is free space on the drive, then try again.", error, url);
      }
      return { filePath, metadata: finalMetadata, info };
    } finally {
      fs.rmSync(workFolder, { recursive: true, force: true });
    }
  }

  return { extract, postProcessingError };
}

module.exports = { buildTaggingArgs, createSongExtractor, removeStaleWorkFolders, uniqueFilePath };
