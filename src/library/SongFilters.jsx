import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "./format";
import { CheckIcon, CloseIcon, HeartIcon, SearchIcon } from "./icons";
import { EMPTY_FILTERS, activeFilterCount } from "./filterState";
import { libraryApi, useCachedLoader, useDebounced, useLoader } from "./useLibrary";

// The Filter menu and chips for song lists: what music to show, never what
// needs fixing (missing details, duplicates and file problems live in Review). Each facet allows several values; facets combine.

const FACETS = [
  { key: "artists", label: "Artist" },
  { key: "albums", label: "Album" },
  { key: "genres", label: "Genre" },
  { key: "decades", label: "Decade" },
];

/** The options of one facet: [{ key, label, count }]. Lists are cached per library revision. */
function useFacetOptions(facet, search, revision) {
  const debounced = useDebounced(search, 200);
  const artists = useCachedLoader(facet === "artists" ? "facet:artists" : "", () => (facet === "artists" ? libraryApi.listArtists({ limit: 5000 }) : null), revision);
  const genres = useCachedLoader(facet === "genres" ? "facet:genres" : "", () => (facet === "genres" ? libraryApi.listGenres() : null), revision);
  const facets = useCachedLoader(facet === "decades" ? "facet:decades" : "", () => (facet === "decades" ? libraryApi.browseFacets() : null), revision);
  // Albums are many: searched as you type.
  const albums = useLoader(() => (facet === "albums" ? libraryApi.listAlbums({ search: debounced, sort: "title", limit: 80 }) : null), [facet, debounced, revision]);

  return useMemo(() => {
    const text = search.trim().toLowerCase();
    const match = (label) => !text || label.toLowerCase().includes(text);
    if (facet === "artists") return (artists.data?.rows || []).filter((row) => match(row.name)).map((row) => ({ key: row.key, label: row.name, count: row.track_count }));
    if (facet === "genres") return (genres.data || []).filter((row) => row.name && match(row.name)).map((row) => ({ key: row.name, label: row.name, count: row.track_count }));
    if (facet === "decades") return (facets.data?.decades || []).map((row) => ({ key: row.decade, label: `${row.decade}s`, count: row.count })).filter((row) => match(row.label));
    if (facet === "albums") {
      return (albums.data?.rows || []).map((row) => ({ key: row.id, label: row.title, hint: row.album_artist || "Various artists", count: row.track_count }));
    }
    return [];
  }, [facet, search, artists.data, genres.data, facets.data, albums.data]);
}

/**
 * The Filter button and its menu. `filters` is the browse filter state
 * (EMPTY_FILTERS shape); `facets` limits which facets are offered (a scoped
 * list, e.g. an artist's songs, doesn't offer Artist).
 */
export function FilterMenu({ filters, onChange, revision, facets = ["favorite", "artists", "albums", "genres", "decades"] }) {
  const [open, setOpen] = useState(false);
  const offered = FACETS.filter((facet) => facets.includes(facet.key));
  const [facet, setFacet] = useState(offered[0]?.key || null);
  const [search, setSearch] = useState("");
  const ref = useRef(null);
  const options = useFacetOptions(open ? facet : null, search, revision);
  const count = activeFilterCount(filters);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "mousedown" && ref.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const selected = new Set((filters[facet] || []).map((item) => item.key));
  const toggle = (option) => {
    const list = filters[facet] || [];
    const next = selected.has(option.key) ? list.filter((item) => item.key !== option.key) : [...list, { key: option.key, label: option.label }];
    onChange({ ...filters, [facet]: next });
  };

  return (
    <div className="lib-filter" ref={ref}>
      <button type="button" className={`btn btn--secondary btn--sm lib-filter__button ${count ? "is-active" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        Filter
        {count > 0 && <span className="lib-filter__count">{count}</span>}
      </button>
      {open && (
        <div className="lib-filter__menu" role="dialog" aria-label="Filter songs">
          <div className="lib-filter__facets" role="tablist" aria-label="Filter by">
            {facets.includes("favorite") && (
              <button type="button" className={`lib-filter__facet lib-filter__favorite ${filters.favorite ? "is-on" : ""}`} aria-pressed={filters.favorite} onClick={() => onChange({ ...filters, favorite: !filters.favorite })}>
                <HeartIcon size={13} filled={filters.favorite} /> Favorites
              </button>
            )}
            {offered.map((item) => {
              const chosen = filters[item.key].length;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={facet === item.key}
                  className={`lib-filter__facet ${facet === item.key ? "is-active" : ""}`}
                  onClick={() => {
                    setFacet(item.key);
                    setSearch("");
                  }}
                >
                  {item.label}
                  {chosen > 0 && <span className="lib-filter__count">{chosen}</span>}
                </button>
              );
            })}
            {count > 0 && (
              <button type="button" className="btn btn--link lib-filter__reset" onClick={() => onChange(EMPTY_FILTERS)}>
                Clear All
              </button>
            )}
          </div>
          {facet && (
            <div className="lib-filter__options">
              <label className="lib-search lib-filter__search">
                <SearchIcon size={14} />
                <input
                  type="search"
                  className="lib-search__input"
                  placeholder={`Find ${FACETS.find((item) => item.key === facet)?.label.toLowerCase()}…`}
                  value={search}
                  autoFocus
                  onChange={(event) => setSearch(event.target.value)}
                  aria-label="Find in this list"
                />
              </label>
              <div className="lib-filter__list" role="listbox" aria-multiselectable="true">
                {options.slice(0, 400).map((option) => (
                  <button key={option.key} type="button" role="option" aria-selected={selected.has(option.key)} className={`lib-filter__option ${selected.has(option.key) ? "is-on" : ""}`} onClick={() => toggle(option)}>
                    <span className="lib-filter__check" aria-hidden="true">
                      {selected.has(option.key) && <CheckIcon size={12} />}
                    </span>
                    <span className="lib-filter__label">
                      {option.label}
                      {option.hint && <span className="lib-filter__hint"> · {option.hint}</span>}
                    </span>
                    <span className="lib-filter__n">{formatNumber(option.count)}</span>
                  </button>
                ))}
                {!options.length && <p className="lib-filter__empty">Nothing to choose here.</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The active filters as small chips, each removable, plus Clear. */
export function FilterChips({ filters, onChange }) {
  const chips = [];
  if (filters.favorite) chips.push({ id: "favorite", label: "Favorites", remove: () => onChange({ ...filters, favorite: false }) });
  for (const facet of FACETS) {
    for (const item of filters[facet.key]) {
      chips.push({ id: `${facet.key}:${item.key}`, label: item.label, remove: () => onChange({ ...filters, [facet.key]: filters[facet.key].filter((other) => other.key !== item.key) }) });
    }
  }
  if (!chips.length) return null;
  return (
    <div className="lib-chips lib-filter__chips">
      {chips.map((chip) => (
        <span key={chip.id} className="lib-chip is-scope">
          {chip.label}
          <button type="button" onClick={chip.remove} aria-label={`Remove ${chip.label}`}>
            <CloseIcon size={12} />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button type="button" className="btn btn--link lib-filter__reset" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear All
        </button>
      )}
    </div>
  );
}
