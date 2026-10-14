// Shared hooks for the Library UI: the API object, background job state,
// and "something changed, reload" notifications.

import { useCallback, useEffect, useRef, useState } from "react";
import { GENRE_OPTIONS } from "../constants/genres";
import { parseIpcError } from "../ipcErrors";

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

// Genre names for pickers: WaveMint's starter list, the library's genre
// taxonomy and the genres songs use. Loaded once and shared by every picker
// (a playlist can show a hundred), reloaded after the library changes.
const sortGenres = (names) => [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const STARTER_GENRES = sortGenres(GENRE_OPTIONS);
let genreNames = null;
window.waveMintAPI.onLibraryEvent?.(({ name, data }) => {
  if (name === "library-changed" || (name === "job" && data?.status !== "running")) genreNames = null;
});

function loadGenreNames() {
  genreNames ??= Promise.all([libraryApi.listGenreTaxonomy().catch(() => []), libraryApi.listGenres().catch(() => [])]).then(([taxonomy, used]) =>
    sortGenres([...GENRE_OPTIONS, ...taxonomy.map((genre) => genre.name), ...used.map((genre) => genre.name)]),
  );
  return genreNames;
}

/** Sorted genre names for pickers (the starter list until the library's arrive). */
export function useGenreNames() {
  const [names, setNames] = useState(STARTER_GENRES);
  useEffect(() => {
    let alive = true;
    loadGenreNames().then((loaded) => alive && setNames(loaded));
    return () => {
      alive = false;
    };
  }, []);
  return names;
}

export const QUICK_FILTERS = [
  { key: "favorite", label: "Favorites" },
  { key: "missingArtwork", label: "No artwork" },
  { key: "missingAlbum", label: "No album" },
  { key: "unclassified", label: "No genre" },
  { key: "lowBitrate", label: "Low bitrate" },
  { key: "missingFile", label: "Missing files" },
  { key: "multipleVersions", label: "Multiple versions" },
  { key: "possibleDuplicates", label: "Possible duplicates" },
  { key: "missingAlbumArtist", label: "No album artist" },
];

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
