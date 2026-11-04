import { useState } from "react";
import { AppleFilesFlow } from "./AppleFilesFlow";
import { AppleMigration } from "./AppleMigration";
import { Disclosure } from "./Disclosure";
import { formatBytes, formatDate, formatNumber, pluralize } from "./format";
import { CheckIcon, PhoneIcon, RefreshIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useJobRunner, useLoader } from "./useLibrary";

const KIND_LABELS = {
  add: "New",
  adopt: "Already in iTunes",
  readd: "Removed from iTunes",
  metadata: "Details changed",
  replacement: "File changed",
  relocate: "Moved or replaced",
  relink: "iTunes points elsewhere",
  drift: "Edited in iTunes",
  remove: "Leaves WaveMint",
  blocked: "Can't sync",
  waiting: "Not saved to file yet",
};
const KIND_TONE = { add: "success", adopt: "info", readd: "warn", metadata: "info", replacement: "info", relocate: "info", relink: "warn", drift: "warn", remove: "error", blocked: "error", waiting: "quiet" };
const PHASES = { connecting: "Connecting to iTunes", reading: "Reading the iTunes library", files: "Converting files iTunes can't play", adding: "Adding songs", updating: "Updating songs", relinking: "Relinking songs", removing: "Removing songs", playlists: "Syncing playlists", exporting: "Converting files" };
const NEEDS_TEXT = {
  removal: "removal needs your go-ahead",
  recreate: "iTunes can't re-point this entry: it would be replaced (rating, plays and playlists carried over)",
  conflict: "details were edited in iTunes",
  bulk: "part of an unusually large batch",
  retry: "failed several times",
};

function Stat({ value, label, tone }) {
  return (
    <span className={tone ? `is-${tone}` : ""}>
      <strong>{formatNumber(value ?? 0)}</strong> {label}
    </span>
  );
}

function summarize(report) {
  const parts = [
    [report.added, "added"],
    [report.adopted, "matched"],
    [report.updated, "updated"],
    [report.relinked, "relinked"],
    [report.recreated, "replaced"],
    [report.removed, "removed"],
    [report.unmanaged, "no longer managed"],
    [report.playlists, report.playlists === 1 ? "playlist" : "playlists"],
  ].filter(([count]) => count > 0);
  return parts.length ? parts.map(([count, word]) => `${formatNumber(count)} ${word}`).join(", ") : "Everything was already up to date.";
}

/** The result of verifying iTunes against WaveMint. */
function Verification({ result }) {
  if (!result) return null;
  return result.ok && result.checked > 0 ? (
    <p className="lib-managed__done">
      <CheckIcon size={16} /> Verified: {pluralize(result.checked, "song")} in iTunes, each playing its WaveMint Library file
      {result.converted ? ` (${formatNumber(result.converted)} through a converted copy)` : ""}, with matching details and artwork. No second copy of your library
      exists{result.cache?.files ? ` (the compatibility cache holds ${pluralize(result.cache.files, "converted file")}, ${formatBytes(result.cache.bytes)})` : ""}.
    </p>
  ) : (
    <p className="lib-upgrade__warning is-strong">
      <WarningIcon size={14} /> {pluralize(result.problemCount, "problem")}:{" "}
      {result.problems
        .slice(0, 4)
        .map((item) => (item.title || item.playlist ? `${item.title || item.playlist} (${item.problem})` : item.problem))
        .join("; ")}
    </p>
  );
}

/** What a sync actually did, in numbers, including what it couldn't do. */
function SyncResult({ result }) {
  if (!result) return null;
  const good = result.status === "completed" && !result.skippedCount;
  const headline = ["waiting", "blocked", "stopped", "nothing"].includes(result.status)
    ? result.reason
    : `${summarize(result)}${result.review ? ` · ${pluralize(result.review, "change")} waiting for your decision` : ""}`;
  return (
    <div className={good ? "lib-managed__done" : "lib-upgrade__warning"} role="status">
      <p>
        {good ? <CheckIcon size={16} /> : <WarningIcon size={14} />} {headline}
      </p>
      {result.library && (
        <p className="settings-hint">
          iTunes library {result.library.id} ({result.library.bridge === "itunes-com" ? "the real iTunes, through COM" : `bridge: ${result.library.bridge}`}) · {pluralize(result.library.songsBefore, "song")} before this
          sync{result.requested ? ` · ${result.requested} chosen` : ""} · {formatNumber(result.added)} added · {formatNumber(result.failed.length)} failed · {formatNumber(result.skippedCount || 0)} skipped
        </p>
      )}
      {result.failed?.length > 0 && (
        <p className="settings-hint">
          Failed:{" "}
          {result.failed
            .slice(0, 5)
            .map((item) => `${item.title || item.playlist} (${item.error})`)
            .join("; ")}
        </p>
      )}
      {result.skippedCount > 0 && (
        <p className="settings-hint">
          Skipped:{" "}
          {result.skipped
            .slice(0, 5)
            .map((item) => `${item.title} (${item.reason})`)
            .join("; ")}
          {result.skippedCount > 5 ? ` and ${formatNumber(result.skippedCount - 5)} more` : ""}
        </p>
      )}
    </div>
  );
}

/** The classic iTunes synchronization manager: iTunes plays the WaveMint Library's own files. */
export function AppleSyncPanel({ revision, running, onChanged, onError, onNavigate }) {
  const { data: status, reload } = useLoader(() => libraryApi.getAppleSync(), [revision]);
  const { data: detected, reload: redetect } = useLoader(() => libraryApi.detectApple(), []);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [verification, setVerification] = useState(null);
  const [confirm, setConfirm] = useState({});
  const runJob = useJobRunner();
  const activeJob = running.find((job) => job.kind.startsWith("apple-"));
  const busy = !!activeJob;

  const act = async (action) => {
    try {
      return await action();
    } catch (error) {
      onError(errorMessage(error));
      return null;
    }
  };
  const setting = (patch) => act(async () => (await libraryApi.updateSettings({ patch }), reload(), onChanged()));
  const choose = (key) => (event) => setConfirm((current) => ({ ...current, [key]: event.target.checked }));
  const job = (start, onDone) =>
    act(async () => {
      const done = await runJob(start);
      if (done.status === "completed") await onDone(done.result);
      else onError(done.error || "That didn't complete.");
      reload();
      onChanged();
    });

  const check = () => job(libraryApi.previewAppleSync(), (value) => (setResult(null), setPreview(value), redetect()));
  const verify = () => job(libraryApi.verifyAppleLibrary(), setVerification);
  const finished = (value) => {
    setResult(value);
    setConfirm({});
    if (["completed", "partial"].includes(value?.status)) setPreview(null);
  };
  // Verification only follows a test that really added songs.
  const testSync = () => job(libraryApi.appleTestSync({ count: 5 }), async (value) => (finished(value), value.added + value.adopted > 0 && verify()));
  const sync = (extra = {}, trackIds) => job(libraryApi.runAppleSync({ confirm: { ...confirm, ...extra }, ...(trackIds ? { trackIds } : {}) }), finished);
  const retry = () => act(async () => (await libraryApi.retryAppleFailures({}), reload()));

  const counts = preview?.counts || status?.counts;
  const items = preview?.items || status?.review || [];
  const needing = items.filter((item) => item.needs?.length);
  const needs = (kind) => needing.some((item) => item.needs.includes(kind));
  const progress = activeJob?.progress;
  const firstSync = status && !status.baselineDone;
  const emptyItunes = preview?.connected && preview.library?.unmanaged === 0;
  const cache = status?.cache;
  const libraryProblem = status?.libraryCheck && !status.libraryCheck.ok ? status.libraryCheck.reason : null;
  const canWrite = !libraryProblem;

  return (
    <div className="lib-iphone">
      <section className="panel lib-merge__intro">
        <PhoneIcon size={22} />
        <div>
          <strong>Apple Library Sync</strong>
          <p className="settings-hint">
            iTunes plays your WaveMint Library&apos;s own files: one copy of each song on this PC, managed by WaveMint. What you add, edit, upgrade, reorganize or remove here is
            brought into iTunes; then you sync your iPhone in iTunes as usual. Nothing in iTunes that WaveMint didn&apos;t add is ever changed, and syncing never deletes or moves
            a music file.
          </p>
          <p className="lib-managed__root">
            <span className="lib-source__path" title={status?.libraryRoot || ""}>
              WaveMint Library: {status?.libraryRoot || status?.libraryCheck?.roots?.join(", ") || "not set up yet"}
            </span>
            <span className="settings-hint"> · Sync mode: Direct reference</span>
          </p>
          <p className="settings-hint">
            {status ? `${formatNumber((counts?.managed || 0) + (counts?.new || 0) + (counts?.metadata || 0) + (counts?.replacements || 0) + (counts?.unchanged || 0) + (counts?.blocked || 0) + (counts?.waiting || 0) + (counts?.drift || 0))} songs` : ""}
            {status?.profileDir ? ` · WaveMint profile: ${status.profileDir}` : ""}
            {status?.bridge ? ` · iTunes bridge: ${status.bridge === "itunes-com" ? "real iTunes (COM)" : status.bridge}` : ""}
          </p>
          {libraryProblem && (
            <p className="lib-upgrade__warning is-strong">
              <WarningIcon size={14} /> {libraryProblem} Syncing is turned off.
            </p>
          )}
        </div>
      </section>

      {(status?.organizeDetected || status?.deleteRemovesFiles || status?.copyDetected) && (
        <section className="panel">
          {status.organizeDetected && (
            <p className="lib-upgrade__warning is-strong">
              <WarningIcon size={14} /> iTunes moved a file out of your WaveMint Library. Turn off &ldquo;Keep iTunes Media folder organized&rdquo; in iTunes, then rescan the
              library (Sources) before syncing again.
            </p>
          )}
          {status.deleteRemovesFiles && (
            <p className="lib-upgrade__warning is-strong">
              <WarningIcon size={14} /> iTunes deleted a file when its entry was removed. WaveMint put it back and doesn&apos;t remove iTunes entries anymore.
            </p>
          )}
          {status.copyDetected && (
            <p className="lib-upgrade__warning">
              <WarningIcon size={14} /> iTunes made its own copy of some songs. Turn off &ldquo;Copy files to iTunes Media folder when adding to library&rdquo;, then sync to point
              those entries back at your library files.
            </p>
          )}
        </section>
      )}

      <section className="panel">
        <span className="section-label">iTunes</span>
        <div className="lib-managed__plan">
          <span>
            {detected?.itunesInstalled ? (
              <>
                <CheckIcon size={14} /> Classic iTunes{status?.library?.version ? ` ${status.library.version}` : ""} ·{" "}
                {detected.itunesRunning ? "running" : "not running (it opens when you sync)"}
                {preview?.connected ? ` · connected, ${pluralize(preview.library.fileSongs, "song")} in its library` : ""}
              </>
            ) : detected ? (
              <>
                <WarningIcon size={14} /> Classic iTunes wasn&apos;t found{detected.appleMusicInstalled ? ". The Apple Music app is installed: see below." : "."}
              </>
            ) : (
              "Looking for iTunes…"
            )}
          </span>
          <button type="button" className="btn btn--link" onClick={redetect}>
            <RefreshIcon size={14} /> Check Again
          </button>
        </div>
        <p className="settings-hint">
          In iTunes (Edit → Preferences → Advanced) both &ldquo;Keep iTunes Media folder organized&rdquo; and &ldquo;Copy files to iTunes Media folder when adding to library&rdquo; must
          be <strong>off</strong>, so iTunes plays your files where they are. iTunes doesn&apos;t let other programs read these settings; WaveMint checks the first songs it adds and
          stops if iTunes copies or moves them.
        </p>
        <label className="lib-edit__bool">
          <input type="checkbox" checked={!!status?.setupConfirmed} onChange={(event) => act(async () => (await libraryApi.confirmAppleSetup({ confirmed: event.target.checked }), reload()))} />
          Both settings are off in iTunes
        </label>
        <div className="lib-edit__actions">
          <label className="lib-edit__bool">
            <input type="checkbox" checked={status?.autoSync || false} disabled={!status?.baselineDone} onChange={(event) => setting({ appleAutoSync: event.target.checked })} />
            Sync automatically when I save changes (while iTunes is open; changes wait for it otherwise)
          </label>
        </div>
        {!status?.baselineDone && <p className="settings-hint">Automatic sync becomes available after the first full sync.</p>}
        <label className="lib-edit__bool">
          When a song leaves WaveMint:{" "}
          <select className="field" value={status?.removalPolicy || "confirm"} onChange={(event) => setting({ appleRemovalPolicy: event.target.value })}>
            <option value="confirm">Ask me before removing it from iTunes</option>
            <option value="auto">Remove it from iTunes (small batches only)</option>
            <option value="keep">Leave it in iTunes and stop managing it</option>
          </select>
        </label>
        <p className="settings-hint">Removing a song from iTunes only removes its iTunes entry. The music file stays in your WaveMint Library.</p>
      </section>

      {firstSync && (
        <section className="panel lib-iphone__guide">
          <span className="section-label">First sync</span>
          <ol>
            <li>
              <strong>Check iTunes.</strong>{" "}
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={check}>
                Check What&apos;s Changed
              </button>{" "}
              {preview?.connected &&
                (emptyItunes ? (
                  <span className="settings-hint">
                    <CheckIcon size={13} /> iTunes has no songs WaveMint doesn&apos;t manage: ready.
                  </span>
                ) : (
                  <span className="settings-hint is-warn">iTunes already has {pluralize(preview.library.unmanaged, "song")}: use the guided migration below.</span>
                ))}
            </li>
            <li>
              <strong>Confirm the two iTunes settings</strong> above are off.
            </li>
            <li>
              <strong>Test with a few songs.</strong>{" "}
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy || !canWrite || !status.setupConfirmed || !emptyItunes} onClick={testSync}>
                Sync 5 Songs as a Test
              </button>{" "}
              <span className="settings-hint">Then look at them in iTunes: they should play, show their artwork and live in your WaveMint Library folder.</span>
            </li>
            <li>
              <strong>Sync everything.</strong>{" "}
              <button type="button" className="btn btn--primary btn--sm" disabled={busy || !canWrite || !status.setupConfirmed || !emptyItunes} onClick={() => sync({ baseline: true })}>
                Sync {counts ? pluralize(counts.new + (counts.managed || 0), "Song") : "All Songs"}
              </button>
            </li>
          </ol>
          {!status.setupConfirmed && <p className="settings-hint">Confirm the iTunes settings first.</p>}
        </section>
      )}

      <section className="panel">
        <span className="section-label">Status</span>
        {counts ? (
          <div className="lib-managed__plan">
            <Stat value={counts.managed} label="synced songs" />
            <Stat value={counts.new} label="to add" tone={counts.new ? "success" : ""} />
            <Stat value={counts.metadata} label="detail updates" />
            <Stat value={counts.replacements} label="moved or replaced files" />
            <Stat value={counts.removals} label="pending removals" tone={counts.removals ? "warn" : ""} />
            {counts.waiting > 0 && <Stat value={counts.waiting} label="waiting to be saved to their files" />}
            {counts.drift > 0 && <Stat value={counts.drift} label="edited in iTunes" tone="warn" />}
            {counts.blocked > 0 && <Stat value={counts.blocked} label="can't sync" tone="warn" />}
            <span>{formatNumber(counts.unchanged)} unchanged</span>
            {counts.playlistChanges > 0 && <Stat value={counts.playlistChanges} label="playlist changes" />}
            {status?.failed?.length > 0 && <Stat value={status.failed.length} label="failed" tone="warn" />}
          </div>
        ) : (
          <p className="settings-hint">Counting…</p>
        )}
        {(counts?.converted > 0 || cache?.files > 0) && (
          <p className="settings-hint">
            {pluralize(counts?.converted || 0, "song")} in a format iTunes can&apos;t play {counts?.converted === 1 ? "is" : "are"} played through a converted Apple Lossless copy.
            Compatibility cache: {cache.root} · {pluralize(cache.files, "file")}, {formatBytes(cache.bytes)}.
          </p>
        )}
        <p className="settings-hint">
          {status?.lastSyncAt ? `Last successful sync: ${formatDate(status.lastSyncAt)}` : "Not synced yet"}
          {status?.dirty ? " · changes are waiting to sync" : ""}
          {preview ? " · includes a fresh look at iTunes" : " · from WaveMint's saved state (Check What's Changed also looks at iTunes)"}
        </p>

        {busy && (
          <p className="lib-managed__done" role="status">
            <RefreshIcon size={16} /> {activeJob.label}
            {progress ? ` — ${PHASES[progress.phase] || "working"}` : ""}
            {progress?.total ? `: ${formatNumber(progress.done ?? 0)} of ${formatNumber(progress.total)}` : ""}
            {progress?.current ? ` · ${progress.current}` : ""}
          </p>
        )}

        {!firstSync && (
          <div className="lib-edit__actions">
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={check}>
              Check What&apos;s Changed
            </button>
            <button type="button" className={`btn btn--primary ${activeJob?.kind === "apple-sync" ? "is-loading" : ""}`} disabled={busy || !canWrite} onClick={() => sync()}>
              Sync with iTunes
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={verify}>
              Verify iTunes
            </button>
            {status?.failed?.length > 0 && (
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={retry}>
                Retry Failed Songs
              </button>
            )}
          </div>
        )}

        {preview && !preview.connected && <p className="lib-upgrade__warning">{preview.reason}</p>}
        {preview?.newLibrary && (
          <label className="lib-edit__bool">
            <input type="checkbox" checked={!!confirm.newLibrary} onChange={choose("newLibrary")} />
            iTunes is using a different library than the last sync — sync into this one anyway
          </label>
        )}

        {needing.length > 0 && (
          <div className="lib-iphone__confirm">
            <span className="section-label">Needs your decision</span>
            {needs("removal") && (
              <label className="lib-edit__bool">
                <input type="checkbox" checked={!!confirm.removals} onChange={choose("removals")} />
                Remove {pluralize(needing.filter((item) => item.needs.includes("removal")).length, "song")} from iTunes (no longer in your collection; the files stay)
              </label>
            )}
            {needs("recreate") && (
              <label className="lib-edit__bool">
                <input type="checkbox" checked={!!confirm.recreate} onChange={choose("recreate")} />
                Replace {pluralize(needing.filter((item) => item.needs.includes("recreate")).length, "iTunes entry", "iTunes entries")}: this iTunes can&apos;t point an entry at a
                new file, so a new entry is made with the rating, play history and playlists carried over
              </label>
            )}
            {needs("conflict") && (
              <label className="lib-edit__bool">
                <input type="checkbox" checked={!!confirm.conflicts} onChange={choose("conflicts")} />
                Overwrite details edited in iTunes with WaveMint&apos;s ({pluralize(needing.filter((item) => item.needs.includes("conflict")).length, "song")})
              </label>
            )}
            {needs("bulk") && (
              <label className="lib-edit__bool">
                <input type="checkbox" checked={!!confirm.bulk} onChange={choose("bulk")} />
                Yes, I expect this many changes (more than {counts?.bulkThreshold ?? 5} removals or replacements)
              </label>
            )}
            {needs("retry") && (
              <label className="lib-edit__bool">
                <input type="checkbox" checked={!!confirm.retry} onChange={choose("retry")} />
                Try again the songs that failed several times
              </label>
            )}
            <div className="lib-edit__actions">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={busy || !canWrite}
                onClick={() => sync({}, [...new Set(needing.map((item) => item.trackId))])}
                title="Sync only the songs listed here, with the choices above; nothing else is added or changed"
              >
                Apply to These {pluralize(new Set(needing.map((item) => item.trackId)).size, "Song")} Only
              </button>
            </div>
          </div>
        )}

        {items.length > 0 && (
          <div className="lib-iphone__items">
            {items.slice(0, 80).map((item) => (
              <div key={`${item.kind}-${item.trackId}`} className="lib-iphone__item">
                <span className={`lib-badge is-name is-${KIND_TONE[item.kind] || "quiet"}`}>{KIND_LABELS[item.kind] || item.kind}</span>
                <span className="lib-iphone__item-title">
                  {item.title} · {item.artist}
                </span>
                <span className="settings-hint">{item.needs?.length ? item.needs.map((need) => NEEDS_TEXT[need]).filter(Boolean).join("; ") : item.reason || ""}</span>
              </div>
            ))}
          </div>
        )}
        {preview?.playlists?.length > 0 && (
          <p className="settings-hint">
            Playlists:{" "}
            {preview.playlists
              .map((item) => `${item.kind} “${item.name}” (${pluralize(item.songs, "song")})`)
              .slice(0, 6)
              .join(", ")}
          </p>
        )}

        <SyncResult result={result} />
        <Verification result={verification} />
        {status?.failed?.length > 0 && (
          <div className="lib-iphone__items">
            {status.failed.slice(0, 20).map((item) => (
              <div key={item.trackId} className="lib-iphone__item">
                <span className="lib-badge is-name is-error">Failed</span>
                <span className="lib-iphone__item-title">{item.title}</span>
                <span className="settings-hint">{item.error}</span>
              </div>
            ))}
          </div>
        )}
        <p className="settings-hint">After syncing, connect your iPhone and sync it in iTunes (choose the music or playlists to sync). WaveMint never writes to the iPhone.</p>
      </section>

      <Disclosure
        label="Guided migration of an iTunes library that already has songs"
        hint="only needed if iTunes isn't empty"
        defaultOpen={!!preview?.needsMigration}
      >
        <AppleMigration revision={revision} running={running} status={status} onChanged={() => (reload(), onChanged())} onError={onError} />
      </Disclosure>

      <Disclosure label="Portable copy of the library" hint="optional, not needed for iTunes">
        <p className="settings-hint">
          A complete copy of the library in another folder or drive (for another device or a backup), with your tags and artwork written in. iTunes sync doesn&apos;t use it.
        </p>
        <AppleFilesFlow revision={revision} exporting={running.some((item) => item.kind === "export")} onChanged={onChanged} onError={onError} />
      </Disclosure>

      <Disclosure label="Apple Music app (Windows)" hint="files only">
        <p className="settings-hint">
          The newer Apple Music app for Windows has no automation interface WaveMint can rely on, so it can&apos;t be updated, replaced or cleaned up automatically. If you use
          it instead of iTunes, WaveMint keeps a portable copy up to date and you add the files yourself.
        </p>
        <button type="button" className="btn btn--ghost" onClick={() => act(async () => (await setting({ appleDestination: "files" }), onNavigate?.("iphone")))}>
          Use the Apple Music app instead
        </button>
      </Disclosure>
    </div>
  );
}
