import { useState } from "react";
import { formatBytes, formatDate, formatNumber } from "./format";
import { RefreshIcon, SourceIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const ROLE_OPTIONS = [
  ["curated", "Curated (preferred)"],
  ["legacy", "Legacy"],
  ["other", "Other"],
];

const ROLE_HELP = {
  curated: "Your carefully edited collection. Preferred when the same recording exists in several places.",
  legacy: "An older collection (for example your iTunes Media folder). Kept for songs that exist nowhere else.",
  other: "Any other music folder or drive.",
  managed: "WaveMint's own organized library. WaveMint writes finished, consolidated files here.",
};

export function ScanProgress({ job, onCancel }) {
  if (!job) return null;
  const progress = job.progress || {};
  const done = (progress.added || 0) + (progress.updated || 0) + (progress.unchanged || 0) + (progress.unreadable || 0);

  return (
    <div className="lib-job" role="status">
      <div className="lib-job__text">
        <strong>{job.label}</strong>
        <span>
          {progress.sourceName ? `${progress.sourceName}: ` : ""}
          {formatNumber(done)} files checked
          {progress.added ? ` · ${formatNumber(progress.added)} new` : ""}
          {progress.updated ? ` · ${formatNumber(progress.updated)} changed` : ""}
          {progress.unreadable ? ` · ${formatNumber(progress.unreadable)} unreadable` : ""}
        </span>
        {progress.currentPath && <span className="lib-job__path">{progress.currentPath}</span>}
      </div>
      <div className="progress__track is-indeterminate lib-job__bar">
        <div className="progress__fill" />
      </div>
      {onCancel && (
        <button type="button" className="btn btn--link" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

function SourceCard({ source, busy, onChanged, onError }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmWritable, setConfirmWritable] = useState(false);
  const stats = source.last_scan_stats;

  const run = async (action) => {
    try {
      await action();
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  return (
    <div className={`lib-source ${source.status !== "ok" ? "is-unavailable" : ""}`}>
      <div className="lib-source__head">
        <SourceIcon size={20} />
        <div className="lib-source__title">
          <strong>{source.name}</strong>
          <span className="lib-source__path" title={source.root_path}>
            {source.root_path}
          </span>
        </div>
        {source.status !== "ok" ? (
          <span className="lib-badge is-missing">Unavailable</span>
        ) : (
          <span className="lib-badge is-quiet">{source.read_only ? "Read-only" : "Writable"}</span>
        )}
      </div>

      {source.status !== "ok" && (
        <p className="lib-source__warning">
          <WarningIcon size={14} /> This folder can&apos;t be reached (a disconnected drive or a moved folder). Its songs stay in your
          library; reconnect the drive and rescan, or relink the folder if it moved.
        </p>
      )}

      <div className="lib-source__stats">
        <span>{formatNumber(source.file_count)} files</span>
        <span>{formatBytes(source.total_size)}</span>
        {source.missing_count > 0 && <span className="is-warn">{formatNumber(source.missing_count)} missing</span>}
        {source.unreadable_count > 0 && <span className="is-warn">{formatNumber(source.unreadable_count)} unreadable</span>}
        <span>
          {source.last_scan_completed_at ? `Scanned ${formatDate(source.last_scan_completed_at)}` : "Not scanned yet"}
          {stats?.added ? ` · ${formatNumber(stats.added)} new` : ""}
        </span>
      </div>

      <div className="lib-source__controls">
        {source.role === "managed" ? (
          <span className="settings-hint">{ROLE_HELP.managed}</span>
        ) : (
          <>
            <label className="form-field lib-source__role">
              <span className="form-field__label">Role</span>
              <select
                className="field"
                value={source.role}
                disabled={busy}
                onChange={(event) =>
                  run(() =>
                    libraryApi.updateSource({
                      id: source.id,
                      patch: {
                        role: event.target.value,
                        priority: { curated: 80, legacy: 20, other: 50 }[event.target.value],
                      },
                    }),
                  )
                }
              >
                {ROLE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field lib-source__priority">
              <span className="form-field__label">Priority</span>
              <input
                className="field"
                type="number"
                min={0}
                max={100}
                defaultValue={source.priority}
                disabled={busy}
                onBlur={(event) => {
                  const value = Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0)));
                  if (value !== source.priority) run(() => libraryApi.updateSource({ id: source.id, patch: { priority: value } }));
                }}
              />
            </label>
            <span className="settings-hint lib-source__help">{ROLE_HELP[source.role]}</span>
          </>
        )}
      </div>

      {source.role !== "managed" && (
        <div className="lib-source__writable">
          {source.read_only ? (
            confirmWritable ? (
              <span className="lib-confirm">
                WaveMint will be allowed to write tags into files in this folder (each file is backed up first). Other apps
                that use these files, such as iTunes, may show the changes.
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmWritable(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  onClick={() => run(() => libraryApi.updateSource({ id: source.id, patch: { readOnly: false } })).then(() => setConfirmWritable(false))}
                >
                  Allow Writing
                </button>
              </span>
            ) : (
              <button type="button" className="btn btn--link" onClick={() => setConfirmWritable(true)}>
                Allow WaveMint to write tags in this folder…
              </button>
            )
          ) : (
            <span className="settings-hint">
              WaveMint may write tags here.{" "}
              <button type="button" className="btn btn--link" onClick={() => run(() => libraryApi.updateSource({ id: source.id, patch: { readOnly: true } }))}>
                Make read-only again
              </button>
            </span>
          )}
        </div>
      )}

      <div className="lib-source__actions">
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          disabled={busy}
          onClick={() => run(() => libraryApi.scanSources({ sourceIds: [source.id] }))}
        >
          <RefreshIcon size={14} />
          Rescan
        </button>
        {source.status !== "ok" && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => run(() => libraryApi.relinkSource({ id: source.id }))}>
            Relink Folder…
          </button>
        )}
        {source.role !== "managed" &&
          (confirmRemove ? (
            <span className="lib-confirm">
              Remove from WaveMint? Files on disk are not touched.
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
              <button
                type="button"
                className="btn btn--danger btn--sm"
                disabled={busy}
                onClick={() => run(() => libraryApi.removeSource({ id: source.id }))}
              >
                Remove
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Remove…
            </button>
          ))}
      </div>
    </div>
  );
}

export function SourcesView({ revision, busy, scanJob, onCancelJob, onAddSource, onError }) {
  const { data: sources, error, reload } = useLoader(() => libraryApi.listSources(), [revision]);

  return (
    <div className="lib-sources">
      <div className="lib-section-head">
        <p className="text-muted lib-sources__intro">
          WaveMint only reads these folders. Songs are copied, never moved, when you consolidate them into your
          managed library.
        </p>
        <div className="lib-sources__add">
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => onAddSource("curated")}>
            Add Curated Folder
          </button>
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => onAddSource("legacy")}>
            Add Legacy Folder
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onAddSource("other")}>
            Add Other…
          </button>
          {sources?.length > 1 && (
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => libraryApi.scanSources({}).catch((err) => onError(errorMessage(err)))}>
              <RefreshIcon size={14} />
              Rescan All
            </button>
          )}
        </div>
      </div>

      <ScanProgress job={scanJob} onCancel={scanJob ? () => onCancelJob(scanJob.id) : null} />

      {error && (
        <div className="alert alert--compact" role="alert">
          {error}
        </div>
      )}

      <div className="lib-source-list">
        {sources?.map((source) => (
          <SourceCard key={source.id} source={source} busy={busy} onChanged={reload} onError={onError} />
        ))}
        {sources && !sources.length && <p className="lib-empty-note">No folders added yet.</p>}
      </div>
    </div>
  );
}
