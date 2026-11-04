// Technical audio facts for comparing files: a short description ("MP3 320
// kbps", "FLAC 16-bit/44.1 kHz"), a coarse resolution tier, and signals from
// a file's properties and an optional FFmpeg check (damaged, truncated…).
// Used by Upgrade Track and playlist imports while the user compares a
// replacement. Nothing here rates songs in the library or recommends upgrades.

const { LOW_BITRATE_KBPS } = require("./queries.cjs");

const CODEC_NAMES = { mp3: "MP3", aac: "AAC", alac: "ALAC", flac: "FLAC", pcm: "PCM", vorbis: "Vorbis", opus: "Opus", wav: "WAV", aiff: "AIFF" };

function describeFile(file) {
  const codec = CODEC_NAMES[file.codec] || String(file.codec || "unknown format").toUpperCase();
  if (file.lossless) {
    const parts = [file.bit_depth ? `${file.bit_depth}-bit` : "", file.sample_rate ? `${(file.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : ""].filter(Boolean);
    return parts.length ? `${codec} ${parts.join("/")}` : codec;
  }
  return file.bitrate ? `${codec} ${file.bitrate} kbps` : codec;
}

/**
 * A coarse technical resolution tier, used only to point out that another
 * version *may* be worth comparing. 0 = unknown.
 */
function technicalTier(file) {
  if (!file || !file.codec) return 0;
  if (file.lossless) return file.bit_depth > 16 || file.sample_rate > 48000 ? 6 : 5;
  const kbps = Number(file.bitrate) || 0;
  if (!kbps) return 0;
  const efficient = file.codec === "aac" || file.codec === "opus" || file.codec === "vorbis";
  const effective = efficient ? kbps * 1.3 : kbps;
  if (effective >= 256) return 4;
  if (effective >= 192) return 3;
  if (effective >= 128) return 2;
  return 1;
}

const reason = (code, level, text) => ({ code, level, text });

/** Signals for one file (technical facts plus, if checked, FFmpeg measurements). */
function fileSignals(file, check, { lowBitrateKbps = LOW_BITRATE_KBPS } = {}) {
  const reasons = [];
  if (!file) return reasons;
  if (file.status === "missing") return [reason("missing", 3, "The file is missing")];
  if (file.status === "unreadable") return [reason("unreadable", 3, "The file couldn't be read")];

  if (!file.lossless && file.bitrate > 0 && file.bitrate < lowBitrateKbps) {
    reasons.push(reason("low_bitrate", 2, `Lossy at ${file.bitrate} kbps`));
  }
  if (file.sample_rate && file.sample_rate < 44100) {
    reasons.push(reason("low_sample_rate", 2, `Sample rate ${(file.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`));
  }
  if (!file.duration_ms) reasons.push(reason("no_duration", 1, "Length unknown"));

  if (check) {
    if (check.decode_errors > 0) {
      reasons.push(reason("decode_errors", 3, `${check.decode_errors} decoding error${check.decode_errors === 1 ? "" : "s"} (the file may be damaged)`));
    }
    if (check.truncated) reasons.push(reason("truncated", 3, "The audio ends before the file's stated length (it may be incomplete)"));

    const drop = check.band_high_db !== null && check.band_mid_db !== null ? check.band_high_db - check.band_mid_db : null;
    if (drop !== null && check.band_mid_db > -80 && drop < -10 && (file.sample_rate || 44100) >= 44100) {
      if (file.lossless) {
        reasons.push(reason("lossless_cutoff", 2, "Lossless file, but almost nothing above 16 kHz: it may have been made from a lossy copy (some recordings are simply like this)"));
      } else if (file.bitrate >= 256) {
        reasons.push(reason("hidden_cutoff", 2, `Almost nothing above 16 kHz for ${file.bitrate} kbps: it may have been re-encoded from a lower-quality file`));
      } else {
        reasons.push(reason("cutoff", 1, "Almost nothing above 16 kHz (typical of lower-bitrate encodes)"));
      }
    }
    if (check.peak_db !== null && check.peak_db >= -0.1 && check.peak_count && check.sample_count) {
      const ratio = check.peak_count / check.sample_count;
      if (ratio > 0.0005) reasons.push(reason("clipping", 1, "Many samples at full scale (possible clipping; common in loud masters)"));
    }
  }
  return reasons;
}

module.exports = { describeFile, fileSignals, technicalTier };
