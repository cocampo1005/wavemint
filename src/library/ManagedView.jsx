import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { formatBytes, formatNumber, pluralize } from "./format";
import { CheckIcon, FolderOpenIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useDebounced, useLoader } from "./useLibrary";

const TOKENS = ["{albumArtist}", "{artist}", "{album}", "{year}", "{disc-}", "{track}", "{title}", "{genre}"];

function NamingPattern({ initial, disabled, onSaved, onError }) {
  const [pattern, setPattern] = useState(initial);
  const debounced = useDebounced(pattern, 300);
  const [preview, setPreview] = useState({ rows: [], error: "" });

  useEffect(() => {
    let cancelled = false;
    libraryApi
      .previewNamingPattern({ pattern: debounced })
      .then((rows) => !cancelled && setPreview({ rows, error: "" }))
      .catch((error) => !cancelled && setPreview({ rows: [], error: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const save = async () => {
    try {
      await libraryApi.updateSettings({ patch: { namingPattern: pattern } });
      onSaved();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  return (
    <section className="panel lib-managed__naming" aria-labelledby="lib-naming">
      <span id="lib-naming" className="section-label">
        Folder and file names
      </span>
      <div className="lib-inline-form">
        <input
          className="field"
          value={pattern}
          disabled={disabled}
          spellCheck={false}
          aria-label="Naming pattern"
          onChange={(event) => setPattern(event.target.value)}
        />
        <button type="button" className="btn btn--secondary" disabled={disabled || pattern === initial || !!preview.error} onClick={save}>
          Save
        </button>
        {pattern !== initial && (
          <button type="button" className="btn btn--ghost" onClick={() => setPattern(initial)}>
            Reset
          </button>
        )}
      </div>
      <p className="settings-hint">
        Tokens: {TOKENS.join(" ")}. A slash starts a folder. Empty values are left out, multi-disc albums get a disc prefix, and
        compilations go under &ldquo;Various Artists&rdquo;.
      </p>
      {preview.error ? (
        <p className="lib-source__warning">
          <WarningIcon size={14} /> {preview.error}
        </p>
      ) : (
        <ul className="lib-managed__samples">
          {preview.rows.map((row) => (
            <li key={row.trackId}>{row.relPath}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CopyDialog({ preview, onClose, onStarted, onError }) {
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try {
      await libraryApi.consolidate({});
      onStarted();
    } catch (error) {
      onError(errorMessage(error));
      setStarting(false);
    }
  };

  return (
    <Dialog
      title="Copy into the WaveMint Library"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn btn--primary ${starting ? "is-loading" : ""}`} disabled={starting} onClick={start}>
            Copy {pluralize(preview.toCopy + (preview.reused || 0), "Song")}
          </button>
        </>
      }
    >
      <p>
        WaveMint will copy <strong>{pluralize(preview.toCopy, "song")}</strong> ({formatBytes(preview.bytes)}) into{" "}
        <strong>{preview.root}</strong>, check each copy against its original, and write your edited tags and artwork into the copies.
      </p>
      <p className="settings-note">
        Your original folders are only read: nothing in them is moved, renamed, changed or deleted. Existing files at the destination are
        never overwritten. You can stop at any time and continue later.
      </p>
    </Dialog>
  );
}

export function ManagedView({ revision, busy, lastJob, onChanged, onError }) {
  const { data: managed, reload } = useLoader(() => libraryApi.getManagedLibrary(), [revision]);
  const hasRoot = !!managed?.source;
  const { data: preview, error: previewError, loading } = useLoader(
    () => (hasRoot ? libraryApi.previewConsolidation({}) : null),
    [hasRoot, revision, managed?.pattern],
  );
  const [copyOpen, setCopyOpen] = useState(false);
  const [notEmpty, setNotEmpty] = useState(false);

  const chooseRoot = async () => {
    try {
      const result = await libraryApi.chooseManagedRoot();
      if (!result) return;
      setNotEmpty(!result.empty);
      reload();
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const report = lastJob?.status !== "running" ? lastJob : null;
  const lowSpace = preview && preview.freeBytes !== null && preview.freeBytes < preview.bytes * 1.02;

  return (
    <div className="lib-managed">
      <section className="panel lib-merge__intro">
        <FolderOpenIcon size={22} />
        <div>
          <strong>Your WaveMint Library</strong>
          <p className="settings-hint">
            One clean, organized folder with every song from your merged library, copied from your sources with your edits written in. Your
            original iTunes and curated folders are kept exactly as they are, as a backup.
          </p>
          {managed?.source && (
            <p className="lib-managed__root">
              <span className="lib-source__path" title={managed.source.root_path}>
                {managed.source.root_path}
              </span>
            </p>
          )}
        </div>
        <div className="lib-merge__intro-actions">
          {!hasRoot && (
            <button type="button" className="btn btn--primary" disabled={busy} onClick={chooseRoot}>
              Choose Folder…
            </button>
          )}
        </div>
      </section>

      {notEmpty && (
        <p className="lib-source__warning">
          <WarningIcon size={14} /> This folder already has files in it. WaveMint won&apos;t touch them or overwrite them, but an empty folder
          keeps things tidy.
        </p>
      )}

      {managed && (
        <NamingPattern key={managed.pattern} initial={managed.pattern} disabled={busy} onSaved={reload} onError={onError} />
      )}

      {hasRoot && (
        <section className="panel" aria-labelledby="lib-copy">
          <div className="lib-section-head">
            <span id="lib-copy" className="section-label">
              Copy songs
            </span>
          </div>
          {previewError && <div className="alert alert--compact">{previewError}</div>}
          {!preview && loading && <p className="settings-hint">Working out what to copy…</p>}
          {preview && (
            <>
              <div className="lib-managed__plan">
                <span>
                  <strong>{formatNumber(preview.toCopy)}</strong> to copy · {formatBytes(preview.bytes)}
                </span>
                <span>{formatNumber(preview.alreadyManaged)} already in the WaveMint Library</span>
                {preview.reused > 0 && <span>{pluralize(preview.reused, "earlier copy", "earlier copies")} will be used again</span>}
                {preview.tagsWritten > 0 && <span>Your edited tags go into {pluralize(preview.tagsWritten, "copy", "copies")}</span>}
                {preview.renamedForCollisions > 0 && <span>{pluralize(preview.renamedForCollisions, "name")} get a (2) suffix to avoid clashes</span>}
                {preview.unavailableCount > 0 && <span className="is-warn">{formatNumber(preview.unavailableCount)} can&apos;t be copied (missing or unreadable)</span>}
                {preview.freeBytes !== null && <span className={lowSpace ? "is-warn" : ""}>{formatBytes(preview.freeBytes)} free at the destination</span>}
              </div>
              {preview.samples.length > 0 && (
                <ul className="lib-managed__samples">
                  {preview.samples.slice(0, 8).map((sample) => (
                    <li key={sample.trackId}>{sample.relPath}</li>
                  ))}
                  {preview.toCopy > 8 && <li className="settings-hint">…and {formatNumber(preview.toCopy - 8)} more</li>}
                </ul>
              )}
              <div className="lib-edit__actions">
                {preview.toCopy + (preview.reused || 0) > 0 ? (
                  <button type="button" className="btn btn--primary" disabled={busy || lowSpace} onClick={() => setCopyOpen(true)}>
                    Copy {pluralize(preview.toCopy + (preview.reused || 0), "Song")}…
                  </button>
                ) : (
                  <span className="lib-managed__done">
                    <CheckIcon size={16} /> Every available song is in the WaveMint Library.
                  </span>
                )}
              </div>
              <p className="settings-note">Tip: merge your libraries first so each song is copied once, from its best source.</p>
            </>
          )}
        </section>
      )}

      {report?.kind === "consolidate" && (
        <section className="panel" aria-label="Last copy">
          {report.status === "failed" ? (
            <p className="lib-source__warning">
              <WarningIcon size={14} /> {report.error}
            </p>
          ) : (
            report.result && (
              <>
                <p className="lib-managed__done">
                  <CheckIcon size={16} /> Copied {pluralize(report.result.copied, "song")} ({formatBytes(report.result.bytes)})
                  {report.result.failed ? `; ${formatNumber(report.result.failed)} failed` : ""}
                  {report.status === "cancelled" || report.result.status === "partial" ? ". Stopped early; run it again to continue." : "."}
                </p>
                {report.result.failures?.map((failure, index) => (
                  <p key={index} className="settings-hint">
                    {failure.title}: {failure.error}
                  </p>
                ))}
              </>
            )
          )}
        </section>
      )}

      {copyOpen && preview && (
        <CopyDialog
          preview={preview}
          onClose={() => setCopyOpen(false)}
          onError={onError}
          onStarted={() => {
            setCopyOpen(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
