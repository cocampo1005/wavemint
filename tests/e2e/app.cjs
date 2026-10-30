/* global window -- used inside page.evaluate callbacks, which run in the app window */
// Launches the real WaveMint app (Electron, built renderer) for end-to-end
// tests, isolated from the user's own setup: a temporary profile
// (--user-data-dir, so settings and the library database are scratch
// copies), a synthetic music folder, and file dialogs and the Recycle Bin
// stubbed in the main process. Nothing outside the temporary folders is
// read or changed.
//
// Prerequisites (tests skip with the reason when one is missing):
// - `npm run build` (the app loads dist/ with WAVEMINT_RENDERER=dist),
// - `npm run binaries:fetch` (FFmpeg makes the synthetic songs),
// - the playwright-core dev dependency (drives the window; no browsers).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { SKIP_REASON: NO_FFMPEG, makeTrack } = require("../library-fixtures.cjs");

const REPO = path.join(__dirname, "..", "..");

function findPlaywright() {
  try {
    return require("playwright-core");
  } catch {
    return null;
  }
}

const playwright = findPlaywright();
const SKIP_REASON =
  (!fs.existsSync(path.join(REPO, "dist", "index.html")) && 'run "npm run build" first') ||
  NO_FFMPEG ||
  (!playwright && 'install dev dependencies ("npm install") for playwright-core') ||
  false;

const running = new Set();

/** Closes the app; if it doesn't close in time, its process is ended. */
async function closeApp(app) {
  running.delete(app);
  const closed = await Promise.race([app.close().then(() => true, () => false), new Promise((resolve) => setTimeout(() => resolve(false), 10000))]);
  if (!closed) app.process()?.kill();
}

/** A temporary folder removed when the test ends (after any app still using it is closed). */
function scratchDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await Promise.all([...running].map(closeApp));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  return dir;
}

/** Writes synthetic songs: [relativePath, tags] pairs. */
function makeMusic(root, songs) {
  for (const [relPath, tags] of songs) makeTrack(root, relPath, { tags });
  return root;
}

/** Starts WaveMint with `profile` as its user data folder; resolves when the window is ready. */
async function launchApp(profile, { width = 1400, height = 900 } = {}) {
  const env = { ...process.env, WAVEMINT_RENDERER: "dist" };
  // Some tool environments set this; Electron would run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await playwright._electron.launch({
    executablePath: require("electron"),
    args: [REPO, `--user-data-dir=${profile}`],
    cwd: REPO,
    env,
  });
  running.add(app);
  const page = await app.firstWindow();
  await setWindowSize(app, width, height);
  await page.locator(".app-nav").waitFor({ timeout: 30000 });
  // Nothing may reach the real Recycle Bin or open a native dialog.
  await app.evaluate(({ shell }) => {
    shell.trashItem = async () => {};
  });
  return { app, page };
}

async function setWindowSize(app, width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
}

/** Adds `folder` as a library source (through the stubbed folder dialog), waits for its scan, and lets WaveMint write to it. */
async function addSource(app, page, folder) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
  await page.evaluate(() => window.waveMintAPI.library.addSourceFromDialog({ role: "curated", scan: true }));
  await until(async () => {
    const jobs = await page.evaluate(() => window.waveMintAPI.library.listJobs());
    return jobs.some((job) => job.kind === "scan" && job.status !== "running");
  }, "the scan to finish");
  await page.evaluate(async () => {
    const [source] = await window.waveMintAPI.library.listSources();
    await window.waveMintAPI.library.updateSource({ id: source.id, patch: { readOnly: false } });
  });
}

/** Polls `check` until it returns a truthy value (the UI updates asynchronously). */
async function until(check, what, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

module.exports = { REPO, SKIP_REASON, addSource, closeApp, launchApp, makeMusic, scratchDir, setWindowSize, until };
