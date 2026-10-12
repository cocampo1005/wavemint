import { useCallback, useEffect, useMemo, useState } from "react";
import { pluralize } from "./format";
import { CloseIcon, SearchIcon } from "./icons";
import { BulkEditor } from "./Editors";
import { TrackDetail } from "./TrackDetail";
import { TrackTable } from "./TrackTable";
import { QUICK_FILTERS, useDebounced } from "./useLibrary";


function toFilters(base, quick) {
  const filters = { ...base };
  for (const key of quick) {
    if (key === "unclassified") filters.genre = "";
    else filters[key] = true;
  }
  return filters;
}


/**
 * Searchable, filterable, sortable song list with a details panel.
 * `baseFilters` scopes it (album, artist, genre, source…); `chips` describe
 * that scope and can be cleared with `onClearScope`.
 */
export function SongBrowser({
  baseFilters = {},
  initialQuick = [],
  initialActiveId = null,
  chips = [],
  onClearScope,
  revision,
  playing,
  onPlay,
  onPlayFile,
  onOpenAlbum,
  onError,
  lowBitrate,
  hideColumns,
  defaultSort = "artist",
  toolbarExtra,
  onChanged,
  onWriteTags,
  onUpgrade,
  selection: controlledSelection,
  onSelectionChange: setControlledSelection,
}) {
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState(initialQuick);
  const [sort, setSort] = useState({ field: defaultSort, direction: "asc" });
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

  const query = useMemo(
    () => ({
      search: debouncedSearch,
      filters: toFilters(JSON.parse(baseKey), quick),
      sort: sort.field,
      direction: sort.direction,
    }),
    [debouncedSearch, baseKey, quick, sort],
  );

  const handleSort = useCallback(
    (field) =>
      setSort((current) => ({
        field,
        direction: current.field === field && current.direction === "asc" ? "desc" : "asc",
      })),
    [],
  );

  const toggleQuick = (key) =>
    setQuick((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));

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
          {toolbarExtra?.({ selection, query, clearSelection: () => setSelection(new Set()) })}
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
          {QUICK_FILTERS.map((filter) => (
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
          playing={playing}
          onPlay={onPlay}
          onSort={handleSort}
          lowBitrate={lowBitrate}
          // The details panel shows the source, so the table gives up that column.
          hideColumns={activeId || selection.size > 1 ? [...(hideColumns || []), "source"] : hideColumns}
          emptyText={search || quick.length ? "No songs match these filters." : "No songs here yet."}
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
      ) : activeId && (
        <TrackDetail
          trackId={activeId}
          revision={revision}
          playing={playing}
          onPlayFile={onPlayFile}
          onClose={() => setActiveId(null)}
          onOpenAlbum={onOpenAlbum}
          onError={onError}
          onChanged={onChanged}
          onWriteTags={onWriteTags}
          onUpgrade={onUpgrade}
        />
      )}
    </div>
  );
}
