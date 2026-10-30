import { useState } from "react";
import { Artwork } from "./Artwork";
import { Disclosure } from "./Disclosure";
import { TrackEditor } from "./Editors";
import { codecLabel, formatBytes, formatDate, formatDuration, formatQuality } from "./format";
import { CloseIcon, FolderOpenIcon, HeartIcon, PauseIcon, PlayIcon, SearchIcon, UpgradeIcon, WarningIcon, WaveformIcon } from "./icons";
import { MusicBrainzConsent } from "./IdentifyDialog";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const QUALITY_LABELS = {
  unknown: "Quality not checked",
  review_suggested: "Quality review suggested",
  acceptable: "No quality concerns found",
  user_marked_poor: "Marked poor quality",
  upgrade_available: "Upgrade candidate available",
  upgraded: "Upgraded",
  keep_original: "Kept in original form",
};

const fileName = (file) => file.rel_path.split(/[\\/]/).pop();

function describeRate(file) {
  if (!file.sample_rate) return null;
  const rate = `${(file.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz`;
  return file.bit_depth ? `${rate} · ${file.bit_depth}-bit` : rate;
}

/**
 * The song's artwork, with what Save Changes will write: a chosen image or a
 * cover found online is shown as a proposal until it's saved or dropped.
 * "Find Artwork" (only when the song has none) looks up a cover from the
 * song's title, artist and album; it never identifies the song or changes
 * anything else.
 */
function ArtworkPanel({ track, artwork, fileArtwork, pending, onPending, onChanged, onError }) {
  const [finding, setFinding] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);

  const find = async () => {
    setFinding(true);
    setNotFound(false);
    try {
      const found = await libraryApi.findArtwork({ trackId: track.id });
      if (found) onPending({ hash: found.hash, caption: ["Cover Art Archive", found.release.title, found.release.year].filter(Boolean).join(" · ") });
      else setNotFound(true);
    } catch (error) {
      if (error?.message?.includes("MusicBrainz")) setNeedsConsent(true);
      else onError(errorMessage(error, "Artwork couldn't be looked up."));
    } finally {
      setFinding(false);
    }
  };

  const choose = async () => {
    try {
      const chosen = await libraryApi.chooseUpgradeArtwork({});
      if (chosen?.hash) onPending({ hash: chosen.hash, caption: "Your chosen image" });
    } catch (error) {
      onError(errorMessage(error, "That image couldn't be used."));
    }
  };

  const shown = pending?.hash || artwork;
  return (
    <div className="lib-detail__artwork">
      <div className={`lib-detail__art ${pending ? "is-pending" : ""}`}>
        <Artwork hash={shown} size={320} alt={shown ? `${track.album || track.title} artwork` : "No artwork"} />
        {!shown && (
          <button type="button" className={`lib-detail__find-art ${finding ? "is-loading" : ""}`} disabled={finding} onClick={find} title="Look up the album cover from the title, artist and album">
            <SearchIcon size={13} /> {finding ? "Searching…" : "Find Artwork"}
          </button>
        )}
      </div>
      <div className="lib-detail__art-actions">
        {pending ? (
          <>
            <span className="lib-detail__art-note">New artwork · {pending.caption}. Save Changes to keep it.</span>
            <button type="button" className="btn btn--link" onClick={() => onPending(null)}>
              Don&apos;t Use
            </button>
          </>
        ) : (
          <>
            {notFound && <span className="lib-detail__art-note">No cover found for this album.</span>}
            {/* Only when the file has other artwork than WaveMint shows (a file WaveMint doesn't write). */}
            {track.artwork_hash && fileArtwork && track.artwork_hash !== fileArtwork && (
              <button
                type="button"
                className="btn btn--link"
                onClick={() =>
                  libraryApi
                    .clearArtwork({ trackIds: [track.id] })
                    .then(onChanged)
                    .catch((error) => onError(errorMessage(error)))
                }
              >
                Use the File&apos;s Artwork
              </button>
            )}
            <button type="button" className="btn btn--link" onClick={choose}>
              {shown ? "Change Artwork…" : "Choose Image…"}
            </button>
          </>
        )}
      </div>
      {needsConsent && (
        <MusicBrainzConsent
          onError={onError}
          onEnabled={() => {
            setNeedsConsent(false);
            find();
          }}
        />
      )}
    </div>
  );
}

/** The song's current file: the essentials, then the technical details on request. */
function FileDetails({ track, file, onUpgrade, onChanged, onError }) {
  let reasons = [];
  try {
    reasons = JSON.parse(track.quality_reasons || "{}").reasons || [];
  } catch {
    reasons = [];
  }
  const setQuality = (status) =>
    libraryApi
      .setQualityStatus({ trackIds: [track.id], status })
      .then(onChanged)
      .catch((error) => onError?.(errorMessage(error)));
  const show = () => libraryApi.showFileInFolder({ fileId: file.id }).catch((error) => onError?.(errorMessage(error)));

  return (
    <section className="lib-detail__file" aria-label="File">
      <span className="section-label">File</span>
      {file.status !== "ok" && (
        <p className="lib-edit__note is-error">
          <WarningIcon size={13} /> {file.status === "missing" ? "The file is missing. Rescan its folder from Sources, or check File Health." : file.read_error || "The file can't be read."}
        </p>
      )}
      <div className="lib-detail__file-summary">
        <span>{formatQuality(file)}</span>
        <span>{formatDuration(file.duration_ms)}</span>
        <span>{formatBytes(file.size)}</span>
      </div>
      <div className="lib-detail__file-path" title={file.path}>
        {fileName(file)}
        <button type="button" className="btn btn--link" onClick={show} disabled={file.status === "missing"}>
          <FolderOpenIcon size={13} /> Show in Explorer
        </button>
      </div>

      <Disclosure label="Technical details" className="lib-detail__technical">
        <dl className="lib-detail__facts">
          <dt>Format</dt>
          <dd>{file.codec ? `${codecLabel(file.codec)}${file.lossless ? " (lossless)" : ""}` : "—"}</dd>
          <dt>Bitrate</dt>
          <dd>{file.bitrate ? `${file.bitrate} kbps` : "—"}</dd>
          <dt>Sample rate</dt>
          <dd>{describeRate(file) || "—"}</dd>
          <dt>Channels</dt>
          <dd>{{ 1: "Mono", 2: "Stereo" }[file.channels] || (file.channels ? `${file.channels} channels` : "—")}</dd>
          <dt>Location</dt>
          <dd className="is-path">{file.path}</dd>
          <dt>Folder</dt>
          <dd>
            {file.source_name}
            {file.source_read_only ? " (read-only)" : ""}
          </dd>
          <dt>Quality</dt>
          <dd>{QUALITY_LABELS[track.quality_status] || track.quality_status}</dd>
        </dl>
        {reasons.length > 0 && (
          <ul className="lib-detail__reasons">
            {reasons.map((item) => (
              <li key={item.code}>{item.text}</li>
            ))}
          </ul>
        )}
        <div className="lib-detail__quality-head">
          {onUpgrade && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => onUpgrade(track.id)}>
              <UpgradeIcon size={14} /> Upgrade Audio…
            </button>
          )}
          <select className="field lib-quality-row__status" aria-label="Quality decision" value="" onChange={(event) => event.target.value && setQuality(event.target.value)}>
            <option value="">Quality decision…</option>
            <option value="user_marked_poor">Mark poor quality</option>
            <option value="keep_original">Keep in original form</option>
            <option value="acceptable">Acceptable</option>
            {track.quality_set_by !== "auto" && <option value="auto">Let WaveMint decide</option>}
          </select>
        </div>
      </Disclosure>
    </section>
  );
}

/**
 * Earlier files of this song (kept after an upgrade or audio edit, or other
 * copies merged into it). Collapsed by default; restoring one goes through
 * Upgrade Track, which compares it with the current file and asks first.
 */
export function VersionHistory({ track, playing, onPlayFile, onRestore, onError, defaultOpen = false }) {
  const previous = track.files.filter((file) => file.id !== track.active_file_id);
  if (!previous.length) return null;
  return (
    <Disclosure label="Version history" hint={`${previous.length} earlier ${previous.length === 1 ? "file" : "files"}`} defaultOpen={defaultOpen} className="lib-detail__history">
      <p className="settings-hint">The current file is the one above. These earlier files are kept so a change can be taken back.</p>
      <div className="lib-versions">
        {previous.map((file) => {
          const isPlaying = playing?.fileId === file.id && playing.isPlaying;
          return (
            <div key={file.id} className="lib-version">
              <div className="lib-version__head">
                <span className="lib-version__name" title={file.path}>
                  {fileName(file)}
                </span>
                <span className="lib-badge is-quiet">{file.role === "archived" ? "Previous version" : "Other copy"}</span>
                {file.status !== "ok" && <span className={`lib-badge ${file.status === "missing" ? "is-missing" : "is-error"}`}>{file.status === "missing" ? "Missing" : "Unreadable"}</span>}
              </div>
              <div className="lib-version__meta">
                <span>{formatQuality(file)}</span>
                <span>{formatDuration(file.duration_ms)}</span>
                <span>{formatBytes(file.size)}</span>
                {file.first_seen_at && <span>since {formatDate(file.first_seen_at)}</span>}
              </div>
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
                  disabled={file.status === "missing"}
                  onClick={() => libraryApi.showFileInFolder({ fileId: file.id }).catch((error) => onError?.(errorMessage(error)))}
                >
                  <FolderOpenIcon size={14} /> Show in Explorer
                </button>
                {file.status === "ok" && onRestore && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRestore(track.id, { fileId: file.id })}>
                    Restore This Version…
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}

/**
 * The song panel: artwork, the metadata editor (one Save Changes that writes
 * the file), the current file, and its earlier versions (collapsed).
 */
export function TrackDetail({ trackId, revision, playing, onPlayFile, onClose, onOpenAlbum, onOpenArtist, onError, onChanged, onUpgrade, onIdentify, onEditAudio, onToggleFavorite }) {
  const { data: track, error, loading } = useLoader(() => libraryApi.getTrack({ id: trackId }), [trackId, revision]);
  const [pendingArtwork, setPendingArtwork] = useState(null);

  if (!trackId) return null;
  const activeFile = track?.files.find((file) => file.id === track.active_file_id);
  const artwork = track ? track.artwork_hash || activeFile?.artwork_hash : null;
  const isPlaying = !!activeFile && playing?.fileId === activeFile.id && playing.isPlaying;

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

      {track && track.state !== "active" && <div className="lib-detail__loading">This song is no longer in your library.</div>}

      {track && track.state === "active" && (
        <div className="lib-detail__body">
          <div className="lib-detail__hero">
            <ArtworkPanel
              track={track}
              artwork={artwork}
              fileArtwork={activeFile?.artwork_hash || null}
              pending={pendingArtwork}
              onPending={setPendingArtwork}
              onChanged={onChanged}
              onError={onError}
            />
            <div>
              <h3 className="heading-md">{track.title || "Untitled"}</h3>
              <div className="meta-line">
                {track.artist && onOpenArtist ? (
                  <button type="button" className="btn btn--link" onClick={() => onOpenArtist(track.artist_key, track.artist)}>
                    {track.artist}
                  </button>
                ) : (
                  <span>{track.artist || "Unknown artist"}</span>
                )}
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
            {track.mb_recording_id && " · identified"}
            {onIdentify && (
              <button type="button" className="btn btn--link lib-detail__identify" onClick={() => onIdentify(track.id)}>
                {track.mb_recording_id ? "Identify again…" : "Identify…"}
              </button>
            )}
          </div>
          {activeFile && activeFile.status === "ok" && (
            <div className="lib-detail__actions">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => onPlayFile(track, activeFile)}>
                {isPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                {isPlaying ? "Pause" : "Play"}
              </button>
              {onEditAudio && (
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => onEditAudio(track.id)}>
                  <WaveformIcon size={14} /> Edit Audio…
                </button>
              )}
              {onToggleFavorite && (
                <button
                  type="button"
                  className={`btn btn--ghost btn--sm lib-detail__favorite ${track.favorite ? "is-on" : ""}`}
                  aria-pressed={!!track.favorite}
                  onClick={() => onToggleFavorite(track)}
                >
                  <HeartIcon size={14} filled={!!track.favorite} /> {track.favorite ? "Favorite" : "Add to Favorites"}
                </button>
              )}
            </div>
          )}

          <TrackEditor track={track} pendingArtwork={pendingArtwork} onPendingArtworkChange={setPendingArtwork} onChanged={onChanged} />

          {activeFile && <FileDetails track={track} file={activeFile} onUpgrade={onUpgrade} onChanged={onChanged} onError={onError} />}
          <VersionHistory track={track} playing={playing} onPlayFile={(file) => onPlayFile(track, file)} onRestore={onUpgrade} onError={onError} />
        </div>
      )}

      {loading && !track && <div className="lib-detail__loading">Loading…</div>}
    </aside>
  );
}
