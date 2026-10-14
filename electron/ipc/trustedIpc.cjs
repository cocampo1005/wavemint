// IPC handlers only answer WaveMint's own page.
//
// The window can't navigate away or open other pages (main.cjs), so this is
// defence in depth: if anything else ever ran in a WaveMint frame, it still
// couldn't reach privileged operations. (Electron security checklist:
// "Validate the sender of all IPC messages".)

const { pathToFileURL } = require("url");

/**
 * A check for the page WaveMint loads: the built index.html (installed
 * builds, or development with WAVEMINT_RENDERER=dist) or the Vite dev server.
 */
function createAppUrlCheck({ indexFile = null, devServerUrl = null }) {
  if (indexFile) {
    const expected = pathToFileURL(indexFile).href.toLowerCase();
    return (url) => {
      try {
        const parsed = new URL(url);
        parsed.hash = "";
        parsed.search = "";
        // Windows paths are case-insensitive (drive letters especially).
        return parsed.protocol === "file:" && parsed.href.toLowerCase() === expected;
      } catch {
        return false;
      }
    };
  }
  const origin = new URL(devServerUrl).origin;
  return (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
}

/** An `ipcMain`-like object whose handlers reject calls from any other page. */
function createTrustedIpc({ ipcMain, isAppUrl, logger = console }) {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, ...args) => {
        const url = event.senderFrame?.url || "";
        if (!isAppUrl(url)) {
          logger.warn(`[ipc] Refused "${channel}" from an unexpected page`);
          throw new Error("This request isn't allowed.");
        }
        return handler(event, ...args);
      });
    },
  };
}

module.exports = { createAppUrlCheck, createTrustedIpc };
