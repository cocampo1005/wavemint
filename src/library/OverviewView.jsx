import { usePlayer } from "../player/usePlayer";
import { formatAddedAgo, formatBytes, formatLongDuration, formatNumber, pluralize } from "./format";
import { AddMusicIcon, PauseIcon, PlayIcon, WarningIcon } from "./icons";
import { libraryApi, useLoader } from "./useLibrary";
import { Artwork } from "./Artwork";

const RECENT_SHOWN = 12;
const GENRES_SHOWN = 10;

function Stat({ label, value, onClick }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag type={onClick ? "button" : undefined} className={`lib-stat ${onClick ? "is-link" : ""}`} onClick={onClick}>
      <span className="lib-stat__value">{value}</span>
      <span className="lib-stat__label">{label}</span>
    </Tag>
  );
}

function IssueRow({ label, count, onOpen, tone = "warn" }) {
  return (
    <button type="button" className="lib-issue" onClick={onOpen} disabled={!count}>
      <span className={`lib-issue__dot is-${count ? tone : "ok"}`} aria-hidden="true" />
      <span className="lib-issue__label">{label}</span>
      <span className="lib-issue__count">{formatNumber(count)}</span>
    </button>
  );
}

/** Shown while the library is empty (Overview and Songs). */
export function EmptyLibrary({ onAddMusic, onAddSource }) {
  return (
    <div className="lib-empty-library">
      <span className="eyebrow">Your music library</span>
      <h2 className="heading-lg">Start your collection</h2>
      <p className="text-muted">
        Add songs from YouTube, or bring in the music folders you already have (for example your iTunes Media folder). WaveMint only reads
        your folders: nothing in them is moved, renamed or changed.
      </p>
      <div className="lib-welcome__actions">
        <button type="button" className="btn btn--primary" onClick={onAddMusic}>
          <AddMusicIcon size={16} /> Add Music
        </button>
        <button type="button" className="btn btn--secondary" onClick={() => onAddSource("legacy")}>
          Add iTunes / Legacy Folder
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => onAddSource("other")}>
          Add Other Folder
        </button>
      </div>
    </div>
  );
}

function RecentlyAdded({ rows, onOpenTrack, onTrackMenu, onViewAll }) {
  const player = usePlayer();
  const ids = rows.map((row) => row.id);
  return (
    <section className="lib-recent" aria-labelledby="lib-recent-title">
      <div className="lib-section-head">
        <h2 id="lib-recent-title" className="heading-md">
          Recently Added
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onViewAll}>
          View All
        </button>
      </div>
      <div className="lib-recent__grid">
        {rows.map((row) => {
          const isCurrent = player.playing?.trackId === row.id;
          const isPlaying = isCurrent && player.playing.isPlaying;
          return (
            <article
              key={row.id}
              className={`lib-card ${isCurrent ? "is-playing" : ""}`}
              onContextMenu={(event) => {
                event.preventDefault();
                onTrackMenu?.({ x: event.clientX, y: event.clientY, row, rows: [row], ids: [row.id], onPlayNow: () => player.playList({ label: "Recently Added", ids, rows, startId: row.id }) });
              }}
            >
              <div className="lib-card__art">
                <button type="button" className="lib-card__cover" onClick={() => onOpenTrack(row.id)} aria-label={`Show ${row.title || "song"} details`} tabIndex={-1}>
                  <Artwork hash={row.artwork_hash} size={320} loading="lazy" draggable={false} />
                </button>
                {row.file_id && row.file_status !== "missing" && (
                  <button
                    type="button"
                    className="lib-card__play"
                    aria-label={isPlaying ? `Pause ${row.title}` : `Play ${row.title}`}
                    onClick={() => (isCurrent ? player.togglePlay() : player.playList({ label: "Recently Added", ids, rows, startId: row.id }))}
                  >
                    {isPlaying ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
                  </button>
                )}
              </div>
              <button type="button" className="lib-card__open" onClick={() => onOpenTrack(row.id)} title="Show song details">
                <strong className="lib-card__title">{row.title || "Untitled"}</strong>
                <span className="lib-card__meta">{[row.artist || "Unknown artist", row.album].filter(Boolean).join(" · ")}</span>
                <span className="lib-card__when">{formatAddedAgo(row.created_at)}</span>
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Genre composition as one-hue bars with direct labels (count and share). */
function GenreBars({ genres, total, onOpenGenre, onAllGenres }) {
  const named = genres.filter((genre) => genre.name);
  const unclassified = genres.find((genre) => !genre.name);
  const shown = named.slice(0, GENRES_SHOWN);
  const others = named.slice(GENRES_SHOWN).reduce((sum, genre) => sum + genre.count, 0);
  const max = Math.max(1, ...shown.map((genre) => genre.count));
  const percent = (count) => (total ? `${Math.round((count / total) * 100)}%` : "");
  const share = (count) => (total ? Math.round((count / total) * 1000) / 10 : 0);

  return (
    <section className="panel lib-genres-card" aria-labelledby="lib-genres-title">
      <div className="lib-section-head">
        <h2 id="lib-genres-title" className="section-label">
          Genres
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onAllGenres}>
          All Genres
        </button>
      </div>
      {shown.length ? (
        <ul className="lib-genre-bars">
          {shown.map((genre) => (
            <li key={genre.name}>
              <button
                type="button"
                className="lib-genre-bar"
                onClick={() => onOpenGenre(genre.name)}
                title={`${genre.name}: ${pluralize(genre.count, "song")} (${share(genre.count)}% of your library) by ${pluralize(genre.artists, "artist")}, ${formatLongDuration(genre.duration_ms)}`}
              >
                <span className="lib-genre-bar__name">{genre.name}</span>
                <span className="lib-genre-bar__track" aria-hidden="true">
                  <span style={{ width: `${Math.max(2, (genre.count / max) * 100)}%` }} />
                </span>
                <span className="lib-genre-bar__count">
                  {formatNumber(genre.count)} <span>{percent(genre.count)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-hint">Your songs don&apos;t have genres yet.</p>
      )}
      {(others > 0 || unclassified) && (
        <p className="settings-hint lib-genres-card__foot">
          {others > 0 && `${pluralize(named.length - GENRES_SHOWN, "more genre")} with ${pluralize(others, "song")}. `}
          {unclassified && (
            <button type="button" className="btn btn--link" onClick={() => onOpenGenre("")}>
              {pluralize(unclassified.count, "song")} without a genre
            </button>
          )}
        </p>
      )}
    </section>
  );
}

function TopArtists({ artists, onOpenArtist }) {
  if (!artists.length) return null;
  return (
    <section className="panel lib-top-artists" aria-labelledby="lib-artists-title">
      <h2 id="lib-artists-title" className="section-label">
        Most songs by
      </h2>
      <ul>
        {artists.map((artist) => (
          <li key={artist.key}>
            <button type="button" className="lib-top-artist" onClick={() => onOpenArtist(artist)}>
              <Artwork hash={artist.artwork_hash} size={64} loading="lazy" />
              <span className="lib-top-artist__name">{artist.name}</span>
              <span className="lib-top-artist__meta">
                {pluralize(artist.track_count, "song")} · {pluralize(artist.album_count, "album")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Overview: the home of the collection. Totals, Recently Added (artwork
 * first), what the library is made of (genres, top artists), and a short
 * list of things that may need attention.
 */
export function OverviewView({ revision, onNavigate, onAddMusic, onAddSource, onOpenTrack, onTrackMenu }) {
  const { data, error, loading } = useLoader(() => libraryApi.getOverview(), [revision]);

  if (error) {
    return (
      <div className="alert" role="alert">
        <WarningIcon size={18} />
        <span className="alert__text">{error}</span>
      </div>
    );
  }

  if (!data) return <div className="lib-loading">{loading ? "Loading your library…" : ""}</div>;
  const { totals, issues, duplicates, genres, recent, topArtists } = data;
  if (!totals.tracks) return <EmptyLibrary onAddMusic={onAddMusic} onAddSource={onAddSource} />;

  const attention = [
    ["Songs without a genre", issues.missing_genre, () => onNavigate("songs", { quick: ["unclassified"] })],
    ["Songs without artwork", issues.missing_artwork, () => onNavigate("songs", { quick: ["missingArtwork"] })],
    ["Songs without an album", issues.missing_album, () => onNavigate("songs", { quick: ["missingAlbum"] })],
    ["Possible duplicates", duplicates.tracks, () => onNavigate("songs", { quick: ["possibleDuplicates"], sort: "title" }), "info"],
    ["Missing or unreadable files", issues.missing_files, () => onNavigate("songs", { quick: ["missingFile"] }), "error"],
  ].filter(([, count]) => count > 0);

  return (
    <div className="lib-overview">
      <section className="lib-stats" aria-label="Library totals">
        <Stat label="Songs" value={formatNumber(totals.tracks)} onClick={() => onNavigate("songs")} />
        <Stat label="Albums" value={formatNumber(totals.albums)} onClick={() => onNavigate("albums")} />
        <Stat label="Artists" value={formatNumber(totals.artists)} onClick={() => onNavigate("artists")} />
        <Stat label="Genres" value={formatNumber(totals.genres)} onClick={() => onNavigate("genres")} />
        <Stat label="Favorites" value={formatNumber(totals.favorites)} onClick={() => onNavigate("favorites")} />
        <Stat label="Listening time" value={formatLongDuration(totals.duration_ms)} />
        <Stat label="Library size" value={formatBytes(totals.active_size)} />
      </section>

      {recent.length > 0 && (
        <RecentlyAdded
          rows={recent.slice(0, RECENT_SHOWN)}
          onOpenTrack={onOpenTrack}
          onTrackMenu={onTrackMenu}
          onViewAll={() => onNavigate("songs", { sort: "added", direction: "desc", chip: "Newest first" })}
        />
      )}

      <div className="lib-overview__grid">
        <GenreBars
          genres={genres}
          total={totals.tracks}
          onOpenGenre={(name) => onNavigate("songs", { genre: name, chip: `Genre: ${name || "Unclassified"}` })}
          onAllGenres={() => onNavigate("genres")}
        />
        <div className="lib-overview__side">
          <TopArtists artists={topArtists} onOpenArtist={(artist) => onNavigate("songs", { artist: artist.key, chip: `Artist: ${artist.name}`, sort: "album" })} />
          {attention.length > 0 && (
            <section className="panel" aria-labelledby="lib-attention">
              <div className="lib-section-head">
                <h2 id="lib-attention" className="section-label">
                  Needs attention
                </h2>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => onNavigate("review")}>
                  Review
                </button>
              </div>
              <div className="lib-issues">
                {attention.map(([label, count, open, tone]) => (
                  <IssueRow key={label} label={label} count={count} onOpen={open} tone={tone} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
