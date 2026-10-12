import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { artworkUrl, formatBytes, formatDuration } from "./format";
import { CheckIcon, FolderOpenIcon, PauseIcon, PlayIcon, UpgradeIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useJobRunner } from "./useLibrary";

const FIELD_FORMAT = (value) => (value === null || value === undefined || value === "" ? "—" : String(value));

/** Two players sharing one position, for switching between versions. */
function AbPlayer({ currentSrc, candidateSrc }) {
  const refs = { a: useRef(null), b: useRef(null) };
  const [side, setSide] = useState(null); // "a" | "b" | null
  const [paused, setPaused] = useState(true);

  const play = (next) => {
    const from = side ? refs[side].current : null;
    const to = refs[next].current;
    if (!to) return;
    if (side === next) {
      if (to.paused) to.play().catch(() => {});
      else to.pause();
      return;
    }
    if (from) {
      to.currentTime = Math.min(from.currentTime, to.duration || from.currentTime);
      from.pause();
    }
    to.play().catch(() => {});
    setSide(next);
  };

  useEffect(
    () => () => {
      refs.a.current?.pause();
      refs.b.current?.pause();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const button = (key, label) => {
    const active = side === key && !paused;
    return (
      <button type="button" className={`btn ${side === key ? "btn--primary" : "btn--secondary"} btn--sm`} onClick={() => play(key)}>
        {active ? <PauseIcon size={14} /> : <PlayIcon size={14} />} {label}
      </button>
    );
  };

  return (
    <div className="lib-ab">
      {["a", "b"].map((key) => (
        <audio
          key={key}
          ref={refs[key]}
          src={key === "a" ? currentSrc : candidateSrc}
          preload="metadata"
          onPlay={() => setPaused(false)}
          onPause={() => side === key && setPaused(true)}
        />
      ))}
      {button("a", "Current")}
      {button("b", "Replacement")}
      <span className="settings-hint">Switching keeps the position, so you can compare the same moment.</span>
    </div>
  );
}

/** Spectrograms of both versions, on request (about a second each). */
function Spectrograms({ currentFileId, candidateId }) {
  const [images, setImages] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const [current, candidate] = await Promise.all([
        currentFileId ? libraryApi.spectrogram({ fileId: currentFileId }) : null,
        libraryApi.spectrogram({ candidateId }),
      ]);
      setImages({ current, candidate });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!images) {
    return (
      <div className="lib-spectra__start">
        <button type="button" className={`btn btn--ghost btn--sm ${busy ? "is-loading" : ""}`} disabled={busy} onClick={load}>
          Show Spectrograms
        </button>
        <span className="settings-hint">A lossy encode often shows as a flat ceiling in the high frequencies. A hint, not proof.</span>
        {error && <span className="settings-hint">{error}</span>}
      </div>
    );
  }
  return (
    <div className="lib-spectra">
      {images.current && (
        <figure>
          <img src={images.current} alt="Spectrogram of the current version" />
          <figcaption>Current</figcaption>
        </figure>
      )}
      <figure>
        <img src={images.candidate} alt="Spectrogram of the replacement" />
        <figcaption>Replacement</figcaption>
      </figure>
    </div>
  );
}

function Side({ title, data, kind }) {
  if (!data) return <div className="lib-compare__side" />;
  return (
    <div className={`lib-compare__side is-${kind}`}>
      <span className="section-label">{title}</span>
      <div className="lib-compare__hero">
        {data.artworkHash ? <img src={artworkUrl(data.artworkHash, 160)} alt="" /> : <span className="lib-art-placeholder lib-compare__art" />}
        <div>
          <strong>{data.title || "Untitled"}</strong>
          <span>{data.artist || "Unknown artist"}</span>
          <span>{data.album || "No album"}</span>
        </div>
      </div>
      <dl className="lib-compare__facts">
        <dt>File</dt>
        <dd title={data.folder ? `${data.folder}\\${data.fileName}` : data.relPath}>{data.fileName}</dd>
        <dt>Source</dt>
        <dd>{data.sourceName}</dd>
        <dt>Format</dt>
        <dd>{data.description}</dd>
        <dt>Length</dt>
        <dd>{formatDuration(data.durationMs)}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(data.size)}</dd>
        {data.mbRecordingId && (
          <>
            <dt>MusicBrainz</dt>
            <dd>{data.mbRecordingId}</dd>
          </>
        )}
      </dl>
      <div className="lib-compare__signals">
        {data.signals?.length ? (
          data.signals.map((signal) => (
            <span key={signal.code} className={`lib-badge is-name ${signal.level >= 3 ? "is-error" : signal.level === 2 ? "is-warn" : "is-quiet"}`}>
              {signal.text}
            </span>
          ))
        ) : (
          <span className="settings-hint">{kind === "candidate" || data.checked ? "No technical concerns found." : "Not checked yet."}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Upgrade Track: pick a replacement, compare, choose metadata, confirm.
 * `start` is { fileId } to use another version, or null to choose a file.
 */
export function UpgradeDialog({ trackId, start = null, candidateId: initialCandidate = null, onClose, onDone }) {
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState({});
  const [artwork, setArtwork] = useState("current");
  const [confirmed, setConfirmed] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const startedRef = useRef(false);

  const load = async (action) => {
    setLoading(true);
    setError("");
    try {
      const next = await action();
      if (!next) return;
      setComparison(next);
      setChoices(Object.fromEntries(next.fields.map((field) => [field.field, field.choice])));
      setArtwork(next.artwork.choice);
      setConfirmed(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (initialCandidate) load(() => libraryApi.compareUpgrade({ candidateId: initialCandidate }));
    else if (start?.fileId) load(() => libraryApi.prepareUpgrade({ trackId, fileId: start.fileId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runJob = useJobRunner();

  const chooseFile = () => load(() => libraryApi.chooseUpgradeFile({ trackId }));

  const apply = async () => {
    setError("");
    try {
      setJobId(true);
      const job = await runJob(libraryApi.applyUpgrade({ candidateId: comparison.candidateId, choices, artwork }));
      if (job.status === "completed") {
        setResult(job.result);
        onDone?.();
      } else {
        setError(job.error || "The upgrade didn't complete; the current version is unchanged.");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setJobId(null);
    }
  };

  const strong = comparison?.warnings.some((warning) => warning.level === "strong");
  const plan = comparison?.plan;
  const blocked = plan?.mode === "needs_library";

  let footer;
  if (result) {
    footer = (
      <button type="button" className="btn btn--primary" onClick={onClose}>
        Done
      </button>
    );
  } else {
    footer = (
      <>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          {comparison ? "Cancel" : "Close"}
        </button>
        {comparison && (
          <button
            type="button"
            className={`btn btn--primary ${jobId ? "is-loading" : ""}`}
            disabled={!!jobId || blocked || (strong && !confirmed)}
            onClick={apply}
          >
            <UpgradeIcon size={14} /> Upgrade Song
          </button>
        )}
      </>
    );
  }

  return (
    <Dialog title="Upgrade song" wide onClose={onClose} footer={footer}>
      {error && (
        <div className="alert alert--compact" role="alert">
          <WarningIcon size={16} /> {error}
        </div>
      )}

      {result ? (
        <div className="lib-upgrade__done">
          <p className="lib-managed__done">
            <CheckIcon size={16} /> Upgraded.{" "}
            {result.mode === "copy"
              ? `The new version is in your WaveMint Library as ${result.target}.`
              : "The other version is now this song's active version."}
          </p>
          <p className="settings-note">
            The previous version was kept{result.archived ? " in the WaveMint Library's archive folder" : ""}. You can undo this from History.
          </p>
        </div>
      ) : !comparison ? (
        <div className="lib-upgrade__start">
          <p>
            Replace this song&apos;s audio with a better version. Your edited title, artist, album, genre and artwork stay unless you choose
            otherwise, and the current file is kept so you can undo.
          </p>
          <button type="button" className={`btn btn--primary ${loading ? "is-loading" : ""}`} disabled={loading} onClick={chooseFile}>
            <FolderOpenIcon size={14} /> Choose Replacement File…
          </button>
          <p className="settings-hint">To use another version already in your library, pick it from the song&apos;s file versions.</p>
        </div>
      ) : (
        <div className="lib-upgrade">
          <div className="lib-compare">
            <Side title="Current" data={comparison.current} kind="current" />
            <Side title="Replacement" data={comparison.candidate} kind="candidate" />
          </div>

          <Spectrograms currentFileId={comparison.current?.fileId} candidateId={comparison.candidateId} />

          <AbPlayer
            currentSrc={comparison.current ? `wavemint-media://file/${comparison.current.fileId}` : ""}
            candidateSrc={`wavemint-media://candidate/${comparison.candidateId}`}
          />

          <div className={`lib-upgrade__match is-${comparison.match.verdict}`}>
            <strong>
              {{
                exact: "Identical files",
                same: "Looks like the same recording",
                uncertain: "Possibly a different version",
                different: "Possibly a different recording",
              }[comparison.match.verdict] || "Comparison"}
            </strong>
            <span>{comparison.match.evidence.map((item) => item.text).join(" · ")}</span>
          </div>
          {comparison.warnings.map((warning) => (
            <p key={warning.text} className={`lib-upgrade__warning is-${warning.level}`}>
              <WarningIcon size={14} /> {warning.text}
            </p>
          ))}
          {strong && (
            <label className="lib-edit__bool">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              I&apos;ve listened to both, and this is the version I want for this song.
            </label>
          )}

          <span className="section-label">Metadata</span>
          <p className="settings-hint">Your current values are kept unless you pick the replacement&apos;s.</p>
          <div className="lib-upgrade__fields" role="table">
            <div className="lib-upgrade__field is-head" role="row">
              <span>Field</span>
              <span>Current</span>
              <span>Replacement</span>
            </div>
            {comparison.fields.map((field) => {
              const same = FIELD_FORMAT(field.current) === FIELD_FORMAT(field.candidate);
              return (
                <div key={field.field} className={`lib-upgrade__field ${same ? "is-same" : ""}`} role="row">
                  <span>{field.label}</span>
                  <label>
                    <input
                      type="radio"
                      name={`field-${field.field}`}
                      checked={choices[field.field] !== "candidate"}
                      disabled={same}
                      onChange={() => setChoices((current) => ({ ...current, [field.field]: "current" }))}
                    />
                    {FIELD_FORMAT(field.current)}
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={`field-${field.field}`}
                      checked={choices[field.field] === "candidate"}
                      disabled={same || field.candidate === null}
                      onChange={() => setChoices((current) => ({ ...current, [field.field]: "candidate" }))}
                    />
                    {FIELD_FORMAT(field.candidate)}
                  </label>
                </div>
              );
            })}
            <div className="lib-upgrade__field" role="row">
              <span>Artwork</span>
              <label>
                <input type="radio" name="field-artwork" checked={artwork === "current"} onChange={() => setArtwork("current")} />
                {comparison.artwork.current ? <img src={artworkUrl(comparison.artwork.current, 64)} alt="Current artwork" /> : "None"}
              </label>
              <label>
                <input
                  type="radio"
                  name="field-artwork"
                  checked={artwork === "candidate"}
                  disabled={!comparison.artwork.candidate}
                  onChange={() => setArtwork("candidate")}
                />
                {comparison.artwork.candidate ? <img src={artworkUrl(comparison.artwork.candidate, 64)} alt="Replacement artwork" /> : "None"}
              </label>
            </div>
          </div>

          <div className="lib-upgrade__plan">
            {plan.mode === "copy" && (
              <>
                <span>
                  The replacement is copied into your WaveMint Library as <strong>{plan.relPath}</strong>, with the metadata above.{" "}
                  {comparison.kind === "version" ? "The other version's file isn't changed." : "The file you chose isn't changed."}
                </span>
                <span>
                  {plan.currentManaged
                    ? "The current file moves to the library's archive folder."
                    : "The current file stays where it is, kept as an archived version."}
                </span>
              </>
            )}
            {plan.mode === "switch" && <span>The other version becomes this song&apos;s active version. No files are copied or changed.</span>}
            {blocked && (
              <span className="is-warn">
                Upgrades are copied into your WaveMint Library, and it doesn&apos;t have a folder yet. Choose one under Manage → WaveMint Library.
              </span>
            )}
          </div>
          {comparison.kind === "file" && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={chooseFile}>
              Choose a Different File…
            </button>
          )}
          {jobId && <p className="settings-hint">Copying and verifying the replacement…</p>}
        </div>
      )}
    </Dialog>
  );
}
