// Upgrade Track: replace a song's audio with a preferred version while the
// logical song (its identity, curated metadata, playlists) stays the same.
//
// The replacement is a chosen file, another version already in the library,
// or a fresh extraction from a URL (the main process extracts it into the
// library's staging folder with the same pipeline as Add Music). Either way
// the result is a complete new file: the final metadata and artwork chosen
// in the upgrade dialog are written into WaveMint's copy of it.
//
//   1. prepare(): the replacement is read (never modified), compared with the
//      current version, and quality-checked. Nothing else changes.
//   2. apply job (journaled, one operation):
//        copy the replacement to "<target>.wmtmp<ext>" next to its place in
//        the WaveMint Library and verify its SHA-256 → write the chosen
//        metadata and artwork into the copy and verify the tags and audio
//        stream → move the previous version out of the way (into the
//        library's archive folder if WaveMint owns it; files in other
//        folders are never touched) → rename the copy into place → one
//        database transaction activates the new version.
//      Any failure rolls the files back; the previous version stays usable.
//   3. undoUpgrade(): the previous version becomes active again and the
//      replacement copy is archived (nothing is deleted).
// Upgrading from another version already in the library without a WaveMint
// Library folder only switches the active version in the database.

const fs = require("fs");
const path = require("path");
const { nowIso, parseJson, transaction } = require("./db.cjs");
const { ARCHIVE_DIR, freeBytes, insertFileRow } = require("./consolidate.cjs");
const { FIELDS, normalizeValue, syncDerived } = require("./edits.cjs");
const { TAG_FIELDS, freePath, moveFile, sha256, siblingPath, tagDifferences } = require("./fileops.cjs");
const { compareTracks } = require("./match.cjs");
const { pathKey } = require("./normalize.cjs");
const { addStep, finishOperation, logChange, startOperation, updateStep } = require("./operations.cjs");
const { DEFAULT_PATTERN, planPaths } = require("./organize.cjs");
const { describeFile, fileSignals, refreshQuality, technicalTier } = require("./quality.cjs");
const { guessFromPath } = require("./scanner.cjs");
const { refreshTrackSearch } = require("./search.cjs");
const { retentionLabel } = require("./storage.cjs");
const { canWriteTags, isAudioFile, readArtwork, readTags, writeTags } = require("./tags.cjs");

// Fields offered in the metadata comparison (API name -> label).
const MERGE_FIELDS = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["albumArtist", "Album artist"],
  ["album", "Album"],
  ["genre", "Genre"],
  ["year", "Year"],
  ["trackNo", "Track"],
  ["trackTotal", "Tracks on album"],
  ["discNo", "Disc"],
  ["discTotal", "Discs"],
  ["composer", "Composer"],
];

const empty = (value) => value === null || value === undefined || value === "";

// Artwork for the upgraded song: the song's current artwork, the
// replacement's own (for an extraction: its square-cropped thumbnail), an
// image the user chose (stored in the art store first), or none.
const ARTWORK_CHOICES = ["current", "candidate", "custom", "none"];

// Words that suggest a replacement is a different performance or edit.
const ALTERNATE_VERSION = /\b(live|remix(?:ed)?|instrumental|acoustic|karaoke|cover|sped[ -]?up|slowed|nightcore|demo|unplugged|extended|radio edit|reprise|mashup|bootleg|8d audio|a ?cappella)\b/gi;

function alternateWords(text) {
  return new Set([...String(text || "").matchAll(ALTERNATE_VERSION)].map((match) => match[1].toLowerCase().replace(/[ -]+/g, " ")));
}

function minutes(ms) {
  const total = Math.round(Math.abs(Number(ms) || 0) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Where an extraction came from (shown in the comparison; never trusted as a path). */
function cleanSource(source) {
  if (!source || typeof source !== "object") return null;
  const text = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const url = text(source.url, 2000);
  return { title: text(source.title, 500), uploader: text(source.uploader, 300), url: /^https?:\/\//i.test(url) ? url : "" };
}

function createUpgrader({ db, media, artStore, managedSource, getSettings, logger = console }) {
  function trackRow(trackId) {
    const track = db.prepare("SELECT * FROM tracks WHERE id = ? AND state = 'active'").get(Number(trackId));
    if (!track) throw new Error("This song no longer exists.");
    return track;
  }

  function fileRow(fileId) {
    return db
      .prepare(
        `SELECT f.*, s.name AS source_name, s.role AS source_role, s.read_only, s.root_path
         FROM files f JOIN sources s ON s.id = f.source_id WHERE f.id = ?`,
      )
      .get(Number(fileId));
  }

  /** Reads a replacement file (read-only) into a comparable description. */
  async function describeReplacement(filePath) {
    const stat = fs.statSync(filePath);
    let tags = null;
    try {
      tags = readTags(filePath, { size: stat.size });
    } catch {
      tags = media?.probe ? await media.probe(filePath, { size: stat.size }) : null;
    }
    if (!tags) throw new Error("That file couldn't be read as audio.");
    const guess = guessFromPath(path.basename(filePath));
    let artworkHash = null;
    try {
      const art = readArtwork(filePath);
      if (art) artworkHash = artStore.save(art.data).hash;
    } catch {
      // Artwork is optional.
    }
    return {
      path: filePath,
      fileName: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      tags: { ...tags, title: tags.title || guess.title || "", artist: tags.artist || guess.artist || "" },
      artworkHash,
    };
  }

  /** Adds a replacement for a song: a file chosen by the user, or another version. */
  async function prepare({ trackId, filePath = null, fileId = null, kind: requestedKind = null, source = null }) {
    const track = trackRow(trackId);
    let kind = "file";
    let candidatePath = filePath;
    let versionId = null;

    if (fileId) {
      const version = fileRow(fileId);
      if (!version || version.track_id !== track.id) throw new Error("That version doesn't belong to this song.");
      if (version.id === track.active_file_id) throw new Error("That is already the song's current version.");
      if (version.status !== "ok") throw new Error("That version's file isn't available.");
      kind = "version";
      candidatePath = version.path;
      versionId = version.id;
    } else {
      candidatePath = path.resolve(String(filePath || ""));
      if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) throw new Error("That file can't be opened.");
      if (!isAudioFile(candidatePath)) throw new Error("Choose an audio file (MP3, M4A, FLAC, WAV or AIFF).");
      const known = db.prepare("SELECT id, track_id FROM files WHERE path_key = ?").get(pathKey(candidatePath));
      if (known && known.track_id === track.id) {
        if (known.id === track.active_file_id) throw new Error("That is already the song's current file.");
        kind = "version";
        versionId = known.id;
      } else if (known) {
        const other = db.prepare("SELECT title, artist FROM tracks WHERE id = ?").get(known.track_id);
        throw new Error(
          `That file is already in your library as "${other?.title || "another song"}"${other?.artist ? ` by ${other.artist}` : ""}. Merge the two songs first, then pick it from this song's versions.`,
        );
      }
    }

    if (kind === "file" && requestedKind === "extraction") kind = "extraction";
    const info = await describeReplacement(candidatePath);
    if (kind === "extraction") info.source = cleanSource(source);
    try {
      info.check = await media.qualityCheck(candidatePath, { durationMs: info.tags.durationMs, sampleRate: info.tags.sampleRate });
    } catch (error) {
      info.check = null;
      logger.warn(`[library] Couldn't check ${candidatePath}: ${error.message}`);
    }

    // One pending replacement per song and file.
    db.prepare("UPDATE upgrade_candidates SET status = 'discarded' WHERE track_id = ? AND status = 'pending' AND path = ?").run(track.id, candidatePath);
    const id = Number(
      db
        .prepare("INSERT INTO upgrade_candidates (track_id, kind, path, file_id, info, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
        .run(track.id, kind, candidatePath, versionId, JSON.stringify(info), nowIso()).lastInsertRowid,
    );
    return compare({ candidateId: id });
  }

  function candidateRow(candidateId) {
    const row = db.prepare("SELECT * FROM upgrade_candidates WHERE id = ?").get(Number(candidateId));
    if (!row) throw new Error("This replacement is no longer available.");
    return { ...row, info: parseJson(row.info, {}) };
  }

  /** Where the replacement would go, and what happens to the current file. */
  function plan(track, candidate, fields = {}) {
    const managed = managedSource();
    const current = track.active_file_id ? fileRow(track.active_file_id) : null;
    const currentManaged = !!managed && current?.source_id === managed.id;

    if (!managed) {
      if (candidate.kind === "version") return { mode: "switch", currentManaged: false };
      return { mode: "needs_library", currentManaged: false };
    }

    const final = { ...track };
    for (const [field, value] of Object.entries(fields)) final[FIELDS[field].column] = value;
    const pattern = getSettings().namingPattern || DEFAULT_PATTERN;
    const freed = currentManaged ? pathKey(current.path) : null;
    const [planned] = planPaths([{ track: final, ext: candidate.info.ext }], {
      root: managed.root_path,
      pattern,
      exists: (target) => pathKey(target) !== freed && fs.existsSync(target),
    });
    // A song replaced more than once keeps every earlier version.
    const archive = currentManaged ? freePath(path.join(managed.root_path, ARCHIVE_DIR, "upgrades", `track-${track.id}`, current.rel_path)) : null;
    return {
      mode: "copy",
      target: planned.target,
      relPath: planned.relPath,
      root: managed.root_path,
      currentManaged,
      archive,
      freeBytes: freeBytes(managed.root_path),
      // How long the archived version is kept (Storage settings).
      keptFor: retentionLabel(getSettings().keepPreviousVersions),
    };
  }

  /** Side-by-side comparison, warnings, and the metadata choices. */
  function compare({ candidateId }) {
    const candidate = candidateRow(candidateId);
    const track = trackRow(candidate.track_id);
    const current = track.active_file_id ? fileRow(track.active_file_id) : null;
    const { tags } = candidate.info;
    const settings = getSettings();

    const currentCheck = current ? db.prepare("SELECT * FROM quality_checks WHERE file_id = ?").get(current.id) : null;
    const candidateCheck = candidate.info.check
      ? {
          decode_errors: candidate.info.check.decodeErrors,
          truncated: candidate.info.check.truncated ? 1 : 0,
          peak_db: candidate.info.check.peakDb,
          peak_count: candidate.info.check.peakCount,
          sample_count: candidate.info.check.sampleCount,
          band_mid_db: candidate.info.check.bandMidDb,
          band_high_db: candidate.info.check.bandHighDb,
        }
      : null;
    const candidateFile = {
      codec: tags.codec,
      lossless: tags.lossless,
      bitrate: tags.bitrate,
      sample_rate: tags.sampleRate,
      bit_depth: tags.bitDepth,
      channels: tags.channels,
      duration_ms: tags.durationMs,
      status: "ok",
    };
    const source = candidate.info.source || null;

    const match = compareTracks(
      { title: track.title, artist: track.artist, album: track.album, duration_ms: current?.duration_ms ?? track.duration_ms, mb_recording_id: track.mb_recording_id },
      { title: tags.title, artist: tags.artist, album: tags.album, duration_ms: tags.durationMs, mb_recording_id: tags.musicBrainzRecordingId || null },
    );

    const warnings = [];
    const currentMs = current?.duration_ms ?? track.duration_ms;
    const lengthDiff = currentMs && tags.durationMs ? Math.abs(currentMs - tags.durationMs) : null;
    if (match.verdict === "different" && candidate.kind === "extraction" && lengthDiff !== null && lengthDiff <= 3000) {
      // Video titles rarely match a curated title; the length is the better clue.
      warnings.push({ level: "caution", text: "The source's title doesn't match this song, but the lengths match, so it's probably the same recording. Listen to be sure." });
    } else if (match.verdict === "different") {
      warnings.push({ level: "strong", text: `These may be different recordings: ${match.evidence.map((item) => item.text).join("; ")}. Listen to both before upgrading.` });
    } else if (match.verdict === "uncertain") {
      warnings.push({ level: "caution", text: `Possibly a different version: ${match.evidence.filter((item) => item.weight <= 0).map((item) => item.text).join("; ") || "check the length and title"}.` });
    }
    if (current && technicalTier(candidateFile) && technicalTier(candidateFile) < technicalTier(current)) {
      warnings.push({
        level: "caution",
        text: `The replacement is technically lower resolution (${describeFile(candidateFile)} vs ${describeFile(current)}). It can still sound better; listen before deciding.`,
      });
    }
    const candidateSignals = fileSignals(candidateFile, candidateCheck, { lowBitrateKbps: settings.lowBitrateKbps });
    for (const signal of candidateSignals.filter((item) => item.level >= 3)) warnings.push({ level: "strong", text: `Replacement: ${signal.text}.` });
    if (lengthDiff !== null && lengthDiff > 2000 && !match.evidence.some((item) => item.type === "duration")) {
      warnings.push({ level: "caution", text: `The lengths differ by ${minutes(lengthDiff)} (${minutes(currentMs)} now, ${minutes(tags.durationMs)} for the replacement).` });
    }
    const currentWords = alternateWords([track.title, track.album].join(" "));
    const flagged = [...alternateWords([tags.title, tags.album, source?.title].join(" "))].filter((word) => !currentWords.has(word));
    if (flagged.length) {
      warnings.push({ level: "caution", text: `The replacement may be an alternate version ("${flagged.join('", "')}" in its title). Listen before upgrading.` });
    }
    if (candidate.kind === "extraction") {
      warnings.push({
        level: "note",
        text: "Streaming audio is already compressed before WaveMint converts it to MP3, so the bitrate shown overstates its quality. Compare by listening.",
      });
    }

    const fields = MERGE_FIELDS.map(([field, label]) => {
      const def = FIELDS[field];
      const currentValue = track[def.column] ?? null;
      const candidateValue = empty(tags[field]) ? null : normalizeValue(field, tags[field]);
      return {
        field,
        label,
        current: currentValue,
        candidate: empty(candidateValue) ? null : candidateValue,
        // Curated values stay by default; the replacement only fills gaps.
        choice: empty(currentValue) && !empty(candidateValue) ? "candidate" : "current",
      };
    });

    const currentArt = track.artwork_hash || current?.artwork_hash || null;
    const defaultFields = Object.fromEntries(fields.filter((item) => item.choice === "candidate").map((item) => [item.field, item.candidate]));

    return {
      candidateId: candidate.id,
      status: candidate.status,
      kind: candidate.kind,
      trackId: track.id,
      current: current && {
        fileId: current.id,
        fileName: path.basename(current.path),
        relPath: current.rel_path,
        sourceName: current.source_name,
        sourceRole: current.source_role,
        codec: current.codec,
        lossless: current.lossless,
        bitrate: current.bitrate,
        sampleRate: current.sample_rate,
        bitDepth: current.bit_depth,
        channels: current.channels,
        durationMs: current.duration_ms,
        size: current.size,
        artworkHash: currentArt,
        title: track.title,
        artist: track.artist,
        album: track.album,
        mbRecordingId: track.mb_recording_id,
        description: describeFile(current),
        signals: fileSignals(current, currentCheck, { lowBitrateKbps: settings.lowBitrateKbps }),
      },
      candidate: {
        fileName: candidate.info.fileName,
        folder: path.dirname(candidate.path),
        sourceName: candidate.kind === "version" ? fileRow(candidate.file_id)?.source_name : candidate.kind === "extraction" ? "New extraction" : "Chosen file",
        codec: tags.codec,
        lossless: tags.lossless,
        bitrate: tags.bitrate,
        sampleRate: tags.sampleRate,
        bitDepth: tags.bitDepth,
        channels: tags.channels,
        durationMs: tags.durationMs,
        size: candidate.info.size,
        source,
        artworkHash: candidate.info.artworkHash,
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        mbRecordingId: tags.musicBrainzRecordingId || null,
        description: describeFile(candidateFile),
        signals: candidateSignals,
        checked: !!candidateCheck,
      },
      match: { verdict: match.verdict, score: match.score, evidence: match.evidence },
      warnings,
      fields,
      artwork: { current: currentArt, candidate: candidate.info.artworkHash, choice: !currentArt && candidate.info.artworkHash ? "candidate" : "current" },
      plan: plan(track, candidate, defaultFields),
    };
  }

  /** Returns the discarded replacement's kind and path (so its staged copy can go). */
  function discard({ candidateId }) {
    const row = db.prepare("SELECT kind, path, status FROM upgrade_candidates WHERE id = ?").get(Number(candidateId));
    db.prepare("UPDATE upgrade_candidates SET status = 'discarded' WHERE id = ? AND status = 'pending'").run(Number(candidateId));
    return { discarded: true, kind: row?.kind ?? null, path: row?.status === "pending" ? row.path : null };
  }

  function listCandidates({ trackId }) {
    return db
      .prepare("SELECT id, kind, path, status, created_at FROM upgrade_candidates WHERE track_id = ? AND status = 'pending' ORDER BY id DESC")
      .all(Number(trackId))
      .map((row) => ({ ...row, fileName: path.basename(row.path) }));
  }

  /**
   * The final metadata as { field: value } (only fields that change):
   * `metadata` is the edited form (the tag fields the user saw); older
   * callers pass `choices` to take fields from the replacement instead.
   */
  function finalFields(track, candidate, { metadata = null, choices = {} } = {}) {
    if (!metadata) return chosenFields(track, candidate, choices);
    const out = {};
    for (const [field, def] of TAG_FIELDS) {
      if (!Object.hasOwn(metadata, field)) continue;
      const value = normalizeValue(field, metadata[field]);
      const old = track[def.column] ?? null;
      if (value !== old && !(empty(value) && empty(old))) out[field] = value;
    }
    return out;
  }

  /** The artwork that goes into the file, and the song's artwork in the library. */
  function chosenArtwork(track, candidate, previous, artwork, customHash) {
    if (!ARTWORK_CHOICES.includes(artwork)) throw new Error("Choose the artwork for the upgraded song.");
    if (artwork === "none") return { embed: null, track: null };
    if (artwork === "candidate") {
      if (!candidate.info.artworkHash) throw new Error("The replacement has no artwork of its own.");
      return { embed: candidate.info.artworkHash, track: candidate.info.artworkHash };
    }
    if (artwork === "custom") {
      if (!/^[a-f0-9]{40}$/.test(String(customHash || "")) || !artStore.read(customHash, db)) throw new Error("Choose the artwork image again.");
      return { embed: customHash, track: customHash };
    }
    // The song's own artwork: the image chosen for it, or the current file's.
    return { embed: track.artwork_hash || previous?.artwork_hash || null, track: track.artwork_hash };
  }

  /** The chosen metadata as { field: value } (only fields that change). */
  function chosenFields(track, candidate, choices) {
    const tags = candidate.info.tags;
    const out = {};
    for (const [field] of MERGE_FIELDS) {
      if (choices?.[field] !== "candidate" || empty(tags[field])) continue;
      const value = normalizeValue(field, tags[field]);
      if (value !== (track[FIELDS[field].column] ?? null)) out[field] = value;
    }
    return out;
  }

  /**
   * Activates the replacement. `metadata` is the final, edited metadata
   * ({ field: value } for the tag fields); older callers pass `choices`
   * (field -> "candidate" to take a field from the replacement). `artwork`
   * is one of ARTWORK_CHOICES (`artworkHash` for "custom").
   * `purpose: "edit"` is used by the audio editor: the replacement is an
   * edited copy of the song's own audio, so its quality status stays.
   */
  async function applyJob({ candidateId, metadata = null, choices = {}, artwork = "current", artworkHash: customArtwork = null, purpose = "upgrade", signal, progress }) {
    const isEdit = purpose === "edit";
    const candidate = candidateRow(candidateId);
    if (candidate.status !== "pending") throw new Error("This replacement was already used or discarded.");
    const track = trackRow(candidate.track_id);
    const fields = finalFields(track, candidate, { metadata, choices });
    const target = plan(track, candidate, fields);
    if (target.mode === "needs_library") throw new Error(`Choose a folder for your WaveMint Library first; ${isEdit ? "edited songs" : "upgrades"} are saved there.`);
    if (!fs.existsSync(candidate.path)) throw new Error("The replacement file is no longer there.");
    const stat = fs.statSync(candidate.path);
    if (stat.size !== candidate.info.size || Math.round(stat.mtimeMs) !== candidate.info.mtimeMs) {
      throw new Error("The replacement file changed after it was analyzed. Choose it again.");
    }
    if (target.mode === "copy" && target.freeBytes !== null && target.freeBytes < stat.size * 1.05) {
      throw new Error("There isn't enough free space in the WaveMint Library folder.");
    }

    const previous = fileRow(track.active_file_id);
    const art = chosenArtwork(track, candidate, previous, artwork, customArtwork);
    const artworkHash = art.track;
    const operationId = startOperation(db, { kind: "upgrade", label: `${isEdit ? "Edit audio of" : "Upgrade"} "${track.title || "Untitled"}"` });
    const details = { candidateId: candidate.id, previousFileId: previous?.id ?? null, sourcePath: candidate.path, purpose };

    if (target.mode === "switch") {
      activate({ operationId, track, candidate, fields, artworkHash, newFileId: candidate.file_id, previous, moved: null, isEdit });
      return { operationId, mode: "switch" };
    }

    const staged = siblingPath(target.target, "wmtmp");
    const stepId = addStep(db, operationId, {
      action: "upgrade",
      fileId: previous?.id ?? null,
      trackId: track.id,
      targetPath: target.target,
      stagedPath: staged,
      details,
    });
    let archived = null;
    let placed = false;
    try {
      progress?.({ phase: "copying", current: track.title });
      fs.mkdirSync(path.dirname(target.target), { recursive: true });
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(candidate.path, staged, fs.constants.COPYFILE_EXCL);
      if ((await sha256(staged)) !== (await sha256(candidate.path))) throw new Error("The copy didn't match the replacement file");
      updateStep(db, stepId, { state: "copied" });
      if (signal?.aborted) throw new Error("Cancelled");

      // The final metadata goes into the copy (never into the chosen file).
      // Every tag field is written (empty ones cleared), so nothing the
      // replacement carried in its own tags overrides the final values.
      progress?.({ phase: "tagging", current: track.title });
      const final = { ...track, artwork_hash: art.embed };
      for (const [field, value] of Object.entries(fields)) final[FIELDS[field].column] = value;
      if (canWriteTags(staged)) {
        const wanted = {};
        for (const [field, def] of TAG_FIELDS) wanted[field] = final[def.column];
        let picture = null;
        if (art.embed) {
          picture = artStore.read(art.embed, db);
          if (!picture) throw new Error("The chosen artwork couldn't be read");
        }
        wanted.artwork = picture;
        const before = readTags(staged);
        if (tagDifferences(final, before).length || (before.artworkHash || null) !== art.embed) {
          const audioBefore = await media.audioStreamHash(staged);
          writeTags(staged, wanted);
          const after = readTags(staged);
          const remaining = tagDifferences({ ...final, artwork_hash: null }, after).map((change) => change.field);
          if ((after.artworkHash || null) !== art.embed) remaining.push("artwork");
          if (remaining.length) throw new Error(`Tags didn't read back correctly (${remaining.join(", ")})`);
          if ((await media.audioStreamHash(staged)) !== audioBefore) throw new Error("The audio stream changed while writing tags");
        }
      }
      updateStep(db, stepId, { state: "tagged" });
      // The last point to cancel: after this, files move.
      if (signal?.aborted) throw new Error("Cancelled");

      // The previous version leaves the library's main folders only if
      // WaveMint owns it; files in your other folders stay where they are.
      if (target.currentManaged && previous && fs.existsSync(previous.path)) {
        moveFile(previous.path, target.archive);
        archived = { from: previous.path, to: target.archive };
        updateStep(db, stepId, { state: "archived", details: { ...details, archivedFrom: archived.from, archivedTo: archived.to } });
      }

      moveFile(staged, target.target);
      placed = true;
      updateStep(db, stepId, { state: "placed" });

      const snapshot = readTags(target.target, { size: fs.statSync(target.target).size });
      const newFile = { trackId: track.id, sourceId: managedSource().id, target: target.target, relRoot: target.root, snapshot, role: "alternate" };
      activate({ operationId, track, candidate, fields, artworkHash, newFile, previous, moved: archived, stepId, details, isEdit });
      return { operationId, mode: "copy", target: target.relPath, archived: !!archived };
    } catch (error) {
      // Put everything back the way it was.
      try {
        fs.rmSync(staged, { force: true });
        if (placed && fs.existsSync(target.target)) {
          const parked = path.join(target.root, ARCHIVE_DIR, "failed", `op-${operationId}`, path.basename(target.target));
          moveFile(target.target, parked);
        }
        if (archived && fs.existsSync(archived.to) && !fs.existsSync(archived.from)) moveFile(archived.to, archived.from);
      } catch (rollbackError) {
        logger.error(`[library] Upgrade rollback problem: ${rollbackError.message}`);
      }
      updateStep(db, stepId, { state: "failed", error: error.message });
      finishOperation(db, operationId, "failed", { error: error.message });
      throw new Error(`The ${isEdit ? "edit" : "upgrade"} didn't complete; the current version is unchanged. ${error.message}`);
    }
  }

  /**
   * One transaction: the new version becomes active. `newFile` describes a
   * copy to register; `newFileId` an existing version.
   */
  function activate({ operationId, track, candidate, fields, artworkHash, newFileId = null, newFile: copy = null, previous, moved, stepId = null, details = {}, isEdit = false }) {
    transaction(db, () => {
      const now = nowIso();
      // The previous file's row moves first: the copy may take over its path.
      if (previous && moved) {
        db.prepare("UPDATE files SET path = ?, path_key = ?, rel_path = ? WHERE id = ?").run(moved.to, pathKey(moved.to), path.relative(previous.root_path, moved.to), previous.id);
        logChange(db, operationId, { entityType: "file", entityId: previous.id, field: "path", oldValue: moved.from, newValue: moved.to });
      }
      if (copy) newFileId = insertFileRow(db, copy);
      const curated = new Set(parseJson(track.curated_fields, []));
      const set = (column, value, { curate = false } = {}) => {
        const old = db.prepare(`SELECT ${column} AS value FROM tracks WHERE id = ?`).get(track.id).value;
        if ((old ?? null) === (value ?? null)) return;
        db.prepare(`UPDATE tracks SET ${column} = ? WHERE id = ?`).run(value, track.id);
        logChange(db, operationId, { entityId: track.id, field: column, oldValue: old, newValue: value });
        if (curate) curated.add(column);
      };

      for (const [field, value] of Object.entries(fields)) set(FIELDS[field].column, value, { curate: true });
      if (artworkHash !== track.artwork_hash) set("artwork_hash", artworkHash, { curate: true });

      const newFile = db.prepare("SELECT * FROM files WHERE id = ?").get(newFileId);
      set("duration_ms", newFile.duration_ms ?? track.duration_ms);
      set("active_file_id", newFileId);
      if (!isEdit) {
        set("quality_status", "upgraded");
        set("quality_set_by", "upgrade");
      }

      db.prepare("UPDATE files SET role = 'active' WHERE id = ?").run(newFileId);
      if (previous) {
        db.prepare("UPDATE files SET role = 'archived' WHERE id = ?").run(previous.id);
        logChange(db, operationId, { entityType: "file", entityId: previous.id, field: "role", oldValue: previous.role, newValue: "archived" });
      }

      const final = db.prepare("SELECT * FROM tracks WHERE id = ?").get(track.id);
      const stale = tagDifferences(final, parseJson(newFile.tag_snapshot, {})).length > 0;
      db.prepare("UPDATE tracks SET curated_fields = ?, tags_dirty = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...curated]), stale ? 1 : 0, now, track.id);
      syncDerived(db, track.id);

      db.prepare("UPDATE upgrade_candidates SET status = 'applied', operation_id = ? WHERE id = ?").run(operationId, candidate.id);
      if (stepId) updateStep(db, stepId, { state: "done", details: { ...details, newFileId, archivedFrom: moved?.from, archivedTo: moved?.to } });
      finishOperation(db, operationId, "completed", { newFileId, previousFileId: previous?.id ?? null, fields: Object.keys(fields) });
    });
    refreshTrackSearch(db, [track.id]);
  }

  /** Makes the previous version active again; the replacement copy is archived. */
  function undoUpgrade(operationId) {
    const operation = db.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'upgrade'").get(Number(operationId));
    if (!operation || operation.status !== "completed") throw new Error("This upgrade can't be undone.");
    if (db.prepare("SELECT 1 FROM operations WHERE undo_of = ? AND status = 'completed'").get(operation.id)) throw new Error("This upgrade was already undone.");
    const changes = db.prepare("SELECT * FROM change_log WHERE operation_id = ? ORDER BY id DESC").all(operation.id);
    const activeChange = changes.find((change) => change.entity_type === "track" && change.field === "active_file_id");
    if (!activeChange) throw new Error("This upgrade can't be undone.");
    const trackId = activeChange.entity_id;
    const newFileId = parseJson(activeChange.new_value);
    const oldFileId = parseJson(activeChange.old_value);
    const track = trackRow(trackId);
    if (track.active_file_id !== newFileId) throw new Error("This song's version changed after the upgrade; switch versions from the song instead.");

    const newFile = fileRow(newFileId);
    const oldFile = oldFileId ? fileRow(oldFileId) : null;
    const pathChange = changes.find((change) => change.entity_type === "file" && change.field === "path");
    const managed = managedSource();
    const moves = [];

    // Files first (each move is reversible), then one transaction.
    let undoId = null;
    try {
      undoId = startOperation(db, { kind: "upgrade", label: `Undo: ${operation.label}`, undoOf: operation.id, undoable: false });
      if (pathChange && oldFile) {
        const from = parseJson(pathChange.new_value);
        const to = parseJson(pathChange.old_value);
        if (fs.existsSync(from)) {
          // The replacement copy may sit at the old path (same name); park it first.
          if (managed && newFile.source_id === managed.id && pathKey(newFile.path) === pathKey(to) && fs.existsSync(newFile.path)) {
            const parked = path.join(managed.root_path, ARCHIVE_DIR, "upgrades", `track-${trackId}`, `undone-${operation.id}`, newFile.rel_path);
            moveFile(newFile.path, parked);
            moves.push({ fileId: newFile.id, from: newFile.path, to: parked, root: managed.root_path });
          }
          moveFile(from, to);
          moves.push({ fileId: oldFile.id, from, to, root: oldFile.root_path });
        }
      }
      if (managed && newFile.source_id === managed.id && !moves.some((move) => move.fileId === newFile.id) && fs.existsSync(newFile.path)) {
        const parked = path.join(managed.root_path, ARCHIVE_DIR, "upgrades", `track-${trackId}`, `undone-${operation.id}`, newFile.rel_path);
        moveFile(newFile.path, parked);
        moves.push({ fileId: newFile.id, from: newFile.path, to: parked, root: managed.root_path });
      }
    } catch (error) {
      for (const move of moves.reverse()) {
        try {
          moveFile(move.to, move.from);
        } catch {
          // Reported below.
        }
      }
      if (undoId) finishOperation(db, undoId, "failed", { error: error.message });
      throw new Error(`The upgrade couldn't be undone: ${error.message}`);
    }

    transaction(db, () => {
      for (const move of moves) {
        db.prepare("UPDATE files SET path = ?, path_key = ?, rel_path = ? WHERE id = ?").run(move.to, pathKey(move.to), path.relative(move.root, move.to), move.fileId);
        logChange(db, undoId, { entityType: "file", entityId: move.fileId, field: "path", oldValue: move.from, newValue: move.to });
      }
      for (const change of changes.filter((item) => item.entity_type === "track")) {
        if (!/^[a-z_]+$/.test(change.field)) continue;
        db.prepare(`UPDATE tracks SET ${change.field} = ? WHERE id = ?`).run(parseJson(change.old_value), trackId);
        logChange(db, undoId, { entityId: trackId, field: change.field, oldValue: parseJson(change.new_value), newValue: parseJson(change.old_value) });
      }
      if (oldFile) db.prepare("UPDATE files SET role = 'active' WHERE id = ?").run(oldFile.id);
      db.prepare("UPDATE files SET role = 'archived' WHERE id = ?").run(newFile.id);
      if (newFile.source_id !== managed?.id) db.prepare("UPDATE files SET role = 'alternate' WHERE id = ?").run(newFile.id);
      const restored = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
      const active = oldFile ? db.prepare("SELECT tag_snapshot FROM files WHERE id = ?").get(oldFile.id) : null;
      db.prepare("UPDATE tracks SET tags_dirty = ?, updated_at = ? WHERE id = ?").run(
        active && tagDifferences(restored, parseJson(active.tag_snapshot, {})).length ? 1 : 0,
        nowIso(),
        trackId,
      );
      syncDerived(db, trackId);
      db.prepare("UPDATE upgrade_candidates SET status = 'pending', operation_id = NULL WHERE operation_id = ?").run(operation.id);
      finishOperation(db, undoId, "completed", { trackId });
    });
    refreshTrackSearch(db, [trackId]);
    refreshQuality(db, { trackIds: [trackId], lowBitrateKbps: getSettings().lowBitrateKbps });
    return { operationId: undoId, tracks: 1 };
  }

  /** Puts files back after an upgrade interrupted by a crash. */
  function recover() {
    const report = [];
    for (const operation of db.prepare("SELECT * FROM operations WHERE kind = 'upgrade' AND status = 'running'").all()) {
      for (const step of db.prepare("SELECT * FROM operation_steps WHERE operation_id = ? AND state NOT IN ('done', 'failed', 'rolled_back')").all(operation.id)) {
        const details = parseJson(step.details, {});
        try {
          if (step.staged_path) fs.rmSync(step.staged_path, { force: true });
          const managed = managedSource();
          if ((step.state === "placed" || step.state === "archived") && step.target_path && fs.existsSync(step.target_path) && managed) {
            // Our copy of the replacement; parked, not deleted.
            const known = db.prepare("SELECT 1 FROM files WHERE path_key = ?").get(pathKey(step.target_path));
            if (!known) moveFile(step.target_path, path.join(managed.root_path, ARCHIVE_DIR, "failed", `op-${operation.id}`, path.basename(step.target_path)));
          }
          if (details.archivedTo && fs.existsSync(details.archivedTo) && !fs.existsSync(details.archivedFrom)) moveFile(details.archivedTo, details.archivedFrom);
          updateStep(db, step.id, { state: "rolled_back" });
          report.push({ operationId: operation.id, trackId: step.track_id, outcome: "rolled_back" });
        } catch (error) {
          updateStep(db, step.id, { state: "failed", error: `Recovery: ${error.message}` });
          report.push({ operationId: operation.id, trackId: step.track_id, outcome: "failed" });
        }
      }
      finishOperation(db, operation.id, "interrupted", {});
      logger.warn(`[library] Rolled back interrupted upgrade ${operation.id}`);
    }
    return report;
  }

  function resolveCandidateFile({ candidateId }) {
    const row = db.prepare("SELECT id, path FROM upgrade_candidates WHERE id = ? AND status = 'pending'").get(Number(candidateId));
    return row && fs.existsSync(row.path) ? row : null;
  }

  return { applyJob, compare, discard, listCandidates, prepare, recover, resolveCandidateFile, undoUpgrade };
}

module.exports = { ARTWORK_CHOICES, MERGE_FIELDS, createUpgrader };
