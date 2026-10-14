import { useState } from "react";
import { Dialog } from "./Dialog";
import { pluralize } from "./format";
import { TrashIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const LISTED = 8;

/**
 * Delete File: confirms which files go to the Recycle Bin (only the songs'
 * own files in folders WaveMint may change) before anything happens.
 */
export function DeleteFilesDialog({ trackIds, onClose, onDone }) {
  const { data: plan, error: loadError } = useLoader(() => libraryApi.previewFileDeletion({ trackIds }), [trackIds.join(",")]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const files = plan ? plan.items.flatMap((item) => item.files.map((file) => ({ ...file, title: item.title }))) : [];
  const songs = plan?.items.length || 0;
  const keptElsewhere = plan ? plan.items.reduce((sum, item) => sum + item.keptElsewhere, 0) : 0;

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      onDone(await libraryApi.deleteTrackFiles({ trackIds: plan.items.map((item) => item.trackId) }));
    } catch (err) {
      setError(errorMessage(err, "The files couldn't be deleted."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={songs === 1 ? "Delete this song's file?" : "Delete these songs' files?"}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <span className="settings-hint">Use Remove from Library instead to keep the files.</span>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn btn--danger ${busy ? "is-loading" : ""}`} onClick={confirm} disabled={busy || !songs}>
            <TrashIcon size={14} /> Move to Recycle Bin
          </button>
        </>
      }
    >
      {loadError && <p className="lib-upgrade__warning">{loadError}</p>}
      {plan && (
        <>
          {songs > 0 && (
            <p className="settings-help">
              {pluralize(songs, "song")} will leave your library, and {files.length === 1 ? "its file goes" : `${pluralize(files.length, "file")} go`} to the Windows Recycle Bin, where you
              can restore {files.length === 1 ? "it" : "them"}. Other songs and their artwork aren&apos;t affected.
            </p>
          )}
          {files.length > 0 && (
            <ul className="lib-delete__list">
              {files.slice(0, LISTED).map((file) => (
                <li key={file.fileId} title={file.name}>
                  {file.name} <span>· {file.sourceName}{file.missing ? " · already missing" : ""}</span>
                </li>
              ))}
              {files.length > LISTED && <li>and {pluralize(files.length - LISTED, "more file")}</li>}
            </ul>
          )}
          {keptElsewhere > 0 && <p className="settings-hint">{pluralize(keptElsewhere, "older version")} in read-only folders will be left as they are.</p>}
          {plan.blocked.map((item) => (
            <p key={item.trackId} className="lib-upgrade__warning">
              <WarningIcon size={14} /> &ldquo;{item.title || "Untitled"}&rdquo; won&apos;t be deleted. {item.reason}
            </p>
          ))}
        </>
      )}
      {error && <p className="lib-upgrade__warning">{error}</p>}
    </Dialog>
  );
}
