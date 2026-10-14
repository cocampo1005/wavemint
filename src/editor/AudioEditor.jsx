import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "../library/Dialog";
import { mediaUrl } from "../library/format";
import { PauseIcon, PlayIcon, WarningIcon } from "../library/icons";
import { errorMessage, libraryApi, useJobRunner } from "../library/useLibrary";
import { usePlayer } from "../player/usePlayer";
import { PREVIEW_EDGE_MS, clampEdits, clampView, formatTime, gainAt, hasChanges, initialEdits, maxFade, parseTime, tickStep, zoomView } from "./editMath";
import "./editor.css";
import { Artwork } from "../library/Artwork";

const WAVE_HEIGHT = 150;
const BAR_STEP = 3; // px per bar (2 px bar, 1 px gap)
const ZOOM_STEP = 2;
// Closer than this share of the song, a finer waveform of the visible stretch is loaded.
const DETAIL_BELOW = 0.34;

/** The peak level between two times, from the finest data that covers them. */
function peakBetween(fromMs, toMs, overview, detail) {
  const source = detail && fromMs >= detail.startMs && toMs <= detail.startMs + detail.durationMs ? detail : overview;
  const { peaks } = source;
  const scale = peaks.length / source.durationMs;
  const first = Math.max(0, Math.floor((fromMs - source.startMs) * scale));
  const last = Math.min(peaks.length, Math.max(first + 1, Math.ceil((toMs - source.startMs) * scale)));
  let peak = 0;
  for (let i = first; i < last; i += 1) if (peaks[i] > peak) peak = peaks[i];
  return peak;
}

/**
 * Waveform with the kept region, trim handles, fade envelope and playhead,
 * showing `view` ({ startMs, spanMs }) of the song. The playhead is placed
 * imperatively (ref.setPlayhead) so playback doesn't re-render the editor.
 */
function Waveform({ ref, overview, detail, durationMs, edits, view, onViewChange, onChange, onSeek }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const playheadRef = useRef(null);
  const playheadAt = useRef(0);
  const [width, setWidth] = useState(0);
  const drag = useRef(null);

  useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const toX = useCallback((ms) => (view.spanMs ? ((ms - view.startMs) / view.spanMs) * width : 0), [view, width]);
  const toMs = (clientX) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return Math.round(view.startMs + (x / rect.width) * view.spanMs);
  };

  const placePlayhead = useCallback(() => {
    const element = playheadRef.current;
    if (!element) return;
    const x = toX(playheadAt.current);
    element.style.display = x < -1 || x > width + 1 ? "none" : "";
    element.style.transform = `translateX(${x}px)`;
  }, [toX, width]);

  useLayoutEffect(placePlayhead);
  useImperativeHandle(
    ref,
    () => ({
      setPlayhead(ms) {
        playheadAt.current = ms;
        placePlayhead();
      },
    }),
    [placePlayhead],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width || !overview?.peaks?.length) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(WAVE_HEIGHT * ratio);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);

    const middle = WAVE_HEIGHT / 2;
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "#1fc8ff");
    gradient.addColorStop(0.55, "#4a8dff");
    gradient.addColorStop(1, "#8a5cff");
    const removed = "rgba(118, 132, 166, 0.32)";
    const faded = "rgba(118, 132, 166, 0.22)";
    const msPerPx = view.spanMs / width;

    for (let x = 0; x < width; x += BAR_STEP) {
      const fromMs = view.startMs + x * msPerPx;
      const toMsAt = fromMs + BAR_STEP * msPerPx;
      if (fromMs >= durationMs) break;
      const peak = peakBetween(fromMs, toMsAt, overview, detail);
      const ms = (fromMs + toMsAt) / 2;
      const full = Math.max(1, peak * (middle - 6));
      const kept = ms >= edits.startMs && ms <= edits.endMs;
      if (!kept) {
        ctx.fillStyle = removed;
        ctx.fillRect(x, middle - full, BAR_STEP - 1, full * 2);
        continue;
      }
      // Inside a fade, the faint bar is the original and the bright bar what
      // will be heard.
      const gain = gainAt(ms, edits);
      if (gain < 1) {
        ctx.fillStyle = faded;
        ctx.fillRect(x, middle - full, BAR_STEP - 1, full * 2);
      }
      const heard = Math.max(1, full * gain);
      ctx.fillStyle = gradient;
      ctx.fillRect(x, middle - heard, BAR_STEP - 1, heard * 2);
    }
  }, [overview, detail, width, durationMs, edits, view]);

  // Ctrl + wheel zooms around the pointer; the wheel scrolls through a zoomed waveform.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return undefined;
    const onWheel = (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const anchor = view.startMs + ((event.clientX - rect.left) / rect.width) * view.spanMs;
        onViewChange(zoomView(view, event.deltaY < 0 ? 1.25 : 0.8, anchor, durationMs));
        return;
      }
      if (view.spanMs >= durationMs) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      onViewChange(clampView({ startMs: view.startMs + (delta / Math.max(1, width)) * view.spanMs, spanMs: view.spanMs }, durationMs));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [view, width, durationMs, onViewChange]);

  const handlePointerDown = (event, key) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = key;
  };
  const handlePointerMove = (event) => {
    if (!drag.current) return;
    onChange({ ...edits, [drag.current]: toMs(event.clientX) }, drag.current);
  };
  const handlePointerUp = () => {
    drag.current = null;
  };
  // Arrow keys nudge a handle by 0.1 s, Shift by 1 s, Alt by 10 ms.
  const handleKey = (event, key) => {
    const step = event.shiftKey ? 1000 : event.altKey ? 10 : 100;
    const delta = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
    if (!delta) return;
    event.preventDefault();
    onChange({ ...edits, [key]: edits[key] + delta }, key);
  };

  const clampX = (x) => Math.min(Math.max(x, -20), width + 20);
  const startX = clampX(toX(edits.startMs));
  const endX = clampX(toX(edits.endMs));
  const fadeInX = clampX(toX(edits.startMs + edits.fadeInMs));
  const fadeOutX = clampX(toX(edits.endMs - edits.fadeOutMs));
  const step = tickStep(view.spanMs, width);
  const ticks = [];
  for (let ms = Math.ceil(view.startMs / step) * step; ms <= view.startMs + view.spanMs && width; ms += step) ticks.push(ms);
  const tickDigits = step < 100 ? 2 : step < 1000 ? 1 : 0;

  return (
    <div className="wm-wave">
      {/* The frame's side padding keeps the handles at the very start and end visible. */}
      <div className="wm-wave__frame">
        <div
          className="wm-wave__canvas-wrap"
          ref={wrapRef}
          style={{ height: WAVE_HEIGHT }}
          onPointerDown={(event) => event.button === 0 && onSeek(toMs(event.clientX))}
        >
          <canvas ref={canvasRef} className="wm-wave__canvas" style={{ width: "100%", height: WAVE_HEIGHT }} aria-hidden="true" />
          <div className="wm-wave__removed" style={{ left: 0, width: Math.max(0, startX) }} />
          <div className="wm-wave__removed" style={{ left: Math.min(width, endX), right: 0 }} />
          {(edits.fadeInMs > 0 || edits.fadeOutMs > 0) && (
            <svg className="wm-wave__envelope" width={width} height={WAVE_HEIGHT} aria-hidden="true">
              <polyline points={`${startX},${WAVE_HEIGHT - 6} ${fadeInX},6 ${fadeOutX},6 ${endX},${WAVE_HEIGHT - 6}`} />
            </svg>
          )}
          <div className="wm-wave__playhead" ref={playheadRef} />
          {[
            ["startMs", toX(edits.startMs), "Trim start"],
            ["endMs", toX(edits.endMs), "Trim end"],
          ].map(([key, x, label]) => (
            <div
              key={key}
              className={`wm-wave__handle ${key === "startMs" ? "is-start" : "is-end"}`}
              style={{ left: x, display: x < -8 || x > width + 8 ? "none" : undefined }}
              role="slider"
              tabIndex={0}
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={Math.round(durationMs / 1000)}
              aria-valuenow={Math.round(edits[key] / 1000)}
              aria-valuetext={formatTime(edits[key], { digits: 2 })}
              onPointerDown={(event) => handlePointerDown(event, key)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onKeyDown={(event) => handleKey(event, key)}
            >
              <span className="wm-wave__grip" />
            </div>
          ))}
        </div>
      </div>
      <div className="wm-wave__timeline" aria-hidden="true">
        {ticks.map((ms) => (
          <span key={ms} className="wm-wave__tick" style={{ left: toX(ms) }}>
            {formatTime(ms, { digits: tickDigits })}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Zoom buttons, the visible stretch, and a scroll bar while zoomed in. */
function ZoomBar({ view, durationMs, onZoom, onFit, onScroll }) {
  const zoomed = view.spanMs < durationMs;
  const level = durationMs / view.spanMs;
  return (
    <div className="wm-zoom">
      <div className="wm-zoom__buttons" role="group" aria-label="Zoom">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onZoom(1 / ZOOM_STEP)} disabled={!zoomed} aria-label="Zoom out" title="Zoom out (Ctrl + scroll)">
          −
        </button>
        <span className="wm-zoom__level" aria-live="polite">
          {level < 1.05 ? "Whole song" : `${level < 10 ? level.toFixed(1) : Math.round(level)}×`}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onZoom(ZOOM_STEP)} disabled={view.spanMs <= 1000} aria-label="Zoom in" title="Zoom in (Ctrl + scroll)">
          +
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onFit} disabled={!zoomed}>
          Fit to View
        </button>
      </div>
      {zoomed && (
        <>
          <input
            type="range"
            className="wm-zoom__scroll"
            min={0}
            max={Math.max(0, durationMs - view.spanMs)}
            step={10}
            value={view.startMs}
            onChange={(event) => onScroll(Number(event.target.value))}
            aria-label="Scroll through the waveform"
          />
          <span className="wm-zoom__range">
            {formatTime(view.startMs)}–{formatTime(view.startMs + view.spanMs)}
          </span>
        </>
      )}
    </div>
  );
}

/** A time input ("1:05.3"); the value is applied on Enter or when leaving the field. */
function TimeField({ label, valueMs, onCommit, disabled }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft === null) return;
    const ms = parseTime(draft);
    if (ms !== null) onCommit(ms);
    setDraft(null);
  };
  return (
    <label className="form-field wm-editor__time">
      <span className="form-field__label">{label}</span>
      <input
        className="field"
        value={draft ?? formatTime(valueMs, { digits: 2 })}
        disabled={disabled}
        inputMode="decimal"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
    </label>
  );
}

function FadeControl({ label, valueMs, maxMs, onChange, disabled }) {
  const seconds = (valueMs / 1000).toFixed(1);
  return (
    <div className="wm-editor__fade">
      <span className="form-field__label">{label}</span>
      <div className="wm-editor__fade-row">
        <input
          type="range"
          className="wm-editor__slider"
          min={0}
          max={Math.max(0, Math.floor(maxMs / 100) * 100)}
          step={100}
          value={Math.min(valueMs, maxMs)}
          disabled={disabled || maxMs <= 0}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={`${label} length`}
        />
        <input
          type="number"
          className="field wm-editor__seconds"
          min={0}
          max={(maxMs / 1000).toFixed(1)}
          step={0.1}
          value={seconds}
          disabled={disabled}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) onChange(Math.round(value * 1000));
          }}
          aria-label={`${label} in seconds`}
        />
        <span className="wm-editor__unit">s</span>
      </div>
    </div>
  );
}

/**
 * Trim and fade editor, shared by the library ("library": a song already in
 * the library, saved in place) and Add Music ("staged": a fresh extraction
 * that is added to the library when saved or skipped).
 *
 * Preview playback is the real file with the edits applied live: it stops at
 * the end handle and follows the same linear fade ramps FFmpeg uses when
 * saving. Nothing plays until the user presses play. The audio element's
 * own time is the only clock: one animation loop runs while it plays and
 * moves the playhead directly, so seeking during playback just works.
 */
export function AudioEditor({ mode, trackId = null, token = null, onClose, onDone }) {
  const [info, setInfo] = useState(null);
  const [wave, setWave] = useState(null);
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState(null); // { startMs, spanMs }
  const [loadError, setLoadError] = useState("");
  const [edits, setEdits] = useState(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState("");
  const [saveError, setSaveError] = useState("");
  const [reload, setReload] = useState(0);
  const audioRef = useRef(null);
  const waveRef = useRef(null);
  const clockRef = useRef(null);
  const editsRef = useRef(null);
  const viewRef = useRef(null);
  const stopAtRef = useRef(null);
  const runJob = useJobRunner();
  const player = usePlayer();

  const durationMs = wave?.durationMs || info?.durationMs || 0;
  useLayoutEffect(() => {
    editsRef.current = edits;
    viewRef.current = view;
  });

  // One thing plays at a time: the music player pauses while editing.
  useEffect(() => {
    player?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    const source = mode === "library" ? { trackId } : { token };
    Promise.all([mode === "library" ? libraryApi.getAudioEditSource({ trackId }) : libraryApi.getStagedExtraction({ token }), libraryApi.audioWaveform(source)])
      .then(([nextInfo, nextWave]) => {
        if (cancelled) return;
        const length = nextWave.durationMs || nextInfo.durationMs;
        setLoadError("");
        setInfo(nextInfo);
        setWave(nextWave);
        setView((current) => current || { startMs: 0, spanMs: length });
        setEdits((current) => current || initialEdits(length));
      })
      .catch((error) => !cancelled && setLoadError(errorMessage(error, "This song couldn't be opened for editing.")));
    return () => {
      cancelled = true;
    };
  }, [mode, trackId, token, reload]);

  // Zoomed in: a finer waveform of the visible stretch (and a margin around
  // it for scrolling), loaded once the view settles.
  useEffect(() => {
    if (!view || !durationMs || view.spanMs > durationMs * DETAIL_BELOW) return undefined;
    const covers = detail && detail.startMs <= view.startMs && detail.startMs + detail.durationMs >= view.startMs + view.spanMs;
    if (covers && (detail.peaks.length * view.spanMs) / detail.durationMs >= 700) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      const startMs = Math.max(0, Math.round(view.startMs - view.spanMs));
      const endMs = Math.min(durationMs, Math.round(view.startMs + 2 * view.spanMs));
      libraryApi
        .audioWaveform({ ...(mode === "library" ? { trackId } : { token }), startMs, endMs, points: 3600 })
        .then((next) => !cancelled && setDetail(next))
        .catch(() => {});
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, durationMs, detail, mode, trackId, token]);

  // Shows a playback time without re-rendering: playhead and clock.
  const showTime = useCallback((ms) => {
    waveRef.current?.setPlayhead(ms);
    if (clockRef.current) clockRef.current.textContent = formatTime(ms, { digits: 2 });
  }, []);

  useEffect(() => showTime(playheadMs), [playheadMs, showTime]);

  // While playing: follow the audio's own time, apply the fades as volume,
  // stop at the end of what will be kept, and keep the playhead in view.
  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const loop = () => {
      const audio = audioRef.current;
      const current = editsRef.current;
      if (!audio || !current) return;
      const ms = audio.currentTime * 1000;
      const stopAt = stopAtRef.current;
      if (stopAt !== null && ms >= stopAt) {
        audio.pause();
        audio.currentTime = stopAt / 1000;
        showTime(stopAt);
        return;
      }
      audio.volume = ms >= current.startMs && ms <= current.endMs ? gainAt(ms, current) : 1;
      showTime(ms);
      const shown = viewRef.current;
      if (shown && shown.spanMs < durationMs && (ms > shown.startMs + shown.spanMs * 0.97 || ms < shown.startMs)) {
        setView(clampView({ startMs: ms - shown.spanMs * 0.05, spanMs: shown.spanMs }, durationMs));
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, durationMs, showTime]);

  // Leaving the editor stops the preview and lets the decoder go.
  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
    [],
  );

  const currentMs = () => (audioRef.current ? audioRef.current.currentTime * 1000 : playheadMs);

  const playRange = (fromMs, untilMs) => {
    const audio = audioRef.current;
    if (!audio) return;
    stopAtRef.current = untilMs;
    audio.currentTime = fromMs / 1000;
    audio.volume = fromMs >= edits.startMs && fromMs <= edits.endMs ? gainAt(fromMs, edits) : 1;
    showTime(fromMs);
    audio.play().catch(() => {});
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio || !edits) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    // From the playhead; at the end of the selection, from its start again.
    let from = currentMs();
    if (from >= edits.endMs - 50 && from <= edits.endMs + 50) from = edits.startMs;
    playRange(from, from <= edits.endMs ? edits.endMs : durationMs);
  };

  const changeEdits = (next, key) => setEdits(clampEdits(next, durationMs, key));

  // Clicking the waveform moves the playhead; during playback, playback
  // simply continues from there.
  const seek = (ms) => {
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = ms / 1000;
      if (!audio.paused) stopAtRef.current = ms <= edits.endMs ? edits.endMs : durationMs;
    }
    setPlayheadMs(ms);
    showTime(ms);
  };

  const zoom = (factor) => {
    const at = currentMs();
    const anchor = at >= view.startMs && at <= view.startMs + view.spanMs ? at : view.startMs + view.spanMs / 2;
    setView(zoomView(view, factor, anchor, durationMs));
  };

  useEffect(() => {
    const handleKey = (event) => {
      if (event.code !== "Space" || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName)) return;
      event.preventDefault();
      togglePlay();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });

  const busy = !!saving;
  const changed = edits ? hasChanges(edits, durationMs) : false;
  const lengthMs = edits ? edits.endMs - edits.startMs : 0;
  const needsLibrary = info && !info.hasLibraryFolder;
  const notEditable = mode === "library" && info && !info.editable;

  const save = async ({ skip = false } = {}) => {
    audioRef.current?.pause();
    setSaveError("");
    setSaving(skip ? "Adding to your library…" : edits.fadeInMs || edits.fadeOutMs || !info.lossy ? "Applying edits…" : "Trimming…");
    try {
      if (mode === "library") {
        const job = await runJob(libraryApi.applyAudioEdit({ trackId, edits }));
        if (job.status !== "completed") throw new Error(job.error || "The edits couldn't be saved.");
        onDone?.(job.result);
      } else {
        const result = await libraryApi.commitStagedExtraction({ token, edits: skip || !changed ? undefined : edits });
        onDone?.(result);
      }
    } catch (error) {
      setSaveError(errorMessage(error, "The edits couldn't be saved."));
      setSaving("");
    }
  };

  const chooseLibraryFolder = async () => {
    try {
      if (await libraryApi.chooseManagedRoot()) setReload((value) => value + 1);
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  };

  const footer = (
    <>
      <button type="button" className="btn btn--ghost wm-editor__reset" onClick={() => setEdits(initialEdits(durationMs))} disabled={busy || !changed}>
        Reset Edits
      </button>
      {saving && <span className="settings-hint wm-editor__saving">{saving}</span>}
      {mode === "library" ? (
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn--primary ${busy ? "is-loading" : ""}`}
            onClick={() => save()}
            disabled={busy || !edits || !changed || needsLibrary || notEditable}
          >
            Save Changes
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn--secondary" onClick={() => save({ skip: true })} disabled={busy || !info || needsLibrary}>
            Skip Editing &amp; Add to Library
          </button>
          <button
            type="button"
            className={`btn btn--primary ${busy ? "is-loading" : ""}`}
            onClick={() => save()}
            disabled={busy || !edits || !changed || needsLibrary}
          >
            Save &amp; Add to Library
          </button>
        </>
      )}
    </>
  );

  return (
    <Dialog title="Edit Audio" wide onClose={busy ? undefined : onClose} footer={footer} labelledBy="wm-editor-title">
      <div className="wm-editor">
        {loadError && (
          <div className="alert alert--compact" role="alert">
            <WarningIcon size={16} /> {loadError}
          </div>
        )}

        {!loadError && (!info || !wave || !edits) && (
          <div className="wm-editor__loading">
            <span className="artwork__spinner" aria-hidden="true" />
            Reading the audio…
          </div>
        )}

        {info && wave && edits && view && (
          <>
            <div className="wm-editor__head">
              <Artwork className="wm-editor__art" hash={info.artworkHash} size={160} />
              <div className="wm-editor__title">
                <strong>{info.title || "Untitled"}</strong>
                <span className="text-muted">{[info.artist, info.album].filter(Boolean).join(" · ")}</span>
              </div>
              <div className="wm-editor__lengths" aria-live="polite">
                <span className="text-muted">Original {formatTime(durationMs)}</span>
                <strong>{changed ? `New length ${formatTime(lengthMs)}` : "No changes yet"}</strong>
              </div>
            </div>

            <Waveform ref={waveRef} overview={wave} detail={detail} durationMs={durationMs} edits={edits} view={view} onViewChange={setView} onChange={changeEdits} onSeek={seek} />
            <ZoomBar
              view={view}
              durationMs={durationMs}
              onZoom={zoom}
              onFit={() => setView({ startMs: 0, spanMs: durationMs })}
              onScroll={(startMs) => setView(clampView({ startMs, spanMs: view.spanMs }, durationMs))}
            />

            <audio
              ref={audioRef}
              src={mode === "library" ? mediaUrl(info.fileId) : `wavemint-media://staged/${token}`}
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={(event) => {
                setPlaying(false);
                setPlayheadMs(event.currentTarget.currentTime * 1000);
              }}
              onEnded={(event) => {
                setPlaying(false);
                setPlayheadMs(event.currentTarget.currentTime * 1000);
              }}
              onError={() => setLoadError("This audio can't be previewed.")}
            />

            <div className="wm-editor__transport">
              <button type="button" className="btn btn--primary wm-editor__play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} disabled={busy}>
                {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                {playing ? "Pause" : "Play"}
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => playRange(edits.startMs, edits.endMs)} disabled={busy}>
                Play Selection
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => playRange(edits.startMs, Math.min(edits.endMs, edits.startMs + PREVIEW_EDGE_MS))} disabled={busy}>
                Preview Start
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => playRange(Math.max(edits.startMs, edits.endMs - PREVIEW_EDGE_MS), edits.endMs)} disabled={busy}>
                Preview End
              </button>
              <span className="wm-editor__clock">
                <span ref={clockRef}>{formatTime(playheadMs, { digits: 2 })}</span> <span className="text-muted">/ {formatTime(durationMs, { digits: 2 })}</span>
              </span>
            </div>

            <div className="wm-editor__controls">
              <fieldset className="wm-editor__group" disabled={busy}>
                <legend className="section-label">Trim</legend>
                <div className="wm-editor__trim">
                  <TimeField label="Start" valueMs={edits.startMs} onCommit={(ms) => changeEdits({ ...edits, startMs: ms }, "startMs")} />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => changeEdits({ ...edits, startMs: currentMs() }, "startMs")}>
                    Set to Playhead
                  </button>
                  <TimeField label="End" valueMs={edits.endMs} onCommit={(ms) => changeEdits({ ...edits, endMs: ms }, "endMs")} />
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => changeEdits({ ...edits, endMs: currentMs() }, "endMs")}>
                    Set to Playhead
                  </button>
                </div>
                <p className="settings-hint">
                  Removes {formatTime(edits.startMs)} from the start and {formatTime(durationMs - edits.endMs)} from the end. Drag the handles, nudge them with the
                  arrow keys (Alt for 10 ms), or type a time such as 1:05.32.
                </p>
              </fieldset>

              <fieldset className="wm-editor__group" disabled={busy}>
                <legend className="section-label">Fades</legend>
                <FadeControl label="Fade in" valueMs={edits.fadeInMs} maxMs={maxFade(edits, "fadeInMs")} onChange={(ms) => changeEdits({ ...edits, fadeInMs: ms }, "fadeInMs")} />
                <FadeControl label="Fade out" valueMs={edits.fadeOutMs} maxMs={maxFade(edits, "fadeOutMs")} onChange={(ms) => changeEdits({ ...edits, fadeOutMs: ms }, "fadeOutMs")} />
              </fieldset>
            </div>

            <p className="settings-hint wm-editor__note">
              {info.lossy
                ? "A trim alone is saved without re-encoding. Fades re-encode the audio at the original's quality."
                : "Edits are saved losslessly."}{" "}
              {mode === "library" &&
                (info.inLibraryFolder
                  ? `The current version is kept for ${info.keptFor || "3 days"}, so you can undo this from History.`
                  : `Your original file in "${info.sourceName}" isn't changed; the edited version is saved in your WaveMint Library. Undo it from History within ${info.keptFor || "3 days"}.`)}
              {mode === "staged" && " The song is added with its details and artwork once you save or skip editing."}
            </p>

            {needsLibrary && (
              <div className="alert alert--compact" role="alert">
                <WarningIcon size={16} />
                <span className="alert__text">Choose a folder for your WaveMint Library first; edited songs are saved there.</span>
                <button type="button" className="btn btn--secondary btn--sm" onClick={chooseLibraryFolder}>
                  Choose Folder…
                </button>
              </div>
            )}
            {notEditable && (
              <div className="alert alert--compact" role="alert">
                <WarningIcon size={16} /> WaveMint can&apos;t edit this file&apos;s format.
              </div>
            )}
          </>
        )}

        {saveError && (
          <div className="alert alert--compact" role="alert">
            <WarningIcon size={16} /> {saveError}
          </div>
        )}
      </div>
    </Dialog>
  );
}
