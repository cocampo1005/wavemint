import { useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { Artwork } from "./Artwork";
import { formatBytes, formatNumber, pluralize } from "./format";
import { HistoryIcon, RefreshIcon, StorageIcon, UpgradeIcon, WarningIcon } from "./icons";
import { WithSongPanel } from "./SongPanel";
import { VersionHistory } from "./TrackDetail";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const SECTIONS = [
  ["missing", "Missing or unreadable files"],
  ["versions", "Earlier versions"],
  ["backups", "Backups and recovery"],
];

const PAGE = 100;

/** One song whose current file is missing or can't be read, with the ways to repair it. */
function MissingRow({ row, onOpen, onReplace, onRemove }) {
  return (
    <div className="lib-review-item">
      <Artwork className="lib-review-item__art" hash={row.artwork_hash} size={64} loading="lazy" />
      <div className="lib-review-item__body">
        <div className="lib-review-item__title">
          <span className={`lib-badge ${row.file_status === "missing" || !row.file_id ? "is-missing" : "is-error"}`}>{!row.file_id ? "No file" : row.file_status === "missing" ? "Missing" : "Unreadable"}</span>
          <button type="button" className="lib-review-item__open" onClick={() => onOpen(row.id)}>
            {`${row.title || "Untitled"} — ${row.artist || "Unknown artist"}`}
          </button>
        </div>
        <span className="lib-review-item__text">{row.source_name ? `In "${row.source_name}"` : "Not in any library folder"}</span>
      </div>
      <div className="lib-review-item__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => onReplace(row.id)} title="Choose the file (or another copy) to use for this song">
          <UpgradeIcon size={13} /> Replace File…
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRemove(row)} title="Remove the song from your library (nothing on disk changes; undo from History)">
          Remove from Library
        </button>
      </div>
    </div>
  );
}

/** A song with earlier files: its version history, expandable in place. */
function VersionsRow({ row, onOpen, onRestore, onError }) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const { data: track } = useLoader(() => (open ? libraryApi.getTrack({ id: row.id }) : null), [open, row.id]);
  return (
    <div className="lib-review-item lib-health-versions">
      <Artwork className="lib-review-item__art" hash={row.artwork_hash} size={64} loading="lazy" />
      <div className="lib-review-item__body">
        <div className="lib-review-item__title">
          <button type="button" className="lib-review-item__open" onClick={() => onOpen(row.id)}>
            {`${row.title || "Untitled"} — ${row.artist || "Unknown artist"}`}
          </button>
        </div>
        {!open && (
          <button type="button" className="btn btn--link" onClick={() => setOpen(true)}>
            Show version history
          </button>
        )}
        {open && track && (
          <VersionHistory
            track={track}
            defaultOpen
            playing={player.playing}
            onPlayFile={(file) => player.playFile(track, file)}
            onRestore={onRestore}
            onError={onError}
          />
        )}
      </div>
    </div>
  );
}

/**
 * File integrity and management: songs whose file is missing or unreadable
 * (repair or remove), songs with earlier versions kept after an upgrade or an
 * audio edit (restore one), and the backups that make changes undoable.
 */
export function FileHealthView({ revision, browserProps, onNavigate, onRemove, onError, scanning }) {
  const [section, setSection] = useState("missing");
  const [openTrack, setOpenTrack] = useState(null);
  const [limit, setLimit] = useState(PAGE);
  const filters = section === "missing" ? { missingFile: true } : { multipleVersions: true };
  const { data, error } = useLoader(
    () => (section === "backups" ? null : libraryApi.listTracks({ filters, sort: "artist", direction: "asc", limit })),
    [section, limit, revision],
  );
  const { data: storage } = useLoader(() => (section === "backups" ? libraryApi.storageReport() : null), [section, revision]);
  const { data: status } = useLoader(() => libraryApi.getStatus(), [revision]);

  const rescan = () => libraryApi.scanSources({}).catch((err) => onError(errorMessage(err, "The scan couldn't start.")));
  const replace = (trackId) => browserProps.onUpgrade(trackId);
  const category = (id) => storage?.categories.find((item) => item.id === id);

  return (
    <WithSongPanel trackId={openTrack} onClose={() => setOpenTrack(null)} browserProps={browserProps}>
      <div className="lib-review lib-health">
        <div className="lib-chips lib-quality__views" role="tablist" aria-label="File health">
          {SECTIONS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={section === key}
              className={`lib-chip ${section === key ? "is-on" : ""}`}
              onClick={() => {
                setSection(key);
                setLimit(PAGE);
              }}
            >
              {label}
              {key === "missing" && status?.fileProblems > 0 && <span className="lib-tab-count">{formatNumber(status.fileProblems)}</span>}
            </button>
          ))}
        </div>

        {error && <div className="alert alert--compact">{error}</div>}

        {section === "missing" && (
          <>
            <div className="lib-toolbar">
              <span className="settings-hint">A file is missing when it was moved, renamed or deleted outside WaveMint, or its drive isn&apos;t connected.</span>
              <div className="lib-toolbar__actions">
                <button type="button" className={`btn btn--ghost btn--sm ${scanning ? "is-loading" : ""}`} disabled={scanning} onClick={rescan}>
                  <RefreshIcon size={14} /> Rescan Library Folders
                </button>
              </div>
            </div>
            <div className="lib-review__list">
              {data?.rows.map((row) => (
                <MissingRow key={row.id} row={row} onOpen={setOpenTrack} onReplace={replace} onRemove={(item) => onRemove([item.id], [item])} />
              ))}
              {data && !data.rows.length && <p className="lib-empty-note">Every song&apos;s file is where WaveMint expects it.</p>}
            </div>
          </>
        )}

        {section === "versions" && (
          <>
            <p className="settings-hint">
              Earlier files of a song are kept after an upgrade or an audio edit, so the change can be taken back. Restoring one compares it with the
              current file first and asks before anything changes.
            </p>
            <div className="lib-review__list">
              {data?.rows.map((row) => (
                <VersionsRow key={row.id} row={row} onOpen={setOpenTrack} onRestore={(trackId, start) => browserProps.onUpgrade(trackId, start)} onError={onError} />
              ))}
              {data && !data.rows.length && <p className="lib-empty-note">No song has earlier versions.</p>}
            </div>
          </>
        )}

        {section !== "backups" && data && data.total > data.rows.length && (
          <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + PAGE)}>
            Show more ({formatNumber(data.total - data.rows.length)})
          </button>
        )}

        {section === "backups" && (
          <div className="lib-health__backups">
            <p className="settings-hint">
              Before WaveMint changes a file it keeps a way back: saving metadata keeps a verified copy of the original (one per song per day), and an
              upgrade or audio edit keeps the previous file. They&apos;re kept for {storage?.retentionLabel || "a few days"}, then cleaned up
              {storage?.autoCleanup === false ? " when you choose" : " automatically"}.
            </p>
            {storage && (
              <dl className="lib-detail__facts">
                <dt>Previous versions</dt>
                <dd>{formatBytes(category("versions")?.bytes || 0)}</dd>
                <dt>Metadata backups</dt>
                <dd>{formatBytes(category("tagBackups")?.bytes || 0)}</dd>
                <dt>Kept for</dt>
                <dd>{storage.retentionLabel}</dd>
              </dl>
            )}
            <div className="lib-toolbar__actions">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => onNavigate("history")}>
                <HistoryIcon size={14} /> Undo a Change in History
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate("storage")}>
                <StorageIcon size={14} /> Storage and Retention
              </button>
            </div>
            {status?.unsavedWritable > 0 && (
              <p className="lib-edit__note is-warn">
                <WarningIcon size={13} /> {pluralize(status.unsavedWritable, "song")} {status.unsavedWritable === 1 ? "has" : "have"} changes that couldn&apos;t be saved to the file yet.
              </p>
            )}
          </div>
        )}
      </div>
    </WithSongPanel>
  );
}
