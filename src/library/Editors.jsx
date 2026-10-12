import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import { EditPreview } from "./EditPreview";
import { EDIT_FIELDS, FIELD_LABELS, displayValue, toApiValue, toFormValue } from "./fields";
import { pluralize } from "./format";
import { CloseIcon, EditIcon, WarningIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

export function GenreOptions({ id }) {
  const { data: taxonomy } = useLoader(() => libraryApi.listGenreTaxonomy(), []);
  const { data: used } = useLoader(() => libraryApi.listGenres(), []);
  const names = useMemo(
    () => [...new Set([...(taxonomy || []).map((genre) => genre.name), ...(used || []).map((genre) => genre.name).filter(Boolean)])].sort((a, b) => a.localeCompare(b)),
    [taxonomy, used],
  );
  return (
    <datalist id={id}>
      {names.map((name) => (
        <option key={name} value={name} />
      ))}
    </datalist>
  );
}

function FieldInput({ field, value, onChange, placeholder, listId, changed, original }) {
  if (field.type === "bool") {
    return (
      <label className={`settings-toggle lib-edit__bool ${changed ? "is-changed" : ""}`}>
        <input type="checkbox" checked={!!value} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }

  return (
    <label className={`form-field lib-edit__field ${field.wide ? "is-wide" : ""} ${field.type === "number" ? "is-number" : ""} ${changed ? "is-changed" : ""}`}>
      <span className="form-field__label">{field.label}</span>
      <input
        className="field"
        type={field.type === "number" ? "number" : "text"}
        min={field.type === "number" ? 0 : undefined}
        value={value}
        placeholder={placeholder}
        list={field.key === "genre" ? listId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {changed && original !== undefined && (
        <span className="lib-edit__original">Was: {displayValue(original)}</span>
      )}
    </label>
  );
}

/** Tag status of one song: in sync, unsaved, or not writable here. */
function TagStatus({ track, onWriteTags }) {
  const active = track.files.find((file) => file.id === track.active_file_id);
  if (!track.tags_dirty || !active) return null;
  const editable = ["mp3", "m4a", "m4b", "flac"].includes(String(active.ext).replace(".", "").toLowerCase());

  let note;
  if (active.source_read_only) {
    note = `Saved in WaveMint. "${active.source_name}" is read-only, so the file keeps its old tags until you consolidate it into your managed library.`;
  } else if (!editable) {
    note = "Saved in WaveMint. WaveMint doesn't change tags in this file format.";
  }

  return (
    <div className="lib-tagstatus">
      <WarningIcon size={14} />
      <span>{note || "Saved in WaveMint, not yet written to the file."}</span>
      {!note && (
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => onWriteTags([track.id])}>
          Write to File…
        </button>
      )}
    </div>
  );
}

/** Editor for one song (inside the details panel). */
export function TrackEditor({ track, onChanged, onError, onWriteTags }) {
  const initial = useMemo(
    () => Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, toFormValue(field, track[field.column])])),
    [track],
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  // "Saved · Undo" belongs to this song; another song starts fresh.
  useEffect(() => {
    setSaved(null);
  }, [track.id]);

  const changedKeys = EDIT_FIELDS.filter((field) => form[field.key] !== initial[field.key]).map((field) => field.key);

  const save = async () => {
    setSaving(true);
    try {
      const fields = {};
      for (const field of EDIT_FIELDS) if (changedKeys.includes(field.key)) fields[field.key] = toApiValue(field, form[field.key]);
      const result = await libraryApi.applyEdits({ edits: [{ trackId: track.id, fields }], label: `Edit "${track.title || "song"}"` });
      setSaved(result);
      onChanged?.();
    } catch (error) {
      onError?.(errorMessage(error, "The changes couldn't be saved"));
    } finally {
      setSaving(false);
    }
  };

  const undo = async () => {
    try {
      await libraryApi.undoOperation({ id: saved.operationId });
      setSaved(null);
      onChanged?.();
    } catch (error) {
      onError?.(errorMessage(error));
    }
  };

  const artworkAction = async (action) => {
    try {
      const result = await action();
      if (result) onChanged?.();
    } catch (error) {
      onError?.(errorMessage(error));
    }
  };

  return (
    <div className="lib-edit">
      <GenreOptions id={`genres-${track.id}`} />
      <div className="lib-edit__grid">
        {EDIT_FIELDS.map((field) => (
          <FieldInput
            key={field.key}
            field={field}
            value={form[field.key]}
            listId={`genres-${track.id}`}
            changed={changedKeys.includes(field.key)}
            original={initial[field.key]}
            onChange={(value) => setForm((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
      </div>

      <div className="lib-edit__actions">
        <button type="button" className={`btn btn--primary btn--sm ${saving ? "is-loading" : ""}`} onClick={save} disabled={!changedKeys.length || saving}>
          Save {changedKeys.length ? pluralize(changedKeys.length, "change") : ""}
        </button>
        {changedKeys.length > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setForm(initial)}>
            Discard
          </button>
        )}
        {saved?.operationId && !changedKeys.length && (
          <span className="lib-edit__saved">
            Saved.{" "}
            <button type="button" className="btn btn--link" onClick={undo}>
              Undo
            </button>
          </span>
        )}
      </div>

      <div className="lib-edit__artwork">
        <span className="form-field__label">Artwork</span>
        <div className="lib-edit__artwork-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => artworkAction(() => libraryApi.setArtworkFromDialog({ trackIds: [track.id] }))}>
            Choose Image…
          </button>
          {track.artwork_hash && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => artworkAction(() => libraryApi.clearArtwork({ trackIds: [track.id] }))}>
              Use the File&apos;s Artwork
            </button>
          )}
        </div>
      </div>

      <TagStatus track={track} onWriteTags={onWriteTags} />
    </div>
  );
}

/** Editor for several songs at once. Empty fields keep each song's value. */
export function BulkEditor({ trackIds, query, onClose, onChanged, onError, onWriteTags }) {
  const ids = useMemo(() => [...trackIds], [trackIds]);
  const [form, setForm] = useState(() => Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, field.type === "bool" ? null : ""])));
  const [cleared, setCleared] = useState(() => new Set());
  const [pendingEdits, setPendingEdits] = useState(null);
  const [pendingLabel, setPendingLabel] = useState("");

  // Values all selected songs already share are shown as placeholders.
  const { data: shared } = useLoader(async () => {
    const result = await libraryApi.listTracks({ filters: { ids: ids.slice(0, 1000) }, limit: 1000 });
    const values = {};
    for (const field of EDIT_FIELDS) {
      const set = new Set(result.rows.map((row) => row[field.column] ?? ""));
      values[field.key] = set.size === 1 ? [...set][0] : undefined;
    }
    return values;
  }, [ids.join(",")]);

  const fieldsToApply = () => {
    const fields = {};
    for (const field of EDIT_FIELDS) {
      if (cleared.has(field.key)) fields[field.key] = field.type === "number" ? 0 : field.type === "bool" ? false : "";
      else if (field.type === "bool" ? form[field.key] !== null : String(form[field.key]).trim() !== "") {
        fields[field.key] = toApiValue(field, form[field.key]);
      }
    }
    return fields;
  };

  const review = () => {
    const fields = fieldsToApply();
    if (!Object.keys(fields).length) return;
    setPendingLabel(`Edit ${ids.length} songs`);
    setPendingEdits(ids.map((trackId) => ({ trackId, fields })));
  };

  const titleCase = async () => {
    try {
      setPendingLabel("Fix capitalization");
      setPendingEdits(await libraryApi.suggestTitleCase({ trackIds: ids }));
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  // Numbers the selected songs 1..N in the order they are listed.
  const numberTracks = async () => {
    try {
      const ordered = await libraryApi.listTracks({ ...query, filters: { ...query.filters, ids }, limit: 1000 });
      setPendingLabel("Number tracks");
      setPendingEdits(ordered.rows.map((row, index) => ({ trackId: row.id, fields: { trackNo: index + 1, trackTotal: ordered.rows.length } })));
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const coverForAll = async () => {
    try {
      const result = await libraryApi.setArtworkFromDialog({ trackIds: ids });
      if (result) onChanged();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const hasInput = Object.keys(fieldsToApply()).length > 0;

  return (
    <aside className="lib-detail" aria-label="Edit several songs">
      <div className="lib-detail__header">
        <span className="section-label">Edit {pluralize(ids.length, "song")}</span>
        <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close bulk editor">
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="lib-detail__body">
        <p className="settings-help">Fill in only what should change. Empty fields keep each song&apos;s own value.</p>
        <GenreOptions id="genres-bulk" />
        <div className="lib-edit__grid">
          {EDIT_FIELDS.map((field) =>
            field.type === "bool" ? (
              <label key={field.key} className="settings-toggle lib-edit__bool is-wide">
                <select
                  className="field"
                  value={form[field.key] === null ? "" : form[field.key] ? "yes" : "no"}
                  onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value === "" ? null : event.target.value === "yes" }))}
                >
                  <option value="">Keep existing</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
                <span>{field.label}</span>
              </label>
            ) : (
              <div key={field.key} className={`lib-edit__bulkfield ${field.wide ? "is-wide" : ""} ${field.type === "number" ? "is-number" : ""}`}>
                <FieldInput
                  field={field}
                  value={cleared.has(field.key) ? "" : form[field.key]}
                  listId="genres-bulk"
                  placeholder={
                    cleared.has(field.key)
                      ? "Will be cleared"
                      : shared && shared[field.key] !== undefined
                        ? `${displayValue(shared[field.key])} (all)`
                        : "Keep existing"
                  }
                  changed={cleared.has(field.key) || String(form[field.key]).trim() !== ""}
                  onChange={(value) => {
                    setCleared((current) => {
                      const next = new Set(current);
                      next.delete(field.key);
                      return next;
                    });
                    setForm((current) => ({ ...current, [field.key]: value }));
                  }}
                />
                {!field.type && (
                  <button
                    type="button"
                    className="btn btn--link lib-edit__clear"
                    onClick={() =>
                      setCleared((current) => {
                        const next = new Set(current);
                        if (next.has(field.key)) next.delete(field.key);
                        else next.add(field.key);
                        return next;
                      })
                    }
                  >
                    {cleared.has(field.key) ? "Keep" : "Clear"}
                  </button>
                )}
              </div>
            ),
          )}
        </div>

        <div className="lib-edit__actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={review} disabled={!hasInput}>
            Review Changes…
          </button>
        </div>

        <span className="section-label lib-detail__section">Tools</span>
        <div className="lib-edit__tools">
          <button type="button" className="btn btn--ghost btn--sm" onClick={titleCase}>
            <EditIcon size={14} /> Title Case Titles
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={numberTracks}>
            Number Tracks 1–{ids.length}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={coverForAll}>
            Use One Cover for All…
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onWriteTags(ids)}>
            Write Tags to Files…
          </button>
        </div>
        <p className="settings-note">Track numbers follow the order the songs are listed in.</p>
      </div>

      {pendingEdits && (
        <EditPreview
          title={pendingLabel}
          edits={pendingEdits}
          label={pendingLabel}
          onClose={() => setPendingEdits(null)}
          onApplied={() => {
            setPendingEdits(null);
            setForm(Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, field.type === "bool" ? null : ""])));
            setCleared(new Set());
            onChanged();
          }}
        />
      )}
    </aside>
  );
}

/** Writes saved WaveMint changes into the files (preview first). */
export function WriteTagsDialog({ trackIds = null, onClose, onStarted }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    libraryApi
      .previewTagWrite({ trackIds: trackIds || undefined })
      .then(setPreview)
      .catch((err) => setError(errorMessage(err)));
  }, [trackIds]);

  const start = async () => {
    setStarting(true);
    try {
      await libraryApi.writeTags({ trackIds: trackIds || undefined });
      onStarted?.();
    } catch (err) {
      setError(errorMessage(err));
      setStarting(false);
    }
  };

  const writable = preview?.writable || [];
  const blocked = preview?.blocked || [];

  return (
    <Dialog
      title="Write tags to files"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="settings-hint">Each file is backed up and verified first. You can undo this in History.</span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn btn--primary ${starting ? "is-loading" : ""}`} onClick={start} disabled={!writable.length || starting}>
            Write {pluralize(writable.length, "file")}
          </button>
        </>
      }
    >
      {error && (
        <div className="alert alert--compact" role="alert">
          {error}
        </div>
      )}
      {!preview && !error && <p className="text-muted">Comparing WaveMint with the files…</p>}
      {preview && !writable.length && !blocked.length && <p className="text-muted">The files already match WaveMint. Nothing to write.</p>}

      {writable.length > 0 && (
        <>
          <span className="section-label">Will be updated ({writable.length})</span>
          <div className="lib-preview lib-preview--compact">
            {writable.slice(0, 300).map((item) => (
              <div key={item.trackId} className="lib-preview__item">
                <strong>{item.title || "Untitled"}</strong>
                <span className="text-muted"> — {item.changes.map((change) => FIELD_LABELS[change.field] || change.field).join(", ")}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {blocked.length > 0 && (
        <>
          <span className="section-label lib-detail__section">Not written ({blocked.length})</span>
          <div className="lib-preview lib-preview--compact">
            {blocked.slice(0, 300).map((item) => (
              <div key={item.trackId} className="lib-preview__item">
                <strong>{item.title || "Untitled"}</strong>
                <span className="text-muted"> — {item.reason}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Album-level editing: one form for every song on the album. */
export function AlbumEditor({ album, onClose, onChanged, onError }) {
  const fields = EDIT_FIELDS.filter((field) => ["album", "albumArtist", "year", "genre", "discTotal", "compilation"].includes(field.key));
  const initial = useMemo(
    () => ({
      album: album.title || "",
      albumArtist: album.album_artist || "",
      year: album.year ? String(album.year) : "",
      genre: album.genres && !album.genres.includes(",") ? album.genres : "",
      discTotal: "",
      compilation: album.release_type === "compilation",
    }),
    [album],
  );
  const [form, setForm] = useState(initial);
  const [pending, setPending] = useState(null);

  const review = async () => {
    const changed = {};
    for (const field of fields) {
      if (form[field.key] === initial[field.key]) continue;
      if (field.type !== "bool" && String(form[field.key]).trim() === "" && field.key !== "albumArtist") continue;
      changed[field.key] = toApiValue(field, form[field.key]);
    }
    if (!Object.keys(changed).length) return;
    try {
      const trackIds = await libraryApi.albumTrackIds({ releaseId: album.id });
      setPending(trackIds.map((trackId) => ({ trackId, fields: changed })));
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const cover = async () => {
    try {
      const trackIds = await libraryApi.albumTrackIds({ releaseId: album.id });
      const result = await libraryApi.setArtworkFromDialog({ trackIds });
      if (result) onChanged();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  return (
    <Dialog
      title="Edit album"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={review}>
            Review Changes…
          </button>
        </>
      }
    >
      <p className="settings-help">
        These values apply to all {pluralize(album.track_count, "song")} on this album. Song titles, artists and track
        numbers stay as they are.
      </p>
      <GenreOptions id="genres-album" />
      <div className="lib-edit__grid">
        {fields.map((field) => (
          <FieldInput
            key={field.key}
            field={field}
            value={form[field.key]}
            listId="genres-album"
            changed={form[field.key] !== initial[field.key]}
            original={initial[field.key]}
            onChange={(value) => setForm((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
      </div>
      <div className="lib-edit__artwork">
        <span className="form-field__label">Artwork</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={cover}>
          Choose Cover for the Album…
        </button>
      </div>

      {pending && (
        <EditPreview
          title="Album changes"
          edits={pending}
          label={`Edit album "${album.title}"`}
          onClose={() => setPending(null)}
          onApplied={() => {
            setPending(null);
            onChanged();
            onClose();
          }}
        />
      )}
    </Dialog>
  );
}
