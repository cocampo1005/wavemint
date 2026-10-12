import { useState } from "react";
import { artworkUrl, formatDuration, formatLongDuration, pluralize } from "./format";
import { CloseIcon, PauseIcon, PlayIcon, PlaylistIcon } from "./icons";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const FIELDS = {
  genre: { label: "Genre", ops: [["is", "is"], ["is_not", "is not"], ["contains", "contains"]], input: "text" },
  artist: { label: "Artist", ops: [["is", "is"], ["contains", "contains"]], input: "text" },
  album: { label: "Album", ops: [["is", "is"], ["contains", "contains"]], input: "text" },
  year: { label: "Year", ops: [["is", "is"], ["gte", "is at least"], ["lte", "is at most"]], input: "number" },
  quality: {
    label: "Quality status",
    ops: [["is", "is"]],
    input: "select",
    options: [
      ["unknown", "Quality unknown"],
      ["review_suggested", "Review suggested"],
      ["acceptable", "Acceptable"],
      ["user_marked_poor", "Marked poor"],
      ["upgrade_available", "Upgrade available"],
      ["upgraded", "Upgraded"],
      ["keep_original", "Kept original"],
    ],
  },
  added: { label: "Date added", ops: [["within_days", "in the last … days"], ["before_days", "more than … days ago"]], input: "number" },
  review: { label: "Review", ops: [["has_open", "has open issues"], ["none_open", "has no open issues"]], input: "none" },
  rating: { label: "Rating", ops: [["gte", "is at least"]], input: "number" },
  format: { label: "Format", ops: [["is", "codec is"], ["lossless", "is lossless"], ["lossy", "is lossy"]], input: "text" },
  source: {
    label: "Source",
    ops: [["is", "is"]],
    input: "select",
    options: [
      ["curated", "Curated"],
      ["legacy", "Legacy"],
      ["managed", "WaveMint Library"],
      ["other", "Other"],
    ],
  },
};
const NO_VALUE = new Set(["has_open", "none_open", "lossless", "lossy"]);

function SmartRulesEditor({ rules, onChange }) {
  const set = (patch) => onChange({ ...rules, ...patch });
  const setCondition = (index, patch) => set({ conditions: rules.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)) });
  return (
    <div className="lib-smart">
      <div className="lib-smart__head">
        Songs matching
        <select className="field" value={rules.match} onChange={(event) => set({ match: event.target.value })}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        of these rules
      </div>
      {rules.conditions.map((condition, index) => {
        const field = FIELDS[condition.field];
        return (
          <div key={index} className="lib-smart__rule">
            <select
              className="field"
              aria-label="Field"
              value={condition.field}
              onChange={(event) => setCondition(index, { field: event.target.value, op: FIELDS[event.target.value].ops[0][0], value: FIELDS[event.target.value].options?.[0]?.[0] ?? "" })}
            >
              {Object.entries(FIELDS).map(([key, item]) => (
                <option key={key} value={key}>
                  {item.label}
                </option>
              ))}
            </select>
            <select className="field" aria-label="Condition" value={condition.op} onChange={(event) => setCondition(index, { op: event.target.value })}>
              {field.ops.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {!NO_VALUE.has(condition.op) && field.input === "select" && (
              <select className="field" aria-label="Value" value={condition.value} onChange={(event) => setCondition(index, { value: event.target.value })}>
                {field.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            {!NO_VALUE.has(condition.op) && (field.input === "text" || field.input === "number") && (
              <input
                className="field"
                aria-label="Value"
                type={field.input === "number" ? "number" : "text"}
                value={condition.value ?? ""}
                onChange={(event) => setCondition(index, { value: event.target.value })}
              />
            )}
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              aria-label="Remove rule"
              disabled={rules.conditions.length === 1}
              onClick={() => set({ conditions: rules.conditions.filter((_, i) => i !== index) })}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        );
      })}
      <div className="lib-smart__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => set({ conditions: [...rules.conditions, { field: "genre", op: "is", value: "" }] })}>
          Add Rule
        </button>
        <label className="lib-smart__inline">
          Sort by
          <select className="field" value={rules.sort || "artist"} onChange={(event) => set({ sort: event.target.value })}>
            <option value="artist">Artist</option>
            <option value="album">Album</option>
            <option value="title">Title</option>
            <option value="year">Year (newest)</option>
            <option value="recent">Recently added</option>
            <option value="rating">Rating</option>
          </select>
        </label>
        <label className="lib-smart__inline">
          Limit to
          <input
            className="field"
            type="number"
            min={1}
            placeholder="all"
            value={rules.limit ?? ""}
            onChange={(event) => set({ limit: event.target.value ? Math.max(1, Math.round(Number(event.target.value))) : null })}
          />
          songs
        </label>
      </div>
    </div>
  );
}

const cleanRules = (rules) => ({
  match: rules.match,
  sort: rules.sort || "artist",
  ...(rules.limit ? { limit: rules.limit } : {}),
  conditions: rules.conditions.map((condition) => ({
    field: condition.field,
    op: condition.op,
    value: FIELDS[condition.field].input === "number" && !NO_VALUE.has(condition.op) ? Number(condition.value) : condition.value,
  })),
});

function PlaylistDetail({ id, revision, playing, onPlay, onOpenTrack, onChanged, onDeleted, onError }) {
  const { data: playlist, reload } = useLoader(() => libraryApi.getPlaylist({ id }), [id, revision]);
  const [rules, setRules] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState("");

  const act = async (action, after) => {
    try {
      const result = await action();
      reload();
      onChanged();
      after?.(result);
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  if (!playlist) return <div className="lib-loading">Loading…</div>;
  const manual = playlist.kind === "manual";
  const editing = rules || (playlist.kind === "smart" ? playlist.rules : null);
  const total = playlist.tracks.reduce((sum, row) => sum + (row.duration_ms || 0), 0);

  return (
    <div className="lib-playlist">
      <div className="lib-playlist__head">
        <PlaylistIcon size={28} />
        <div className="lib-playlist__title">
          <input
            className="lib-playlist__name"
            aria-label="Playlist name"
            defaultValue={playlist.name}
            key={`n${playlist.id}${playlist.updated_at}`}
            onBlur={(event) => event.target.value.trim() && event.target.value !== playlist.name && act(() => libraryApi.updatePlaylist({ id, name: event.target.value }))}
          />
          <input
            className="lib-playlist__description"
            aria-label="Description"
            placeholder="Add a description"
            defaultValue={playlist.description}
            key={`d${playlist.id}${playlist.updated_at}`}
            onBlur={(event) => event.target.value !== playlist.description && act(() => libraryApi.updatePlaylist({ id, description: event.target.value }))}
          />
          <span className="settings-hint">
            {manual ? "Playlist" : "Smart playlist"} · {pluralize(playlist.tracks.length, "song")} · {formatLongDuration(total)}
          </span>
        </div>
        <div className="lib-playlist__actions">
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => act(() => libraryApi.exportPlaylistFile({ id, relative: false }), (result) => result && setNotice(`Exported ${pluralize(result.written, "song")} to ${result.filePath}`))}
          >
            Export M3U8…
          </button>
          {confirmDelete ? (
            <span className="lib-confirm">
              Delete this playlist? The songs stay in your library.
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => act(() => libraryApi.deletePlaylist({ id }), onDeleted)}>
                Delete
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          )}
        </div>
      </div>
      {notice && <p className="settings-hint">{notice}</p>}

      {editing && (
        <div className="panel lib-playlist__rules">
          <SmartRulesEditor rules={editing} onChange={setRules} />
          {rules && (
            <div className="lib-edit__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRules(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => act(() => libraryApi.updatePlaylist({ id, rules: cleanRules(rules) }), () => setRules(null))}>
                Save Rules
              </button>
            </div>
          )}
        </div>
      )}

      <div className="lib-playlist__tracks">
        {playlist.tracks.map((row, index) => {
          const isPlaying = playing?.fileId === row.file_id && playing.isPlaying;
          return (
            <div key={row.id} className="lib-playlist__row">
              <span className="lib-playlist__pos">{index + 1}</span>
              <button type="button" className="lib-play" aria-label={isPlaying ? "Pause" : `Play ${row.title}`} onClick={() => onPlay(row)}>
                {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
              </button>
              {row.artwork_hash ? <img className="lib-playlist__art" src={artworkUrl(row.artwork_hash, 64)} alt="" loading="lazy" /> : <span className="lib-playlist__art lib-art-placeholder" />}
              <button type="button" className="lib-playlist__text" onClick={() => onOpenTrack(row.id)}>
                <strong>{row.title || "Untitled"}</strong>
                <span>
                  {row.artist || "Unknown artist"}
                  {row.album ? ` · ${row.album}` : ""}
                </span>
              </button>
              <span className="lib-playlist__time">{formatDuration(row.duration_ms)}</span>
              {manual && (
                <span className="lib-playlist__edit">
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Move up" disabled={index === 0} onClick={() => act(() => libraryApi.movePlaylistTrack({ id, trackId: row.id, toPosition: index }))}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    aria-label="Move down"
                    disabled={index === playlist.tracks.length - 1}
                    onClick={() => act(() => libraryApi.movePlaylistTrack({ id, trackId: row.id, toPosition: index + 2 }))}
                  >
                    ↓
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove ${row.title}`} onClick={() => act(() => libraryApi.removeFromPlaylist({ id, trackIds: [row.id] }))}>
                    <CloseIcon size={12} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        {!playlist.tracks.length && (
          <p className="lib-empty-note">{manual ? "No songs yet. Select songs in Songs or Albums and choose Add to Playlist." : "No songs match these rules."}</p>
        )}
      </div>
    </div>
  );
}

export function PlaylistsView({ revision, playing, onPlay, onOpenTrack, onChanged, onError }) {
  const { data: lists, reload } = useLoader(() => libraryApi.listPlaylists(), [revision]);
  const [selected, setSelected] = useState(null);
  const [notice, setNotice] = useState("");
  const active = selected ?? lists?.[0]?.id ?? null;

  const create = async (kind) => {
    try {
      const playlist = await libraryApi.createPlaylist(
        kind === "smart"
          ? { name: "New Smart Playlist", kind: "smart", rules: { match: "all", sort: "artist", conditions: [{ field: "genre", op: "is", value: "" }] } }
          : { name: "New Playlist", kind: "manual" },
      );
      setSelected(playlist.id);
      reload();
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const importFile = async () => {
    try {
      const result = await libraryApi.importPlaylistFile();
      if (!result) return;
      setSelected(result.playlist.id);
      setNotice(
        `Imported "${result.playlist.name}": ${result.matched} of ${result.total} songs found${result.unmatchedCount ? `; not in your library: ${result.unmatched.slice(0, 5).join(", ")}${result.unmatchedCount > 5 ? "…" : ""}` : ""}.`,
      );
      reload();
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  return (
    <div className="lib-review__layout lib-playlists">
      <aside className="lib-review__kinds" aria-label="Playlists">
        <div className="lib-playlists__new">
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => create("manual")}>
            New Playlist
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => create("smart")}>
            New Smart
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={importFile}>
            Import…
          </button>
        </div>
        {(lists || []).map((item) => (
          <button key={item.id} type="button" className={`lib-kind ${item.id === active ? "is-active" : ""}`} onClick={() => setSelected(item.id)}>
            <span>
              {item.kind === "smart" ? "⚙ " : ""}
              {item.name}
            </span>
            <span className="lib-kind__count">{item.count ?? "!"}</span>
          </button>
        ))}
        {lists && !lists.length && <p className="settings-hint">No playlists yet.</p>}
      </aside>
      <div className="lib-review__main">
        {notice && <p className="settings-hint">{notice}</p>}
        {active ? (
          <PlaylistDetail
            key={active}
            id={active}
            revision={revision}
            playing={playing}
            onPlay={onPlay}
            onOpenTrack={onOpenTrack}
            onChanged={() => {
              reload();
              onChanged();
            }}
            onDeleted={() => setSelected(null)}
            onError={onError}
          />
        ) : (
          <p className="lib-empty-note">Create a playlist, or import an M3U/M3U8 file.</p>
        )}
      </div>
    </div>
  );
}

/** "Add to playlist" for selected songs (manual playlists, or a new one). */
export function AddToPlaylist({ trackIds, onDone, onError }) {
  const { data: lists, reload } = useLoader(() => libraryApi.listPlaylists(), []);
  const add = async (value) => {
    if (!value) return;
    try {
      if (value === "new") {
        await libraryApi.createPlaylist({ name: "New Playlist", kind: "manual", trackIds });
        reload();
        onDone?.(`Added to a new playlist`);
      } else {
        const result = await libraryApi.addToPlaylist({ id: Number(value), trackIds });
        onDone?.(`Added ${pluralize(result.added, "song")}`);
      }
    } catch (error) {
      onError?.(errorMessage(error));
    }
  };
  return (
    <select className="field lib-add-playlist" aria-label="Add to playlist" value="" onChange={(event) => add(event.target.value)}>
      <option value="">Add to Playlist…</option>
      {(lists || [])
        .filter((item) => item.kind === "manual")
        .map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      <option value="new">New playlist</option>
    </select>
  );
}
