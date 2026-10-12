import { artworkUrl, formatBytes, formatDate, formatDuration, formatQuality } from "./format";
import { CloseIcon, FolderOpenIcon, PauseIcon, PlayIcon, WarningIcon } from "./icons";
import { TrackEditor } from "./Editors";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const ROLE_LABELS = { legacy: "Legacy", curated: "Curated", managed: "Managed", other: "Library" };

export function FileVersions({ track, playing, onPlayFile, onError }) {
  return (
    <div className="lib-versions">
      {track.files.map((file) => {
        const isActive = file.id === track.active_file_id;
        const isPlaying = playing?.fileId === file.id && playing.isPlaying;
        return (
          <div key={file.id} className={`lib-version ${isActive ? "is-active" : ""}`}>
            <div className="lib-version__head">
              <span className="lib-version__name" title={file.path}>
                {file.rel_path.split(/[\\/]/).pop()}
              </span>
              {isActive && <span className="lib-badge is-info">Active</span>}
              {file.role === "archived" && <span className="lib-badge is-quiet">Archived</span>}
              {file.status !== "ok" && (
                <span className={`lib-badge ${file.status === "missing" ? "is-missing" : "is-error"}`}>
                  {file.status === "missing" ? "Missing" : "Unreadable"}
                </span>
              )}
            </div>
            <div className="lib-version__meta">
              <span>{formatQuality(file)}</span>
              <span>{formatDuration(file.duration_ms)}</span>
              <span>{formatBytes(file.size)}</span>
              <span>
                {file.source_name} · {ROLE_LABELS[file.source_role] || "Library"}
              </span>
            </div>
            {file.read_error && <div className="lib-version__error">{file.read_error}</div>}
            <div className="lib-version__actions">
              {file.status !== "missing" && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => onPlayFile(file)}>
                  {isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                  {isPlaying ? "Pause" : "Play"}
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  libraryApi.showFileInFolder({ fileId: file.id }).catch((error) => onError?.(errorMessage(error)))
                }
                disabled={file.status === "missing"}
              >
                <FolderOpenIcon size={14} />
                Show in Explorer
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TrackDetail({ trackId, revision, playing, onPlayFile, onClose, onOpenAlbum, onError, onChanged, onWriteTags }) {
  const { data: track, error, loading } = useLoader(() => libraryApi.getTrack({ id: trackId }), [trackId, revision]);

  if (!trackId) return null;
  const artwork = track ? track.artwork_hash || track.files.find((file) => file.id === track.active_file_id)?.artwork_hash : null;

  return (
    <aside className="lib-detail" aria-label="Song details">
      <div className="lib-detail__header">
        <span className="section-label">Song</span>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close details">
          <CloseIcon size={16} />
        </button>
      </div>

      {error && (
        <div className="alert alert--compact" role="alert">
          <WarningIcon size={16} /> {error}
        </div>
      )}

      {track && (
        <div className="lib-detail__body">
          <div className="lib-detail__hero">
            <div className="lib-detail__art">
              {artwork ? (
                <img src={artworkUrl(artwork, 320)} alt={`${track.album || track.title} artwork`} />
              ) : (
                <span className="lib-art-placeholder lib-art-placeholder--lg">No artwork</span>
              )}
            </div>
            <div>
              <h3 className="heading-md">{track.title || "Untitled"}</h3>
              <div className="meta-line">
                <span>{track.artist || "Unknown artist"}</span>
                {track.album && (
                  <>
                    <span className="meta-line__dot" aria-hidden="true" />
                    {track.release_id && onOpenAlbum ? (
                      <button type="button" className="btn btn--link" onClick={() => onOpenAlbum(track.release_id)}>
                        {track.album}
                      </button>
                    ) : (
                      <span>{track.album}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="lib-detail__meta">
            {formatDuration(track.duration_ms)} · added {formatDate(track.created_at)}
          </div>
          <TrackEditor track={track} onChanged={onChanged} onError={onError} onWriteTags={onWriteTags} />

          <span className="section-label lib-detail__section">
            File versions ({track.files.length})
          </span>
          <FileVersions track={track} playing={playing} onPlayFile={(file) => onPlayFile(track, file)} onError={onError} />
        </div>
      )}

      {loading && !track && <div className="lib-detail__loading">Loading…</div>}
    </aside>
  );
}
