// Artwork chosen in WaveMint (custom images, artwork copied from another
// track) is stored once per image, by content hash, with its original bytes:
// nothing is recompressed. Embedded artwork in audio files stays in the files.

const fs = require("fs");
const path = require("path");
const { hashBytes, readArtwork } = require("./tags.cjs");

const MAX_ARTWORK_BYTES = 20 * 1024 * 1024;

function detectImageType(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: ".jpg", mime: "image/jpeg" };
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: ".png", mime: "image/png" };
  }
  return null;
}

function createArtStore(dir) {
  function locate(hash) {
    if (!/^[a-f0-9]{40}$/.test(String(hash))) return null;
    for (const ext of [".jpg", ".png"]) {
      const file = path.join(dir, hash.slice(0, 2), `${hash}${ext}`);
      if (fs.existsSync(file)) return { path: file, mime: ext === ".png" ? "image/png" : "image/jpeg" };
    }
    return null;
  }

  /** Stores image bytes (JPEG or PNG). Returns { hash, mime }. */
  function save(bytes) {
    const data = Buffer.from(bytes);
    if (!data.length || data.length > MAX_ARTWORK_BYTES) throw new Error("Artwork must be an image smaller than 20 MB.");
    const type = detectImageType(data);
    if (!type) {
      throw new Error("Artwork must be a JPEG or PNG image. Apple Music and most players only show those formats.");
    }

    const hash = hashBytes(data);
    if (!locate(hash)) {
      const target = path.join(dir, hash.slice(0, 2), `${hash}${type.ext}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temp, data);
      fs.renameSync(temp, target);
    }
    return { hash, mime: type.mime };
  }

  function saveFromFile(filePath) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ARTWORK_BYTES) throw new Error("Artwork must be an image smaller than 20 MB.");
    return save(fs.readFileSync(filePath));
  }

  /** Bytes for an artwork hash: the store first, then any audio file embedding it. */
  function read(hash, db) {
    const stored = locate(hash);
    if (stored) return { data: fs.readFileSync(stored.path), mime: stored.mime };
    if (!db) return null;
    const file = db.prepare("SELECT path FROM files WHERE artwork_hash = ? AND status = 'ok' ORDER BY id LIMIT 1").get(String(hash));
    return file ? readArtwork(file.path) : null;
  }

  return { dir, locate, read, save, saveFromFile };
}

module.exports = { MAX_ARTWORK_BYTES, createArtStore, detectImageType };
