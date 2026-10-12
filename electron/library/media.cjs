// Media helpers that need WaveMint's bundled FFmpeg tools: a technical probe
// for files taglib can't parse, artwork thumbnails, and audio-stream hashes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runCommand } = require("../processes.cjs");

const THUMB_SIZES = new Set([64, 160, 320, 600]);

function createMedia({ ffmpegPath, ffprobePath, cacheDir, env = process.env }) {
  const thumbsDir = path.join(cacheDir, "artwork");
  const inFlight = new Map();

  async function probe(filePath, { size = 0 } = {}) {
    const result = await runCommand(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration,bit_rate,format_name:format_tags:stream=codec_name,sample_rate,channels,bits_per_raw_sample,bits_per_sample,codec_type", "-of", "json", filePath],
      { label: "FFprobe", env, timeoutMs: 30000 },
    );
    if (result.code !== 0) throw new Error((result.stderr || "FFprobe could not read the file").trim().split(/\r?\n/).pop());

    const data = JSON.parse(result.stdout || "{}");
    const audio = (data.streams || []).find((stream) => stream.codec_type === "audio");
    if (!audio) throw new Error("No audio stream found");

    const tags = Object.fromEntries(
      Object.entries(data.format?.tags || {}).map(([key, value]) => [key.toLowerCase(), String(value).trim()]),
    );
    const [trackNo, trackTotal] = String(tags.track || "").split("/").map((value) => Number.parseInt(value, 10));
    const [discNo, discTotal] = String(tags.disc || "").split("/").map((value) => Number.parseInt(value, 10));
    const durationMs = Math.round(Number(data.format?.duration || 0) * 1000) || null;
    const codecName = String(audio.codec_name || "");
    const lossless = /flac|alac|pcm/.test(codecName) ? 1 : /mp3|aac|vorbis|opus/.test(codecName) ? 0 : null;
    const yearMatch = /\d{4}/.exec(tags.date || tags.year || "");

    return {
      title: tags.title || "",
      artist: tags.artist || "",
      albumArtist: tags.album_artist || tags["album artist"] || "",
      album: tags.album || "",
      genre: tags.genre || "",
      genres: tags.genre ? [tags.genre] : [],
      year: yearMatch ? Number(yearMatch[0]) : null,
      trackNo: trackNo > 0 ? trackNo : null,
      trackTotal: trackTotal > 0 ? trackTotal : null,
      discNo: discNo > 0 ? discNo : null,
      discTotal: discTotal > 0 ? discTotal : null,
      composer: tags.composer || "",
      comment: tags.comment || "",
      compilation: tags.compilation === "1" ? 1 : 0,
      durationMs,
      bitrate: Math.round(Number(data.format?.bit_rate || 0) / 1000) || (durationMs && size ? Math.round((size * 8) / durationMs) : null),
      sampleRate: Number(audio.sample_rate) || null,
      bitDepth: Number(audio.bits_per_raw_sample || audio.bits_per_sample) || null,
      channels: Number(audio.channels) || null,
      codec: codecName.startsWith("pcm") ? "pcm" : codecName || null,
      lossless,
      container: path.extname(filePath).slice(1).toLowerCase(),
      artworkHash: null,
      artworkMime: null,
      artworkCount: 0,
      probedWithFfprobe: true,
    };
  }

  /** MD5 of the audio stream only (unchanged by tag edits). */
  async function audioStreamHash(filePath) {
    const result = await runCommand(
      ffmpegPath,
      ["-v", "error", "-i", filePath, "-map", "0:a:0", "-c:a", "copy", "-f", "md5", "-"],
      { label: "FFmpeg", env, timeoutMs: 120000 },
    );
    const match = /MD5=([a-f0-9]{32})/i.exec(result.stdout || "");
    if (result.code !== 0 || !match) throw new Error("The audio stream could not be read");
    return match[1].toLowerCase();
  }

  /** Decodes the whole file to check for decoding errors (quality checks). */
  async function decodeCheck(filePath) {
    const result = await runCommand(ffmpegPath, ["-v", "error", "-i", filePath, "-map", "0:a:0", "-f", "null", "-"], {
      label: "FFmpeg",
      env,
      timeoutMs: 300000,
    });
    const errors = String(result.stderr || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { ok: result.code === 0 && errors.length === 0, errorCount: errors.length, sample: errors.slice(0, 5) };
  }

  /**
   * A spectrogram picture (PNG, cached by `key`), for comparing versions by
   * eye: a lossy encode shows as a flat ceiling in the high frequencies.
   */
  async function spectrogram(filePath, key) {
    if (!/^[\w.-]+$/.test(String(key))) throw new Error("Invalid spectrogram key");
    const target = path.join(cacheDir, "spectra", `${key}.png`);
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp.png`;
    try {
      const result = await runCommand(
        ffmpegPath,
        ["-v", "error", "-y", "-i", filePath, "-lavfi", "showspectrumpic=s=720x240:legend=1:mode=combined:scale=log:fscale=lin", "-frames:v", "1", temp],
        { label: "FFmpeg", env, timeoutMs: 300000 },
      );
      if (result.code !== 0 || !fs.existsSync(temp)) throw new Error("The spectrogram couldn't be made");
      fs.renameSync(temp, target);
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return target;
  }

  /**
   * Lossless conversion to Apple Lossless (.m4a) for formats Apple's apps
   * can't use (FLAC) or can't carry tags in (WAV). Audio only; WaveMint
   * writes the tags and artwork afterwards.
   */
  async function convertToAlac(input, output, { signal } = {}) {
    const result = await runCommand(
      ffmpegPath,
      ["-v", "error", "-y", "-i", input, "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "alac", "-f", "ipod", output],
      { label: "FFmpeg", env, timeoutMs: 900000, signal },
    );
    if (result.code !== 0 || !fs.existsSync(output)) {
      throw new Error(`The conversion to Apple Lossless failed${result.stderr ? `: ${String(result.stderr).trim().split(/\r?\n/).pop()}` : ""}`);
    }
    return output;
  }

  /**
   * Diagnostic signals for one file in a single FFmpeg pass: the whole file
   * is decoded (decoding errors), and a window of up to 90 s from the middle
   * is measured for level, samples at full scale, and the energy above
   * 16.5 kHz compared with the 12–15 kHz band (a sharp drop is typical of a
   * low-bitrate encode somewhere in the file's history). These are hints for
   * a human to review, never a verdict on how the file sounds.
   */
  async function qualityCheck(filePath, { durationMs = 0, sampleRate = 0 } = {}) {
    const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
    const window = 90;
    const start = seconds > window + 20 ? seconds / 2 - window / 2 : 0;
    const highpass = (freq, times) => Array.from({ length: times }, () => `highpass=f=${freq}:poles=2`).join(",");
    const lowpass = (freq, times) => Array.from({ length: times }, () => `lowpass=f=${freq}:poles=2`).join(",");
    const graph = [
      "[0:a:0]asplit=2[all][sample]",
      "[all]anullsink",
      `[sample]atrim=start=${start.toFixed(2)}:duration=${window},aformat=sample_fmts=fltp,asplit=3[full][mid][high]`,
      "[full]astats=measure_perchannel=none:measure_overall=Peak_level+RMS_level+Peak_count+Number_of_samples,anullsink",
      `[mid]${highpass(12000, 2)},${lowpass(15000, 2)},astats=measure_perchannel=none:measure_overall=RMS_level,anullsink`,
      `[high]${highpass(16500, 3)},astats=measure_perchannel=none:measure_overall=RMS_level[out]`,
    ].join(";");

    const result = await runCommand(
      ffmpegPath,
      ["-hide_banner", "-nostats", "-v", "level+info", "-i", filePath, "-filter_complex", graph, "-map", "[out]", "-f", "null", "-"],
      { label: "FFmpeg", env, timeoutMs: 600000 },
    );

    const stats = new Map(); // astats instance -> { name: value }
    const errors = [];
    for (const line of String(result.stderr || "").split(/\r?\n/)) {
      const stat = /^\[Parsed_astats_(\d+) @ [^\]]+\] \[info\] ([A-Za-z ]+): (-?inf|-?[\d.]+)/.exec(line);
      if (stat) {
        if (!stats.has(Number(stat[1]))) stats.set(Number(stat[1]), {});
        stats.get(Number(stat[1]))[stat[2].trim()] = /inf/.test(stat[3]) ? null : Number(stat[3]);
        continue;
      }
      if (/\[(error|fatal)\]/.test(line) && !line.startsWith("[Parsed_")) errors.push(line.replace(/^(\[[^\]]*\]\s*)+/, "").trim());
    }

    const [full = {}, mid = {}, high = {}] = [...stats.keys()].sort((a, b) => a - b).map((key) => stats.get(key));
    if (result.code !== 0 && !stats.size) {
      return { decodeErrors: Math.max(1, errors.length), decodeSample: errors.slice(0, 5), failed: true, truncated: false };
    }
    // Fewer samples than the stated length allows: the audio ends early.
    const expected = seconds && sampleRate ? Math.min(window, seconds - start) * sampleRate : 0;
    const sampleCount = full["Number of samples"] ?? null;
    return {
      decodeErrors: errors.length,
      decodeSample: errors.slice(0, 5),
      peakDb: full["Peak level dB"] ?? null,
      rmsDb: full["RMS level dB"] ?? null,
      peakCount: full["Peak count"] ?? null,
      sampleCount,
      truncated: !!(expected && sampleCount !== null && sampleCount < expected * 0.9),
      bandMidDb: mid["RMS level dB"] ?? null,
      bandHighDb: high["RMS level dB"] ?? null,
      failed: false,
    };
  }

  /**
   * Returns the path of a cached JPEG thumbnail for an artwork hash, making
   * it from the bytes `loadArt()` returns ({ data }) when needed.
   */
  async function thumbnail(hash, size, loadArt) {
    const px = THUMB_SIZES.has(size) ? size : 160;
    if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error("Invalid artwork id");
    const target = path.join(thumbsDir, hash.slice(0, 2), `${hash}-${px}.jpg`);
    if (fs.existsSync(target)) return target;

    const key = `${hash}-${px}`;
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        (async () => {
          const art = loadArt();
          if (!art) throw new Error("This artwork is no longer available");
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const temp = path.join(thumbsDir, `${key}-${crypto.randomBytes(4).toString("hex")}.src`);
          const tempOut = `${target}.${process.pid}.tmp.jpg`;
          fs.writeFileSync(temp, art.data);
          try {
            const result = await runCommand(
              ffmpegPath,
              ["-v", "error", "-y", "-i", temp, "-vf", `scale=${px}:${px}:force_original_aspect_ratio=decrease:flags=lanczos`, "-frames:v", "1", "-q:v", "3", tempOut],
              { label: "FFmpeg", env, timeoutMs: 30000 },
            );
            if (result.code !== 0 || !fs.existsSync(tempOut)) throw new Error("The artwork could not be converted");
            fs.renameSync(tempOut, target);
          } finally {
            fs.rmSync(temp, { force: true });
            fs.rmSync(tempOut, { force: true });
          }
          return target;
        })().finally(() => inFlight.delete(key)),
      );
    }
    return inFlight.get(key);
  }

  /**
   * Chromium can't play ALAC or AIFF. For those, preview uses a lossless FLAC
   * copy decoded once into the cache (keyed by file id and modification time).
   */
  async function previewFile({ fileId, filePath, mtimeMs }) {
    const target = path.join(cacheDir, "previews", `${fileId}-${Math.round(mtimeMs)}.flac`);
    if (fs.existsSync(target)) return target;

    const key = `preview-${fileId}`;
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        (async () => {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          for (const old of fs.readdirSync(path.dirname(target))) {
            if (old.startsWith(`${fileId}-`)) fs.rmSync(path.join(path.dirname(target), old), { force: true });
          }
          const temp = `${target}.${process.pid}.tmp.flac`;
          try {
            const result = await runCommand(ffmpegPath, ["-v", "error", "-y", "-i", filePath, "-map", "0:a:0", "-c:a", "flac", temp], {
              label: "FFmpeg",
              env,
              timeoutMs: 300000,
            });
            if (result.code !== 0 || !fs.existsSync(temp)) throw new Error("This file can't be previewed");
            fs.renameSync(temp, target);
          } finally {
            fs.rmSync(temp, { force: true });
          }
          return target;
        })().finally(() => inFlight.delete(key)),
      );
    }
    return inFlight.get(key);
  }

  return { audioStreamHash, convertToAlac, decodeCheck, previewFile, probe, qualityCheck, spectrogram, thumbnail };
}

module.exports = { THUMB_SIZES, createMedia };
