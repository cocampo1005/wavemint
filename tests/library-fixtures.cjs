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

const BASE_DIR = path.join(os.tmpdir(), "wavemint-test-audio-v2");

// Different tones and lengths make files that are genuinely different audio.
const BASES = {
  mp3_128: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "128k"], freq: 440, seconds: 3 },
  mp3_320: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "320k"], freq: 440, seconds: 3 },
  mp3_other: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "192k"], freq: 660, seconds: 5 },
  m4a: { ext: ".m4a", args: ["-c:a", "aac", "-b:a", "256k"], freq: 440, seconds: 3 },
  flac: { ext: ".flac", args: ["-c:a", "flac"], freq: 440, seconds: 3 },
  wav: { ext: ".wav", args: [], freq: 550, seconds: 2 },
  // Full-band noise (like music) for the quality signals; "transcoded" is a
  // 320 kbps file made from the 128 kbps one.
  noise_128: { ext: ".mp3", args: ["-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k"], noise: 6 },
  noise_320: { ext: ".mp3", args: ["-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "320k"], noise: 6 },
  noise_flac: { ext: ".flac", args: ["-ac", "2", "-ar", "44100", "-sample_fmt", "s16", "-c:a", "flac"], noise: 6 },
  noise_transcoded: { ext: ".mp3", args: ["-c:a", "libmp3lame", "-b:a", "320k"], from: "noise_128" },
};

// Test files run in parallel processes: each one renders into its own temp
// file and the first to finish wins, so nobody reads a half-written file.
function generateOnce(target, args) {
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const ext = path.extname(target);
  const temp = `${target}.${process.pid}.tmp${ext}`;
  execFileSync(FFMPEG, ["-v", "error", "-y", ...args, temp]);
  try {
    if (!fs.existsSync(target)) fs.renameSync(temp, target);
  } catch (error) {
    if (!fs.existsSync(target)) throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return target;
}

function ensureBase(name) {
  const spec = BASES[name];
  const input = spec.from
    ? ["-i", ensureBase(spec.from)]
    : ["-f", "lavfi", "-i", spec.noise ? `anoisesrc=d=${spec.noise}:c=pink:a=0.3:seed=7` : `sine=frequency=${spec.freq}:duration=${spec.seconds}`];
  return generateOnce(path.join(BASE_DIR, `${name}${spec.ext}`), [...input, ...spec.args]);
}

function coverBytes(color = "navy") {
  const file = generateOnce(path.join(BASE_DIR, `cover-${color}.jpg`), ["-f", "lavfi", "-i", `color=c=${color}:s=300x300`, "-frames:v", "1"]);
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

const quietLogger = { log() {}, warn() {}, error() {} };

/** A migrated library database in a temp folder, closed and deleted after the test. */
async function createTestLibrary(t) {
  const { migrate, openDatabase } = require("../electron/library/db.cjs");
  const { createScanner } = require("../electron/library/scanner.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavemint-db-"));
  const file = path.join(dir, "library.db");
  const { db } = openDatabase(file);
  t.after(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await migrate(db, { filePath: file, logger: quietLogger });
  return { db, dir, scanner: createScanner({ db, logger: quietLogger }) };
}

/** Adds a folder as a source and scans it. Returns the source id. */
async function addAndScan(db, scanner, rootPath, options = {}) {
  const { addSource } = require("../electron/library/sources.cjs");
  const { id } = addSource(db, { rootPath, ...options });
  if (options.writable) db.prepare("UPDATE sources SET read_only = 0 WHERE id = ?").run(id);
  await scanner.scanSource(id);
  return id;
}

function mediaForTests() {
  const { createMedia } = require("../electron/library/media.cjs");
  return createMedia({
    ffmpegPath: FFMPEG,
    ffprobePath: path.join(BIN, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
    cacheDir: path.join(os.tmpdir(), "wavemint-test-media-cache"),
  });
}

module.exports = {
  HAVE_FFMPEG,
  SKIP_REASON,
  addAndScan,
  coverBytes,
  createTestLibrary,
  ensureBase,
  makeTempDir,
  makeTrack,
  mediaForTests,
  quietLogger,
  snapshotFolder,
};
