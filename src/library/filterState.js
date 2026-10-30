// Browsing filters for song lists (the Filter menu in SongFilters.jsx): what
// music to show, never what needs fixing. Each facet holds { key, label }
// items; facets combine, values within a facet are alternatives.

export const EMPTY_FILTERS = { favorite: false, artists: [], albums: [], genres: [], decades: [] };

/** The library API filters for a browse filter state. */
export function toApiFilters(filters) {
  const out = {};
  if (filters.favorite) out.favorite = true;
  if (filters.artists.length) out.artists = filters.artists.map((item) => item.key);
  if (filters.albums.length) out.releaseIds = filters.albums.map((item) => item.key);
  if (filters.genres.length) out.genres = filters.genres.map((item) => item.key);
  if (filters.decades.length) out.decades = filters.decades.map((item) => item.key);
  return out;
}

export const activeFilterCount = (filters) =>
  (filters.favorite ? 1 : 0) + filters.artists.length + filters.albums.length + filters.genres.length + filters.decades.length;
