import assert from "node:assert/strict";
import test from "node:test";

import { parseIpcError } from "../src/ipcErrors.js";

test("strips Electron's IPC wrapper and reads WaveMint's error code", () => {
  const error = new Error(
    "Error invoking remote method 'analyze-url': Error: [auth] Chrome cookies could not be accessed.",
  );

  assert.deepEqual(parseIpcError(error), {
    code: "auth",
    message: "Chrome cookies could not be accessed.",
  });
});

test("plain errors keep their message and have no code", () => {
  assert.deepEqual(
    parseIpcError(new Error("Error invoking remote method 'download-mp3': Error: Download failed")),
    { code: "", message: "Download failed" },
  );
  assert.deepEqual(parseIpcError(null, "Fallback"), { code: "", message: "Fallback" });
});
