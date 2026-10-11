const fs = require("fs");
const os = require("os");
const path = require("path");

function makeTempDir(t, prefix = "wavemint-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(filePath, contents = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

// Builds a fake per-user AppData layout for browser detection tests.
function makeFakeAppData(t) {
  const root = makeTempDir(t, "wavemint-appdata-");
  const env = {
    LOCALAPPDATA: path.join(root, "Local"),
    APPDATA: path.join(root, "Roaming"),
  };
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  fs.mkdirSync(env.APPDATA, { recursive: true });
  return { root, env };
}

const FUTURE = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const PAST = Math.floor(Date.now() / 1000) - 24 * 3600;

function cookieLine(domain, name, value, expires = FUTURE) {
  return [domain, "TRUE", "/", "TRUE", String(expires), name, value].join("\t");
}

module.exports = { FUTURE, PAST, cookieLine, makeFakeAppData, makeTempDir, writeFile };
