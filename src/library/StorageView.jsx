import { useState } from "react";
import { formatBytes, formatDate, pluralize } from "./format";
import { CheckIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const CATEGORIES = {
  library: ["Songs in your WaveMint Library", "Your music. Never cleaned up."],
  versions: ["Previous versions", "The audio that Edit Audio or Upgrade replaced, kept so the change can be undone."],
  tagBackups: ["Write Tags backups", "Copies of files from before WaveMint wrote tags or artwork into them."],
  playback: ["Playback copies", "Playable copies of Apple Lossless and AIFF songs. Made again when needed; kept under 1 GB."],
  artwork: ["Artwork and thumbnails", "Covers you chose, and small previews. Covers no song uses anymore are removed."],
  caches: ["Other caches", "Spectrograms and waveform data."],
  temporary: ["Temporary files", "Album imports left open for a week, and leftover extraction work folders."],
  dbBackups: ["Database backups", "Taken before WaveMint upgrades its library database; the newest 3 are kept."],
  database: ["Library database", "Your library's details, playlists and history."],
  engine: ["Extraction engine updates", "Newer yt-dlp versions you installed from Settings; old ones are pruned automatically."],
};

const RETENTION_OPTIONS = [
  ["1d", "1 day"],
  ["3d", "3 days"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["never", "Until I clean up"],
];

const REMOVED_LABELS = {
  versions: "previous version",
  tagBackups: "backup",
  playback: "playback copy",
  artwork: "unused image",
  caches: "cache file",
  temporary: "temporary item",
  dbBackups: "database backup",
};

function describeCleanup(cleanup) {
  const parts = Object.entries(cleanup.removed || {}).map(([category, count]) => pluralize(count, REMOVED_LABELS[category] || "item"));
  return parts.length ? parts.join(", ") : "nothing needed cleaning up";
}

/**
 * Storage: what WaveMint keeps on disk, what can be freed, and how long
 * previous versions are kept. Your music (and your own music folders) is
 * shown for context but never offered for cleanup.
 */
export function StorageView({ revision, onError }) {
  const [tick, setTick] = useState(0);
  const { data, loading } = useLoader(() => libraryApi.storageReport(), [revision, tick]);
  const [cleaning, setCleaning] = useState(null); // category id or "all"
  const [result, setResult] = useState(null);

  const cleanUp = async (categories) => {
    setCleaning(categories ? categories[0] : "all");
    setResult(null);
    try {
      setResult(await libraryApi.cleanUpStorage({ categories }));
      setTick((value) => value + 1);
    } catch (error) {
      onError?.(errorMessage(error, "The cleanup didn't run"));
    } finally {
      setCleaning(null);
    }
  };

  const update = async (patch) => {
    try {
      await libraryApi.updateSettings({ patch });
      setTick((value) => value + 1);
    } catch (error) {
      onError?.(errorMessage(error));
    }
  };

  if (!data) return <div className="lib-loading">{loading ? "Measuring how much space WaveMint uses…" : ""}</div>;

  const max = Math.max(1, ...data.categories.map((item) => item.bytes));
  const reclaimable = data.reclaimableBytes;

  return (
    <div className="lib-storage">
      <section className="lib-storage__summary" aria-label="Summary">
        <div className="lib-stat">
          <span className="lib-stat__value">{formatBytes(data.totalBytes)}</span>
          <span className="lib-stat__label">Used by WaveMint</span>
        </div>
        <div className="lib-stat">
          <span className="lib-stat__value">{formatBytes(reclaimable)}</span>
          <span className="lib-stat__label">Can be freed now</span>
        </div>
        <div className="lib-storage__actions">
          <button type="button" className={`btn btn--primary ${cleaning === "all" ? "is-loading" : ""}`} onClick={() => cleanUp(null)} disabled={!!cleaning || !reclaimable}>
            Clean Up
          </button>
          <span className="settings-hint">
            {data.lastCleanup
              ? `Last cleanup ${formatDate(data.lastCleanup.at)}${data.lastCleanup.auto ? " (automatic)" : ""}: freed ${formatBytes(data.lastCleanup.freedBytes)}.`
              : "Not cleaned up yet."}
          </span>
        </div>
      </section>

      {result && (
        <div className="lib-notice" role="status">
          <CheckIcon size={16} />
          <span className="lib-notice__text">
            Freed {formatBytes(result.freedBytes)}: {describeCleanup(result)}.
            {result.failed ? ` ${pluralize(result.failed, "item")} couldn't be removed and ${result.failed === 1 ? "was" : "were"} left in place (for example, a file in use).` : ""}
            {result.removed?.versions || result.removed?.tagBackups || result.removed?.dbBackups ? " Audio and backups went to the Recycle Bin." : ""}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      <section className="panel lib-storage__settings" aria-labelledby="lib-storage-settings">
        <h2 id="lib-storage-settings" className="section-label">
          Keeping previous versions
        </h2>
        <div className="lib-storage__setting">
          <label className="form-field">
            <span className="form-field__label">Keep previous versions and backups for</span>
            <select className="field" value={data.retention} onChange={(event) => update({ keepPreviousVersions: event.target.value })}>
              {RETENTION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={data.autoCleanup} onChange={(event) => update({ autoCleanup: event.target.checked })} />
            Clean up automatically (at most once a day, never during a task)
          </label>
        </div>
        <p className="settings-hint">
          After an edit, upgrade or tag write, the earlier version stays recoverable for this long. After that it moves to the Recycle Bin and the
          change can no longer be undone from History.
        </p>
      </section>

      <section className="panel" aria-labelledby="lib-storage-breakdown">
        <h2 id="lib-storage-breakdown" className="section-label">
          What WaveMint keeps
        </h2>
        <ul className="lib-storage__list">
          {data.categories.map((item) => {
            const [label, description] = CATEGORIES[item.id] || [item.id, ""];
            const text = item.id === "versions" || item.id === "tagBackups" ? `${description} Kept for ${data.retentionLabel}.` : description;
            return (
              <li key={item.id} className={`lib-storage__row ${item.kept ? "is-kept" : ""}`}>
                <div className="lib-storage__text">
                  <strong>{label}</strong>
                  <span>{text}</span>
                </div>
                <span className="lib-storage__bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(item.bytes ? 1 : 0, (item.bytes / max) * 100)}%` }} />
                </span>
                <span className="lib-storage__size">
                  {formatBytes(item.bytes)}
                  {item.reclaimable > 0 && <span className="lib-storage__free">{formatBytes(item.reclaimable)} can be freed</span>}
                  {item.kept && <span className="lib-storage__kept">Kept</span>}
                </span>
                <span className="lib-storage__action">
                  {item.reclaimable > 0 && (
                    <button type="button" className={`btn btn--ghost btn--sm ${cleaning === item.id ? "is-loading" : ""}`} onClick={() => cleanUp([item.id])} disabled={!!cleaning}>
                      Clean Up
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {data.external.files > 0 && (
        <section className="panel lib-storage__external" aria-labelledby="lib-storage-external">
          <h2 id="lib-storage-external" className="section-label">
            Your own music folders
          </h2>
          <p className="settings-help">
            {formatBytes(data.external.bytes)} in {pluralize(data.external.files, "file")}. WaveMint only reads these folders and never cleans them up.
            {data.external.duplicatedFiles > 0 &&
              ` ${formatBytes(data.external.duplicatedBytes)} of that (${pluralize(data.external.duplicatedFiles, "file")}) belongs to songs that now play from your WaveMint Library. If you no longer need those originals, you can remove them yourself.`}
          </p>
        </section>
      )}

      {data.lastCleanup?.failures?.length > 0 && (
        <p className="settings-hint">
          <WarningIcon size={14} /> Left in place last time: {data.lastCleanup.failures.map((failure) => failure.name).join(", ")}.
        </p>
      )}
    </div>
  );
}
