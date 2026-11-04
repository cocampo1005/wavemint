import { useState } from "react";
import { formatDate, formatNumber, pluralize } from "./format";
import { CheckIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useJobRunner } from "./useLibrary";

const label = (entry) => `${entry.name || "(untitled)"} · ${entry.artist || "Unknown artist"}${entry.album ? ` · ${entry.album}` : ""}`;

/**
 * The one-time migration of an existing iTunes library: compare, back up,
 * preview, migrate, verify, then (separately) clean up. Nothing is deleted
 * before the last step.
 */
export function AppleMigration({ running, status, onChanged, onError }) {
  const [analysis, setAnalysis] = useState(null);
  const [choices, setChoices] = useState({});
  const [dry, setDry] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [verification, setVerification] = useState(null);
  const [backupAck, setBackupAck] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [understand, setUnderstand] = useState(false);
  const [cleaned, setCleaned] = useState(null);
  const runJob = useJobRunner();
  const busy = running.some((job) => job.kind.startsWith("apple-"));
  const backup = status?.backup;

  const act = async (action) => {
    try {
      return await action();
    } catch (error) {
      onError(errorMessage(error));
      return null;
    }
  };
  const job = (start, onDone) =>
    act(async () => {
      const done = await runJob(start);
      if (done.status === "completed") await onDone(done.result);
      else onError(done.error || "That didn't complete.");
      onChanged();
    });

  const resolutions = () => Object.fromEntries(Object.entries(choices).filter(([, value]) => value));
  const analyze = () => job(libraryApi.analyzeAppleMigration(), (result) => (setAnalysis(result), setDry(null), setOutcome(null), setVerification(null), setCleaned(null)));
  const makeBackup = () => job(libraryApi.backupItunes(), () => undefined);
  const preview = () => job(libraryApi.applyAppleMigration({ resolutions: resolutions(), dryRun: true }), setDry);
  const migrate = () =>
    job(libraryApi.applyAppleMigration({ resolutions: resolutions(), dryRun: false, backupAck }), (result) => {
      setOutcome(result);
      setVerification(result.verification);
      setDry(null);
    });
  const verify = () => job(libraryApi.verifyAppleLibrary(), setVerification);
  const toggle = (pid) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  const superseded = verification?.superseded || [];
  const removeCount = picked.size + superseded.filter((entry) => !picked.has(entry.pid)).length;
  const cleanUp = () =>
    job(libraryApi.cleanUpAppleLibrary({ pids: [...picked], includeSuperseded: true, expected: removeCount, backupAck }), (result) => {
      setCleaned(result);
      setPicked(new Set());
      setUnderstand(false);
      setAnalysis(null);
      setVerification(null);
    });

  return (
    <div className="lib-apple-migration">
      <p className="settings-hint">
        Matches your existing iTunes songs with your curated library, keeps their ratings, play counts and playlists where it can, and adds what&apos;s missing. Matching is
        cautious: only same-file or same artist, title and length with no competing candidate is automatic; anything unclear is yours to decide. Nothing is deleted until the
        last, separate step, and iTunes&apos; own music files are never deleted.
      </p>

      <ol className="lib-apple-migration__steps">
        <li>
          <strong>1. Compare</strong> (read-only){" "}
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={analyze}>
            Compare iTunes with My Library
          </button>
        </li>
      </ol>

      {analysis && (
        <>
          <div className="lib-managed__plan">
            <span>
              <strong>{formatNumber(analysis.counts.iTunesSongs)}</strong> songs in iTunes
            </span>
            <span>
              <strong>{formatNumber(analysis.counts.exact)}</strong> same file
            </span>
            <span>
              <strong>{formatNumber(analysis.counts.strong)}</strong> same song
            </span>
            <span className={analysis.counts.ambiguous ? "is-warn" : ""}>
              <strong>{formatNumber(analysis.counts.ambiguous)}</strong> need your choice
            </span>
            <span>
              <strong>{formatNumber(analysis.counts.toAdd)}</strong> to add to iTunes
            </span>
            <span>{formatNumber(analysis.counts.obsolete)} in iTunes only (left alone)</span>
            {analysis.counts.missingFiles > 0 && <span className="is-warn">{pluralize(analysis.counts.missingFiles, "iTunes entry", "iTunes entries")} with a missing file</span>}
            {analysis.counts.duplicateGroups > 0 && <span className="is-warn">{pluralize(analysis.counts.duplicateGroups, "set")} of duplicates in iTunes</span>}
          </div>

          {analysis.ambiguous.length > 0 && (
            <div className="lib-iphone__items">
              {analysis.ambiguous.map((item) => (
                <label key={item.trackId} className="lib-iphone__item">
                  <span className="lib-iphone__item-title">
                    {item.title} · {item.artist}
                  </span>
                  <select className="field" value={choices[item.trackId] || ""} onChange={(event) => (setChoices((current) => ({ ...current, [item.trackId]: event.target.value })), setDry(null))}>
                    <option value="">Add as a new song</option>
                    {item.candidates.map((candidate) => (
                      <option key={candidate.pid} value={candidate.pid}>
                        Use: {label(candidate)}
                        {candidate.exists ? "" : " (file missing)"}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          <ol className="lib-apple-migration__steps" start={2}>
            <li>
              <strong>2. Back up</strong> the iTunes database{" "}
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={makeBackup}>
                Back Up iTunes Library
              </button>
              <span className="settings-hint">
                {backup ? ` Last backup ${formatDate(backup.at)}: ${backup.files.length} files${backup.iTunesWasRunning ? " (iTunes was open; for the safest copy close it first)" : ""}.` : " Copies the iTunes library files (not your music)."}
              </span>
              <label className="lib-edit__bool">
                <input type="checkbox" checked={backupAck} onChange={(event) => setBackupAck(event.target.checked)} />I already have my own backup of the iTunes library
              </label>
            </li>
            <li>
              <strong>3. Preview</strong> (changes nothing){" "}
              <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={preview}>
                Preview Migration
              </button>
              {dry && (
                <div className="lib-managed__plan">
                  <span>
                    <strong>{formatNumber(dry.adopt)}</strong> iTunes entries kept ({formatNumber(dry.inPlace)} already use the right file, {formatNumber(dry.relink)} get re-pointed)
                  </span>
                  <span>
                    <strong>{formatNumber(dry.add)}</strong> songs added
                  </span>
                  {dry.identityChanges > 0 && <span className="is-warn">{pluralize(dry.identityChanges, "entry", "entries")} replaced by new ones (history carried over)</span>}
                  {dry.identityUnknown && dry.relink > 0 && <span className="settings-hint">Whether entries can be re-pointed is checked when you start.</span>}
                  <span>{formatNumber(dry.leftAlone)} other iTunes songs left untouched</span>
                </div>
              )}
            </li>
            <li>
              <strong>4. Migrate</strong>{" "}
              <button type="button" className="btn btn--primary btn--sm" disabled={busy || (dry?.needsBackup && !backup && !backupAck)} onClick={migrate}>
                Migrate Now
              </button>
              {dry?.needsBackup && !backup && !backupAck && <span className="settings-hint"> Back up first (step 2).</span>}
            </li>
          </ol>
        </>
      )}

      {outcome && (
        <p className="lib-managed__done">
          <CheckIcon size={16} /> {outcome.result.status === "completed" ? "Migrated." : `Migration finished with ${pluralize(outcome.result.failed.length, "problem")}.`} {formatNumber(outcome.result.relinked)} entries re-pointed, {formatNumber(outcome.result.recreated)} replaced, {formatNumber(outcome.result.added)} added.
        </p>
      )}

      {(verification || status?.baselineDone) && (
        <div>
          <strong>5. Verify</strong>{" "}
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={verify}>
            Verify iTunes Library
          </button>
          {verification &&
            (verification.ok ? (
              <p className="lib-managed__done">
                <CheckIcon size={16} /> Every managed song is in iTunes and plays its Apple Library file.
              </p>
            ) : (
              <p className="lib-upgrade__warning is-strong">
                <WarningIcon size={14} /> {pluralize(verification.problemCount, "problem")}: {verification.problems.slice(0, 3).map((item) => `${item.title} (${item.problem})`).join("; ")}. Sync, then verify again.
              </p>
            ))}
        </div>
      )}

      {verification?.ok && (superseded.length > 0 || analysis?.obsolete?.length > 0) && (
        <div>
          <strong>6. Clean up</strong> (optional, removes entries from the iTunes library only)
          {superseded.length > 0 && <p className="settings-hint">{pluralize(superseded.length, "old entry", "old entries")} replaced by new ones will be removed.</p>}
          {analysis?.obsolete?.length > 0 && (
            <div className="lib-iphone__items">
              {analysis.obsolete.map((entry) => (
                <label key={entry.pid} className="lib-iphone__item">
                  <input type="checkbox" checked={picked.has(entry.pid)} onChange={() => toggle(entry.pid)} />
                  <span className="lib-iphone__item-title">{label(entry)}</span>
                  <span className="settings-hint">{entry.exists ? "" : "file missing"}</span>
                </label>
              ))}
            </div>
          )}
          <label className="lib-edit__bool">
            <input type="checkbox" checked={understand} onChange={(event) => setUnderstand(event.target.checked)} />I understand this removes {pluralize(removeCount, "entry", "entries")} from the iTunes library (the music files stay on disk)
          </label>
          <button type="button" className="btn btn--danger btn--sm" disabled={busy || !understand || removeCount === 0 || (!backup && !backupAck)} onClick={cleanUp}>
            Remove {pluralize(removeCount, "Entry", "Entries")} from iTunes
          </button>
        </div>
      )}
      {cleaned && (
        <p className="lib-managed__done">
          <CheckIcon size={16} /> Removed {pluralize(cleaned.removed, "entry", "entries")} from iTunes.
        </p>
      )}
    </div>
  );
}
