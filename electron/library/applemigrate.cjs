// The guided first migration of an existing iTunes library to WaveMint-managed
// synchronization.
//
// Goal: do it once, carefully, and end with the persistent mapping every later
// sync relies on. The order is deliberately cautious:
//
//   1. Analyze (read-only): compare iTunes' songs with WaveMint's curated
//      songs, with conservative, explainable matching:
//        exact      the iTunes entry already plays a file WaveMint knows for
//                   that song (same path)
//        strong     same artist + title (+ album when both have one) and the
//                   same length (within 3 s), and nobody else claims either side
//        ambiguous  anything else with candidates: the user decides
//      Everything iTunes holds that matches no WaveMint song is only listed.
//   2. Preview (dry run): what would be adopted, relinked or added.
//   3. Back up the iTunes database files (and confirm).
//   4. Apply: matched entries are adopted (and, where possible, kept and pointed
//      at the Apple Library file; otherwise re-created with rating, play history
//      and playlists carried over); the remaining songs are added.
//      Old entries are NOT deleted here.
//   5. Verify the resulting library.
//   6. Clean up (optional, separate, confirmed): remove the superseded entries
//      and any obsolete ones the user picked. Media files are never deleted.
//
// iTunes' XML export is not used: the live COM listing carries the same
// persistent IDs and play counts and is always current, and the XML cannot be
// written back to the binary iTunes database anyway.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { nowIso, parseJson } = require("./db.cjs");
const { artistKey, normalizeKey, pathKey, titleKey } = require("./normalize.cjs");
const { itunesSig } = require("./applesync.cjs");
const { playlistTracks } = require("./playlists.cjs");

const LENGTH_TOLERANCE_MS = 3000;
const BACKUP_FRESH_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 500;
const CHUNK = 100;
const BACKUP_FILES = [/^iTunes( Music)? Library\.(itl|xml)$/i, /^iTunes Library (Genius|Extras)\.itdb$/i, /^iTunes Library\.itl\.bak$/i];

const brief = (track) => ({
  pid: track.pid,
  name: track.name,
  artist: track.artist,
  album: track.album,
  location: track.location,
  exists: !!track.exists,
  rating: track.rating,
  playedCount: track.playedCount,
});

function createAppleMigration({ db, sync, getAdapter, paths, logger = console }) {
  function backupIsFresh() {
    const backup = sync.meta().lastBackup;
    return !!backup && Date.now() - Date.parse(backup.at) < BACKUP_FRESH_MS;
  }

  /** Copies iTunes' database files to a dated folder. Media files are not copied. */
  async function backup({ signal } = {}) {
    const adapter = getAdapter();
    const wasRunning = await adapter.isRunning();
    let libraryPath = sync.meta().libraryPath;
    if (!libraryPath) libraryPath = (await sync.connect({ launch: true, signal })).libraryPath;
    // iTunes doesn't always report where its library is: the usual place is checked too.
    const folders = [libraryPath && path.dirname(libraryPath), path.join(os.homedir(), "Music", "iTunes")].filter(Boolean);
    const source = folders.find((folder) => fs.existsSync(path.join(folder, "iTunes Library.itl")) || fs.existsSync(path.join(folder, "iTunes Music Library.xml")));
    if (!source) throw new Error("WaveMint couldn't find the iTunes library folder.");
    const target = path.join(paths.dataDir, "apple-backups", `itunes-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(target, { recursive: true });
    const copied = [];
    const failed = [];
    for (const name of fs.readdirSync(source)) {
      if (!BACKUP_FILES.some((pattern) => pattern.test(name))) continue;
      try {
        fs.copyFileSync(path.join(source, name), path.join(target, name));
        copied.push(name);
      } catch (error) {
        failed.push({ file: name, error: error.code || error.message });
      }
    }
    if (!copied.some((name) => /\.itl$/i.test(name))) {
      throw new Error("The iTunes library file couldn't be copied. Close iTunes completely, then back up again.");
    }
    const record = { at: nowIso(), path: target, files: copied, failed, iTunesWasRunning: wasRunning };
    sync.patchMeta({ lastBackup: record });
    return record;
  }

  /** Read-only comparison of iTunes and the curated library. */
  async function analyzeFull({ signal, progress } = {}) {
    const conn = await sync.connect({ launch: true, signal });
    if (!conn.connected) throw new Error("iTunes didn't start.");
    progress?.({ phase: "reading", detail: "Reading the iTunes library" });
    const snapshot = await getAdapter().listTracks({ signal, onProgress: (value) => progress?.({ phase: "reading", ...value }) });
    const rows = sync.rowsFor(conn.libraryId);
    const managed = new Set([...rows.values()].filter((row) => row.pid && row.status !== "removed").map((row) => row.pid));
    const live = new Set(snapshot.map((track) => track.pid));

    const candidates = snapshot.filter((track) => !managed.has(track.pid));
    const byPath = new Map();
    const byKey = new Map();
    for (const track of candidates) {
      if (track.location) byPath.set(pathKey(track.location), track);
      const key = `${artistKey(track.artist)}|${titleKey(track.name)}`;
      byKey.set(key, [...(byKey.get(key) || []), track]);
    }

    const filesByTrack = new Map();
    for (const file of db.prepare("SELECT track_id, path FROM files WHERE track_id IS NOT NULL").all()) {
      filesByTrack.set(file.track_id, [...(filesByTrack.get(file.track_id) || []), pathKey(file.path)]);
    }
    // Converted copies (compatibility cache) count as the song's files too.
    const cache = sync.cacheRoot();
    for (const entry of db.prepare("SELECT track_id, rel_path FROM export_state WHERE root_key = ?").all(pathKey(cache))) {
      filesByTrack.set(entry.track_id, [...(filesByTrack.get(entry.track_id) || []), pathKey(path.join(cache, entry.rel_path))]);
    }

    const tracks = db.prepare("SELECT id, title, artist, album, duration_ms, title_key, artist_key FROM tracks WHERE state = 'active'").all();
    const proposals = [];
    for (const track of tracks) {
      const row = rows.get(track.id);
      if (row?.pid && row.status !== "removed" && live.has(row.pid)) continue; // already managed
      const exact = [...new Set((filesByTrack.get(track.id) || []).map((key) => byPath.get(key)).filter(Boolean))];
      if (exact.length === 1) {
        proposals.push({ track, confidence: "exact", candidates: exact });
        continue;
      }
      if (exact.length > 1) {
        proposals.push({ track, confidence: "ambiguous", candidates: exact, reason: "Several iTunes entries play this song's files" });
        continue;
      }
      const key = `${track.artist_key || artistKey(track.artist)}|${track.title_key || titleKey(track.title)}`;
      let found = byKey.get(key) || [];
      if (track.duration_ms) found = found.filter((entry) => !entry.duration || Math.abs(entry.duration * 1000 - track.duration_ms) <= LENGTH_TOLERANCE_MS);
      if (track.album && found.length > 1) {
        const sameAlbum = found.filter((entry) => normalizeKey(entry.album) === normalizeKey(track.album));
        if (sameAlbum.length) found = sameAlbum;
      }
      if (found.length === 1) proposals.push({ track, confidence: "strong", candidates: found });
      else if (found.length > 1) proposals.push({ track, confidence: "ambiguous", candidates: found, reason: "More than one iTunes entry looks like this song" });
    }

    // An iTunes entry two songs both want is not a confident match for either.
    const claims = new Map();
    for (const proposal of proposals) for (const entry of proposal.candidates) claims.set(entry.pid, (claims.get(entry.pid) || 0) + 1);
    for (const proposal of proposals) {
      if (proposal.confidence !== "ambiguous" && claims.get(proposal.candidates[0].pid) > 1) {
        Object.assign(proposal, { confidence: "ambiguous", reason: "Another song matches the same iTunes entry" });
      }
    }

    const matched = new Set(proposals.flatMap((proposal) => (proposal.confidence === "ambiguous" ? [] : [proposal.candidates[0].pid])));
    const wanted = new Set(proposals.flatMap((proposal) => proposal.candidates.map((entry) => entry.pid)));
    const obsolete = candidates.filter((track) => !wanted.has(track.pid));
    const duplicateGroups = new Map();
    for (const track of snapshot) {
      const key = `${artistKey(track.artist)}|${titleKey(track.name)}`;
      duplicateGroups.set(key, [...(duplicateGroups.get(key) || []), track]);
    }
    const duplicates = [...duplicateGroups.values()].filter((group) => group.length > 1);
    const matchedIds = new Set(proposals.map((proposal) => proposal.track.id));
    const toAdd = tracks.filter((track) => !matchedIds.has(track.id) && !(rows.get(track.id)?.pid && live.has(rows.get(track.id).pid)));

    return { conn, snapshot, proposals, matched, obsolete, duplicates, toAdd, managedCount: managed.size };
  }

  async function analyze(options) {
    const analysis = await analyzeFull(options);
    const confident = analysis.proposals.filter((proposal) => proposal.confidence !== "ambiguous");
    const ambiguous = analysis.proposals.filter((proposal) => proposal.confidence === "ambiguous");
    return {
      library: { id: analysis.conn.libraryId, version: analysis.conn.version, trackCount: analysis.snapshot.length },
      counts: {
        iTunesSongs: analysis.snapshot.length,
        alreadyManaged: analysis.managedCount,
        exact: confident.filter((proposal) => proposal.confidence === "exact").length,
        strong: confident.filter((proposal) => proposal.confidence === "strong").length,
        ambiguous: ambiguous.length,
        toAdd: analysis.toAdd.length,
        obsolete: analysis.obsolete.length,
        missingFiles: analysis.snapshot.filter((track) => !track.exists).length,
        duplicateGroups: analysis.duplicates.length,
      },
      matches: confident.slice(0, LIST_LIMIT).map((proposal) => ({ trackId: proposal.track.id, title: proposal.track.title, artist: proposal.track.artist, confidence: proposal.confidence, itunes: brief(proposal.candidates[0]) })),
      ambiguous: ambiguous.slice(0, 200).map((proposal) => ({ trackId: proposal.track.id, title: proposal.track.title, artist: proposal.track.artist, reason: proposal.reason, candidates: proposal.candidates.slice(0, 8).map(brief) })),
      obsolete: analysis.obsolete.slice(0, LIST_LIMIT).map(brief),
      duplicates: analysis.duplicates.slice(0, 100).map((group) => group.slice(0, 6).map(brief)),
      truncated: confident.length > LIST_LIMIT || analysis.obsolete.length > LIST_LIMIT,
    };
  }

  /**
   * `resolutions` maps a song ID to an iTunes persistent ID (use that entry)
   * or "new" (don't match; add the song as new). Confident matches are used
   * unless overridden. A dry run only reports.
   */
  async function apply({ resolutions = {}, dryRun = true, backupAck = false, signal, progress } = {}) {
    const analysis = await analyzeFull({ signal, progress });
    const libraryId = analysis.conn.libraryId;
    // The file each song should play: its own library file, or a converted copy.
    const targets = new Map(sync.desiredTargets().map((entry) => [entry.trackId, entry]));
    const settable = sync.meta().capabilities?.locationSettable;

    const adopt = [];
    for (const proposal of analysis.proposals) {
      const choice = resolutions[proposal.track.id] ?? resolutions[String(proposal.track.id)];
      let entry = null;
      if (choice === "new") continue;
      if (proposal.confidence !== "ambiguous") entry = proposal.candidates[0];
      else if (choice) entry = proposal.candidates.find((candidate) => candidate.pid === choice) || null;
      if (entry) adopt.push({ track: proposal.track, entry, confidence: proposal.confidence });
    }
    const used = new Set();
    for (const item of adopt) {
      if (used.has(item.entry.pid)) throw new Error("Two songs were matched to the same iTunes entry. Review the choices.");
      used.add(item.entry.pid);
    }
    const inPlace = adopt.filter((item) => targets.get(item.track.id)?.target?.path && pathKey(targets.get(item.track.id).target.path) === pathKey(item.entry.location));
    const relink = adopt.length - inPlace.length;
    const adoptedIds = new Set(adopt.map((item) => item.track.id));
    const rows = sync.rowsFor(libraryId);
    const adding = [...targets.values()].filter((entry) => !adoptedIds.has(entry.trackId) && !entry.problems.length && !rows.get(entry.trackId)?.pid).length;
    const summary = {
      adopt: adopt.length,
      inPlace: inPlace.length,
      relink,
      // When this iTunes can't re-point an entry, a new entry replaces it (history carried over).
      identityChanges: settable === false ? relink : 0,
      identityUnknown: settable === null || settable === undefined,
      add: adding,
      leftAlone: analysis.obsolete.length,
      needsBackup: relink > 0,
    };
    if (dryRun) return { dryRun: true, ...summary };

    if (summary.needsBackup && !backupIsFresh() && !backupAck) {
      throw new Error("Back up the iTunes library first (or confirm you have a backup).");
    }
    for (const item of adopt) {
      const target = targets.get(item.track.id)?.target;
      const here = inPlace.includes(item);
      // An entry that already plays the right file keeps it; any other is re-pointed by the sync.
      sync.saveRow(libraryId, item.track.id, {
        pid: item.entry.pid,
        location: item.entry.location,
        rel_path: here ? target.relPath || null : null,
        target_path: here ? target.path : null,
        mode: here ? target.mode : null,
        source_file_id: here ? target.fileId ?? null : null,
        format: here ? target.format : null,
        audio_hash: null,
        file_sig: null,
        meta_sig: null,
        itunes_sig: itunesSig(item.entry),
        origin: "adopted",
        status: "pending",
        attempts: 0,
        last_error: null,
      });
    }

    const result = await sync.run({
      mode: "manual",
      confirm: { recreate: true, bulk: true, newLibrary: true, migrated: true, retry: true },
      deferDelete: true,
      signal,
      progress,
    });
    const verification = result.status === "completed" || result.status === "partial" ? await verify({ signal }) : null;
    if (result.status === "completed" || result.status === "partial") {
      sync.patchMeta({ migration: { at: nowIso(), adopted: adopt.length, added: result.added, recreated: result.recreated, relinked: result.relinked, verified: !!verification?.ok }, baselineDone: true });
    }
    return { dryRun: false, ...summary, result, verification };
  }

  /**
   * Checks iTunes against the saved mapping, read-only: every managed song is
   * there once, plays the right file (the library's own file, so no second
   * copy exists), the file is there, its details and artwork came through, and
   * WaveMint's playlists hold the right songs.
   */
  async function verify({ signal } = {}) {
    const conn = await sync.connect({ launch: true, signal });
    if (!conn.connected) throw new Error("iTunes didn't start.");
    const snapshot = await getAdapter().listTracks({ signal });
    const byPid = new Map(snapshot.map((track) => [track.pid, track]));
    const atLocation = new Map();
    for (const track of snapshot.filter((item) => item.location)) atLocation.set(pathKey(track.location), (atLocation.get(pathKey(track.location)) || 0) + 1);
    const problems = [];
    const superseded = [];
    const counts = { checked: 0, direct: 0, converted: 0 };
    const detailsOf = db.prepare("SELECT t.title, t.artist, t.album, COALESCE(t.artwork_hash, f.artwork_hash) AS art FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id WHERE t.id = ?");
    const rows = sync.rowsFor(conn.libraryId);
    for (const row of rows.values()) {
      const track = detailsOf.get(row.track_id) || {};
      const title = track.title || "(song)";
      const add = (problem) => problems.push({ trackId: row.track_id, title, problem });
      for (const pid of parseJson(row.legacy_pids, [])) if (byPid.has(pid)) superseded.push({ trackId: row.track_id, pid, title });
      if (!row.pid || row.status === "removed") continue;
      const entry = byPid.get(row.pid);
      counts.checked += 1;
      if (row.mode === "converted") counts.converted += 1;
      else counts.direct += 1;
      if (!entry) add("Missing in iTunes");
      else if (row.status !== "synced") add(row.last_error || "Not synced yet");
      else if (!entry.location) add("iTunes can't find the song's file (it was moved or renamed); sync to point iTunes at it again");
      else if (!row.target_path || pathKey(entry.location) !== pathKey(row.target_path)) add("iTunes plays a different file (a copy, or a file WaveMint doesn't use)");
      else if (!entry.exists) add("iTunes can't find the file");
      else if (atLocation.get(pathKey(entry.location)) > 1) add("More than one iTunes entry plays this file");
      else if (track.title && entry.name.trim().toLowerCase() !== track.title.trim().toLowerCase()) add("iTunes shows a different title");
      else if (track.artist && entry.artist.trim().toLowerCase() !== track.artist.trim().toLowerCase()) add("iTunes shows a different artist");
      else if (track.art && entry.artworkCount === 0) add("iTunes shows no artwork");
    }

    // WaveMint's own playlists: exactly their songs, in order.
    const playlistRows = db.prepare("SELECT * FROM apple_sync_playlists WHERE library_id = ? AND status = 'synced' AND pid IS NOT NULL").all(conn.libraryId);
    if (playlistRows.length) {
      const live = new Map((await getAdapter().listPlaylists({ withTracks: true, signal })).map((item) => [item.pid, item]));
      for (const saved of playlistRows) {
        const inItunes = live.get(saved.pid);
        if (!inItunes) {
          problems.push({ playlist: saved.name, problem: "The playlist is missing in iTunes" });
          continue;
        }
        let wanted = [];
        try {
          wanted = playlistTracks(db, saved.playlist_id)
            .map((track) => rows.get(track.id))
            .filter((row) => row?.pid && row.status === "synced")
            .map((row) => row.pid);
        } catch {
          continue; // the playlist is gone from WaveMint: the next sync handles it
        }
        if ([].concat(inItunes.tracks || []).join() !== wanted.join()) problems.push({ playlist: saved.name, problem: "The playlist's songs differ from WaveMint's" });
      }
    }

    // Nothing synced is nothing verified: it never counts as a success.
    if (counts.checked === 0) problems.push({ problem: "No songs are synced to iTunes yet, so there is nothing to verify." });
    return {
      ok: problems.length === 0,
      problems: problems.slice(0, 200),
      problemCount: problems.length,
      superseded,
      iTunesSongs: snapshot.length,
      ...counts,
      cache: sync.cacheUsage(),
    };
  }

  /**
   * Removes superseded entries and the obsolete ones the user picked, from
   * iTunes' library only. Refuses anything WaveMint manages, anything that
   * isn't in iTunes, and a verification with problems.
   */
  async function cleanup({ pids = [], includeSuperseded = true, expected, backupAck = false, signal, progress } = {}) {
    const verification = await verify({ signal });
    if (!verification.ok) throw new Error("The new library has problems. Fix them before removing anything.");
    if (!backupIsFresh() && !backupAck) throw new Error("Back up the iTunes library first (or confirm you have a backup).");
    const conn = await sync.connect({ launch: false, signal });
    const libraryId = conn.libraryId;
    const rows = [...sync.rowsFor(libraryId).values()];
    const managed = new Set(rows.filter((row) => row.pid && row.status !== "removed").map((row) => row.pid));
    const snapshot = await getAdapter().listTracks({ signal });
    const live = new Set(snapshot.map((track) => track.pid));
    const locations = new Map(snapshot.map((track) => [track.pid, track.location]));
    const targets = new Set(pids);
    if (includeSuperseded) for (const entry of verification.superseded) targets.add(entry.pid);
    const list = [...targets].filter((pid) => live.has(pid) && !managed.has(pid));
    if (expected !== undefined && expected !== list.length) throw new Error("The list of songs to remove changed. Check it again.");
    if (!list.length) return { removed: 0 };

    let removed = 0;
    const failed = [];
    for (let index = 0; index < list.length; index += CHUNK) {
      if (signal?.aborted) break;
      const group = list.slice(index, index + CHUNK);
      progress?.({ phase: "removing", done: removed, total: list.length });
      const results = await sync.deleteEntries(getAdapter(), group.map((pid) => ({ pid, location: locations.get(pid) })), { signal });
      group.forEach((pid) => (results.get(pid)?.ok ? (removed += 1) : failed.push({ pid, error: results.get(pid)?.error })));
    }
    for (const row of rows) {
      const legacy = parseJson(row.legacy_pids, []);
      if (legacy.length) sync.saveRow(libraryId, row.track_id, { legacy_pids: JSON.stringify(legacy.filter((pid) => live.has(pid) && !list.includes(pid))) });
    }
    db.prepare("INSERT INTO apple_sync_runs (library_id, kind, started_at, finished_at, status, report) VALUES (?, 'cleanup', ?, ?, ?, ?)").run(
      libraryId,
      nowIso(),
      nowIso(),
      failed.length ? "partial" : "completed",
      JSON.stringify({ removed, failed }),
    );
    logger.log(`[apple] Cleanup removed ${removed} superseded or obsolete iTunes entries`);
    return { removed, failed };
  }

  return { analyze, apply, backup, cleanup, verify };
}

module.exports = { createAppleMigration };
