// Shared hooks for the Library UI: the API object, background job state,
// and "something changed, reload" notifications.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { GENRE_OPTIONS } from "../constants/genres";
import { parseIpcError } from "../ipcErrors";
import { nameKey, uniqueNames } from "./suggest";

export const libraryApi = window.waveMintAPI.library;

export function errorMessage(error, fallback = "Something went wrong") {
  return parseIpcError(error, fallback).message;
}

/** Subscribes to library events ({ name, data }) for the component's lifetime. */
export function useLibraryEvent(handler) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  }, [handler]);

  useEffect(() => window.waveMintAPI.onLibraryEvent((event) => ref.current?.(event)), []);
}

/**
 * Tracks background jobs. `revision` increases whenever a job finishes, so
 * views can reload their data.
 */
export function useLibraryJobs() {
  const [jobs, setJobs] = useState([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    libraryApi
      .listJobs()
      .then((list) => !cancelled && setJobs(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useLibraryEvent(({ name, data }) => {
    // Songs added from Add Music (outside a job).
    if (name === "library-changed") {
      setRevision((value) => value + 1);
      return;
    }
    if (name !== "job") return;
    setJobs((current) => [...current.filter((job) => job.id !== data.id), data].slice(-20));
    if (data.status !== "running") setRevision((value) => value + 1);
  });

  const running = jobs.filter((job) => job.status === "running");
  const bump = useCallback(() => setRevision((value) => value + 1), []);
  return { jobs, running, revision, bump };
}

/** Loads data with `load()` whenever `deps` change; exposes reload(). */
export function useLoader(load, deps) {
  const [state, setState] = useState({ data: null, error: "", loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    Promise.resolve()
      .then(() => loadRef.current())
      .then((data) => !cancelled && setState({ data, error: "", loading: false }))
      .catch((error) => !cancelled && setState({ data: null, error: errorMessage(error), loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, reload };
}

// Browse data (the artist, album and genre lists, an artist's or album's
// header…) is loaded once per library revision and shared by every view that
// shows it. Switching tabs or going back from a detail view shows the stored
// result at once without asking the library again; after a change (a new
// revision) the old result stays on screen while the new one loads.
const BROWSE_CACHE_MAX = 80;
const browseCache = new Map(); // key -> { revision, data, promise }

function rememberBrowse(key, entry) {
  browseCache.delete(key);
  browseCache.set(key, entry);
  while (browseCache.size > BROWSE_CACHE_MAX) browseCache.delete(browseCache.keys().next().value);
}

/**
 * Like useLoader, but cached per `key` and library `revision` (see above).
 * An empty key loads nothing (a section that isn't shown).
 */
export function useCachedLoader(key, load, revision, { keepPreviousData = false } = {}) {
  const [state, setState] = useState(() => ({ data: browseCache.get(key)?.data ?? null, error: "", key }));

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const cached = browseCache.get(key);
    if (cached?.revision === revision && cached.data !== undefined && !cached.promise) {
      setState({ data: cached.data, error: "", key });
      return undefined;
    }
    // The last result (possibly from an older revision) stays visible meanwhile.
    setState((previous) => ({ data: cached?.data ?? (keepPreviousData ? previous.data : null), error: "", key }));
    let promise = cached?.revision === revision ? cached.promise : null;
    if (!promise) {
      promise = Promise.resolve().then(load);
      rememberBrowse(key, { revision, data: cached?.data, promise });
    }
    promise
      .then((data) => {
        if (browseCache.get(key)?.promise === promise) rememberBrowse(key, { revision, data, promise: null });
        if (alive) setState({ data, error: "", key });
      })
      .catch((error) => {
        if (browseCache.get(key)?.promise === promise) browseCache.delete(key);
        if (alive) setState((previous) => ({ data: cached?.data ?? (keepPreviousData ? previous.data : null), error: errorMessage(error), key }));
      });
    return () => {
      alive = false;
    };
    // `load` belongs to `key`: a new key is a new request, a new `load` alone isn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision, keepPreviousData]);

  // Paginated grids may retain the previous page while the larger result
  // loads, so their height and scroll position remain stable.
  return state.key === key ? state : { data: browseCache.get(key)?.data ?? (keepPreviousData ? state.data : null), error: "", key };
}

// Names for the metadata pickers (Artist, Album, Genre), from the library.
// Each list is loaded once and shared by every picker (a playlist can show a
// hundred), and every mounted picker reloads after the library changes.
const suggestionCache = new Map(); // key → Promise
const suggestionListeners = new Set();
let suggestionVersion = 0;

/** Drops the loaded picker lists; mounted pickers load them again. */
export function refreshSuggestions() {
  suggestionCache.clear();
  suggestionVersion += 1;
  for (const listener of suggestionListeners) listener();
}

window.waveMintAPI.onLibraryEvent?.(({ name, data }) => {
  if (name === "library-changed" || (name === "job" && data?.status !== "running")) refreshSuggestions();
});

function cachedSuggestions(key, load) {
  if (!suggestionCache.has(key)) {
    suggestionCache.set(
      key,
      load().catch(() => {
        suggestionCache.delete(key); // tried again by the next picker
        return null;
      }),
    );
  }
  return suggestionCache.get(key);
}

const subscribeSuggestions = (listener) => {
  suggestionListeners.add(listener);
  return () => suggestionListeners.delete(listener);
};

/** The list `load` gives for `key` (null: none), `fallback` until it arrives. */
function useSuggestions(key, load, fallback) {
  const version = useSyncExternalStore(subscribeSuggestions, () => suggestionVersion);
  const [state, setState] = useState({ key: null, value: fallback });
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    cachedSuggestions(key, load).then((value) => alive && value && setState({ key, value }));
    return () => {
      alive = false;
    };
    // `load` belongs to `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return state.key === key ? state.value : fallback;
}

const sortNames = (names) => uniqueNames(names).sort((a, b) => a.localeCompare(b));
const STARTER_GENRES = sortNames(GENRE_OPTIONS);
const NO_NAMES = [];

/**
 * Genre names for pickers: the library's genre taxonomy (which includes
 * new genres once a song with one was saved), WaveMint's starter list and the genres songs
 * use, without case/spacing duplicates (the first spelling wins, in that
 * order). The starter list until the library's arrive.
 */
export function useGenreNames() {
  return useSuggestions(
    "genres",
    () =>
      Promise.all([libraryApi.listGenreTaxonomy(), libraryApi.listGenres()]).then(([taxonomy, used]) =>
        sortNames([...taxonomy.map((genre) => genre.name), ...GENRE_OPTIONS, ...used.map((genre) => genre.name)]),
      ),
    STARTER_GENRES,
  );
}

// The library's artists, prepared once per load and shared by every picker
// (a playlist in Add Music shows one per song): the names, and each name's
// artist (by comparison key) for its albums.
const loadArtists = () =>
  libraryApi.listArtists({ limit: 5000 }).then((result) => {
    const byName = new Map();
    for (const row of result.rows) if (!byName.has(nameKey(row.name))) byName.set(nameKey(row.name), { key: row.key, name: row.name.trim() });
    return { names: [...byName.values()].map((artist) => artist.name), byName };
  });
const NO_ARTISTS = { names: NO_NAMES, byName: new Map() };

/** The library's artist names, for the Artist pickers. */
export function useArtistNames() {
  return useSuggestions("artists", loadArtists, NO_ARTISTS).names;
}

/**
 * The albums the library has for `artist` (matched ignoring case and
 * spacing), for the Album pickers: `{ name, albums }`, with the library's
 * spelling of the artist. No albums while `artist` isn't in the library.
 */
export function useArtistAlbums(artist) {
  const found = useSuggestions("artists", loadArtists, NO_ARTISTS).byName.get(nameKey(artist)) ?? null;
  const albums = useSuggestions(
    found ? `albums:${found.key}` : null,
    () => libraryApi.listAlbums({ filters: { artist: found.key }, sort: "title", limit: 1000 }).then((result) => uniqueNames(result.rows.map((row) => row.title))),
    NO_NAMES,
  );
  return { name: found?.name ?? "", albums: found ? albums : NO_NAMES };
}

export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Stable key of a playlist entry from the Extract view. */
export const entryKey = (entry) => String(entry.id || entry.webpage_url);

/**
 * Starts a background job and resolves with its final snapshot. Finished
 * jobs are remembered, so a job that completes before its start call
 * returns is never missed.
 */
export function useJobRunner() {
  const finished = useRef(new Map());
  const waiting = useRef(new Map());

  useLibraryEvent(({ name, data }) => {
    if (name !== "job" || data.status === "running") return;
    finished.current.set(data.id, data);
    const resolve = waiting.current.get(data.id);
    if (resolve) {
      waiting.current.delete(data.id);
      resolve(data);
    }
  });

  return useCallback(async (start) => {
    const job = await start;
    const done = finished.current.get(job.id);
    if (done) return done;
    return new Promise((resolve) => waiting.current.set(job.id, resolve));
  }, []);
}
