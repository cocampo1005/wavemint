// Release safety checks. Fails the build when:
//   - anything that looks like cookies, browser credential stores, signing
//     keys or local secrets would be packaged;
//   - packaged text contains cookie-file content, YouTube session values or
//     a hardcoded path to a cookies file;
//   - the bundled tools are missing, unpinned, or differ from what
//     `npm run binaries:fetch` verified;
//   - app.asar contains files outside the expected whitelist.
//
// Usage:
//   node scripts/check-release.cjs    checks the inputs (dist/, electron/,
//                                     resources/bin/) before packaging
//   electron-builder afterPack hook   checks the packaged app (win-unpacked)

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "binaries.manifest.json");
const REQUIRED_TOOLS = ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "deno.exe"];
const MAX_SCANNED_TEXT_BYTES = 8 * 1024 * 1024;

const SENSITIVE_NAME_PATTERNS = [
  /(^|[\\/])[^\\/]*cookies?[^\\/]*\.(txt|json|sqlite|db)$/i,
  /\.cookies$/i,
  /(^|[\\/])(Cookies|Login Data|Web Data|Local State)$/,
  /(^|[\\/])\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|snk|keystore)$/i,
  /(^|[\\/])(settings|secrets?)\.json$/i,
  /(^|[\\/])WaveMint-Dev([\\/]|$)/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  { pattern: /#\s*(Netscape )?HTTP Cookie File/i, reason: "a Netscape cookie file header" },
  {
    pattern: /^[^\t\r\n]*\t(TRUE|FALSE)\t[^\t\r\n]*\t(TRUE|FALSE)\t\d+\t[^\t\r\n]+\t/m,
    reason: "a cookies.txt entry",
  },
  {
    pattern: /\b(SAPISID|APISID|__Secure-[13]PSID|__Secure-[13]PAPISID|LOGIN_INFO)\s*[=:\t]\s*["']?[A-Za-z0-9_\-/+.]{16,}/,
    reason: "a YouTube session cookie value",
  },
  {
    // Drive-letter paths only; "https://" is excluded by the lookahead.
    pattern: /(^|[^A-Za-z0-9])[A-Za-z]:(\\\\|\\|\/(?!\/))[^"'`\r\n]{0,200}cookies?[^"'`\r\n\\/]*\.txt/i,
    reason: "a hardcoded path to a cookies file",
  },
];

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".node", ".pak", ".bin", ".dat", ".asar", ".png", ".jpg",
  ".jpeg", ".ico", ".woff", ".woff2", ".ttf", ".wasm", ".so", ".dylib",
]);

// Packaged by Electron itself; large and not authored by WaveMint.
const IGNORED_CONTENT_FILES = new Set(["LICENSES.chromium.html"]);

const ASAR_ALLOWED = [/^dist([\\/]|$)/, /^electron([\\/]|$)/, /^package\.json$/];

// Runtime npm packages (and their dependencies) may be packaged; nothing
// else from node_modules. Derived from package-lock.json's non-dev entries.
function productionPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  return new Set(
    Object.entries(lock.packages || {})
      .filter(([key, info]) => key.startsWith("node_modules/") && !info.dev && !info.devOptional)
      .map(([key]) => key.replace(/^node_modules\//, "")),
  );
}

function isAllowedAsarEntry(item, packages) {
  if (ASAR_ALLOWED.some((pattern) => pattern.test(item))) return true;
  const match = /^node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(item);
  return !!match && packages.has(match[1].replace(/\\/g, "/"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath, base);
    return [{ fullPath, relativePath: path.relative(base, fullPath) }];
  });
}

function isTextCandidate(relativePath, size) {
  return (
    size <= MAX_SCANNED_TEXT_BYTES &&
    !BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) &&
    !IGNORED_CONTENT_FILES.has(path.basename(relativePath))
  );
}

function scanNamesAndContent(entries, label, problems) {
  for (const { relativePath, size, read } of entries) {
    if (SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(relativePath))) {
      problems.push(`${label}: sensitive-looking file "${relativePath}"`);
      continue;
    }

    if (!isTextCandidate(relativePath, size)) continue;

    const text = read().toString("utf8");
    for (const { pattern, reason } of SENSITIVE_CONTENT_PATTERNS) {
      if (pattern.test(text)) {
        problems.push(`${label}: "${relativePath}" contains ${reason}`);
      }
    }
  }
}

function filesystemEntries(dir) {
  return walk(dir).map(({ fullPath, relativePath }) => ({
    relativePath,
    size: fs.statSync(fullPath).size,
    read: () => fs.readFileSync(fullPath),
  }));
}

function checkBundledTools(binDir, label, problems) {
  for (const tool of REQUIRED_TOOLS) {
    if (!fs.existsSync(path.join(binDir, tool))) {
      problems.push(`${label}: missing bundled ${tool}. Run "npm run binaries:fetch".`);
    }
  }

  const versionsPath = path.join(binDir, "versions.json");
  if (!fs.existsSync(versionsPath)) {
    problems.push(`${label}: missing versions.json. Run "npm run binaries:fetch".`);
    return;
  }

  const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  for (const pinned of manifest.binaries) {
    const installed = versions.binaries?.find((item) => item.id === pinned.id);

    if (!installed || installed.sha256 !== pinned.sha256) {
      problems.push(
        `${label}: bundled ${pinned.id} does not match the pinned version in binaries.manifest.json. Run "npm run binaries:fetch".`,
      );
      continue;
    }

    for (const file of installed.files) {
      const filePath = path.join(binDir, file.path);
      if (!fs.existsSync(filePath)) {
        problems.push(`${label}: missing ${file.path}`);
      } else if (sha256(filePath) !== file.sha256) {
        problems.push(`${label}: ${file.path} was modified after it was verified`);
      }
    }

    if (!installed.files.some((file) => file.path.startsWith("licenses/"))) {
      problems.push(`${label}: no license files recorded for ${pinned.id}`);
    }
  }
}

/** Packaged npm packages that THIRD_PARTY_NOTICES.md doesn't list. */
function missingNotices() {
  const noticesPath = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
  if (!fs.existsSync(noticesPath)) return ["THIRD_PARTY_NOTICES.md is missing."];
  const notices = fs.readFileSync(noticesPath, "utf8");
  return [...productionPackages()].filter((name) => !notices.includes(`\`${name}\``)).map((name) => `THIRD_PARTY_NOTICES.md doesn't list the packaged npm package "${name}".`);
}

function report(problems, label) {
  if (problems.length) {
    const message = `Release check failed (${label}):\n  - ${problems.join("\n  - ")}`;
    throw new Error(message);
  }

  console.log(`[release-check] ${label}: OK`);
}

function checkInputs() {
  const problems = [];

  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    problems.push('dist/index.html is missing. Run "npm run build".');
  }

  if (!fs.existsSync(path.join(ROOT, "build", "icon.ico"))) {
    problems.push('build/icon.ico is missing. Run "npm run icon".');
  }

  problems.push(...missingNotices());

  for (const dir of ["dist", "electron"]) {
    scanNamesAndContent(filesystemEntries(path.join(ROOT, dir)), dir, problems);
  }

  const binDir = path.join(ROOT, "resources", "bin", "win32-x64");
  scanNamesAndContent(filesystemEntries(binDir), "resources/bin", problems);
  checkBundledTools(binDir, "resources/bin", problems);

  report(problems, "release inputs");
}

async function checkPackagedApp(context) {
  // Imported lazily so `npm run check:release` works without it.
  const asar = require("@electron/asar");
  const problems = [];
  const appOutDir = context.appOutDir;
  const resourcesDir = path.join(appOutDir, "resources");
  const asarPath = path.join(resourcesDir, "app.asar");

  if (!fs.existsSync(asarPath)) {
    problems.push("resources/app.asar is missing");
  } else {
    const asarFiles = asar
      .listPackage(asarPath, { isPack: false })
      .map((item) => item.replace(/^[\\/]/, ""))
      .filter((item) => {
        try {
          return !asar.statFile(asarPath, item).files;
        } catch {
          return false;
        }
      });

    const packages = productionPackages();
    for (const item of asarFiles) {
      if (!isAllowedAsarEntry(item, packages)) {
        problems.push(`app.asar: unexpected file "${item}"`);
      }
    }

    for (const required of ["dist/index.html", "electron/main.cjs", "electron/preload.cjs"]) {
      if (!asarFiles.some((item) => item.replace(/\\/g, "/") === required)) {
        problems.push(`app.asar: missing ${required}`);
      }
    }

    scanNamesAndContent(
      asarFiles.map((item) => ({
        relativePath: item,
        size: asar.statFile(asarPath, item).size || 0,
        read: () => asar.extractFile(asarPath, item),
      })),
      "app.asar",
      problems,
    );
  }

  const outsideAsar = filesystemEntries(appOutDir).filter(
    (entry) => !entry.relativePath.startsWith(path.join("resources", "app.asar")),
  );
  scanNamesAndContent(outsideAsar, "packaged app", problems);
  checkBundledTools(path.join(resourcesDir, "bin"), "packaged app", problems);

  if (!fs.existsSync(path.join(resourcesDir, "THIRD_PARTY_NOTICES.md"))) {
    problems.push("packaged app: THIRD_PARTY_NOTICES.md is missing");
  }
  for (const name of productionPackages()) {
    if (!fs.existsSync(path.join(resourcesDir, "licenses", `${name}-LICENSE.txt`))) {
      problems.push(`packaged app: licenses/${name}-LICENSE.txt is missing (add it to extraResources in electron-builder.yml)`);
    }
  }

  report(problems, `packaged app (${path.basename(appOutDir)})`);
}

module.exports = checkPackagedApp;
module.exports.default = checkPackagedApp;
module.exports.checkInputs = checkInputs;
module.exports.isAllowedAsarEntry = isAllowedAsarEntry;
module.exports.missingNotices = missingNotices;
module.exports.productionPackages = productionPackages;
module.exports.SENSITIVE_CONTENT_PATTERNS = SENSITIVE_CONTENT_PATTERNS;
module.exports.SENSITIVE_NAME_PATTERNS = SENSITIVE_NAME_PATTERNS;

if (require.main === module) {
  try {
    checkInputs();
  } catch (error) {
    console.error(`[release-check] ${error.message}`);
    process.exit(1);
  }
}
