import { useState } from "react";
import { formatDuration, formatNumber, pluralize } from "./format";
import { SearchIcon, WarningIcon } from "./icons";
import { libraryApi, useDebounced, useLoader } from "./useLibrary";
import { Artwork } from "./Artwork";

const ALBUM_PAGE = 120;

function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="lib-search">
      <SearchIcon size={16} />
      <input
        type="search"
        className="lib-search__input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={placeholder}
      />
    </label>
  );
}

function LoadError({ error }) {
  return error ? (
    <div className="alert alert--compact" role="alert">
      <WarningIcon size={16} /> {error}
    </div>
  ) : null;
}

export function AlbumsView({ revision, onOpenAlbum, filters = {}, chips = [], onClearScope }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("artist");
  const [limit, setLimit] = useState(ALBUM_PAGE);
  const debounced = useDebounced(search);
  const filterKey = JSON.stringify(filters);

  const { data, error } = useLoader(
    () => libraryApi.listAlbums({ search: debounced, sort, limit, filters: JSON.parse(filterKey) }),
    [debounced, sort, limit, filterKey, revision],
  );

  return (
    <div className="lib-collection">
      <div className="lib-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search albums" />
        <span className="lib-toolbar__count">{data ? pluralize(data.total, "album") : "…"}</span>
        <div className="segmented" role="group" aria-label="Sort albums">
          {[
            ["artist", "Artist"],
            ["title", "Title"],
            ["year", "Year"],
            ["added", "Recently added"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`segmented__option ${sort === value ? "is-active" : ""}`}
              aria-pressed={sort === value}
              onClick={() => setSort(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {chips.length > 0 && (
        <div className="lib-chips">
          {chips.map((chip) => (
            <span key={chip} className="lib-chip is-scope">
              {chip}
              <button type="button" onClick={onClearScope} aria-label={`Clear ${chip}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <LoadError error={error} />

      <div className="lib-album-grid">
        {data?.rows.map((album) => (
          <button key={album.id} type="button" className="lib-album" onClick={() => onOpenAlbum(album.id)}>
            <span className="lib-album__art">
              <Artwork hash={album.artwork_hash} size={320} loading="lazy" draggable={false} />
            </span>
            <span className="lib-album__title">{album.title}</span>
            <span className="lib-album__artist">{album.album_artist || "Various artists"}</span>
            <span className="lib-album__meta">
              {[album.year, pluralize(album.track_count, "song"), album.edition].filter(Boolean).join(" · ")}
            </span>
          </button>
        ))}
      </div>
      {data && data.total > data.rows.length && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + ALBUM_PAGE)}>
          Show more albums
        </button>
      )}
      {data && data.total === 0 && <p className="lib-empty-note">No albums found.</p>}
    </div>
  );
}

export function AlbumHeader({ releaseId, revision, onEdit, onIdentify }) {
  const { data: album } = useLoader(() => libraryApi.getAlbum({ id: releaseId }), [releaseId, revision]);
  if (!album) return null;

  return (
    <div className="lib-album-head">
      <span className="lib-album-head__art">
        <Artwork hash={album.artwork_hash} size={320} />
      </span>
      <div>
        <span className="eyebrow">{album.release_type === "compilation" ? "Compilation" : "Album"}</span>
        <h2 className="heading-lg">{album.title}</h2>
        <div className="meta-line">
          <span>{album.album_artist || "Various artists"}</span>
          {album.year && (
            <>
              <span className="meta-line__dot" aria-hidden="true" />
              <span>{album.year}</span>
            </>
          )}
          <span className="meta-line__dot" aria-hidden="true" />
          <span>{pluralize(album.track_count, "song")}</span>
          <span className="meta-line__dot" aria-hidden="true" />
          <span>{formatDuration(album.duration_ms)}</span>
        </div>
        {album.genres && <div className="lib-album-head__genres">{album.genres.split(",").join(" · ")}</div>}
        {onEdit && (
          <button type="button" className="btn btn--secondary btn--sm lib-album-head__edit" onClick={() => onEdit(album)}>
            Edit Album…
          </button>
        )}
        {onIdentify && (
          <button type="button" className="btn btn--ghost btn--sm lib-album-head__edit" onClick={() => onIdentify(album)}>
            Identify Album…
          </button>
        )}
      </div>
    </div>
  );
}

export function ArtistsView({ revision, onOpenArtist }) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search);
  const { data, error } = useLoader(() => libraryApi.listArtists({ search: debounced, limit: 2000 }), [debounced, revision]);

  return (
    <div className="lib-collection">
      <div className="lib-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search artists" />
        <span className="lib-toolbar__count">{data ? pluralize(data.total, "artist") : "…"}</span>
      </div>
      <LoadError error={error} />
      <div className="lib-list">
        {data?.rows.map((artist) => (
          <button key={artist.key} type="button" className="lib-list__row" onClick={() => onOpenArtist(artist)}>
            <Artwork className="lib-list__art is-round" hash={artist.artwork_hash} size={64} loading="lazy" />
            <span className="lib-list__name">{artist.name}</span>
            <span className="lib-list__meta">
              {pluralize(artist.track_count, "song")} · {pluralize(artist.album_count, "album")}
            </span>
          </button>
        ))}
      </div>
      {data && data.total > data.rows.length && (
        <p className="lib-empty-note">Showing the first {formatNumber(data.rows.length)} artists. Search to narrow the list.</p>
      )}
    </div>
  );
}
