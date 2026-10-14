import assert from "node:assert/strict";
import test from "node:test";

import {
  LAYERS,
  SILENCE,
  SPECTRUM_BANDS,
  bandBins,
  createEnvelope,
  displacement,
  envelopeEnergy,
  perimeterSamples,
  readLevels,
  stepEnvelope,
} from "../src/player/visualizer.js";

const RECT = { x: 50, y: 50, width: 400, height: 400, radius: 18 };

function onBorder(rect, x, y) {
  const r = rect.radius;
  const cx = Math.min(Math.max(x, rect.x + r), rect.x + rect.width - r);
  const cy = Math.min(Math.max(y, rect.y + r), rect.y + rect.height - r);
  return Math.abs(Math.hypot(x - cx, y - cy) - r);
}

function loudLevels(value) {
  return { bass: value, mid: value, high: value, spectrum: new Array(SPECTRUM_BANDS).fill(value) };
}

function settle(levels, seconds, lag = 1) {
  const env = createEnvelope();
  for (let t = 0; t < seconds; t += 1 / 60) stepEnvelope(env, levels, 1 / 60, lag);
  return env;
}

function meanDisplacement(env, layer) {
  let sum = 0;
  for (let i = 0; i < 200; i += 1) sum += displacement(env, layer, i / 200);
  return sum / 200;
}

test("perimeter samples follow the rounded border with outward normals", () => {
  const samples = perimeterSamples(RECT, 5);
  assert.ok(samples.count >= 64);
  // Starts at the top middle and runs clockwise.
  assert.ok(Math.abs(samples.x[0] - 250) < 1e-6 && Math.abs(samples.y[0] - 50) < 1e-6);
  assert.ok(samples.x[Math.round(samples.count / 8)] > 400);
  for (let i = 0; i < samples.count; i += 1) {
    assert.ok(onBorder(RECT, samples.x[i], samples.y[i]) < 0.01, `point ${i} is on the border`);
    assert.ok(Math.abs(Math.hypot(samples.nx[i], samples.ny[i]) - 1) < 1e-6, "unit normal");
    // Outward: stepping along the normal leaves the rectangle's centre behind.
    const before = Math.hypot(samples.x[i] - 250, samples.y[i] - 250);
    const after = Math.hypot(samples.x[i] + samples.nx[i] - 250, samples.y[i] + samples.ny[i] - 250);
    assert.ok(after > before);
    if (i) assert.ok(samples.u[i] > samples.u[i - 1]);
  }
});

test("the contour is closed and stays within the available room", () => {
  const env = settle(loudLevels(1), 2);
  for (const layer of LAYERS) {
    const start = displacement(env, layer, 0);
    const end = displacement(env, layer, 1 - 1e-6);
    assert.ok(Math.abs(start - end) < 1e-3, "no seam where the contour closes");
    for (let i = 0; i < 500; i += 1) {
      const value = displacement(env, layer, i / 500);
      assert.ok(value >= 0 && value <= 1);
    }
  }
});

test("louder music pushes the contours further out than quiet music", () => {
  const quiet = settle(loudLevels(0.15), 2);
  const loud = settle(loudLevels(0.9), 2);
  for (const layer of LAYERS) assert.ok(meanDisplacement(loud, layer) > meanDisplacement(quiet, layer) + 0.1);
  // Outer layers sit further out than inner ones.
  assert.ok(meanDisplacement(loud, LAYERS[3]) > meanDisplacement(loud, LAYERS[0]));
});

test("silence (pause/stop) eases to a still resting frame", () => {
  const env = settle(loudLevels(0.9), 2);
  // Not an instant snap.
  stepEnvelope(env, SILENCE, 1 / 60);
  assert.ok(envelopeEnergy(env) > 0.5);
  for (let t = 0; t < 4; t += 1 / 60) stepEnvelope(env, SILENCE, 1 / 60);
  assert.ok(envelopeEnergy(env) < 0.008);
  // At rest the contour is the layer's base offset and doesn't move.
  const phase = env.phase;
  stepEnvelope(env, SILENCE, 1 / 60);
  assert.equal(env.phase, phase);
  assert.ok(Math.abs(displacement(env, LAYERS[0], 0.3) - LAYERS[0].base) < 0.01);
});

test("slower layers follow the music later than the inner layer", () => {
  const inner = createEnvelope();
  const outer = createEnvelope();
  for (let i = 0; i < 6; i += 1) {
    stepEnvelope(inner, loudLevels(0.9), 1 / 60, LAYERS[0].lag);
    stepEnvelope(outer, loudLevels(0.9), 1 / 60, LAYERS[3].lag);
  }
  assert.ok(inner.bass > outer.bass);
});

test("a sudden bass hit gives a bounded kick that decays", () => {
  const env = settle(loudLevels(0.1), 2);
  stepEnvelope(env, { ...loudLevels(0.1), bass: 1 }, 1 / 60);
  assert.ok(env.kick > 0.5 && env.kick <= 1);
  for (let t = 0; t < 1.5; t += 1 / 60) stepEnvelope(env, loudLevels(0.1), 1 / 60);
  assert.ok(env.kick < 0.05);
  // A long frame (hidden window) is clamped instead of jumping.
  const before = createEnvelope();
  stepEnvelope(before, loudLevels(1), 30);
  assert.ok(before.bass < 1);
});

test("band levels come from the analyser's bins; quiet bins read as silence", () => {
  const ranges = bandBins(1024, 48000);
  assert.ok(ranges.bass[0] >= 1 && ranges.bass[1] > ranges.bass[0]);
  assert.ok(ranges.mid[0] >= ranges.bass[1] - 1);
  assert.equal(ranges.spectrum.length, SPECTRUM_BANDS);
  const silent = readLevels(new Uint8Array(1024).fill(40), ranges);
  assert.equal(silent.bass, 0);
  assert.equal(silent.high, 0);
  const loud = readLevels(new Uint8Array(1024).fill(240), ranges);
  assert.ok(loud.bass > 0.8 && loud.mid > 0.8 && loud.high > 0.8);
  // A single strong tone in a wide band still registers.
  const tone = new Uint8Array(1024).fill(60);
  const bin = Math.round(440 / (48000 / 2 / 1024));
  tone[bin - 1] = 200;
  tone[bin] = 240;
  tone[bin + 1] = 200;
  assert.ok(readLevels(tone, ranges).mid > 0.2);
});
