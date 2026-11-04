// An in-memory stand-in for classic iTunes, implementing the adapter
// interface of electron/library/itunes.cjs. It behaves like the real thing
// where that matters for the sync engine: it reads a song's tags from its
// file, adds a duplicate when the same file is added twice, can refuse to
// change a song's file location, can copy files into its own media folder, and
// can be closed or unreachable. It records every call so tests can check
// what a sync did.

const fs = require("fs");
const path = require("path");
const { AppleSyncError } = require("../electron/library/itunes.cjs");
const { readTags } = require("../electron/library/tags.cjs");

function createFakeItunes({ locationSettable = true, mediaFolder = null, moveOnAdd = false, deleteRemovesFile = false, libraryDir = path.join(path.sep, "iTunes"), libraryId = "00000000000000A1" } = {}) {
  const state = {
    tracks: new Map(),
    playlists: new Map(),
    running: true,
    available: true,
    counter: 0x1000,
    calls: [],
    failAdds: false,
    libraryId,
    locationSettable,
    mediaFolder,
    libraryDir,
    // "Keep iTunes Media folder organized" (moves added files) and an iTunes that deletes files with their entries.
    moveOnAdd,
    deleteRemovesFile,
  };
  const nextPid = () => (state.counter++).toString(16).toUpperCase().padStart(16, "0");

  const readDetails = (file) => {
    const tags = readTags(file);
    return { name: tags.title || path.basename(file), artist: tags.artist || "", album: tags.album || "", genre: tags.genre || "", year: tags.year || 0, duration: Math.round((tags.durationMs || 0) / 1000), artworkCount: tags.artworkCount || 0 };
  };
  // Like iTunes: an entry whose file can't be found reports an empty location.
  const info = (track) => {
    const exists = !!track.location && fs.existsSync(track.location);
    return { ...track, kind: 1, exists, location: exists ? track.location : "" };
  };
  const record = (name, detail) => state.calls.push({ name, ...detail });

  function guard() {
    if (!state.available) throw new AppleSyncError("unavailable", "iTunes can't be reached");
    if (!state.running) throw new AppleSyncError("not-running", "iTunes isn't running");
  }

  const adapter = {
    // Never "itunes-com": a stand-in must not be mistaken for the real iTunes.
    kind: "fake",
    state,
    mutations: () => state.calls.filter((call) => ["add", "update", "setLocation", "delete", "carry", "playlistCreate", "playlistSet", "playlistRename", "playlistDelete"].includes(call.name)),
    clearCalls: () => (state.calls.length = 0),

    /** Puts a song in the library the way a user would (already there before WaveMint). */
    seed(file, extra = {}) {
      const pid = nextPid();
      state.tracks.set(pid, { pid, location: file, rating: 0, playedCount: 0, skippedCount: 0, size: 1, ...readDetails(file), ...extra });
      return pid;
    },
    userEdit(pid, patch) {
      Object.assign(state.tracks.get(pid), patch);
    },
    userDelete(pid) {
      state.tracks.delete(pid);
    },

    async detect() {
      return { kind: "itunes", itunesInstalled: true, itunesRunning: state.running, appleMusicInstalled: false };
    },
    async isRunning() {
      return state.available && state.running;
    },
    async connect({ launch = false } = {}) {
      if (!state.available) throw new AppleSyncError("unavailable", "iTunes can't be reached");
      if (!state.running && !launch) return { connected: false, running: false };
      state.running = true;
      return { connected: true, running: true, version: "12.13.11.1", libraryId: state.libraryId, libraryPath: path.join(state.libraryDir, "iTunes Music Library.xml"), trackCount: state.tracks.size };
    },
    async probe() {
      return { locationSettable: state.locationSettable, definition: null };
    },
    async listTracks() {
      guard();
      record("list");
      return [...state.tracks.values()].map(info);
    },
    async getTracks(pids) {
      guard();
      return new Map(pids.map((pid) => [pid, state.tracks.has(pid) ? info(state.tracks.get(pid)) : null]));
    },
    async addFiles(files) {
      guard();
      return files.map((file) => {
        record("add", { file });
        if (state.failAdds) return { ok: false, error: "iTunes didn't add the file" };
        let location = file;
        if (state.mediaFolder) {
          location = path.join(state.mediaFolder, path.basename(file));
          if (state.moveOnAdd) fs.renameSync(file, location);
          else fs.copyFileSync(file, location);
        }
        const pid = nextPid();
        // Like iTunes, adding the same file again makes another entry.
        state.tracks.set(pid, { pid, location, rating: 0, playedCount: 0, skippedCount: 0, size: 1, ...readDetails(location) });
        return { ok: true, info: info(state.tracks.get(pid)) };
      });
    },
    async updateFromFile(pids) {
      guard();
      return pids.map((pid) => {
        record("update", { pid });
        const track = state.tracks.get(pid);
        if (!track) return { ok: false, error: "The song is not in iTunes" };
        Object.assign(track, readDetails(track.location));
        return { ok: true, info: info(track) };
      });
    },
    async setLocation(pid, file) {
      guard();
      record("setLocation", { pid, file });
      const track = state.tracks.get(pid);
      if (!track) return { ok: false, error: "The song is not in iTunes" };
      if (!state.locationSettable) return { ok: true, unsupported: true };
      track.location = file;
      Object.assign(track, readDetails(file));
      return { ok: true, info: info(track) };
    },
    async deleteTracks(pids) {
      guard();
      return pids.map((pid) => {
        record("delete", { pid });
        if (state.deleteRemovesFile && state.tracks.get(pid)) fs.rmSync(state.tracks.get(pid).location, { force: true });
        state.tracks.delete(pid);
        for (const playlist of state.playlists.values()) playlist.tracks = playlist.tracks.filter((entry) => entry !== pid);
        return { ok: true };
      });
    },
    async carryOver({ from, to, playlists = [] }) {
      guard();
      record("carry", { from, to });
      const source = state.tracks.get(from);
      const target = state.tracks.get(to);
      Object.assign(target, { rating: source.rating, playedCount: source.playedCount, skippedCount: source.skippedCount });
      for (const pid of playlists) state.playlists.get(pid)?.tracks.push(to);
      return { ok: true, notes: [] };
    },
    async listPlaylists({ withTracks = false } = {}) {
      guard();
      return [...state.playlists.values()].map((playlist) => ({ pid: playlist.pid, name: playlist.name, smart: false, special: 0, count: playlist.tracks.length, ...(withTracks ? { tracks: [...playlist.tracks] } : {}) }));
    },
    async createPlaylist(name) {
      guard();
      record("playlistCreate", { name });
      const pid = nextPid();
      state.playlists.set(pid, { pid, name, tracks: [] });
      return { pid, name };
    },
    async renamePlaylist(pid, name) {
      guard();
      record("playlistRename", { pid, name });
      state.playlists.get(pid).name = name;
      return { name };
    },
    async deletePlaylist(pid) {
      guard();
      record("playlistDelete", { pid });
      state.playlists.delete(pid);
      return { gone: true };
    },
    async setPlaylistTracks(pid, trackPids) {
      guard();
      const playlist = state.playlists.get(pid);
      if (!playlist) throw new Error("The playlist is not in iTunes");
      if (playlist.tracks.join() !== trackPids.join()) {
        record("playlistSet", { pid });
        playlist.tracks = [...trackPids];
      }
      return { tracks: playlist.tracks };
    },
  };
  return adapter;
}

module.exports = { createFakeItunes };
