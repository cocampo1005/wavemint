// The main-process IPC layer with fake Electron objects: sender checks,
// request-scoped progress, and what renderer-supplied paths/URLs may do.
const assert = require("node:assert/strict");
const path = require("path");
const test = require("node:test");

const { registerExtractionHandlers } = require("../electron/ipc/extractionHandlers.cjs");
const { createAppUrlCheck, createTrustedIpc } = require("../electron/ipc/trustedIpc.cjs");
const { createOperationRegistry } = require("../electron/operationRegistry.cjs");

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler) };
}

function fakeSender(id = 1) {
  const sent = [];
  return { id, sent, isDestroyed: () => false, send: (channel, data) => sent.push({ channel, data }) };
}

const quiet = { log() {}, warn() {}, error() {} };

test("IPC handlers only answer WaveMint's own page", async () => {
  const indexFile = path.resolve("dist", "index.html");
  const isAppUrl = createAppUrlCheck({ indexFile });
  const appUrl = require("url").pathToFileURL(indexFile).href;
  assert.equal(isAppUrl(appUrl), true);
  assert.equal(isAppUrl(`${appUrl}#settings`), true);
  assert.equal(isAppUrl(appUrl.toUpperCase().replace("FILE:", "file:")), true, "Windows paths are case-insensitive");
  assert.equal(isAppUrl("file:///C:/Users/me/Downloads/evil.html"), false);
  assert.equal(isAppUrl("https://example.com/"), false);
  assert.equal(isAppUrl(""), false);

  const devCheck = createAppUrlCheck({ devServerUrl: "http://localhost:5173" });
  assert.equal(devCheck("http://localhost:5173/src/main.jsx"), true);
  assert.equal(devCheck("http://localhost:5174/"), false);

  const ipcMain = fakeIpcMain();
  const ipc = createTrustedIpc({ ipcMain, isAppUrl, logger: quiet });
  ipc.handle("ping", async (_event, value) => `pong ${value}`);
  const handler = ipcMain.handlers.get("ping");
  assert.equal(await handler({ senderFrame: { url: appUrl } }, 1), "pong 1");
  assert.throws(() => handler({ senderFrame: { url: "https://example.com/" } }, 1), /isn't allowed/);
  assert.throws(() => handler({ senderFrame: null }, 1), /isn't allowed/);
});

function setup({ analysis, extracted } = {}) {
  const ipcMain = fakeIpcMain();
  const libraryCalls = [];
  const previews = [];
  const extractions = [];
  registerExtractionHandlers({
    ipc: ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { fromWebContents: () => null },
    extraction: {
      assertAvailable() {},
      async analyze({ onStatus }) {
        onStatus({ phase: "analyzing" });
        return analysis;
      },
    },
    artwork: { squarePreview: async (url) => previews.push(url) && "data:image/jpeg;base64,AA==" },
    songExtractor: {
      async extract(options) {
        extractions.push(options);
        options.onProgress({ phase: "downloading", percent: 10, title: "Song" });
        return { filePath: path.join(options.outputFolder, "Song.mp3"), metadata: { title: "Song" }, info: {}, ...extracted };
      },
      postProcessingError: (message) => new Error(message),
    },
    libraryHost: {
      async call(method, params) {
        libraryCalls.push({ method, params });
        if (method === "prepareExtractionStaging") return { token: "a".repeat(32), folder: "C:/staging/a" };
        if (method === "commitStagedExtraction") return { trackId: 9 };
        return {};
      },
    },
    getAuthSettings: () => ({ mode: "none" }),
    assertBundledToolsPresent() {},
    operations: createOperationRegistry(),
    logger: quiet,
  });
  const call = (channel, sender, payload) => ipcMain.handlers.get(channel)({ sender }, payload);
  return { call, libraryCalls, previews, extractions };
}

const ANALYSIS = {
  id: "v1",
  title: "Song",
  uploader: "Artist",
  thumbnail: "https://i.ytimg.com/vi/v1/maxresdefault.jpg",
  webpage_url: "https://www.youtube.com/watch?v=v1",
};

test("progress events carry the request id they belong to", async () => {
  const { call } = setup({ analysis: ANALYSIS });
  const sender = fakeSender();
  await call("analyze-url", sender, { url: ANALYSIS.webpage_url, mode: "video", requestId: "add-music-1" });
  assert.ok(sender.sent.length >= 2);
  assert.ok(sender.sent.every((event) => event.channel === "analyze-progress" && event.data.requestId === "add-music-1"));

  await call("download-mp3", sender, { url: ANALYSIS.webpage_url, metadata: {}, requestId: "upgrade-4" });
  const downloads = sender.sent.filter((event) => event.channel === "download-progress");
  assert.ok(downloads.length >= 2 && downloads.every((event) => event.data.requestId === "upgrade-4"));
});

test("only thumbnails from an analysis are downloaded for previews and covers", async () => {
  const { call, previews, extractions } = setup({ analysis: ANALYSIS });
  const sender = fakeSender();
  await assert.rejects(call("generate-square-crop-preview", sender, { thumbnail: ANALYSIS.thumbnail }), /No valid thumbnail/, "unknown until analyzed");

  await call("analyze-url", sender, { url: ANALYSIS.webpage_url, mode: "video" });
  const { previewUrl } = await call("generate-square-crop-preview", sender, { thumbnail: ANALYSIS.thumbnail });
  assert.match(previewUrl, /^data:image\/jpeg/);
  await assert.rejects(call("generate-square-crop-preview", sender, { thumbnail: "https://192.168.1.1/admin.png" }), /No valid thumbnail/);
  assert.deepEqual(previews, [ANALYSIS.thumbnail]);

  await call("download-mp3", sender, { url: ANALYSIS.webpage_url, thumbnail: "https://evil.example/x.jpg" });
  await call("download-mp3", sender, { url: ANALYSIS.webpage_url, thumbnail: ANALYSIS.thumbnail });
  assert.deepEqual(
    extractions.map((options) => options.thumbnail),
    ["", ANALYSIS.thumbnail],
  );
});

test("invalid requests fail before any staging folder is made", async () => {
  const { call, libraryCalls } = setup({ analysis: ANALYSIS });
  const sender = fakeSender();
  await assert.rejects(call("download-mp3", sender, { url: "file:///C:/x.mp3" }), /web address/);
  await assert.rejects(call("download-mp3", sender, { url: ANALYSIS.webpage_url, artwork: { mode: "custom_file", customFilePath: "C:/Windows/secret.png" } }), /Choose the custom artwork image again/);
  await assert.rejects(call("analyze-url", sender, { url: "javascript:alert(1)" }), /web address/);
  assert.deepEqual(libraryCalls, [], "nothing was staged");

  const result = await call("download-mp3", sender, { url: ANALYSIS.webpage_url });
  assert.deepEqual(result.added, { trackId: 9 });
  assert.deepEqual(
    libraryCalls.map((item) => item.method),
    ["prepareExtractionStaging", "commitStagedExtraction"],
  );
});
