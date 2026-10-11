import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { getErrorActions, isSkippableInBatch, parseIpcError } from "../src/ipcErrors.js";

const require = createRequire(import.meta.url);
const { CATEGORIES, CATEGORY_ACTIONS, ExtractionError } = require("../electron/errors.cjs");

test("strips Electron's IPC wrapper and reads WaveMint's error code", () => {
  const error = new Error(
    "Error invoking remote method 'analyze-url': Error: [auth] Chrome cookies could not be accessed.",
  );

  assert.deepEqual(parseIpcError(error), {
    code: "auth",
    message: "Chrome cookies could not be accessed.",
    diagnosticsId: "",
  });
});

test("plain errors keep their message and have no code", () => {
  assert.deepEqual(
    parseIpcError(new Error("Error invoking remote method 'download-mp3': Error: Download failed")),
    { code: "", message: "Download failed", diagnosticsId: "" },
  );
  assert.deepEqual(parseIpcError(null, "Fallback"), {
    code: "",
    message: "Fallback",
    diagnosticsId: "",
  });
});

test("extraction errors carry their category and diagnostics id through IPC", () => {
  const thrown = new ExtractionError(
    { category: CATEGORIES.NETWORK_TIMEOUT, message: "The connection timed out." },
    { diagnosticsId: "m1abc2" },
  );
  // Electron prefixes the class name of the thrown error, as seen in the app.
  const wrapped = new Error(
    `Error invoking remote method 'download-mp3': ${thrown.name}: ${thrown.message}`,
  );

  assert.deepEqual(parseIpcError(wrapped), {
    code: "network-timeout",
    message: "The connection timed out.",
    diagnosticsId: "m1abc2",
  });
});

test("the UI offers the same actions the main process defines", () => {
  for (const [category, actions] of Object.entries(CATEGORY_ACTIONS)) {
    assert.deepEqual(getErrorActions(category), actions, category);
  }

  assert.deepEqual(getErrorActions("auth"), ["settings"]);
  assert.deepEqual(getErrorActions(""), []);
  // Final answers never offer a pointless retry.
  assert.deepEqual(getErrorActions("unavailable"), []);
  assert.deepEqual(getErrorActions("rate-limit"), []);
});

test("a batch skips per-video problems but stops on problems affecting every track", () => {
  for (const code of ["unavailable", "private", "geo-restricted", "post-processing"]) {
    assert.equal(isSkippableInBatch(code), true, code);
  }

  for (const code of [
    "network-unavailable",
    "network-timeout",
    "rate-limit",
    "auth-unavailable",
    "auth-expired",
    "bot-check",
    "extractor-outdated",
    "dependency",
    "cancelled",
    "",
  ]) {
    assert.equal(isSkippableInBatch(code), false, code);
  }
});
