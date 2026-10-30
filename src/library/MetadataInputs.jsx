// The Artist, Album and Genre fields of every metadata form (song editor,
// bulk and album editors, Upgrade Track, Add Music). Suggestions come from
// the library; any typed value is kept as it is.

import { Combobox } from "./Combobox";
import { useArtistAlbums, useArtistNames, useGenreNames } from "./useLibrary";

/** Suggests the library's artists once typing matches one. */
export function ArtistInput({ value, onChange, placeholder, disabled, ariaLabel }) {
  const names = useArtistNames();
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={names}
      label="Artists in your library"
      placeholder={placeholder}
      disabled={disabled}
      ariaLabel={ariaLabel}
      limit={50}
    />
  );
}

/**
 * Lists the albums the library has for `artist` (focus shows them all,
 * typing filters them). With an artist the library doesn't have, it's a
 * plain text field.
 */
export function AlbumInput({ value, onChange, artist, placeholder, disabled, ariaLabel }) {
  const { name, albums } = useArtistAlbums(artist);
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={albums}
      label={`Albums by ${name}`}
      placeholder={placeholder}
      disabled={disabled}
      ariaLabel={ariaLabel}
      browse={albums.length > 0}
    />
  );
}

/**
 * Every known genre. A new one is simply typed (or confirmed with the "Use…"
 * option); it joins the genre list when the song is saved (the library does
 * that, see genres.registerLabels), never before.
 */
export function GenreInput({ value, onChange, placeholder, disabled, ariaLabel }) {
  const names = useGenreNames();
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={names}
      label="Genres"
      placeholder={placeholder || "Search or type a genre"}
      disabled={disabled}
      ariaLabel={ariaLabel}
      browse
      limit={Infinity}
      createLabel={(name) => `Use “${name}” as a new genre`}
      emptyText="No genres yet. Type one to add it."
      hint="Type to filter or enter a new one · ↑ ↓ to browse · Enter to choose"
    />
  );
}
