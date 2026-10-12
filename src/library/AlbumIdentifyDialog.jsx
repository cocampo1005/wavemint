import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { CheckIcon, WarningIcon } from "./icons";
import { MusicBrainzConsent } from "./IdentifyDialog";
import { errorMessage, libraryApi } from "./useLibrary";

const ALBUM_FIELDS = [
  ["album", "Album title"],
  ["albumArtist", "Album artist"],
  ["year", "Year"],
  ["trackNo", "Track numbers"],
  ["trackTotal", "Tracks on disc"],
  ["discNo", "Disc numbers"],
  ["discTotal", "Number of discs"],
  ["title", "Song titles"],
  ["artist", "Song artists"],
  ["genre", "Genre (only where missing)"],
];
const DEFAULT_FIELDS = ["album", "albumArtist", "year", "trackNo", "trackTotal", "discNo", "discTotal"];
const show = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

/** Match a whole album to a MusicBrainz release and apply it in one edit. */
export function AlbumIdentifyDialog({ releaseId, onClose, onApplied }) {
  const [enabled, setEnabled] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [fields, setFields] = useState(new Set(DEFAULT_FIELDS));
  const [excluded, setExcluded] = useState(new Set());
  const [useCover, setUseCover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  const started = useRef(false);

  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const search = () => run(async () => setCandidates(await libraryApi.identifyAlbumCandidates({ releaseId })));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    libraryApi
      .identificationSummary()
      .then((summary) => {
        setEnabled(summary.enabled);
        if (summary.enabled) search();
      })
      .catch((err) => setError(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (mbReleaseId) =>
    run(async () => {
      setChosen(mbReleaseId);
      const next = await libraryApi.identifyAlbumProposal({ releaseId, mbReleaseId });
      setProposal(next);
      setExcluded(new Set(next.rows.filter((row) => row.match && row.match.score < 0.85).map((row) => row.trackId)));
    });

  const apply = () =>
    run(async () => {
      const result = await libraryApi.applyAlbumIdentification({
        releaseId,
        mbReleaseId: chosen,
        fields: [...fields],
        exclude: [...excluded],
        useCover,
      });
      setDone(result);
      onApplied?.();
    });

  const toggle = (setter, value, on) =>
    setter((current) => {
      const next = new Set(current);
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });

  const matched = proposal?.rows.filter((row) => row.match && !excluded.has(row.trackId)) || [];
  const footer = done ? (
    <button type="button" className="btn btn--primary" onClick={onClose}>
      Done
    </button>
  ) : (
    <>
      {proposal && (
        <button type="button" className="btn btn--ghost" onClick={() => setProposal(null)}>
          Back
        </button>
      )}
      <button type="button" className="btn btn--ghost" onClick={onClose}>
        Cancel
      </button>
      {proposal && (
        <button type="button" className={`btn btn--primary ${busy ? "is-loading" : ""}`} disabled={busy || !matched.length} onClick={apply}>
          <CheckIcon size={14} /> Apply to {matched.length} Song{matched.length === 1 ? "" : "s"}
        </button>
      )}
    </>
  );

  return (
    <Dialog title="Identify album" wide onClose={onClose} footer={footer}>
      {error && (
        <div className="alert alert--compact" role="alert">
          <WarningIcon size={16} /> {error}
        </div>
      )}
      {enabled === false && (
        <MusicBrainzConsent
          onError={setError}
          onEnabled={() => {
            setEnabled(true);
            search();
          }}
        />
      )}
      {done && (
        <p className="lib-managed__done">
          <CheckIcon size={16} /> Updated {done.tracks} song{done.tracks === 1 ? "" : "s"}. Undo it from History if needed.
        </p>
      )}

      {!done && !proposal && candidates && (
        <div className="lib-identify">
          <p className="settings-hint">
            Releases of &ldquo;{candidates.album.title}&rdquo; in MusicBrainz. Your album has {candidates.album.tracks} song
            {candidates.album.tracks === 1 ? "" : "s"}; editions with the same number of tracks are marked.
          </p>
          <div className="lib-identify__releases">
            {candidates.candidates.map((release) => (
              <button key={release.id} type="button" className="lib-identify__release is-button" disabled={busy} onClick={() => choose(release.id)}>
                <span className={`lib-badge is-name ${release.kind === "album" ? "is-success" : "is-quiet"}`}>{release.kindLabel}</span>
                <span className="lib-identify__release-title">{release.title}</span>
                <span className="settings-hint">
                  {[release.artist, release.year, release.country, release.format, release.trackCount ? `${release.trackCount} tracks` : null, release.status]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {release.trackCountMatches && <span className="lib-badge is-name is-info">Same track count</span>}
              </button>
            ))}
            {!candidates.candidates.length && <p className="settings-hint">MusicBrainz has no release with this title and artist.</p>}
          </div>
        </div>
      )}
      {busy && !proposal && !candidates && enabled && <p className="settings-hint">Searching MusicBrainz…</p>}

      {!done && proposal && (
        <div className="lib-identify">
          <div className="lib-upgrade__match">
            <strong>
              {proposal.release.title} · {proposal.release.artist}
            </strong>
            <span>
              {[proposal.release.kindLabel, proposal.release.year, proposal.release.country, `${proposal.release.trackCount} tracks`, proposal.release.discCount > 1 ? `${proposal.release.discCount} discs` : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>

          <span className="section-label">Apply</span>
          <div className="lib-identify__fieldpicks">
            {ALBUM_FIELDS.map(([field, label]) => (
              <label key={field} className="lib-edit__bool">
                <input type="checkbox" checked={fields.has(field)} onChange={(event) => toggle(setFields, field, event.target.checked)} />
                {label}
              </label>
            ))}
            <label className="lib-edit__bool">
              <input type="checkbox" checked={useCover} onChange={(event) => setUseCover(event.target.checked)} />
              Cover from the Cover Art Archive
            </label>
          </div>

          <span className="section-label">Songs</span>
          <div className="lib-upgrade__fields">
            <div className="lib-upgrade__field lib-identify__album-row is-head">
              <span />
              <span>Your song</span>
              <span>MusicBrainz track</span>
              <span>Match</span>
            </div>
            {proposal.rows.map((row) => (
              <label key={row.trackId} className="lib-upgrade__field lib-identify__album-row">
                <input
                  type="checkbox"
                  disabled={!row.match}
                  checked={!!row.match && !excluded.has(row.trackId)}
                  onChange={(event) => toggle(setExcluded, row.trackId, !event.target.checked)}
                />
                <span>
                  {row.current?.trackNo ? `${row.current.trackNo}. ` : ""}
                  {row.title}
                </span>
                <span>
                  {row.match ? `${row.match.discNo > 1 ? `${row.match.discNo}-` : ""}${show(row.match.trackNo)}. ${row.match.title}` : "No matching track"}
                </span>
                <span>{row.match ? `${Math.round(row.match.score * 100)}%` : ""}</span>
              </label>
            ))}
          </div>
          {proposal.unmatchedRelease.length > 0 && (
            <p className="settings-hint">
              Not in your library: {proposal.unmatchedRelease.slice(0, 12).map((track) => `${track.trackNo}. ${track.title}`).join(", ")}
              {proposal.unmatchedRelease.length > 12 ? "…" : ""}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
