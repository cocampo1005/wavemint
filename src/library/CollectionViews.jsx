import { useState } from "react";
import { usePlayer } from "../player/usePlayer";
import { Artwork } from "./Artwork";
import { formatDuration, formatNumber, pluralize } from "./format";
import { ChevronIcon, PlayIcon, SearchIcon, ShuffleIcon, WarningIcon } from "./icons";
import { useCollectionMemory, useCollectionScroll } from "./useCollectionMemory";
import { SongBrowser } from "./SongBrowser";
import { libraryApi, useCachedLoader, useDebounced, useLoader } from "./useLibrary";

// Artists, Albums and Genres are browsing experiences of their own: a list,
// then a detail view inside the same tab (an artist's albums and songs, an
// album's tracks, a genre's songs, artists and albums). Lists and headers come
// from the shared browse cache (useCachedLoader), so moving between tabs and
// back from a detail view is instant after the first load.

const ALBUM_PAGE = 120;
const ARTIST_PAGE = 240;

function SearchBox({ value, onChange, placeholder }) {
  return (
    <label className="lib-search">
      <SearchIcon size={16} />
      <input type="search" className="lib-search__input" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} aria-label={placeholder} />
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

/** "Artists › Coldplay › Parachutes": where a detail view is, with the way back. */
export function Breadcrumbs({ items }) {
  return (
    <nav className="lib-crumbs" aria-label="Location">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="lib-crumbs__item">
          {index > 0 && <ChevronIcon size={12} />}
          {item.onClick && index < items.length - 1 ? (
            <button type="button" className="btn btn--link" onClick={item.onClick}>
              {item.label}
            </button>
          ) : (
            <span aria-current={index === items.length - 1 ? "page" : undefined}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** Play and Shuffle for a whole list (the songs a query returns, in its order). */
function PlayButtons({ label, query, disabled }) {
  const player = usePlayer();
  return (
    <div className="lib-detail-head__play">
      <button type="button" className="btn btn--primary btn--sm" disabled={disabled} onClick={() => player.playQuery({ label, query })}>
        <PlayIcon size={14} /> Play
      </button>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        disabled={disabled}
        onClick={() => {
          if (!player.shuffle) player.toggleShuffle();
          player.playQuery({ label, query });
        }}
      >
        <ShuffleIcon size={14} /> Shuffle
      </button>
    </div>
  );
}

function AlbumCard({ album, onOpen, showArtist = true }) {
  return (
    <button type="button" className="lib-album" onClick={() => onOpen(album.id, album.title)}>
      <span className="lib-album__art">
        <Artwork hash={album.artwork_hash} size={320} loading="lazy" draggable={false} />
      </span>
      <span className="lib-album__title">{album.title}</span>
      {showArtist && <span className="lib-album__artist">{album.album_artist || "Various artists"}</span>}
      <span className="lib-album__meta">{[album.year, pluralize(album.track_count, "song"), album.edition].filter(Boolean).join(" · ")}</span>
    </button>
  );
}

function ArtistCard({ artist, onOpen }) {
  return (
    <button type="button" className="lib-album lib-artist-card" onClick={() => onOpen(artist)}>
      <span className="lib-album__art is-round">
        <Artwork hash={artist.artwork_hash} size={320} loading="lazy" draggable={false} />
      </span>
      <span className="lib-album__title">{artist.name}</span>
      <span className="lib-album__meta">
        {pluralize(artist.track_count, "song")}
        {artist.album_count ? ` · ${pluralize(artist.album_count, "album")}` : ""}
      </span>
    </button>
  );
}

// --- Albums --------------------------------------------------------------------------

const ALBUM_SORTS = [
  ["artist", "Artist"],
  ["title", "Title"],
  ["year", "Year"],
  ["added", "Recently added"],
];

/** Album grid. `filters` narrows it ({ artist } or { genre }); `embedded` drops the outer padding. */
export function AlbumsView({ revision, onOpenAlbum, filters = {}, embedded = false, showArtist = true }) {
  const { ref, state: { search, sort, limit }, set } = useCollectionMemory(`albums:${JSON.stringify(filters)}`, { search: "", sort: filters.artist ? "year" : "artist", limit: ALBUM_PAGE });
  const setSearch = set("search"), setSort = set("sort"), setLimit = set("limit");
  const debounced = useDebounced(search);
  const filterKey = JSON.stringify(filters);
  const params = { search: debounced, sort, limit, filters: JSON.parse(filterKey) };
  // Plain lists are cached; a search asks the library each time.
  const cached = useCachedLoader(debounced ? "" : `albums:${JSON.stringify(params)}`, () => libraryApi.listAlbums(params), revision, { keepPreviousData: true });
  const searched = useLoader(() => (debounced ? libraryApi.listAlbums(params) : null), [debounced, sort, limit, filterKey, revision]);
  const { data, error } = debounced ? searched : cached;
  useCollectionScroll(ref, `albums:${filterKey}`, { search, sort, limit }, !!data);

  return (
    <div ref={ref} className={`lib-collection ${embedded ? "is-embedded" : ""}`}>
      <div className="lib-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search albums" />
        <span className="lib-toolbar__count">{data ? pluralize(data.total, "album") : "…"}</span>
        <div className="segmented" role="group" aria-label="Sort albums">
          {ALBUM_SORTS.map(([value, label]) => (
            <button key={value} type="button" className={`segmented__option ${sort === value ? "is-active" : ""}`} aria-pressed={sort === value} onClick={() => setSort(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <LoadError error={error} />
      <div className="lib-album-grid">
        {data?.rows.map((album) => (
          <AlbumCard key={album.id} album={album} onOpen={onOpenAlbum} showArtist={showArtist} />
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

export function AlbumHeader({ releaseId, revision, onEdit, onIdentify, onOpenArtist }) {
  const { data: album } = useCachedLoader(`album:${releaseId}`, () => libraryApi.getAlbum({ id: releaseId }), revision);
  if (!album) return null;

  return (
    <div className="lib-album-head">
      <span className="lib-album-head__art">
        <Artwork hash={album.artwork_hash} size={320} />
      </span>
      <div className="lib-album-head__text">
        <span className="eyebrow">{album.release_type === "compilation" ? "Compilation" : "Album"}</span>
        <h2 className="heading-lg">{album.title}</h2>
        <div className="meta-line">
          {album.album_artist && onOpenArtist ? (
            <button type="button" className="btn btn--link" onClick={() => onOpenArtist(album.artist_key, album.album_artist)}>
              {album.album_artist}
            </button>
          ) : (
            <span>{album.album_artist || "Various artists"}</span>
          )}
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
        <div className="lib-album-head__actions">
          <PlayButtons label={album.title} query={{ filters: { releaseId: album.id }, sort: "track", direction: "asc" }} disabled={!album.track_count} />
          {onEdit && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onEdit(album)}>
              Edit Album…
            </button>
          )}
          {onIdentify && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onIdentify(album)}>
              Identify Album…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One album: its header and its tracks in track order, editable in place. */
export function AlbumDetail({ releaseId, crumbs, revision, browserProps, onEditAlbum, onIdentifyAlbum, onOpenArtist }) {
  return (
    <div className="lib-detail-view">
      <Breadcrumbs items={crumbs} />
      <AlbumHeader releaseId={releaseId} revision={revision} onEdit={onEditAlbum} onIdentify={onIdentifyAlbum} onOpenArtist={onOpenArtist} />
      <SongBrowser
        key={`album-${releaseId}`}
        {...browserProps}
        baseFilters={{ releaseId }}
        facets={[]}
        contextLabel="this album"
        defaultSort="track"
        explicitSort
        hideColumns={["album"]}
        showColumns={["track"]}
      />
    </div>
  );
}

// --- Artists ---------------------------------------------------------------------------

export function ArtistsView({ revision, onOpenArtist, genre }) {
  const { ref, state: { search, sort, limit }, set } = useCollectionMemory(`artists:${genre ?? ""}`, { search: "", sort: "name", limit: ARTIST_PAGE });
  const setSearch = set("search"), setSort = set("sort"), setLimit = set("limit");
  const { data, error } = useCachedLoader(`artists:${genre ?? ""}`, () => libraryApi.listArtists({ limit: 5000, ...(genre !== undefined ? { genre } : {}) }), revision);

  useCollectionScroll(ref, `artists:${genre ?? ""}`, { search, sort, limit }, !!data);
  const text = search.trim().toLowerCase();
  const rows = (data?.rows || []).filter((artist) => !text || artist.name.toLowerCase().includes(text));
  const sorted = sort === "songs" ? [...rows].sort((a, b) => b.track_count - a.track_count || a.name.localeCompare(b.name)) : rows;

  return (
    <div ref={ref} className="lib-collection">
      <div className="lib-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search artists" />
        <span className="lib-toolbar__count">{data ? pluralize(rows.length, "artist") : "…"}</span>
        <div className="segmented" role="group" aria-label="Sort artists">
          {[
            ["name", "Name"],
            ["songs", "Most songs"],
          ].map(([value, label]) => (
            <button key={value} type="button" className={`segmented__option ${sort === value ? "is-active" : ""}`} aria-pressed={sort === value} onClick={() => setSort(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <LoadError error={error} />
      <div className="lib-album-grid lib-artist-grid">
        {sorted.slice(0, limit).map((artist) => (
          <ArtistCard key={artist.key} artist={artist} onOpen={onOpenArtist} />
        ))}
      </div>
      {sorted.length > limit && (
        <button type="button" className="btn btn--secondary lib-more" onClick={() => setLimit((value) => value + ARTIST_PAGE)}>
          Show more artists ({formatNumber(sorted.length - limit)})
        </button>
      )}
      {data && !rows.length && <p className="lib-empty-note">No artists found.</p>}
    </div>
  );
}

/**
 * One artist: their albums, then their songs (editable in place). From a
 * genre, the songs start limited to that genre (the chip clears it).
 */
export function ArtistDetail({ artistKey, genre, crumbs, revision, browserProps, onOpenAlbum, onOpenGenre }) {
  const { data: artist, error } = useCachedLoader(`artist:${artistKey}`, () => libraryApi.getArtist({ key: artistKey }), revision);
  const [onlyGenre, setOnlyGenre] = useState(genre !== undefined);
  const filters = { artist: artistKey, ...(onlyGenre && genre !== undefined ? { genre } : {}) };

  return (
    <div className="lib-detail-view">
      <Breadcrumbs items={crumbs} />
      <LoadError error={error} />
      {artist === null && !error && <p className="lib-empty-note">This artist has no songs in your library anymore.</p>}
      {artist && (
        <div className="lib-album-head">
          <span className="lib-album-head__art is-round">
            <Artwork hash={artist.artwork_hash} size={320} />
          </span>
          <div className="lib-album-head__text">
            <span className="eyebrow">Artist</span>
            <h2 className="heading-lg">{artist.name}</h2>
            <div className="meta-line">
              <span>{pluralize(artist.track_count, "song")}</span>
              <span className="meta-line__dot" aria-hidden="true" />
              <span>{pluralize(artist.album_count, "album")}</span>
              <span className="meta-line__dot" aria-hidden="true" />
              <span>{formatDuration(artist.duration_ms)}</span>
            </div>
            {artist.genres.length > 0 && (
              <div className="lib-album-head__genres">
                {artist.genres.map((item, index) => (
                  <span key={item.name}>
                    {index > 0 && " · "}
                    {onOpenGenre ? (
                      <button type="button" className="btn btn--link" onClick={() => onOpenGenre(item.name)}>
                        {item.name}
                      </button>
                    ) : (
                      item.name
                    )}
                  </span>
                ))}
              </div>
            )}
            <div className="lib-album-head__actions">
              <PlayButtons label={artist.name} query={{ filters, sort: "album", direction: "asc" }} disabled={!artist.track_count} />
            </div>
          </div>
        </div>
      )}

      {artist && artist.album_count > 0 && (
        <section className="lib-detail-view__albums" aria-label="Albums">
          <span className="section-label">Albums</span>
          <ArtistAlbums artistKey={artistKey} revision={revision} onOpenAlbum={onOpenAlbum} />
        </section>
      )}

      <section className="lib-detail-view__songs" aria-label="Songs">
        <span className="section-label">Songs</span>
        <SongBrowser
          key={`artist-${artistKey}-${onlyGenre}`}
          {...browserProps}
          baseFilters={filters}
          facets={["favorite", "albums", "genres", "decades"]}
          chips={onlyGenre && genre !== undefined ? [`Only ${genre || "unclassified"} songs`] : []}
          onClearScope={() => setOnlyGenre(false)}
          contextLabel={artist?.name || "Artist"}
          defaultSort="album"
          explicitSort
        />
      </section>
    </div>
  );
}

/** An artist's albums as a compact row of cards (newest first). */
function ArtistAlbums({ artistKey, revision, onOpenAlbum }) {
  const params = { sort: "year", limit: 200, filters: { artist: artistKey } };
  const { data } = useCachedLoader(`albums:${JSON.stringify(params)}`, () => libraryApi.listAlbums(params), revision);
  return (
    <div className="lib-album-strip">
      {data?.rows.map((album) => (
        <AlbumCard key={album.id} album={album} onOpen={onOpenAlbum} showArtist={false} />
      ))}
    </div>
  );
}

// --- Genres ----------------------------------------------------------------------------

/** The genres songs in the library use (as curated, song by song). */
export function GenresView({ revision, onOpenGenre, onManage, onReviewUnclassified }) {
  const [search, setSearch] = useState("");
  const { data, error } = useCachedLoader("genres", () => libraryApi.listGenres(), revision);
  const text = search.trim().toLowerCase();
  const genres = (data || []).filter((genre) => genre.name && (!text || genre.name.toLowerCase().includes(text)));
  const unclassified = (data || []).find((genre) => !genre.name);
  const largest = Math.max(1, ...genres.map((genre) => genre.track_count));

  return (
    <div className="lib-collection">
      <div className="lib-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search genres" />
        <span className="lib-toolbar__count">{data ? pluralize(genres.length, "genre") : "…"}</span>
        <div className="lib-toolbar__actions">
          {onManage && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onManage}>
              Manage Genres…
            </button>
          )}
        </div>
      </div>
      <LoadError error={error} />
      <div className="lib-genre-grid">
        {genres.map((genre) => (
          <button key={genre.name} type="button" className="lib-genre-card" onClick={() => onOpenGenre(genre.name)}>
            <span className="lib-genre-card__name">{genre.name}</span>
            <span className="lib-genre-card__meta">
              {pluralize(genre.track_count, "song")} · {pluralize(genre.artist_count, "artist")}
            </span>
            <span className="lib-genre-card__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(4, Math.round((genre.track_count / largest) * 100))}%` }} />
            </span>
          </button>
        ))}
      </div>
      {unclassified?.track_count > 0 && onReviewUnclassified && (
        <p className="lib-empty-note">
          {pluralize(unclassified.track_count, "song")} {unclassified.track_count === 1 ? "has" : "have"} no genre yet.{" "}
          <button type="button" className="btn btn--link" onClick={onReviewUnclassified}>
            Review them
          </button>
        </p>
      )}
      {data && !genres.length && <p className="lib-empty-note">No genres found.</p>}
    </div>
  );
}

const GENRE_SECTIONS = [
  ["songs", "Songs"],
  ["artists", "Artists"],
  ["albums", "Albums"],
];

/** One genre: its songs, and the artists and albums that have songs in it. */
export function GenreDetail({ genre, crumbs, revision, browserProps, onOpenArtist, onOpenAlbum }) {
  const [section, setSection] = useState("songs");
  const { data: genres } = useCachedLoader("genres", () => libraryApi.listGenres(), revision);
  const info = (genres || []).find((item) => (item.name || "").toLowerCase() === genre.toLowerCase());
  const query = { filters: { genre }, sort: "artist", direction: "asc" };

  return (
    <div className="lib-detail-view">
      <Breadcrumbs items={crumbs} />
      <div className="lib-genre-head">
        <div>
          <span className="eyebrow">Genre</span>
          <h2 className="heading-lg">{genre || "Unclassified"}</h2>
          {info && (
            <div className="meta-line">
              <span>{pluralize(info.track_count, "song")}</span>
              <span className="meta-line__dot" aria-hidden="true" />
              <span>{pluralize(info.artist_count, "artist")}</span>
            </div>
          )}
        </div>
        <PlayButtons label={genre || "Unclassified"} query={query} disabled={!info?.track_count} />
      </div>
      <div className="segmented lib-genre-head__sections" role="tablist" aria-label="Show">
        {GENRE_SECTIONS.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={section === value} className={`segmented__option ${section === value ? "is-active" : ""}`} onClick={() => setSection(value)}>
            {label}
          </button>
        ))}
      </div>
      {section === "songs" && (
        <SongBrowser
          key={`genre-${genre}`}
          {...browserProps}
          baseFilters={{ genre }}
          facets={["favorite", "artists", "albums", "decades"]}
          contextLabel={genre || "Unclassified"}
          defaultSort="artist"
          sortStorageKey="genre"
        />
      )}
      {section === "artists" && <ArtistsView revision={revision} genre={genre} onOpenArtist={onOpenArtist} />}
      {section === "albums" && <AlbumsView revision={revision} filters={{ genre }} onOpenAlbum={onOpenAlbum} embedded />}
    </div>
  );
}
