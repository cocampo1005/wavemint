import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { pluralize } from "./format";
import { CloseIcon, SearchIcon } from "./icons";
import { BulkEditor } from "./Editors";
import { TrackDetail } from "./TrackDetail";
import { TrackTable } from "./TrackTable";
import { QUICK_FILTERS, useDebounced } from "./useLibrary";

const SORT_OPTIONS = [
  ["added:desc", "Recently Added"],
  ["added:asc", "Oldest Added"],
  ["title:asc", "Title A–Z"],
  ["title:desc", "Title Z–A"],
  ["artist:asc", "Artist A–Z"],
  ["artist:desc", "Artist Z–A"],
  ["album:asc", "Album"],
  ["genre:asc", "Genre"],
  ["duration:desc", "Longest"],
  ["duration:asc", "Shortest"],
  ["size:desc", "Largest Files"],
];
const SORT_KEY = "wavemint.sort.v1";

function toFilters(base, quick) {
  const filters = { ...base };
  for (const key of quick) {
    if (key === "unclassified") filters.genre = "";
    else filters[key] = true;
  }
  return filters;
}

function storedSort(key) {
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(SORT_KEY))?.[key] || null;
  } catch {
    return null;
  }
}

function storeSort(key, sort) {
  if (!key) return;
  try {
    const all = JSON.parse(localStorage.getItem(SORT_KEY)) || {};
    localStorage.setItem(SORT_KEY, JSON.stringify({ ...all, [key]: sort }));
  } catch {
    // The sort order is a convenience.
  }
}

/**
 * Searchable, filterable, sortable song list with a details panel.
 * `baseFilters` scopes it (album, artist, genre, favorites…); `chips`
 * describe that scope and can be cleared with `onClearScope`. Playing a song
 * plays the list as shown (same filters and order) from that song.
 */
export function SongBrowser({
  baseFilters = {},
  initialQuick = [],
  initialActiveId = null,
  chips = [],
  onClearScope,
  revision,
  contextLabel = "Songs",
  sortStorageKey = null,
  explicitSort = false,
  onPlayFile,
  onOpenAlbum,
  onError,
  lowBitrate,
  hideColumns,
  defaultSort = "artist",
  defaultDirection = "asc",
  toolbarExtra,
  onChanged,
  onWriteTags,
  onUpgrade,
  onIdentify,
  onEditAudio,
  onToggleFavorite,
  onTrackMenu,
  emptyState = null,
  selection: controlledSelection,
  onSelectionChange: setControlledSelection,
}) {
  const player = usePlayer();
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState(initialQuick);
  // An explicit order from the caller (e.g. "View All" newest first) wins
  // over the order remembered for this list.
  const [sort, setSort] = useState(() => (!explicitSort && storedSort(sortStorageKey)) || { field: defaultSort, direction: defaultDirection });
  const [ownSelection, setOwnSelection] = useState(() => new Set());
  const [activeId, setActiveId] = useState(initialActiveId);
  const [total, setTotal] = useState(null);
  const debouncedSearch = useDebounced(search);

  const selection = controlledSelection || ownSelection;
  const setSelection = setControlledSelection || setOwnSelection;
  const baseKey = JSON.stringify(baseFilters);

  // A different scope starts with a clean selection.
  useEffect(() => {
    setSelection(new Set());
    setActiveId(initialActiveId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);

  useEffect(() => storeSort(sortStorageKey, sort), [sortStorageKey, sort]);

  const query = useMemo(
    () => ({
      search: debouncedSearch,
      filters: toFilters(JSON.parse(baseKey), quick),
      sort: sort.field,
      direction: sort.direction,
    }),
    [debouncedSearch, baseKey, quick, sort],
  );

  // A column header: same column flips the direction; dates and sizes start newest/largest first.
  const handleSort = useCallback(
    (field) =>
      setSort((current) => ({
        field,
        direction: current.field === field ? (current.direction === "asc" ? "desc" : "asc") : field === "added" || field === "size" ? "desc" : "asc",
      })),
    [],
  );

  const toggleQuick = (key) => setQuick((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

  const playRow = (row) => player.playQuery({ label: contextLabel, query, startId: row.id, rows: [row] });
  const sortValue = `${sort.field}:${sort.direction}`;
  const knownSort = SORT_OPTIONS.some(([value]) => value === sortValue);

  return (
    <div className={`lib-browser ${activeId || selection.size > 1 ? "has-detail" : ""}`}>
      <div className="lib-browser__main">
        <div className="lib-toolbar">
          <label className="lib-search">
            <SearchIcon size={16} />
            <input
              type="search"
              className="lib-search__input"
              placeholder="Search title, artist, album, genre…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search songs"
            />
          </label>
          <span className="lib-toolbar__count">
            {total === null ? "…" : pluralize(total, "song")}
            {selection.size > 0 && ` · ${pluralize(selection.size, "selected", "selected")}`}
          </span>
          {total > 0 && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => player.playQuery({ label: contextLabel, query })} title={`Play ${contextLabel} in this order`}>
              Play All
            </button>
          )}
          {toolbarExtra?.({ selection, query, clearSelection: () => setSelection(new Set()) })}
          <label className="lib-toolbar__sort">
            Sort
            <select
              className="field"
              value={sortValue}
              onChange={(event) => {
                const [field, direction] = event.target.value.split(":");
                setSort({ field, direction });
              }}
              aria-label="Sort songs"
            >
              {!knownSort && <option value={sortValue}>By column</option>}
              {SORT_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="lib-chips">
          {chips.map((chip) => (
            <span key={chip} className="lib-chip is-scope">
              {chip}
              {onClearScope && (
                <button type="button" onClick={onClearScope} aria-label={`Clear ${chip}`}>
                  <CloseIcon size={12} />
                </button>
              )}
            </span>
          ))}
          {QUICK_FILTERS.filter((filter) => !(filter.key in baseFilters)).map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`lib-chip ${quick.includes(filter.key) ? "is-on" : ""}`}
              aria-pressed={quick.includes(filter.key)}
              onClick={() => toggleQuick(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <TrackTable
          query={query}
          revision={revision}
          selection={selection}
          onSelectionChange={setSelection}
          activeId={activeId}
          onActivate={(row) => setActiveId(row.id)}
          onTotalChange={setTotal}
          playing={player.playing}
          onPlay={playRow}
          onToggleFavorite={onToggleFavorite}
          onRowMenu={
            onTrackMenu &&
            ((request) =>
              onTrackMenu({
                ...request,
                onPlayNow: request.ids.length === 1 ? () => playRow(request.row) : null,
                onEditMetadata: () => setActiveId(request.row.id),
              }))
          }
          onSort={handleSort}
          lowBitrate={lowBitrate}
          // The details panel takes room: the table gives up the least-used columns.
          hideColumns={activeId || selection.size > 1 ? [...(hideColumns || []), "genre", "added", "size"] : hideColumns}
          emptyText={search || quick.length ? "No songs match these filters." : emptyState || "No songs here yet."}
        />
      </div>

      {selection.size > 1 ? (
        <BulkEditor
          trackIds={selection}
          query={query}
          onClose={() => setSelection(new Set())}
          onChanged={onChanged}
          onError={onError}
          onWriteTags={onWriteTags}
        />
      ) : (
        activeId && (
          <TrackDetail
            trackId={activeId}
            revision={revision}
            playing={player.playing}
            onPlayFile={onPlayFile}
            onClose={() => setActiveId(null)}
            onOpenAlbum={onOpenAlbum}
            onError={onError}
            onChanged={onChanged}
            onWriteTags={onWriteTags}
            onUpgrade={onUpgrade}
            onIdentify={onIdentify}
            onEditAudio={onEditAudio}
            onToggleFavorite={onToggleFavorite}
          />
        )
      )}
    </div>
  );
}
