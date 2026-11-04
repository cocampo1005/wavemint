/* global window -- used inside page.evaluate callbacks, which run in the app window */
// End-to-end: Apple Library Sync (direct reference), the Audio formats view
// and missing files in File Health, in the real app with a temporary profile
// and synthetic songs. It never asks the app to talk to iTunes (no preview,
// sync or migration), so a real iTunes on the machine is not touched.
// Run with `npm run test:e2e` (see app.cjs for the prerequisites).

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const { makeTrack } = require("../library-fixtures.cjs");
const { SKIP_REASON, addSource, closeApp, launchApp, scratchDir } = require("./app.cjs");

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out");
}

test("Apple Library Sync, audio formats and missing files", { skip: SKIP_REASON, timeout: 180000 }, async (t) => {
  const root = scratchDir(t, "wavemint-e2e-apple-");
  const music = path.join(root, "music");
  makeTrack(music, "A/One/01.mp3", { tags: { title: "Alpha", artist: "A", album: "One", genre: "Rock" } });
  makeTrack(music, "A/One/02.mp3", { tags: { title: "Beta", artist: "A", album: "One", genre: "Rock" } });
  makeTrack(music, "B/Two/01.m4a", { base: "m4a", tags: { title: "Gamma", artist: "B", album: "Two", genre: "Jazz" } });
  const { app, page } = await launchApp(path.join(root, "profile"));
  t.after(() => closeApp(app));
  await addSource(app, page, music);

  // --- Apple Library Sync: no export folder to choose; the library's own files are synced.
  await page.locator(".app-nav__item", { hasText: "Apple Library Sync" }).click();
  await page.locator("strong", { hasText: "Apple Library Sync" }).waitFor();
  await page.locator("text=Sync mode: Direct reference").waitFor();
  assert.equal(await page.locator("text=Choose Apple Library Folder").count(), 0);
  await page.locator(".lib-iphone__guide", { hasText: "First sync" }).waitFor();
  const status = await page.evaluate(() => window.waveMintAPI.library.getAppleSync());
  assert.equal(status.syncMode, "direct");
  assert.equal(status.counts.new, 3);
  assert.equal(status.counts.converted, 0);
  assert.equal(status.cache.exists, false);
  // This test library lives in the temporary folder: the app refuses to sync it into iTunes, and says so.
  assert.equal(status.libraryCheck.code, "test-library");
  assert.equal(status.bridge, "itunes-com", "the app always uses the real iTunes bridge");
  await page.locator("text=it looks like a test library").waitFor();
  assert.equal(await page.locator("text=Compatibility cache").count(), 0, "no conversion settings when nothing needs converting");
  // The test and full sync wait for the iTunes settings to be confirmed (and for a check of iTunes).
  assert.equal(await page.locator("button", { hasText: "Sync 5 Songs as a Test" }).isDisabled(), true);
  assert.equal(await page.locator("label", { hasText: "Sync automatically" }).locator("input").isDisabled(), true);
  await page.locator("select.field").first().selectOption("keep");
  await until(async () => (await page.evaluate(() => window.waveMintAPI.library.getAppleSync())).removalPolicy === "keep");
  // The portable copy is still there, as an option.
  await page.locator(".lib-disclosure__toggle", { hasText: "Portable copy of the library" }).click();
  await page.locator("text=Choose Export Folder").waitFor();
  if (process.env.WAVEMINT_E2E_SCREENSHOT) await page.screenshot({ path: process.env.WAVEMINT_E2E_SCREENSHOT.replace(/\.png$/, "-sync.png"), fullPage: true });

  // --- File Health → Audio formats.
  await page.locator(".app-nav__item", { hasText: "File Health" }).click();
  await page.locator(".lib-chip", { hasText: "Audio formats" }).click();
  await page.locator(".lib-formats__table").waitFor();
  const rows = await page.locator(".lib-formats__table tbody tr").allTextContents();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /MP3.*\.mp3.*2/);
  assert.match(rows[1], /AAC.*\.m4a.*1/);
  await page.locator("text=Ready for iTunes: 3 play as they are").waitFor();
  await page.locator(".lib-formats__table button", { hasText: "AAC" }).click();
  await page.locator(".section-label", { hasText: "AAC songs (1)" }).waitFor();
  await page.locator(".lib-review-item__open", { hasText: "Gamma" }).waitFor();
  if (process.env.WAVEMINT_E2E_SCREENSHOT) await page.screenshot({ path: process.env.WAVEMINT_E2E_SCREENSHOT.replace(/\.png$/, "-formats.png"), fullPage: true });

  // --- A missing file: Sources links to File Health, which says which file and why.
  fs.renameSync(path.join(music, "A", "One", "02.mp3"), path.join(root, "02 moved.mp3"));
  await page.evaluate(() => window.waveMintAPI.library.scanSources({}));
  await until(async () => (await page.evaluate(() => window.waveMintAPI.library.listMissingFiles())).length === 1, 30000);
  await page.locator(".app-nav__item", { hasText: "Sources" }).click();
  await page.locator("button", { hasText: "1 missing" }).click();
  await page.locator(".lib-health-missing").waitFor();
  const text = await page.locator(".lib-health-missing").textContent();
  assert.match(text, /Beta/);
  assert.match(text, /02\.mp3/);
  assert.match(text, /moved, renamed or deleted outside WaveMint/);
  await page.locator("button", { hasText: "Locate File" }).waitFor();
  if (process.env.WAVEMINT_E2E_SCREENSHOT) await page.screenshot({ path: process.env.WAVEMINT_E2E_SCREENSHOT.replace(/\.png$/, "-missing.png"), fullPage: true });
});
