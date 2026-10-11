import { useEffect, useState } from "react";
import "./App.css";
import { GENRE_OPTIONS } from "./constants/genres";
import { parseIpcError } from "./ipcErrors";
import { SettingsDialog } from "./SettingsDialog";
import horizontalLogo from "./assets/Horizontal Logo.png";
import logomark from "./assets/Logomark.png";

function CheckIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 6v4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="10" cy="13.75" r="1" fill="currentColor" />
    </svg>
  );
}

function GearIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8.6 2.5h2.8l.45 2.1c.5.2.96.47 1.38.8l2.04-.68 1.4 2.43-1.6 1.43a5.6 5.6 0 0 1 0 1.6l1.6 1.43-1.4 2.43-2.04-.68c-.42.33-.88.6-1.38.8l-.45 2.1H8.6l-.45-2.1a5.6 5.6 0 0 1-1.38-.8l-2.04.68-1.4-2.43 1.6-1.43a5.6 5.6 0 0 1 0-1.6l-1.6-1.43 1.4-2.43 2.04.68c.42-.33.88-.6 1.38-.8l.45-2.1Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function describeAuthState(authState) {
  if (!authState || authState.mode === "none") {
    return "YouTube authentication: off";
  }

  const verified = authState.lastTest?.status === "authenticated";
  const method =
    authState.mode === "browser" ? "browser cookies" : "cookies file";

  return `YouTube authentication: ${method} (${verified ? "verified" : "not verified"})`;
}

function describeComponentProblems(problems, isPackaged) {
  const names = problems.map((tool) => tool.label).join(", ");

  if (!isPackaged) {
    return `These tools are not available: ${names}. Run "npm run binaries:fetch", or install them on PATH.`;
  }

  const blocked = problems.some((tool) => tool.problem === "blocked");
  return `Some of WaveMint's built-in components could not be started: ${names}. ${
    blocked ? "Your antivirus may have quarantined them. " : ""
  }Reinstall WaveMint to repair them.`;
}

function ProgressBar({ value, label }) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));

  return (
    <div className="progress">
      <div className="progress__meta">
        <span className="progress__label">{label}</span>
        <span className="progress__value">{Math.round(percent)}%</span>
      </div>
      <div
        className="progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={label || "Progress"}
      >
        <div className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function InlineStatus({ message }) {
  if (!message) return null;

  return (
    <span role="status" aria-live="polite" className="status-pill">
      <CheckIcon className="status-pill__icon" />
      {message}
    </span>
  );
}

function GenreSelect({ value, onChange, disabled, className = "" }) {
  return (
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={`field ${value ? "" : "is-empty"} ${className}`.trim()}
    >
      <option value="">Select genre</option>
      {GENRE_OPTIONS.map((genre) => (
        <option key={genre.value || genre} value={genre.value || genre}>
          {genre.label || genre}
        </option>
      ))}
    </select>
  );
}

function FormField({ label, wide = false, children }) {
  return (
    <label className={`form-field ${wide ? "form-field--wide" : ""}`.trim()}>
      <span className="form-field__label">{label}</span>
      {children}
    </label>
  );
}

const ARTWORK_OPTIONS = [
  { value: "original_thumbnail", label: "Original" },
  { value: "square_crop", label: "Square" },
  { value: "custom_file", label: "Custom" },
];

function createArtworkState(item) {
  return {
    ...item,
    artworkMode: "square_crop",
    squareCropPreview: "",
    customArtworkPath: "",
    customArtworkPreview: "",
    artworkPreviewLoading: false,
    artworkPreviewError: "",
  };
}

function getFileNameFromPath(filePath) {
  if (!filePath) return "";
  return filePath.split(/[\\/]/).pop() || filePath;
}

function getArtworkDescription(mode, customFilePath) {
  if (mode === "original_thumbnail") {
    return "Full YouTube thumbnail";
  }

  if (mode === "square_crop") {
    return "Centered square crop";
  }

  return customFilePath
    ? getFileNameFromPath(customFilePath)
    : "Choose an image file";
}

function ArtworkPanel({
  thumbnail,
  title,
  mode = "square_crop",
  squareCropPreview,
  customFilePath,
  customPreview,
  previewLoading,
  previewError,
  onModeChange,
  onChooseCustom,
  disabled = false,
  compact = false,
}) {
  const previewSource =
    mode === "custom_file"
      ? customPreview
      : mode === "square_crop"
        ? squareCropPreview || thumbnail
        : thumbnail;

  return (
    <div className={`artwork ${compact ? "artwork--compact" : ""}`.trim()}>
      <div className="artwork__frame">
        {previewSource ? (
          <img
            className="artwork__img"
            src={previewSource}
            alt={`${title || "Track"} artwork preview`}
            style={{ opacity: previewLoading ? 0.4 : 1 }}
          />
        ) : (
          <div className="artwork__placeholder">
            {previewLoading ? "Generating preview…" : "No artwork preview"}
          </div>
        )}

        {previewLoading && (
          <div className="artwork__overlay">
            <span className="artwork__spinner" aria-hidden="true" />
            Generating square preview…
          </div>
        )}
      </div>

      <div
        className={`segmented segmented--block artwork__modes ${
          compact ? "segmented--compact" : ""
        }`}
        role="group"
        aria-label="Artwork source"
      >
        {ARTWORK_OPTIONS.map((option) => {
          const active = mode === option.value;

          return (
            <button
              key={option.value}
              type="button"
              className={`segmented__option ${active ? "is-active" : ""}`}
              disabled={disabled || previewLoading}
              onClick={() => onModeChange(option.value)}
              aria-pressed={active}
              title={
                option.value === "original_thumbnail"
                  ? "Use the full YouTube thumbnail"
                  : option.value === "square_crop"
                    ? "Center-crop the thumbnail into a 1000 × 1000 square"
                    : "Choose a custom image"
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className={`artwork__caption ${previewError ? "is-error" : ""}`}>
        <span className="artwork__caption-text">
          {previewError || getArtworkDescription(mode, customFilePath)}
        </span>

        {mode === "custom_file" && customFilePath && (
          <button
            type="button"
            className="btn btn--link"
            onClick={onChooseCustom}
            disabled={disabled}
          >
            Change
          </button>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return "Unknown";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [errorState, setErrorState] = useState({ message: "", code: "" });
  const [result, setResult] = useState(null);
  const [outputFolder, setOutputFolder] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [mode, setMode] = useState("video");
  const [entries, setEntries] = useState([]);
  const [masterArtist, setMasterArtist] = useState("");
  const [masterAlbum, setMasterAlbum] = useState("");
  const [masterGenre, setMasterGenre] = useState("");
  const [lastDownloadedFile, setLastDownloadedFile] = useState("");
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [downloadedFiles, setDownloadedFiles] = useState([]);
  const [itunesOpened, setItunesOpened] = useState(false);
  const [batchProgressText, setBatchProgressText] = useState("");
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadLabel, setDownloadLabel] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authState, setAuthState] = useState(null);
  const [appStatus, setAppStatus] = useState(null);
  const [checkingComponents, setCheckingComponents] = useState(false);

  const error = errorState.message;
  const setError = (message) => setErrorState({ message, code: "" });
  const showError = (err, fallback) =>
    setErrorState(parseIpcError(err, fallback));

  useEffect(() => {
    let cancelled = false;

    window.waveMintAPI
      .getAuthState()
      .then((state) => !cancelled && setAuthState(state))
      .catch(() => {});

    window.waveMintAPI
      .getAppStatus()
      .then((status) => !cancelled && setAppStatus(status))
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const removeAnalyzeProgress = window.waveMintAPI.onAnalyzeProgress(
      (data) => {
        setAnalyzeProgress(data.percent || 0);
      },
    );

    const removeDownloadProgress = window.waveMintAPI.onDownloadProgress(
      (data) => {
        setDownloadProgress(data.percent || 0);
        setDownloadLabel(data.label || "");
      },
    );

    return () => {
      removeAnalyzeProgress?.();
      removeDownloadProgress?.();
    };
  }, []);

  const handleAnalyze = async () => {
    if (!url.trim()) return;

    setLoading(true);
    setError("");
    setStatusMessage("");
    setResult(null);
    setEntries([]);
    setMasterArtist("");
    setMasterAlbum("");
    setMasterGenre("");
    setLastDownloadedFile("");
    setDownloadedFiles([]);
    setItunesOpened(false);
    setBatchProgressText("");
    setAnalyzeProgress(0);
    setDownloadProgress(0);
    setDownloadLabel("");

    try {
      const data = await window.waveMintAPI.analyzeUrl({ url, mode });
      const normalizedEntries = (data.entries || []).map(createArtworkState);

      if (data.isPlaylist) {
        setResult(data);
        setEntries(normalizedEntries);

        const entriesWithPreviews = await Promise.all(
          normalizedEntries.map(async (entry) => {
            try {
              const squarePreviewUrl = await generateSquareCropPreview(entry);

              if (!squarePreviewUrl) {
                throw new Error("No square artwork preview was created");
              }

              return {
                ...entry,
                squareCropPreview: squarePreviewUrl,
                artworkPreviewError: "",
              };
            } catch (previewError) {
              console.error(
                "[artwork] Failed to generate initial square preview:",
                previewError,
              );

              return {
                ...entry,
                artworkPreviewError:
                  parseIpcError(
                    previewError,
                    "Failed to generate the square artwork preview",
                  ).message,
              };
            }
          }),
        );

        setEntries(entriesWithPreviews);
      } else {
        const nextResult = createArtworkState(data);

        try {
          const squarePreviewUrl = await generateSquareCropPreview(nextResult);

          if (!squarePreviewUrl) {
            throw new Error("No square artwork preview was created");
          }

          nextResult.squareCropPreview = squarePreviewUrl;
          nextResult.artworkPreviewError = "";
        } catch (previewError) {
          console.error(
            "[artwork] Failed to generate initial square preview:",
            previewError,
          );

          nextResult.artworkPreviewError =
            parseIpcError(
              previewError,
              "Failed to generate the square artwork preview",
            ).message;
        }

        setResult(nextResult);
        setEntries([]);
      }
    } catch (err) {
      showError(err, "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleChooseFolder = async () => {
    try {
      const folder = await window.waveMintAPI.chooseOutputFolder();
      if (folder) setOutputFolder(folder);
    } catch (err) {
      showError(err, "Failed to choose folder");
    }
  };

  const chooseArtworkFile = async () => {
    try {
      const selection = await window.waveMintAPI.chooseArtworkFile();

      if (!selection) return null;

      if (typeof selection === "string") {
        return { filePath: selection, previewUrl: "" };
      }

      return selection;
    } catch (err) {
      showError(err, "Failed to choose artwork file");
      return null;
    }
  };

  const generateSquareCropPreview = async (item) => {
    const response = await window.waveMintAPI.generateSquareCropPreview({
      thumbnail: item.thumbnail,
    });

    return typeof response === "string" ? response : response?.previewUrl || "";
  };

  const handleSingleArtworkModeChange = async (artworkMode) => {
    if (!result || downloading) return;

    setError("");

    if (artworkMode === "custom_file") {
      if (result.customArtworkPath && result.customArtworkPreview) {
        setResult((current) => ({
          ...current,
          artworkMode,
          artworkPreviewError: "",
        }));
        return;
      }

      const selection = await chooseArtworkFile();
      if (!selection?.filePath) return;

      setResult((current) => ({
        ...current,
        artworkMode,
        customArtworkPath: selection.filePath,
        customArtworkPreview: selection.previewUrl || "",
        artworkPreviewError: "",
      }));
      return;
    }

    if (artworkMode === "square_crop") {
      if (result.squareCropPreview) {
        setResult((current) => ({
          ...current,
          artworkMode,
          artworkPreviewLoading: false,
          artworkPreviewError: "",
        }));
        return;
      }

      setResult((current) => ({
        ...current,
        artworkMode,
        artworkPreviewLoading: true,
        artworkPreviewError: "",
      }));

      try {
        const previewUrl = await generateSquareCropPreview(result);

        if (!previewUrl) {
          throw new Error("No square artwork preview was created");
        }

        setResult((current) => ({
          ...current,
          artworkMode,
          squareCropPreview: previewUrl,
          artworkPreviewLoading: false,
          artworkPreviewError: "",
        }));
      } catch (err) {
        setResult((current) => ({
          ...current,
          artworkPreviewLoading: false,
          artworkPreviewError:
            parseIpcError(err, "Failed to generate the square artwork preview")
              .message,
        }));
      }

      return;
    }

    setResult((current) => ({
      ...current,
      artworkMode,
      artworkPreviewLoading: false,
      artworkPreviewError: "",
    }));
  };

  const handleChooseSingleArtwork = async () => {
    const selection = await chooseArtworkFile();
    if (!selection?.filePath) return;

    setResult((current) => ({
      ...current,
      artworkMode: "custom_file",
      customArtworkPath: selection.filePath,
      customArtworkPreview: selection.previewUrl || "",
      artworkPreviewError: "",
    }));
  };

  const updateEntry = (index, patch) => {
    setEntries((currentEntries) =>
      currentEntries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    );
  };

  const handleEntryArtworkModeChange = async (index, artworkMode) => {
    const entry = entries[index];
    if (!entry || batchDownloading) return;

    setError("");

    if (artworkMode === "custom_file") {
      if (entry.customArtworkPath && entry.customArtworkPreview) {
        updateEntry(index, { artworkMode, artworkPreviewError: "" });
        return;
      }

      const selection = await chooseArtworkFile();
      if (!selection?.filePath) return;

      updateEntry(index, {
        artworkMode,
        customArtworkPath: selection.filePath,
        customArtworkPreview: selection.previewUrl || "",
        artworkPreviewError: "",
      });
      return;
    }

    if (artworkMode === "square_crop") {
      if (entry.squareCropPreview) {
        updateEntry(index, {
          artworkMode,
          artworkPreviewLoading: false,
          artworkPreviewError: "",
        });
        return;
      }

      updateEntry(index, {
        artworkMode,
        artworkPreviewLoading: true,
        artworkPreviewError: "",
      });

      try {
        const previewUrl = await generateSquareCropPreview(entry);

        if (!previewUrl) {
          throw new Error("No square artwork preview was created");
        }

        updateEntry(index, {
          artworkMode,
          squareCropPreview: previewUrl,
          artworkPreviewLoading: false,
          artworkPreviewError: "",
        });
      } catch (err) {
        updateEntry(index, {
          artworkPreviewLoading: false,
          artworkPreviewError:
            parseIpcError(err, "Failed to generate the square artwork preview")
              .message,
        });
      }

      return;
    }

    updateEntry(index, {
      artworkMode,
      artworkPreviewLoading: false,
      artworkPreviewError: "",
    });
  };

  const handleChooseEntryArtwork = async (index) => {
    const selection = await chooseArtworkFile();
    if (!selection?.filePath) return;

    updateEntry(index, {
      artworkMode: "custom_file",
      customArtworkPath: selection.filePath,
      customArtworkPreview: selection.previewUrl || "",
      artworkPreviewError: "",
    });
  };

  const updateEntryMetadata = (index, field, value) => {
    setEntries((currentEntries) =>
      currentEntries.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              metadata: {
                ...entry.metadata,
                [field]: value,
              },
            }
          : entry,
      ),
    );
  };

  const handleDownloadSingle = async () => {
    setItunesOpened(false);
    if (!result || result.isPlaylist) return;

    if (!outputFolder) {
      setError("Please choose an output folder first");
      return;
    }

    if (
      (result.artworkMode || "square_crop") === "custom_file" &&
      !result.customArtworkPath
    ) {
      setError("Please choose a custom artwork image first");
      return;
    }

    setDownloading(true);
    setError("");
    setStatusMessage("");
    setLastDownloadedFile("");
    setDownloadProgress(0);
    setDownloadLabel("");

    try {
      const response = await window.waveMintAPI.downloadMp3({
        url: result.webpage_url,
        outputFolder,
        metadata: result.metadata,
        thumbnail: result.thumbnail,
        duration: result.duration,
        artwork: {
          mode: result.artworkMode || "square_crop",
          customFilePath: result.customArtworkPath || "",
        },
      });

      setStatusMessage("MP3 extracted successfully");
      setLastDownloadedFile(response.filePath || "");
    } catch (err) {
      showError(err, "Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const handleOpenSingleInItunes = async () => {
    if (!lastDownloadedFile) return;

    try {
      setError("");
      await window.waveMintAPI.openFile(lastDownloadedFile);
      setItunesOpened(true);
      setStatusMessage("Opened in iTunes");
    } catch (err) {
      showError(err, "Failed to open the file in iTunes");
    }
  };

  const handleOpenDownloadedFilesInItunes = async () => {
    if (!downloadedFiles.length) return;

    try {
      setError("");

      for (const filePath of downloadedFiles) {
        await window.waveMintAPI.openFile(filePath);
      }

      setItunesOpened(true);
      setStatusMessage("Opened all in iTunes");
    } catch (err) {
      showError(err, "Failed to open the files in iTunes");
    }
  };

  const handleSelectAllEntries = () => {
    setEntries((currentEntries) =>
      currentEntries.map((entry) => ({ ...entry, selected: true })),
    );
  };

  const handleClearAllEntries = () => {
    setEntries((currentEntries) =>
      currentEntries.map((entry) => ({ ...entry, selected: false })),
    );
  };

  const handleApplyMasterMetadata = () => {
    if (batchDownloading) return;

    const trimmedArtist = masterArtist.trim();
    const trimmedAlbum = masterAlbum.trim();

    if (!trimmedArtist && !trimmedAlbum && !masterGenre) return;

    setEntries((currentEntries) =>
      currentEntries.map((entry) => ({
        ...entry,
        metadata: {
          ...entry.metadata,
          ...(trimmedArtist ? { artist: trimmedArtist } : {}),
          ...(trimmedAlbum ? { album: trimmedAlbum } : {}),
          ...(masterGenre ? { genre: masterGenre } : {}),
        },
      })),
    );
  };

  const handleApplyArtworkToAllEntries = async () => {
    if (batchDownloading) return;

    const selection = await chooseArtworkFile();
    if (!selection?.filePath) return;

    setError("");
    setEntries((currentEntries) =>
      currentEntries.map((entry) => ({
        ...entry,
        artworkMode: "custom_file",
        customArtworkPath: selection.filePath,
        customArtworkPreview: selection.previewUrl || "",
        artworkPreviewError: "",
      })),
    );
  };

  const handleDownloadSelected = async () => {
    setItunesOpened(false);

    if (!outputFolder) {
      setError("Please choose an output folder first");
      return;
    }

    const selectedEntries = entries.filter((entry) => entry.selected);

    if (!selectedEntries.length) {
      setError("Please select at least one song");
      return;
    }

    const missingCustomArtwork = selectedEntries.find(
      (entry) =>
        (entry.artworkMode || "square_crop") === "custom_file" &&
        !entry.customArtworkPath,
    );

    if (missingCustomArtwork) {
      setError(
        `Please choose a custom artwork image for ${
          missingCustomArtwork.metadata?.title ||
          missingCustomArtwork.title ||
          "the selected track"
        }`,
      );
      return;
    }

    setBatchDownloading(true);
    setError("");
    setStatusMessage("");
    setDownloadedFiles([]);
    setBatchProgressText("");

    const completedFiles = [];

    try {
      setDownloadProgress(0);
      setDownloadLabel("");

      for (let index = 0; index < selectedEntries.length; index += 1) {
        const entry = selectedEntries[index];

        setBatchProgressText(
          `Extracting ${index + 1} of ${selectedEntries.length}: ${
            entry.metadata?.title || entry.title
          }`,
        );

        const response = await window.waveMintAPI.downloadMp3({
          url: entry.webpage_url,
          outputFolder,
          metadata: entry.metadata,
          thumbnail: entry.thumbnail,
          duration: entry.duration,
          artwork: {
            mode: entry.artworkMode || "square_crop",
            customFilePath: entry.customArtworkPath || "",
          },
        });

        if (response?.filePath) completedFiles.push(response.filePath);
      }

      setDownloadedFiles(completedFiles);
      setStatusMessage(
        `${completedFiles.length} song${
          completedFiles.length === 1 ? "" : "s"
        } extracted successfully`,
      );
      setBatchProgressText("");
    } catch (err) {
      showError(err, "Batch download failed");
      setBatchProgressText("");
    } finally {
      setBatchDownloading(false);
    }
  };

  const handleRecheckComponents = async () => {
    setCheckingComponents(true);

    try {
      setAppStatus(await window.waveMintAPI.getAppStatus({ refresh: true }));
    } catch (err) {
      showError(err, "Could not check WaveMint's components");
    } finally {
      setCheckingComponents(false);
    }
  };

  const selectedEntryCount = entries.filter((entry) => entry.selected).length;
  const canApplyMasterMetadata =
    !batchDownloading &&
    !!(masterArtist.trim() || masterAlbum.trim() || masterGenre);
  const componentProblems =
    appStatus?.dependencies?.tools?.filter((tool) => !tool.ok) || [];
  const authIndicator =
    authState && authState.mode !== "none"
      ? authState.lastTest?.status === "authenticated"
        ? "success"
        : "warning"
      : "";

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__inner">
          <img
            className="app-header__logo"
            src={horizontalLogo}
            alt="WaveMint"
            draggable={false}
          />
          <div className="app-header__actions">
            <span className="app-header__tagline">
              YouTube audio to tagged MP3
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm header-settings"
              onClick={() => setSettingsOpen(true)}
              title={describeAuthState(authState)}
            >
              <GearIcon className="header-settings__icon" />
              Settings
              {authIndicator && (
                <span
                  className={`header-settings__dot is-${authIndicator}`}
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        </div>
      </header>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        busy={loading || downloading || batchDownloading}
        onAuthStateChange={setAuthState}
      />

      <main className="app-main">
        {componentProblems.length > 0 && (
          <div className="alert" role="alert">
            <AlertIcon className="alert__icon" />
            <span className="alert__text">
              {describeComponentProblems(componentProblems, appStatus?.isPackaged)}
            </span>
            <button
              type="button"
              className={`btn btn--secondary btn--sm alert__action ${
                checkingComponents ? "is-loading" : ""
              }`}
              onClick={handleRecheckComponents}
              disabled={checkingComponents}
            >
              Check Again
            </button>
          </div>
        )}

        <section className="panel" aria-label="Source and output">
          <div className="panel__section">
            <div className="source-top">
              <span className="section-label" style={{ margin: 0 }}>
                Source
              </span>
              <div className="segmented" role="group" aria-label="Source type">
                {[
                  ["video", "Single Video"],
                  ["playlist", "Playlist"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`segmented__option ${
                      mode === value ? "is-active" : ""
                    }`}
                    aria-pressed={mode === value}
                    onClick={() => setMode(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="input-row">
              <input
                type="text"
                className="field field--lg"
                placeholder={
                  mode === "playlist"
                    ? "Paste a YouTube playlist URL…"
                    : "Paste a YouTube video URL…"
                }
                aria-label="YouTube URL"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <button
                type="button"
                className={`btn btn--primary btn--lg ${
                  loading ? "is-loading" : ""
                }`}
                onClick={handleAnalyze}
                disabled={loading}
              >
                {loading ? "Analyzing…" : "Analyze"}
              </button>
            </div>

            {loading && (
              <ProgressBar value={analyzeProgress} label="Analyzing…" />
            )}
          </div>

          <div className="panel__section">
            <span className="section-label">Output folder</span>
            <div className="input-row">
              <div
                className={`folder-display ${outputFolder ? "is-set" : ""}`}
                title={outputFolder || undefined}
              >
                <span className="folder-display__path">
                  {outputFolder || "No folder selected"}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={handleChooseFolder}
              >
                {outputFolder ? "Change Folder" : "Choose Folder"}
              </button>
            </div>
          </div>
        </section>

        {error && (
          <div className="alert" role="alert">
            <AlertIcon className="alert__icon" />
            <span className="alert__text">{error}</span>
            {errorState.code === "auth" && (
              <button
                type="button"
                className="btn btn--secondary btn--sm alert__action"
                onClick={() => setSettingsOpen(true)}
              >
                Open Settings
              </button>
            )}
          </div>
        )}

        {!result && !loading && (
          <div className="empty-state">
            <img
              className="empty-state__mark"
              src={logomark}
              alt=""
              draggable={false}
            />
            <span>
              {mode === "playlist"
                ? "Paste a playlist link and select Analyze to review its tracks."
                : "Paste a video link and select Analyze to review its audio and metadata."}
            </span>
          </div>
        )}

        {result && (
          <section className="panel" aria-label="Analysis result">
            {!result.isPlaylist && (
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
                  onModeChange={handleSingleArtworkModeChange}
                  onChooseCustom={handleChooseSingleArtwork}
                  disabled={downloading}
                />

                <div className="result-single__info">
                  <span className="eyebrow">Video detected</span>
                  <h2 className="heading-lg">{result.title}</h2>
                  <div className="meta-line">
                    <span>{result.uploader || "Unknown uploader"}</span>
                    <span className="meta-line__dot" aria-hidden="true" />
                    <span>{formatDuration(result.duration)}</span>
                  </div>

                  <div className="form-grid form-grid--2 result-single__form">
                    <FormField label="Title" wide>
                      <input
                        type="text"
                        className="field"
                        value={result.metadata?.title || ""}
                        onChange={(event) =>
                          setResult((current) => ({
                            ...current,
                            metadata: {
                              ...current.metadata,
                              title: event.target.value,
                            },
                          }))
                        }
                        placeholder="Title"
                      />
                    </FormField>

                    <FormField label="Artist">
                      <input
                        type="text"
                        className="field"
                        value={result.metadata?.artist || ""}
                        onChange={(event) =>
                          setResult((current) => ({
                            ...current,
                            metadata: {
                              ...current.metadata,
                              artist: event.target.value,
                            },
                          }))
                        }
                        placeholder="Artist"
                      />
                    </FormField>

                    <FormField label="Album">
                      <input
                        type="text"
                        className="field"
                        value={result.metadata?.album || ""}
                        onChange={(event) =>
                          setResult((current) => ({
                            ...current,
                            metadata: {
                              ...current.metadata,
                              album: event.target.value,
                            },
                          }))
                        }
                        placeholder="Album"
                      />
                    </FormField>

                    <FormField label="Genre" wide>
                      <GenreSelect
                        value={result.metadata?.genre || ""}
                        onChange={(event) =>
                          setResult((current) => ({
                            ...current,
                            metadata: {
                              ...current.metadata,
                              genre: event.target.value,
                            },
                          }))
                        }
                      />
                    </FormField>
                  </div>

                  <div className="result-single__actions">
                    <div className="action-bar">
                      {!lastDownloadedFile && (
                        <button
                          type="button"
                          className={`btn btn--primary btn--lg ${
                            downloading ? "is-loading" : ""
                          }`}
                          onClick={handleDownloadSingle}
                          disabled={downloading || result.artworkPreviewLoading}
                        >
                          {downloading ? "Extracting MP3…" : "Extract MP3"}
                        </button>
                      )}

                      {lastDownloadedFile && !itunesOpened && (
                        <button
                          type="button"
                          className="btn btn--primary btn--lg"
                          onClick={handleOpenSingleInItunes}
                        >
                          Open in iTunes
                        </button>
                      )}

                      <InlineStatus message={statusMessage} />
                    </div>

                    {downloading && (
                      <ProgressBar
                        value={downloadProgress}
                        label={downloadLabel || "Extracting…"}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {result.isPlaylist && (
              <div>
                <div className="playlist-head">
                  <div className="playlist-head__title">
                    <span className="eyebrow">Playlist detected</span>
                    <h2 className="heading-md">{result.title}</h2>
                    <span className="text-muted" style={{ fontSize: 13 }}>
                      Select the songs you want to extract as MP3 files.
                    </span>
                  </div>
                </div>

                <div className="playlist-toolbar">
                  <div className="playlist-toolbar__group">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={handleSelectAllEntries}
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={handleClearAllEntries}
                    >
                      Clear All
                    </button>
                    <span className="text-muted" style={{ fontSize: 12 }}>
                      {selectedEntryCount} of {entries.length} selected
                    </span>
                  </div>

                  <div className="playlist-toolbar__group">
                    <InlineStatus message={statusMessage} />

                    {downloadedFiles.length === 0 && (
                      <button
                        type="button"
                        className={`btn btn--primary ${
                          batchDownloading ? "is-loading" : ""
                        }`}
                        onClick={handleDownloadSelected}
                        disabled={batchDownloading}
                      >
                        {batchDownloading
                          ? "Extracting Selected…"
                          : "Extract Selected"}
                      </button>
                    )}

                    {downloadedFiles.length > 0 && !itunesOpened && (
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={handleOpenDownloadedFilesInItunes}
                      >
                        Open All in iTunes
                      </button>
                    )}
                  </div>
                </div>

                {batchDownloading && (
                  <ProgressBar
                    value={downloadProgress}
                    label={batchProgressText}
                  />
                )}

                <div className="bulk-edit">
                  <span className="section-label">Apply to all tracks</span>
                  <div className="bulk-edit__row">
                    <input
                      type="text"
                      className="field"
                      value={masterArtist}
                      onChange={(event) => setMasterArtist(event.target.value)}
                      placeholder="Artist"
                      aria-label="Artist for all tracks"
                      disabled={batchDownloading}
                    />

                    <input
                      type="text"
                      className="field"
                      value={masterAlbum}
                      onChange={(event) => setMasterAlbum(event.target.value)}
                      placeholder="Album"
                      aria-label="Album for all tracks"
                      disabled={batchDownloading}
                    />

                    <GenreSelect
                      value={masterGenre}
                      onChange={(event) => setMasterGenre(event.target.value)}
                      disabled={batchDownloading}
                    />

                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={handleApplyMasterMetadata}
                      disabled={!canApplyMasterMetadata}
                    >
                      Apply to All
                    </button>

                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={handleApplyArtworkToAllEntries}
                      disabled={batchDownloading}
                    >
                      Use Cover for All
                    </button>
                  </div>
                </div>

                <div className="track-list">
                  {entries.map((entry, index) => (
                    <div
                      key={entry.id || index}
                      className={`track ${entry.selected ? "is-selected" : ""}`}
                    >
                      <button
                        type="button"
                        className={`check ${entry.selected ? "is-checked" : ""}`}
                        onClick={() =>
                          updateEntry(index, { selected: !entry.selected })
                        }
                        aria-pressed={!!entry.selected}
                        aria-label={`Select ${entry.title}`}
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
                        onModeChange={(artworkMode) =>
                          handleEntryArtworkModeChange(index, artworkMode)
                        }
                        onChooseCustom={() => handleChooseEntryArtwork(index)}
                        disabled={batchDownloading}
                      />

                      <div className="track__body">
                        <div className="track__title">{entry.title}</div>
                        <div className="meta-line track__meta">
                          <span>{entry.uploader || "Unknown uploader"}</span>
                          <span className="meta-line__dot" aria-hidden="true" />
                          <span>{formatDuration(entry.duration)}</span>
                        </div>

                        <div className="form-grid form-grid--3">
                          <FormField label="Title" wide>
                            <input
                              type="text"
                              className="field"
                              value={entry.metadata?.title || ""}
                              onChange={(event) =>
                                updateEntryMetadata(
                                  index,
                                  "title",
                                  event.target.value,
                                )
                              }
                              placeholder="Title"
                            />
                          </FormField>

                          <FormField label="Artist">
                            <input
                              type="text"
                              className="field"
                              value={entry.metadata?.artist || ""}
                              onChange={(event) =>
                                updateEntryMetadata(
                                  index,
                                  "artist",
                                  event.target.value,
                                )
                              }
                              placeholder="Artist"
                            />
                          </FormField>

                          <FormField label="Album">
                            <input
                              type="text"
                              className="field"
                              value={entry.metadata?.album || ""}
                              onChange={(event) =>
                                updateEntryMetadata(
                                  index,
                                  "album",
                                  event.target.value,
                                )
                              }
                              placeholder="Album"
                            />
                          </FormField>

                          <FormField label="Genre">
                            <GenreSelect
                              value={entry.metadata?.genre || ""}
                              onChange={(event) =>
                                updateEntryMetadata(
                                  index,
                                  "genre",
                                  event.target.value,
                                )
                              }
                            />
                          </FormField>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <p className="list-footer">Showing {entries.length} items.</p>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
