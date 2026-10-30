import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../toasts/useToast";
import { Dialog } from "./Dialog";
import { Disclosure } from "./Disclosure";
import { EditPreview } from "./EditPreview";
import { ADVANCED_FIELDS, EDIT_FIELDS, FIELD_LABELS, PRIMARY_FIELDS, PRIMARY_KEYS, displayValue, toApiValue, toFormValue } from "./fields";
import { pluralize } from "./format";
import { CloseIcon, EditIcon, WarningIcon } from "./icons";
import { AlbumInput, ArtistInput, GenreInput } from "./MetadataInputs";
import { errorMessage, libraryApi, refreshSuggestions, useLoader } from "./useLibrary";

/** The input for one field. `artist` is the form's artist, whose albums the Album field suggests. */
function FieldInput({ field, value, onChange, placeholder, artist = "", changed, original }) {
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
      {field.key === "genre" ? (
        <GenreInput value={value} onChange={onChange} placeholder={placeholder} />
      ) : field.key === "artist" || field.key === "albumArtist" ? (
        <ArtistInput value={value} onChange={onChange} placeholder={placeholder} />
      ) : field.key === "album" ? (
        <AlbumInput value={value} onChange={onChange} artist={artist} placeholder={placeholder} />
      ) : (
        <input
          className="field"
          type={field.type === "number" ? "number" : "text"}
          min={field.type === "number" ? 0 : undefined}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {changed && original !== undefined && (
        <span className="lib-edit__original">Was: {displayValue(original)}</span>
      )}
    </label>
  );
}

/** The artist whose albums a form's Album field suggests: the song artist, else the album artist. */
const formArtist = (form) => String(form.artist ?? "").trim() || String(form.albumArtist ?? "").trim();

function FieldGroup({ fields, form, initial, onChange }) {
  return fields.map((field) => (
    <FieldInput
      key={field.key}
      field={field}
      value={form[field.key]}
      artist={formArtist(form)}
      changed={form[field.key] !== initial[field.key]}
      original={initial[field.key]}
      onChange={(value) => onChange(field.key, value)}
    />
  ));
}

/**
 * The metadata form, shared by the song editor and Upgrade Track: Title,
 * Artist, Album and Genre always, every other tag under a collapsed
 * "Advanced metadata". `form` and `initial` are form values (see fields.js);
 * fields that differ from `initial` are marked with their old value. Hidden
 * fields keep their values and are saved like the visible ones.
 */
export function MetadataFields({ form, initial, onChange, disabled = false }) {
  const changedAdvanced = ADVANCED_FIELDS.filter((field) => form[field.key] !== initial[field.key]).length;
  return (
    <fieldset className="lib-edit__fieldset" disabled={disabled}>
      <div className="lib-edit__grid is-primary">
        <FieldGroup fields={PRIMARY_FIELDS} form={form} initial={initial} onChange={onChange} />
      </div>
      <Disclosure label="Advanced metadata" hint={changedAdvanced ? pluralize(changedAdvanced, "change") : ""} className="lib-edit__advanced">
        <div className="lib-edit__grid">
          <FieldGroup fields={ADVANCED_FIELDS} form={form} initial={initial} onChange={onChange} />
        </div>
      </Disclosure>
    </fieldset>
  );
}

const SOURCE_FORMATS = ["mp3", "m4a", "m4b", "flac"];

/**
 * Why this song's edits stay in WaveMint instead of its file (a read-only
 * folder, a format WaveMint doesn't tag), or that saving to the file is still
 * pending (a failed or waiting write, which can be retried). Null when the
 * file matches.
 */
function FileSaveNote({ track, onRetry, retrying }) {
  const active = track.files.find((file) => file.id === track.active_file_id);
  if (!track.tags_dirty || !active) return null;
  const editable = SOURCE_FORMATS.includes(String(active.ext).replace(".", "").toLowerCase());
  if (active.source_read_only) {
    return <p className="lib-edit__note">Saved in WaveMint. &ldquo;{active.source_name}&rdquo; is read-only, so the file keeps its old tags until the song is copied into your WaveMint Library.</p>;
  }
  if (!editable) return <p className="lib-edit__note">Saved in WaveMint. WaveMint doesn&apos;t change tags in this file format.</p>;
  return (
    <p className="lib-edit__note is-warn">
      <WarningIcon size={13} /> Saved in WaveMint, not yet in the file.{" "}
      <button type="button" className={`btn btn--link ${retrying ? "is-loading" : ""}`} disabled={retrying} onClick={onRetry}>
        Save to File
      </button>
    </p>
  );
}

const formValuesOf = (track) => Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, toFormValue(field, track[field.column])]));

/**
 * Editor for one song (inside the details panel). Save Changes writes the
 * edited fields and the chosen artwork (`pendingArtwork`, set from the
 * artwork panel: a chosen image or a found cover) into the song's file in
 * one step. Nothing is shown as saved until the file write succeeded; if it
 * fails, the form keeps the edits and says why.
 */
export function TrackEditor({ track, pendingArtwork = null, onPendingArtworkChange, onChanged }) {
  const initial = useMemo(() => formValuesOf(track), [track]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { notify } = useToast();
  const [retrying, setRetrying] = useState(false);
  const previousInitial = useRef(initial);

  // A reload (after a save, or anything else that changed the library)
  // refreshes the fields the user hasn't touched and keeps the ones they're
  // editing.
  useEffect(() => {
    const before = previousInitial.current;
    previousInitial.current = initial;
    setForm((current) => Object.fromEntries(EDIT_FIELDS.map((field) => [field.key, current[field.key] === before[field.key] ? initial[field.key] : current[field.key]])));
  }, [initial]);

  const changedKeys = EDIT_FIELDS.filter((field) => form[field.key] !== initial[field.key]).map((field) => field.key);
  const changeCount = changedKeys.length + (pendingArtwork ? 1 : 0);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const fields = {};
      for (const field of EDIT_FIELDS) if (changedKeys.includes(field.key)) fields[field.key] = toApiValue(field, form[field.key]);
      const result = await libraryApi.saveTrack({ trackId: track.id, fields, ...(pendingArtwork ? { artworkHash: pendingArtwork.hash } : {}) });
      const files = result.files || {};
      const name = `"${form.title.trim() || "Untitled"}"`;
      const text = files.deferred ? `Saved ${name}. It goes into the file when the current task finishes.` : files.blocked ? `Saved ${name} in WaveMint.` : `Saved ${name} to the file.`;
      const operationId = result.operationId;
      notify({ text, action: operationId ? { label: "Undo", onClick: () => undo(operationId) } : null });
      onPendingArtworkChange?.(null);
      refreshSuggestions();
      onChanged?.();
    } catch (err) {
      // The edits stay in the form so nothing typed is lost.
      setError(errorMessage(err, "Your changes couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(initial);
    setError("");
    onPendingArtworkChange?.(null);
  };

  const undo = async (id) => {
    try {
      await libraryApi.undoOperation({ id });
      refreshSuggestions();
      onChanged?.();
      notify({ text: "Changes undone." });
    } catch (err) {
      notify({ tone: "error", text: errorMessage(err, "That couldn't be undone.") });
    }
  };

  const retryFileSave = async () => {
    setRetrying(true);
    setError("");
    try {
      await libraryApi.writeTags({ trackIds: [track.id] });
      onChanged?.();
    } catch (err) {
      setError(errorMessage(err, "The file couldn't be saved."));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="lib-edit">
      <MetadataFields
        form={form}
        initial={initial}
        disabled={saving}
        onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
      />

      {error && (
        <p className="lib-edit__note is-error" role="alert">
          <WarningIcon size={13} /> {error}
        </p>
      )}

      <div className="lib-edit__actions">
        <button type="button" className={`btn btn--primary btn--sm ${saving ? "is-loading" : ""}`} onClick={save} disabled={!changeCount || saving}>
          Save Changes
        </button>
        {changeCount > 0 && !saving && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={discard}>
            Discard
          </button>
        )}
      </div>

      <FileSaveNote track={track} onRetry={retryFileSave} retrying={retrying} />
    </div>
  );
}

/** Editor for several songs at once. Empty fields keep each song's value. Applying saves into the files. */
export function BulkEditor({ trackIds, query, onClose, onChanged, onError }) {
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
  const advancedPending = ADVANCED_FIELDS.filter((field) => cleared.has(field.key) || (field.type === "bool" ? form[field.key] !== null : String(form[field.key]).trim() !== "")).length;

  const bulkField = (field) =>
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
          artist={field.key === "album" ? formArtist(form) || formArtist(shared || {}) : ""}
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
    );

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
        <div className="lib-edit__grid">{PRIMARY_FIELDS.map(bulkField)}</div>
        <Disclosure label="Advanced metadata" hint={advancedPending ? pluralize(advancedPending, "change") : ""} className="lib-edit__advanced">
          <div className="lib-edit__grid">{ADVANCED_FIELDS.map(bulkField)}</div>
        </Disclosure>

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

/** Retries saving changes into files that couldn't be written when they were saved (preview first). */
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
      title="Save changes to files"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="settings-hint">Each file is backed up and verified first. You can undo this in History.</span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`btn btn--primary ${starting ? "is-loading" : ""}`} onClick={start} disabled={!writable.length || starting}>
            Save {pluralize(writable.length, "file")}
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
      {preview && !writable.length && !blocked.length && <p className="text-muted">The files already match WaveMint. Nothing to save.</p>}

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
  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

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
      <div className="lib-edit__grid">
        <FieldGroup fields={fields.filter((field) => PRIMARY_KEYS.includes(field.key))} form={form} initial={initial} onChange={setField} />
      </div>
      <Disclosure label="Advanced metadata" className="lib-edit__advanced">
        <div className="lib-edit__grid">
          <FieldGroup fields={fields.filter((field) => !PRIMARY_KEYS.includes(field.key))} form={form} initial={initial} onChange={setField} />
        </div>
      </Disclosure>
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
