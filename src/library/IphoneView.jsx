import { useState } from "react";
import { formatBytes, formatDate, formatNumber, pluralize } from "./format";
import { CheckIcon, FolderOpenIcon, PhoneIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useJobRunner, useLoader } from "./useLibrary";

const STATUS_LABELS = { new: "New", replace: "Replaced", refresh: "Details changed", problem: "Can't export" };
const STATUS_TONE = { new: "success", replace: "info", refresh: "warn", problem: "error" };

function Guidance() {
  return (
    <section className="panel lib-iphone__guide" aria-labelledby="lib-iphone-guide">
      <span id="lib-iphone-guide" className="section-label">
        Getting the songs onto your iPhone
      </span>
      <ol>
        <li>
          Prepare the songs here. WaveMint writes finished files (your tags and artwork inside) into the export folder and lists what&apos;s new
          or changed in <em>WaveMint Export Report.txt</em>.
        </li>
        <li>
          Add the new files to Apple Music (or iTunes) on this PC: use <strong>Send to Apple Music</strong> below, which copies them into
          Apple&apos;s &ldquo;Automatically Add&rdquo; folder, or add the files or the folder from Apple&apos;s app yourself.
        </li>
        <li>
          For <strong>replaced</strong> songs (an upgrade), delete the old entry in Apple Music first, then add the new file. For songs whose{" "}
          <strong>details changed</strong>, Apple Music keeps its own copy of the details: edit them there, or remove and add the song again.
        </li>
        <li>Playlists are in the export&apos;s Playlists folder as M3U8 files; import them in Apple&apos;s app if it offers playlist import.</li>
        <li>Connect the iPhone and sync it with the Apple Devices app (or iTunes), choosing the music and playlists to sync.</li>
      </ol>
      <p className="settings-hint">
        WaveMint never changes Apple&apos;s library or the iPhone directly, and replacing a file here doesn&apos;t update a song Apple Music has
        already imported. Menu names differ between iTunes and the Apple Music app; WaveMint hasn&apos;t verified them on this PC.
      </p>
    </section>
  );
}

export function IphoneView({ revision, exporting, onChanged, onError }) {
  const { data: setup, reload } = useLoader(() => libraryApi.getExportSetup(), [revision]);
  const { data: lists } = useLoader(() => libraryApi.listPlaylists(), [revision]);
  const { data: genres } = useLoader(() => libraryApi.listGenres(), [revision]);
  const [scopeKind, setScopeKind] = useState("all");
  const [chosenPlaylists, setChosenPlaylists] = useState(new Set());
  const [chosenGenres, setChosenGenres] = useState(new Set());
  const [allPlaylists, setAllPlaylists] = useState(true);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [handed, setHanded] = useState(null);
  const [folder, setFolder] = useState("");
  const runJob = useJobRunner();

  const scope = scopeKind === "all" ? { all: true } : scopeKind === "playlists" ? { playlistIds: [...chosenPlaylists] } : { genres: [...chosenGenres] };
  const act = async (action) => {
    try {
      return await action();
    } catch (error) {
      onError(errorMessage(error));
      return null;
    }
  };

  const chooseRoot = () => act(async () => (await libraryApi.chooseExportRoot()) && (setPreview(null), reload()));
  const runPreview = () => act(async () => setPreview(await libraryApi.previewExport({ scope })));
  const runExport = () =>
    act(async () => {
      setResult(null);
      setHanded(null);
      const job = await runJob(libraryApi.exportForIphone({ scope, allPlaylists }));
      if (job.status === "completed") setResult(job.result);
      else onError(job.error || "Preparing the songs didn't complete.");
      setPreview(null);
      reload();
      onChanged();
    });
  const handOff = () =>
    act(async () => {
      const target = folder || setup.autoAddFolders[0];
      setHanded(await libraryApi.handOffToApple({ exportId: (result || setup.last)?.exportId ?? setup.last?.id, folder: target }));
    });
  const toggle = (setter, value) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  const last = result ? { report: result, createdAt: null } : setup?.last;
  const changed = last?.report?.changedFiles?.length || 0;
  const summary = preview?.summary;
  const scopeEmpty = (scopeKind === "playlists" && !chosenPlaylists.size) || (scopeKind === "genres" && !chosenGenres.size);

  return (
    <div className="lib-iphone">
      <section className="panel lib-merge__intro">
        <PhoneIcon size={22} />
        <div>
          <strong>Prepare for iPhone</strong>
          <p className="settings-hint">
            Keep a folder of finished songs for Apple Music and your iPhone. MP3, AAC and Apple Lossless files are copied as they are; FLAC is
            converted to Apple Lossless (no quality loss). Only new and changed songs are written again.
          </p>
          {setup?.root && (
            <p className="lib-managed__root">
              <span className="lib-source__path" title={setup.root}>
                {setup.root}
              </span>
            </p>
          )}
        </div>
        <div className="lib-merge__intro-actions">
          <button type="button" className={`btn ${setup?.root ? "btn--ghost" : "btn--primary"}`} disabled={exporting} onClick={chooseRoot}>
            {setup?.root ? "Change Folder…" : "Choose Export Folder…"}
          </button>
          {setup?.root && (
            <button type="button" className="btn btn--link" onClick={() => act(() => libraryApi.openExportFolder({}))}>
              <FolderOpenIcon size={14} /> Open Folder
            </button>
          )}
        </div>
      </section>

      {setup?.root && (
        <section className="panel">
          <span className="section-label">Songs to prepare</span>
          <div className="lib-chips" role="group" aria-label="Songs to prepare">
            {[
              ["all", "Whole library"],
              ["playlists", "Playlists"],
              ["genres", "Genres"],
            ].map(([value, label]) => (
              <button key={value} type="button" className={`lib-chip ${scopeKind === value ? "is-on" : ""}`} aria-pressed={scopeKind === value} onClick={() => (setScopeKind(value), setPreview(null))}>
                {label}
              </button>
            ))}
          </div>
          {scopeKind === "playlists" && (
            <div className="lib-iphone__picks">
              {(lists || []).map((item) => (
                <label key={item.id} className="lib-edit__bool">
                  <input type="checkbox" checked={chosenPlaylists.has(item.id)} onChange={() => (toggle(setChosenPlaylists, item.id), setPreview(null))} />
                  {item.name} ({item.count ?? "?"})
                </label>
              ))}
              {lists && !lists.length && <span className="settings-hint">No playlists yet.</span>}
            </div>
          )}
          {scopeKind === "genres" && (
            <div className="lib-iphone__picks">
              {(genres || [])
                .filter((item) => item.name)
                .map((item) => (
                  <label key={item.name} className="lib-edit__bool">
                    <input type="checkbox" checked={chosenGenres.has(item.name)} onChange={() => (toggle(setChosenGenres, item.name), setPreview(null))} />
                    {item.name} ({formatNumber(item.track_count ?? item.count ?? 0)})
                  </label>
                ))}
            </div>
          )}
          <label className="lib-edit__bool">
            <input type="checkbox" checked={allPlaylists} onChange={(event) => setAllPlaylists(event.target.checked)} />
            Write all my playlists as M3U8 files (with the songs that are in the export)
          </label>
          <label className="lib-edit__bool">
            <input
              type="checkbox"
              checked={setup.convertWavAiff}
              onChange={(event) => act(async () => (await libraryApi.updateSettings({ patch: { convertWavAiff: event.target.checked } }), setPreview(null), reload()))}
            />
            Convert WAV and AIFF to Apple Lossless, so tags and artwork go with them
          </label>
          <div className="lib-edit__actions">
            <button type="button" className="btn btn--secondary" disabled={exporting || scopeEmpty} onClick={runPreview}>
              Check What&apos;s Changed
            </button>
            <button type="button" className={`btn btn--primary ${exporting ? "is-loading" : ""}`} disabled={exporting || scopeEmpty} onClick={runExport}>
              Prepare Songs
            </button>
          </div>

          {summary && (
            <>
              <div className="lib-managed__plan">
                <span>
                  <strong>{formatNumber(summary.new)}</strong> new
                </span>
                <span>
                  <strong>{formatNumber(summary.replace)}</strong> replaced
                </span>
                <span>
                  <strong>{formatNumber(summary.refresh)}</strong> details changed
                </span>
                <span>{formatNumber(summary.unchanged)} unchanged</span>
                {summary.conversions > 0 && <span>{pluralize(summary.conversions, "conversion")} to Apple Lossless</span>}
                <span>
                  {formatBytes(summary.bytes)} to write{summary.freeBytes !== null ? ` · ${formatBytes(summary.freeBytes)} free` : ""}
                </span>
                {summary.problems > 0 && <span className="is-warn">{pluralize(summary.problems, "song")} can&apos;t be exported</span>}
                {summary.removed > 0 && <span>{pluralize(summary.removed, "song")} exported before but not selected now (left in place)</span>}
              </div>
              <div className="lib-iphone__items">
                {preview.items.slice(0, 60).map((item) => (
                  <div key={item.trackId} className="lib-iphone__item">
                    <span className={`lib-badge is-name is-${STATUS_TONE[item.status] || "quiet"}`}>{STATUS_LABELS[item.status] || item.status}</span>
                    <span className="lib-iphone__item-title">
                      {item.title} · {item.artist}
                    </span>
                    <span className="settings-hint">
                      {item.action === "convert" ? "→ Apple Lossless" : (item.format || "").toUpperCase()}
                      {item.problems.length ? ` · ${item.problems.join(", ")}` : item.warnings.length ? ` · ${item.warnings.join(", ")}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {last?.report && (
        <section className="panel">
          <span className="section-label">Last preparation{last.createdAt ? ` · ${formatDate(last.createdAt)}` : ""}</span>
          <p className="lib-managed__done">
            <CheckIcon size={16} /> {pluralize(last.report.new || 0, "new song")}, {last.report.replace || 0} replaced, {last.report.refresh || 0} with
            changed details, {last.report.unchanged || 0} unchanged.
          </p>
          {last.report.failed?.length > 0 && (
            <p className="lib-upgrade__warning is-strong">
              <WarningIcon size={14} /> {pluralize(last.report.failed.length, "song")} couldn&apos;t be written: {last.report.failed.slice(0, 3).map((item) => item.title).join(", ")}
            </p>
          )}
          <div className="lib-edit__actions lib-iphone__handoff">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(() => libraryApi.openExportFolder({ report: true }))}>
              Open Report
            </button>
            {changed > 0 && (
              <>
                {setup?.autoAddFolders?.length > 0 ? (
                  <select className="field" aria-label="Apple's Automatically Add folder" value={folder || setup.autoAddFolders[0]} onChange={(event) => setFolder(event.target.value)}>
                    {setup.autoAddFolders.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="settings-hint">Apple&apos;s &ldquo;Automatically Add&rdquo; folder wasn&apos;t found.</span>
                )}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => act(async () => (await libraryApi.chooseAutoAddFolder()) && reload())}>
                  Choose…
                </button>
                <button type="button" className="btn btn--primary btn--sm" disabled={!setup?.autoAddFolders?.length && !folder} onClick={handOff}>
                  Send {pluralize(changed, "File")} to Apple Music
                </button>
              </>
            )}
          </div>
          {handed && (
            <p className="settings-hint">
              Copied {pluralize(handed.copied, "file")} into {handed.folder}. Apple&apos;s app adds them when it&apos;s running
              {handed.failures.length ? `; ${handed.failures.length} couldn't be copied` : ""}.
            </p>
          )}
        </section>
      )}

      <Guidance />
    </div>
  );
}
