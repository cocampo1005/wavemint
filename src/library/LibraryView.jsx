import { useCallback, useEffect, useState } from "react";
import { AudioEditor } from "../editor/AudioEditor";
import { usePlayer } from "../player/usePlayer";
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
import { DeleteFilesDialog } from "./DeleteFilesDialog";
import {
  CloseIcon,
  EditIcon,
  FolderOpenIcon,
  HeartIcon,
  NextIcon,
  PlayIcon,
  PlaylistIcon,
  PlusIcon,
  QueueIcon,
  TrashIcon,
  WarningIcon,
  WaveformIcon,
} from "./icons";
import { ManagedView } from "./ManagedView";
import { MergeView } from "./MergeView";
import { EmptyLibrary, OverviewView } from "./OverviewView";
import { QualityView } from "./QualityView";
import { ReviewView } from "./ReviewView";
import { SongBrowser } from "./SongBrowser";
import { StorageView } from "./StorageView";
import { TrackMenu } from "./TrackMenu";
import { UpgradeDialog } from "./UpgradeDialog";
import { ScanProgress, SourcesView } from "./SourcesView";
import { errorMessage, libraryApi } from "./useLibrary";
import "./library.css";

const TITLES = {
  overview: "Overview",
  songs: "Songs",
  favorites: "Favorites",
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
  storage: "Storage",
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
  "audio-edit": "audio-edit",
};

/**
 * The library workspace. Navigation lives in the app shell (AppNav), which
 * owns `route` and the background job state.
 */
export function LibraryView({ route, onNavigate: navigate, jobsState, status, onAddMusic }) {
  const [error, setError] = useState("");
  const [writeTags, setWriteTags] = useState(null); // { trackIds } | null
  const [editAlbum, setEditAlbum] = useState(null);
  const [upgrade, setUpgrade] = useState(null); // { trackId, start } | null
  const [identify, setIdentify] = useState(null); // trackId | null
  const [identifyAlbum, setIdentifyAlbum] = useState(null); // releaseId | null
  const [editAudio, setEditAudio] = useState(null); // trackId | null
  const [menu, setMenu] = useState(null); // { x, y, title, items }
  const [deleteRequest, setDeleteRequest] = useState(null); // trackIds | null
  const [notice, setNotice] = useState(null); // { text, undoId? }
  const { jobs, running, revision, bump } = jobsState;
  const player = usePlayer();
  const playing = player.playing;

  const scanJob = running.find((job) => job.kind === "scan");
  const otherJob = running.find((job) => job.kind !== "scan" && JOB_LABELS[job.kind]);
  const busy = running.length > 0;
  const lastJob = (kind) => jobs.filter((job) => job.kind === kind).at(-1) || null;
  const failedAnalysis = lastJob("merge-analysis");

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

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [notice]);

  const cancelJob = (id) => libraryApi.cancelJob({ id }).catch(() => {});
  const fail = (fallback) => (err) => setError(errorMessage(err, fallback));

  const editAudioFor = (trackId) => {
    player.pause();
    setEditAudio(trackId);
  };

  const setFavorite = (trackIds, favorite) =>
    libraryApi
      .setFavorite({ trackIds, favorite })
      .then(bump)
      .catch(fail("The favorite couldn't be saved"));

  const toggleFavorite = (row) => setFavorite([row.id], !row.favorite);

  // Remove from Library: no confirmation (files stay; Undo is offered).
  const removeFromLibrary = async (trackIds, rows) => {
    try {
      const result = await libraryApi.removeFromLibrary({ trackIds });
      bump();
      if (result.removed) {
        setNotice({
          text: `Removed ${result.removed === 1 && rows?.[0] ? `"${rows[0].title || "Untitled"}"` : pluralize(result.removed, "song")} from your library. The ${result.removed === 1 ? "file wasn't" : "files weren't"} changed.`,
          undoId: result.operationId,
        });
      }
    } catch (err) {
      setError(errorMessage(err, "The songs couldn't be removed"));
    }
  };

  const undoNotice = async () => {
    const id = notice?.undoId;
    setNotice(null);
    try {
      await libraryApi.undoOperation({ id });
      bump();
      setNotice({ text: "Restored." });
    } catch (err) {
      setError(errorMessage(err, "That couldn't be undone"));
    }
  };

  const addToPlaylist = async (playlist, trackIds) => {
    try {
      const result = await libraryApi.addToPlaylist({ id: playlist.id, trackIds });
      bump();
      setNotice({ text: `Added ${pluralize(result.added, "song")} to "${playlist.name}".` });
    } catch (err) {
      setError(errorMessage(err, "The songs couldn't be added to the playlist"));
    }
  };

  const newPlaylist = async (trackIds) => {
    try {
      const created = await libraryApi.createPlaylist({ name: "New Playlist", kind: "manual", trackIds });
      bump();
      setNotice({ text: `Created "${created.name}" with ${pluralize(trackIds.length, "song")}. Rename it in Playlists.` });
    } catch (err) {
      setError(errorMessage(err, "The playlist couldn't be created"));
    }
  };

  /**
   * The song actions menu (right-click or ⋯), the same everywhere. A request
   * has the clicked row, the ids it applies to (the selection when the row is
   * part of it), and optional context actions (play the list from here, open
   * the details, remove from the playlist being shown).
   */
  const openTrackMenu = useCallback(
    (request) => {
      const { ids, row } = request;
      const rows = request.rows?.length ? request.rows : [row];
      const single = ids.length === 1;
      const favorite = single && !!row.favorite;
      const items = [
        {
          label: "Play Now",
          icon: <PlayIcon size={14} />,
          onSelect: () => (request.onPlayNow ? request.onPlayNow() : player.playList({ label: single ? row.title : "Selected songs", ids, rows, startId: ids[0] })),
        },
        { label: "Play Next", icon: <NextIcon size={14} />, onSelect: () => player.playNext(ids, rows) },
        { label: "Add to Queue", icon: <QueueIcon size={14} />, onSelect: () => player.addToQueue(ids, rows) },
        "separator",
        {
          label: "Add to Playlist",
          icon: <PlaylistIcon size={14} />,
          submenu: async () => {
            const lists = (await libraryApi.listPlaylists().catch(() => [])).filter((list) => list.kind === "manual");
            return [
              ...lists.map((list) => ({ label: list.name, onSelect: () => addToPlaylist(list, ids) })),
              ...(lists.length ? ["separator"] : []),
              { label: "New Playlist", icon: <PlusIcon size={14} />, onSelect: () => newPlaylist(ids) },
            ];
          },
        },
        ...(request.onRemoveFromPlaylist ? [{ label: "Remove from This Playlist", icon: <CloseIcon size={14} />, onSelect: request.onRemoveFromPlaylist }] : []),
        "separator",
        ...(single
          ? [
              { label: "Edit Metadata", icon: <EditIcon size={14} />, onSelect: () => (request.onEditMetadata ? request.onEditMetadata() : openTrack(row.id)) },
              { label: "Edit Audio…", icon: <WaveformIcon size={14} />, disabled: !row.file_id || row.file_status === "missing", onSelect: () => editAudioFor(row.id) },
            ]
          : []),
        {
          label: favorite ? "Remove from Favorites" : "Add to Favorites",
          icon: <HeartIcon size={14} filled={favorite} />,
          onSelect: () => setFavorite(ids, !favorite),
        },
        ...(single && row.file_id
          ? [{ label: "Show in Explorer", icon: <FolderOpenIcon size={14} />, onSelect: () => libraryApi.showFileInFolder({ fileId: row.file_id }).catch(fail("The file couldn't be shown")) }]
          : []),
        "separator",
        { label: "Remove from Library", icon: <CloseIcon size={14} />, hint: "keeps the file", onSelect: () => removeFromLibrary(ids, rows) },
        { label: "Delete File…", icon: <TrashIcon size={14} />, danger: true, onSelect: () => setDeleteRequest(ids) },
      ];
      setMenu({ x: request.x, y: request.y, title: single ? row.title || "Untitled" : pluralize(ids.length, "song"), items });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player],
  );
  const openAlbum = (releaseId) => navigate("album", { releaseId });
  const openTrack = (trackId) => navigate("songs", { ids: [trackId], activeId: trackId, chip: "Selected song" });

  const browserProps = {
    revision,
    onPlayFile: (track, file) => player.playFile(track, file),
    onOpenAlbum: openAlbum,
    onError: setError,
    onChanged: bump,
    onWriteTags: (trackIds) => setWriteTags({ trackIds }),
    onUpgrade: (trackId, start = null) => setUpgrade({ trackId, start }),
    onIdentify: (trackId) => setIdentify(trackId),
    onEditAudio: editAudioFor,
    onToggleFavorite: toggleFavorite,
    onTrackMenu: openTrackMenu,
    toolbarExtra: ({ selection }) =>
      selection.size > 0 ? <AddToPlaylist trackIds={[...selection]} onDone={() => bump()} onError={setError} /> : null,
  };

  const { view, scope } = route;
  let content = null;

  if (view === "overview") {
    content = <OverviewView revision={revision} onNavigate={navigate} onAddMusic={onAddMusic} onAddSource={addSource} onOpenTrack={openTrack} onTrackMenu={openTrackMenu} />;
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
        defaultDirection={scope.direction || "asc"}
        explicitSort={!!scope.sort}
        sortStorageKey={Object.keys(filters).length ? null : "songs"}
        contextLabel={scope.chip && !scope.chip.startsWith("Newest") ? scope.chip.replace(/^(Artist|Genre): /, "") : "Songs"}
        chips={scope.chip ? [scope.chip] : []}
        onClearScope={() => navigate("songs")}
        emptyState={Object.keys(filters).length || status?.tracks !== 0 ? null : <EmptyLibrary onAddMusic={onAddMusic} onAddSource={addSource} />}
      />
    );
  } else if (view === "favorites") {
    content = (
      <SongBrowser
        key="favorites"
        {...browserProps}
        baseFilters={{ favorite: true }}
        contextLabel="Favorites"
        sortStorageKey="favorites"
        defaultSort="added"
        defaultDirection="desc"
        emptyState={<span>No favorites yet. Click the heart on any song to add it here.</span>}
      />
    );
  } else if (view === "album") {
    content = (
      <div className="lib-album-view">
        <AlbumHeader releaseId={scope.releaseId} revision={revision} onEdit={setEditAlbum} onIdentify={(album) => setIdentifyAlbum(album.id)} />
        <SongBrowser key={scope.releaseId} {...browserProps} baseFilters={{ releaseId: scope.releaseId }} contextLabel="this album" defaultSort="track" explicitSort hideColumns={["album"]} />
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
          onPlay={(row) => player.playTrack(row)}
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
        onPlay={(row) => player.playTrack(row)}
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
    content = <PlaylistsView revision={revision} playing={playing} onOpenTrack={openTrack} onTrackMenu={openTrackMenu} onChanged={bump} onError={setError} />;
  } else if (view === "iphone") {
    content = <IphoneView revision={revision} exporting={running.some((job) => job.kind === "export")} onChanged={bump} onError={setError} />;
  } else if (view === "managed") {
    content = <ManagedView revision={revision} busy={busy} lastJob={lastJob("consolidate")} onChanged={bump} onError={setError} />;
  } else if (view === "history") {
    content = <HistoryView revision={revision} onChanged={bump} onError={setError} />;
  } else if (view === "storage") {
    content = <StorageView revision={revision} onError={setError} />;
  } else if (view === "sources") {
    content = <SourcesView revision={revision} busy={busy} scanJob={scanJob} onCancelJob={cancelJob} onAddSource={addSource} onError={setError} />;
  }

  return (
    <div className="library">

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
          <button type="button" className="btn btn--primary btn--sm lib-content__add" onClick={onAddMusic}>
            <PlusIcon size={16} /> Add Music
          </button>
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

        {notice && (
          <div className="lib-notice" role="status">
            <span className="lib-notice__text">{notice.text}</span>
            {notice.undoId && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={undoNotice}>
                Undo
              </button>
            )}
            <button type="button" className="btn btn--ghost btn--icon" onClick={() => setNotice(null)} aria-label="Dismiss">
              <CloseIcon size={14} />
            </button>
          </div>
        )}

        <div className="lib-content__body">{content}</div>
      </div>

      {menu && <TrackMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)} />}
      {deleteRequest && (
        <DeleteFilesDialog
          trackIds={deleteRequest}
          onClose={() => setDeleteRequest(null)}
          onDone={(result) => {
            setDeleteRequest(null);
            bump();
            const failed = result.failures?.length ? ` ${pluralize(result.failures.length, "file")} couldn't be moved: ${result.failures[0].error}` : "";
            setNotice({ text: `Moved ${pluralize(result.deleted, "song")} to the Recycle Bin.${failed}` });
          }}
        />
      )}

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
          key={upgrade.trackId}
          trackId={upgrade.trackId}
          start={upgrade.start}
          onClose={() => {
            setUpgrade(null);
            bump();
          }}
          onDone={(result, track) =>
            setNotice({
              text: `Upgraded "${track?.title || "Untitled"}".${result?.mode === "copy" && result.target ? ` The new file is ${result.target}.` : ""}`,
              undoId: result?.operationId,
            })
          }
        />
      )}
      {editAudio && (
        <AudioEditor
          mode="library"
          trackId={editAudio}
          onClose={() => setEditAudio(null)}
          onDone={() => {
            setEditAudio(null);
            bump();
          }}
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
