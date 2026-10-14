import assert from "node:assert/strict";
import test from "node:test";

import { clampEdits, formatTime, gainAt, hasChanges, initialEdits, maxFade, parseTime, tickStep } from "../src/editor/editMath.js";

test("trims stay inside the song with at least a second kept", () => {
  assert.deepEqual(clampEdits({ startMs: -100, endMs: 999999, fadeInMs: 0, fadeOutMs: 0 }, 180000), initialEdits(180000));
  // Dragging the start past the end pushes the end along.
  assert.deepEqual(clampEdits({ startMs: 50000, endMs: 40000, fadeInMs: 0, fadeOutMs: 0 }, 180000, "startMs"), {
    startMs: 50000,
    endMs: 51000,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
  // Dragging the end before the start pulls the start back.
  assert.deepEqual(clampEdits({ startMs: 50000, endMs: 40000, fadeInMs: 0, fadeOutMs: 0 }, 180000, "endMs"), {
    startMs: 39000,
    endMs: 40000,
    fadeInMs: 0,
    fadeOutMs: 0,
  });
});

test("fades are measured inside the trim and never overlap", () => {
  // The example from the request: 15 s off the start, 2 s fade in, 20 s off the end, 4 s fade out.
  const edits = clampEdits({ startMs: 15000, endMs: 160000, fadeInMs: 2000, fadeOutMs: 4000 }, 180000);
  assert.deepEqual(edits, { startMs: 15000, endMs: 160000, fadeInMs: 2000, fadeOutMs: 4000 });
  assert.equal(gainAt(14999, edits), 0);
  assert.equal(gainAt(15000, edits), 0);
  assert.equal(gainAt(16000, edits), 0.5);
  assert.equal(gainAt(17000, edits), 1);
  assert.equal(gainAt(158000, edits), 0.5);
  assert.equal(gainAt(160001, edits), 0);
  assert.ok(hasChanges(edits, 180000));
  assert.ok(!hasChanges(initialEdits(180000), 180000));

  const short = { startMs: 0, endMs: 10000, fadeInMs: 0, fadeOutMs: 0 };
  assert.deepEqual(clampEdits({ ...short, fadeInMs: 6000, fadeOutMs: 6000 }, 10000, "fadeOutMs"), { ...short, fadeInMs: 4000, fadeOutMs: 6000 });
  assert.deepEqual(clampEdits({ ...short, fadeInMs: 6000, fadeOutMs: 6000 }, 10000, "fadeInMs"), { ...short, fadeInMs: 6000, fadeOutMs: 4000 });
  assert.equal(maxFade({ ...short, fadeOutMs: 3000 }, "fadeInMs"), 7000);
  assert.equal(maxFade({ startMs: 0, endMs: 600000, fadeInMs: 0, fadeOutMs: 0 }, "fadeInMs"), 30000);
});

test("times are formatted and parsed", () => {
  assert.equal(formatTime(65300), "1:05.3");
  assert.equal(formatTime(65300, { tenths: false }), "1:05");
  assert.equal(formatTime(0), "0:00.0");
  assert.equal(parseTime("1:05.3"), 65300);
  assert.equal(parseTime("65.3"), 65300);
  assert.equal(parseTime("0:01:05"), 65000);
  assert.equal(parseTime("abc"), null);
  assert.equal(parseTime("-1"), null);
  assert.equal(tickStep(180000, 900), 30000);
  assert.equal(tickStep(10000, 900), 1000);
});

test("zooming keeps the anchor in place and the window inside the song", async () => {
  const { zoomView, clampView, formatTime: format } = await import("../src/editor/editMath.js");
  const whole = { startMs: 0, spanMs: 200000 };
  const zoomed = zoomView(whole, 4, 100000, 200000);
  assert.deepEqual(zoomed, { startMs: 75000, spanMs: 50000 }, "the anchor stays at the same place on screen");
  assert.deepEqual(zoomView(zoomed, 1000, 75000, 200000), { startMs: 75000, spanMs: 1000 }, "never closer than a second");
  assert.deepEqual(zoomView({ startMs: 190000, spanMs: 10000 }, 0.01, 199000, 200000), whole, "zooming out stops at the whole song");
  assert.deepEqual(clampView({ startMs: 195000, spanMs: 10000 }, 200000), { startMs: 190000, spanMs: 10000 });
  assert.equal(format(65321, { digits: 2 }), "1:05.32");
  assert.equal(format(59999, { digits: 2 }), "1:00.00");
});
