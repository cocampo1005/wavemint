// Apple library synchronization: WaveMint owns the music, iTunes follows.
//
// Direct reference: iTunes plays the WaveMint Library's own files. There is
// one physical copy of each song (its current file, wherever WaveMint keeps
// it); WaveMint writes the curated tags into it when a change is saved
// (service.cjs write-through), and iTunes re-reads the file. Nothing is
// copied for iTunes.
//
// Only a file iTunes can't play (FLAC, and WAV/AIFF when that setting is on;
// see formats.appleCompatibility) gets a converted Apple Lossless copy, kept
// in the compatibility cache (exporter.cjs with the cache as its root,
// `export_state`). Lossy audio is never converted. With no such files the
// cache isn't even created.
//
// The iTunes side (`apple_sync_tracks` / `apple_sync_playlists`) records, for
// every song, the iTunes entry that plays it (iTunes' persistent ID, tied to
// WaveMint's own song ID), the file it should play (`target_path`) and how
// (`mode`: direct | converted). Titles and paths are never the identity.
//
// A sync computes the desired state (each song's file), compares it
// with what was saved for iTunes and with what iTunes really holds right now
// (drift: entries deleted, moved or edited in iTunes), and does only the
// difference. Running it again changes nothing. Every step saves its result
// right away, so an interrupted run resumes where it stopped, and an entry
// that was added but not saved is recognised by its location next time
// instead of being added twice.
//
// Safety rules:
//   - Only entries WaveMint created, or was told to adopt in the guided
//     migration, are ever changed or removed. Nothing else in iTunes is
//     touched.
//   - Sync never deletes, moves or writes a library file. Removing an iTunes
//     entry is guarded: the file it plays gets a temporary second name (a
//     hard link, no extra space) first, so if iTunes took the file with it,
//     it is put back and removals stop. Only converted copies in the
//     compatibility cache are ever set aside (in `.replaced/`).
//   - If iTunes moves a file it was given (its "Keep iTunes Media folder
//     organized" setting), the sync stops at once.
//   - Removals, re-creations that change an entry's identity, overwriting
//     details edited in iTunes, and unusually large batches need confirmation.
//     Automatic runs never do any of these.
//   - A song's old file is kept until iTunes references the new one.
//
// The iTunes side is an adapter (itunes.cjs); tests use an in-memory one.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getSetting, nowIso, parseJson, setSetting } = require("./db.cjs");
const { appleCompatibility } = require("./formats.cjs");
const { pathKey } = require("./normalize.cjs");
const { playlistTracks } = require("./playlists.cjs");
const { AppleSyncError } = require("./itunes.cjs");

const FIRST_CHUNK = 5;
const isInside = (root, file) => !!root && !!file && pathKey(file).startsWith(`${pathKey(root)}\\`);

const META_KEY = "apple_sync";
const BULK_MIN = 5;
const BULK_FRACTION = 0.05;
const CHUNK = 100;
const MAX_ATTEMPTS = 3;
const DEBOUNCE_MS = 30 * 1000;
const POLL_MS = 90 * 1000;
const PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const norm = (value) => String(value ?? "").trim();
const sameText = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

/** A fingerprint of the details iTunes shows, to notice edits made in iTunes. */
function itunesSig(info) {
  return sha1(JSON.stringify([norm(info.name), norm(info.artist), norm(info.album), norm(info.genre), Number(info.year) || 0]));
}

function createAppleSync({ db, exporter, getAdapter, getSettings, getLibraryRoot = () => null, defaultCacheRoot, isQuiet = () => true, assertWritable = null, logger = console, emit = () => {} }) {
  let running = false;
  let timer = null;
  let poller = null;

  // --- saved state ---------------------------------------------------------------
  const meta = () => getSetting(db, META_KEY, {});
  const patchMeta = (patch) => setSetting(db, META_KEY, { ...meta(), ...patch });

  const rowsFor = (libraryId) =>
    new Map(db.prepare("SELECT * FROM apple_sync_tracks WHERE library_id = ?").all(libraryId).map((row) => [row.track_id, row]));

  const COLUMNS = ["pid", "location", "rel_path", "target_path", "mode", "source_file_id", "format", "audio_hash", "file_sig", "meta_sig", "itunes_sig", "origin", "status", "attempts", "last_error", "last_synced_at", "legacy_pids"];
  function saveRow(libraryId, trackId, patch) {
    const current = db.prepare("SELECT * FROM apple_sync_tracks WHERE library_id = ? AND track_id = ?").get(libraryId, trackId);
    const next = { origin: "created", status: "pending", attempts: 0, ...(current || {}), ...patch };
    db.prepare(
      `INSERT INTO apple_sync_tracks (library_id, track_id, ${COLUMNS.join(", ")}, updated_at)
       VALUES (?, ?, ${COLUMNS.map(() => "?").join(", ")}, ?)
       ON CONFLICT(library_id, track_id) DO UPDATE SET ${COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}, updated_at = excluded.updated_at`,
    ).run(libraryId, trackId, ...COLUMNS.map((column) => next[column] ?? null), nowIso());
  }

  const markSynced = (libraryId, trackId, target, info, extra = {}) =>
    saveRow(libraryId, trackId, {
      pid: info.pid,
      location: info.location,
      rel_path: target.relPath || null,
      target_path: target.path,
      mode: target.mode,
      source_file_id: target.fileId ?? null,
      format: target.format,
      audio_hash: target.audioHash || null,
      file_sig: target.fileSig,
      meta_sig: target.metaSig,
      itunes_sig: itunesSig(info),
      status: "synced",
      attempts: 0,
      last_error: null,
      last_synced_at: nowIso(),
      ...extra,
    });

  const markFailed = (libraryId, trackId, error) => {
    const row = db.prepare("SELECT attempts FROM apple_sync_tracks WHERE library_id = ? AND track_id = ?").get(libraryId, trackId);
    saveRow(libraryId, trackId, { status: "failed", attempts: (row?.attempts || 0) + 1, last_error: String(error).slice(0, 300) });
  };

  /** Where converted copies of files iTunes can't play are kept (created only when needed). */
  const cacheRoot = () => path.resolve(getSettings().appleCompatRoot || defaultCacheRoot);

  /**
   * The file iTunes should play for every song in the library: its own file
   * (direct), or a converted copy in the compatibility cache. `checkFiles`
   * also confirms each file is really there (a sync does; the screen doesn't).
   */
  function desiredTargets({ checkFiles = false } = {}) {
    const settings = getSettings();
    const convertWavAiff = settings.convertWavAiff !== false;
    const rows = db
      .prepare(
        `SELECT t.*, COALESCE(t.artwork_hash, f.artwork_hash) AS effective_art, f.id AS file_id, f.path, f.ext, f.size, f.mtime_ms,
                f.codec, f.audio_hash, f.status AS file_status
         FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id
         WHERE t.state = 'active'`,
      )
      .all();
    const entries = [];
    const converted = [];
    for (const track of rows) {
      const entry = {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        details: { title: track.title, artist: track.artist, album: track.album, genre: track.genre, year: track.year },
        problems: [],
        warnings: [],
      };
      entries.push(entry);
      if (!track.file_id || track.file_status !== "ok" || (checkFiles && !fs.existsSync(track.path))) {
        entry.problems.push(track.file_status === "unreadable" ? "The file can't be read" : "The file is missing");
        continue;
      }
      const compat = appleCompatibility(track, { convertWavAiff });
      if (compat.mode === "unsupported") {
        entry.problems.push(compat.reason);
        continue;
      }
      if (compat.mode === "convert") {
        converted.push(entry);
        continue;
      }
      // iTunes reads the details from the file: wait until WaveMint has written them.
      if (track.tags_dirty) entry.waiting = "The latest changes aren't saved into the file yet";
      entry.target = {
        mode: "direct",
        path: track.path,
        fileId: track.file_id,
        format: compat.format,
        fileSig: `${track.file_id}:${track.size}:${Math.round(track.mtime_ms || 0)}`,
        metaSig: exporter.metaSig(track),
        audioHash: track.audio_hash || null,
      };
    }

    if (converted.length) {
      const root = cacheRoot();
      const exists = fs.existsSync(root);
      const plan = exists ? exporter.plan({ root, scope: { trackIds: converted.map((entry) => entry.trackId) }, options: { convertWavAiff } }) : null;
      const planned = new Map((plan?.items || []).map((item) => [item.trackId, item]));
      const hashes = exists ? new Map(db.prepare("SELECT track_id, audio_hash FROM export_state WHERE root_key = ?").all(pathKey(root)).map((row) => [row.track_id, row.audio_hash])) : new Map();
      for (const entry of converted) {
        const item = planned.get(entry.trackId);
        if (item?.status === "problem") {
          entry.problems.push(item.problems[0]);
          continue;
        }
        entry.convert = true;
        entry.exportStatus = item?.status || "new";
        entry.target = {
          mode: "converted",
          path: item?.relPath ? path.join(root, item.relPath) : null,
          relPath: item?.relPath || null,
          fileId: item?.track?.file_id ?? null,
          format: "alac",
          fileSig: item?.fileSig || null,
          metaSig: item?.metaSig || null,
          audioHash: hashes.get(entry.trackId) || null,
        };
      }
    }
    return entries;
  }

  // --- connecting ----------------------------------------------------------------
  async function connect({ launch, signal }) {
    const adapter = getAdapter();
    const conn = await adapter.connect({ launch, signal });
    if (!conn.connected) return conn;
    const saved = meta();
    patchMeta({ libraryId: conn.libraryId, version: conn.version, libraryPath: conn.libraryPath, lastSeenAt: nowIso() });
    // What this iTunes can do is checked once, not assumed.
    const capabilities = saved.capabilities;
    if (!capabilities || capabilities.libraryId !== conn.libraryId || capabilities.locationSettable === null || Date.now() - Date.parse(capabilities.probedAt || 0) > PROBE_MAX_AGE_MS) {
      try {
        const probe = await adapter.probe({ signal });
        patchMeta({ capabilities: { libraryId: conn.libraryId, locationSettable: probe.locationSettable, probedAt: nowIso() } });
      } catch (error) {
        logger.warn(`[apple] Capability check failed: ${error.message}`);
      }
    }
    return { ...conn, previousLibraryId: saved.libraryId || null };
  }

  const locationSettable = () => meta().capabilities?.locationSettable;

  // --- planning -------------------------------------------------------------------
  /**
   * What a sync would do. With `snapshot` (iTunes' songs right now) it also
   * finds drift; without it (offline) it works from the saved state only.
   */
  function buildPlan({ libraryId, snapshot = null, regenerated = null, checkFiles = false }) {
    const settings = getSettings();
    const targets = desiredTargets({ checkFiles });
    const rows = libraryId ? rowsFor(libraryId) : new Map();
    const byPid = snapshot ? new Map(snapshot.map((track) => [track.pid, track])) : null;
    // Entries whose file iTunes can't find have no location: never matched by location.
    const byLocation = snapshot ? new Map(snapshot.filter((track) => track.location).map((track) => [pathKey(track.location), track])) : null;
    const settable = locationSettable();
    const items = [];
    const seen = new Set();

    for (const entry of targets) {
      seen.add(entry.trackId);
      const row = rows.get(entry.trackId);
      const target = entry.target || null;
      const item = { trackId: entry.trackId, title: entry.title, artist: entry.artist, album: entry.album, target, exportStatus: entry.exportStatus || null, needs: [], warnings: entry.warnings };
      items.push(item);

      if (entry.problems.length) {
        Object.assign(item, { kind: "blocked", reason: entry.problems[0] });
        continue;
      }
      if (entry.waiting) {
        Object.assign(item, { kind: "waiting", reason: entry.waiting });
        continue;
      }
      const exhausted = !!row && row.status === "failed" && row.attempts >= MAX_ATTEMPTS;
      const itrack = row?.pid ? byPid?.get(row.pid) || null : null;
      if (!row || !row.pid || row.status === "removed" || (snapshot && !itrack)) {
        // An entry already playing the song's file (a run that stopped before saving) is adopted, not added twice.
        const existing = target?.path ? byLocation?.get(pathKey(target.path)) : null;
        if (existing) Object.assign(item, { kind: "adopt", pid: existing.pid, info: existing });
        else if (row?.pid && row.status !== "removed") Object.assign(item, { kind: "readd", reason: "It was removed from iTunes" });
        else item.kind = "add";
        if (exhausted) item.needs.push("retry");
        continue;
      }
      item.pid = row.pid;
      item.info = itrack;
      // A row from before direct reference (no target_path) points at an old export copy.
      const expected = row.target_path || target.path;
      const pathChanged = !row.target_path || pathKey(row.target_path) !== pathKey(target.path) || row.format !== target.format;
      const drifted = pathKey(itrack ? itrack.location : row.location) !== pathKey(expected);
      const audioChanged = pathChanged || entry.exportStatus === "replace" || (row.audio_hash && target.audioHash && row.audio_hash !== target.audioHash);
      const detailsChanged = row.meta_sig !== target.metaSig || row.file_sig !== target.fileSig;
      // iTunes re-reads a file by itself when it changes, so its details can
      // differ from the last sync simply because they now match WaveMint's.
      // Only details that differ from WaveMint's count as edited in iTunes.
      const details = entry.details || {};
      const matchesWaveMint =
        !!itrack &&
        sameText(itrack.name, details.title) &&
        sameText(itrack.artist, details.artist) &&
        sameText(itrack.album, details.album) &&
        sameText(itrack.genre, details.genre) &&
        (Number(itrack.year) || 0) === (Number(details.year) || 0);
      const editedInItunes = !!itrack && !!row.itunes_sig && itunesSig(itrack) !== row.itunes_sig && !matchesWaveMint;

      if (pathChanged || drifted) {
        Object.assign(item, { kind: pathChanged ? "relocate" : "relink", reason: pathChanged ? "The song's file was moved, renamed or replaced" : "iTunes points at a different file" });
        item.identityRisk = settable === false;
        if (item.identityRisk) item.needs.push("recreate");
      } else if (audioChanged || detailsChanged) {
        item.kind = audioChanged ? "replacement" : "metadata";
        if (editedInItunes) item.needs.push("conflict");
      } else if (editedInItunes) {
        Object.assign(item, { kind: "drift", reason: "Edited in iTunes since the last sync" });
        item.needs.push("conflict");
      } else if (regenerated?.has(entry.trackId)) {
        // The file was written again this run (it had gone missing): iTunes re-reads it.
        item.kind = "metadata";
      } else {
        item.kind = "unchanged";
      }
      if (row.attempts >= MAX_ATTEMPTS && item.kind !== "unchanged") item.needs.push("retry");
    }

    // Entries WaveMint manages for songs that are no longer in the collection.
    for (const row of rows.values()) {
      if (seen.has(row.track_id) || row.status === "removed" || !row.pid) continue;
      const track = db.prepare("SELECT title, artist FROM tracks WHERE id = ?").get(row.track_id) || {};
      items.push({
        trackId: row.track_id,
        title: track.title || "(removed song)",
        artist: track.artist || "",
        kind: "remove",
        pid: row.pid,
        location: byPid?.get(row.pid)?.location || row.location,
        target: { path: row.target_path, mode: row.mode, relPath: row.rel_path },
        needs: [],
        warnings: [],
      });
    }

    // Safeguards: removals follow the user's policy, and an unusually large
    // batch of removals / re-additions needs an explicit go-ahead.
    const managed = [...rows.values()].filter((row) => row.pid && row.status !== "removed").length;
    const threshold = Math.max(BULK_MIN, Math.ceil(managed * BULK_FRACTION));
    const risky = items.filter((item) => ["remove", "readd"].includes(item.kind) || item.needs.includes("recreate"));
    const bulk = risky.length > threshold;
    const policy = settings.appleRemovalPolicy || "confirm";
    for (const item of items) {
      if (item.kind === "remove") {
        item.unmanageOnly = policy === "keep";
        if (policy === "confirm") item.needs.push("removal");
      }
      if (bulk && risky.includes(item)) item.needs.push("bulk");
    }

    return { items, rows, managed, bulk, threshold, playlists: planPlaylists({ libraryId, items }) };
  }

  /** A playlist's saved fingerprint covers its name and its songs' iTunes IDs. */
  function desiredPlaylists(libraryId, items) {
    const rows = libraryId ? rowsFor(libraryId) : new Map();
    const itemById = new Map(items.map((item) => [item.trackId, item]));
    const pidOf = (trackId) => {
      const row = rows.get(trackId);
      const pending = itemById.get(trackId);
      if (row?.pid && row.status !== "removed" && pending?.kind !== "relocate" && pending?.kind !== "relink") return row.pid;
      return `track:${trackId}`;
    };
    const out = [];
    for (const playlist of db.prepare("SELECT id, name FROM playlists ORDER BY id").all()) {
      let tracks = [];
      try {
        tracks = playlistTracks(db, playlist.id);
      } catch (error) {
        logger.warn(`[apple] Playlist "${playlist.name}" skipped: ${error.message}`);
        continue;
      }
      const ids = tracks.filter((track) => itemById.get(track.id) && !["blocked", "remove"].includes(itemById.get(track.id).kind)).map((track) => track.id);
      const pids = ids.map(pidOf);
      out.push({ id: playlist.id, name: playlist.name, trackIds: ids, pids, sig: sha1(JSON.stringify([playlist.name, pids])) });
    }
    return out;
  }

  function planPlaylists({ libraryId, items }) {
    const desired = desiredPlaylists(libraryId, items);
    const saved = libraryId ? new Map(db.prepare("SELECT * FROM apple_sync_playlists WHERE library_id = ?").all(libraryId).map((row) => [row.playlist_id, row])) : new Map();
    const actions = [];
    for (const playlist of desired) {
      const row = saved.get(playlist.id);
      if (!row || !row.pid || row.status === "removed") actions.push({ kind: "create", playlist });
      else if (row.items_sig !== playlist.sig || row.status !== "synced") actions.push({ kind: "update", playlist, pid: row.pid });
    }
    const wanted = new Set(desired.map((playlist) => playlist.id));
    for (const row of saved.values()) {
      if (wanted.has(row.playlist_id) || row.status === "removed" || !row.pid) continue;
      actions.push({ kind: "delete", pid: row.pid, name: row.name, playlist: { id: row.playlist_id, name: row.name } });
    }
    return actions;
  }

  function countPlan(plan) {
    const count = (...kinds) => plan.items.filter((item) => kinds.includes(item.kind)).length;
    const needsConfirm = plan.items.filter((item) => item.needs.length && item.kind !== "unchanged");
    return {
      managed: plan.managed,
      new: count("add", "adopt", "readd"),
      metadata: count("metadata"),
      replacements: count("replacement", "relocate", "relink"),
      removals: count("remove"),
      drift: count("drift"),
      blocked: count("blocked"),
      waiting: count("waiting"),
      converted: plan.items.filter((item) => item.target?.mode === "converted" && item.kind !== "remove").length,
      unchanged: count("unchanged"),
      needsConfirmation: needsConfirm.length,
      playlistChanges: plan.playlists.length,
      bulk: plan.bulk,
      bulkThreshold: plan.threshold,
    };
  }

  const lite = (item) => ({
    trackId: item.trackId,
    title: item.title,
    artist: item.artist,
    kind: item.kind,
    reason: item.reason || null,
    needs: item.needs,
    identityRisk: !!item.identityRisk,
    unmanageOnly: !!item.unmanageOnly,
    warnings: item.warnings,
  });

  /** Offline status for the screen: nothing here talks to iTunes. */
  function status() {
    const settings = getSettings();
    const saved = meta();
    const result = {
      destination: settings.appleDestination || "itunes",
      autoSync: !!settings.appleAutoSync,
      removalPolicy: settings.appleRemovalPolicy || "confirm",
      syncMode: "direct",
      libraryRoot: getLibraryRoot() || null,
      cache: cacheUsage(),
      organizeDetected: !!saved.organizeDetected,
      deleteRemovesFiles: !!saved.deleteRemovesFiles,
      library: { id: saved.libraryId || null, version: saved.version || null, path: saved.libraryPath || null, lastSeenAt: saved.lastSeenAt || null },
      capabilities: saved.capabilities || null,
      baselineDone: !!saved.baselineDone,
      setupConfirmed: !!saved.setupConfirmed,
      copyDetected: !!saved.copyDetected,
      lastSyncAt: saved.lastSyncAt || null,
      dirty: !!saved.dirtyAt,
      backup: saved.lastBackup || null,
      migration: saved.migration || null,
      running,
      counts: null,
      failed: [],
      review: [],
    };
    try {
      const plan = buildPlan({ libraryId: saved.libraryId || null });
      result.counts = countPlan(plan);
      result.review = plan.items.filter((item) => item.needs.length && item.kind !== "unchanged").slice(0, 100).map(lite);
      if (saved.libraryId) {
        result.failed = db
          .prepare(
            `SELECT a.track_id AS trackId, t.title, a.last_error AS error, a.attempts FROM apple_sync_tracks a LEFT JOIN tracks t ON t.id = a.track_id
             WHERE a.library_id = ? AND a.status = 'failed' ORDER BY a.updated_at DESC LIMIT 100`,
          )
          .all(saved.libraryId);
        const playlistFailures = db.prepare("SELECT playlist_id AS id, name, last_error AS error FROM apple_sync_playlists WHERE library_id = ? AND status = 'failed'").all(saved.libraryId);
        result.failedPlaylists = playlistFailures;
      }
    } catch (error) {
      result.error = error.message;
    }
    return result;
  }

  /** The compatibility cache: how many converted copies it holds and their size (it may not exist). */
  function cacheUsage() {
    const root = cacheRoot();
    const usage = { root, exists: fs.existsSync(root), files: 0, bytes: 0 };
    if (!usage.exists) return usage;
    for (const row of db.prepare("SELECT rel_path FROM export_state WHERE root_key = ?").all(pathKey(root))) {
      try {
        usage.bytes += fs.statSync(path.join(root, row.rel_path)).size;
        usage.files += 1;
      } catch {
        // A copy that went missing is made again by the next sync.
      }
    }
    return usage;
  }

  /** iTunes file songs that WaveMint doesn't manage (an "empty" iTunes has none). */
  function unmanagedIn(snapshot, libraryId) {
    const managed = new Set([...rowsFor(libraryId).values()].filter((row) => row.pid && row.status !== "removed").map((row) => row.pid));
    return snapshot.filter((track) => !managed.has(track.pid));
  }

  /** A dry run against iTunes as it is now: the preview before a manual sync. */
  async function preview({ launch = true, signal } = {}) {
    const settings = getSettings();
    if ((settings.appleDestination || "itunes") !== "itunes") throw new Error("Previewing needs classic iTunes. Choose it as the destination first.");
    const conn = await connect({ launch, signal });
    if (!conn.connected) return { connected: false, reason: "iTunes isn't running.", counts: status().counts };
    const snapshot = await getAdapter().listTracks({ signal });
    const plan = buildPlan({ libraryId: conn.libraryId, snapshot, checkFiles: true });
    const saved = meta();
    const unmanaged = unmanagedIn(snapshot, conn.libraryId);
    return {
      connected: true,
      library: { id: conn.libraryId, version: conn.version, trackCount: conn.trackCount, fileSongs: snapshot.length, unmanaged: unmanaged.length },
      itunesEmpty: snapshot.length === 0,
      newLibrary: !!conn.previousLibraryId && conn.previousLibraryId !== conn.libraryId,
      needsMigration: !saved.baselineDone && unmanaged.length > 0,
      counts: countPlan(plan),
      items: plan.items.filter((item) => item.kind !== "unchanged").slice(0, 400).map(lite),
      playlists: plan.playlists.map((action) => ({ kind: action.kind, name: action.playlist.name, songs: action.playlist.pids?.length ?? 0 })),
    };
  }

  // --- running ---------------------------------------------------------------------
  const satisfied = (item, confirm, trackKey) => {
    const pick = (value) => value === true || (Array.isArray(value) && value.includes(trackKey));
    return item.needs.every((need) => {
      if (need === "removal") return pick(confirm.removals);
      if (need === "recreate") return pick(confirm.recreate);
      if (need === "conflict") return pick(confirm.conflicts);
      if (need === "bulk") return confirm.bulk === true;
      if (need === "retry") return confirm.retry === true;
      return false;
    });
  };

  /**
   * Brings iTunes up to date. `mode` "auto" only does what needs no
   * decision; "manual" also does what `confirm` allows:
   * { removals, recreate, conflicts: true | [trackId], bulk, retry, newLibrary, baseline }.
   */
  async function run({ mode = "manual", confirm = {}, deferDelete = false, only = null, signal, progress = () => {} } = {}) {
    if (running) throw new Error("A sync is already running.");
    const settings = getSettings();
    const destination = settings.appleDestination || "itunes";
    running = true;
    const startedAt = nowIso();
    const report = {
      status: "completed",
      mode,
      added: 0,
      adopted: 0,
      updated: 0,
      relinked: 0,
      recreated: 0,
      removed: 0,
      unmanaged: 0,
      playlists: 0,
      failed: [],
      review: 0,
      skipped: [],
      skippedCount: 0,
      requested: only ? only.length : null,
      library: null,
      notes: [],
    };
    let libraryId = null;
    try {
      if (destination !== "itunes") {
        // Apple Music for Windows has no automation interface WaveMint can rely on:
        // only a portable export folder is kept up to date.
        if (!settings.exportRoot) throw new Error("Choose the export folder first.");
        const root = exporter.checkRoot(settings.exportRoot);
        const exported = await exporter.exportJob({ root, scope: { all: true }, options: { skipIfUnchanged: true, playlists: "all" }, signal, progress });
        return { ...report, status: exported.failed.length ? "partial" : "completed", destination, files: { new: exported.new, replace: exported.replace, refresh: exported.refresh, failed: exported.failed } };
      }

      // The host refuses to write a library that isn't the real one (e.g. a test library) into iTunes.
      try {
        assertWritable?.();
      } catch (error) {
        return { ...report, status: "blocked", reason: error.message, code: error.code || "not-writable" };
      }

      progress({ phase: "connecting" });
      let conn;
      try {
        conn = await connect({ launch: mode === "manual", signal });
      } catch (error) {
        if (error.code === "cancelled") throw error;
        patchMeta({ dirtyAt: meta().dirtyAt || nowIso(), lastError: error.message });
        return { ...report, status: "waiting", reason: error.message, code: error.code || "unavailable" };
      }
      if (!conn.connected) {
        patchMeta({ dirtyAt: meta().dirtyAt || nowIso() });
        return { ...report, status: "waiting", reason: "iTunes isn't running. The changes are saved and will sync when it is.", code: "not-running" };
      }
      libraryId = conn.libraryId;
      if (conn.previousLibraryId && conn.previousLibraryId !== libraryId && !confirm.newLibrary && mode !== "auto") {
        return { ...report, status: "blocked", reason: "iTunes is using a different library than the last sync. Confirm to sync into this one.", code: "new-library" };
      }
      if (mode === "auto" && !meta().baselineDone) return { ...report, status: "blocked", reason: "Run the first sync (or the guided migration) before automatic sync.", code: "no-baseline" };

      progress({ phase: "reading", detail: "Reading the iTunes library" });
      const snapshot = await getAdapter().listTracks({ signal, onProgress: (value) => progress({ phase: "reading", ...value }) });
      const unmanaged = unmanagedIn(snapshot, libraryId);
      // Which iTunes library this run writes to, as iTunes itself reports it.
      report.library = { id: libraryId, version: conn.version || null, bridge: getAdapter().kind, songsBefore: snapshot.length, unmanagedBefore: unmanaged.length };
      if (!meta().baselineDone && unmanaged.length > 0 && !confirm.baseline && !confirm.migrated) {
        return { ...report, status: "blocked", reason: `iTunes already holds ${unmanaged.length} songs WaveMint doesn't manage. Run the guided migration first so they're matched instead of duplicated.`, code: "needs-migration" };
      }
      if (meta().deleteRemovesFiles) report.notes.push("Removing songs from iTunes is paused: iTunes deleted a file when an entry was removed earlier.");

      // 1. Files: only songs iTunes can't play get a converted copy (compatibility cache).
      // Everything else is played from the library as it is: nothing to prepare.
      let exported = { failed: [], regenerated: [] };
      const toConvert = desiredTargets().filter((entry) => entry.convert && (!only || only.includes(entry.trackId))).map((entry) => entry.trackId);
      if (toConvert.length) {
        progress({ phase: "files", detail: "Converting files iTunes can't play" });
        const root = cacheRoot();
        fs.mkdirSync(root, { recursive: true });
        exported = await exporter.exportJob({ root, scope: { trackIds: toConvert }, options: { keepPrevious: true, skipIfUnchanged: true, playlists: "selected" }, signal, progress });
      }
      for (const failure of exported.failed) {
        report.failed.push({ trackId: failure.trackId, title: failure.title, error: failure.error });
        if (libraryId && db.prepare("SELECT 1 FROM apple_sync_tracks WHERE library_id = ? AND track_id = ?").get(libraryId, failure.trackId)) markFailed(libraryId, failure.trackId, failure.error);
      }
      if (signal?.aborted) return { ...report, status: "cancelled" };

      // 2. iTunes: the difference between the files and what iTunes holds.
      const plan = buildPlan({ libraryId, snapshot, regenerated: new Set(exported.regenerated), checkFiles: true });
      // Songs that can't be synced now are reported, never silently left out.
      const skipped = plan.items.filter((item) => ["blocked", "waiting"].includes(item.kind) && (!only || only.includes(item.trackId)));
      report.skippedCount = skipped.length;
      report.skipped = skipped.slice(0, 50).map((item) => ({ trackId: item.trackId, title: item.title, artist: item.artist, reason: item.reason }));
      const adapter = getAdapter();
      const byLocation = new Map(snapshot.filter((track) => track.location).map((track) => [pathKey(track.location), track]));
      const pool = plan.items.filter((item) => !["unchanged", "blocked", "waiting"].includes(item.kind) && (!only || only.includes(item.trackId)));
      const failedExport = new Set(exported.failed.map((failure) => failure.trackId));
      const allowed = (item) => !failedExport.has(item.trackId) && (item.needs.length ? mode !== "auto" && satisfied(item, confirm, item.trackId) : true);
      const todo = pool.filter(allowed);
      report.review = pool.length - todo.length - pool.filter((item) => failedExport.has(item.trackId)).length;
      const step = (phase, done, total, current) => progress({ phase, done, total, current });
      // Old converted copies to set aside once iTunes no longer plays them (never library files).
      const aside = new Set();

      // The first batch is small, so a wrong iTunes setting is caught after a few songs.
      const chunks = (list, first = CHUNK) => {
        const out = [];
        let index = 0;
        while (index < list.length) {
          const size = out.length ? CHUNK : first;
          out.push(list.slice(index, index + size));
          index += size;
        }
        return out;
      };

      // Adding: a song already at that location is adopted, never added twice.
      const adds = todo.filter((item) => ["add", "readd"].includes(item.kind));
      for (const group of chunks(adds, FIRST_CHUNK)) {
        if (signal?.aborted) break;
        step("adding", report.added, adds.length, group[0].title);
        const results = await adapter.addFiles(group.map((item) => item.target.path), { signal });
        let moved = null;
        group.forEach((item, index) => {
          const result = results[index];
          if (!result?.ok) {
            markFailed(libraryId, item.trackId, result?.error || "iTunes didn't add the song");
            report.failed.push({ trackId: item.trackId, title: item.title, error: result?.error || "iTunes didn't add the song" });
            return;
          }
          if (pathKey(result.info.location) !== pathKey(item.target.path)) {
            if (!fs.existsSync(item.target.path)) moved = moved || item;
            else {
              patchMeta({ copyDetected: true });
              if (!report.notes.some((note) => note.startsWith("iTunes copied"))) report.notes.push("iTunes copied some files into its own media folder instead of playing the library's files.");
            }
          }
          markSynced(libraryId, item.trackId, item.target, result.info, { origin: "created" });
          report.added += 1;
        });
        if (moved) {
          // iTunes moved a library file into its own folder: stop before it touches more.
          patchMeta({ organizeDetected: true });
          throw new AppleSyncError(
            "itunes-moved-files",
            `iTunes moved "${moved.title}" out of your WaveMint Library. Turn off "Keep iTunes Media folder organized" in iTunes, then rescan the library. The sync stopped.`,
          );
        }
      }

      // Adopting: an entry already referencing the song's file.
      const updates = [];
      for (const item of todo.filter((entry) => entry.kind === "adopt")) {
        saveRow(libraryId, item.trackId, {
          pid: item.pid,
          location: item.info.location,
          rel_path: item.target.relPath || null,
          target_path: item.target.path,
          mode: item.target.mode,
          source_file_id: item.target.fileId ?? null,
          format: item.target.format,
          audio_hash: null,
          file_sig: null,
          meta_sig: null,
          itunes_sig: itunesSig(item.info),
          origin: "created",
          status: "pending",
          attempts: 0,
          last_error: null,
        });
        updates.push(item);
        report.adopted += 1;
      }

      // Updating: iTunes re-reads the song's tags and artwork from its file.
      updates.push(...todo.filter((item) => ["metadata", "replacement", "drift"].includes(item.kind)));
      for (const group of chunks(updates)) {
        if (signal?.aborted) break;
        step("updating", report.updated, updates.length, group[0].title);
        const results = await adapter.updateFromFile(group.map((item) => item.pid), { signal });
        group.forEach((item, index) => {
          const result = results[index];
          const problem = !result?.ok ? result?.error || "iTunes didn't update the song" : verifyDetails(item, result.info);
          if (problem) {
            markFailed(libraryId, item.trackId, problem);
            report.failed.push({ trackId: item.trackId, title: item.title, error: problem });
            return;
          }
          markSynced(libraryId, item.trackId, item.target, result.info);
          report.updated += 1;
        });
      }

      // Relinking: iTunes keeps its entry and plays the new file. If this iTunes
      // can't change a song's file, the entry is re-created (with rating, play
      // history and playlists carried over) - only when that was confirmed.
      const relocations = todo.filter((item) => ["relocate", "relink"].includes(item.kind));
      let memberships = null;
      for (const [index, item] of relocations.entries()) {
        if (signal?.aborted) break;
        step("relinking", index, relocations.length, item.title);
        const row = plan.rows.get(item.trackId);
        const target = item.target.path;
        try {
          let done = false;
          if (locationSettable() !== false) {
            const result = await adapter.setLocation(item.pid, target, { signal });
            if (result.unsupported) patchMeta({ capabilities: { ...(meta().capabilities || {}), locationSettable: false, probedAt: nowIso() } });
            else if (!result.ok) throw new Error(result.error || "iTunes didn't accept the new location");
            else if (pathKey(result.info.location) !== pathKey(target)) throw new Error("iTunes kept the old location");
            else {
              markSynced(libraryId, item.trackId, item.target, result.info);
              report.relinked += 1;
              done = true;
            }
          }
          if (!done) {
            if (!satisfied({ needs: ["recreate"] }, confirm, item.trackId)) {
              report.review += 1;
              continue;
            }
            memberships = memberships || (await playlistMemberships(adapter, libraryId, signal));
            await recreate({ adapter, libraryId, item, row, target, byLocation, memberships, deferDelete, signal });
            report.recreated += 1;
          }
          if (row?.target_path && pathKey(row.target_path) !== pathKey(target)) aside.add(row.target_path);
        } catch (error) {
          if (error.code === "cancelled") throw error;
          markFailed(libraryId, item.trackId, error.message);
          report.failed.push({ trackId: item.trackId, title: item.title, error: error.message });
        }
      }

      // Removing: only entries WaveMint manages, only when allowed.
      const removals = todo.filter((item) => item.kind === "remove");
      const removable = removals.filter((item) => !item.unmanageOnly);
      for (const item of removals.filter((entry) => entry.unmanageOnly)) {
        saveRow(libraryId, item.trackId, { status: "removed", pid: null, last_error: null });
        report.unmanaged += 1;
      }
      for (const group of chunks(removable)) {
        if (signal?.aborted) break;
        step("removing", report.removed, removable.length, group[0].title);
        const results = await deleteEntries(adapter, group.map((item) => ({ pid: item.pid, location: item.location })), { signal });
        group.forEach((item) => {
          const result = results.get(item.pid);
          if (!result?.ok) {
            markFailed(libraryId, item.trackId, result?.error || "iTunes didn't remove the song");
            report.failed.push({ trackId: item.trackId, title: item.title, error: result?.error });
            return;
          }
          saveRow(libraryId, item.trackId, { status: "removed", pid: null, last_error: null, last_synced_at: nowIso() });
          if (item.target?.mode === "converted" && item.target.path) {
            aside.add(item.target.path);
            db.prepare("DELETE FROM export_state WHERE root_key = ? AND track_id = ?").run(pathKey(cacheRoot()), item.trackId);
          }
          report.removed += 1;
        });
      }

      // Old converted copies are set aside only now that iTunes no longer plays them.
      // Library files are never touched: only files inside the compatibility cache qualify.
      const cache = cacheRoot();
      for (const file of aside) {
        if (!isInside(cache, file)) continue;
        const relPath = path.relative(cache, file);
        const stillUsed = db.prepare("SELECT 1 FROM apple_sync_tracks WHERE library_id = ? AND target_path = ? AND pid IS NOT NULL AND status != 'removed' LIMIT 1").get(libraryId, file);
        const exportedNow = db.prepare("SELECT 1 FROM export_state WHERE root_key = ? AND rel_path = ?").get(pathKey(cache), relPath);
        if (!stillUsed && !exportedNow) {
          try {
            exporter.setAside(cache, relPath);
          } catch (error) {
            report.notes.push(`Couldn't set aside ${relPath}: ${error.message}`);
          }
        }
      }

      // Playlists, after the songs so their IDs are known.
      if (!signal?.aborted) report.playlists = await syncPlaylists({ adapter, libraryId, items: plan.items, mode, confirm, signal, progress, report });

      report.status = signal?.aborted ? "cancelled" : report.failed.length ? "partial" : "completed";
      // A run for chosen songs (the first test) that synced none of them didn't work, whatever else happened.
      const synced = report.added + report.adopted + report.updated + report.relinked + report.recreated + report.removed + report.unmanaged;
      if (only && synced === 0 && report.playlists === 0 && !signal?.aborted) {
        report.status = "nothing";
        report.reason = report.skippedCount
          ? `None of the ${only.length} chosen songs could be synced: ${report.skipped[0]?.reason || "see the list"}.`
          : report.failed.length
            ? `None of the ${only.length} chosen songs could be synced: ${report.failed[0].error}.`
            : report.review
              ? `${report.review} of the ${only.length} chosen songs need a decision first (Apple Library Sync shows them).`
              : `None of the ${only.length} chosen songs needed syncing.`;
      }
      // Songs whose changes aren't in their files yet keep the sync pending.
      const outstanding = report.failed.length > 0 || report.review > 0 || plan.items.some((item) => item.kind === "waiting");
      const finished = { lastSyncAt: nowIso(), lastError: null };
      if (!outstanding && !signal?.aborted) finished.dirtyAt = null;
      // Changes not yet written into their files sync once they are (cheap to check: no iTunes needed).
      else if (plan.items.some((item) => item.kind === "waiting")) finished.dirtyAt = meta().dirtyAt || nowIso();
      // A first full sync sets the baseline automatic sync builds on (a test with a few songs doesn't).
      if (!meta().baselineDone && report.status !== "cancelled" && !only && (confirm.baseline || confirm.migrated || unmanaged.length === 0)) finished.baselineDone = true;
      patchMeta(finished);
      return report;
    } catch (error) {
      if (error.code === "cancelled") return { ...report, status: "cancelled" };
      if (error instanceof AppleSyncError && error.code === "itunes-moved-files") {
        patchMeta({ lastError: error.message });
        return { ...report, status: "stopped", reason: error.message, code: error.code };
      }
      if (error instanceof AppleSyncError) {
        patchMeta({ dirtyAt: meta().dirtyAt || nowIso(), lastError: error.message });
        return { ...report, status: "waiting", reason: error.message, code: error.code };
      }
      throw error;
    } finally {
      running = false;
      const meaningful = report.added + report.adopted + report.updated + report.relinked + report.recreated + report.removed + report.unmanaged + report.playlists + report.failed.length > 0;
      if (libraryId && meaningful) {
        db.prepare("INSERT INTO apple_sync_runs (library_id, kind, started_at, finished_at, status, report) VALUES (?, ?, ?, ?, ?, ?)").run(libraryId, mode === "auto" ? "auto" : "sync", startedAt, nowIso(), report.status, JSON.stringify(report));
        emit("library-changed", { appleSync: true });
      }
    }
  }

  // --- guarded removal ----------------------------------------------------------------
  // iTunes and WaveMint play the same files, so removing an iTunes entry must
  // never take its file along. Before each removal the file gets a temporary
  // second name on the same drive (a hard link: no copy, no extra space).
  // Afterwards the file must still be there; if iTunes removed it, it is put
  // back from that second name and further removals stop. A file that can't
  // be protected this way isn't risked: its entry is not removed.

  function guardFolders(file) {
    const volume = path.parse(file).root.toLowerCase();
    const library = getLibraryRoot();
    // A folder of its own (never scanned, never cleaned up by Storage), on the file's drive.
    return [library && path.join(library, ".wavemint-guard"), path.join(path.parse(file).root, ".wavemint-guard")].filter(
      (folder) => folder && path.parse(folder).root.toLowerCase() === volume,
    );
  }

  function makeGuard(file) {
    for (const folder of guardFolders(file)) {
      try {
        fs.mkdirSync(folder, { recursive: true });
        const guard = path.join(folder, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file)}`);
        fs.linkSync(file, guard);
        return guard;
      } catch {
        // Try the next place on the same drive.
      }
    }
    return null;
  }

  /** Removes iTunes entries; resolves to a Map from persistent ID to { ok, error }. */
  async function deleteEntries(adapter, entries, { signal } = {}) {
    const results = new Map();
    if (meta().deleteRemovesFiles) {
      for (const entry of entries) results.set(entry.pid, { ok: false, error: "Removing songs from iTunes is paused: iTunes deleted a file during an earlier removal." });
      return results;
    }
    const guards = new Map();
    const ready = [];
    for (const entry of entries) {
      const file = entry.location;
      if (file && fs.existsSync(file)) {
        const guard = makeGuard(file);
        if (!guard) {
          results.set(entry.pid, { ok: false, error: "WaveMint couldn't protect the song's file, so its iTunes entry wasn't removed." });
          continue;
        }
        guards.set(entry.pid, { file, guard });
      }
      ready.push(entry);
    }
    let outcomes = [];
    try {
      outcomes = ready.length ? await adapter.deleteTracks(ready.map((entry) => entry.pid), { signal }) : [];
    } finally {
      ready.forEach((entry, index) => {
        const outcome = outcomes[index] || { ok: false, error: "No answer from iTunes" };
        const guarded = guards.get(entry.pid);
        if (guarded && !fs.existsSync(guarded.file)) {
          let restored = false;
          try {
            fs.mkdirSync(path.dirname(guarded.file), { recursive: true });
            fs.linkSync(guarded.guard, guarded.file);
            restored = true;
          } catch (error) {
            logger.error(`[apple] iTunes removed ${guarded.file}; it is kept at ${guarded.guard}: ${error.message}`);
          }
          patchMeta({ deleteRemovesFiles: true });
          results.set(entry.pid, {
            ok: false,
            error: restored
              ? "iTunes deleted the song's file when its entry was removed. WaveMint put the file back and paused removals."
              : `iTunes deleted the song's file. It is safe at ${guarded.guard}; removals are paused.`,
          });
          if (!restored) guards.delete(entry.pid); // keep the only remaining name
          return;
        }
        results.set(entry.pid, { ok: !!outcome.ok, error: outcome.error });
      });
      for (const { guard } of guards.values()) {
        try {
          fs.rmSync(guard, { force: true });
          // The guard folder goes too once nothing is left in it.
          if (!fs.readdirSync(path.dirname(guard)).length) fs.rmdirSync(path.dirname(guard));
        } catch (error) {
          logger.warn(`[apple] Couldn't remove a temporary file name ${guard}: ${error.message}`);
        }
      }
    }
    return results;
  }

  /** The song's details in iTunes match the song after an update. */
  function verifyDetails(item, info) {
    const track = db.prepare("SELECT title, artist FROM tracks WHERE id = ?").get(item.trackId);
    if (!track || !info) return null;
    if (norm(track.title) && !sameText(track.title, info.name)) return "iTunes didn't pick up the new title";
    if (norm(track.artist) && !sameText(track.artist, info.artist)) return "iTunes didn't pick up the new artist";
    return null;
  }

  /** Playlists (other than WaveMint's own) that contain each iTunes song. */
  async function playlistMemberships(adapter, libraryId, signal) {
    const ours = new Set(db.prepare("SELECT pid FROM apple_sync_playlists WHERE library_id = ? AND pid IS NOT NULL").all(libraryId).map((row) => row.pid));
    const map = new Map();
    for (const playlist of await adapter.listPlaylists({ withTracks: true, signal })) {
      if (ours.has(playlist.pid) || playlist.smart || playlist.special !== 0) continue;
      for (const pid of [].concat(playlist.tracks || [])) map.set(pid, [...(map.get(pid) || []), playlist.pid]);
    }
    return map;
  }

  /**
   * Replaces an entry whose file can't be re-pointed. The new entry is added
   * (or found) and checked first; rating, play history and playlists are
   * carried over; the old entry is removed last - or, in the migration, left
   * for the cleanup step after the whole library has been verified.
   */
  async function recreate({ adapter, libraryId, item, row, target, byLocation, memberships, deferDelete, signal }) {
    let fresh = byLocation.get(pathKey(target));
    if (!fresh || fresh.pid === item.pid) {
      const [added] = await adapter.addFiles([target], { signal });
      if (!added?.ok) throw new Error(added?.error || "iTunes didn't add the song");
      fresh = added.info;
    }
    const check = await adapter.getTracks([fresh.pid], { signal });
    if (!check.get(fresh.pid)) throw new Error("The new iTunes entry couldn't be verified");
    const carried = await adapter.carryOver({ from: item.pid, to: fresh.pid, playlists: memberships.get(item.pid) || [] }, { signal });
    if (!carried.ok) throw new Error(carried.error || "Couldn't carry the song's history over");
    const legacy = parseJson(row?.legacy_pids, []);
    if (deferDelete) {
      markSynced(libraryId, item.trackId, item.target, fresh, { legacy_pids: JSON.stringify([...legacy, item.pid]), origin: row?.origin || "created" });
      return;
    }
    const deleted = (await deleteEntries(adapter, [{ pid: item.pid, location: item.info?.location || row?.location }], { signal })).get(item.pid);
    if (!deleted?.ok) {
      // The new entry is in place; the old one stays listed as a superseded entry.
      markSynced(libraryId, item.trackId, item.target, fresh, { legacy_pids: JSON.stringify([...legacy, item.pid]) });
      return;
    }
    markSynced(libraryId, item.trackId, item.target, fresh);
  }

  /** Creates, updates and deletes WaveMint's own iTunes playlists. */
  async function syncPlaylists({ adapter, libraryId, items, mode, confirm, signal, progress, report }) {
    const actions = planPlaylists({ libraryId, items });
    if (!actions.length) return 0;
    const existing = actions.some((action) => action.kind !== "delete") ? await adapter.listPlaylists({ signal }) : [];
    let changed = 0;
    for (const [index, action] of actions.entries()) {
      if (signal?.aborted) break;
      progress({ phase: "playlists", done: index, total: actions.length, current: action.playlist.name });
      const save = (patch) =>
        db
          .prepare(
            `INSERT INTO apple_sync_playlists (library_id, playlist_id, pid, name, items_sig, status, last_error, last_synced_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(library_id, playlist_id) DO UPDATE SET pid = excluded.pid, name = excluded.name, items_sig = excluded.items_sig, status = excluded.status,
               last_error = excluded.last_error, last_synced_at = excluded.last_synced_at, updated_at = excluded.updated_at`,
          )
          .run(libraryId, action.playlist.id, patch.pid ?? null, patch.name ?? action.playlist.name, patch.sig ?? null, patch.status, patch.error ?? null, patch.status === "synced" ? nowIso() : null, nowIso());
      try {
        if (action.kind === "delete") {
          // Deleting a playlist is a removal: it waits for a decision, and says so.
          if (mode === "auto" || !(confirm.removals === true)) {
            report.review += 1;
            continue;
          }
          await adapter.deletePlaylist(action.pid, { signal });
          save({ pid: null, status: "removed", sig: null });
          changed += 1;
          continue;
        }
        // Songs that aren't in iTunes yet (not synced) are left out until they are.
        const rows = rowsFor(libraryId);
        const pids = action.playlist.trackIds.map((trackId) => rows.get(trackId)).filter((row) => row?.pid && row.status === "synced").map((row) => row.pid);
        const sig = sha1(JSON.stringify([action.playlist.name, pids]));
        let pid = action.pid;
        // Never take over (or rename onto) a playlist that already has this name.
        const taken = (candidate) => existing.some((playlist) => playlist.pid !== pid && sameText(playlist.name, candidate));
        let name = taken(action.playlist.name) ? `${action.playlist.name} (WaveMint)` : action.playlist.name;
        if (action.kind === "create") {
          pid = (await adapter.createPlaylist(name, { signal })).pid;
          existing.push({ pid, name });
          save({ pid, name, status: "pending", sig: null });
        } else {
          const current = existing.find((playlist) => playlist.pid === pid);
          if (!current) throw new Error("The playlist is no longer in iTunes");
          if (current.name !== name) {
            await adapter.renamePlaylist(pid, name, { signal });
            current.name = name;
          }
        }
        await adapter.setPlaylistTracks(pid, pids, { signal });
        save({ pid, name, status: "synced", sig });
        changed += 1;
      } catch (error) {
        if (error.code === "cancelled") throw error;
        save({ pid: action.pid ?? null, status: "failed", error: error.message });
        report.failed.push({ playlist: action.playlist.name, error: error.message });
      }
    }
    return changed;
  }

  /** Puts failed songs back in line (a manual retry ignores earlier attempts). */
  function resetFailures(trackIds = null) {
    const libraryId = meta().libraryId;
    if (!libraryId) return { reset: 0 };
    const rows = db.prepare("SELECT track_id FROM apple_sync_tracks WHERE library_id = ? AND status = 'failed'").all(libraryId).filter((row) => !trackIds || trackIds.includes(row.track_id));
    for (const row of rows) saveRow(libraryId, row.track_id, { status: "pending", attempts: 0, last_error: null });
    return { reset: rows.length };
  }

  /** Accepts the details as they are in iTunes (an edit made there stays). */
  async function acceptItunesDetails(trackIds, { signal } = {}) {
    const libraryId = meta().libraryId;
    const rows = rowsFor(libraryId);
    const wanted = trackIds.map((id) => rows.get(id)).filter((row) => row?.pid);
    const current = await getAdapter().getTracks(wanted.map((row) => row.pid), { signal });
    for (const row of wanted) {
      const info = current.get(row.pid);
      if (info) saveRow(libraryId, row.track_id, { itunes_sig: itunesSig(info) });
    }
    return { accepted: wanted.length };
  }

  // --- automatic sync ----------------------------------------------------------------
  /** Records that something changed and, if automatic sync is on, schedules a run. */
  function touch({ delayMs = DEBOUNCE_MS } = {}) {
    const settings = getSettings();
    if ((settings.appleDestination || "itunes") !== "itunes") return;
    if (!meta().baselineDone) return;
    patchMeta({ dirtyAt: nowIso() });
    if (!settings.appleAutoSync) return;
    clearTimeout(timer);
    timer = setTimeout(autoTick, delayMs);
    timer.unref?.();
  }

  async function autoTick() {
    const settings = getSettings();
    if (!settings.appleAutoSync || !meta().dirtyAt || (settings.appleDestination || "itunes") !== "itunes") return;
    // Edits are synced once things settle, never in the middle of a file operation.
    if (running || !isQuiet()) return void touch({ delayMs: 15 * 1000 });
    try {
      // Nothing to do means no need to read iTunes' whole library.
      const plan = buildPlan({ libraryId: meta().libraryId || null });
      // Only work automatic sync may do counts: changes waiting for a decision
      // (removals, deleted playlists…) don't make it read iTunes over and over.
      const autoWork =
        plan.items.some((item) => !["unchanged", "blocked", "waiting"].includes(item.kind) && !item.needs.length) ||
        plan.playlists.some((action) => action.kind !== "delete");
      if (!autoWork) return void patchMeta({ dirtyAt: null });
      if (!(await getAdapter().isRunning())) return;
      const result = await run({ mode: "auto" });
      if (result.status === "partial" && result.failed.some((failure) => !failure.trackId)) logger.warn("[apple] Automatic sync had playlist errors");
    } catch (error) {
      logger.warn(`[apple] Automatic sync failed: ${error.message}`);
    }
  }

  function start() {
    clearInterval(poller);
    // A cheap check: nothing happens unless there is unsynced work and automatic sync is on.
    poller = setInterval(() => {
      if (meta().dirtyAt && getSettings().appleAutoSync) autoTick();
    }, POLL_MS);
    poller.unref?.();
    if (meta().dirtyAt && getSettings().appleAutoSync) {
      timer = setTimeout(autoTick, 60 * 1000);
      timer.unref?.();
    }
  }

  function stop() {
    clearTimeout(timer);
    clearInterval(poller);
  }

  return {
    acceptItunesDetails,
    buildPlan,
    connect,
    countPlan,
    isRunning: () => running,
    itunesSig,
    meta,
    patchMeta,
    preview,
    resetFailures,
    cacheRoot,
    cacheUsage,
    deleteEntries,
    desiredTargets,
    unmanagedIn,
    rowsFor,
    run,
    saveRow,
    start,
    status,
    stop,
    touch,
  };
}

module.exports = { createAppleSync, itunesSig };
