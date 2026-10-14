// Building blocks of the Add Music workspace (moved from App.jsx): progress,
// errors with details, metadata fields and the artwork picker.

import { useState } from "react";
import { getErrorActions } from "../ipcErrors";
import { useGenreNames } from "../library/useLibrary";
import { ARTWORK_PLACEHOLDER } from "../library/placeholder";
import { ARTWORK_OPTIONS } from "./extraction";

export function CheckIcon({ className }) {
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

export function AlertIcon({ className }) {
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

// Determinate only while yt-dlp reports a real download percentage;
// otherwise an indeterminate bar, so no progress is ever invented.
export function ProgressBar({ value = null, label, onCancel, cancelling = false }) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const percent = determinate ? Math.max(0, Math.min(100, value)) : 0;

  return (
    <div className="progress">
      <div className="progress__meta">
        <span className="progress__label" aria-live="polite">
          {label}
        </span>
        <span className="progress__end">
          {determinate && (
            <span className="progress__value">{Math.round(percent)}%</span>
          )}
          {onCancel && (
            <button
              type="button"
              className="btn btn--link progress__cancel"
              onClick={onCancel}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </span>
      </div>
      <div
        className={`progress__track ${determinate ? "" : "is-indeterminate"}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? Math.round(percent) : undefined}
        aria-label={label || "Progress"}
      >
        <div
          className="progress__fill"
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
}

export function ErrorAlert({ error, onRetry, onOpenSettings, retryDisabled }) {
  const [details, setDetails] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const actions = getErrorActions(error.code);

  const toggleDetails = async () => {
    if (detailsOpen) {
      setDetailsOpen(false);
      return;
    }

    if (!details) {
      try {
        setDetails(
          (await window.waveMintAPI.getErrorDetails(error.diagnosticsId)) ||
            "No technical details were recorded for this problem.",
        );
      } catch {
        setDetails("Technical details are no longer available.");
      }
    }

    setDetailsOpen(true);
  };

  const copyDetails = async () => {
    try {
      const result = await window.waveMintAPI.copyErrorDetails(error.diagnosticsId);
      setCopied(!!result?.copied);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="alert alert--stacked" role="alert">
      <div className="alert__row">
        <AlertIcon className="alert__icon" />
        <span className="alert__text">{error.message}</span>
        <span className="alert__actions">
          {actions.includes("retry") && onRetry && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={onRetry}
              disabled={retryDisabled}
            >
              Retry
            </button>
          )}
          {actions.includes("settings") && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => onOpenSettings("access")}
            >
              YouTube Access
            </button>
          )}
          {actions.includes("updates") && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => onOpenSettings("engine")}
            >
              Check for Updates
            </button>
          )}
          {error.diagnosticsId && (
            <button
              type="button"
              className="btn btn--link alert__details-toggle"
              onClick={toggleDetails}
              aria-expanded={detailsOpen}
            >
              {detailsOpen ? "Hide details" : "Details"}
            </button>
          )}
        </span>
      </div>

      {detailsOpen && (
        <div className="alert__details">
          <pre className="alert__details-text">{details}</pre>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={copyDetails}
          >
            {copied ? "Copied" : "Copy Error Details"}
          </button>
        </div>
      )}
    </div>
  );
}

export function InlineStatus({ message }) {
  if (!message) return null;

  return (
    <span role="status" aria-live="polite" className="status-pill">
      <CheckIcon className="status-pill__icon" />
      {message}
    </span>
  );
}

/**
 * The genre picker. Its options always include the current value, so a
 * detected genre that isn't in the list is shown as it will be written.
 */
export function GenreSelect({ value, onChange, disabled, className = "" }) {
  const genres = useGenreNames();
  const options = value && !genres.includes(value) ? [value, ...genres] : genres;
  return (
    <select value={value} onChange={onChange} disabled={disabled} className={`field ${value ? "" : "is-empty"} ${className}`.trim()}>
      <option value="">Select genre</option>
      {options.map((genre) => (
        <option key={genre} value={genre}>
          {genre}
        </option>
      ))}
    </select>
  );
}

export function FormField({ label, wide = false, children }) {
  return (
    <label className={`form-field ${wide ? "form-field--wide" : ""}`.trim()}>
      <span className="form-field__label">{label}</span>
      {children}
    </label>
  );
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

export function ArtworkPanel({
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
        ) : previewLoading ? (
          <div className="artwork__placeholder">Generating preview…</div>
        ) : (
          <img className="artwork__img" src={ARTWORK_PLACEHOLDER} alt="No artwork" />
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
