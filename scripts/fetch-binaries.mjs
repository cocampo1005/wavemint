#!/usr/bin/env node
// Downloads the pinned yt-dlp / Deno / FFmpeg builds listed in
// scripts/binaries.manifest.json, verifies each download against its pinned
// SHA-256, and installs the executables (plus license texts) into
// resources/bin/<platform>/, which electron-builder packages as extraResources.
//
// Usage:
//   node scripts/fetch-binaries.mjs           # install if missing or outdated
//   node scripts/fetch-binaries.mjs --force   # always re-download
//   node scripts/fetch-binaries.mjs --verify  # check installed files only, no network

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "binaries.manifest.json");
const VERSIONS_FILE_NAME = "versions.json";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const verifyOnly = args.has("--verify");

function log(message) {
  console.log(`[binaries] ${message}`);
}

function fail(message) {
  console.error(`[binaries] ERROR: ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function manifestFingerprint(binary) {
  return createHash("sha256").update(JSON.stringify(binary)).digest("hex");
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function download(url, destination, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "WaveMint-build" },
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const hash = createHash("sha256");
      const body = Readable.fromWeb(response.body);
      body.on("data", (chunk) => hash.update(chunk));
      await pipeline(body, fs.createWriteStream(destination));
      return hash.digest("hex");
    } catch (error) {
      fs.rmSync(destination, { force: true });

      if (attempt === attempts) {
        throw new Error(`Download failed for ${url}: ${error.message}`);
      }

      log(`Retrying ${url} (${error.message})`);
    }
  }

  return null;
}

function extractZip(zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });

  // Windows 10+ ships bsdtar as System32\tar.exe, which reads zip files. Use
  // its absolute path so Git for Windows' GNU tar is never picked up instead.
  const command =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "unzip";
  const commandArgs =
    process.platform === "win32"
      ? ["-xf", zipPath, "-C", destination]
      : ["-q", zipPath, "-d", destination];

  const result = spawnSync(command, commandArgs, { stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error(`Could not extract ${path.basename(zipPath)}`);
  }
}

// Supports a single "*" wildcard in the file-name part of `from`.
function resolveSourceFiles(baseDir, from) {
  const fullPattern = path.join(baseDir, from);
  const directory = path.dirname(fullPattern);
  const namePattern = path.basename(fullPattern);

  if (!namePattern.includes("*")) {
    return fs.existsSync(fullPattern) ? [fullPattern] : [];
  }

  const [prefix, suffix] = namePattern.split("*");
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .map((name) => path.join(directory, name));
}

function installedMatchesManifest(targetDir, manifest) {
  const versionsPath = path.join(targetDir, VERSIONS_FILE_NAME);
  if (!fs.existsSync(versionsPath)) return false;

  let installed;
  try {
    installed = readJson(versionsPath);
  } catch {
    return false;
  }

  return manifest.binaries.every((binary) => {
    const record = installed.binaries?.find((item) => item.id === binary.id);
    return (
      record &&
      record.manifestFingerprint === manifestFingerprint(binary) &&
      record.files.every((file) => {
        const filePath = path.join(targetDir, file.path);
        return fs.existsSync(filePath) && fs.statSync(filePath).size === file.size;
      })
    );
  });
}

function verifyInstalledHashes(targetDir) {
  const versionsPath = path.join(targetDir, VERSIONS_FILE_NAME);
  if (!fs.existsSync(versionsPath)) {
    fail(`${versionsPath} is missing. Run "npm run binaries:fetch".`);
  }

  const installed = readJson(versionsPath);
  const problems = [];

  for (const binary of installed.binaries) {
    for (const file of binary.files) {
      const filePath = path.join(targetDir, file.path);
      if (!fs.existsSync(filePath)) {
        problems.push(`missing ${file.path}`);
      } else if (sha256File(filePath) !== file.sha256) {
        problems.push(`hash mismatch for ${file.path}`);
      }
    }
  }

  if (problems.length) {
    fail(`Bundled binaries failed verification:\n  ${problems.join("\n  ")}`);
  }

  log(`Verified ${installed.binaries.length} bundled components in ${targetDir}`);
}

async function installBinary(binary, targetDir, workDir) {
  log(`Downloading ${binary.id} ${binary.version}`);

  const downloadName = path.basename(new URL(binary.url).pathname);
  const downloadPath = path.join(workDir, downloadName);
  const actualHash = await download(binary.url, downloadPath);

  if (actualHash !== binary.sha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${binary.id}: expected ${binary.sha256}, got ${actualHash}. ` +
        "The download was rejected.",
    );
  }

  log(`Verified ${binary.id} SHA-256`);

  let sourceRoot = workDir;
  if (binary.archive === "zip") {
    sourceRoot = path.join(workDir, `${binary.id}-extracted`);
    extractZip(downloadPath, sourceRoot);
  } else if (binary.archive !== "none") {
    throw new Error(`Unsupported archive type "${binary.archive}" for ${binary.id}`);
  }

  const installedFiles = [];

  for (const spec of binary.files) {
    const sources = resolveSourceFiles(sourceRoot, spec.from);
    if (!sources.length) {
      throw new Error(`${binary.id}: "${spec.from}" was not found in the download`);
    }

    for (const source of sources) {
      const relativeTarget = spec.to.endsWith(".")
        ? path.join(spec.to, path.basename(source))
        : spec.to;
      const destination = path.join(targetDir, relativeTarget);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      installedFiles.push(path.normalize(relativeTarget));
    }
  }

  for (const license of binary.licenses || []) {
    const destination = path.join(targetDir, license.to);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await download(license.url, destination);
    installedFiles.push(path.normalize(license.to));
  }

  return {
    id: binary.id,
    version: binary.version,
    url: binary.url,
    sha256: binary.sha256,
    manifestFingerprint: manifestFingerprint(binary),
    files: installedFiles.map((relativePath) => {
      const filePath = path.join(targetDir, relativePath);
      return {
        path: relativePath.split(path.sep).join("/"),
        size: fs.statSync(filePath).size,
        sha256: sha256File(filePath),
      };
    }),
  };
}

async function main() {
  const manifest = readJson(MANIFEST_PATH);
  const targetDir = path.join(ROOT, "resources", "bin", manifest.platform);

  if (verifyOnly) {
    verifyInstalledHashes(targetDir);
    return;
  }

  if (!force && installedMatchesManifest(targetDir, manifest)) {
    log(`Bundled binaries are up to date in ${path.relative(ROOT, targetDir)}`);
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wavemint-binaries-"));
  const stagingDir = `${targetDir}.staging`;

  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    const records = [];
    for (const binary of manifest.binaries) {
      records.push(await installBinary(binary, stagingDir, workDir));
    }

    fs.writeFileSync(
      path.join(stagingDir, VERSIONS_FILE_NAME),
      `${JSON.stringify(
        { platform: manifest.platform, generatedAt: new Date().toISOString(), binaries: records },
        null,
        2,
      )}\n`,
    );

    // Swap in the complete set only after every component verified, so a
    // failed run never leaves a half-updated bin directory behind.
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);

    log(`Installed ${records.length} components into ${path.relative(ROOT, targetDir)}`);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fail(error.message);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
