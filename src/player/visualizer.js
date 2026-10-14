// Listen Mode's visualizer model: translucent contours that flow outward
// from the artwork's (rounded) border, driven by the music that is playing.
// Pure functions and small state objects (no DOM), so the drawing code in
// ArtworkVisualizer.jsx stays thin and this part can be tested in Node.

// Frequency bands (Hz). Bass gives broad, slow pulses; mids move the
// contour; highs add small ripples.
export const BANDS = {
  bass: [40, 220],
  mid: [220, 2600],
  high: [2600, 12000],
};
export const SPECTRUM_BANDS = 12;

// Inner layers are defined and quick; outer ones sit further out and are
// smoother, slower and fainter. base/gain: resting offset and how far the
// music moves it (shares of the available room); lag: how much later it
// follows the music; phase: so layers never move in lockstep; detail: how
// much of the fine (treble, spectrum) movement it shows.
export const LAYERS = [
  { base: 0.05, gain: 0.5, lag: 1, phase: 0, detail: 1, fill: 0.3, stroke: 0.85, blur: 0 },
  { base: 0.15, gain: 0.62, lag: 1.7, phase: 1.3, detail: 0.7, fill: 0.2, stroke: 0.6, blur: 0.01 },
  { base: 0.26, gain: 0.68, lag: 2.5, phase: 2.6, detail: 0.45, fill: 0.14, stroke: 0.42, blur: 0.02 },
  { base: 0.37, gain: 0.63, lag: 3.4, phase: 4.1, detail: 0.25, fill: 0.1, stroke: 0.28, blur: 0.035 },
];

// Envelope time constants (seconds): attack, release.
const TIMING = {
  bass: [0.07, 0.38],
  mid: [0.05, 0.24],
  high: [0.03, 0.15],
  spectrum: [0.05, 0.28],
};
// Below these (0–1 analyser levels) a band counts as silent, so quiet
// passages pull the contours in toward the artwork.
const FLOORS = { bass: 0.38, mid: 0.28, high: 0.16, spectrum: 0.22 };

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
// Slower layers rise later, but fall back only a little slower than the
// inner one, so a pause settles in a few seconds.
const follow = (current, target, dt, [attack, release], lag = 1) => {
  const tau = target > current ? attack * lag : release * (1 + (lag - 1) * 0.35);
  return current + (target - current) * (1 - Math.exp(-dt / tau));
};

/** Bin ranges for the bands and the log-spaced spectrum bands. */
export function bandBins(binCount, sampleRate) {
  const hzPerBin = sampleRate / 2 / binCount;
  const bin = (hz) => Math.max(1, Math.min(binCount - 1, Math.round(hz / hzPerBin)));
  const range = ([from, to]) => [bin(from), Math.max(bin(from) + 1, bin(to))];
  const spectrum = [];
  const low = 60;
  const high = 10000;
  for (let i = 0; i < SPECTRUM_BANDS; i += 1) {
    const from = low * Math.pow(high / low, i / SPECTRUM_BANDS);
    const to = low * Math.pow(high / low, (i + 1) / SPECTRUM_BANDS);
    spectrum.push(range([from, to]));
  }
  return { bass: range(BANDS.bass), mid: range(BANDS.mid), high: range(BANDS.high), spectrum };
}

// A band's level: mostly its average, partly its loudest bin, so a strong
// tone (a bass note, a vocal) registers even in a wide band.
function average(bins, [from, to]) {
  let sum = 0;
  let peak = 0;
  for (let i = from; i < to; i += 1) {
    sum += bins[i];
    if (bins[i] > peak) peak = bins[i];
  }
  return (0.6 * (sum / (to - from)) + 0.4 * peak) / 255;
}

const shape = (value, floor) => Math.pow(clamp01((value - floor) / (1 - floor)), 1.35);

/** Raw band levels (0–1) from analyser byte frequency data. */
export function readLevels(bins, ranges) {
  return {
    bass: shape(average(bins, ranges.bass), FLOORS.bass),
    mid: shape(average(bins, ranges.mid), FLOORS.mid),
    high: shape(average(bins, ranges.high), FLOORS.high),
    spectrum: ranges.spectrum.map((range) => shape(average(bins, range), FLOORS.spectrum)),
  };
}

export const SILENCE = { bass: 0, mid: 0, high: 0, spectrum: new Array(SPECTRUM_BANDS).fill(0) };

/** Smoothed state for one layer. */
export function createEnvelope() {
  return { bass: 0, mid: 0, high: 0, kick: 0, slowBass: 0, phase: 0, spectrum: new Float32Array(SPECTRUM_BANDS), shape: new Float32Array(SPECTRUM_BANDS) };
}

/**
 * Moves an envelope toward `levels` (SILENCE when paused or stopped).
 * Sudden bass rises add a "kick" that decays quickly, so transients get a
 * noticeable but bounded reaction. Returns the envelope.
 */
export function stepEnvelope(env, levels, dt, lag = 1) {
  const step = Math.min(0.1, Math.max(0, dt)); // a long frame (tab hidden) doesn't jump
  env.bass = follow(env.bass, levels.bass, step, TIMING.bass, lag);
  env.mid = follow(env.mid, levels.mid, step, TIMING.mid, lag);
  env.high = follow(env.high, levels.high, step, TIMING.high, lag);
  for (let i = 0; i < SPECTRUM_BANDS; i += 1) env.spectrum[i] = follow(env.spectrum[i], levels.spectrum[i] || 0, step, TIMING.spectrum, lag);
  // The spectrum as a contour: neighbouring bands blended, so it flows
  // rather than forming a bump per band.
  env.shape.set(env.spectrum);
  for (let pass = 0; pass < 2; pass += 1) {
    let previous = env.shape[0];
    for (let i = 0; i < SPECTRUM_BANDS; i += 1) {
      const current = env.shape[i];
      const next = env.shape[Math.min(SPECTRUM_BANDS - 1, i + 1)];
      env.shape[i] = 0.25 * previous + 0.5 * current + 0.25 * next;
      previous = current;
    }
  }
  env.slowBass = follow(env.slowBass, levels.bass, step, [0.45, 0.45]);
  const rise = Math.max(0, levels.bass - env.slowBass - 0.06);
  env.kick = Math.min(1, Math.max(env.kick * Math.exp(-step / (0.2 * lag)), rise * 2.2));
  // The contour flows faster with more energy and stands still at rest.
  env.phase += step * (0.35 + 1.6 * env.mid + 0.8 * env.bass) * (env.bass + env.mid + env.high > 0.002 ? 1 : 0);
  return env;
}

export function envelopeEnergy(env) {
  return env.bass + env.mid + env.high + env.kick;
}

/** The spectrum at side-position c (0 = middle of a side, 1 = corner), smoothly interpolated. */
function spectrumAt(spectrum, c) {
  const x = c * (SPECTRUM_BANDS - 1);
  const i = Math.floor(x);
  const t = x - i;
  const a = spectrum[i] || 0;
  const b = spectrum[Math.min(SPECTRUM_BANDS - 1, i + 1)] || 0;
  const s = (1 - Math.cos(Math.PI * t)) / 2;
  return a + (b - a) * s;
}

const TAU = Math.PI * 2;

/**
 * Outward displacement (0–1 of the available room) at perimeter position u
 * (0–1, clockwise from the top middle). Whole-number wave counts keep the
 * contour closed; each side sees the same kind of motion.
 */
export function displacement(env, layer, u) {
  const p = env.phase + layer.phase;
  // Bass: the whole frame swells, a little more at the middle of each side.
  const bass = env.bass * (0.72 + 0.28 * Math.cos(TAU * 4 * u)) + env.kick * 0.55;
  // Mids: two slow waves travelling in opposite directions.
  const mid = env.mid * (0.5 + 0.25 * Math.sin(TAU * 7 * u + p * 1.1) + 0.25 * Math.sin(TAU * 11 * u - p * 0.8));
  // Highs: small, quick ripples.
  const high = env.high * (0.5 + 0.25 * Math.sin(TAU * 13 * u + p * 2.4) + 0.25 * Math.sin(TAU * 19 * u - p * 1.7));
  // The spectrum itself, mirrored on every side (lows mid-side, highs toward corners).
  const q = (u * 4 + 0.5) % 1;
  const spectral = spectrumAt(env.shape, Math.abs(q - 0.5) * 2) * (0.6 + 0.4 * Math.sin(TAU * 5 * u + p * 0.6));
  const detail = layer.detail ?? 1;
  const value = layer.base + layer.gain * (0.36 * bass + 0.28 * mid + 0.1 * detail * high + 0.26 * (0.4 + 0.6 * detail) * spectral);
  return Math.min(1, Math.max(0, value));
}

/**
 * Points along a rounded rectangle's border, clockwise from the top middle:
 * { x, y, nx, ny } arrays (positions and outward normals) and u (0–1).
 */
export function perimeterSamples({ x, y, width, height, radius }, spacing = 6) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const straightW = width - 2 * r;
  const straightH = height - 2 * r;
  const arc = (Math.PI / 2) * r;
  const segments = [
    { kind: "line", length: straightW / 2, from: [x + width / 2, y], dir: [1, 0], normal: [0, -1] },
    { kind: "arc", length: arc, center: [x + width - r, y + r], start: -Math.PI / 2 },
    { kind: "line", length: straightH, from: [x + width, y + r], dir: [0, 1], normal: [1, 0] },
    { kind: "arc", length: arc, center: [x + width - r, y + height - r], start: 0 },
    { kind: "line", length: straightW, from: [x + width - r, y + height], dir: [-1, 0], normal: [0, 1] },
    { kind: "arc", length: arc, center: [x + r, y + height - r], start: Math.PI / 2 },
    { kind: "line", length: straightH, from: [x, y + height - r], dir: [0, -1], normal: [-1, 0] },
    { kind: "arc", length: arc, center: [x + r, y + r], start: Math.PI },
    { kind: "line", length: straightW / 2, from: [x + r, y], dir: [1, 0], normal: [0, -1] },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const count = Math.max(64, Math.round(total / spacing));
  const out = { count, u: new Float32Array(count), x: new Float32Array(count), y: new Float32Array(count), nx: new Float32Array(count), ny: new Float32Array(count) };
  let index = 0;
  let offset = 0;
  for (const segment of segments) {
    while (index < count && (index * total) / count < offset + segment.length + 1e-9) {
      const along = (index * total) / count - offset;
      if (segment.kind === "line") {
        out.x[index] = segment.from[0] + segment.dir[0] * along;
        out.y[index] = segment.from[1] + segment.dir[1] * along;
        out.nx[index] = segment.normal[0];
        out.ny[index] = segment.normal[1];
      } else {
        const angle = segment.start + (r ? along / r : 0);
        out.nx[index] = Math.cos(angle);
        out.ny[index] = Math.sin(angle);
        out.x[index] = segment.center[0] + r * out.nx[index];
        out.y[index] = segment.center[1] + r * out.ny[index];
      }
      out.u[index] = index / count;
      index += 1;
    }
    offset += segment.length;
  }
  return out;
}
