import { useState } from "react";
import { displayValue, FIELD_LABELS } from "./fields";
import { formatDate, pluralize } from "./format";
import { ChevronIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const STATUS_TONE = {
  completed: "success",
  partial: "warn",
  failed: "error",
  interrupted: "warn",
  running: "info",
  undone: "quiet",
};

const KIND_LABEL = {
  metadata: "Metadata",
  artwork: "Artwork",
  genre: "Genres",
  "tag-write": "Files",
  "tag-restore": "Files",
  "secondary-genres": "Genres",
  merge: "Merge",
  consolidate: "Files",
  upgrade: "Upgrade",
  quality: "Quality",
  import: "Import",
};

const STEP_LABEL = { consolidate: "Copy", upgrade: "Upgrade", "write-tags": "Write tags", "restore-tags": "Restore" };

// Merges log several low-level rows per song; show one readable line each.
function readableChanges(operation) {
  if (operation.kind !== "merge") return operation.changes;
  return operation.changes.flatMap((change) => {
    if (change.field === "merged_into" && change.new_value) {
      return [{ ...change, field: "Merged into", old_value: null, new_value: change.other_title || `Song ${change.new_value}` }];
    }
    if (change.entity_type === "decision") {
      const decision = change.new_value?.decision;
      return decision === "different" ? [{ ...change, field: "Kept separate from", old_value: null, new_value: change.other_title || "another song" }] : [];
    }
    if (change.entity_type === "track" && change.field !== "state") return [change];
    return [];
  });
}

function OperationDetail({ id }) {
  const { data } = useLoader(() => libraryApi.getOperation({ id }), [id]);
  if (!data) return <div className="lib-history__detail text-muted">Loading…</div>;

  return (
    <div className="lib-history__detail">
      {readableChanges(data).slice(0, 200).map((change) => (
        <div key={change.id} className="lib-history__change">
          <span className="lib-history__song">{change.track_title || `Song ${change.entity_id}`}</span>
          <span>{FIELD_LABELS[change.field] || change.field}</span>
          <span className="lib-preview__old">{displayValue(change.old_value)}</span>
          <span className="lib-preview__new">{displayValue(change.new_value)}</span>
        </div>
      ))}
      {data.steps.slice(0, 200).map((step) => (
        <div key={step.id} className="lib-history__change">
          <span className="lib-history__song" title={step.target_path}>
            {String(step.target_path || "").split(/[\\/]/).pop()}
          </span>
          <span>{STEP_LABEL[step.action] || step.action}</span>
          <span className={`lib-badge is-${step.state === "done" ? "success" : step.state === "failed" ? "error" : "quiet"}`}>{step.state}</span>
          <span className="text-muted">{step.error || ""}</span>
        </div>
      ))}
      {data.changes.length > 200 && <p className="settings-note">Showing the first 200 changes.</p>}
    </div>
  );
}

export function HistoryView({ revision, onChanged, onError }) {
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const { data, error } = useLoader(() => libraryApi.listOperations({ limit }), [limit, revision]);

  const undo = async (operation) => {
    setBusy(operation.id);
    try {
      const result = await libraryApi.undoOperation({ id: operation.id });
      const conflicts = result?.conflicts?.length || 0;
      if (conflicts) onError(`Undone, except ${pluralize(conflicts, "change")} that were changed again afterwards and were left as they are.`);
      onChanged();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lib-history">
      <p className="text-muted lib-history__intro">
        Every change WaveMint makes to your library. Metadata changes and merges can be undone; written files are restored
        from their verified backups. Undoing a copy into the WaveMint Library switches songs back but keeps the copies on disk.
      </p>
      {error && <div className="alert alert--compact">{error}</div>}
      <div className="lib-list">
        {(data || []).map((operation) => {
          const undoable = !!operation.undoable && !operation.was_undone && ["completed", "partial"].includes(operation.status);
          return (
            <div key={operation.id} className="lib-history__op">
              <div className="lib-history__row">
                <button type="button" className="btn btn--ghost btn--icon" onClick={() => setOpen(open === operation.id ? null : operation.id)} aria-label="Details" aria-expanded={open === operation.id}>
                  <ChevronIcon direction={open === operation.id ? "down" : "right"} size={14} />
                </button>
                <span className="lib-badge is-quiet">{KIND_LABEL[operation.kind] || operation.kind}</span>
                <span className="lib-history__label">{operation.label}</span>
                <span className="lib-history__meta">
                  {[
                    operation.change_count ? pluralize(operation.entity_count, "song") : operation.step_count ? `${operation.steps_done}/${operation.step_count} files` : "",
                    formatDate(operation.created_at),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className={`lib-badge is-${STATUS_TONE[operation.status] || "quiet"}`}>{operation.was_undone ? "undone" : operation.status}</span>
                {undoable && (
                  <button type="button" className={`btn btn--secondary btn--sm ${busy === operation.id ? "is-loading" : ""}`} disabled={!!busy} onClick={() => undo(operation)}>
                    Undo
                  </button>
                )}
              </div>
              {open === operation.id && <OperationDetail id={operation.id} />}
            </div>
          );
        })}
        {data && !data.length && <p className="lib-empty-note">No changes yet.</p>}
      </div>
      {data && data.length >= limit && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + 50)}>
          Show more
        </button>
      )}
    </div>
  );
}
