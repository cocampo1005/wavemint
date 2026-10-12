import { useCallback, useState } from "react";
import { AlbumIdentifyDialog } from "./AlbumIdentifyDialog";
import { AlbumHeader, AlbumsView, ArtistsView } from "./CollectionViews";
import { AlbumEditor, WriteTagsDialog } from "./Editors";
import { pluralize } from "./format";
import { GenreManager } from "./GenreManager";
import { HistoryView } from "./HistoryView";
import { IphoneView } from "./IphoneView";
import { AddToPlaylist, PlaylistsView } from "./PlaylistsView";
import { IdentifyDialog } from "./IdentifyDialog";
import { IdentifyView } from "./IdentifyView";
import {
  AlbumIcon,
  ArtistIcon,
  CloseIcon,
  FolderOpenIcon,
  GenreIcon,
  HistoryIcon,
  MergeIcon,
  OverviewIcon,
  PhoneIcon,
  PlaylistIcon,
  QualityIcon,
  ReviewIcon,
  SearchIcon,
  SongsIcon,
  SourceIcon,
  WarningIcon,
} from "./icons";
import { ManagedView } from "./ManagedView";
import { MergeView } from "./MergeView";
import { OverviewView } from "./OverviewView";
import { QualityView } from "./QualityView";
import { usePreviewPlayer } from "./Player";
import { ReviewView } from "./ReviewView";
import { SongBrowser } from "./SongBrowser";
import { UpgradeDialog } from "./UpgradeDialog";
import { ScanProgress, SourcesView } from "./SourcesView";
import { errorMessage, libraryApi, useLibraryJobs, useLoader } from "./useLibrary";
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
      { id: "playlists", label: "Playlists", Icon: PlaylistIcon },
    ],
  },
  {
    label: "Maintain",
    items: [
      { id: "review", label: "Review", Icon: ReviewIcon, badge: "reviewOpen" },
      { id: "merge", label: "Merge & Duplicates", Icon: MergeIcon },
      { id: "quality", label: "Quality & Upgrades", Icon: QualityIcon, badge: "qualityAttention" },
      { id: "identify", label: "Identify", Icon: SearchIcon },
    ],
  },
  {
    label: "Manage",
    items: [
      { id: "sources", label: "Sources", Icon: SourceIcon },
      { id: "managed", label: "WaveMint Library", Icon: FolderOpenIcon },
      { id: "iphone", label: "Prepare for iPhone", Icon: PhoneIcon },
      { id: "history", label: "History", Icon: HistoryIcon },
    ],
  },
];

const TITLES = {
  overview: "Overview",
  songs: "Songs",
  albums: "Albums",
  artists: "Artists",
  genres: "Genres",
  review: "Review",
  merge: "Merge & Duplicates",
  quality: "Quality & Upgrades",
  identify: "Identify",
  managed: "WaveMint Library",
  playlists: "Playlists",
  iphone: "Prepare for iPhone",
  sources: "Library sources",
  history: "History",
  album: "Album",
};

const JOB_LABELS = {
  scan: "scan",
  "write-tags": "write-tags",
  "merge-analysis": "merge-analysis",
  consolidate: "consolidate",
  "quality-check": "quality-check",
  upgrade: "upgrade",
  identify: "identify",
  import: "import",
  export: "export",
};

export function LibraryView() {
  const [route, setRoute] = useState({ view: "overview", scope: {} });
  const [error, setError] = useState("");
  const [writeTags, setWriteTags] = useState(null); // { trackIds } | null
  const [editAlbum, setEditAlbum] = useState(null);
  const [upgrade, setUpgrade] = useState(null); // { trackId, start } | null
  const [identify, setIdentify] = useState(null); // trackId | null
  const [identifyAlbum, setIdentifyAlbum] = useState(null); // releaseId | null
  const { jobs, running, revision, bump } = useLibraryJobs();
  const [playing, play, player] = usePreviewPlayer();
  const { data: status } = useLoader(() => libraryApi.getStatus(), [revision]);

  const scanJob = running.find((job) => job.kind === "scan");
  const otherJob = running.find((job) => job.kind !== "scan" && JOB_LABELS[job.kind]);
  const busy = running.length > 0;
  const lastJob = (kind) => jobs.filter((job) => job.kind === kind).at(-1) || null;
  const failedAnalysis = lastJob("merge-analysis");

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
  const openTrack = (trackId) => navigate("songs", { ids: [trackId], activeId: trackId, chip: "Selected song" });

  const browserProps = {
    revision,
    playing,
    onPlay: (row) => play(row),
    onPlayFile: (track, file) => play(track, file),
    onOpenAlbum: openAlbum,
    onError: setError,
    onChanged: bump,
    onWriteTags: (trackIds) => setWriteTags({ trackIds }),
    onUpgrade: (trackId, start = null) => setUpgrade({ trackId, start }),
    onIdentify: (trackId) => setIdentify(trackId),
    toolbarExtra: ({ selection }) =>
      selection.size > 0 ? <AddToPlaylist trackIds={[...selection]} onDone={() => bump()} onError={setError} /> : null,
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
    if (scope.ids) filters.ids = scope.ids;
    content = (
      <SongBrowser
        key={JSON.stringify(scope)}
        {...browserProps}
        baseFilters={filters}
        initialQuick={scope.quick || []}
        initialActiveId={scope.activeId}
        defaultSort={scope.sort || "artist"}
        chips={scope.chip ? [scope.chip] : []}
        onClearScope={() => navigate("songs")}
      />
    );
  } else if (view === "album") {
    content = (
      <div className="lib-album-view">
        <AlbumHeader releaseId={scope.releaseId} revision={revision} onEdit={setEditAlbum} onIdentify={(album) => setIdentifyAlbum(album.id)} />
        <SongBrowser key={scope.releaseId} {...browserProps} baseFilters={{ releaseId: scope.releaseId }} defaultSort="track" hideColumns={["album"]} />
      </div>
    );
  } else if (view === "albums") {
    content = <AlbumsView revision={revision} onOpenAlbum={openAlbum} />;
  } else if (view === "artists") {
    content = <ArtistsView revision={revision} onOpenArtist={(artist) => navigate("songs", { artist: artist.key, chip: `Artist: ${artist.name}`, sort: "album" })} />;
  } else if (view === "genres") {
    content = (
      <GenreManager
        revision={revision}
        onChanged={bump}
        onError={setError}
        onOpenGenre={(name) => navigate("songs", { genre: name, chip: `Genre: ${name || "Unclassified"}` })}
      />
    );
  } else if (view === "review") {
    content = <ReviewView revision={revision} onChanged={bump} onOpenTrack={openTrack} onOpenAlbum={openAlbum} onError={setError} />;
  } else if (view === "merge") {
    content = (
      <>
        {failedAnalysis?.status === "failed" && <div className="alert alert--compact">The comparison failed: {failedAnalysis.error}</div>}
        <MergeView
          revision={revision}
          analyzing={failedAnalysis?.status === "running"}
          playing={playing}
          onPlay={(row) => play(row)}
          onChanged={bump}
          onError={setError}
        />
      </>
    );
  } else if (view === "quality") {
    content = (
      <QualityView
        revision={revision}
        checking={running.some((job) => job.kind === "quality-check")}
        playing={playing}
        onPlay={(row) => play(row)}
        onOpenTrack={openTrack}
        onUpgrade={(trackId) => setUpgrade({ trackId, start: null })}
        onChanged={bump}
        onError={setError}
      />
    );
  } else if (view === "identify") {
    content = (
      <IdentifyView
        revision={revision}
        identifying={running.some((job) => job.kind === "identify")}
        onReview={(trackId) => setIdentify(trackId)}
        onChanged={bump}
        onError={setError}
      />
    );
  } else if (view === "playlists") {
    content = <PlaylistsView revision={revision} playing={playing} onPlay={(row) => play(row)} onOpenTrack={openTrack} onChanged={bump} onError={setError} />;
  } else if (view === "iphone") {
    content = <IphoneView revision={revision} exporting={running.some((job) => job.kind === "export")} onChanged={bump} onError={setError} />;
  } else if (view === "managed") {
    content = <ManagedView revision={revision} busy={busy} lastJob={lastJob("consolidate")} onChanged={bump} onError={setError} />;
  } else if (view === "history") {
    content = <HistoryView revision={revision} onChanged={bump} onError={setError} />;
  } else if (view === "sources") {
    content = <SourcesView revision={revision} busy={busy} scanJob={scanJob} onCancelJob={cancelJob} onAddSource={addSource} onError={setError} />;
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
              const count = item.badge ? status?.[item.badge] : 0;
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
                  {count > 0 && <span className="lib-nav__count">{count}</span>}
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
          {otherJob && (
            <div className="lib-job" role="status">
              <div className="lib-job__text">
                <strong>{otherJob.label}</strong>
                {otherJob.progress && (
                  <span>
                    {otherJob.progress.done ?? 0} of {otherJob.progress.total ?? "?"} · {otherJob.progress.current || ""}
                  </span>
                )}
              </div>
              <div className="progress__track is-indeterminate lib-job__bar">
                <div className="progress__fill" />
              </div>
              <button type="button" className="btn btn--link" onClick={() => cancelJob(otherJob.id)}>
                Stop
              </button>
            </div>
          )}
          {!otherJob && status?.unsavedWritable > 0 && (
            <div className="lib-unsaved" role="status">
              <span>{pluralize(status.unsavedWritable, "song")} with changes not yet written to files</span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setWriteTags({ trackIds: null })}>
                Write Tags…
              </button>
            </div>
          )}
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

      {writeTags && (
        <WriteTagsDialog
          trackIds={writeTags.trackIds}
          onClose={() => setWriteTags(null)}
          onStarted={() => {
            setWriteTags(null);
            bump();
          }}
        />
      )}
      {identify && (
        <IdentifyDialog
          trackId={identify}
          onClose={() => {
            setIdentify(null);
            bump();
          }}
          onApplied={bump}
        />
      )}
      {identifyAlbum && (
        <AlbumIdentifyDialog
          releaseId={identifyAlbum}
          onClose={() => {
            setIdentifyAlbum(null);
            bump();
          }}
          onApplied={bump}
        />
      )}
      {upgrade && (
        <UpgradeDialog
          trackId={upgrade.trackId}
          start={upgrade.start}
          onClose={() => {
            setUpgrade(null);
            bump();
          }}
          onDone={bump}
        />
      )}
      {editAlbum && (
        <AlbumEditor
          album={editAlbum}
          onClose={() => setEditAlbum(null)}
          onChanged={bump}
          onError={setError}
        />
      )}
    </div>
  );
}
