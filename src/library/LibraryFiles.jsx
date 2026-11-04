import { useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { Artwork } from "./Artwork";
import { Disclosure } from "./Disclosure";
import { formatBytes, formatDate, formatNumber, pluralize } from "./format";
import { CheckIcon, FolderOpenIcon, RefreshIcon, UpgradeIcon, WarningIcon } from "./icons";
import { VersionHistory } from "./TrackDetail";
import { errorMessage, libraryApi, useJobRunner, useLoader } from "./useLibrary";

// The library's files: what's wrong with them (Review → Diagnostics), what
// they're made of (Library Tools → Storage → Audio formats, with the genre
// tag check) and the earlier versions kept after upgrades and edits.

const PAGE = 100;

// What each kind of file problem means, in a word and in a sentence.
const PROBLEM_KINDS = {
  missing: ["Missing", "is-missing"],
  moved: ["Moved or renamed", "is-missing"],
  drive: ["Drive not connected", "is-warn"],
  unreadable: ["Unreadable", "is-error"],
  back: ["Back in place", "is-success"],
};

const ACTION_HELP = {
  locate: "Point WaveMint at the file where it is now. The song keeps its details, playlists, history and iTunes entry.",
  replace: "Choose a different audio file for this song (Upgrade Track). The song keeps its details and playlists.",
  remove: "Remove the song from WaveMint. No file on disk changes, and you can undo it from History.",
  forget: "Forget this leftover entry in WaveMint's database. No file is deleted, and no song in your library changes.",
};

/** A song with no file at all (not even a missing one). */
function NoFileRow({ row, onOpen, onReplace, onRemove }) {
  return (
    <div className="lib-review-item">
      <Artwork className="lib-review-item__art" hash={row.artwork_hash} size={64} loading="lazy" />
      <div className="lib-review-item__body">
        <div className="lib-review-item__title">
          <span className="lib-badge is-missing">No file</span>
          <button type="button" className="lib-review-item__open" onClick={() => onOpen(row.id)}>
            {`${row.title || "Untitled"} — ${row.artist || "Unknown artist"}`}
          </button>
        </div>
        <span className="lib-review-item__text">This song has no audio file in WaveMint. Choose one, or remove the song.</span>
      </div>
      <div className="lib-review-item__actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => onReplace(row.id)} title={ACTION_HELP.replace}>
          <UpgradeIcon size={13} /> Choose File…
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRemove(row)} title={ACTION_HELP.remove}>
          Remove from Library
        </button>
      </div>
    </div>
  );
}

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
  const leftover = !item.current;
  const [label, tone] = leftover ? [item.kind === "earlier" ? "Earlier version" : "Leftover", "is-quiet"] : PROBLEM_KINDS[item.kind] || PROBLEM_KINDS.missing;
  return (
    <div className={`lib-review-item lib-health-missing ${leftover ? "is-quiet" : ""}`}>
      <div className="lib-review-item__body">
        <div className="lib-review-item__title">
          <span className={`lib-badge ${tone}`}>{label}</span>
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
        {!leftover && item.elsewhere.length > 0 && (
          <span className="lib-review-item__text">A file with the same name exists: {item.elsewhere.map((entry) => entry.path).join("; ")}</span>
        )}
        {!leftover && item.otherCopies.length > 0 && (
          <span className="lib-review-item__text">
            The library has another copy of this song: {item.otherCopies.map((entry) => `${entry.title} (${entry.path})`).join("; ")}
          </span>
        )}
      </div>
      <div className="lib-review-item__actions">
        {!leftover && !item.backAtPath && (
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => act(() => libraryApi.locateMissingFile({ fileId: item.fileId }))} title={ACTION_HELP.locate}>
            <FolderOpenIcon size={13} /> Locate File…
          </button>
        )}
        {item.current && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onReplace(item.trackId)} title={ACTION_HELP.replace}>
            <UpgradeIcon size={13} /> Replace File…
          </button>
        )}
        {item.current && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onRemove(item)} title={ACTION_HELP.remove}>
            Remove from Library
          </button>
        )}
        {item.canForget && !item.backAtPath && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(() => libraryApi.forgetMissingFile({ fileId: item.fileId }))} title={ACTION_HELP.forget}>
            Forget Reference
          </button>
        )}
      </div>
    </div>
  );
}

const percent = (share) => `${(share * 100).toFixed(share > 0 && share < 0.001 ? 2 : 1)}%`;

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
export function FormatsPanel({ revision, onOpen, onError }) {
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
 * Review → Diagnostics: songs whose file is missing, moved, unreadable or
 * absent, each with the safe repairs, and (apart, collapsed) leftover
 * references: files of removed or merged songs and earlier versions that
 * are gone. Leftovers aren't problems; forgetting them only tidies the
 * database. `onOpen` opens a song beside the list.
 */
export function DiagnosticsPanel({ revision, scanning, onOpen, onReplace, onRemove, onChanged, onError }) {
  const [tick, setTick] = useState(0);
  const [forgetting, setForgetting] = useState(false);
  const { data: missingFiles, loading } = useLoader(() => libraryApi.listMissingFiles(), [revision, tick]);
  const { data: noFileData } = useLoader(() => libraryApi.listTracks({ filters: { missingFile: true }, sort: "artist", direction: "asc", limit: 500 }), [revision, tick]);
  const noFile = (noFileData?.rows || []).filter((row) => !row.file_id);
  const changed = () => {
    setTick((value) => value + 1);
    onChanged?.();
  };

  const problems = (missingFiles || []).filter((item) => item.current);
  const leftovers = (missingFiles || []).filter((item) => !item.current);
  const rescan = () => libraryApi.scanSources({}).catch((err) => onError(errorMessage(err, "The scan couldn't start.")));
  const forgetAll = async () => {
    setForgetting(true);
    try {
      const result = await libraryApi.forgetLeftoverReferences({ fileIds: leftovers.filter((item) => item.canForget && !item.backAtPath).map((item) => item.fileId) });
      if (result.skipped?.length) onError(`${pluralize(result.skipped.length, "reference")} couldn't be forgotten: ${result.skipped[0].reason}`);
      changed();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setForgetting(false);
    }
  };
  const rowProps = { onOpen, onReplace, onRemove: (entry) => onRemove([entry.trackId], [{ id: entry.trackId, title: entry.title, artist: entry.artist }]), onChanged: changed, onError };

  if (!missingFiles) return <div className="lib-loading">{loading ? "Checking your files…" : ""}</div>;

  return (
    <div className="lib-diagnostics">
      <div className="lib-toolbar">
        <span className="settings-hint">
          Songs that can&apos;t play because their file was moved, renamed or deleted outside WaveMint, can&apos;t be read, or is on a drive that isn&apos;t connected.
        </span>
        <div className="lib-toolbar__actions">
          <button type="button" className={`btn btn--ghost btn--sm ${scanning ? "is-loading" : ""}`} disabled={scanning} onClick={rescan} title="Look for added, changed and missing files in your library folders">
            <RefreshIcon size={14} /> Rescan Library Folders
          </button>
        </div>
      </div>

      {problems.length + noFile.length === 0 ? (
        <div className="lib-review-empty">
          <CheckIcon size={20} />
          <div>
            <strong>Every song&apos;s file is where WaveMint expects it.</strong>
            <span>Nothing needs fixing.</span>
          </div>
        </div>
      ) : (
        <>
          {problems.some((item) => item.kind === "moved") && (
            <p className="settings-hint lib-diagnostics__tip">
              <WarningIcon size={13} /> Locate a moved file before rescanning: a rescan would add it as a new song, without its history, playlists or iTunes entry.
            </p>
          )}
          <div className="lib-review__list">
            {problems.map((item) => (
              <MissingFileRow key={item.fileId} item={item} {...rowProps} />
            ))}
            {noFile.map((row) => (
              <NoFileRow key={row.id} row={row} onOpen={onOpen} onReplace={onReplace} onRemove={(entry) => onRemove([entry.id], [entry])} />
            ))}
          </div>
        </>
      )}

      {leftovers.length > 0 && (
        <Disclosure label="Leftover references" hint={`${formatNumber(leftovers.length)} · not a problem`} className="lib-diagnostics__leftovers">
          <p className="settings-hint">
            Files WaveMint once knew about that no longer belong to a song in your library: songs you removed or merged, and earlier versions whose files are gone. They
            don&apos;t affect playback or iTunes. Forgetting them only tidies WaveMint&apos;s database; no file is deleted.
          </p>
          <div className="lib-edit__actions">
            <button type="button" className={`btn btn--secondary btn--sm ${forgetting ? "is-loading" : ""}`} disabled={forgetting} onClick={forgetAll} title={ACTION_HELP.forget}>
              Forget All ({formatNumber(leftovers.length)})
            </button>
          </div>
          <div className="lib-review__list">
            {leftovers.map((item) => (
              <MissingFileRow key={item.fileId} item={item} {...rowProps} />
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** Library Tools → Storage → Earlier versions: songs with files kept after an upgrade or edit. */
export function EarlierVersionsPanel({ revision, onOpen, onRestore, onError }) {
  const [limit, setLimit] = useState(PAGE);
  const { data } = useLoader(() => libraryApi.listTracks({ filters: { multipleVersions: true }, sort: "artist", direction: "asc", limit }), [limit, revision]);
  return (
    <div className="lib-review">
      <p className="settings-hint">
        Earlier files of a song are kept after an upgrade or an audio edit, so the change can be taken back. Restoring one compares it with the current file first and
        asks before anything changes. How long they&apos;re kept is set under Disk usage.
      </p>
      <div className="lib-review__list">
        {data?.rows.map((row) => (
          <VersionsRow key={row.id} row={row} onOpen={onOpen} onRestore={onRestore} onError={onError} />
        ))}
        {data && !data.rows.length && <p className="lib-empty-note">No song has earlier versions.</p>}
      </div>
      {data && data.total > data.rows.length && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + PAGE)}>
          Show more ({formatNumber(data.total - data.rows.length)})
        </button>
      )}
    </div>
  );
}
