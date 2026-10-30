// Artwork for extracted songs: downloading thumbnails, previews for the Add
// Music UI, and the final cover image embedded into the MP3.
//
// Modes (ARTWORK_MODES; mirrored by ARTWORK_OPTIONS in the renderer):
// - original_thumbnail: the thumbnail as published (re-encoded as JPEG);
// - square_crop: square artwork, scaled to 1000 × 1000 (see below). Never
//   padded, blurred, stretched or layered: only cropped;
// - custom_file: an image the user chose in a main-process dialog.
//
// Square artwork, step by step:
//   1. The source picture. For a square video (album art videos usually
//      are) a still of the video itself when it is better: YouTube's
//      auto-generated "art tracks", a video that is one still image, or a
//      still that shows the same picture as the thumbnail at a higher
//      resolution. Otherwise the largest version of the video's thumbnail
//      (YouTube publishes several sizes of the same picture; playlist entries
//      only list small ones).
//   2. The framing. YouTube fits non-16:9 videos into its thumbnails with
//      bars (a square cover sits in a 1280 × 720 thumbnail with bars left and
//      right; in 4:3 thumbnails also above and below). Bars are found from
//      the pixels and removed only when what remains has a standard frame
//      shape (square, 4:3, 16:9 or their portrait forms); anything else keeps
//      the whole image. Then a centered square, so an ordinary widescreen
//      thumbnail is center-cropped as before and a square picture isn't
//      cropped at all.
//   3. Preview = cover. The square image is made once per video (the
//      preview) and the very same file is embedded, so what the user sees is
//      what is written into the file.
//
// Downloads only use HTTPS (redirects included), are size- and time-limited,
// and must be valid images (FFprobe reads their dimensions) before use.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { getHighResThumbnailCandidates } = require("./youtubeMetadata.cjs");

const ARTWORK_MODES = ["original_thumbnail", "square_crop", "custom_file"];
const SQUARE_SIZE = 1000;
// The center square of an image (also what's left after bars were removed).
const SQUARE_CROP_FILTER = `crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2,scale=${SQUARE_SIZE}:${SQUARE_SIZE}:flags=lanczos`;
const STANDARD_SHAPES = [1, 4 / 3, 16 / 9, 3 / 4, 9 / 16];
const ANALYSIS_WIDTH = 320;
const FRAME_TIMEOUT_MS = 25000;
const SQUARE_CACHE_MAX_ENTRIES = 200;
// Custom image previews are only for display; the original is embedded.
const PREVIEW_FILTER = "scale=min(1200\\,iw):-2:flags=lanczos";
const JPEG_QUALITY = "2"; // FFmpeg -q:v (2 = visually lossless)

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

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

// --- Framing (pure) ---------------------------------------------------------------

/** Mean color of a run of pixels and the share of them within `tolerance` of it. */
function lineStats(pixels, width, { x0, y0, dx, dy, count }, tolerance) {
  const sum = [0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const offset = ((y0 + dy * i) * width + (x0 + dx * i)) * 3;
    for (let c = 0; c < 3; c += 1) sum[c] += pixels[offset + c];
  }
  const mean = sum.map((value) => value / count);
  let close = 0;
  for (let i = 0; i < count; i += 1) {
    const offset = ((y0 + dy * i) * width + (x0 + dx * i)) * 3;
    if (Math.abs(pixels[offset] - mean[0]) <= tolerance && Math.abs(pixels[offset + 1] - mean[1]) <= tolerance && Math.abs(pixels[offset + 2] - mean[2]) <= tolerance) close += 1;
  }
  return { mean, uniform: close / count };
}

const colorDistance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * The picture inside an RGB image (`pixels`: width × height × 3) once bars
 * of one flat color are removed from opposite sides: { x, y, w, h }, or null
 * when there are none. Bars must be on both opposite sides, about equally
 * wide and of the same color (so a cover with a dark edge on one side is
 * never trimmed); nested bars (bars inside bars) are found in a few passes.
 */
function findContentBox(pixels, width, height, { tolerance = 24, uniformShare = 0.985, sameColor = 20, maxPasses = 3 } = {}) {
  const box = { x: 0, y: 0, w: width, h: height };
  // How many lines from one side are bars of the same flat color.
  const barDepth = (side) => {
    const horizontal = side === "top" || side === "bottom";
    const limit = Math.floor((horizontal ? box.h : box.w) * 0.45);
    const line = (index) =>
      horizontal
        ? { x0: box.x, y0: side === "top" ? box.y + index : box.y + box.h - 1 - index, dx: 1, dy: 0, count: box.w }
        : { x0: side === "left" ? box.x + index : box.x + box.w - 1 - index, y0: box.y, dx: 0, dy: 1, count: box.h };
    const first = lineStats(pixels, width, line(0), tolerance);
    if (first.uniform < uniformShare) return { depth: 0 };
    let depth = 1;
    while (depth < limit) {
      const next = lineStats(pixels, width, line(depth), tolerance);
      if (next.uniform < uniformShare || colorDistance(next.mean, first.mean) > sameColor) break;
      depth += 1;
    }
    return { depth, color: first.mean };
  };

  let trimmed = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (const [a, b, axis] of [
      ["top", "bottom", "h"],
      ["left", "right", "w"],
    ]) {
      const first = barDepth(a);
      const second = barDepth(b);
      if (!first.depth || !second.depth) continue;
      const size = box[axis];
      // Bars come in pairs: about as wide as each other, the same color.
      if (Math.abs(first.depth - second.depth) > Math.max(2, size * 0.03) || colorDistance(first.color, second.color) > sameColor) continue;
      if (size - first.depth - second.depth < size * 0.3) continue;
      if (axis === "h") {
        box.y += first.depth;
        box.h -= first.depth + second.depth;
      } else {
        box.x += first.depth;
        box.w -= first.depth + second.depth;
      }
      changed = true;
    }
    if (!changed) break;
    trimmed = true;
  }
  return trimmed ? box : null;
}

/**
 * Snaps a content box to the standard frame shape it is closest to (within
 * 6%), keeping its center and its larger side, or returns null when it
 * isn't close to any (then nothing is trimmed). Bars detected a few pixels
 * too wide (a cover with a dark edge next to dark bars) don't shrink the
 * picture this way.
 */
function snapToShape(box, width, height) {
  const aspect = box.w / box.h;
  const shape = STANDARD_SHAPES.find((candidate) => Math.abs(aspect / candidate - 1) <= 0.06);
  if (!shape) return null;
  let w = box.w;
  let h = box.h;
  if (aspect < shape) w = h * shape;
  else h = w / shape;
  w = Math.min(w, width);
  h = Math.min(h, height);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = Math.min(Math.max(0, cx - w / 2), width - w);
  const y = Math.min(Math.max(0, cy - h / 2), height - h);
  return { x, y, w, h };
}

/**
 * The FFmpeg filter for square artwork from an image of `width` × `height`
 * whose picture is `box` (null: the whole image): the centered square of the
 * picture, scaled to SQUARE_SIZE.
 */
function squareFilterFor(box, width, height) {
  if (!box) return SQUARE_CROP_FILTER;
  const side = Math.floor(Math.min(box.w, box.h, width, height));
  const x = Math.round(Math.min(Math.max(0, box.x + (box.w - side) / 2), width - side));
  const y = Math.round(Math.min(Math.max(0, box.y + (box.h - side) / 2), height - side));
  return `crop=${side}:${side}:${x}:${y},scale=${SQUARE_SIZE}:${SQUARE_SIZE}:flags=lanczos`;
}

/** Mean absolute difference (0–1) of two equally sized grayscale images. */
function grayDifference(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length / 255;
}

/** Whether a grayscale image is essentially one flat tone (a black or blank frame). */
function isBlank(gray) {
  if (!gray?.length) return true;
  let sum = 0;
  for (const value of gray) sum += value;
  const mean = sum / gray.length;
  let variance = 0;
  for (const value of gray) variance += (value - mean) ** 2;
  return Math.sqrt(variance / gray.length) < 4;
}

/**
 * @param {object} deps
 * @param {(tool: string, args: string[], options?: object) => Promise<{stdout: string}>} deps.runChecked
 *   FFmpeg/FFprobe runner (extraction manager's runChecked).
 * @param {() => string} deps.getTempDir folder for short-lived preview files.
 */
function createArtworkProcessor({ runChecked, getTempDir, download = downloadImage, logger = console }) {
  // Square artwork per video, made once and reused for the embedded cover:
  // key (the thumbnail the user saw) -> JPEG file in the temp folder.
  const squareCache = new Map();
  const squaresInFlight = new Map();

  function tempBase(prefix) {
    return path.join(getTempDir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  }

  async function convertToJpeg(inputPath, outputPath, { filter = null, signal } = {}) {
    await runChecked("ffmpeg", ["-y", "-i", inputPath, ...(filter ? ["-vf", filter] : []), "-frames:v", "1", "-q:v", JPEG_QUALITY, outputPath], { signal });
    if (!fs.existsSync(outputPath)) throw new Error("FFmpeg did not create the prepared artwork file");
    return outputPath;
  }

  /** { width, height } of an image, or null when it isn't one. */
  async function imageSize(inputPath) {
    try {
      const { stdout } = await runChecked("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", inputPath]);
      const stream = JSON.parse(stdout)?.streams?.[0];
      const width = Number(stream?.width);
      const height = Number(stream?.height);
      return width > 0 && height > 0 ? { width, height } : null;
    } catch (error) {
      logger.warn(`[artwork] Couldn't read image dimensions: ${error?.message || error}`);
      return null;
    }
  }

  /** Raw pixels of an image scaled to `width` × `height` (rgb24 or gray), or null. */
  async function rawPixels(inputPath, width, height, format, signal) {
    const output = `${tempBase("wavemint-pixels")}.raw`;
    try {
      await runChecked("ffmpeg", ["-y", "-i", inputPath, "-vf", `scale=${width}:${height}:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", format, output], { signal });
      const bytes = fs.readFileSync(output);
      return bytes.length === width * height * (format === "gray" ? 1 : 3) ? bytes : null;
    } catch {
      return null;
    } finally {
      fs.rmSync(output, { force: true });
    }
  }

  const grayscale = (inputPath, signal) => rawPixels(inputPath, 24, 24, "gray", signal);

  /** The picture inside an image once YouTube's bars are removed (full-size coordinates), or null. */
  async function pictureBox(inputPath, size, signal) {
    const width = ANALYSIS_WIDTH;
    const height = Math.max(2, Math.round((size.height * width) / size.width));
    const pixels = await rawPixels(inputPath, width, height, "rgb24", signal);
    const box = pixels && findContentBox(pixels, width, height);
    if (!box) return null;
    const fx = size.width / width;
    const fy = size.height / height;
    return snapToShape({ x: box.x * fx, y: box.y * fy, w: box.w * fx, h: box.h * fy }, size.width, size.height);
  }

  /** Square artwork from one image into `output`: { side, framed } (framed: bars were removed). */
  async function squareFromImage(inputPath, output, signal) {
    const size = await imageSize(inputPath);
    if (!size) throw new Error("The artwork source is not a valid image");
    const box = await pictureBox(inputPath, size, signal);
    await convertToJpeg(inputPath, output, { filter: squareFilterFor(box, size.width, size.height), signal });
    return { side: Math.floor(Math.min(box?.w ?? size.width, box?.h ?? size.height)), framed: !!box };
  }

  /** The first candidate URL that downloads as a valid image, or null if none were given. */
  async function downloadFirstValid(candidates, folder, baseName, { signal } = {}) {
    let lastError = null;
    for (const [index, url] of [...new Set(candidates.filter(Boolean))].entries()) {
      const destination = path.join(folder, `${baseName}-downloaded-artwork-${index}${imageExtensionFromUrl(url)}`);
      try {
        await download(url, destination, { signal });
        if (await imageSize(destination)) return destination;
        lastError = new Error("The downloaded artwork was not a valid image");
      } catch (error) {
        lastError = error;
      }
      fs.rmSync(destination, { force: true });
    }
    if (lastError) throw lastError;
    return null;
  }

  /** One still of a video stream (`atSeconds` in) as an image file. */
  async function grabFrame(video, atSeconds, output, signal) {
    // Only harmless request headers: never cookies or credentials.
    const headers = Object.entries(video.headers || {})
      .filter(([name, value]) => /^(user-agent|accept|accept-language|origin|referer)$/i.test(name) && typeof value === "string" && !/[\r\n]/.test(value))
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    const args = ["-y", ...(headers ? ["-headers", headers] : []), ...(atSeconds > 0 ? ["-ss", String(atSeconds)] : []), "-i", video.url, "-frames:v", "1", "-an", output];
    await runChecked("ffmpeg", args, { signal, timeoutMs: FRAME_TIMEOUT_MS });
    if (!fs.existsSync(output)) throw new Error("FFmpeg did not take a still from the video");
    return output;
  }

  /**
   * A still of a square video when it's the better source for the artwork,
   * else null: an auto-generated art track (a still of the cover by
   * definition), a still showing the same picture as the thumbnail, or a
   * video that is one still image throughout (the thumbnail was reframed).
   * Moving pictures, black frames and anything else keep the thumbnail.
   */
  async function stillFromVideo(video, thumb, base, signal) {
    const first = await grabFrame(video, 1, `${base}-still-a.png`, signal);
    const size = await imageSize(first);
    if (!size || Math.abs(size.width / size.height - 1) > 0.02) return null;
    const grayA = await grayscale(first, signal);
    if (!grayA || isBlank(grayA)) return null;
    let accept = !!video.artTrack;
    if (!accept && thumb) accept = grayDifference(grayA, await grayscale(thumb.file, signal)) <= 0.1;
    if (!accept && video.duration > 8) {
      const second = await grabFrame(video, Math.round(Math.min(video.duration / 2, 60)), `${base}-still-b.png`, signal);
      accept = grayDifference(grayA, await grayscale(second, signal)) <= 0.03;
    }
    return accept ? first : null;
  }

  /**
   * Square artwork for one video into `output`. `candidates` are thumbnail
   * URLs (largest first); `video` the square video stream, if any (see
   * getSquareVideoSource). Returns { source } or null when there's no image.
   */
  async function makeSquare({ candidates, video = null, output, signal }) {
    const base = tempBase("wavemint-square");
    const folder = path.dirname(base);
    const baseName = path.basename(base);
    try {
      let thumb = null;
      let thumbError = null;
      try {
        const downloaded = await downloadFirstValid(candidates, folder, baseName, { signal });
        if (downloaded) thumb = { file: `${base}-thumb.jpg`, ...(await squareFromImage(downloaded, `${base}-thumb.jpg`, signal)) };
      } catch (error) {
        if (signal?.aborted) throw error;
        thumbError = error;
      }

      // A still only when it can do better: the video is larger than the
      // picture in the thumbnail, or the thumbnail isn't the plain picture
      // with bars a square video's thumbnail normally is.
      if (video && (!thumb || !thumb.framed || video.size > thumb.side * 1.1)) {
        try {
          const still = await stillFromVideo(video, thumb, base, signal);
          if (still) {
            await squareFromImage(still, output, signal);
            return { source: "video" };
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          logger.warn(`[artwork] Using the thumbnail; no still from the video: ${error?.message || error}`);
        }
      }

      if (!thumb) {
        if (thumbError) throw thumbError;
        return null;
      }
      fs.copyFileSync(thumb.file, output);
      return { source: "thumbnail" };
    } finally {
      for (const name of fs.readdirSync(folder)) {
        if (name.startsWith(baseName)) fs.rmSync(path.join(folder, name), { force: true });
      }
    }
  }

  /**
   * The square artwork file for `key` (the thumbnail the user saw), made once
   * and kept for the session; concurrent requests share the work.
   */
  function squareFor(key, { candidates, video, signal }) {
    const known = squareCache.get(key);
    if (known && fs.existsSync(known)) return Promise.resolve(known);
    if (!squaresInFlight.has(key)) {
      const folder = path.join(getTempDir(), "square-artwork");
      const file = path.join(folder, `${crypto.createHash("sha1").update(key).digest("hex")}.jpg`);
      squaresInFlight.set(
        key,
        (async () => {
          fs.mkdirSync(folder, { recursive: true });
          const made = await makeSquare({ candidates, video, output: file, signal });
          if (!made) return null;
          squareCache.delete(key);
          squareCache.set(key, file);
          while (squareCache.size > SQUARE_CACHE_MAX_ENTRIES) {
            const [oldKey, oldFile] = squareCache.entries().next().value;
            squareCache.delete(oldKey);
            fs.rmSync(oldFile, { force: true });
          }
          return file;
        })().finally(() => squaresInFlight.delete(key)),
      );
    }
    return squaresInFlight.get(key);
  }

  const squareCandidates = (shown, others = []) => [...getHighResThumbnailCandidates(shown), shown, ...others].filter(Boolean);

  /**
   * The cover image for an extraction, as a JPEG in `folder`, or null when
   * no thumbnail was available. Square artwork reuses the preview the user
   * saw (`squareKey`: that thumbnail) when there is one.
   */
  async function prepareCover({ mode, customFilePath = "", thumbnailCandidates = [], squareKey = "", video = null, folder, baseName, signal }) {
    const output = path.join(folder, `${baseName}-prepared-artwork.jpg`);
    if (mode === "custom_file") {
      if (!customFilePath || !fs.existsSync(customFilePath)) throw new Error("The selected custom artwork file could not be found");
      return convertToJpeg(customFilePath, output, { signal });
    }
    if (mode === "square_crop") {
      const key = squareKey || thumbnailCandidates[0];
      if (!key) return null;
      const square = await squareFor(key, { candidates: squareCandidates(squareKey, thumbnailCandidates), video, signal });
      if (!square) return null;
      fs.copyFileSync(square, output);
      return output;
    }
    // The published thumbnail, from its largest 16:9 version (same picture, same framing).
    const [maxres, hq720] = getHighResThumbnailCandidates(thumbnailCandidates[0]);
    const downloaded = await downloadFirstValid([maxres, hq720, ...thumbnailCandidates], folder, baseName, { signal });
    if (!downloaded) return null;
    return convertToJpeg(downloaded, output, { signal });
  }

  /**
   * The square artwork preview for a thumbnail, as a data URL (the same file
   * the extraction embeds). `video`: the square video stream, when the
   * analysis found one.
   */
  async function squarePreview(thumbnailUrl, { video = null } = {}) {
    try {
      const file = await squareFor(thumbnailUrl, { candidates: squareCandidates(thumbnailUrl), video });
      if (!file) throw new Error("No thumbnail was available");
      return fileToDataUrl(file);
    } catch (error) {
      throw new Error(`Failed to generate square artwork preview: ${error?.message || "Unknown preview error"}`);
    }
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
  SQUARE_SIZE,
  createArtworkProcessor,
  downloadImage,
  findContentBox,
  grayDifference,
  imageExtensionFromUrl,
  isBlank,
  normalizeArtworkMode,
  snapToShape,
  squareFilterFor,
};
