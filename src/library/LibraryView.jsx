import { useCallback, useState } from "react";
import { AlbumHeader, AlbumsView, ArtistsView, GenresView } from "./CollectionViews";
import { AlbumIcon, ArtistIcon, CloseIcon, GenreIcon, OverviewIcon, SongsIcon, SourceIcon, WarningIcon } from "./icons";
import { OverviewView } from "./OverviewView";
import { usePreviewPlayer } from "./Player";
import { SongBrowser } from "./SongBrowser";
import { ScanProgress, SourcesView } from "./SourcesView";
import { errorMessage, libraryApi, useLibraryJobs } from "./useLibrary";
import "./library.css";

// Sections appear here only once they are implemented.
const NAV_GROUPS = [
  {
    label: "Library",
    items: [
      { id: "overview", label: "Overview", Icon: OverviewIcon },
      { id: "songs", label: "Songs", Icon: SongsIcon },
      { id: "albums", label: "Albums", Icon: AlbumIcon },
      { id: "artists", label: "Artists", Icon: ArtistIcon },
      { id: "genres", label: "Genres", Icon: GenreIcon },
    ],
  },
  {
    label: "Manage",
    items: [{ id: "sources", label: "Sources", Icon: SourceIcon }],
  },
];

const TITLES = {
  overview: "Overview",
  songs: "Songs",
  albums: "Albums",
  artists: "Artists",
  genres: "Genres",
  sources: "Library sources",
  album: "Album",
};

export function LibraryView() {
  const [route, setRoute] = useState({ view: "overview", scope: {} });
  const [error, setError] = useState("");
  const { running, revision, bump } = useLibraryJobs();
  const [playing, play, player] = usePreviewPlayer();

  const scanJob = running.find((job) => job.kind === "scan");
  const busy = running.length > 0;

  const navigate = useCallback((view, scope = {}) => setRoute({ view, scope }), []);

  const addSource = async (role) => {
    setError("");
    try {
      const added = await libraryApi.addSourceFromDialog({ role, scan: true });
      if (added) {
        bump();
        navigate("sources");
      }
    } catch (err) {
      setError(errorMessage(err, "The folder couldn't be added"));
    }
  };

  const cancelJob = (id) => libraryApi.cancelJob({ id }).catch(() => {});

  const openAlbum = (releaseId) => navigate("album", { releaseId });
  const playTrack = (row) => play(row);
  const playFile = (track, file) => play(track, file);

  const browserProps = {
    revision,
    playing,
    onPlay: playTrack,
    onPlayFile: playFile,
    onOpenAlbum: openAlbum,
    onError: setError,
  };

  const { view, scope } = route;
  let content = null;

  if (view === "overview") {
    content = <OverviewView revision={revision} onNavigate={navigate} onAddSource={addSource} />;
  } else if (view === "songs") {
    const filters = {};
    if (scope.sourceId) filters.sourceId = scope.sourceId;
    if (scope.artist !== undefined) filters.artist = scope.artist;
    if (scope.genre !== undefined) filters.genre = scope.genre;
    content = (
      <SongBrowser
        key={JSON.stringify(scope)}
        {...browserProps}
        baseFilters={filters}
        initialQuick={scope.quick || []}
        defaultSort={scope.sort || "artist"}
        chips={scope.chip ? [scope.chip] : []}
        onClearScope={() => navigate("songs")}
      />
    );
  } else if (view === "album") {
    content = (
      <div className="lib-album-view">
        <AlbumHeader releaseId={scope.releaseId} revision={revision} />
        <SongBrowser
          key={scope.releaseId}
          {...browserProps}
          baseFilters={{ releaseId: scope.releaseId }}
          defaultSort="track"
          hideColumns={["album"]}
        />
      </div>
    );
  } else if (view === "albums") {
    content = <AlbumsView revision={revision} onOpenAlbum={openAlbum} />;
  } else if (view === "artists") {
    content = (
      <ArtistsView revision={revision} onOpenArtist={(artist) => navigate("songs", { artist: artist.key, chip: `Artist: ${artist.name}`, sort: "album" })} />
    );
  } else if (view === "genres") {
    content = (
      <GenresView
        revision={revision}
        onOpenGenre={(name) => navigate("songs", { genre: name, chip: `Genre: ${name || "Unclassified"}` })}
      />
    );
  } else if (view === "sources") {
    content = (
      <SourcesView
        revision={revision}
        busy={busy}
        scanJob={scanJob}
        onCancelJob={cancelJob}
        onAddSource={addSource}
        onError={setError}
      />
    );
  }

  const activeNav = view === "album" ? "albums" : view;

  return (
    <div className="library">
      <nav className="lib-nav" aria-label="Library sections">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="lib-nav__group">
            <span className="lib-nav__label">{group.label}</span>
            {group.items.map((item) => {
              const NavIcon = item.Icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`lib-nav__item ${activeNav === item.id ? "is-active" : ""}`}
                  aria-current={activeNav === item.id ? "page" : undefined}
                  onClick={() => navigate(item.id)}
                >
                  <NavIcon size={18} />
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="lib-content">
        <div className="lib-content__head">
          <h1 className="heading-md">{TITLES[view]}</h1>
          {scanJob && view !== "sources" && <ScanProgress job={scanJob} onCancel={() => cancelJob(scanJob.id)} />}
        </div>

        {error && (
          <div className="alert lib-alert" role="alert">
            <WarningIcon size={18} />
            <span className="alert__text">{error}</span>
            <button type="button" className="btn btn--ghost btn--icon" onClick={() => setError("")} aria-label="Dismiss">
              <CloseIcon size={14} />
            </button>
          </div>
        )}

        <div className="lib-content__body">{content}</div>
        {player}
      </div>
    </div>
  );
}
