/* global window -- used inside page.evaluate callbacks, which run in the app window */
// End-to-end: the navigation (Music, Playlists, Review, Apple Library Sync,
// Library Tools, Settings), browsing tabs, Review's three tabs (essential
// metadata, duplicates with Keep Both, diagnostics), the song panel's Upgrade
// Track / Identify Song, and every Library Tools tab. Real app, temporary
// profile, synthetic songs; iTunes is never contacted.
// Run with `npm run test:e2e` (see app.cjs for the prerequisites).

const assert = require("node:assert/strict");
const path = require("path");
const test = require("node:test");

const { makeTrack } = require("../library-fixtures.cjs");
const { SKIP_REASON, addSource, closeApp, launchApp, scratchDir, until } = require("./app.cjs");

const nav = (page, label) => page.locator(".app-nav__item", { hasText: label }).first().click();
const tab = (page, label) => page.locator(".lib-tabs__tab", { hasText: label }).first().click();

test("navigation, Review and Library Tools", { skip: SKIP_REASON, timeout: 180000 }, async (t) => {
  const root = scratchDir(t, "wavemint-e2e-nav-");
  const music = path.join(root, "music");
  makeTrack(music, "A/One/01.mp3", { tags: { title: "Alpha", artist: "A", album: "One", genre: "Rock" }, cover: "navy" });
  makeTrack(music, "A/One/02.mp3", { tags: { title: "Beta", artist: "A", album: "One", genre: "Rock" }, cover: "navy" });
  // The same recording twice (different folders and tags): a likely duplicate.
  makeTrack(music, "D/Album/01 Halo.mp3", { tags: { title: "Halo", artist: "D", album: "Album", genre: "Pop" }, cover: "teal" });
  makeTrack(music, "D/Singles/Halo.mp3", { tags: { title: "Halo", artist: "D", album: "Singles", genre: "Pop" }, cover: "teal" });
  // A live version is a different recording, and it has no artwork.
  makeTrack(music, "D/Album/02 Halo (Live).mp3", { tags: { title: "Halo (Live)", artist: "D", album: "Album", genre: "Pop" } });
  const { app, page } = await launchApp(path.join(root, "profile"));
  t.after(() => closeApp(app));
  await addSource(app, page, music);

  // --- The sidebar: everyday destinations only.
  const items = (await page.locator(".app-nav__item").allTextContents()).map((text) => text.replace(/\d+$/, "").trim());
  assert.deepEqual(items, ["Add Music", "Music", "Playlists", "Review", "Apple Library Sync", "Library Tools", "Settings"]);

  // --- Music: one destination, browsing tabs.
  await nav(page, /^Music/);
  for (const [label, marker] of [
    ["Overview", ".lib-stats"],
    ["Songs", ".lib-row[role=row] >> text=Alpha"],
    ["Albums", "text=One"],
    ["Artists", ".lib-artist-card"],
    ["Genres", ".lib-genre-card >> text=Rock"],
    ["Favorites", "text=No favorites yet"],
  ]) {
    await tab(page, label);
    await page.locator(marker).first().waitFor();
    assert.equal(await page.locator(".lib-tabs__tab.is-active").textContent(), label);
  }

  // --- A song's details offer Upgrade Track and Identify Song.
  await tab(page, "Songs");
  await page.locator(".lib-row[role=row]", { hasText: "Alpha" }).first().click();
  await page.locator(".lib-detail button", { hasText: "Upgrade Track" }).waitFor();
  await page.locator(".lib-detail button", { hasText: "Identify Song" }).waitFor();
  assert.equal(await page.locator(".lib-detail", { hasText: "Quality" }).count(), 0, "no quality verdicts");

  // --- Playlists.
  await nav(page, "Playlists");
  await page.locator(".lib-content__head h1", { hasText: "Playlists" }).waitFor();

  // --- Review: the badge counts actionable issues.
  await nav(page, "Review");
  await page.locator(".lib-issue-group", { hasText: "Missing artwork" }).waitFor();
  const attention = await page.locator(".lib-issue-group").allTextContents();
  assert.equal(attention.length, 1, `only the live version, which has no artwork, needs attention: ${attention.join(" | ")}`);
  assert.match(attention[0], /Halo \(Live\)/);
  const before = await page.evaluate(() => window.waveMintAPI.library.getStatus());
  assert.equal(before.reviewOpen, 2, "one song without artwork + one likely duplicate");

  await tab(page, "Possible Duplicates");
  await page.locator(".lib-dup").waitFor();
  assert.equal(await page.locator(".lib-dup").count(), 1, "the live version isn't paired");
  assert.equal(await page.locator(".lib-dup-member").count(), 2);
  await page.locator(".lib-dup .lib-badge", { hasText: "Likely duplicate" }).waitFor();
  if (process.env.WAVEMINT_E2E_SCREENSHOT) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.WAVEMINT_E2E_SCREENSHOT.replace(/.png$/, "-duplicates.png"), fullPage: true });
  }
  await page.locator(".lib-dup button", { hasText: "Keep Both" }).click();
  await page.locator("text=No duplicates found.").waitFor();
  await until(async () => (await page.evaluate(() => window.waveMintAPI.library.getStatus())).reviewOpen === 1, "the badge to update");

  await tab(page, "Diagnostics");
  await page.locator("text=Every song's file is where WaveMint expects it.").waitFor();

  // --- Library Tools: setup and maintenance utilities, one tab each.
  await nav(page, "Library Tools");
  for (const [label, marker] of [
    ["Sources", "text=Add Curated Folder"],
    ["Library Organization", "text=Your WaveMint Library"],
    ["Storage", "text=Used by WaveMint"],
    ["History", ".lib-history"],
    ["Import & Merge", "text=Import and merge separate libraries"],
    ["Identify Songs", "text=Identify with MusicBrainz"],
  ]) {
    await tab(page, label);
    await page.locator(marker).first().waitFor();
  }
  // The Keep Both decision is in History, undoable.
  await tab(page, "History");
  await page.locator(".lib-history", { hasText: "Keep separate" }).waitFor();

  // --- Apple Library Sync is its own destination (not contacted here).
  await nav(page, "Apple Library Sync");
  await page.locator("strong", { hasText: "Apple Library Sync" }).waitFor();
  if (process.env.WAVEMINT_E2E_SCREENSHOT) await page.screenshot({ path: process.env.WAVEMINT_E2E_SCREENSHOT.replace(/\.png$/, "-nav.png"), fullPage: true });
});
