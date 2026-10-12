import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import { displayValue, FIELD_LABELS } from "./fields";
import { pluralize } from "./format";
import { errorMessage, libraryApi } from "./useLibrary";

/**
 * Shows exactly what an edit will change (existing → proposed, per song and
 * field) and applies only the changes left ticked. Nothing is saved before
 * the user confirms.
 */
export function EditPreview({ title = "Review changes", edits, label, onClose, onApplied }) {
  const [preview, setPreview] = useState(null);
  const [excluded, setExcluded] = useState(() => new Set());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    libraryApi
      .previewEdits({ edits })
      .then((result) => !cancelled && setPreview(result))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [edits]);

  const changeCount = useMemo(
    () => (preview || []).reduce((sum, item) => sum + item.changes.filter((change) => !excluded.has(`${item.trackId}:${change.field}`)).length, 0),
    [preview, excluded],
  );

  const toggle = (key) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      const exclude = [...excluded].map((key) => {
        const [trackId, field] = key.split(":");
        return { trackId: Number(trackId), field };
      });
      const result = await libraryApi.applyEdits({ edits, exclude, label });
      onApplied?.(result);
    } catch (err) {
      setError(errorMessage(err, "The changes couldn't be saved"));
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="settings-hint">
            Saved in WaveMint first; files are only changed when you write tags. You can undo this in History.
          </span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn btn--primary ${saving ? "is-loading" : ""}`} onClick={apply} disabled={!changeCount || saving}>
            Save {pluralize(changeCount, "change")}
          </button>
        </>
      }
    >
      {error && (
        <div className="alert alert--compact" role="alert">
          {error}
        </div>
      )}
      {!preview && !error && <p className="text-muted">Checking what would change…</p>}
      {preview && !preview.length && <p className="text-muted">Nothing would change: the songs already have these values.</p>}
      {preview && preview.length > 0 && (
        <>
          <p className="settings-help">
            {pluralize(preview.length, "song")} will change. Untick anything you want to keep as it is.
          </p>
          <div className="lib-preview">
            <div className="lib-preview__row lib-preview__row--head">
              <span />
              <span>Song</span>
              <span>Field</span>
              <span>Existing</span>
              <span>Proposed</span>
            </div>
            {preview.slice(0, 500).flatMap((item) =>
              item.changes.map((change) => {
                const key = `${item.trackId}:${change.field}`;
                const on = !excluded.has(key);
                return (
                  <label key={key} className={`lib-preview__row ${on ? "" : "is-off"}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(key)} />
                    <span className="lib-preview__song" title={`${item.title} — ${item.artist}`}>
                      {item.title || "Untitled"}
                    </span>
                    <span>{FIELD_LABELS[change.field] || change.field}</span>
                    <span className="lib-preview__old">{displayValue(change.from)}</span>
                    <span className="lib-preview__new">{displayValue(change.to)}</span>
                  </label>
                );
              }),
            )}
          </div>
          {preview.length > 500 && <p className="settings-note">Showing the first 500 songs; all {preview.length} will be changed.</p>}
        </>
      )}
    </Dialog>
  );
}
