import { useEffect, useMemo, useRef, useState } from "react";
import { describeProgress, formatDuration as formatSeconds } from "../addMusic/extraction";
import { ProgressBar } from "../addMusic/parts";
import { parseIpcError } from "../ipcErrors";
import { usePlayer } from "../player/usePlayer";
import { Artwork } from "./Artwork";
import { Dialog } from "./Dialog";
import { GenreOptions, MetadataFields } from "./Editors";
import { EDIT_FIELDS, displayValue, toApiValue, toFormValue } from "./fields";
import { codecLabel, formatBytes, formatDuration } from "./format";
import { FolderOpenIcon, PauseIcon, PlayIcon, SearchIcon, UpgradeIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useJobRunner, useLibraryEvent } from "./useLibrary";

// Upgrade Track keeps three things apart:
//   1. the song as it is now (`track`, and `original`: its values as form values),
//   2. what the replacement source says about itself (the analysis of a URL,
//      or the replacement file's own tags), shown only as a source preview,
//   3. the edited metadata and artwork (`form`, `artwork`): the only values
//      written into the new file.
// The form is filled from (1) once, when the dialog opens, and only the user
// changes it afterwards (typing, or "Use Detected Metadata"). Analyses and
// extractions that finish late can't touch it, and results that arrive for an
// abandoned request are discarded (see `seq`).

const METHODS = [
  ["file", "Choose File"],
  ["url", "Analyze URL"],
];

const ARTWORK_CHOICES = [
  ["current", "Current"],
  ["candidate", "Source"],
  ["custom", "Custom"],
  ["none", "None"],
];

const JOB_PHASES = {
  copying: "Copying and verifying the replacement…",
  tagging: "Writing metadata and artwork…",
};

const formValues = (track) => Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, toFormValue(field, track[field.column])]));

/** Two players sharing one position, for switching between versions. */
function AbPlayer({ currentSrc, candidateSrc }) {
  const refs = { a: useRef(null), b: useRef(null) };
  const [side, setSide] = useState(null); // "a" | "b" | null
  const [paused, setPaused] = useState(true);
  const player = usePlayer();

  const play = (next) => {
    const from = side ? refs[side].current : null;
    const to = refs[next].current;
    if (!to) return;
    // One thing plays at a time.
    player.pause();
    if (side === next) {
      if (to.paused) to.play().catch(() => {});
      else to.pause();
      return;
    }
    if (from) {
      to.currentTime = Math.min(from.currentTime, to.duration || from.currentTime);
      from.pause();
    }
    to.play().catch(() => {});
    setSide(next);
  };

  // Unloading (not just pausing) closes the media streams, so the files they
  // read can be moved or deleted (Windows keeps open files "delete pending").
  useEffect(
    () => () => {
      for (const ref of [refs.a, refs.b]) {
        const audio = ref.current;
        if (!audio) continue;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const button = (key, label, disabled) => {
    const active = side === key && !paused;
    return (
      <button type="button" className={`btn ${side === key ? "btn--primary" : "btn--secondary"} btn--sm`} disabled={disabled} onClick={() => play(key)}>
        {active ? <PauseIcon size={14} /> : <PlayIcon size={14} />} {label}
      </button>
    );
  };

  return (
    <div className="lib-ab">
      {["a", "b"].map((key) => (
        <audio
          key={key}
          ref={refs[key]}
          src={(key === "a" ? currentSrc : candidateSrc) || undefined}
          preload="metadata"
          onPlay={() => setPaused(false)}
          onPause={() => side === key && setPaused(true)}
        />
      ))}
      {button("a", "Current", !currentSrc)}
      {button("b", "Replacement", !candidateSrc)}
      <span className="settings-hint">Switching keeps the position, so you can compare the same moment.</span>
    </div>
  );
}

/** Spectrograms of both versions, on request (about a second each). */
function Spectrograms({ currentFileId, candidateId }) {
  const [images, setImages] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const [current, candidate] = await Promise.all([
        currentFileId ? libraryApi.spectrogram({ fileId: currentFileId }) : null,
        libraryApi.spectrogram({ candidateId }),
      ]);
      setImages({ current, candidate });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!images) {
    return (
      <div className="lib-spectra__start">
        <button type="button" className={`btn btn--ghost btn--sm ${busy ? "is-loading" : ""}`} disabled={busy} onClick={load}>
          Show Spectrograms
        </button>
        <span className="settings-hint">A lossy encode often shows as a flat ceiling in the high frequencies. A hint, not proof.</span>
        {error && <span className="settings-hint">{error}</span>}
      </div>
    );
  }
  return (
    <div className="lib-spectra">
      {images.current && (
        <figure>
          <img src={images.current} alt="Spectrogram of the current version" />
          <figcaption>Current</figcaption>
        </figure>
      )}
      <figure>
        <img src={images.candidate} alt="Spectrogram of the replacement" />
        <figcaption>Replacement</figcaption>
      </figure>
    </div>
  );
}

function describeFormat(file) {
  if (!file?.codec) return null;
  return `${codecLabel(file.codec)}${file.lossless ? " (lossless)" : ""}`;
}

function describeRate(file) {
  if (!file?.sampleRate) return null;
  const rate = `${(file.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`;
  return file.bitDepth ? `${rate} · ${file.bitDepth}-bit` : rate;
}

function describeChannels(count) {
  if (!count) return null;
  return { 1: "Mono", 2: "Stereo" }[count] || `${count} channels`;
}

/** Current vs replacement, technical facts only. */
function QualityTable({ current, replacement, estimate }) {
  const rows = [
    ["Format", describeFormat(current), estimate ? estimate.format : describeFormat(replacement)],
    ["Bitrate", current?.bitrate ? `${current.bitrate} kbps` : null, estimate ? estimate.bitrate : replacement?.bitrate ? `${replacement.bitrate} kbps` : null],
    ["Sample rate", describeRate(current), estimate ? null : describeRate(replacement)],
    ["Channels", describeChannels(current?.channels), estimate ? null : describeChannels(replacement?.channels)],
    ["Size", current?.size ? formatBytes(current.size) : null, estimate ? null : replacement?.size ? formatBytes(replacement.size) : null],
    ["Length", current?.durationMs ? formatDuration(current.durationMs) : null, estimate ? estimate.length : replacement?.durationMs ? formatDuration(replacement.durationMs) : null],
  ];
  return (
    <div className="lib-upgrade__quality" role="table" aria-label="Quality comparison">
      <div className="lib-upgrade__qrow is-head" role="row">
        <span role="columnheader" />
        <span role="columnheader">Current</span>
        <span role="columnheader">Replacement{estimate ? " (estimated)" : ""}</span>
      </div>
      {rows.map(([label, now, next]) => (
        <div key={label} className="lib-upgrade__qrow" role="row">
          <span role="rowheader">{label}</span>
          <span role="cell">{now || "—"}</span>
          <span role="cell" className={next ? "" : "is-unknown"}>
            {next || (estimate ? "After extraction" : "—")}
          </span>
        </div>
      ))}
    </div>
  );
}

/** "Use Detected Metadata": pick which detected values replace the form's. */
function DetectedMetadata({ detected, form, onApply, onClose }) {
  const changes = detected.filter((item) => item.formValue !== form[item.key]);
  const [picked, setPicked] = useState(() => new Set(changes.filter((item) => form[item.key] === "" || form[item.key] === false).map((item) => item.key)));
  if (!changes.length) {
    return (
      <div className="lib-upgrade__detected">
        <span className="settings-hint">The detected metadata matches what&apos;s in the form.</span>
        <button type="button" className="btn btn--link" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  const toggle = (key) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div className="lib-upgrade__detected">
      <span className="settings-hint">Only the fields you tick change. Everything else stays as it is in the form.</span>
      {changes.map((item) => (
        <label key={item.key} className="lib-upgrade__detected-row">
          <input type="checkbox" checked={picked.has(item.key)} onChange={() => toggle(item.key)} />
          <span className="lib-upgrade__detected-field">{item.label}</span>
          <span className="lib-upgrade__detected-old">{displayValue(form[item.key])}</span>
          <span aria-hidden="true">→</span>
          <span className="lib-upgrade__detected-new">{displayValue(item.formValue)}</span>
        </label>
      ))}
      <div className="lib-upgrade__detected-actions">
        <button type="button" className="btn btn--secondary btn--sm" disabled={!picked.size} onClick={() => onApply(changes.filter((item) => picked.has(item.key)))}>
          Use {picked.size || ""} Selected
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Upgrade Track: replace a song's file with a new one (from a file or a URL),
 * with the song's metadata prefilled and editable, and the chosen metadata
 * and artwork written into the new file.
 * `start` is { fileId } to use another version of the song; `candidateId`
 * opens a replacement prepared elsewhere (an album import).
 */
export function UpgradeDialog({ trackId, start = null, candidateId: initialCandidate = null, onClose, onDone }) {
  const [track, setTrack] = useState(null);
  const [form, setForm] = useState(null);
  const [method, setMethod] = useState("file");
  const [candidates, setCandidates] = useState({ file: null, url: null });
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState("");

  const [url, setUrl] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [squarePreview, setSquarePreview] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [status, setStatus] = useState(null);
  const [urlError, setUrlError] = useState(null);

  const [artwork, setArtwork] = useState("current");
  const [customArt, setCustomArt] = useState(null);
  const [showDetected, setShowDetected] = useState(false);
  const [confirmedFor, setConfirmedFor] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [applying, setApplying] = useState(false);
  const [jobPhase, setJobPhase] = useState("");

  // Requests are numbered; a response for an older number is stale.
  const seq = useRef(0);
  const mounted = useRef(true);
  const created = useRef(new Set()); // replacements this dialog prepared
  const applied = useRef(new Set());
  const runJob = useJobRunner();

  // 1. The song as it is now; the form starts from it (once).
  useEffect(() => {
    let cancelled = false;
    libraryApi
      .getTrack({ id: trackId })
      .then((row) => {
        if (cancelled) return;
        if (!row) throw new Error("This song no longer exists.");
        setTrack(row);
        setForm(formValues(row));
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  const original = useMemo(() => (track ? formValues(track) : null), [track]);
  const activeFile = track?.files.find((file) => file.id === track.active_file_id) || null;
  const currentArt = track ? track.artwork_hash || activeFile?.artwork_hash || null : null;

  // A replacement prepared elsewhere (another version, an album import).
  useEffect(() => {
    let cancelled = false;
    const load = initialCandidate
      ? libraryApi.compareUpgrade({ candidateId: initialCandidate })
      : start?.fileId
        ? libraryApi.prepareUpgrade({ trackId, fileId: start.fileId })
        : null;
    if (!load) return undefined;
    setLoadingFile(true);
    load
      .then((comparison) => {
        if (cancelled) return;
        if (!initialCandidate) created.current.add(comparison.candidateId);
        setCandidates((current) => ({ ...current, file: comparison }));
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setLoadingFile(false));
    return () => {
      cancelled = true;
    };
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replacements this dialog made and didn't use are discarded on close
  // (an extracted one only lived in the library's staging folder).
  useEffect(
    () => () => {
      mounted.current = false;
      seq.current += 1;
      for (const id of created.current) if (!applied.current.has(id)) libraryApi.discardUpgrade({ candidateId: id }).catch(() => {});
    },
    [],
  );

  // Progress of our own analysis/extraction, and of the upgrade job.
  const listening = useRef(false);
  useEffect(() => {
    listening.current = analyzing || extracting;
  }, [analyzing, extracting]);
  useEffect(() => {
    const removeAnalyze = window.waveMintAPI.onAnalyzeProgress((data) => listening.current && setStatus(data));
    const removeDownload = window.waveMintAPI.onDownloadProgress((data) => listening.current && setStatus(data));
    return () => {
      removeAnalyze();
      removeDownload();
    };
  }, []);
  useLibraryEvent(({ name, data }) => {
    if (name === "job" && jobId && data.id === jobId && data.status === "running" && data.progress?.phase) setJobPhase(data.progress.phase);
  });

  const comparison = candidates[method];
  const busy = analyzing || extracting || applying || loadingFile;

  /** Replaces the candidate for a method; the previous one (if ours) is discarded. */
  const setCandidate = (key, next) => {
    setCandidates((current) => {
      const previous = current[key];
      if (previous && previous.candidateId !== next?.candidateId && created.current.has(previous.candidateId)) {
        created.current.delete(previous.candidateId);
        libraryApi.discardUpgrade({ candidateId: previous.candidateId }).catch(() => {});
      }
      return { ...current, [key]: next };
    });
  };

  // --- Choose File -------------------------------------------------------------

  const chooseFile = async () => {
    setError("");
    setLoadingFile(true);
    try {
      const next = await libraryApi.chooseUpgradeFile({ trackId });
      if (!next || !mounted.current) {
        if (next && !mounted.current) libraryApi.discardUpgrade({ candidateId: next.candidateId }).catch(() => {});
        return;
      }
      created.current.add(next.candidateId);
      setCandidate("file", next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (mounted.current) setLoadingFile(false);
    }
  };

  // --- Analyze URL -------------------------------------------------------------

  const analyze = async (event) => {
    event?.preventDefault();
    const value = url.trim();
    if (!value || busy) return;
    const mine = ++seq.current;
    setAnalyzing(true);
    setUrlError(null);
    setStatus(null);
    setAnalysis(null);
    setSquarePreview("");
    setCandidate("url", null);
    try {
      const data = await window.waveMintAPI.analyzeUrl({ url: value, mode: "video" });
      if (seq.current !== mine) return;
      if (data.isPlaylist) throw new Error("That's a playlist. Paste the URL of a single video.");
      setAnalysis(data);
      if (data.thumbnail) {
        window.waveMintAPI
          .generateSquareCropPreview({ thumbnail: data.thumbnail })
          .then((preview) => seq.current === mine && setSquarePreview(preview.previewUrl))
          .catch(() => {});
      }
    } catch (err) {
      if (seq.current === mine) {
        const parsed = parseIpcError(err, "That URL couldn't be analyzed.");
        setUrlError(parsed.code === "cancelled" ? null : parsed);
      }
    } finally {
      if (seq.current === mine) setAnalyzing(false);
    }
  };

  // Extracts the analyzed source with Add Music's pipeline; the result is a
  // replacement candidate (nothing changes in the library yet).
  const extract = async () => {
    if (!analysis || busy) return;
    const mine = ++seq.current;
    setExtracting(true);
    setCancelling(false);
    setUrlError(null);
    setStatus(null);
    try {
      const response = await window.waveMintAPI.downloadMp3({
        url: analysis.webpage_url || url.trim(),
        // The source's own details; the final metadata is written at upgrade time.
        metadata: analysis.metadata,
        thumbnail: analysis.thumbnail,
        artwork: { mode: "square_crop" },
        upgradeTrackId: trackId,
      });
      const next = response?.upgrade;
      if (!next) throw new Error("The extraction didn't produce a replacement.");
      if (seq.current !== mine || !mounted.current) {
        libraryApi.discardUpgrade({ candidateId: next.candidateId }).catch(() => {});
        return;
      }
      created.current.add(next.candidateId);
      setCandidate("url", next);
    } catch (err) {
      if (seq.current === mine) {
        const parsed = parseIpcError(err, "The extraction stopped.");
        setUrlError(parsed.code === "cancelled" ? null : parsed);
      }
    } finally {
      if (seq.current === mine) {
        setExtracting(false);
        setCancelling(false);
        setStatus(null);
      }
    }
  };

  const cancelExtraction = async () => {
    setCancelling(true);
    try {
      await window.waveMintAPI.cancelOperations();
    } catch {
      setCancelling(false);
    }
  };

  // --- Metadata and artwork ---------------------------------------------------------

  // What the source says about itself (never applied without asking).
  const detected = useMemo(() => {
    const byKey = new Map();
    if (comparison) {
      for (const item of comparison.fields) if (item.candidate !== null && item.candidate !== undefined) byKey.set(item.field, item.candidate);
    } else if (method === "url" && analysis?.metadata) {
      for (const key of ["title", "artist", "album", "genre"]) if (analysis.metadata[key]) byKey.set(key, analysis.metadata[key]);
    }
    return EDIT_FIELDS.filter((field) => byKey.has(field.key)).map((field) => ({
      key: field.key,
      label: field.label === "of" ? `${field.key.startsWith("track") ? "Track" : "Disc"} total` : field.label,
      formValue: toFormValue(field, byKey.get(field.key)),
    }));
  }, [comparison, method, analysis]);

  const sourceArt = comparison?.artwork.candidate || null;
  const sourceArtPreview = sourceArt ? "" : method === "url" ? squarePreview || analysis?.thumbnail || "" : "";
  const sourceArtAvailable = !!sourceArt || (method === "url" && !!analysis?.thumbnail && !comparison);

  const artPreview = {
    current: { hash: currentArt },
    candidate: { hash: sourceArt, src: sourceArtPreview },
    custom: { hash: customArt },
    none: {},
  }[artwork];

  const chooseCustomArt = async () => {
    try {
      const chosen = await libraryApi.chooseUpgradeArtwork({});
      if (chosen?.hash && mounted.current) {
        setCustomArt(chosen.hash);
        setArtwork("custom");
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const artworkCaption = {
    current: currentArt ? "The song's current artwork" : "The song has no artwork",
    candidate: sourceArt
      ? method === "url"
        ? "The video thumbnail, square-cropped"
        : "The replacement file's own artwork"
      : sourceArtAvailable
        ? "The video thumbnail, square-cropped when extracted"
        : "The replacement has no artwork",
    custom: customArt ? "Your chosen image" : "Choose an image",
    none: "No artwork will be embedded",
  }[artwork];

  // --- Upgrade ---------------------------------------------------------------------

  const strong = comparison?.warnings.some((warning) => warning.level === "strong");
  const confirmed = confirmedFor === comparison?.candidateId;
  const plan = comparison?.plan;
  const blocked = plan?.mode === "needs_library";
  const artworkReady = artwork !== "candidate" || !!sourceArt;
  const customReady = artwork !== "custom" || !!customArt;
  const canApply = !!comparison && !!form && !busy && !blocked && (!strong || confirmed) && artworkReady && customReady;

  const apply = async () => {
    if (!canApply) return;
    setError("");
    setApplying(true);
    setJobPhase("");
    // Let the previews unmount first: they hold the replacement file open.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const candidateId = comparison.candidateId;
    const metadata = Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, toApiValue(field, form[field.key])]));
    try {
      const started = libraryApi.applyUpgrade({ candidateId, metadata, artwork, artworkHash: artwork === "custom" ? customArt : undefined });
      started.then((job) => mounted.current && setJobId(job.id)).catch(() => {});
      const job = await runJob(started);
      if (!mounted.current) return;
      if (job.status === "completed") {
        // Done: the library shows a compact confirmation and the dialog closes.
        applied.current.add(candidateId);
        onDone?.(job.result, track);
        onClose?.();
        return;
      } else {
        setError(job.status === "cancelled" ? "Cancelled. The current version is unchanged." : job.error || "The upgrade didn't complete; the current version is unchanged.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (mounted.current) {
        setApplying(false);
        setJobId(null);
      }
    }
  };

  const close = () => {
    if (applying) return; // the replacement is being put in place
    onClose?.();
  };

  // --- Rendering -------------------------------------------------------------------

  const currentFacts = comparison?.current || (activeFile && {
    codec: activeFile.codec,
    lossless: activeFile.lossless,
    bitrate: activeFile.bitrate,
    sampleRate: activeFile.sample_rate,
    bitDepth: activeFile.bit_depth,
    channels: activeFile.channels,
    size: activeFile.size,
    durationMs: activeFile.duration_ms,
  });
  const estimate =
    !comparison && method === "url" && analysis
      ? { format: "MP3 (converted from the source's best audio)", bitrate: "Unknown until extracted", length: analysis.duration ? formatSeconds(Math.round(analysis.duration)) : null }
      : null;

  const footer = (
    <>
      {applying && (
        <span className="lib-upgrade__progress" role="status" aria-live="polite">
          <span className="artwork__spinner" aria-hidden="true" />
          {JOB_PHASES[jobPhase] || "Preparing the new file…"}
          {jobId && jobPhase !== "tagging" && (
            <button type="button" className="btn btn--link" onClick={() => libraryApi.cancelJob({ id: jobId }).catch(() => {})}>
              Cancel
            </button>
          )}
        </span>
      )}
      <button type="button" className="btn btn--ghost" onClick={close} disabled={applying}>
        Cancel
      </button>
      <button type="button" className={`btn btn--primary ${applying ? "is-loading" : ""}`} disabled={!canApply} onClick={apply}>
        <UpgradeIcon size={14} /> Upgrade Track
      </button>
    </>
  );

  return (
    <Dialog title={track ? `Upgrade "${track.title || "Untitled"}"` : "Upgrade song"} wide onClose={close} footer={footer}>
      {error && (
        <div className="alert alert--compact" role="alert">
          <WarningIcon size={16} /> {error}
        </div>
      )}

      {!track || !form ? (
        !error && <p className="settings-hint">Loading the song…</p>
      ) : (
        <div className="lib-upgrade">
          {/* 1. The replacement source */}
          <section className="lib-upgrade__section" aria-label="Replacement source">
            <div className="segmented lib-upgrade__methods" role="group" aria-label="Replacement source">
              {METHODS.map(([value, label]) => (
                <button key={value} type="button" className={`segmented__option ${method === value ? "is-active" : ""}`} aria-pressed={method === value} disabled={busy} onClick={() => setMethod(value)}>
                  {label}
                </button>
              ))}
            </div>

            {method === "file" ? (
              <div className="lib-upgrade__source">
                {comparison ? (
                  <div className="lib-upgrade__source-card">
                    <Artwork className="lib-upgrade__source-art" hash={comparison.candidate.artworkHash} size={64} />
                    <div className="lib-upgrade__source-text">
                      <strong title={comparison.candidate.folder ? `${comparison.candidate.folder}\\${comparison.candidate.fileName}` : ""}>{comparison.candidate.fileName}</strong>
                      <span>
                        {comparison.kind === "version" ? `Another version of this song (${comparison.candidate.sourceName})` : comparison.kind === "extraction" ? "Extracted for an album import" : comparison.candidate.folder}
                      </span>
                    </div>
                    <button type="button" className={`btn btn--ghost btn--sm ${loadingFile ? "is-loading" : ""}`} disabled={busy} onClick={chooseFile}>
                      <FolderOpenIcon size={14} /> Choose Another…
                    </button>
                  </div>
                ) : (
                  <div className="lib-upgrade__source-empty">
                    <button type="button" className={`btn btn--secondary ${loadingFile ? "is-loading" : ""}`} disabled={busy} onClick={chooseFile}>
                      <FolderOpenIcon size={14} /> Choose Replacement File…
                    </button>
                    <span className="settings-hint">MP3, M4A, FLAC, WAV or AIFF. The file you choose is never changed; WaveMint writes into its own copy.</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="lib-upgrade__source">
                <form className="lib-upgrade__url" onSubmit={analyze}>
                  <input
                    className="field"
                    type="url"
                    value={url}
                    placeholder="Paste a YouTube video URL…"
                    aria-label="Video URL"
                    disabled={busy}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button type="submit" className={`btn btn--secondary ${analyzing ? "is-loading" : ""}`} disabled={busy || !url.trim()}>
                    <SearchIcon size={14} /> Analyze
                  </button>
                </form>
                {(analyzing || extracting) && (
                  <ProgressBar
                    value={status?.phase === "downloading" && Number.isFinite(status.percent) ? status.percent : null}
                    label={describeProgress(status, analyzing ? "Analyzing video…" : "Extracting audio…")}
                    onCancel={cancelExtraction}
                    cancelling={cancelling}
                  />
                )}
                {urlError && (
                  <div className="alert alert--compact" role="alert">
                    <WarningIcon size={16} /> {urlError.message}
                    {urlError.diagnosticsId && (
                      <button type="button" className="btn btn--link" onClick={() => window.waveMintAPI.copyErrorDetails(urlError.diagnosticsId).catch(() => {})}>
                        Copy Error Details
                      </button>
                    )}
                  </div>
                )}
                {analysis && (
                  <div className="lib-upgrade__source-card">
                    <Artwork className="lib-upgrade__source-art is-video" src={analysis.thumbnail || ""} />
                    <div className="lib-upgrade__source-text">
                      <strong title={analysis.title}>{analysis.title || "Untitled video"}</strong>
                      <span>{[analysis.uploader, analysis.duration ? formatSeconds(Math.round(analysis.duration)) : ""].filter(Boolean).join(" · ")}</span>
                    </div>
                    {!comparison && (
                      <button type="button" className={`btn btn--secondary btn--sm ${extracting ? "is-loading" : ""}`} disabled={busy} onClick={extract}>
                        Extract for Comparison
                      </button>
                    )}
                    {comparison && <span className="lib-badge is-name is-success">Extracted</span>}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 2. How it compares */}
          {(comparison || estimate) && (
            <section className="lib-upgrade__section" aria-label="Comparison">
              <span className="section-label">Quality</span>
              <QualityTable current={currentFacts} replacement={comparison?.candidate} estimate={estimate} />
              {estimate && <p className="settings-hint">The exact format is known once the audio is extracted. Nothing in your library changes until you upgrade.</p>}
              {comparison && (
                <>
                  <div className={`lib-upgrade__match is-${comparison.match.verdict}`}>
                    <strong>
                      {{
                        exact: "Identical files",
                        same: "Looks like the same recording",
                        uncertain: "Possibly a different version",
                        different: "Possibly a different recording",
                      }[comparison.match.verdict] || "Comparison"}
                    </strong>
                    <span>{comparison.match.evidence.map((item) => item.text).join(" · ")}</span>
                  </div>
                  {comparison.warnings.map((warning) => (
                    <p key={warning.text} className={`lib-upgrade__warning is-${warning.level}`}>
                      <WarningIcon size={14} /> {warning.text}
                    </p>
                  ))}
                  {strong && (
                    <label className="lib-edit__bool">
                      <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedFor(event.target.checked ? comparison.candidateId : null)} />
                      I&apos;ve listened to both, and this is the version I want for this song.
                    </label>
                  )}
                  {!applying && (
                    <AbPlayer
                      key={comparison.candidateId}
                    currentSrc={comparison.current ? `wavemint-media://file/${comparison.current.fileId}` : ""}
                      candidateSrc={`wavemint-media://candidate/${comparison.candidateId}`}
                    />
                  )}
                  <Spectrograms key={`s${comparison.candidateId}`} currentFileId={comparison.current?.fileId} candidateId={comparison.candidateId} />
                </>
              )}
            </section>
          )}

          {/* 3. What the new file will contain */}
          <section className="lib-upgrade__section" aria-label="Metadata and artwork">
            <div className="lib-upgrade__meta-head">
              <span className="section-label">Metadata and artwork</span>
              {detected.length > 0 && !showDetected && (
                <button type="button" className="btn btn--link" disabled={applying} onClick={() => setShowDetected(true)}>
                  Use Detected Metadata…
                </button>
              )}
            </div>
            <p className="settings-hint">Prefilled from this song. These values and the artwork are written into the new file.</p>
            {showDetected && (
              <DetectedMetadata
                detected={detected}
                form={form}
                onClose={() => setShowDetected(false)}
                onApply={(changes) => {
                  setForm((current) => ({ ...current, ...Object.fromEntries(changes.map((item) => [item.key, item.formValue])) }));
                  setShowDetected(false);
                }}
              />
            )}
            <div className="lib-upgrade__meta">
              <div className="lib-upgrade__art">
                <div className="lib-upgrade__art-frame">
                  <Artwork key={artwork} hash={artPreview.hash} src={artPreview.src || ""} size={320} alt={artworkCaption} />
                </div>
                <div className="segmented segmented--block segmented--compact" role="group" aria-label="Artwork">
                  {ARTWORK_CHOICES.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`segmented__option ${artwork === value ? "is-active" : ""}`}
                      aria-pressed={artwork === value}
                      disabled={applying || (value === "candidate" && !sourceArtAvailable)}
                      onClick={() => (value === "custom" && !customArt ? chooseCustomArt() : setArtwork(value))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className={`lib-upgrade__art-caption ${(comparison && !artworkReady) || !customReady ? "is-warn" : ""}`}>
                  {artworkCaption}
                  {artwork === "custom" && customArt && (
                    <button type="button" className="btn btn--link" disabled={applying} onClick={chooseCustomArt}>
                      Change
                    </button>
                  )}
                </span>
              </div>
              <div className="lib-upgrade__form">
                <GenreOptions id={`upgrade-genres-${trackId}`} />
                <MetadataFields
                  form={form}
                  initial={original}
                  listId={`upgrade-genres-${trackId}`}
                  disabled={applying}
                  onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
                />
              </div>
            </div>
          </section>

          {/* What happens to the files */}
          {plan && (
            <div className="lib-upgrade__plan">
              {plan.mode === "copy" && (
                <>
                  <span>
                    A new file is made in your WaveMint Library as <strong>{plan.relPath}</strong> with the metadata and artwork above.{" "}
                    {comparison.kind === "version" ? "The other version's file isn't changed." : comparison.kind === "extraction" ? "" : "The file you chose isn't changed."}
                  </span>
                  <span>
                    {plan.currentManaged
                      ? `The current file moves to the library's archive folder and is kept for ${plan.keptFor || "3 days"} so you can undo this.`
                      : "The current file stays where it is (WaveMint never changes files in your other folders), kept as an archived version."}
                  </span>
                </>
              )}
              {plan.mode === "switch" && <span>The other version becomes this song&apos;s active version. No files are copied or changed.</span>}
              {blocked && (
                <span className="is-warn">
                  Upgrades are saved in your WaveMint Library, and it doesn&apos;t have a folder yet. Choose one under Manage → WaveMint Library.
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
