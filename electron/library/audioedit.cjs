// Audio editing (trim and fade) and adding fresh extractions to the library.
//
// Editing a library song:
//   the active file is rendered (trimmed/faded) into a private staging
//   folder, then handed to Upgrade Track as the song's new version: it is
//   copied into the WaveMint Library and verified, the song's tags and
//   artwork are written into the copy, a previous version WaveMint owns is
//   archived (files in your other folders are never touched), and one
//   transaction makes it the active version. The song keeps its id, so its
//   metadata, playlists and history stay. Undo from History restores the
//   previous version.
//
// Adding an extraction:
//   the main process saves the finished, tagged MP3 in a staging folder
//   identified by a random token (prepareExtraction). commitExtraction()
//   optionally renders the edits, copies the file into the WaveMint Library
//   (verified), and registers one new song in a journaled "import"
//   operation (undoable like any import). Nothing reaches the library until
//   that point; a failed or abandoned extraction leaves no song behind.
//
// Rendering: a plain trim of an MP3/AAC file is a stream copy (no
// re-encoding; cut on frame boundaries, about 26 ms). Fades need decoding,
// so they re-encode: MP3 at a standard bitrate at or above the original's,
// AAC likewise, lossless formats losslessly. Tags and artwork are copied
// from the original with taglib.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { nowIso, transaction } = require("./db.cjs");
const { freeBytes, insertFileRow, sha256 } = require("./consolidate.cjs");
const { siblingPath } = require("./fileops.cjs");
const { artistKey, titleKey } = require("./normalize.cjs");
const { addStep, finishOperation, logChange, startOperation, updateStep } = require("./operations.cjs");
const { DEFAULT_PATTERN, planPaths } = require("./organize.cjs");
const { releaseFor } = require("./scanner.cjs");
const { refreshTrackSearch } = require("./search.cjs");
const { retentionLabel } = require("./storage.cjs");
const { EDITABLE_FIELDS, canWriteTags, isAudioFile, readArtwork, readTags, writeTags } = require("./tags.cjs");

const MIN_LENGTH_MS = 1000;
// Within this distance of the file's edge counts as "not trimmed" (decoders
// and tag readers disagree on a song's exact length by a few milliseconds).
const EDGE_TOLERANCE_MS = 60;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const MP3_BITRATES = [128, 160, 192, 224, 256, 320];
const EDITABLE_EXTENSIONS = new Set([".mp3", ".m4a", ".m4b", ".mp4", ".aac", ".flac", ".wav", ".aif", ".aiff"]);

function noLibraryError() {
  const error = new Error("Choose a folder for your WaveMint Library first. Added and edited songs are saved there.");
  error.code = "no-library";
  return error;
}

/**
 * Validates edits against the song's length. Returns { startMs, endMs,
 * fadeInMs, fadeOutMs, changed } with fades measured inside the trimmed
 * region (fade-in from its start, fade-out up to its end).
 */
function normalizeEdits(edits = {}, durationMs) {
  const total = Math.round(Number(durationMs) || 0);
  if (total <= 0) throw new Error("This song's length is unknown, so it can't be edited.");
  const ms = (value, fallback) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback);
  let startMs = Math.min(total, Math.max(0, ms(edits.startMs, 0)));
  let endMs = Math.min(total, Math.max(0, ms(edits.endMs, total)));
  if (startMs <= EDGE_TOLERANCE_MS) startMs = 0;
  if (endMs >= total - EDGE_TOLERANCE_MS) endMs = total;
  if (endMs - startMs < MIN_LENGTH_MS) throw new Error("Keep at least one second of audio.");
  const fadeInMs = Math.max(0, ms(edits.fadeInMs, 0));
  const fadeOutMs = Math.max(0, ms(edits.fadeOutMs, 0));
  if (fadeInMs + fadeOutMs > endMs - startMs) {
    throw new Error("The fades are longer than the trimmed song. Shorten the fades or keep more of the song.");
  }
  const changed = startMs > 0 || endMs < total || fadeInMs > 0 || fadeOutMs > 0;
  return { startMs, endMs, fadeInMs, fadeOutMs, changed };
}

/** The smallest standard MP3 bitrate at or above the original's. */
function mp3Bitrate(kbps) {
  const value = Number(kbps) || 0;
  if (!value) return 256;
  return MP3_BITRATES.find((rate) => rate >= value - 4) || 320;
}

/** How a file is re-encoded when it has to be: { lossless, codecArgs }. */
function encodingFor(filePath, info = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const deep = Number(info.bitDepth) > 16;
  if (ext === ".mp3") return { lossless: false, codecArgs: ["-c:a", "libmp3lame", "-b:a", `${mp3Bitrate(info.bitrate)}k`] };
  if ([".m4a", ".m4b", ".mp4"].includes(ext) && info.codec === "alac") return { lossless: true, codecArgs: ["-c:a", "alac"] };
  if ([".m4a", ".m4b", ".mp4", ".aac"].includes(ext)) {
    const kbps = Math.min(320, Math.max(192, Math.round(Number(info.bitrate) || 256)));
    return { lossless: false, codecArgs: ["-c:a", "aac", "-b:a", `${kbps}k`] };
  }
  if (ext === ".flac") return { lossless: true, codecArgs: ["-c:a", "flac", "-sample_fmt", deep ? "s32" : "s16"] };
  if (ext === ".wav") return { lossless: true, codecArgs: ["-c:a", deep ? "pcm_s24le" : "pcm_s16le"] };
  if (ext === ".aif" || ext === ".aiff") return { lossless: true, codecArgs: ["-c:a", deep ? "pcm_s24be" : "pcm_s16be"] };
  throw new Error(`WaveMint can't edit ${ext.toUpperCase().slice(1) || "these"} files.`);
}

function moveFile(from, to) {
  if (fs.existsSync(to)) throw new Error(`"${path.basename(to)}" already exists; nothing was overwritten`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function createAudioEditor({ db, media, artStore, upgrader, importer, managedSource, getSettings = () => ({}), paths, logger = console }) {
  const staging = (name) => {
    if (!paths?.stagingDir) throw new Error("The library's staging folder isn't available.");
    return path.join(paths.stagingDir, name);
  };
  const committing = new Set();

  /** Staged extractions and renders only live for one app session. */
  function cleanup() {
    if (!paths?.stagingDir) return;
    // Upgrade replacements extracted from a URL live in the same folder.
    db.prepare("UPDATE upgrade_candidates SET status = 'discarded' WHERE status = 'pending' AND kind = 'extraction' AND path LIKE ?").run(
      `${staging("extractions")}${path.sep}%`,
    );
    for (const folder of [staging("extractions"), staging("edits")]) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`[library] Couldn't clean up ${folder}: ${error.message}`);
      }
    }
  }

  function activeFile(trackId) {
    const row = db
      .prepare(
        `SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.artwork_hash, f.id AS file_id, f.path, f.ext, f.status,
                f.duration_ms AS file_duration_ms, f.artwork_hash AS file_artwork_hash, f.codec, f.lossless, f.bitrate,
                f.source_id, s.name AS source_name, s.read_only
         FROM tracks t JOIN files f ON f.id = t.active_file_id JOIN sources s ON s.id = f.source_id
         WHERE t.id = ? AND t.state = 'active'`,
      )
      .get(Number(trackId));
    if (!row) throw new Error("This song no longer exists.");
    if (row.status !== "ok" || !fs.existsSync(row.path)) throw new Error("This song's file isn't available right now.");
    return row;
  }

  function stagedFile(token) {
    if (!TOKEN_PATTERN.test(String(token || ""))) throw new Error("This extraction is no longer available.");
    const folder = path.join(staging("extractions"), token);
    const name = fs.existsSync(folder) ? fs.readdirSync(folder).find((entry) => isAudioFile(entry) && !entry.includes(".wmtmp")) : null;
    if (!name) throw new Error("This extraction is no longer available. Extract the song again.");
    return { folder, path: path.join(folder, name) };
  }

  /** Renders the edits of `sourcePath` into `folder`; tags and artwork carried over. */
  async function render(sourcePath, edits, folder, { signal } = {}) {
    const info = readTags(sourcePath, { size: fs.statSync(sourcePath).size });
    const encoding = encodingFor(sourcePath, info);
    fs.mkdirSync(folder, { recursive: true });
    const output = path.join(folder, path.basename(sourcePath));
    const copy = !encoding.lossless && !edits.fadeInMs && !edits.fadeOutMs;
    await media.renderEdit(sourcePath, output, { ...edits, copy, codecArgs: encoding.codecArgs }, { signal });

    if (canWriteTags(output)) {
      const fields = Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, info[field]]));
      const art = readArtwork(sourcePath);
      if (art) fields.artwork = art;
      writeTags(output, fields);
    }

    const result = readTags(output, { size: fs.statSync(output).size });
    const expected = edits.endMs - edits.startMs;
    if (!result.durationMs || Math.abs(result.durationMs - expected) > Math.max(1500, expected * 0.02)) {
      throw new Error("The edited audio didn't come out the expected length; nothing was changed.");
    }
    return { path: output, durationMs: result.durationMs, reencoded: !copy };
  }

  // --- the editor -----------------------------------------------------------

  /** What the editor needs to know about a library song. */
  function editSource({ trackId }) {
    const row = activeFile(trackId);
    const managed = managedSource();
    let editable = EDITABLE_EXTENSIONS.has(row.ext);
    if (row.ext === ".m4a" || row.ext === ".mp4" || row.ext === ".m4b") editable = editable && ["aac", "alac"].includes(row.codec);
    return {
      trackId: row.id,
      fileId: row.file_id,
      title: row.title,
      artist: row.artist,
      album: row.album,
      artworkHash: row.artwork_hash || row.file_artwork_hash || null,
      durationMs: row.file_duration_ms ?? row.duration_ms,
      sourceName: row.source_name,
      inLibraryFolder: !!managed && row.source_id === managed.id,
      hasLibraryFolder: !!managed,
      editable,
      lossy: row.lossless === 0,
      // How long the replaced version is kept for undo (Storage settings).
      keptFor: retentionLabel(getSettings().keepPreviousVersions),
    };
  }

  /** The whole song's peaks, or a closer look at startMs–endMs (zooming in). */
  async function waveform({ trackId, token, startMs, endMs, points }) {
    const filePath = trackId ? activeFile(trackId).path : stagedFile(token).path;
    return media.waveform(filePath, { startMs, endMs, points: Math.min(6000, points || 1600) });
  }

  /** Job: saves the edits as the song's new active version. */
  async function editTrackJob({ trackId, edits, signal, progress }) {
    const row = activeFile(trackId);
    if (!managedSource()) throw noLibraryError();
    const normalized = normalizeEdits(edits, row.file_duration_ms ?? row.duration_ms);
    if (!normalized.changed) throw new Error("There are no changes to save.");

    const folder = path.join(staging("edits"), crypto.randomBytes(16).toString("hex"));
    let candidateId = null;
    try {
      progress?.({ phase: "rendering", current: row.title });
      const rendered = await render(row.path, normalized, folder, { signal });
      if (signal?.aborted) throw new Error("Cancelled");
      progress?.({ phase: "saving", current: row.title });
      const prepared = await upgrader.prepare({ trackId: row.id, filePath: rendered.path });
      candidateId = prepared.candidateId;
      const result = await upgrader.applyJob({ candidateId, choices: {}, artwork: "current", purpose: "edit", signal, progress });
      candidateId = null;
      return { ...result, trackId: row.id, durationMs: rendered.durationMs, reencoded: rendered.reencoded };
    } finally {
      if (candidateId) upgrader.discard({ candidateId });
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  // --- extractions ------------------------------------------------------------

  /** Host only: a private folder for one extraction (the library must exist). */
  function prepareExtraction() {
    if (!managedSource()) throw noLibraryError();
    const token = crypto.randomBytes(16).toString("hex");
    const folder = path.join(staging("extractions"), token);
    fs.mkdirSync(folder, { recursive: true });
    return { token, folder };
  }

  function extractionInfo({ token }) {
    const staged = stagedFile(token);
    const tags = readTags(staged.path, { size: fs.statSync(staged.path).size });
    let artworkHash = null;
    try {
      const art = readArtwork(staged.path);
      if (art) artworkHash = artStore.save(art.data).hash;
    } catch {
      // Artwork is optional.
    }
    return {
      token,
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      genre: tags.genre,
      durationMs: tags.durationMs,
      artworkHash,
      lossy: tags.lossless === 0,
      hasLibraryFolder: !!managedSource(),
    };
  }

  /** Host only: the staged file, for previews. */
  function resolveExtraction({ token }) {
    try {
      return { path: stagedFile(token).path };
    } catch {
      return null;
    }
  }

  /**
   * Removes the staging folder holding `filePath` if it's one of ours (an
   * extraction used as an upgrade replacement); anything else is left alone.
   * Never throws: on Windows a file that is still open (e.g. by a preview
   * that's still streaming it) stays "delete pending" and its folder can't be
   * removed yet, so removal is retried a few times later. Whatever is left is
   * cleared at the next start (cleanup()).
   */
  function releaseStagedPath(filePath, { retryDelaysMs = [2000, 10000, 60000] } = {}) {
    if (!paths?.stagingDir || !filePath) return false;
    const relative = path.relative(staging("extractions"), path.resolve(filePath));
    const [token, ...rest] = relative.split(path.sep);
    if (!TOKEN_PATTERN.test(token || "") || rest.length !== 1 || committing.has(token)) return false;
    const folder = path.join(staging("extractions"), token);
    const attempt = (remaining) => {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch (error) {
        if (!remaining.length) {
          logger.warn(`[library] Couldn't remove ${folder} yet (${error.code || error.message}); it's cleared at the next start.`);
          return;
        }
        setTimeout(() => attempt(remaining.slice(1)), remaining[0]).unref?.();
      }
    };
    attempt(retryDelaysMs);
    return true;
  }

  function discardExtraction({ token }) {
    if (!TOKEN_PATTERN.test(String(token || ""))) return { discarded: false };
    if (committing.has(token)) throw new Error("This song is being added to the library right now.");
    fs.rmSync(path.join(staging("extractions"), token), { recursive: true, force: true });
    return { discarded: true };
  }

  /** Copies a finished file into the WaveMint Library as one new song. */
  async function addToLibrary(filePath) {
    const managed = managedSource();
    if (!managed) throw noLibraryError();
    const size = fs.statSync(filePath).size;
    const free = freeBytes(managed.root_path);
    if (free !== null && free < size * 1.05) throw new Error("There isn't enough free space in the WaveMint Library folder.");

    const tags = readTags(filePath, { size });
    const ext = path.extname(filePath).toLowerCase();
    const values = {
      title: tags.title || path.basename(filePath, ext),
      artist: tags.artist || "",
      album_artist: tags.albumArtist || "",
      album: tags.album || "",
      genre: tags.genre || "",
      year: tags.year ?? null,
      track_no: tags.trackNo ?? null,
      track_total: tags.trackTotal ?? null,
      disc_no: null,
    };
    const pattern = getSettings().namingPattern || DEFAULT_PATTERN;
    const [planned] = planPaths([{ track: values, ext }], { root: managed.root_path, pattern, exists: (target) => fs.existsSync(target) });
    const staged = siblingPath(planned.target, "wmtmp");
    const operationId = startOperation(db, { kind: "import", label: `Add "${values.title}"` });
    const stepId = addStep(db, operationId, { action: "import", targetPath: planned.target, stagedPath: staged, details: { source: "extraction" } });
    let placed = false;

    try {
      fs.mkdirSync(path.dirname(planned.target), { recursive: true });
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(filePath, staged, fs.constants.COPYFILE_EXCL);
      if ((await sha256(staged)) !== (await sha256(filePath))) throw new Error("The copy didn't match the extracted file");
      moveFile(staged, planned.target);
      placed = true;
      updateStep(db, stepId, { state: "placed" });

      const snapshot = readTags(planned.target, { size: fs.statSync(planned.target).size });
      const trackId = transaction(db, () => {
        const now = nowIso();
        const releaseId = releaseFor(db, { album: values.album, albumArtist: values.album_artist, artist: values.artist, compilation: 0, year: values.year });
        const id = Number(
          db
            .prepare(
              `INSERT INTO tracks (title, artist, album_artist, album, release_id, track_no, track_total, disc_no, disc_total, year, genre,
                 composer, comment, compilation, duration_ms, artwork_hash, title_key, artist_key, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, '', '', 0, ?, NULL, ?, ?, ?, ?)`,
            )
            .run(
              values.title,
              values.artist,
              values.album_artist,
              values.album,
              releaseId,
              values.track_no,
              values.track_total,
              values.year,
              values.genre,
              snapshot.durationMs ?? null,
              titleKey(values.title),
              artistKey(values.artist),
              now,
              now,
            ).lastInsertRowid,
        );
        const fileId = insertFileRow(db, { trackId: id, sourceId: managed.id, target: planned.target, relRoot: managed.root_path, snapshot });
        db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(fileId, id);
        logChange(db, operationId, { entityId: id, field: "created", oldValue: null, newValue: fileId });
        updateStep(db, stepId, { state: "done", details: { source: "extraction", trackId: id, fileId } });
        finishOperation(db, operationId, "completed", { added: 1 });
        return id;
      });
      refreshTrackSearch(db, [trackId]);
      return { trackId, relPath: planned.relPath, durationMs: snapshot.durationMs ?? null, values };
    } catch (error) {
      try {
        fs.rmSync(staged, { force: true });
        // Only WaveMint's own copy is removed; the extraction stays in staging.
        if (placed) fs.rmSync(planned.target, { force: true });
      } catch (cleanupError) {
        logger.error(`[library] Couldn't clean up a failed add: ${cleanupError.message}`);
      }
      updateStep(db, stepId, { state: "failed", error: error.message });
      finishOperation(db, operationId, "failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Adds a staged extraction to the library, after rendering `edits` if
   * given. The staging folder is removed once the song is in the library.
   */
  async function commitExtraction({ token, edits = null }) {
    const staged = stagedFile(token);
    if (committing.has(token)) throw new Error("This song is already being added to the library.");
    committing.add(token);
    try {
      let filePath = staged.path;
      let reencoded = false;
      if (edits) {
        const durationMs = readTags(staged.path, { size: fs.statSync(staged.path).size }).durationMs;
        const normalized = normalizeEdits(edits, durationMs);
        if (normalized.changed) {
          const rendered = await render(staged.path, normalized, path.join(staged.folder, "edited"));
          filePath = rendered.path;
          reencoded = rendered.reencoded;
        }
      }
      const added = await addToLibrary(filePath);
      fs.rmSync(staged.folder, { recursive: true, force: true });
      return {
        trackId: added.trackId,
        title: added.values.title,
        artist: added.values.artist,
        album: added.values.album,
        durationMs: added.durationMs,
        relPath: added.relPath,
        edited: filePath !== staged.path,
        reencoded,
      };
    } finally {
      committing.delete(token);
    }
  }

  /** Library matches for songs about to be added: { [key]: match }. */
  function checkMatches({ entries = [] }) {
    return Object.fromEntries(entries.map((entry) => [entry.key, importer.matchInLibrary(entry)]));
  }

  return {
    checkMatches,
    cleanup,
    commitExtraction,
    discardExtraction,
    editSource,
    editTrackJob,
    extractionInfo,
    prepareExtraction,
    releaseStagedPath,
    resolveExtraction,
    waveform,
  };
}

module.exports = { MIN_LENGTH_MS, createAudioEditor, encodingFor, mp3Bitrate, normalizeEdits };
