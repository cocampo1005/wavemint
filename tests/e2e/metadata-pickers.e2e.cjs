/* global window, document -- used inside page.evaluate callbacks, which run in the app window */
// End-to-end: the Artist / Album / Genre pickers, genres saved with songs,
// and toasts (no layout shift, never over a control), in the real app with
// a temporary profile and synthetic songs. Run with `npm run test:e2e`
// (see app.cjs for the prerequisites).

const assert = require("node:assert/strict");
const path = require("path");
const test = require("node:test");

const { buildAnalysisResult } = require("../../electron/youtubeMetadata.cjs");
const { SKIP_REASON, addSource, closeApp, launchApp, makeMusic, scratchDir, setWindowSize, until } = require("./app.cjs");

const SONGS = [
  ["Muse/Absolution/01.mp3", { title: "Hysteria", artist: "Muse", album: "Absolution", genre: "Alternative Rock" }],
  ["Muse/Absolution/02.mp3", { title: "Time Is Running Out", artist: "muse", album: "Absolution", genre: "alternative rock" }],
  ["Muse/Origin/01.mp3", { title: "Plug In Baby", artist: "Muse", album: "Origin of Symmetry", genre: "Alternative Rock" }],
  ["Muse/BHAR/01.mp3", { title: "Starlight", artist: "Muse", album: "Black Holes and Revelations", genre: "Alternative Rock" }],
  ["Mumford/Babel/01.mp3", { title: "I Will Wait", artist: "Mumford & Sons", album: "Babel", genre: "Folk" }],
  ["Radiohead/OKC/01.mp3", { title: "Paranoid Android", artist: "Radiohead", album: "OK Computer", genre: "Alternative" }],
  ["Radiohead/OKC/02.mp3", { title: "Karma Police", artist: "Radiohead", album: "OK Computer", genre: "Alternative" }],
];
const MUSE_ALBUMS = ["Absolution", "Black Holes and Revelations", "Origin of Symmetry"];

// --- page helpers -------------------------------------------------------------

const panelField = (page, label) => page.locator(`.lib-detail .lib-edit__field:has(> .form-field__label:text-is("${label}")) input`);
const addField = (page, label) => page.locator(`.add-music .form-field:has(> .form-field__label:text-is("${label}")) input`);
// Each option's label (not its ✓ / + marker).
const optionTexts = (page) => page.locator(".lib-combo__panel [role=option] > span:first-child").allTextContents();
const listOpen = (page) => page.locator(".lib-combo__panel").isVisible();
const genreNames = (page) => page.evaluate(async () => (await window.waveMintAPI.library.listGenreTaxonomy()).map((genre) => genre.name));

/** Waits until the open list shows exactly `expected` (in order). */
async function expectOptions(page, expected, what) {
  try {
    await until(async () => JSON.stringify(await optionTexts(page)) === JSON.stringify(expected), what, 5000);
  } catch {
    assert.deepEqual(await optionTexts(page), expected, what);
  }
}

async function type(input, text) {
  await input.click();
  await input.fill("");
  await input.pressSequentially(text, { delay: 20 });
}

async function openSong(page, title) {
  await page.locator(".app-nav__item", { hasText: /^Songs/ }).first().click();
  const row = page.locator(".lib-row[role=row]", { hasText: title }).first();
  await row.waitFor();
  await row.click();
  await page.locator(".lib-detail h3", { hasText: title }).waitFor();
}

/** Controls (buttons, fields) any toast covers. List rows are content, not controls. */
const coveredControls = (page) =>
  page.evaluate(() => {
    const toasts = [...document.querySelectorAll(".wm-toast")].map((toast) => toast.getBoundingClientRect());
    const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return [...document.querySelectorAll("button, input, select, [role=combobox], a[href]")]
      .filter((element) => !element.closest(".wm-toasts, .lib-row, [hidden]"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width && rect.height && toasts.some((toast) => overlaps(rect, toast));
      })
      .map((element) => element.getAttribute("aria-label") || element.textContent.trim() || element.className);
  });

async function expectToastClear(page, toast, what) {
  await toast.waitFor();
  // Let the entrance animation finish so the measured box is the final one.
  await page.waitForTimeout(300);
  assert.deepEqual(await coveredControls(page), [], `${what}: no control under a toast`);
}

// --- the scenario -------------------------------------------------------------

test("metadata pickers, saved genres and toasts", { skip: SKIP_REASON, timeout: 240000 }, async (t) => {
  const profile = scratchDir(t, "wavemint-e2e-profile-");
  const music = makeMusic(scratchDir(t, "wavemint-e2e-music-"), SONGS);
  let { app, page } = await launchApp(profile);
  await addSource(app, page, music);
  await openSong(page, "Karma Police");
  const artist = panelField(page, "Artist");
  const album = panelField(page, "Album");
  const genre = panelField(page, "Genre");

  await t.test("artist suggestions narrow as you type, without duplicates", async () => {
    await type(artist, "mu");
    await expectOptions(page, ["Mumford & Sons", "Muse"], "'mu': names starting with it, one 'Muse' for both spellings");
    await artist.pressSequentially("s");
    await expectOptions(page, ["Muse"], "'mus' narrows the list");
  });

  await t.test("keyboard: arrows highlight, Enter chooses the library's spelling, Escape only closes the list", async () => {
    await artist.press("ArrowDown");
    assert.ok(await artist.getAttribute("aria-activedescendant"), "the highlighted option is announced");
    await artist.press("Enter");
    assert.equal(await artist.inputValue(), "Muse");
    assert.equal(await listOpen(page), false, "choosing closes the list");
    await type(artist, "rad");
    await artist.press("Escape");
    assert.equal(await listOpen(page), false);
    assert.ok(await page.locator(".lib-detail").isVisible(), "Escape doesn't close the song panel");
    await artist.press("Enter"); // nothing highlighted: the typed text stays
    assert.equal(await artist.inputValue(), "rad");
    await type(artist, "Muse");
    await artist.press("Escape");
  });

  await t.test("the Album field lists that artist's albums, and follows artist changes", async () => {
    const before = await album.inputValue();
    await album.click();
    await expectOptions(page, MUSE_ALBUMS, "focusing Album lists Muse's albums only");
    assert.equal(await album.inputValue(), before, "showing suggestions changes nothing");
    await album.pressSequentially("or");
    await expectOptions(page, ["Origin of Symmetry"], "typing filters the albums");
    await page.locator(".lib-combo__panel [role=option]", { hasText: "Origin of Symmetry" }).click();
    assert.equal(await album.inputValue(), "Origin of Symmetry", "a click chooses");

    await type(artist, "Radiohead");
    await artist.press("Escape");
    await album.click();
    await expectOptions(page, ["OK Computer"], "a different artist: its albums");
    assert.equal(await album.inputValue(), "Origin of Symmetry", "the album being typed isn't replaced");
    await album.press("Escape");
  });

  await t.test("new artists and albums are typed freely", async () => {
    await type(artist, "Brand New Artist");
    assert.equal(await listOpen(page), false, "no list for an unknown artist");
    await type(album, "Fresh Album");
    assert.equal(await listOpen(page), false, "an unknown artist's Album is a plain field");
  });

  await t.test("a typed genre isn't kept when the edit is discarded", async () => {
    await type(genre, "Dark Synthwave");
    await expectOptions(page, ["Use “Dark Synthwave” as a new genre"], "a new genre can be confirmed");
    await genre.press("Escape");
    await page.locator(".lib-detail button", { hasText: "Discard" }).click();
    assert.equal(await artist.inputValue(), "Radiohead");
    assert.deepEqual(await genreNames(page), [], "nothing was registered");
  });

  const body = page.locator(".lib-content__body");

  await t.test("saving registers the new genre and shows a toast that moves and covers nothing", async () => {
    await type(artist, "Brand New Artist");
    await type(album, "Fresh Album");
    await type(genre, "Dark Synthwave"); // typed, not chosen from the list
    await genre.press("Escape");
    const before = await body.boundingBox();
    await page.locator(".lib-detail button", { hasText: "Save Changes" }).click();
    const toast = page.locator(".wm-toast", { hasText: "Saved" });
    await expectToastClear(page, toast, "save toast beside the song panel");
    assert.deepEqual(await body.boundingBox(), before, "the song list didn't move");
    const box = await toast.boundingBox();
    const panel = await page.locator(".lib-detail").boundingBox();
    assert.ok(box.x + box.width <= panel.x, "the toast stays left of the song panel");
    assert.deepEqual(await genreNames(page), ["Dark Synthwave"]);

    // Undo from the toast takes the song back, and the genre with it (nothing else uses it).
    await toast.locator("button", { hasText: "Undo" }).click();
    await page.locator(".wm-toast", { hasText: "Changes undone." }).waitFor();
    await until(async () => (await genreNames(page)).length === 0, "the undone genre to go");
  });

  await t.test("saved again, the new artist, album and genre are suggested for other songs", async () => {
    await type(artist, "Brand New Artist");
    await type(album, "Fresh Album");
    await type(genre, "Dark Synthwave");
    await genre.press("Escape");
    await page.locator(".lib-detail button", { hasText: "Save Changes" }).click();
    await page.locator(".wm-toast", { hasText: "Saved" }).waitFor();

    await openSong(page, "Hysteria");
    await type(artist, "bra");
    await expectOptions(page, ["Brand New Artist"], "the saved artist");
    await artist.press("ArrowDown");
    await artist.press("Enter");
    await album.click();
    await expectOptions(page, ["Fresh Album"], "the saved album, for that artist");
    await album.press("Escape");
    await type(genre, "dark synthwave");
    await expectOptions(page, ["Dark Synthwave"], "the saved genre, with no 'Use…' offer for its own name");
    await genre.press("Escape");
    await page.locator(".lib-detail button", { hasText: "Discard" }).click();
  });

  await t.test("the genre list has no case or spacing duplicates", async () => {
    await genre.click();
    await until(async () => (await optionTexts(page)).length > 10, "the genre list");
    const names = (await optionTexts(page)).map((text) => text.trim().toLowerCase());
    assert.equal(names.length, new Set(names).size);
    assert.ok(names.includes("alternative rock"));
    await genre.press("Escape");
  });

  await t.test("remove and delete toasts: Undo works, nothing moves or is covered", async () => {
    const before = await body.boundingBox();
    await page.locator(".lib-row[role=row]", { hasText: "Starlight" }).first().click({ button: "right" });
    await page.locator("[role=menuitem]", { hasText: "Remove from Library" }).click();
    const removed = page.locator(".wm-toast", { hasText: "Removed" });
    await expectToastClear(page, removed, "remove toast");
    assert.deepEqual(await body.boundingBox(), before);
    await removed.locator("button", { hasText: "Undo" }).click();
    await page.locator(".wm-toast", { hasText: "Restored." }).waitFor();

    await page.locator(".lib-row[role=row]", { hasText: "I Will Wait" }).first().click({ button: "right" });
    await page.locator("[role=menuitem]", { hasText: "Delete File" }).click();
    await page.locator(".lib-dialog__footer button", { hasText: "Move to Recycle Bin" }).click();
    await expectToastClear(page, page.locator(".wm-toast", { hasText: "Recycle Bin" }), "delete toast");
    assert.deepEqual(await body.boundingBox(), before);
  });

  await t.test("toasts stay clear of controls in a narrow window (song panel under the list)", async () => {
    await setWindowSize(app, 820, 760);
    await openSong(page, "Hysteria");
    await page.locator(".lib-row[role=row]", { hasText: "Paranoid Android" }).first().click({ button: "right" });
    await page.locator("[role=menuitem]", { hasText: "Remove from Library" }).click();
    const removed = page.locator(".wm-toast", { hasText: "Removed" });
    await expectToastClear(page, removed, "narrow window");
    await removed.locator("button", { hasText: "Undo" }).click();
    await page.locator(".wm-toast", { hasText: "Restored." }).waitFor();
    await setWindowSize(app, 1400, 900);
  });

  await t.test("Add Music uses the same pickers", async () => {
    // A stand-in analysis (no network): the real result builder, made-up video.
    const analysis = buildAnalysisResult({ id: "e2etest0001", title: "Test Song", uploader: "Tester", duration: 30, webpage_url: "https://www.youtube.com/watch?v=e2etest0001" });
    await app.evaluate(({ ipcMain }, result) => {
      ipcMain.removeHandler("analyze-url");
      ipcMain.handle("analyze-url", async () => result);
    }, analysis);
    await page.locator(".app-nav__add").click();
    const url = page.locator(".add-music form input").first();
    await url.fill("https://www.youtube.com/watch?v=e2etest0001");
    await url.press("Enter");
    const addArtist = addField(page, "Artist");
    await addArtist.waitFor();
    await type(addArtist, "mus");
    await expectOptions(page, ["Muse"], "Add Music: artist suggestions");
    await addArtist.press("ArrowDown");
    await addArtist.press("Enter");
    await addField(page, "Album").click();
    await expectOptions(page, MUSE_ALBUMS, "Add Music: the artist's albums");
    await addField(page, "Album").press("Escape");
    await type(addField(page, "Genre"), "dark s");
    await expectOptions(page, ["Dark Synthwave", "Use “dark s” as a new genre"], "Add Music: saved genres");
  });

  await t.test("a saved genre is still offered after a restart", async () => {
    await closeApp(app);
    ({ app, page } = await launchApp(profile));
    assert.ok((await genreNames(page)).includes("Dark Synthwave"), "kept in the library database");
    await openSong(page, "Paranoid Android");
    await type(panelField(page, "Genre"), "dark");
    assert.equal((await optionTexts(page))[0], "Dark Synthwave");
  });

  // The scratch music folder only ever held the synthetic songs.
  assert.ok(path.basename(music).startsWith("wavemint-e2e-music-"));
});
