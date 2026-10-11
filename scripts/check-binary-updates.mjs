#!/usr/bin/env node
// Compares the pinned versions in scripts/binaries.manifest.json with the
// latest upstream releases and prints the new pins, including SHA-256 values
// taken from each project's own published checksum files.
//
// Usage:
//   node scripts/check-binary-updates.mjs           # report only
//   node scripts/check-binary-updates.mjs --write   # also update the manifest
//
// After --write: run `npm run binaries:fetch -- --force`, test the app
// (analysis, extraction, artwork, authentication), then commit the manifest.
// Set GITHUB_TOKEN to avoid GitHub API rate limits.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "scripts", "binaries.manifest.json");
const write = process.argv.includes("--write");

async function fetchText(url) {
  const headers = { "User-Agent": "WaveMint-build" };
  if (process.env.GITHUB_TOKEN && url.startsWith("https://api.github.com/")) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function hashFromSumsFile(text, fileName) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2].trim() === fileName) return match[1].toLowerCase();
  }

  // Deno publishes PowerShell Get-FileHash output: "Hash      : ABC..."
  const powershell = /Hash\s*:\s*([A-F0-9]{64})/i.exec(text);
  return powershell ? powershell[1].toLowerCase() : null;
}

async function latestYtDlp() {
  const release = await fetchJson("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
  const tag = release.tag_name;
  const sumsUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/SHA2-256SUMS`;
  return {
    version: tag,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp.exe`,
    sha256: hashFromSumsFile(await fetchText(sumsUrl), "yt-dlp.exe"),
    checksumSource: sumsUrl,
    replace: (text, current) => text.replaceAll(current.version, tag),
  };
}

async function latestDeno() {
  const release = await fetchJson("https://api.github.com/repos/denoland/deno/releases/latest");
  const version = release.tag_name.replace(/^v/, "");
  const asset = "deno-x86_64-pc-windows-msvc.zip";
  const sumsUrl = `https://github.com/denoland/deno/releases/download/v${version}/${asset}.sha256sum`;
  return {
    version,
    url: `https://github.com/denoland/deno/releases/download/v${version}/${asset}`,
    sha256: hashFromSumsFile(await fetchText(sumsUrl), asset),
    checksumSource: sumsUrl,
    replace: (text, current) => text.replaceAll(`v${current.version}`, `v${version}`),
  };
}

// BtbN deletes daily builds after a few weeks but keeps the end-of-month
// builds much longer, so only those are proposed as pins.
async function latestFfmpeg(current) {
  const branch = /win64-lgpl-shared-(\d+\.\d+)\.zip$/.exec(current.url)?.[1];
  const releases = await fetchJson("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=60");
  const monthly = releases
    .filter((release) => {
      const match = /^autobuild-(\d{4})-(\d{2})-(\d{2})-/.exec(release.tag_name);
      if (!match) return false;
      const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
      return next.getUTCDate() === 1;
    })
    .sort((left, right) => right.tag_name.localeCompare(left.tag_name));

  for (const release of monthly) {
    const asset = release.assets.find((item) =>
      new RegExp(`^ffmpeg-(n${branch.replace(".", "\\.")}[^-]*-\\d+-g[0-9a-f]+)-win64-lgpl-shared-${branch.replace(".", "\\.")}\\.zip$`).test(item.name),
    );
    if (!asset) continue;

    const folder = asset.name.replace(/\.zip$/, "");
    const build = /^ffmpeg-(.+)-win64-lgpl-shared/.exec(asset.name)[1];
    const sumsUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${release.tag_name}/checksums.sha256`;
    const currentFolder = /\/([^/]+)\.zip$/.exec(current.url)[1];
    const currentTag = /download\/([^/]+)\//.exec(current.url)[1];
    const currentBuild = /^ffmpeg-(.+)-win64-lgpl-shared/.exec(currentFolder)[1];
    const currentRelease = currentBuild.split("-")[0];
    const newRelease = build.split("-")[0];

    return {
      version: `${build} (LGPL, shared)`,
      url: asset.browser_download_url,
      sha256: hashFromSumsFile(await fetchText(sumsUrl), asset.name),
      checksumSource: sumsUrl,
      replace: (text) =>
        text
          .replaceAll(currentFolder, folder)
          .replaceAll(currentTag, release.tag_name)
          .replaceAll(`FFmpeg/${currentRelease}/`, `FFmpeg/${newRelease}/`),
    };
  }

  throw new Error(`No end-of-month BtbN build found for FFmpeg ${branch}`);
}

const CHECKERS = { "yt-dlp": latestYtDlp, deno: latestDeno, ffmpeg: latestFfmpeg };

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  let changed = false;

  for (const [index, binary] of manifest.binaries.entries()) {
    const latest = await CHECKERS[binary.id](binary);

    if (!latest.sha256) {
      throw new Error(`Could not read an official checksum for ${binary.id} ${latest.version}`);
    }

    if (latest.url === binary.url && latest.sha256 === binary.sha256) {
      console.log(`${binary.id}: up to date (${binary.version})`);
      continue;
    }

    console.log(`${binary.id}: ${binary.version} -> ${latest.version}`);
    console.log(`  url:    ${latest.url}`);
    console.log(`  sha256: ${latest.sha256}`);

    if (write) {
      const updated = JSON.parse(latest.replace(JSON.stringify(binary), binary));
      updated.version = latest.version;
      updated.url = latest.url;
      updated.sha256 = latest.sha256;
      updated.checksumSource = latest.checksumSource;
      manifest.binaries[index] = updated;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log("\nUpdated scripts/binaries.manifest.json. Next:");
    console.log("  1. npm run binaries:fetch -- --force");
    console.log("  2. Update versions in THIRD_PARTY_NOTICES.md");
    console.log("  3. Test analysis, extraction, artwork and authentication, then commit.");
  }
}

main().catch((error) => {
  console.error(`[binaries] ERROR: ${error.message}`);
  process.exit(1);
});
