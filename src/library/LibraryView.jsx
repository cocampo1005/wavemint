import { useCallback, useState } from "react";
import { AudioEditor } from "../editor/AudioEditor";
import { usePlayer } from "../player/usePlayer";
import { useToast } from "../toasts/useToast";
import { AlbumIdentifyDialog } from "./AlbumIdentifyDialog";
import { AlbumDetail, AlbumsView, ArtistDetail, ArtistsView, Breadcrumbs, GenreDetail, GenresView } from "./CollectionViews";
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
  RefreshIcon,
  TrashIcon,
  WaveformIcon,
} from "./icons";
import { EarlierVersionsPanel, FormatsPanel } from "./LibraryFiles";
import { ManagedView } from "./ManagedView";
import { MergeView } from "./MergeView";
import { EmptyLibrary, OverviewView } from "./OverviewView";
import { ReviewView } from "./ReviewView";
import { SECTIONS, sectionOf } from "./sections";
import { WithSongPanel } from "./SongPanel";
import { SongBrowser } from "./SongBrowser";
import { StorageView } from "./StorageView";
import { TrackMenu } from "./TrackMenu";
import { UpgradeDialog } from "./UpgradeDialog";
import { ScanProgress, SourcesView } from "./SourcesView";
import { errorMessage, libraryApi, useJobRunner } from "./useLibrary";
import "./library.css";

const STORAGE_PARTS = [
  ["usage", "Disk usage & cleanup"],
  ["formats", "Audio formats"],
  ["versions", "Earlier versions"],
];

/**
 * Library Tools → Storage: what WaveMint keeps on disk (and cleanup), the
 * library by audio format (with the genre tag check), and the earlier
 * versions kept after upgrades and edits. Songs open beside the list.
 */
function StorageSection({ revision, part, onPart, browserProps, onError }) {
  const [openTrack, setOpenTrack] = useState(null);
  return (
    <WithSongPanel trackId={openTrack} onClose={() => setOpenTrack(null)} browserProps={browserProps}>
      <div className="lib-chips" role="tablist" aria-label="Storage">
        {STORAGE_PARTS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={part === id} className={`lib-chip ${part === id ? "is-on" : ""}`} onClick={() => onPart(id)}>
            {label}
          </button>
        ))}
      </div>
      {part === "usage" && <StorageView revision={revision} onError={onError} />}
      {part === "formats" && <FormatsPanel revision={revision} onOpen={setOpenTrack} onError={onError} />}
      {part === "versions" && (
        <EarlierVersionsPanel revision={revision} onOpen={setOpenTrack} onRestore={(trackId, start) => browserProps.onUpgrade(trackId, start)} onError={onError} />
      )}
    </WithSongPanel>
  );
}

/** The tabs of a section with several views (Music, Library Tools). */
function SectionTabs({ section, view, onSelect }) {
  if (!section.tabs) return null;
  return (
    <div className="lib-tabs lib-section-tabs" role="tablist" aria-label={section.label}>
      {section.tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={view === id} className={`lib-tabs__tab ${view === id ? "is-active" : ""}`} onClick={() => onSelect(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const JOB_LABELS = {
  scan: "scan",
  "write-tags": "write-tags",
  "merge-analysis": "merge-analysis",
  consolidate: "consolidate",
  upgrade: "upgrade",
  identify: "identify",
  import: "import",
  export: "export",
  "audio-edit": "audio-edit",
  "apple-sync": "apple-sync",
  "apple-preview": "apple-preview",
  "apple-migration": "apple-migration",
  "apple-backup": "apple-backup",
  "apple-verify": "apple-verify",
  "apple-cleanup": "apple-cleanup",
};

/**
 * The library workspace. Navigation lives in the app shell (AppNav), which
 * owns `route` and the background job state.
 */
export function LibraryView({ route, onNavigate: navigate, jobsState, status, onAddMusic }) {
  const [writeTags, setWriteTags] = useState(null); // { trackIds } | null
  const [editAlbum, setEditAlbum] = useState(null);
  const [upgrade, setUpgrade] = useState(null); // { trackId, start } | null
  const [identify, setIdentify] = useState(null); // trackId | null
  const [identifyAlbum, setIdentifyAlbum] = useState(null); // releaseId | null
  const [editAudio, setEditAudio] = useState(null); // trackId | null
  const [menu, setMenu] = useState(null); // { x, y, title, items }
  const [deleteRequest, setDeleteRequest] = useState(null); // trackIds | null
  // Results and errors are toasts, so the page never shifts when one shows.
  const { notify } = useToast();
  const setError = useCallback((message) => message && notify({ tone: "error", text: message }), [notify]);
  const { jobs, running, revision, bump } = jobsState;
  const player = usePlayer();
  const playing = player.playing;

  const scanJob = running.find((job) => job.kind === "scan");
  const otherJob = running.find((job) => job.kind !== "scan" && JOB_LABELS[job.kind]);
  // Syncing with Apple runs beside other work: it doesn't lock the rest of the library.
  const busy = running.some((job) => !job.kind.startsWith("apple-"));
  const lastJob = (kind) => jobs.filter((job) => job.kind === kind).at(-1) || null;
  const failedAnalysis = lastJob("merge-analysis");

  const addSource = async (role) => {
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
  const fail = (fallback) => (err) => setError(errorMessage(err, fallback));
  const runJob = useJobRunner();

  /**
   * Sync to iTunes for chosen songs only: adds them, sends their saved changes,
   * relinks moved files (removals still need the Apple Library Sync screen).
   * Nothing else in the library is touched.
   */
  const syncToItunes = async (ids) => {
    try {
      const job = await runJob(libraryApi.runAppleSync({ trackIds: ids }));
      if (job.status !== "completed") return setError(job.error || "The sync didn't complete.");
      const report = job.result || {};
      const done = (report.added || 0) + (report.adopted || 0) + (report.updated || 0) + (report.relinked || 0) + (report.recreated || 0) + (report.removed || 0);
      const problems = [...(report.failed || []).map((item) => item.error), ...(report.skipped || []).map((item) => item.reason)];
      if (["waiting", "blocked", "stopped"].includes(report.status)) return notify({ tone: "warning", text: report.reason });
      if (report.status === "nothing" && !problems.length && !report.review) return notify({ text: `Already up to date in iTunes (${pluralize(ids.length, "song")}).` });
      notify({
        tone: problems.length || report.review ? "warning" : "success",
        text: [
          done ? `Synced ${pluralize(done, "song")} to iTunes: ${report.added || 0} added, ${report.updated || 0} updated, ${report.relinked || 0} relinked.` : "Nothing was synced.",
          problems.length ? `${pluralize(problems.length, "problem")}: ${problems[0]}` : "",
          report.review ? `${pluralize(report.review, "change")} need a decision in Apple Library Sync.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    } catch (err) {
      setError(errorMessage(err, "The sync couldn't start."));
    }
  };

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
        notify({
          text: `Removed ${result.removed === 1 && rows?.[0] ? `"${rows[0].title || "Untitled"}"` : pluralize(result.removed, "song")} from your library. The ${result.removed === 1 ? "file wasn't" : "files weren't"} changed.`,
          action: undoAction(result.operationId),
        });
      }
    } catch (err) {
      setError(errorMessage(err, "The songs couldn't be removed"));
    }
  };

  const undo = async (id) => {
    try {
      await libraryApi.undoOperation({ id });
      bump();
      notify({ text: "Restored." });
    } catch (err) {
      setError(errorMessage(err, "That couldn't be undone"));
    }
  };
  const undoAction = (id) => (id ? { label: "Undo", onClick: () => undo(id) } : null);

  const addToPlaylist = async (playlist, trackIds) => {
    try {
      const result = await libraryApi.addToPlaylist({ id: playlist.id, trackIds });
      bump();
      notify({ text: `Added ${pluralize(result.added, "song")} to "${playlist.name}".` });
    } catch (err) {
      setError(errorMessage(err, "The songs couldn't be added to the playlist"));
    }
  };

  const newPlaylist = async (trackIds) => {
    try {
      const created = await libraryApi.createPlaylist({ name: "New Playlist", kind: "manual", trackIds });
      bump();
      notify({ text: `Created "${created.name}" with ${pluralize(trackIds.length, "song")}. Rename it in Playlists.` });
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
        { label: "Sync to iTunes", icon: <RefreshIcon size={14} />, hint: single ? "this song only" : "these songs only", onSelect: () => syncToItunes(ids) },
        "separator",
        { label: "Remove from Library", icon: <CloseIcon size={14} />, hint: "keeps the file", onSelect: () => removeFromLibrary(ids, rows) },
        { label: "Delete File…", icon: <TrashIcon size={14} />, danger: true, onSelect: () => setDeleteRequest(ids) },
      ];
      setMenu({ x: request.x, y: request.y, title: single ? row.title || "Untitled" : pluralize(ids.length, "song"), items });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [player],
  );
  const { view, scope } = route;
  const section = SECTIONS[sectionOf(view)];

  // Artists, Albums and Genres keep their own place: opening an album or an
  // artist from inside one of them stays in that tab (Genres › Rock › Album).
  const openAlbum = (releaseId, title = "") => {
    if (view === "artists" && scope.artist) navigate("artists", { artist: scope.artist, artistName: scope.artistName, releaseId, albumTitle: title });
    else if (view === "genres" && scope.genre !== undefined) navigate("genres", { genre: scope.genre, releaseId, albumTitle: title });
    else navigate("albums", { releaseId, albumTitle: title });
  };
  const openArtist = (key, name = "") => {
    if (!key) return;
    if (view === "genres" && scope.genre !== undefined) navigate("genres", { genre: scope.genre, artist: key, artistName: name });
    else navigate("artists", { artist: key, artistName: name });
  };
  const openGenre = (name) => navigate("genres", { genre: name });
  const openTrack = (trackId) => navigate("songs", { ids: [trackId], activeId: trackId, chip: "Selected song" });

  const browserProps = {
    revision,
    onPlayFile: (track, file) => player.playFile(track, file),
    onOpenAlbum: openAlbum,
    onOpenArtist: openArtist,
    onError: setError,
    onChanged: bump,
    onUpgrade: (trackId, start = null) => setUpgrade({ trackId, start }),
    onIdentify: (trackId) => setIdentify(trackId),
    onEditAudio: editAudioFor,
    onToggleFavorite: toggleFavorite,
    onTrackMenu: openTrackMenu,
    toolbarExtra: ({ selection }) =>
      selection.size > 0 ? <AddToPlaylist trackIds={[...selection]} onDone={() => bump()} onError={setError} /> : null,
  };

  let content = null;
  const albumDetail = (crumbs) => (
    <AlbumDetail
      releaseId={scope.releaseId}
      crumbs={[...crumbs, { label: scope.albumTitle || "Album" }]}
      revision={revision}
      browserProps={browserProps}
      onEditAlbum={setEditAlbum}
      onIdentifyAlbum={(album) => setIdentifyAlbum(album.id)}
      onOpenArtist={view === "albums" ? openArtist : undefined}
    />
  );

  if (view === "overview") {
    content = <OverviewView revision={revision} onNavigate={navigate} onAddMusic={onAddMusic} onAddSource={addSource} onOpenTrack={openTrack} onTrackMenu={openTrackMenu} />;
  } else if (view === "songs") {
    const filters = {};
    if (scope.sourceId) filters.sourceId = scope.sourceId;
    if (scope.ids) filters.ids = scope.ids;
    content = (
      <SongBrowser
        key={JSON.stringify(scope)}
        {...browserProps}
        baseFilters={filters}
        initialActiveId={scope.activeId}
        defaultSort={scope.sort || "artist"}
        defaultDirection={scope.direction || "asc"}
        explicitSort={!!scope.sort}
        sortStorageKey={Object.keys(filters).length ? null : "songs"}
        contextLabel={scope.chip && !scope.chip.startsWith("Newest") ? scope.chip : "Songs"}
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
        facets={["artists", "albums", "genres", "decades"]}
        contextLabel="Favorites"
        sortStorageKey="favorites"
        defaultSort="added"
        defaultDirection="desc"
        emptyState={<span>No favorites yet. Click the heart on any song to add it here.</span>}
      />
    );
  } else if (view === "albums") {
    const toAlbums = () => navigate("albums");
    content = scope.releaseId ? albumDetail([{ label: "Albums", onClick: toAlbums }]) : <AlbumsView revision={revision} onOpenAlbum={openAlbum} />;
  } else if (view === "artists") {
    const toArtists = () => navigate("artists");
    const artistCrumbs = [
      { label: "Artists", onClick: toArtists },
      { label: scope.artistName || "Artist", onClick: () => navigate("artists", { artist: scope.artist, artistName: scope.artistName }) },
    ];
    if (scope.artist && scope.releaseId) content = albumDetail(artistCrumbs);
    else if (scope.artist) {
      content = (
        <ArtistDetail
          key={scope.artist}
          artistKey={scope.artist}
          crumbs={artistCrumbs}
          revision={revision}
          browserProps={browserProps}
          onOpenAlbum={openAlbum}
          onOpenGenre={openGenre}
        />
      );
    } else content = <ArtistsView revision={revision} onOpenArtist={(artist) => openArtist(artist.key, artist.name)} />;
  } else if (view === "genres") {
    const toGenres = () => navigate("genres");
    const genreCrumbs = [
      { label: "Genres", onClick: toGenres },
      { label: scope.genre || "Unclassified", onClick: () => navigate("genres", { genre: scope.genre }) },
    ];
    if (scope.manage) {
      content = (
        <div className="lib-detail-view is-scroll">
          <Breadcrumbs items={[{ label: "Genres", onClick: toGenres }, { label: "Manage genres" }]} />
          <GenreManager revision={revision} onChanged={bump} onError={setError} onOpenGenre={openGenre} />
        </div>
      );
    } else if (scope.genre !== undefined && scope.releaseId) content = albumDetail(genreCrumbs);
    else if (scope.genre !== undefined && scope.artist) {
      content = (
        <ArtistDetail
          key={`${scope.genre}:${scope.artist}`}
          artistKey={scope.artist}
          genre={scope.genre}
          crumbs={[...genreCrumbs, { label: scope.artistName || "Artist" }]}
          revision={revision}
          browserProps={browserProps}
          onOpenAlbum={openAlbum}
        />
      );
    } else if (scope.genre !== undefined) {
      content = (
        <GenreDetail
          key={scope.genre}
          genre={scope.genre}
          crumbs={[{ label: "Genres", onClick: toGenres }, { label: scope.genre || "Unclassified" }]}
          revision={revision}
          browserProps={browserProps}
          onOpenArtist={(artist) => openArtist(artist.key, artist.name)}
          onOpenAlbum={openAlbum}
        />
      );
    } else {
      content = (
        <GenresView
          revision={revision}
          onOpenGenre={openGenre}
          onManage={() => navigate("genres", { manage: true })}
          onReviewUnclassified={() => openGenre("")}
        />
      );
    }
  } else if (view === "review") {
    content = (
      <ReviewView
        key={scope.tab || "attention"}
        initialTab={scope.tab || "attention"}
        revision={revision}
        browserProps={browserProps}
        scanning={!!scanJob}
        onChanged={bump}
        onRemove={removeFromLibrary}
        onError={setError}
      />
    );
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
    content = <IphoneView revision={revision} exporting={running.some((job) => job.kind === "export")} running={running} onChanged={bump} onError={setError} />;
  } else if (view === "managed") {
    content = <ManagedView revision={revision} busy={busy} lastJob={lastJob("consolidate")} onChanged={bump} onError={setError} />;
  } else if (view === "history") {
    content = <HistoryView revision={revision} onChanged={bump} onError={setError} />;
  } else if (view === "storage") {
    content = <StorageSection revision={revision} part={scope.part || "usage"} onPart={(part) => navigate("storage", { part })} browserProps={browserProps} onError={setError} />;
  } else if (view === "sources") {
    content = <SourcesView revision={revision} busy={busy} scanJob={scanJob} onCancelJob={cancelJob} onAddSource={addSource} onError={setError} onNavigate={navigate} />;
  }

  return (
    <div className="library">

      <div className="lib-content">
        <div className="lib-content__head">
          <h1 className="heading-md">{section.label}</h1>
          <SectionTabs section={section} view={view} onSelect={(id) => navigate(id)} />
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
          {/* Saving writes into the files; this only shows when some couldn't be written (or are waiting for a task). */}
          {!otherJob && status?.unsavedWritable > 0 && (
            <div className="lib-unsaved" role="status">
              <span>
                {pluralize(status.unsavedWritable, "song")} not yet saved to {status.unsavedWritable === 1 ? "its file" : "their files"}
              </span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setWriteTags({ trackIds: null })}>
                Retry…
              </button>
            </div>
          )}
          <button type="button" className="btn btn--primary btn--sm lib-content__add" onClick={onAddMusic}>
            <PlusIcon size={16} /> Add Music
          </button>
        </div>

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
            notify({ tone: failed ? "warning" : "success", text: `Moved ${pluralize(result.deleted, "song")} to the Recycle Bin.${failed}` });
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
            notify({
              text: `Upgraded "${track?.title || "Untitled"}".${result?.mode === "copy" && result.target ? ` The new file is ${result.target}.` : ""}`,
              action: undoAction(result?.operationId),
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
