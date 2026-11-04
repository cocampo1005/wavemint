import { useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { Artwork } from "./Artwork";
import { formatBytes, formatDate, formatNumber, pluralize } from "./format";
import { CheckIcon, FolderOpenIcon, HistoryIcon, RefreshIcon, StorageIcon, UpgradeIcon, WarningIcon } from "./icons";
import { WithSongPanel } from "./SongPanel";
import { VersionHistory } from "./TrackDetail";
import { errorMessage, libraryApi, useJobRunner, useLoader } from "./useLibrary";

const SECTIONS = [
  ["missing", "Missing or unreadable files"],
  ["formats", "Audio formats"],
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

const percent = (share) => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 2 : 1)}%`;

/** One file WaveMint can't find: which song, where it should be, why, and the safe repairs. */
function MissingFileRow({ item, onOpen, onReplace, onRemove, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const act = async (action) => {
    setBusy(true);
    try {
      if (await action()) onChanged();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const name = `${item.title || "Untitled"} — ${item.artist || "Unknown artist"}`;
  return (
    <div className="lib-review-item lib-health-missing">
      <div className="lib-review-item__body">
        <div className="lib-review-item__title">
          <span className={`lib-badge ${item.status === "missing" ? "is-missing" : "is-error"}`}>{item.status === "missing" ? "Missing" : "Unreadable"}</span>
          {item.trackId && item.current ? (
            <button type="button" className="lib-review-item__open" onClick={() => onOpen(item.trackId)}>
              {name}
            </button>
          ) : (
            <span>{name}</span>
          )}
        </div>
        <span className="lib-review-item__text">{item.belongsTo}</span>
        <code className="lib-health-missing__path" title={item.path}>
          {item.path}
        </code>
        <span className="lib-review-item__text">
          {item.reason}
          {item.lastSeenAt ? ` Last seen ${formatDate(item.lastSeenAt)}.` : ""}
        </span>
        {item.elsewhere.length > 0 && <span className="lib-review-item__text">A file with the same name exists: {item.elsewhere.map((entry) => entry.path).join("; ")}</span>}
        {item.otherCopies.length > 0 && (
          <span className="lib-review-item__text">
            The library has another copy of this song: {item.otherCopies.map((entry) => `${entry.title} (${entry.path})`).join("; ")}
          </span>
        )}
      </div>
      <div className="lib-review-item__actions">
        {!item.backAtPath && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => act(() => libraryApi.locateMissingFile({ fileId: item.fileId }))} title="Point WaveMint at the file where it is now">
            <FolderOpenIcon size={13} /> Locate File…
          </button>
        )}
        {item.current && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onReplace(item.trackId)} title="Choose a different file for this song">
            <UpgradeIcon size={13} /> Replace File…
          </button>
        )}
        {item.current && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onRemove(item)} title="Remove the song from your library (nothing on disk changes; undo from History)">
            Remove from Library
          </button>
        )}
        {item.canForget && !item.backAtPath && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => act(() => libraryApi.forgetMissingFile({ fileId: item.fileId }))}
            title="Forget this leftover reference in WaveMint's database. Nothing on disk changes."
          >
            Forget Reference
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * MP3 genres stored as ID3v1 numbers ("(145)") instead of text: iTunes shows
 * codes above 125 as numbers. The check only reads; the fix is WaveMint's
 * normal Write Tags for those songs (backed up, undoable from History).
 */
function GenreCodes({ onError }) {
  const runJob = useJobRunner();
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [written, setWritten] = useState(null);
  const run = async (start, done) => {
    setBusy(true);
    try {
      const job = await runJob(start);
      if (job.status === "completed") done(job.result);
      else onError(job.error || "That didn't complete.");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const check = () => run(libraryApi.scanNumericGenres(), (result) => (setScan(result), setSure(false)));
  const fix = () =>
    run(libraryApi.storeGenresAsText({ trackIds: scan.trackIds }), (result) => {
      setWritten(result);
      check();
    });
  return (
    <div className="lib-formats__genres">
      <span className="section-label">Genre tags</span>
      <p className="settings-hint">
        Some MP3s store their genre as a number (for example &ldquo;(145)&rdquo; for Anime). iTunes shows numbers above 125 as numbers instead of names.
      </p>
      <div className="lib-edit__actions">
        <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={check}>
          Check Genre Tags
        </button>
      </div>
      {scan && (
        <>
          <p className={scan.shownAsNumbers ? "lib-upgrade__warning" : "lib-managed__done"}>
            {scan.shownAsNumbers ? <WarningIcon size={14} /> : <CheckIcon size={16} />} {formatNumber(scan.checked)} MP3s checked: {formatNumber(scan.numeric)} store the
            genre as a number, {formatNumber(scan.shownAsNumbers)} of them would show as a number in iTunes
            {scan.nonStandard ? ` (${formatNumber(scan.nonStandard)} use a bare number, which isn't standard ID3v2.3)` : ""}.
          </p>
          {scan.numeric > 0 && (
            <>
              <div className="lib-iphone__items">
                {scan.songs.slice(0, 40).map((item) => (
                  <div key={item.trackId} className="lib-iphone__item">
                    <span className={`lib-badge is-name is-${item.itunesShowsNumber ? "warn" : "quiet"}`}>{item.stored}</span>
                    <span className="lib-iphone__item-title">
                      {item.title} · {item.artist}
                    </span>
                    <span className="settings-hint">{item.genre}</span>
                  </div>
                ))}
              </div>
              <label className="lib-edit__bool">
                <input type="checkbox" checked={sure} onChange={(event) => setSure(event.target.checked)} />
                Rewrite the tags of these {formatNumber(scan.numeric)} songs so the genre is stored as text (their audio is untouched; each file is backed up and the change can be
                undone from History)
              </label>
              <div className="lib-edit__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={busy || !sure} onClick={fix}>
                  Store Genres as Text
                </button>
              </div>
            </>
          )}
        </>
      )}
      {written && (
        <p className="settings-hint">
          Rewrote {pluralize(written.written ?? 0, "file")}
          {written.results?.some((item) => !item.ok) ? `; ${pluralize(written.results.filter((item) => !item.ok).length, "file")} couldn't be written` : ""}.
        </p>
      )}
    </div>
  );
}

/** The library by audio format, with the songs of a format one click away. */
function FormatsPanel({ revision, onOpen, onError }) {
  const { data: stats, error } = useLoader(() => libraryApi.getFormatStats(), [revision]);
  const [codec, setCodec] = useState(null);
  const [limit, setLimit] = useState(PAGE);
  const { data: songs } = useLoader(() => (codec !== null ? libraryApi.listTracks({ filters: { codec }, sort: "artist", direction: "asc", limit }) : null), [codec, limit, revision]);
  if (error) return <div className="alert alert--compact">{error}</div>;
  if (!stats) return <p className="settings-hint">Counting…</p>;
  const chosen = stats.formats.find((item) => item.codec === codec);
  const apple = stats.apple;
  const attention = apple.convert || apple.unsupported || apple.missing;
  return (
    <div className="lib-formats">
      <p className="settings-hint">
        The current file of each of the {formatNumber(stats.totalFiles)} songs in your library ({formatBytes(stats.totalBytes)}), by the audio inside it (a .m4a file can
        hold AAC or Apple Lossless). Counted from the library&apos;s scans, so it opens instantly and follows songs being added, replaced or removed.
      </p>
      <table className="lib-formats__table">
        <thead>
          <tr>
            <th scope="col">Format</th>
            <th scope="col" className="is-num">
              Files
            </th>
            <th scope="col" className="is-num">
              Storage
            </th>
            <th scope="col">Library share</th>
          </tr>
        </thead>
        <tbody>
          {stats.formats.map((item) => (
            <tr key={item.codec ?? "unknown"} className={codec === item.codec ? "is-on" : ""}>
              <th scope="row">
                <button
                  type="button"
                  className="btn btn--link"
                  aria-pressed={codec === item.codec}
                  title="Show these songs"
                  onClick={() => {
                    setCodec(codec === item.codec ? null : item.codec);
                    setLimit(PAGE);
                  }}
                >
                  {item.label}
                </button>
                <span className="settings-hint"> {item.extensions.map((entry) => entry.ext).join(", ")}</span>
                {item.missing > 0 && <span className="is-warn"> · {formatNumber(item.missing)} missing</span>}
              </th>
              <td className="is-num">{formatNumber(item.files)}</td>
              <td className="is-num">{formatBytes(item.bytes)}</td>
              <td>
                <div className="lib-formats__share" title={`${percent(item.fileShare)} of files, ${percent(item.byteShare)} of storage`}>
                  <span className="lib-formats__bar">
                    <span style={{ width: `${Math.max(item.byteShare * 100, 0.5)}%` }} />
                  </span>
                  <span className="lib-formats__pct">
                    {percent(item.fileShare)} of files · {percent(item.byteShare)} of storage
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td className="is-num">{formatNumber(stats.totalFiles)}</td>
            <td className="is-num">{formatBytes(stats.totalBytes)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      <p className={attention ? "lib-upgrade__warning" : "lib-managed__done"}>
        {attention ? <WarningIcon size={14} /> : <CheckIcon size={16} />} Ready for iTunes: {formatNumber(apple.direct)} play as they are
        {apple.convert ? `, ${formatNumber(apple.convert)} need a converted copy` : ""}
        {apple.unsupported ? `, ${formatNumber(apple.unsupported)} in a format iTunes can't play` : ""}
        {apple.missing ? `, ${formatNumber(apple.missing)} missing` : ""}.
      </p>
      <p className="settings-hint">
        Also on disk, not counted above: {pluralize(stats.earlierVersions.files, "earlier version")} kept after upgrades or edits ({formatBytes(stats.earlierVersions.bytes)})
        {stats.removedSongs.files ? ` and ${pluralize(stats.removedSongs.files, "file")} of songs removed from the library (${formatBytes(stats.removedSongs.bytes)})` : ""}.
      </p>

      <GenreCodes onError={onError} />

      {chosen && songs && (
        <>
          <span className="section-label">
            {chosen.label} songs ({formatNumber(songs.total)})
          </span>
          <div className="lib-review__list">
            {songs.rows.map((row) => (
              <div key={row.id} className="lib-review-item">
                <Artwork className="lib-review-item__art" hash={row.artwork_hash} size={48} loading="lazy" />
                <div className="lib-review-item__body">
                  <button type="button" className="lib-review-item__open" onClick={() => onOpen(row.id)}>
                    {`${row.title || "Untitled"} — ${row.artist || "Unknown artist"}`}
                  </button>
                  <span className="lib-review-item__text">
                    {row.album || ""}
                    {row.bitrate ? ` · ${row.bitrate} kbps` : ""}
                    {row.size ? ` · ${formatBytes(row.size)}` : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {songs.total > songs.rows.length && (
            <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + PAGE)}>
              Show more ({formatNumber(songs.total - songs.rows.length)})
            </button>
          )}
        </>
      )}
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
  const [changed, setChanged] = useState(0);
  const filters = section === "missing" ? { missingFile: true } : { multipleVersions: true };
  const { data, error } = useLoader(
    () => (["backups", "formats"].includes(section) ? null : libraryApi.listTracks({ filters, sort: "artist", direction: "asc", limit })),
    [section, limit, revision, changed],
  );
  const { data: missingFiles } = useLoader(() => (section === "missing" ? libraryApi.listMissingFiles() : null), [section, revision, changed]);
  // Songs with no file at all (not even a missing one) aren't in the file list.
  const noFile = (data?.rows || []).filter((row) => !row.file_id);
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
              {key === "missing" && (missingFiles?.length ?? status?.fileProblems) > 0 && <span className="lib-tab-count">{formatNumber(missingFiles?.length ?? status.fileProblems)}</span>}
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
              {missingFiles?.map((item) => (
                <MissingFileRow
                  key={item.fileId}
                  item={item}
                  onOpen={setOpenTrack}
                  onReplace={replace}
                  onRemove={(entry) => onRemove([entry.trackId], [{ id: entry.trackId, title: entry.title, artist: entry.artist }])}
                  onChanged={() => setChanged((value) => value + 1)}
                  onError={onError}
                />
              ))}
              {noFile.map((row) => (
                <MissingRow key={row.id} row={row} onOpen={setOpenTrack} onReplace={replace} onRemove={(item) => onRemove([item.id], [item])} />
              ))}
              {missingFiles && !missingFiles.length && !noFile.length && <p className="lib-empty-note">Every file is where WaveMint expects it.</p>}
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

        {section === "formats" && <FormatsPanel revision={revision} onOpen={setOpenTrack} onError={onError} />}

        {section === "versions" && data && data.total > data.rows.length && (
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
