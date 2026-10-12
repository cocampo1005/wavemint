import { useState } from "react";
import { Dialog } from "./Dialog";
import { pluralize } from "./format";
import { errorMessage, libraryApi, useLoader } from "./useLibrary";

const TABS = [
  ["genres", "Your genres"],
  ["labels", "Unrecognized labels"],
  ["similar", "Similar names"],
  ["rules", "Rules"],
];

function GenreSelect({ genres, value, onChange, placeholder = "Choose a genre", exclude }) {
  return (
    <select className="field" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)}>
      <option value="">{placeholder}</option>
      {genres
        .filter((genre) => genre.id !== exclude)
        .map((genre) => (
          <option key={genre.id} value={genre.id}>
            {genre.parent_name ? `${genre.parent_name} › ` : ""}
            {genre.name}
          </option>
        ))}
    </select>
  );
}

function GenreRow({ genre, genres, onAction, onOpenGenre }) {
  const [mode, setMode] = useState(null); // rename | merge | alias
  const [value, setValue] = useState("");
  const [target, setTarget] = useState(null);

  const close = () => {
    setMode(null);
    setValue("");
    setTarget(null);
  };

  return (
    <div className="lib-genre-row">
      <div className="lib-genre-row__main">
        <button type="button" className="btn btn--link lib-genre-row__name" onClick={() => onOpenGenre(genre.name)}>
          {genre.name}
        </button>
        <span className="lib-genre-row__meta">
          {pluralize(genre.track_count, "song")}
          {genre.parent_name ? ` · under ${genre.parent_name}` : ""}
          {genre.aliases.length ? ` · also: ${genre.aliases.join(", ")}` : ""}
        </span>
      </div>

      {mode === null && (
        <div className="lib-genre-row__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setMode("rename"); setValue(genre.name); }}>
            Rename
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMode("merge")}>
            Merge Into…
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMode("alias")}>
            Add Alias
          </button>
          <select
            className="field lib-genre-row__parent"
            value={genre.parent_id || ""}
            aria-label={`Parent category of ${genre.name}`}
            onChange={(event) => onAction(() => libraryApi.setGenreParent({ id: genre.id, parentId: Number(event.target.value) || undefined }))}
          >
            <option value="">No parent</option>
            {genres
              .filter((item) => item.id !== genre.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  Under {item.name}
                </option>
              ))}
          </select>
          {genre.track_count === 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onAction(() => libraryApi.deleteGenre({ id: genre.id }))}>
              Remove
            </button>
          )}
        </div>
      )}

      {mode === "rename" && (
        <form
          className="lib-genre-row__form"
          onSubmit={(event) => {
            event.preventDefault();
            onAction(() => libraryApi.renameGenre({ id: genre.id, name: value })).then(close);
          }}
        >
          <input className="field" value={value} onChange={(event) => setValue(event.target.value)} aria-label="New name" autoFocus />
          <span className="settings-hint">Retags {pluralize(genre.track_count, "song")}; the old name is kept as an alias.</span>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!value.trim()}>
            Rename
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={close}>
            Cancel
          </button>
        </form>
      )}

      {mode === "merge" && (
        <div className="lib-genre-row__form">
          <GenreSelect genres={genres} value={target} onChange={setTarget} exclude={genre.id} placeholder="Merge into…" />
          <span className="settings-hint">Moves {pluralize(genre.track_count, "song")} and removes &ldquo;{genre.name}&rdquo;.</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!target}
            onClick={() => onAction(() => libraryApi.mergeGenres({ targetId: target, genreIds: [genre.id] })).then(close)}
          >
            Merge
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={close}>
            Cancel
          </button>
        </div>
      )}

      {mode === "alias" && (
        <form
          className="lib-genre-row__form"
          onSubmit={(event) => {
            event.preventDefault();
            onAction(() => libraryApi.addGenreAlias({ alias: value, genreId: genre.id })).then(close);
          }}
        >
          <input className="field" value={value} placeholder="e.g. Alt Rock" onChange={(event) => setValue(event.target.value)} aria-label="Alias" autoFocus />
          <span className="settings-hint">Songs labeled this way are mapped to &ldquo;{genre.name}&rdquo; when you apply rules.</span>
          <button type="submit" className="btn btn--primary btn--sm" disabled={!value.trim()}>
            Add
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={close}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}

function RulesPreview({ onClose, onApplied, onError }) {
  const { data, error } = useLoader(() => libraryApi.previewGenreRules(), []);
  const [excluded, setExcluded] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const count = (data || []).filter((item) => !excluded.has(item.trackId)).length;

  return (
    <Dialog
      title="Apply genre rules"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="settings-hint">Genres you set by hand are never changed by rules.</span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn--primary ${busy ? "is-loading" : ""}`}
            disabled={!count || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await libraryApi.applyGenreRules({ exclude: [...excluded] });
                onApplied();
              } catch (err) {
                onError(errorMessage(err));
                setBusy(false);
              }
            }}
          >
            Apply to {pluralize(count, "song")}
          </button>
        </>
      }
    >
      {error && <div className="alert alert--compact">{error}</div>}
      {data && !data.length && <p className="text-muted">Your rules don&apos;t change any songs right now.</p>}
      {data?.length > 0 && (
        <div className="lib-preview">
          <div className="lib-preview__row lib-preview__row--head">
            <span />
            <span>Song</span>
            <span>Reason</span>
            <span>Existing</span>
            <span>Proposed</span>
          </div>
          {data.slice(0, 500).map((item) => (
            <label key={item.trackId} className={`lib-preview__row ${excluded.has(item.trackId) ? "is-off" : ""}`}>
              <input
                type="checkbox"
                checked={!excluded.has(item.trackId)}
                onChange={() =>
                  setExcluded((current) => {
                    const next = new Set(current);
                    if (next.has(item.trackId)) next.delete(item.trackId);
                    else next.add(item.trackId);
                    return next;
                  })
                }
              />
              <span className="lib-preview__song">
                {item.title} — {item.artist}
              </span>
              <span className="text-muted">{item.reason}</span>
              <span className="lib-preview__old">{item.from || "—"}</span>
              <span className="lib-preview__new">{item.to}</span>
            </label>
          ))}
        </div>
      )}
    </Dialog>
  );
}

export function GenreManager({ revision, onChanged, onOpenGenre, onError }) {
  const [tab, setTab] = useState("genres");
  const [newGenre, setNewGenre] = useState("");
  const [ruleKind, setRuleKind] = useState("artist");
  const [ruleArtist, setRuleArtist] = useState("");
  const [ruleAlbum, setRuleAlbum] = useState(null);
  const [ruleGenre, setRuleGenre] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [mapTargets, setMapTargets] = useState({});

  const { data: genres } = useLoader(() => libraryApi.listGenreTaxonomy(), [revision]);
  const { data: report } = useLoader(() => libraryApi.genreReport(), [revision]);
  const { data: rules } = useLoader(() => libraryApi.listGenreRules(), [revision]);
  const { data: artists } = useLoader(() => libraryApi.listArtists({ limit: 2000 }), [revision]);
  const { data: albums } = useLoader(() => libraryApi.listAlbums({ limit: 1000, sort: "artist" }), [revision]);

  const run = async (action) => {
    try {
      await action();
      onChanged();
    } catch (error) {
      onError(errorMessage(error));
      throw error;
    }
  };
  const runQuiet = (action) => run(action).catch(() => {});

  const list = genres || [];
  const counts = {
    genres: list.length,
    labels: report?.unrecognized.length || 0,
    similar: report?.similar.length || 0,
    rules: rules?.length || 0,
  };

  return (
    <div className="lib-genres">
      <div className="lib-toolbar">
        <div className="segmented" role="tablist" aria-label="Genre manager">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`segmented__option ${tab === value ? "is-active" : ""}`}
              onClick={() => setTab(value)}
            >
              {label}
              {counts[value] ? <span className="lib-tab-count">{counts[value]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      {tab === "genres" && (
        <section className="panel lib-panel">
          <form
            className="lib-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              runQuiet(() => libraryApi.createGenre({ name: newGenre })).then(() => setNewGenre(""));
            }}
          >
            <input className="field" placeholder="New genre, e.g. Baroque Pop" value={newGenre} onChange={(event) => setNewGenre(event.target.value)} aria-label="New genre" />
            <button type="submit" className="btn btn--primary btn--sm" disabled={!newGenre.trim()}>
              Add Genre
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => runQuiet(() => libraryApi.adoptGenreLabels({}))}>
              Add All Current Labels
            </button>
          </form>
          <p className="settings-note">
            Your genres are the vocabulary WaveMint uses. The primary genre is what gets written into files (and what Apple
            Music shows); parents and aliases stay inside WaveMint.
          </p>
          <div className="lib-genre-list">
            {list.map((genre) => (
              <GenreRow key={genre.id} genre={genre} genres={list} onAction={run} onOpenGenre={onOpenGenre} />
            ))}
            {!list.length && <p className="lib-empty-note">No genres yet. Add your own, or start from the labels already in your library.</p>}
          </div>
        </section>
      )}

      {tab === "labels" && (
        <section className="panel lib-panel">
          <p className="settings-help">Genre labels on your songs that aren&apos;t in your genre list.</p>
          <div className="lib-genre-list">
            {(report?.unrecognized || []).map((row) => (
              <div key={row.label} className="lib-genre-row">
                <div className="lib-genre-row__main">
                  <button type="button" className="btn btn--link lib-genre-row__name" onClick={() => onOpenGenre(row.label)}>
                    {row.label}
                  </button>
                  <span className="lib-genre-row__meta">
                    {pluralize(row.track_count, "song")}
                    {row.suggestion ? ` · looks like "${row.suggestion.name}" (${row.suggestion.reason})` : ""}
                  </span>
                </div>
                <div className="lib-genre-row__actions">
                  <GenreSelect
                    genres={list}
                    value={mapTargets[row.label] ?? row.suggestion?.id}
                    onChange={(value) => setMapTargets((current) => ({ ...current, [row.label]: value }))}
                    placeholder="Map to…"
                  />
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    disabled={!(mapTargets[row.label] ?? row.suggestion?.id)}
                    onClick={() => runQuiet(() => libraryApi.mergeGenres({ targetId: mapTargets[row.label] ?? row.suggestion.id, labels: [row.label] }))}
                  >
                    Map
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => runQuiet(() => libraryApi.createGenre({ name: row.label }))}>
                    Add as Genre
                  </button>
                </div>
              </div>
            ))}
            {report && !report.unrecognized.length && <p className="lib-empty-note">Every genre label on your songs is in your genre list.</p>}
          </div>
        </section>
      )}

      {tab === "similar" && (
        <section className="panel lib-panel">
          <p className="settings-help">Names that differ only in spelling, spacing or punctuation.</p>
          <div className="lib-genre-list">
            {(report?.similar || []).map((group) => {
              const inTaxonomy = list.filter((genre) => group.some((name) => name.toLowerCase() === genre.name.toLowerCase()));
              return (
                <div key={group.join("|")} className="lib-genre-row">
                  <div className="lib-genre-row__main">
                    <span className="lib-genre-row__name">{group.join(" · ")}</span>
                  </div>
                  <div className="lib-genre-row__actions">
                    {inTaxonomy.map((genre) => (
                      <button
                        key={genre.id}
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() =>
                          runQuiet(() =>
                            libraryApi.mergeGenres({
                              targetId: genre.id,
                              labels: group.filter((name) => name.toLowerCase() !== genre.name.toLowerCase()),
                              genreIds: inTaxonomy.filter((item) => item.id !== genre.id).map((item) => item.id),
                            }),
                          )
                        }
                      >
                        Use &ldquo;{genre.name}&rdquo;
                      </button>
                    ))}
                    {!inTaxonomy.length && <span className="settings-hint">Add one spelling to your genres first to merge the others into it.</span>}
                  </div>
                </div>
              );
            })}
            {report && !report.similar.length && <p className="lib-empty-note">No near-duplicate genre names found.</p>}
          </div>
        </section>
      )}

      {tab === "rules" && (
        <section className="panel lib-panel">
          <p className="settings-help">
            Default genres for artists or albums. An album rule beats an artist rule; a genre you set by hand always wins
            and is never overwritten.
          </p>
          <div className="lib-inline-form">
            <select className="field" value={ruleKind} onChange={(event) => setRuleKind(event.target.value)} aria-label="Rule type">
              <option value="artist">Artist</option>
              <option value="album">Album</option>
            </select>
            {ruleKind === "artist" ? (
              <select className="field" value={ruleArtist} onChange={(event) => setRuleArtist(event.target.value)} aria-label="Artist">
                <option value="">Choose an artist</option>
                {(artists?.rows || []).map((artist) => (
                  <option key={artist.key} value={artist.name}>
                    {artist.name}
                  </option>
                ))}
              </select>
            ) : (
              <select className="field" value={ruleAlbum || ""} onChange={(event) => setRuleAlbum(Number(event.target.value) || null)} aria-label="Album">
                <option value="">Choose an album</option>
                {(albums?.rows || []).map((album) => (
                  <option key={album.id} value={album.id}>
                    {album.title} — {album.album_artist || "Various"}
                  </option>
                ))}
              </select>
            )}
            <GenreSelect genres={list} value={ruleGenre} onChange={setRuleGenre} placeholder="Genre…" />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={!ruleGenre || (ruleKind === "artist" ? !ruleArtist : !ruleAlbum)}
              onClick={() =>
                runQuiet(() =>
                  libraryApi.addGenreRule({ kind: ruleKind, artist: ruleArtist || undefined, releaseId: ruleAlbum || undefined, genreId: ruleGenre }),
                )
              }
            >
              Add Rule
            </button>
          </div>

          <div className="lib-genre-list">
            {(rules || []).map((rule) => (
              <div key={rule.id} className={`lib-genre-row ${rule.enabled ? "" : "is-disabled"}`}>
                <div className="lib-genre-row__main">
                  <span className="lib-genre-row__name">
                    {rule.kind === "artist" ? "Artist" : "Album"}: {rule.match_label} → {rule.genre_name}
                  </span>
                  <span className="lib-genre-row__meta">{pluralize(rule.track_count, "song")}</span>
                </div>
                <div className="lib-genre-row__actions">
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={!!rule.enabled}
                      onChange={(event) => runQuiet(() => libraryApi.updateGenreRule({ id: rule.id, enabled: event.target.checked }))}
                    />
                    <span>On</span>
                  </label>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => runQuiet(() => libraryApi.removeGenreRule({ id: rule.id }))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {rules && !rules.length && <p className="lib-empty-note">No rules yet.</p>}
          </div>

          <div className="lib-edit__actions">
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowRules(true)}>
              Preview and Apply Rules…
            </button>
          </div>
          {showRules && (
            <RulesPreview
              onClose={() => setShowRules(false)}
              onError={onError}
              onApplied={() => {
                setShowRules(false);
                onChanged();
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
