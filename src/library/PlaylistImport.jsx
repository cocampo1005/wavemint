import { useEffect, useState } from "react";
import { isSkippableInBatch, parseIpcError } from "../ipcErrors";
import { pluralize } from "./format";
import { CheckIcon, UpgradeIcon, WarningIcon } from "./icons";
import { UpgradeDialog } from "./UpgradeDialog";
import { entryKey, errorMessage, libraryApi, useJobRunner } from "./useLibrary";
import "./library.css";

const ACTIONS = [
  ["add", "Add new track"],
  ["compare", "Compare & upgrade"],
  ["keep_existing", "Keep existing"],
  ["keep_both", "Keep both"],
  ["skip", "Skip"],
];
const DOWNLOADS = new Set(["add", "compare", "keep_both"]);

function MatchBadge({ match }) {
  if (!match) return null;
  if (match.status === "new") return <span className="lib-badge is-name is-success">New to your library</span>;
  return (
    <span className={`lib-badge is-name ${match.status === "existing" ? "is-info" : "is-warn"}`} title={(match.notes || []).join(" · ")}>
      {match.status === "existing" ? "In library" : "Possibly in library"}: {match.title}
      {match.album ? ` · ${match.album}` : ""}
      {match.quality ? ` · ${match.quality}` : ""}
    </span>
  );
}

/** Library match indicator for an entry card in the Extract view. */
export function EntryLibraryMatch({ match }) {
  return match ? (
    <div className="import-match">
      <MatchBadge match={match} />
    </div>
  ) : null;
}

/**
 * "Import into WaveMint Library" for an analyzed playlist: match → choose
 * actions and album details → extract into staging → review → commit.
 */
export function PlaylistImport({ playlist, entries, downloadStatus, requestId, onBusyChange, onCancel, onMatches, onDone }) {
  const [session, setSession] = useState(null);
  const [step, setStep] = useState("start"); // start | plan | staging | review | done
  const [albumFields, setAlbumFields] = useState({ album: "", albumArtist: "", year: "", genre: "", edition: "", numberTracks: true, artworkKey: "" });
  const [decisions, setDecisions] = useState({});
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(null); // item
  const [jobId, setJobId] = useState(null);

  const selected = entries.filter((entry) => entry.selected);

  useEffect(() => {
    onMatches?.(session ? Object.fromEntries(session.items.map((item) => [item.entryKey, item.match])) : {});
  }, [session, onMatches]);

  useEffect(() => onBusyChange?.(busy || !!jobId), [busy, jobId, onBusyChange]);

  const entryPayload = (list) =>
    list.map((entry) => ({
      key: entryKey(entry),
      title: entry.metadata?.title || entry.title || "",
      artist: entry.metadata?.artist || "",
      album: entry.metadata?.album || "",
      genre: entry.metadata?.genre || "",
      durationMs: Number.isFinite(entry.duration) ? Math.round(entry.duration * 1000) : undefined,
    }));

  const check = async () => {
    setError("");
    setBusy(true);
    try {
      const next = await libraryApi.startImport({ title: playlist.title || "", url: playlist.webpage_url || "", entries: entryPayload(selected) });
      setSession(next);
      const albums = selected.map((entry) => entry.metadata?.album).filter(Boolean);
      const artists = selected.map((entry) => entry.metadata?.artist).filter(Boolean);
      const common = (values) => (values.length && values.every((value) => value === values[0]) ? values[0] : "");
      setAlbumFields((current) => ({ ...current, album: current.album || common(albums), albumArtist: current.albumArtist || common(artists) }));
      setStep("plan");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const setAction = async (item, action) => {
    try {
      setSession(await libraryApi.updateImport({ sessionId: session.id, actions: [{ itemId: item.id, action }] }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const chooseLibraryFolder = async () => {
    try {
      const result = await libraryApi.chooseManagedRoot();
      if (result) setSession(await libraryApi.getImport({ sessionId: session.id }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const fieldsPayload = () => ({
    album: albumFields.album.trim(),
    albumArtist: albumFields.albumArtist.trim(),
    year: /^\d{4}$/.test(String(albumFields.year).trim()) ? Number(albumFields.year) : undefined,
    genre: albumFields.genre.trim(),
    edition: albumFields.edition.trim(),
    numberTracks: !!albumFields.numberTracks,
    artworkKey: albumFields.artworkKey || "",
  });

  const stage = async () => {
    setError("");
    setBusy(true);
    setStep("staging");
    const skipped = [];
    try {
      // Latest details from the Extract view, actions and album fields.
      let current = await libraryApi.updateImport({ sessionId: session.id, albumFields: fieldsPayload(), entries: entryPayload(selected) });
      setSession(current);
      const todo = current.items.filter((item) => DOWNLOADS.has(item.action) && item.status !== "staged");
      for (const [index, item] of todo.entries()) {
        const entry = entries.find((candidate) => entryKey(candidate) === item.entryKey);
        if (!entry) continue;
        setProgress(`Extracting ${index + 1} of ${todo.length}: ${entry.metadata?.title || entry.title}`);
        try {
          await window.waveMintAPI.downloadMp3({
            url: entry.webpage_url,
            importSessionId: session.id,
            importEntryKey: item.entryKey,
            metadata: entry.metadata,
            thumbnail: entry.thumbnail,
            duration: entry.duration,
            artwork: { mode: entry.artworkMode || "square_crop", customFilePath: entry.customArtworkPath || "" },
            requestId,
          });
        } catch (trackError) {
          const parsed = parseIpcError(trackError, "This track couldn't be extracted");
          if (!isSkippableInBatch(parsed.code)) throw trackError;
          skipped.push(`${entry.metadata?.title || entry.title}: ${parsed.message}`);
        }
      }
      current = await libraryApi.getImport({ sessionId: session.id });
      setSession(current);
      // Upgrades need an explicit choice; everything else has a sensible default.
      setDecisions(
        Object.fromEntries(
          current.items
            .filter((item) => item.status === "staged")
            .map((item) => [
              item.id,
              item.candidateId ? "" : item.staged?.libraryMatch?.status === "existing" ? "keep_existing" : item.action === "keep_both" ? "keep_both" : "add",
            ]),
        ),
      );
      if (skipped.length) setError(`${pluralize(skipped.length, "song")} couldn't be extracted: ${skipped.slice(0, 3).join(" ")}`);
      setStep("review");
    } catch (err) {
      setError(parseIpcError(err, "The extraction stopped").message);
      setSession(await libraryApi.getImport({ sessionId: session.id }).catch(() => session));
      setStep("plan");
    } finally {
      setProgress("");
      setBusy(false);
    }
  };

  const runJob = useJobRunner();

  const commit = async () => {
    setError("");
    setJobId(true);
    try {
      const job = await runJob(
        libraryApi.commitImport({
          sessionId: session.id,
          decisions: Object.entries(decisions)
            .filter(([, decision]) => decision)
            .map(([itemId, decision]) => ({ itemId: Number(itemId), decision })),
        }),
      );
      const next = await libraryApi.getImport({ sessionId: session.id });
      if (job.status === "completed" && job.result) {
        setSession({ ...next, report: next.report || job.result });
        setStep("done");
        onDone?.();
      } else {
        setSession(next);
        setError(job.error || "The import didn't complete.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setJobId(null);
    }
  };

  const discard = async () => {
    if (session) await libraryApi.discardImport({ sessionId: session.id }).catch(() => {});
    setSession(null);
    setStep("start");
    setDecisions({});
  };

  const counts = session
    ? {
        new: session.items.filter((item) => item.match.status === "new").length,
        existing: session.items.filter((item) => item.match.status !== "new").length,
        downloads: session.items.filter((item) => DOWNLOADS.has(item.action) && item.status !== "staged").length,
      }
    : null;
  const staged = session?.items.filter((item) => item.status === "staged" || item.status === "failed") || [];
  const undecided = staged.filter((item) => item.status === "staged" && !decisions[item.id]).length;
  const report = session?.report;

  return (
    <div className="import-panel">
      {error && (
        <div className="alert alert--compact" role="alert">
          <WarningIcon size={16} /> {error}
        </div>
      )}

      {step === "start" && (
        <div className="import-panel__intro">
          <p className="text-muted">
            WaveMint checks which of the {pluralize(selected.length, "selected song")} you already have, extracts the rest into a private
            staging folder, checks each file, and only then adds them to your WaveMint Library.
          </p>
          <button type="button" className={`btn btn--primary ${busy ? "is-loading" : ""}`} disabled={busy || !selected.length} onClick={check}>
            Check Against Library
          </button>
        </div>
      )}

      {step === "plan" && session && (
        <>
          <p className="text-muted">
            {pluralize(counts.new, "new song")}, {pluralize(counts.existing, "song")} you may already have. Audio quality is compared after
            extraction, not before.
          </p>
          {!session.hasLibraryFolder && (
            <p className="lib-upgrade__warning">
              <WarningIcon size={14} /> Imports are copied into your WaveMint Library, which doesn&apos;t have a folder yet.{" "}
              <button type="button" className="btn btn--link" onClick={chooseLibraryFolder}>
                Choose Folder…
              </button>
            </p>
          )}

          <div className="import-list">
            {session.items.map((item) => (
              <div key={item.id} className="import-row">
                <span className="import-row__pos">{item.position}</span>
                <div className="import-row__text">
                  <strong>{item.entry.title || "Untitled"}</strong>
                  <MatchBadge match={item.match} />
                </div>
                <select className="field" aria-label={`Action for ${item.entry.title}`} value={item.action} disabled={busy} onChange={(event) => setAction(item, event.target.value)}>
                  {ACTIONS.filter(([value]) => item.match.status !== "new" || !["compare", "keep_existing", "keep_both"].includes(value)).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <span className="section-label">Album details</span>
          <div className="form-grid form-grid--3 import-album">
            {[
              ["album", "Album title"],
              ["albumArtist", "Album artist"],
              ["year", "Year"],
              ["genre", "Genre (where a song has none)"],
              ["edition", "Edition (e.g. Deluxe Edition)"],
            ].map(([field, label]) => (
              <label key={field} className="form-field">
                <span className="form-field__label">{label}</span>
                <input className="field" value={albumFields[field]} disabled={busy} onChange={(event) => setAlbumFields((current) => ({ ...current, [field]: event.target.value }))} />
              </label>
            ))}
            <label className="form-field">
              <span className="form-field__label">Artwork</span>
              <select className="field" value={albumFields.artworkKey} disabled={busy} onChange={(event) => setAlbumFields((current) => ({ ...current, artworkKey: event.target.value }))}>
                <option value="">Each song&apos;s own artwork</option>
                {session.items.map((item) => (
                  <option key={item.entryKey} value={item.entryKey}>
                    Use the artwork of &ldquo;{item.entry.title}&rdquo;
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="lib-edit__bool">
            <input type="checkbox" checked={albumFields.numberTracks} disabled={busy} onChange={(event) => setAlbumFields((current) => ({ ...current, numberTracks: event.target.checked }))} />
            Number the tracks in playlist order
          </label>
          <p className="settings-hint">Album details apply to every new song except ones you gave a different album on purpose.</p>

          <div className="import-panel__actions">
            <button type="button" className="btn btn--ghost" onClick={discard} disabled={busy}>
              Cancel Import
            </button>
            <button type="button" className={`btn btn--primary ${busy ? "is-loading" : ""}`} disabled={busy || !counts.downloads || !session.hasLibraryFolder} onClick={stage}>
              Extract & Check {pluralize(counts.downloads, "Song")}
            </button>
          </div>
        </>
      )}

      {step === "staging" && (
        <div className="import-panel__progress">
          <strong>{progress || "Preparing…"}</strong>
          <span className="text-muted">
            {downloadStatus?.phase === "checking" ? "Checking the file…" : downloadStatus?.phase ? `${downloadStatus.phase}${downloadStatus.percent ? ` ${Math.round(downloadStatus.percent)}%` : ""}` : ""}
          </span>
          <button type="button" className="btn btn--link" onClick={onCancel}>
            Stop
          </button>
        </div>
      )}

      {step === "review" && session && (
        <>
          <p className="text-muted">Review the extracted files before they go into your library.</p>
          <div className="import-list">
            {staged.map((item) => {
              const info = item.staged || {};
              const comparison = info.comparison;
              return (
                <div key={item.id} className={`import-row ${item.status === "failed" ? "is-failed" : ""}`}>
                  <span className="import-row__pos">{item.position}</span>
                  <div className="import-row__text">
                    <strong>{info.title || item.entry.title}</strong>
                    <span className="settings-hint">
                      {info.description || ""}
                      {item.status === "failed" ? ` · ${item.error || "Failed"}` : " · File checked"}
                    </span>
                    {comparison && (
                      <span className="settings-hint">
                        Compared with your copy ({comparison.current}): {comparison.verdict === "same" || comparison.verdict === "exact" ? "looks like the same recording" : "may be a different version"}.
                        {comparison.warnings.length ? ` ${comparison.warnings[0]}` : ""}
                      </span>
                    )}
                    {!comparison && info.libraryMatch?.status === "existing" && (
                      <span className="settings-hint">Already in your library as &ldquo;{info.libraryMatch.title}&rdquo;.</span>
                    )}
                    {(info.signals || []).filter((signal) => signal.level >= 2).map((signal) => (
                      <span key={signal.code} className="lib-badge is-name is-warn">
                        {signal.text}
                      </span>
                    ))}
                  </div>
                  {item.status === "staged" && (
                    <div className="import-row__decide">
                      {comparison && (
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCompare(item)}>
                          <UpgradeIcon size={14} /> Compare…
                        </button>
                      )}
                      <select
                        className="field"
                        aria-label={`Decision for ${item.entry.title}`}
                        value={decisions[item.id] || ""}
                        onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: event.target.value }))}
                      >
                        {comparison ? (
                          <>
                            <option value="">Choose…</option>
                            <option value="upgrade">Upgrade my copy</option>
                            <option value="keep_existing">Keep my copy</option>
                            <option value="keep_both">Keep both</option>
                            <option value="skip">Skip</option>
                          </>
                        ) : (
                          <>
                            <option value="add">Add to library</option>
                            {info.libraryMatch?.status !== "new" && <option value="keep_existing">Keep existing</option>}
                            <option value="skip">Skip</option>
                          </>
                        )}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="import-panel__actions">
            <button type="button" className="btn btn--ghost" onClick={discard} disabled={!!jobId}>
              Cancel Import
            </button>
            {undecided > 0 && <span className="settings-hint">Choose what to do with {pluralize(undecided, "song")} you already have.</span>}
            <button type="button" className={`btn btn--primary ${jobId ? "is-loading" : ""}`} disabled={!!jobId || undecided > 0} onClick={commit}>
              <CheckIcon size={14} /> Add to WaveMint Library
            </button>
          </div>
        </>
      )}

      {step === "done" && report && (
        <div className="import-panel__intro">
          <p className="lib-managed__done">
            <CheckIcon size={16} /> {pluralize(report.added, "track")} added, {report.upgraded} upgraded, {report.skipped} skipped
            {report.kept ? `, ${report.kept} kept as you had ${report.kept === 1 ? "it" : "them"}` : ""}
            {report.failed ? `, ${report.failed} failed` : ""}.
          </p>
          {report.failures?.map((failure) => (
            <p key={failure.title} className="settings-hint">
              {failure.title}: {failure.error}
            </p>
          ))}
          <p className="settings-hint">The songs are in your library (Songs). Undo the import from History if needed.</p>
          <button type="button" className="btn btn--secondary" onClick={discard}>
            Start Over
          </button>
        </div>
      )}

      {compare && (
        <UpgradeDialog
          trackId={compare.staged.comparison.trackId}
          candidateId={compare.candidateId}
          onClose={() => setCompare(null)}
          onDone={() => setDecisions((current) => ({ ...current, [compare.id]: "upgrade" }))}
        />
      )}
    </div>
  );
}
