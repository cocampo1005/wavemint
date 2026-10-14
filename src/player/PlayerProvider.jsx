import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mediaUrl } from "../library/format";
import { libraryApi, useLibraryEvent } from "../library/useLibrary";
import * as Q from "./queue";
import { PlayerContext, PlayerTimeContext } from "./usePlayer";

const PREFS_KEY = "wavemint.player.v1";
const DETAIL_CHUNK = 500;
const DETAIL_LIMIT = 3000;

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

/**
 * The single audio element and playback state for the whole app: the
 * current song, the play order (shuffle/repeat), the queue, and the UI state
 * shared by the player bar, the queue panel and Listen Mode.
 */
export function PlayerProvider({ children }) {
  const [prefs] = useState(loadPrefs);
  const audioRef = useRef(null);
  const [queue, setQueue] = useState(() => Q.emptyQueue(prefs));
  const [details, setDetails] = useState(() => new Map()); // track id -> list row
  const [isPlaying, setIsPlaying] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [volume, setVolumeState] = useState(typeof prefs.volume === "number" ? prefs.volume : 0.8);
  const [notice, setNotice] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [listenMode, setListenMode] = useState(false);
  // The latest state for event handlers and async work. detailsRef is the
  // source of truth for song details (updated the moment they arrive, so
  // async code can read them right away); the state copy only re-renders.
  const detailsRef = useRef(details);
  const queueRef = useRef(queue);
  const failures = useRef(0);
  // Web Audio graph for Listen Mode's visualizer: made the first time it's
  // needed (once made, the element plays through it), suspended while paused.
  const audioGraph = useRef(null);
  // Which song (queue token) and file the audio element has loaded.
  const loaded = useRef({ token: null, fileId: null });

  useEffect(
    () => () => {
      audioGraph.current?.context.close().catch(() => {});
      audioGraph.current = null;
    },
    [],
  );
  useLayoutEffect(() => {
    queueRef.current = queue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ shuffle: queue.shuffle, repeat: queue.repeat, volume }));
    } catch {
      // Preferences are a convenience.
    }
  }, [queue.shuffle, queue.repeat, volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const replaceDetails = useCallback((next) => {
    detailsRef.current = next;
    setDetails(next);
  }, []);

  const remember = useCallback(
    (rows) => {
      if (!rows?.length) return;
      let next = new Map(detailsRef.current);
      // Bounded: past a few thousand songs, keep only what's playing and next.
      if (next.size > DETAIL_LIMIT) {
        const keep = new Set(Q.upcoming(queueRef.current, 150).map((item) => item.id));
        if (queueRef.current.current) keep.add(queueRef.current.current.id);
        next = new Map([...next].filter(([id]) => keep.has(id)));
      }
      for (const row of rows) if (row?.id) next.set(row.id, row);
      replaceDetails(next);
    },
    [replaceDetails],
  );

  // Loads list rows (title, artist, artwork, file) for songs not known yet.
  const loadDetails = useCallback(
    async (ids) => {
      const missing = [...new Set(ids)].filter((id) => !detailsRef.current.has(id));
      for (let index = 0; index < missing.length; index += DETAIL_CHUNK) {
        const chunk = missing.slice(index, index + DETAIL_CHUNK);
        try {
          const result = await libraryApi.listTracks({ filters: { ids: chunk }, limit: 1000 });
          remember(result.rows);
        } catch {
          // Shown as "Unknown" until the next try.
        }
      }
    },
    [remember],
  );

  // A new current song: load it and play. Unplayable songs are skipped.
  const currentToken = queue.current?.token;
  useEffect(() => {
    const audio = audioRef.current;
    const current = queueRef.current.current;
    if (!audio) return undefined;
    if (!current) {
      loaded.current = { token: null, fileId: null };
      audio.pause();
      audio.removeAttribute("src");
      audio.load(); // "emptied" resets the time
      return undefined;
    }
    let cancelled = false;
    (async () => {
      if (!detailsRef.current.has(current.id)) await loadDetails([current.id]);
      if (cancelled) return;
      const row = detailsRef.current.get(current.id);
      const fileId = current.fileId || row?.file_id;
      if (!row || !fileId || row.file_status === "missing") {
        setNotice(row ? `"${row.title || "A song"}" can't be played (its file is missing), so it was skipped.` : "A song couldn't be loaded, so it was skipped.");
        failures.current += 1;
        if (failures.current < 8) setQueue((state) => Q.advance(state));
        return;
      }
      loaded.current = { token: current.token, fileId };
      audio.src = mediaUrl(fileId);
      audio.play().catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [currentToken, loadDetails]);

  // Songs removed from the library leave the queue; library changes refresh
  // what's shown (titles, artwork, files after an edit).
  useLibraryEvent(({ name, data }) => {
    if (name === "library-changed" && data?.removed?.length) {
      const removed = new Set(data.removed);
      setQueue((state) => {
        const next = Q.dropTracks(state, data.removed);
        return state.current && removed.has(state.current.id) ? Q.advance(next) : next;
      });
    }
    if ((name === "library-changed" && !data?.review) || (name === "job" && data.status !== "running")) {
      // Keep showing the current song while its details reload.
      const keep = queueRef.current.current?.id;
      const kept = keep ? detailsRef.current.get(keep) : null;
      replaceDetails(kept ? new Map([[keep, kept]]) : new Map());
      if (keep) {
        libraryApi
          .listTracks({ filters: { ids: [keep] }, limit: 1 })
          .then((result) => remember(result.rows))
          .catch(() => {});
      }
    }
  });

  const audio = () => audioRef.current;

  const actions = useMemo(() => {
    const startList = ({ label = "", ids, rows, startId = null, fileId = null }) => {
      remember(rows);
      if (!ids?.length) return;
      failures.current = 0;
      setQueue((state) => Q.startContext(state, { label, ids, startId, fileId }));
    };
    const isCurrent = (id, fileId = null) => {
      const current = queueRef.current.current;
      return current && current.id === id && (!fileId || (current.fileId || detailsRef.current.get(id)?.file_id) === fileId);
    };
    const togglePlay = () => {
      const element = audio();
      const state = queueRef.current;
      if (!state.current) {
        if (state.context.ids.length) startList({ label: state.context.label, ids: state.context.ids });
        return;
      }
      if (element.paused) element.play().catch(() => {});
      else element.pause();
    };
    const enqueue = (kind) => (ids, rows) => {
      remember(rows);
      if (!ids.length) return;
      setQueue((state) => (state.current ? (kind === "next" ? Q.playNext(state, ids) : Q.addToQueue(state, ids)) : Q.startContext(state, { label: "Queue", ids })));
      setNotice(kind === "next" ? `Playing next: ${ids.length === 1 ? `"${rows?.[0]?.title || "1 song"}"` : `${ids.length} songs`}` : `Added ${ids.length === 1 ? `"${rows?.[0]?.title || "1 song"}"` : `${ids.length} songs`} to the queue`);
    };
    return {
      /** Plays a list from `startId` (ids in list order; rows optional). */
      playList: startList,
      /** Plays the songs a library query lists, in its order, from `startId`. */
      playQuery: async ({ label, query, startId = null, rows }) => {
        remember(rows);
        if (startId && isCurrent(startId)) return togglePlay();
        const ids = await libraryApi.listTrackIds({ search: query.search, filters: query.filters, sort: query.sort, direction: query.direction });
        startList({ label, ids, startId });
      },
      /** One song (or toggles it when it's the current one). */
      playTrack: (row, label = "") => (isCurrent(row.id) ? togglePlay() : startList({ label: label || row.title || "", ids: [row.id], rows: [row], startId: row.id })),
      /** One specific file version of a song. */
      playFile: (track, file) =>
        isCurrent(track.id, file.id) ? togglePlay() : startList({ label: track.title || "", ids: [track.id], rows: [{ ...track, file_id: track.active_file_id }], startId: track.id, fileId: file.id }),
      togglePlay,
      pause: () => audio()?.pause(),
      next: () =>
        setQueue((state) => {
          const next = Q.advance(state);
          return next.current ? next : state;
        }),
      previous: () => {
        const element = audio();
        if (element && element.currentTime > 3) element.currentTime = 0;
        else if (queueRef.current.history.length) setQueue(Q.goBack);
        else if (element) element.currentTime = 0;
      },
      seek: (seconds) => {
        const element = audio();
        if (element && Number.isFinite(seconds)) element.currentTime = seconds;
      },
      setVolume: (value) => setVolumeState(Math.max(0, Math.min(1, value))),
      toggleShuffle: () => setQueue((state) => Q.setShuffle(state, !state.shuffle)),
      cycleRepeat: () => setQueue((state) => Q.setRepeat(state, Q.REPEAT_MODES[(Q.REPEAT_MODES.indexOf(state.repeat) + 1) % Q.REPEAT_MODES.length])),
      playNext: enqueue("next"),
      addToQueue: enqueue("end"),
      removeQueued: (key) => setQueue((state) => Q.removeQueued(state, key)),
      moveQueued: (from, to) => setQueue((state) => Q.moveQueued(state, from, to)),
      clearQueue: () => setQueue(Q.clearQueue),
      skipUpcoming: (orderIndex) => setQueue((state) => Q.skipUpcoming(state, orderIndex)),
      jumpTo: (item) => setQueue((state) => Q.jumpTo(state, item)),
      setQueueOpen,
      setListenMode,
      /** The analyser of what is playing (for visualizers); null if Web Audio isn't available. */
      getAnalyser: () => {
        const element = audio();
        if (!element || typeof window.AudioContext !== "function") return null;
        if (!audioGraph.current) {
          try {
            const context = new window.AudioContext();
            const source = context.createMediaElementSource(element);
            const analyser = context.createAnalyser();
            // ~23 Hz per bin at 48 kHz: enough to tell bass from low mids.
            // The visualizer does its own (per-band) smoothing on top.
            analyser.fftSize = 2048;
            analyser.smoothingTimeConstant = 0.6;
            source.connect(analyser);
            analyser.connect(context.destination);
            audioGraph.current = { context, analyser };
          } catch {
            return null;
          }
        }
        if (!element.paused) audioGraph.current.context.resume().catch(() => {});
        return audioGraph.current.analyser;
      },
      dismissNotice: () => setNotice(""),
    };
  }, [remember]);

  // The audio element's end of a song: Repeat One replays it; otherwise the
  // next song plays, and at the end of the list (Repeat Off) playback stops
  // on the last song.
  const handleEnded = () => {
    const element = audio();
    const state = queueRef.current;
    if (state.repeat === "one") {
      element.currentTime = 0;
      element.play().catch(() => {});
      return;
    }
    const next = Q.advance(state);
    if (next.current) setQueue(next);
    else element.currentTime = 0;
  };

  // Windows media keys and the system media overlay.
  const currentRow = queue.current ? details.get(queue.current.id) || null : null;

  // The playing song's file was replaced (Upgrade Track, Edit Audio): carry on
  // with the new file from the same position. A specific version chosen to
  // play (fileId in the queue) is left alone.
  const activeFileId = queue.current && !queue.current.fileId ? currentRow?.file_id || null : null;
  useEffect(() => {
    const element = audioRef.current;
    const token = queueRef.current.current?.token;
    if (!element || !activeFileId || loaded.current.token !== token || !loaded.current.fileId || loaded.current.fileId === activeFileId) return;
    const position = element.currentTime;
    const resume = !element.paused;
    loaded.current = { token, fileId: activeFileId };
    element.addEventListener(
      "loadedmetadata",
      () => {
        element.currentTime = Math.min(position, element.duration || position);
        if (resume) element.play().catch(() => {});
      },
      { once: true },
    );
    element.src = mediaUrl(activeFileId);
  }, [activeFileId]);
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!session) return;
    session.metadata = currentRow
      ? new window.MediaMetadata({ title: currentRow.title || "Untitled", artist: currentRow.artist || "", album: currentRow.album || "" })
      : null;
    const handlers = { play: actions.togglePlay, pause: actions.pause, nexttrack: actions.next, previoustrack: actions.previous };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not supported.
      }
    }
  }, [currentRow, actions]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const upcomingItems = useMemo(() => Q.upcoming(queue, 150), [queue]);
  const upcomingKey = upcomingItems.map((item) => item.id).join(",");
  useEffect(() => {
    if (queueOpen || listenMode) loadDetails(upcomingKey ? upcomingKey.split(",").map(Number) : []);
  }, [upcomingKey, queueOpen, listenMode, loadDetails]);

  const { current: nowPlaying, context, shuffle, repeat, upNext, history } = queue;
  const value = useMemo(
    () => ({
      ...actions,
      current: nowPlaying,
      currentTrack: currentRow,
      isPlaying,
      // For list views: which song (and file) is playing.
      playing: nowPlaying ? { trackId: nowPlaying.id, fileId: nowPlaying.fileId || currentRow?.file_id || null, isPlaying } : null,
      contextLabel: context.label,
      shuffle,
      repeat,
      upNext,
      upcoming: upcomingItems,
      details,
      volume,
      notice,
      queueOpen,
      listenMode,
      hasPrevious: history.length > 0,
    }),
    [actions, nowPlaying, context, shuffle, repeat, upNext, history, currentRow, isPlaying, upcomingItems, details, volume, notice, queueOpen, listenMode],
  );

  return (
    <PlayerContext.Provider value={value}>
      <PlayerTimeContext.Provider value={time}>
        {children}
        <audio
          ref={audioRef}
          preload="auto"
          // Lets the visualizer read the audio (wavemint-media sends CORS headers).
          crossOrigin="anonymous"
          onPlay={() => {
            audioGraph.current?.context.resume().catch(() => {});
            setIsPlaying(true);
          }}
          onPlaying={() => {
            failures.current = 0;
          }}
          onPause={() => {
            setIsPlaying(false);
            audioGraph.current?.context.suspend().catch(() => {});
          }}
          onEnded={handleEnded}
          onTimeUpdate={(event) => setTime({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration || 0 })}
          onLoadedMetadata={(event) => setTime({ current: 0, duration: event.currentTarget.duration || 0 })}
          onEmptied={() => setTime({ current: 0, duration: 0 })}
          onError={() => {
            if (!queueRef.current.current) return;
            setNotice("This song can't be played, so it was skipped.");
            failures.current += 1;
            if (failures.current < 8) setQueue((state) => Q.advance(state));
          }}
        />
      </PlayerTimeContext.Provider>
    </PlayerContext.Provider>
  );
}
