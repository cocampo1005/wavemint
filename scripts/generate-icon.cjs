// Generates build/icon.ico (multi-resolution, transparent) from the official
// WaveMint logomark. Run with Electron so nativeImage is available:
//   npm run icon
//
// Sizes below 256px are stored as 32-bit BMP entries with straight alpha for
// the widest compatibility (NSIS, legacy shell views); 256px is stored as PNG.

const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "assets", "Logomark.png");
const OUTPUT = path.join(ROOT, "build", "icon.ico");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function padToSquare(image) {
  const { width, height } = image.getSize();
  const side = Math.max(width, height);
  const source = image.toBitmap();
  const target = Buffer.alloc(side * side * 4); // fully transparent
  const offsetX = Math.floor((side - width) / 2);
  const offsetY = Math.floor((side - height) / 2);

  for (let y = 0; y < height; y += 1) {
    source.copy(
      target,
      ((y + offsetY) * side + offsetX) * 4,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }

  return nativeImage.createFromBitmap(target, { width: side, height: side });
}

// nativeImage bitmaps are BGRA, top-down, premultiplied. ICO DIBs expect
// BGRA, bottom-up, straight alpha, followed by a 1bpp AND mask.
function toIcoBitmapEntry(image, size) {
  const pixels = image.toBitmap();
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      const alpha = pixels[src + 3];
      for (let channel = 0; channel < 3; channel += 1) {
        const value = pixels[src + channel];
        xor[dst + channel] =
          alpha === 0 ? 0 : Math.min(255, Math.round((value * 255) / alpha));
      }
      xor[dst + 3] = alpha;
    }
  }

  const maskRowBytes = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskRowBytes * size); // all zero: use alpha
  return Buffer.concat([header, xor, andMask]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach(({ size, data }, index) => {
    const base = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, base);
    directory.writeUInt8(size >= 256 ? 0 : size, base + 1);
    directory.writeUInt8(0, base + 2);
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

app.whenReady().then(() => {
  try {
    const source = nativeImage.createFromPath(SOURCE);
    if (source.isEmpty()) throw new Error(`Could not load ${SOURCE}`);

    const square = padToSquare(source);
    const entries = SIZES.map((size) => {
      const resized = square.resize({ width: size, height: size, quality: "best" });
      return {
        size,
        data: size >= 256 ? resized.toPNG() : toIcoBitmapEntry(resized, size),
      };
    });

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, buildIco(entries));
    console.log(`[icon] Wrote ${path.relative(ROOT, OUTPUT)} (${SIZES.join(", ")} px)`);

    if (process.env.WAVEMINT_ICON_PREVIEW_DIR) {
      for (const size of SIZES) {
        fs.writeFileSync(
          path.join(process.env.WAVEMINT_ICON_PREVIEW_DIR, `icon-${size}.png`),
          square.resize({ width: size, height: size, quality: "best" }).toPNG(),
        );
      }
    }

    app.exit(0);
  } catch (error) {
    console.error(`[icon] ${error.message}`);
    app.exit(1);
  }
});
