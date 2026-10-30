const fs = require("fs/promises");

// Read a response completely and close the source before Chromium can pause
// its consumption. Range requests read only the requested portion.
async function readMediaBytes(filePath, start, end) {
  if (start === undefined) return fs.readFile(filePath);
  const file = await fs.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(end - start + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!bytesRead) throw new Error("The audio file changed while reading");
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

module.exports = { readMediaBytes };
