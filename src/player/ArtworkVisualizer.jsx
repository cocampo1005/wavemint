import { useEffect, useRef } from "react";
import { usePlayer } from "./usePlayer";
import { LAYERS, SILENCE, SPECTRUM_BANDS, bandBins, createEnvelope, displacement, envelopeEnergy, perimeterSamples, readLevels, stepEnvelope } from "./visualizer";

const TRACK_FADE_S = 0.6; // after a song change, the music eases back in
const SETTLED = 0.008; // below this the contours move by less than a pixel

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function roundRectPath(ctx, { x, y, width, height, radius }) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/**
 * Layered, translucent contours that flow outward from the artwork's border
 * with the music that is playing (the player's analyser; nothing is played
 * separately). The canvas sits over the artwork's surroundings and is cut
 * out where the artwork is, so the cover is never covered.
 *
 * Playing: reacts continuously. Paused/stopped: eases to a still, resting
 * frame and stops drawing. Song change: the reaction dips and eases back in.
 * Reduced motion: only the resting frame. No React state changes per frame.
 */
export function ArtworkVisualizer({ playing, trackKey, artRef }) {
  const { getAnalyser } = usePlayer();
  const canvasRef = useRef(null);
  const playingRef = useRef(playing);
  const wakeRef = useRef(null);
  const trackChangedAt = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const art = artRef.current;
    if (!canvas || !art) return undefined;
    const ctx = canvas.getContext("2d");
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const colors = [cssColor("--wm-cyan", "#1fc8ff"), cssColor("--wm-azure", "#4a8dff"), cssColor("--wm-violet", "#8a5cff")];
    const envelopes = LAYERS.map(() => createEnvelope());
    let geometry = null;
    let analyser = null;
    let bins = null;
    let ranges = null;
    let frame = 0;
    let last = 0;

    const measure = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const size = art.clientWidth;
      const pad = (width - size) / 2;
      const rect = { x: pad, y: (height - art.clientHeight) / 2, width: size, height: art.clientHeight, radius: parseFloat(getComputedStyle(art).borderTopLeftRadius) || 18 };
      // Room for the contours, leaving space for the outer layer's blur so
      // nothing is clipped at the canvas edge.
      const room = Math.max(0, (pad - 2) / (1 + 2 * Math.max(...LAYERS.map((layer) => layer.blur))));
      const samples = perimeterSamples(rect, 5);
      geometry = { ratio, width, height, rect, room, samples, points: new Float32Array(samples.count * 2) };
    };

    const contour = (env, layer) => {
      const { samples, points, room } = geometry;
      for (let i = 0; i < samples.count; i += 1) {
        const d = displacement(env, layer, samples.u[i]) * room;
        points[i * 2] = samples.x[i] + samples.nx[i] * d;
        points[i * 2 + 1] = samples.y[i] + samples.ny[i] * d;
      }
      // A smooth closed curve through the midpoints.
      const n = samples.count;
      ctx.beginPath();
      ctx.moveTo((points[(n - 1) * 2] + points[0]) / 2, (points[(n - 1) * 2 + 1] + points[1]) / 2);
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        ctx.quadraticCurveTo(points[i * 2], points[i * 2 + 1], (points[i * 2] + points[j * 2]) / 2, (points[i * 2 + 1] + points[j * 2 + 1]) / 2);
      }
      ctx.closePath();
    };

    const render = () => {
      if (!geometry) return;
      const { ratio, width, height, rect, room } = geometry;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.clearRect(0, 0, width, height);
      if (room < 4) return;

      const inner = envelopes[0];
      const level = Math.min(1, inner.bass * 0.6 + inner.mid * 0.3 + inner.kick * 0.4);
      // The palette turns slowly with the music (and stands still at rest).
      const turn = inner.phase * 0.12;
      let paint;
      if (typeof ctx.createConicGradient === "function") {
        paint = ctx.createConicGradient(turn - Math.PI / 2, width / 2, height / 2);
        paint.addColorStop(0, colors[0]);
        paint.addColorStop(0.3, colors[1]);
        paint.addColorStop(0.55, colors[2]);
        paint.addColorStop(0.8, colors[1]);
        paint.addColorStop(1, colors[0]);
      } else {
        paint = ctx.createLinearGradient(0, 0, width, height);
        paint.addColorStop(0, colors[0]);
        paint.addColorStop(0.5, colors[1]);
        paint.addColorStop(1, colors[2]);
      }
      ctx.fillStyle = paint;
      ctx.strokeStyle = paint;
      ctx.lineJoin = "round";

      // Outer (soft, faint) first; the inner, defined layer on top.
      for (let i = LAYERS.length - 1; i >= 0; i -= 1) {
        const layer = LAYERS[i];
        contour(envelopes[i], layer);
        ctx.filter = layer.blur ? `blur(${(layer.blur * room).toFixed(1)}px)` : "none";
        if (i === 0) {
          ctx.shadowColor = colors[1];
          ctx.shadowBlur = 6 + level * 16;
        }
        ctx.globalAlpha = layer.fill * (0.8 + 0.6 * level);
        ctx.fill();
        ctx.globalAlpha = layer.stroke * (0.75 + 0.5 * level);
        ctx.lineWidth = i === 0 ? 1.5 : 1.2;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      ctx.filter = "none";

      // A soft rim where the sound leaves the artwork.
      ctx.globalAlpha = 0.3 + 0.4 * level;
      ctx.lineWidth = 2;
      roundRectPath(ctx, rect);
      ctx.stroke();

      // The artwork itself stays untouched.
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      roundRectPath(ctx, rect);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    };

    const still = () => !!motion?.matches;

    const tick = (now) => {
      frame = 0;
      const dt = last ? (now - last) / 1000 : 1 / 60;
      last = now;
      let levels = SILENCE;
      if (playingRef.current && !still()) {
        if (!analyser) {
          analyser = getAnalyser();
          if (analyser) {
            bins = new Uint8Array(analyser.frequencyBinCount);
            ranges = bandBins(analyser.frequencyBinCount, analyser.context.sampleRate);
          }
        }
        if (analyser) {
          analyser.getByteFrequencyData(bins);
          levels = readLevels(bins, ranges);
          const since = (now - trackChangedAt.current) / 1000;
          if (since < TRACK_FADE_S) {
            const ease = Math.max(0, since / TRACK_FADE_S) ** 2;
            levels = { bass: levels.bass * ease, mid: levels.mid * ease, high: levels.high * ease, spectrum: levels.spectrum.map((value) => value * ease) };
          }
        }
      }
      envelopes.forEach((env, i) => stepEnvelope(env, levels, dt, LAYERS[i].lag));
      render();
      const settled = levels === SILENCE && envelopes.every((env) => envelopeEnergy(env) < SETTLED);
      if (!settled) frame = requestAnimationFrame(tick);
      else last = 0;
    };

    const wake = () => {
      if (still()) {
        // Reduced motion: only the resting frame.
        envelopes.forEach((env) => {
          env.bass = env.mid = env.high = env.kick = env.slowBass = 0;
          env.spectrum.fill(0, 0, SPECTRUM_BANDS);
          env.shape.fill(0, 0, SPECTRUM_BANDS);
        });
        cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
        render();
        return;
      }
      if (!frame) frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    measure();
    wake();
    render();
    const resize = new ResizeObserver(() => {
      measure();
      render();
      wake();
    });
    resize.observe(canvas);
    resize.observe(art);
    motion?.addEventListener?.("change", wake);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      motion?.removeEventListener?.("change", wake);
      wakeRef.current = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [getAnalyser, artRef]);

  useEffect(() => {
    playingRef.current = playing;
    wakeRef.current?.();
  }, [playing]);

  useEffect(() => {
    trackChangedAt.current = performance.now();
    wakeRef.current?.();
  }, [trackKey]);

  return <canvas className="wm-listen__visualizer" ref={canvasRef} aria-hidden="true" />;
}
