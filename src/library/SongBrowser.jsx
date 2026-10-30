import { useCallback, useEffect, useMemo, useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { pluralize } from "./format";
import { CloseIcon, SearchIcon } from "./icons";
import { BulkEditor } from "./Editors";
import { FilterChips, FilterMenu } from "./SongFilters";
import { EMPTY_FILTERS, toApiFilters } from "./filterState";
import { TrackDetail } from "./TrackDetail";
import { TrackTable } from "./TrackTable";
import { useDebounced } from "./useLibrary";

const SORT_OPTIONS = [
  ["added:desc", "Recently Added"],
  ["added:asc", "Oldest Added"],
  ["title:asc", "Title A–Z"],
  ["title:desc", "Title Z–A"],
  ["artist:asc", "Artist A–Z"],
  ["artist:desc", "Artist Z–A"],
  ["album:asc", "Album"],
  ["track:asc", "Track Number"],
  ["genre:asc", "Genre"],
  ["year:desc", "Year (Newest)"],
  ["year:asc", "Year (Oldest)"],
  ["duration:desc", "Longest"],
  ["duration:asc", "Shortest"],
];
const SORT_KEY = "wavemint.sort.v1";

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
 * describe that scope and can be cleared with `onClearScope`. The Filter menu
 * narrows the list by music (artist, album, genre, decade, favorites);
 * `facets` says which of those make sense here ([] hides the menu). Playing a
 * song plays the list as shown (same filters and order) from that song.
 */
export function SongBrowser({
  baseFilters = {},
  facets,
  initialActiveId = null,
  chips = [],
  onClearScope,
  revision,
  contextLabel = "Songs",
  sortStorageKey = null,
  explicitSort = false,
  onPlayFile,
  onOpenAlbum,
  onOpenArtist,
  onError,
  hideColumns,
  showColumns,
  defaultSort = "artist",
  defaultDirection = "asc",
  toolbarExtra,
  onChanged,
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
  const [filters, setFilters] = useState(EMPTY_FILTERS);
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
      // The scope always wins over a browsing filter of the same kind.
      filters: { ...toApiFilters(filters), ...JSON.parse(baseKey) },
      sort: sort.field,
      direction: sort.direction,
    }),
    [debouncedSearch, baseKey, filters, sort],
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

  const filtered = Object.keys(toApiFilters(filters)).length > 0;
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
          {facets?.length !== 0 && <FilterMenu filters={filters} onChange={setFilters} revision={revision} facets={facets} />}
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

        {chips.length > 0 && (
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
          </div>
        )}
        <FilterChips filters={filters} onChange={setFilters} />

        <TrackTable
          scrollKey={sortStorageKey || contextLabel}
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
          showColumns={showColumns}
          // The details panel takes room: the table gives up the least-used columns.
          hideColumns={activeId || selection.size > 1 ? [...(hideColumns || []), "genre", "added", "size"] : hideColumns}
          emptyText={search || filtered ? "No songs match these filters." : emptyState || "No songs here yet."}
        />
      </div>

      {selection.size > 1 ? (
        <BulkEditor trackIds={selection} query={query} onClose={() => setSelection(new Set())} onChanged={onChanged} onError={onError} />
      ) : (
        activeId && (
          <TrackDetail
            key={activeId}
            trackId={activeId}
            revision={revision}
            playing={player.playing}
            onPlayFile={onPlayFile}
            onClose={() => setActiveId(null)}
            onOpenAlbum={onOpenAlbum}
            onOpenArtist={onOpenArtist}
            onError={onError}
            onChanged={onChanged}
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
