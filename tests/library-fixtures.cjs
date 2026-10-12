// Synthetic music libraries for library tests. Base audio files are made
// once with the bundled FFmpeg; variants are copies re-tagged with taglib,
// which is fast enough to build libraries of thousands of files.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { writeTags } = require("../electron/library/tags.cjs");

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "resources", "bin", `${process.platform}-${process.arch}`);
const FFMPEG = path.join(BIN, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
const HAVE_FFMPEG = fs.existsSync(FFMPEG);
const SKIP_REASON = !HAVE_FFMPEG && 'run "npm run binaries:fetch" first';

const BASE_DIR = path.join(os.tmpdir(), "wavemint-test-audio-v1");

// Different tones and lengths make files that are genuinely different audio.
const BASES = {
  mp3_128: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "128k"], freq: 440, seconds: 3 },
  mp3_320: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "320k"], freq: 440, seconds: 3 },
  mp3_other: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "192k"], freq: 660, seconds: 5 },
  m4a: { ext: ".m4a", args: ["-c:a", "aac", "-b:a", "256k"], freq: 440, seconds: 3 },
  flac: { ext: ".flac", args: ["-c:a", "flac"], freq: 440, seconds: 3 },
  wav: { ext: ".wav", args: [], freq: 550, seconds: 2 },
};

function ensureBase(name) {
  const spec = BASES[name];
  const target = path.join(BASE_DIR, `${name}${spec.ext}`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const cover = path.join(BASE_DIR, "cover.jpg");
  if (!fs.existsSync(cover)) {
    execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=navy:s=300x300", "-frames:v", "1", cover]);
  }
  const temp = `${target}.tmp${spec.ext}`;
  execFileSync(FFMPEG, [
    "-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${spec.freq}:duration=${spec.seconds}`,
    ...spec.args, temp,
  ]);
  fs.renameSync(temp, target);
  return target;
}

function coverBytes(color = "navy") {
  const file = path.join(BASE_DIR, `cover-${color}.jpg`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=300x300`, "-frames:v", "1", file]);
  }
  return fs.readFileSync(file);
}

/**
 * Creates `relPath` under `root` from a base sound and writes `tags`
 * (fields as in tags.cjs, plus `cover: "navy"` to embed artwork).
 */
function makeTrack(root, relPath, { base = "mp3_128", tags = {}, cover = null } = {}) {
  const source = ensureBase(base);
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const fields = { ...tags };
  if (cover) fields.artwork = { data: coverBytes(cover), mime: "image/jpeg" };
  if (Object.keys(fields).length && [".mp3", ".m4a", ".flac"].includes(path.extname(target).toLowerCase())) {
    writeTags(target, fields);
  }
  return target;
}

/** SHA-256 of every file under a folder: proves a folder was not modified. */
function snapshotFolder(root) {
  const result = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        result[path.relative(root, full)] = {
          hash: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
          mtime: stat.mtimeMs,
        };
      }
    }
  };
  walk(root);
  return result;
}

function makeTempDir(t, prefix = "wavemint-lib-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

module.exports = { HAVE_FFMPEG, SKIP_REASON, coverBytes, ensureBase, makeTempDir, makeTrack, snapshotFolder };
