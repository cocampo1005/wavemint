// Artwork for extracted songs: downloading thumbnails, previews for the Add
// Music UI, and the final cover image embedded into the MP3.
//
// Modes (ARTWORK_MODES; mirrored by ARTWORK_OPTIONS in the renderer):
// - original_thumbnail: the thumbnail as published (re-encoded as JPEG);
// - square_crop: a centered square crop of the thumbnail, scaled to
//   1000 × 1000. Always a true center crop: no blur, padding, borders or
//   background layers. The preview and the embedded image come from the same
//   source image and the same FFmpeg filter, so what the user sees is what is
//   written into the file;
// - custom_file: an image the user chose in a main-process dialog.
//
// Downloads only use HTTPS (redirects included), are size- and time-limited,
// and must be valid images (FFprobe reads their dimensions) before use.

const fs = require("fs");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const ARTWORK_MODES = ["original_thumbnail", "square_crop", "custom_file"];
const SQUARE_SIZE = 1000;
const SQUARE_CROP_FILTER = `crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=${SQUARE_SIZE}:${SQUARE_SIZE}:flags=lanczos`;
// Custom image previews are only for display; the original is embedded.
const PREVIEW_FILTER = "scale=min(1200\\,iw):-2:flags=lanczos";
const JPEG_QUALITY = "2"; // FFmpeg -q:v (2 = visually lossless)

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const PREVIEW_CACHE_MAX_ENTRIES = 300;

function normalizeArtworkMode(value) {
  return ARTWORK_MODES.includes(value) ? value : "original_thumbnail";
}

function imageExtensionFromUrl(fileUrl) {
  try {
    const ext = path.extname(new URL(fileUrl).pathname.toLowerCase());
    if (ext === ".png" || ext === ".webp") return ext;
  } catch {
    // Not a URL; JPEG is the safe default.
  }
  return ".jpg";
}

function limitBytes(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      callback(total > maxBytes ? new Error("The artwork image is too large") : null, chunk);
    },
  });
}

/**
 * Downloads an image over HTTPS into `destination` (following at most
 * MAX_REDIRECTS redirects, each of which must also be HTTPS).
 */
async function downloadImage(url, destination, { fetchImpl = fetch, maxBytes = MAX_IMAGE_BYTES, timeoutMs = DOWNLOAD_TIMEOUT_MS, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error("The artwork URL is invalid");
    }
    if (parsed.protocol !== "https:") throw new Error("Artwork is only downloaded over HTTPS");

    const response = await fetchImpl(parsed, {
      redirect: "manual",
      signal: combined,
      headers: { Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WaveMint/1.0" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = new URL(location, parsed).href;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Failed to download the artwork: HTTP ${response.status}`);
    }
    if (Number(response.headers.get("content-length") || 0) > maxBytes) {
      await response.body.cancel();
      throw new Error("The artwork image is too large");
    }
    try {
      await pipeline(Readable.fromWeb(response.body), limitBytes(maxBytes), fs.createWriteStream(destination));
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return destination;
  }
  throw new Error("Too many redirects while downloading the artwork");
}

function fileToDataUrl(filePath, mimeType = "image/jpeg") {
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

/**
 * @param {object} deps
 * @param {(tool: string, args: string[], options?: object) => Promise<{stdout: string}>} deps.runChecked
 *   FFmpeg/FFprobe runner (extraction manager's runChecked).
 * @param {() => string} deps.getTempDir folder for short-lived preview files.
 */
function createArtworkProcessor({ runChecked, getTempDir, download = downloadImage, logger = console }) {
  const previewCache = new Map();
  const previewsInFlight = new Map();

  function tempBase(prefix) {
    return path.join(getTempDir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  }

  async function convertToJpeg(inputPath, outputPath, { filter = null, signal } = {}) {
    await runChecked("ffmpeg", ["-y", "-i", inputPath, ...(filter ? ["-vf", filter] : []), "-frames:v", "1", "-q:v", JPEG_QUALITY, outputPath], { signal });
    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg did not create the prepared artwork file");
    return outputPath;
  }

  async function isValidImage(inputPath) {
    try {
      const { stdout } = await runChecked("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", inputPath]);
      const stream = JSON.parse(stdout)?.streams?.[0];
      return Number(stream?.width) > 0 && Number(stream?.height) > 0;
    } catch (error) {
      logger.warn(`[artwork] Couldn't read image dimensions: ${error?.message || error}`);
      return false;
    }
  }

  /** The first candidate URL that downloads as a valid image, or null if none were given. */
  async function downloadFirstValid(candidates, folder, baseName, { signal } = {}) {
    let lastError = null;
    for (const [index, url] of [...new Set(candidates.filter(Boolean))].entries()) {
      const destination = path.join(folder, `${baseName}-downloaded-artwork-${index}${imageExtensionFromUrl(url)}`);
      try {
        await download(url, destination, { signal });
        if (await isValidImage(destination)) return destination;
        lastError = new Error("The downloaded artwork was not a valid image");
      } catch (error) {
        lastError = error;
      }
      fs.rmSync(destination, { force: true });
    }
    if (lastError) throw lastError;
    return null;
  }

  /**
   * The cover image for an extraction, as a JPEG in `folder`, or null when
   * no thumbnail was available.
   */
  async function prepareCover({ mode, customFilePath = "", thumbnailCandidates = [], folder, baseName, signal }) {
    const output = path.join(folder, `${baseName}-prepared-artwork.jpg`);
    if (mode === "custom_file") {
      if (!customFilePath || !fs.existsSync(customFilePath)) throw new Error("The selected custom artwork file could not be found");
      return convertToJpeg(customFilePath, output, { signal });
    }
    const downloaded = await downloadFirstValid(thumbnailCandidates, folder, baseName, { signal });
    if (!downloaded) return null;
    return convertToJpeg(downloaded, output, { filter: mode === "square_crop" ? SQUARE_CROP_FILTER : null, signal });
  }

  async function makeSquarePreview(thumbnailUrl) {
    const base = tempBase("wavemint-square-preview");
    const source = `${base}-source${imageExtensionFromUrl(thumbnailUrl)}`;
    const preview = `${base}-preview.jpg`;
    try {
      await download(thumbnailUrl, source);
      await convertToJpeg(source, preview, { filter: SQUARE_CROP_FILTER });
      return fileToDataUrl(preview);
    } catch (error) {
      throw new Error(`Failed to generate square artwork preview: ${error?.message || "Unknown preview error"}`);
    } finally {
      fs.rmSync(source, { force: true });
      fs.rmSync(preview, { force: true });
    }
  }

  /**
   * The square-crop preview of a thumbnail, as a data URL. Made once per
   * session per thumbnail; concurrent requests share the work.
   */
  function squarePreview(thumbnailUrl) {
    if (previewCache.has(thumbnailUrl)) return Promise.resolve(previewCache.get(thumbnailUrl));
    if (!previewsInFlight.has(thumbnailUrl)) {
      previewsInFlight.set(
        thumbnailUrl,
        makeSquarePreview(thumbnailUrl)
          .then((dataUrl) => {
            previewCache.set(thumbnailUrl, dataUrl);
            while (previewCache.size > PREVIEW_CACHE_MAX_ENTRIES) previewCache.delete(previewCache.keys().next().value);
            return dataUrl;
          })
          .finally(() => previewsInFlight.delete(thumbnailUrl)),
      );
    }
    return previewsInFlight.get(thumbnailUrl);
  }

  /** A display-size preview of a custom image, as a data URL. */
  async function customPreview(filePath) {
    const preview = `${tempBase("wavemint-custom-preview")}.jpg`;
    try {
      await convertToJpeg(filePath, preview, { filter: PREVIEW_FILTER });
      return fileToDataUrl(preview);
    } finally {
      fs.rmSync(preview, { force: true });
    }
  }

  return { customPreview, prepareCover, squarePreview };
}

module.exports = {
  ARTWORK_MODES,
  SQUARE_CROP_FILTER,
  createArtworkProcessor,
  downloadImage,
  imageExtensionFromUrl,
  normalizeArtworkMode,
};
