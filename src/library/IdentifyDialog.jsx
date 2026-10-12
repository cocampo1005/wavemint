import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { artworkUrl, formatDate, formatDuration } from "./format";
import { CheckIcon, RefreshIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi } from "./useLibrary";

const show = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));
const STATUS_TEXT = {
  matched: "Identified",
  uncertain: "Possible match: please check",
  no_match: "No match found",
  error: "The lookup failed",
  applied: "Applied",
  dismissed: "Dismissed",
};

/** Explains what an online lookup sends, and turns it on. */
export function MusicBrainzConsent({ onEnabled, onError }) {
  const [busy, setBusy] = useState(false);
  const enable = async () => {
    setBusy(true);
    try {
      await libraryApi.updateSettings({ patch: { musicBrainzEnabled: true } });
      onEnabled();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lib-consent">
      <p>
        Identification looks songs up in <strong>MusicBrainz</strong>, the open music encyclopedia, and fetches covers from the{" "}
        <strong>Cover Art Archive</strong>. For each song you identify, its title, artist, album and length are sent to them. Nothing else
        leaves your computer, nothing is sent until you start a lookup, and suggestions are only applied when you approve them.
      </p>
      <button type="button" className={`btn btn--primary ${busy ? "is-loading" : ""}`} disabled={busy} onClick={enable}>
        Turn On MusicBrainz Lookups
      </button>
    </div>
  );
}

function Confidence({ value }) {
  if (value === null || value === undefined) return null;
  const tone = value >= 0.85 ? "success" : value >= 0.6 ? "warn" : "error";
  return <span className={`lib-badge is-name is-${tone}`}>{Math.round(value * 100)}% match</span>;
}

/** Identify one song: candidates, release choice, suggested metadata, cover. */
export function IdentifyDialog({ trackId, onClose, onApplied }) {
  const [item, setItem] = useState(null);
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [cover, setCover] = useState(null); // { hash } | null | "none"
  const [useCover, setUseCover] = useState(false);
  const [done, setDone] = useState(false);
  const started = useRef(false);

  const accept = (next) => {
    setItem(next);
    setSelected(new Set((next?.fields || []).filter((field) => field.selected).map((field) => field.field)));
    setCover(null);
    setUseCover(false);
  };

  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (err) {
      setError(errorMessage(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const identify = () => run(async () => accept(await libraryApi.identifySong({ trackId })));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const [summary, existing] = await Promise.all([libraryApi.identificationSummary(), libraryApi.getIdentification({ trackId })]);
      setEnabled(summary.enabled);
      if (existing) accept(existing);
      else if (summary.enabled) identify();
    })().catch((err) => setError(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseRelease = (releaseGroupId) => run(async () => accept(await libraryApi.chooseIdentificationRelease({ trackId, releaseGroupId })));
  const loadCover = () =>
    run(async () => {
      const result = await libraryApi.identificationCover({ trackId });
      setCover(result || "none");
      setUseCover(!!result);
    });
  const apply = () =>
    run(async () => {
      await libraryApi.applyIdentification({ trackId, fields: [...selected], coverHash: useCover && cover?.hash ? cover.hash : undefined });
      setDone(true);
      onApplied?.();
    });
  const dismiss = () =>
    run(async () => {
      await libraryApi.dismissIdentifications({ trackIds: [trackId] });
      onApplied?.();
      onClose();
    });

  const recording = item?.recordings?.[0];
  const changes = (item?.fields || []).filter((field) => !field.same);
  const canApply = !done && item && (selected.size > 0 || (useCover && cover?.hash));

  const footer = done ? (
    <button type="button" className="btn btn--primary" onClick={onClose}>
      Done
    </button>
  ) : (
    <>
      {item && item.status !== "dismissed" && (
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={dismiss}>
          Dismiss
        </button>
      )}
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        Cancel
      </button>
      <button type="button" className={`btn btn--primary ${busy ? "is-loading" : ""}`} disabled={busy || !canApply} onClick={apply}>
        <CheckIcon size={14} /> Apply Selected
      </button>
    </>
  );

  return (
    <Dialog title="Identify song" wide onClose={onClose} footer={footer}>
      {error && (
        <div className="alert alert--compact" role="alert">
          <WarningIcon size={16} /> {error}
        </div>
      )}
      {enabled === false && !item && (
        <MusicBrainzConsent
          onError={setError}
          onEnabled={() => {
            setEnabled(true);
            identify();
          }}
        />
      )}
      {busy && !item && <p className="settings-hint">Looking this song up in MusicBrainz…</p>}

      {done && (
        <p className="lib-managed__done">
          <CheckIcon size={16} /> Applied. The changes are in WaveMint (write tags to put them into files) and can be undone from History.
        </p>
      )}

      {item && !done && (
        <div className="lib-identify">
          <div className="lib-identify__head">
            <div>
              <strong>{STATUS_TEXT[item.status] || item.status}</strong>
              <span className="settings-hint">
                {item.method === "album" ? "Found through the song's album" : item.method === "mbid" ? "Found by its MusicBrainz ID" : "Found by title and artist"}
                {item.checkedAt ? ` · ${formatDate(item.checkedAt)}` : ""}
              </span>
            </div>
            <Confidence value={item.confidence} />
            {enabled && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={identify}>
                <RefreshIcon size={14} /> Search Again
              </button>
            )}
          </div>
          {item.error && <p className="lib-upgrade__warning is-strong">{item.error}</p>}

          {recording && (
            <div className="lib-upgrade__match">
              <strong>
                {recording.title} · {recording.artist}
                {recording.lengthMs ? ` · ${formatDuration(recording.lengthMs)}` : ""}
                {recording.disambiguation ? ` (${recording.disambiguation})` : ""}
              </strong>
              <span>{recording.match?.notes?.join(" · ")}</span>
            </div>
          )}

          {item.releases.length > 0 && (
            <>
              <span className="section-label">Album for this song</span>
              <div className="lib-identify__releases">
                {item.releases.slice(0, 12).map((group) => (
                  <label key={group.releaseGroupId} className={`lib-identify__release ${group.releaseGroupId === item.chosenReleaseGroupId ? "is-chosen" : ""}`}>
                    <input
                      type="radio"
                      name="release"
                      checked={group.releaseGroupId === item.chosenReleaseGroupId}
                      disabled={busy}
                      onChange={() => chooseRelease(group.releaseGroupId)}
                    />
                    <span className={`lib-badge is-name ${group.kind === "original" ? "is-success" : "is-quiet"}`}>{group.kindLabel}</span>
                    <span className="lib-identify__release-title">{group.title}</span>
                    <span className="settings-hint">
                      {[group.artist, group.year, group.releaseCount > 1 ? `${group.releaseCount} editions` : null].filter(Boolean).join(" · ")}
                    </span>
                  </label>
                ))}
                {item.releases.length > 12 && <span className="settings-hint">…and {item.releases.length - 12} more releases (mostly compilations)</span>}
              </div>
            </>
          )}

          {item.fields.length > 0 && (
            <>
              <span className="section-label">Suggested changes</span>
              {!changes.length && <p className="settings-hint">Your details already match MusicBrainz.</p>}
              <div className="lib-upgrade__fields">
                <div className="lib-upgrade__field lib-identify__field is-head">
                  <span />
                  <span>Field</span>
                  <span>Yours</span>
                  <span>MusicBrainz</span>
                </div>
                {item.fields
                  .filter((field) => !field.same)
                  .map((field) => (
                    <label key={field.field} className="lib-upgrade__field lib-identify__field">
                      <input
                        type="checkbox"
                        checked={selected.has(field.field)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(field.field);
                            else next.delete(field.field);
                            return next;
                          })
                        }
                      />
                      <span>
                        {field.label}
                        {field.curated && <span className="lib-badge is-name is-quiet">Edited by you</span>}
                      </span>
                      <span className={field.identifier ? "lib-identify__id" : ""}>{show(field.current)}</span>
                      <span className={field.identifier ? "lib-identify__id" : ""}>{show(field.suggested)}</span>
                    </label>
                  ))}
              </div>
              {item.tags.length > 0 && <p className="settings-hint">MusicBrainz tags: {item.tags.join(", ")} (genres only suggested when they match your genre list).</p>}
            </>
          )}

          {item.fields.some((field) => field.field === "mbReleaseId" || field.field === "mbReleaseGroupId") && (
            <div className="lib-identify__cover">
              {cover?.hash ? (
                <label className="lib-edit__bool">
                  <input type="checkbox" checked={useCover} onChange={(event) => setUseCover(event.target.checked)} />
                  <img src={artworkUrl(cover.hash, 160)} alt="Cover from the Cover Art Archive" />
                  Use this cover
                </label>
              ) : cover === "none" ? (
                <span className="settings-hint">The Cover Art Archive has no cover for this release.</span>
              ) : (
                <button type="button" className="btn btn--secondary btn--sm" disabled={busy || !enabled} onClick={loadCover}>
                  Load Cover from Cover Art Archive
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
