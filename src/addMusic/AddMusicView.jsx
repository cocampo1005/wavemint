import { useEffect, useRef, useState } from "react";
import logomark from "../assets/Logomark.png";
import { AudioEditor } from "../editor/AudioEditor";
import { isSkippableInBatch, parseIpcError } from "../ipcErrors";
import { pluralize } from "../library/format";
import { FolderOpenIcon, WaveformIcon } from "../library/icons";
import { EntryLibraryMatch, PlaylistImport } from "../library/PlaylistImport";
import { entryKey, libraryApi } from "../library/useLibrary";
import { PREVIEW_CONCURRENCY, createArtworkState, describeComponentProblems, describeProgress, formatDuration, mapWithConcurrency } from "./extraction";
import { AlertIcon, ArtworkPanel, CheckIcon, ErrorAlert, FormField, GenreSelect, InlineStatus, ProgressBar } from "./parts";
import "./addMusic.css";

const DONE = new Set(["added", "held"]);

function matchPayload(items) {
  return items.slice(0, 1000).map((item) => ({
    key: entryKey(item),
    title: item.metadata?.title || item.title || "",
    artist: item.metadata?.artist || "",
    durationMs: Number.isFinite(item.duration) ? Math.round(item.duration * 1000) : undefined,
  }));
}

function MetadataFields({ metadata, onChange, disabled, columns = 2 }) {
  const field = (name, label, wide = false) => (
    <FormField label={label} wide={wide}>
      <input type="text" className="field" value={metadata?.[name] || ""} onChange={(event) => onChange(name, event.target.value)} placeholder={label} disabled={disabled} />
    </FormField>
  );
  return (
    <div className={`form-grid form-grid--${columns}`}>
      {field("title", "Title", true)}
      {field("artist", "Artist")}
      {field("album", "Album")}
      <FormField label="Genre" wide={columns === 2}>
        <GenreSelect value={metadata?.genre || ""} onChange={(event) => onChange("genre", event.target.value)} disabled={disabled} />
      </FormField>
    </div>
  );
}

function EditBeforeAddingToggle({ checked, onChange, disabled }) {
  return (
    <label className="add-edit-toggle" title="Extract the song, then open the audio editor to trim it or add fades before it goes into your library">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      Edit audio before adding
    </label>
  );
}

/** What happened to one song: added, waiting for edits, failed, or working. */
function Outcome({ outcome, onEdit, onEditAdded, onAddUnedited, onView, busy }) {
  if (!outcome) return null;
  if (outcome.status === "working") {
    return (
      <div className="add-outcome is-working" role="status">
        <span className="artwork__spinner" aria-hidden="true" /> Adding…
      </div>
    );
  }
  if (outcome.status === "failed") {
    return (
      <div className="add-outcome is-failed" role="status">
        <AlertIcon className="add-outcome__icon" /> {outcome.message}
      </div>
    );
  }
  if (outcome.status === "held") {
    return (
      <div className="add-outcome is-held" role="status">
        <WaveformIcon size={16} /> Extracted · waiting for your edits
        <span className="add-outcome__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={onEdit} disabled={busy}>
            Edit &amp; Add…
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onAddUnedited} disabled={busy}>
            Add Without Editing
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="add-outcome is-added" role="status">
      <CheckIcon className="add-outcome__icon" /> {outcome.edited ? "Edited and added to your library" : "Added to your library"}
      <span className="add-outcome__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onEditAdded}>
          <WaveformIcon size={14} /> Edit Audio
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onView}>
          View in Library
        </button>
      </span>
    </div>
  );
}

/**
 * Add Music: analyze a YouTube video or playlist, review the details and
 * artwork, and add the songs to the WaveMint Library (optionally trimming
 * them first). Stays mounted while the library is shown, so a running
 * extraction, its progress and any edits in progress are kept.
 */
export function AddMusicView({ active, appStatus, checkingComponents, onRecheckComponents, onOpenSettings, onViewInLibrary, onActivityChange }) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState("video");
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState({ message: "", code: "" });
  const [result, setResult] = useState(null);
  const [entries, setEntries] = useState([]);
  const [masterArtist, setMasterArtist] = useState("");
  const [masterAlbum, setMasterAlbum] = useState("");
  const [masterGenre, setMasterGenre] = useState("");
  const [analyzeStatus, setAnalyzeStatus] = useState(null);
  const [downloadStatus, setDownloadStatus] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [library, setLibrary] = useState(null);
  const [editBeforeAdding, setEditBeforeAdding] = useState(false);
  // Single video: idle | adding | held ({ token }) | added ({ added })
  const [single, setSingle] = useState({ status: "idle" });
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState("");
  const [matches, setMatches] = useState({});
  // Playlists can also go through the album import (check, album details, review).
  const [albumMode, setAlbumMode] = useState(false);
  const [importMatches, setImportMatches] = useState({});
  const [importBusy, setImportBusy] = useState(false);
  // { mode: "staged", token, key } | { mode: "library", trackId, key }
  const [editor, setEditor] = useState(null);
  const lastActionRef = useRef(null);

  const error = errorState.message;
  const setError = (message) => setErrorState({ message, code: "", diagnosticsId: "" });
  const showError = (err, fallback) => {
    const parsed = parseIpcError(err, fallback);
    // A cancellation the user asked for isn't an error.
    if (parsed.code === "cancelled") {
      setErrorState({ message: "", code: "", diagnosticsId: "" });
      return;
    }
    setErrorState(parsed);
  };

  // One set of progress listeners for the app's lifetime (this view never unmounts).
  useEffect(() => {
    const removeAnalyze = window.waveMintAPI.onAnalyzeProgress((data) => setAnalyzeStatus(data));
    const removeDownload = window.waveMintAPI.onDownloadProgress((data) => setDownloadStatus(data));
    return () => {
      removeAnalyze?.();
      removeDownload?.();
    };
  }, []);

  const loadLibrary = () =>
    libraryApi
      .getManagedLibrary()
      .then(setLibrary)
      .catch(() => {});

  // The library folder may have been chosen in the Library meanwhile.
  useEffect(() => {
    if (active) loadLibrary();
  }, [active]);

  const hasLibraryFolder = !!library?.source;
  const downloading = single.status === "adding";
  const heldCount = (single.status === "held" ? 1 : 0) + entries.filter((entry) => entry.outcome?.status === "held").length;
  const busy = loading || downloading || batchRunning || importBusy;

  useEffect(() => {
    onActivityChange?.({ busy, waiting: heldCount });
  }, [busy, heldCount, onActivityChange]);

  const chooseLibraryFolder = async () => {
    try {
      if (await libraryApi.chooseManagedRoot()) await loadLibrary();
    } catch (err) {
      showError(err, "The folder couldn't be used");
    }
  };

  const requireLibraryFolder = () => {
    if (hasLibraryFolder) return true;
    setError("Choose a folder for your WaveMint Library first. Added songs are saved there.");
    return false;
  };

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await window.waveMintAPI.cancelOperations();
    } catch {
      setCancelling(false);
    }
  };

  const updateEntryByKey = (key, patch) =>
    setEntries((current) => current.map((entry) => (entryKey(entry) === key ? { ...entry, ...(typeof patch === "function" ? patch(entry) : patch) } : entry)));

  const updateEntry = (index, patch) => setEntries((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)));

  const checkMatches = async (items) => {
    try {
      setMatches(await libraryApi.checkLibraryMatches({ entries: matchPayload(items) }));
    } catch {
      setMatches({});
    }
  };

  const generateSquareCropPreview = async (item) => {
    const response = await window.waveMintAPI.generateSquareCropPreview({ thumbnail: item.thumbnail });
    return typeof response === "string" ? response : response?.previewUrl || "";
  };

  const withSquarePreview = async (item) => {
    try {
      const previewUrl = await generateSquareCropPreview(item);
      if (!previewUrl) throw new Error("No square artwork preview was created");
      return { ...item, squareCropPreview: previewUrl, artworkPreviewError: "" };
    } catch (previewError) {
      console.error("[artwork] Failed to generate initial square preview:", previewError);
      return { ...item, artworkPreviewError: parseIpcError(previewError, "Failed to generate the square artwork preview").message };
    }
  };

  // Songs extracted for editing but not added are dropped with their analysis.
  const discardHeld = () => {
    const tokens = [single.status === "held" ? single.token : null, ...entries.filter((entry) => entry.outcome?.status === "held").map((entry) => entry.outcome.token)];
    for (const token of tokens.filter(Boolean)) libraryApi.discardStagedExtraction({ token }).catch(() => {});
  };

  const handleAnalyze = async () => {
    if (!url.trim() || busy) return;

    discardHeld();
    lastActionRef.current = "analyze";
    setLoading(true);
    setCancelling(false);
    setError("");
    setStatusMessage("");
    setResult(null);
    setEntries([]);
    setMatches({});
    setImportMatches({});
    setAlbumMode(false);
    setMasterArtist("");
    setMasterAlbum("");
    setMasterGenre("");
    setSingle({ status: "idle" });
    setBatchProgressText("");
    setAnalyzeStatus(null);
    setDownloadStatus(null);

    try {
      const data = await window.waveMintAPI.analyzeUrl({ url, mode });

      if (data.isPlaylist) {
        const normalizedEntries = (data.entries || []).map((entry) => ({ ...createArtworkState(entry), editBeforeAdding: false, outcome: null }));
        setResult(data);
        setEntries(normalizedEntries);
        checkMatches(normalizedEntries);
        // Previews are generated a few at a time so a long playlist doesn't
        // start dozens of downloads and FFmpeg processes at once.
        const previews = await mapWithConcurrency(normalizedEntries, PREVIEW_CONCURRENCY, withSquarePreview);
        const byKey = new Map(previews.map((entry) => [entryKey(entry), entry]));
        // Keep anything the user changed while the previews were made.
        setEntries((current) =>
          current.map((entry) => {
            const preview = byKey.get(entryKey(entry));
            return preview && !entry.squareCropPreview ? { ...entry, squareCropPreview: preview.squareCropPreview, artworkPreviewError: preview.artworkPreviewError } : entry;
          }),
        );
      } else {
        const nextResult = await withSquarePreview(createArtworkState(data));
        setResult(nextResult);
        setEntries([]);
        checkMatches([nextResult]);
      }
    } catch (err) {
      showError(err, "Something went wrong");
    } finally {
      setLoading(false);
      setCancelling(false);
    }
  };

  const chooseArtworkFile = async () => {
    try {
      const selection = await window.waveMintAPI.chooseArtworkFile();
      if (!selection) return null;
      if (typeof selection === "string") return { filePath: selection, previewUrl: "" };
      return selection;
    } catch (err) {
      showError(err, "Failed to choose artwork file");
      return null;
    }
  };

  // Shared by the single result and playlist entries: `item` is the current
  // state, `apply(patch)` updates it.
  const changeArtworkMode = async (item, artworkMode, apply) => {
    setError("");

    if (artworkMode === "custom_file") {
      if (item.customArtworkPath && item.customArtworkPreview) {
        apply({ artworkMode, artworkPreviewError: "" });
        return;
      }
      const selection = await chooseArtworkFile();
      if (!selection?.filePath) return;
      apply({ artworkMode, customArtworkPath: selection.filePath, customArtworkPreview: selection.previewUrl || "", artworkPreviewError: "" });
      return;
    }

    if (artworkMode === "square_crop" && !item.squareCropPreview) {
      apply({ artworkMode, artworkPreviewLoading: true, artworkPreviewError: "" });
      try {
        const previewUrl = await generateSquareCropPreview(item);
        if (!previewUrl) throw new Error("No square artwork preview was created");
        apply({ artworkMode, squareCropPreview: previewUrl, artworkPreviewLoading: false, artworkPreviewError: "" });
      } catch (err) {
        apply({ artworkPreviewLoading: false, artworkPreviewError: parseIpcError(err, "Failed to generate the square artwork preview").message });
      }
      return;
    }

    apply({ artworkMode, artworkPreviewLoading: false, artworkPreviewError: "" });
  };

  const chooseCustomArtwork = async (apply) => {
    const selection = await chooseArtworkFile();
    if (!selection?.filePath) return;
    apply({ artworkMode: "custom_file", customArtworkPath: selection.filePath, customArtworkPreview: selection.previewUrl || "", artworkPreviewError: "" });
  };

  const applyToResult = (patch) => setResult((current) => ({ ...current, ...patch }));

  const extractionPayload = (item, holdForEditing) => ({
    url: item.webpage_url,
    metadata: item.metadata,
    thumbnail: item.thumbnail,
    duration: item.duration,
    artwork: { mode: item.artworkMode || "square_crop", customFilePath: item.customArtworkPath || "" },
    holdForEditing,
  });

  const handleAddSingle = async () => {
    if (!result || result.isPlaylist || !requireLibraryFolder()) return;
    if ((result.artworkMode || "square_crop") === "custom_file" && !result.customArtworkPath) {
      setError("Please choose a custom artwork image first");
      return;
    }

    lastActionRef.current = "add-single";
    setSingle({ status: "adding" });
    setCancelling(false);
    setError("");
    setStatusMessage("");
    setDownloadStatus(null);

    try {
      const response = await window.waveMintAPI.downloadMp3(extractionPayload(result, editBeforeAdding));
      if (response.held) {
        setSingle({ status: "held", token: response.token });
        setEditor({ mode: "staged", token: response.token, key: "single" });
      } else {
        setSingle({ status: "added", added: response.added });
        setStatusMessage("Added to your library");
      }
    } catch (err) {
      setSingle({ status: "idle" });
      showError(err, "The song couldn't be added");
    } finally {
      setCancelling(false);
    }
  };

  const handleAddSelected = async () => {
    if (!requireLibraryFolder()) return;
    const selected = entries.filter((entry) => entry.selected);
    if (!selected.length) {
      setError("Please select at least one song");
      return;
    }
    const missingCustomArtwork = selected.find((entry) => (entry.artworkMode || "square_crop") === "custom_file" && !entry.customArtworkPath);
    if (missingCustomArtwork) {
      setError(`Please choose a custom artwork image for ${missingCustomArtwork.metadata?.title || missingCustomArtwork.title || "the selected track"}`);
      return;
    }

    // Songs already added (or waiting for edits) aren't extracted again, so
    // after an interruption this continues where the batch stopped.
    const pending = selected.filter((entry) => !DONE.has(entry.outcome?.status));
    lastActionRef.current = "add-batch";
    setBatchRunning(true);
    setCancelling(false);
    setError("");
    setStatusMessage("");
    setDownloadStatus(null);

    try {
      for (const [index, entry] of pending.entries()) {
        const key = entryKey(entry);
        setDownloadStatus(null);
        setBatchProgressText(`Adding ${index + 1} of ${pending.length}: ${entry.metadata?.title || entry.title}`);
        updateEntryByKey(key, { outcome: { status: "working" } });
        try {
          const response = await window.waveMintAPI.downloadMp3(extractionPayload(entry, !!entry.editBeforeAdding));
          updateEntryByKey(key, { outcome: response.held ? { status: "held", token: response.token } : { status: "added", added: response.added } });
        } catch (trackError) {
          // A problem with one video (removed, private, region-locked…)
          // skips that song. Problems that would hit every remaining song
          // (connection, rate limit, sign-in, cancel) stop the batch.
          const parsed = parseIpcError(trackError, "This song couldn't be added");
          if (!isSkippableInBatch(parsed.code)) {
            updateEntryByKey(key, { outcome: null });
            throw trackError;
          }
          updateEntryByKey(key, { outcome: { status: "failed", message: parsed.message } });
        }
      }
    } catch (err) {
      showError(err, "Adding the songs stopped");
    } finally {
      setBatchProgressText("");
      setBatchRunning(false);
      setCancelling(false);
    }
  };

  // Adds a song that was extracted for editing, without edits.
  const addUnedited = async (key, token) => {
    setError("");
    try {
      const added = await libraryApi.commitStagedExtraction({ token });
      if (key === "single") {
        setSingle({ status: "added", added });
        setStatusMessage("Added to your library");
      } else {
        updateEntryByKey(key, { outcome: { status: "added", added } });
      }
    } catch (err) {
      showError(err, "The song couldn't be added");
    }
  };

  const discardSingle = () => {
    if (single.status === "held") libraryApi.discardStagedExtraction({ token: single.token }).catch(() => {});
    setSingle({ status: "idle" });
  };

  const handleEditorDone = (value) => {
    const current = editor;
    setEditor(null);
    if (!current) return;
    if (current.mode === "staged") {
      if (current.key === "single") {
        setSingle({ status: "added", added: value });
        setStatusMessage(value?.edited ? "Edited and added to your library" : "Added to your library");
      } else {
        updateEntryByKey(current.key, { outcome: { status: "added", added: value, edited: !!value?.edited } });
      }
    } else if (current.key === "single") {
      setStatusMessage("Audio edits saved");
    } else {
      updateEntryByKey(current.key, (entry) => ({ outcome: { ...entry.outcome, edited: true } }));
    }
  };

  const handleRetry = () => {
    const action = lastActionRef.current;
    if (action === "analyze") handleAnalyze();
    else if (action === "add-single") handleAddSingle();
    else if (action === "add-batch") handleAddSelected();
  };

  const handleApplyMasterMetadata = () => {
    const artist = masterArtist.trim();
    const album = masterAlbum.trim();
    if (batchRunning || (!artist && !album && !masterGenre)) return;
    setEntries((current) =>
      current.map((entry) =>
        DONE.has(entry.outcome?.status)
          ? entry
          : { ...entry, metadata: { ...entry.metadata, ...(artist ? { artist } : {}), ...(album ? { album } : {}), ...(masterGenre ? { genre: masterGenre } : {}) } },
      ),
    );
  };

  const handleApplyArtworkToAllEntries = async () => {
    if (batchRunning) return;
    const selection = await chooseArtworkFile();
    if (!selection?.filePath) return;
    setError("");
    setEntries((current) =>
      current.map((entry) => ({ ...entry, artworkMode: "custom_file", customArtworkPath: selection.filePath, customArtworkPreview: selection.previewUrl || "", artworkPreviewError: "" })),
    );
  };

  const componentProblems = appStatus?.dependencies?.tools?.filter((tool) => !tool.ok) || [];
  const selectedCount = entries.filter((entry) => entry.selected).length;
  const counts = entries.reduce((sum, entry) => ({ ...sum, [entry.outcome?.status || "none"]: (sum[entry.outcome?.status || "none"] || 0) + 1 }), {});
  const addedIds = entries.filter((entry) => entry.outcome?.status === "added").map((entry) => entry.outcome.added.trackId);
  const pendingCount = entries.filter((entry) => entry.selected && !DONE.has(entry.outcome?.status)).length;
  const anyOutcome = entries.some((entry) => entry.outcome && entry.outcome.status !== "working");
  const singleMatch = result && !result.isPlaylist ? matches[entryKey(result)] : null;
  const canApplyMaster = !batchRunning && !!(masterArtist.trim() || masterAlbum.trim() || masterGenre);
  const summary = [
    counts.added && `${pluralize(counts.added, "song")} added`,
    counts.held && `${counts.held} waiting for edits`,
    counts.failed && `${counts.failed} couldn't be added`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="add-music">
      <header className="workspace-head">
        <div className="workspace-head__titles">
          <h1 className="heading-md">Add Music</h1>
          <span className="workspace-head__sub">From a YouTube video or playlist, straight into your library</span>
        </div>
      </header>

      <div className="add-music__body">
        {componentProblems.length > 0 && (
          <div className="alert" role="alert">
            <AlertIcon className="alert__icon" />
            <span className="alert__text">{describeComponentProblems(componentProblems, appStatus?.isPackaged)}</span>
            <button type="button" className={`btn btn--secondary btn--sm alert__action ${checkingComponents ? "is-loading" : ""}`} onClick={onRecheckComponents} disabled={checkingComponents}>
              Check Again
            </button>
          </div>
        )}

        <section className="panel" aria-label="Source">
          <div className="source-top">
            <span className="section-label" style={{ margin: 0 }}>
              Source
            </span>
            <div className="segmented" role="group" aria-label="Source type">
              {[
                ["video", "Single Video"],
                ["playlist", "Playlist"],
              ].map(([value, label]) => (
                <button key={value} type="button" className={`segmented__option ${mode === value ? "is-active" : ""}`} aria-pressed={mode === value} onClick={() => setMode(value)}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <form
            className="input-row"
            onSubmit={(event) => {
              event.preventDefault();
              handleAnalyze();
            }}
          >
            <input
              type="text"
              className="field field--lg"
              placeholder={mode === "playlist" ? "Paste a YouTube playlist URL…" : "Paste a YouTube video URL…"}
              aria-label="YouTube URL"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button type="submit" className={`btn btn--primary btn--lg ${loading ? "is-loading" : ""}`} disabled={busy || !url.trim()}>
              {loading ? "Analyzing…" : "Analyze"}
            </button>
          </form>

          {loading && (
            <ProgressBar
              label={describeProgress(analyzeStatus, mode === "playlist" ? "Loading playlist…" : "Analyzing video…")}
              onCancel={handleCancel}
              cancelling={cancelling}
            />
          )}

          <div className={`library-target ${hasLibraryFolder ? "" : "is-missing"}`}>
            <FolderOpenIcon size={16} />
            {library === null ? (
              <span className="library-target__text">Checking your library…</span>
            ) : hasLibraryFolder ? (
              <span className="library-target__text" title={library.root}>
                Songs are saved in your WaveMint Library · <span className="library-target__path">{library.root}</span>
              </span>
            ) : (
              <>
                <span className="library-target__text">Choose where WaveMint keeps the songs you add (your WaveMint Library folder).</span>
                <button type="button" className="btn btn--secondary btn--sm" onClick={chooseLibraryFolder}>
                  Choose Folder…
                </button>
              </>
            )}
          </div>
        </section>

        {error && (
          <ErrorAlert
            key={`${errorState.code}:${errorState.diagnosticsId}:${error}`}
            error={errorState}
            onRetry={lastActionRef.current ? handleRetry : null}
            retryDisabled={busy}
            onOpenSettings={onOpenSettings}
          />
        )}

        {!result && !loading && (
          <div className="empty-state">
            <img className="empty-state__mark" src={logomark} alt="" draggable={false} />
            <span>
              {mode === "playlist"
                ? "Paste a playlist link and select Analyze to review its songs."
                : "Paste a video link and select Analyze to review its audio, details and artwork."}
            </span>
          </div>
        )}

        {result && !result.isPlaylist && (
          <section className="panel" aria-label="Analysis result">
            <div className="result-single">
              <ArtworkPanel
                thumbnail={result.thumbnail}
                title={result.title}
                mode={result.artworkMode}
                squareCropPreview={result.squareCropPreview}
                customFilePath={result.customArtworkPath}
                customPreview={result.customArtworkPreview}
                previewLoading={result.artworkPreviewLoading}
                previewError={result.artworkPreviewError}
                onModeChange={(artworkMode) => changeArtworkMode(result, artworkMode, applyToResult)}
                onChooseCustom={() => chooseCustomArtwork(applyToResult)}
                disabled={single.status !== "idle"}
              />

              <div className="result-single__info">
                <span className="eyebrow">Video detected</span>
                <h2 className="heading-lg">{result.title}</h2>
                <div className="meta-line">
                  <span>{result.uploader || "Unknown uploader"}</span>
                  <span className="meta-line__dot" aria-hidden="true" />
                  <span>{formatDuration(result.duration)}</span>
                </div>
                <EntryLibraryMatch match={singleMatch?.status !== "new" ? singleMatch : null} />

                <div className="result-single__actions">
                  <div className="action-bar">
                    {single.status === "idle" && (
                      <>
                        <button type="button" className="btn btn--primary btn--lg" onClick={handleAddSingle} disabled={busy || result.artworkPreviewLoading}>
                          Add to Library
                        </button>
                        <EditBeforeAddingToggle checked={editBeforeAdding} onChange={setEditBeforeAdding} disabled={busy} />
                      </>
                    )}

                    {single.status === "held" && (
                      <>
                        <button type="button" className="btn btn--primary btn--lg" onClick={() => setEditor({ mode: "staged", token: single.token, key: "single" })}>
                          <WaveformIcon size={16} /> Edit &amp; Add…
                        </button>
                        <button type="button" className="btn btn--secondary" onClick={() => addUnedited("single", single.token)}>
                          Add Without Editing
                        </button>
                        <button type="button" className="btn btn--link" onClick={discardSingle}>
                          Discard
                        </button>
                      </>
                    )}

                    {single.status === "added" && (
                      <>
                        <InlineStatus message={statusMessage || "Added to your library"} />
                        <button type="button" className="btn btn--secondary" onClick={() => onViewInLibrary([single.added.trackId])}>
                          View in Library
                        </button>
                        <button type="button" className="btn btn--ghost" onClick={() => setEditor({ mode: "library", trackId: single.added.trackId, key: "single" })}>
                          <WaveformIcon size={16} /> Edit Audio
                        </button>
                      </>
                    )}
                  </div>

                  {downloading && (
                    <ProgressBar
                      value={downloadStatus?.phase === "downloading" ? downloadStatus.percent : null}
                      label={describeProgress(downloadStatus, "Preparing audio…")}
                      onCancel={handleCancel}
                      cancelling={cancelling}
                    />
                  )}
                  {single.status === "held" && <p className="settings-hint">The song is extracted but not in your library yet. Trim it or add fades, or add it as it is.</p>}
                </div>

                <div className="result-single__form">
                  <MetadataFields
                    metadata={result.metadata}
                    disabled={single.status !== "idle"}
                    onChange={(field, value) => setResult((current) => ({ ...current, metadata: { ...current.metadata, [field]: value } }))}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {result?.isPlaylist && (
          <section className="panel playlist-panel" aria-label="Playlist">
            <div className="playlist-head">
              <div className="playlist-head__title">
                <span className="eyebrow">Playlist detected</span>
                <h2 className="heading-md">{result.title}</h2>
                <span className="text-muted" style={{ fontSize: 13 }}>
                  {albumMode
                    ? "Album import: check the songs against your library, set album details and track numbers, then review before anything is added."
                    : "Select the songs to add. Tick “Edit audio before adding” on a song to trim it or add fades before it goes into your library."}
                </span>
              </div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAlbumMode((value) => !value)} disabled={batchRunning || importBusy || anyOutcome}>
                {albumMode ? "Back to Quick Add" : "Import as Album…"}
              </button>
            </div>

            <div className="playlist-toolbar playlist-toolbar--sticky">
              <div className="playlist-toolbar__group">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEntries((current) => current.map((entry) => ({ ...entry, selected: true })))} disabled={batchRunning}>
                  Select All
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEntries((current) => current.map((entry) => ({ ...entry, selected: false })))} disabled={batchRunning}>
                  Clear All
                </button>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  {selectedCount} of {entries.length} selected
                </span>
              </div>

              {!albumMode && (
                <div className="playlist-toolbar__group">
                  {summary && !batchRunning && <InlineStatus message={summary} />}
                  {addedIds.length > 0 && !batchRunning && (
                    <button type="button" className={`btn ${pendingCount ? "btn--secondary" : "btn--primary"}`} onClick={() => onViewInLibrary(addedIds)}>
                      View {addedIds.length > 1 ? `${addedIds.length} Songs` : "Song"} in Library
                    </button>
                  )}
                  {(pendingCount > 0 || batchRunning) && (
                    <button type="button" className={`btn btn--primary ${batchRunning ? "is-loading" : ""}`} onClick={handleAddSelected} disabled={busy || !selectedCount}>
                      {batchRunning ? "Adding…" : anyOutcome ? "Add Remaining to Library" : "Add Selected to Library"}
                    </button>
                  )}
                </div>
              )}

              {batchRunning && (
                <div className="playlist-toolbar__progress">
                  <ProgressBar
                    value={downloadStatus?.phase === "downloading" ? downloadStatus.percent : null}
                    label={`${batchProgressText} · ${describeProgress(downloadStatus, "Preparing audio…")}`}
                    onCancel={handleCancel}
                    cancelling={cancelling}
                  />
                </div>
              )}
            </div>

            {albumMode && (
              <PlaylistImport
                playlist={result}
                entries={entries}
                downloadStatus={downloadStatus}
                onBusyChange={setImportBusy}
                onCancel={handleCancel}
                onMatches={setImportMatches}
              />
            )}

            <div className="bulk-edit">
              <span className="section-label">Apply to all songs</span>
              <div className="bulk-edit__row">
                <input type="text" className="field" value={masterArtist} onChange={(event) => setMasterArtist(event.target.value)} placeholder="Artist" aria-label="Artist for all songs" disabled={batchRunning} />
                <input type="text" className="field" value={masterAlbum} onChange={(event) => setMasterAlbum(event.target.value)} placeholder="Album" aria-label="Album for all songs" disabled={batchRunning} />
                <GenreSelect value={masterGenre} onChange={(event) => setMasterGenre(event.target.value)} disabled={batchRunning} />
                <button type="button" className="btn btn--secondary" onClick={handleApplyMasterMetadata} disabled={!canApplyMaster}>
                  Apply to All
                </button>
                <button type="button" className="btn btn--secondary" onClick={handleApplyArtworkToAllEntries} disabled={batchRunning}>
                  Use Cover for All
                </button>
              </div>
            </div>

            <div className="track-list">
              {entries.map((entry, index) => {
                const key = entryKey(entry);
                const locked = !!entry.outcome && entry.outcome.status !== "failed";
                const match = albumMode ? importMatches[key] : matches[key];
                return (
                  <div key={key || index} className={`track ${entry.selected ? "is-selected" : ""} ${entry.outcome?.status === "added" ? "is-added" : ""}`}>
                    <button
                      type="button"
                      className={`check ${entry.selected ? "is-checked" : ""}`}
                      onClick={() => updateEntry(index, { selected: !entry.selected })}
                      aria-pressed={!!entry.selected}
                      aria-label={`Select ${entry.title}`}
                      disabled={batchRunning}
                    >
                      {entry.selected && <CheckIcon className="check__icon" />}
                    </button>

                    <ArtworkPanel
                      compact
                      thumbnail={entry.thumbnail}
                      title={entry.title}
                      mode={entry.artworkMode}
                      squareCropPreview={entry.squareCropPreview}
                      customFilePath={entry.customArtworkPath}
                      customPreview={entry.customArtworkPreview}
                      previewLoading={entry.artworkPreviewLoading}
                      previewError={entry.artworkPreviewError}
                      onModeChange={(artworkMode) => changeArtworkMode(entry, artworkMode, (patch) => updateEntryByKey(key, patch))}
                      onChooseCustom={() => chooseCustomArtwork((patch) => updateEntryByKey(key, patch))}
                      disabled={batchRunning || locked}
                    />

                    <div className="track__body">
                      <div className="track__head">
                        <div>
                          <div className="track__title">{entry.title}</div>
                          <div className="meta-line track__meta">
                            <span>{entry.uploader || "Unknown uploader"}</span>
                            <span className="meta-line__dot" aria-hidden="true" />
                            <span>{formatDuration(entry.duration)}</span>
                          </div>
                        </div>
                        {!albumMode && !entry.outcome && (
                          <EditBeforeAddingToggle checked={!!entry.editBeforeAdding} disabled={batchRunning} onChange={(checked) => updateEntry(index, { editBeforeAdding: checked })} />
                        )}
                      </div>
                      {match && match.status !== "new" && <EntryLibraryMatch match={match} />}
                      <Outcome
                        outcome={entry.outcome}
                        busy={batchRunning && entry.outcome?.status !== "held"}
                        onEdit={() => setEditor({ mode: "staged", token: entry.outcome.token, key })}
                        onAddUnedited={() => addUnedited(key, entry.outcome.token)}
                        onEditAdded={() => setEditor({ mode: "library", trackId: entry.outcome.added.trackId, key })}
                        onView={() => onViewInLibrary([entry.outcome.added.trackId])}
                      />

                      <MetadataFields
                        columns={3}
                        metadata={entry.metadata}
                        disabled={locked || batchRunning}
                        onChange={(field, value) => updateEntryByKey(key, (current) => ({ metadata: { ...current.metadata, [field]: value } }))}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="list-footer">Showing {entries.length} items.</p>
          </section>
        )}
      </div>

      {active && editor && (
        <AudioEditor
          key={editor.token || `t${editor.trackId}`}
          mode={editor.mode}
          token={editor.token}
          trackId={editor.trackId}
          onClose={() => setEditor(null)}
          onDone={handleEditorDone}
        />
      )}
    </div>
  );
}
