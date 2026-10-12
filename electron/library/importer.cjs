// Smart playlist import: a YouTube playlist (often a whole album) imported
// into the WaveMint Library instead of a plain folder.
//
//   1. startSession(): every entry is matched against the library before
//      anything is downloaded (New / Possibly in library / In library) and
//      gets a suggested action. Nothing is claimed about audio quality yet.
//   2. Extraction (main process) saves each finished MP3 in the session's
//      private staging folder and hands it over with addStaged(): the file
//      is checked (decoding, real tags), compared with the library, and an
//      upgrade candidate is prepared where the song already exists.
//   3. commitJob(): approved new songs are copied into the WaveMint Library
//      (verified copy, album-level metadata written in, then registered);
//      approved upgrades go through Upgrade Track; the rest is left alone.
//      One "import" operation; Undo Import removes the added songs from the
//      library and archives their files. The staging folder is removed.

const fs = require("fs");
const path = require("path");
const { nowIso, parseJson, transaction } = require("./db.cjs");
const { ARCHIVE_DIR, freeBytes, insertFileRow, sha256 } = require("./consolidate.cjs");
const { siblingPath } = require("./fileops.cjs");
const { scoreMatch } = require("./identify.cjs");
const { artistKey, normalizeKey, parseAlbum, pathKey, titleKey } = require("./normalize.cjs");
const { addStep, finishOperation, logChange, startOperation, updateStep } = require("./operations.cjs");
const { DEFAULT_PATTERN, planPaths } = require("./organize.cjs");
const { describeFile, fileSignals } = require("./quality.cjs");
const { releaseFor } = require("./scanner.cjs");
const { refreshTrackSearch } = require("./search.cjs");
const { canWriteTags, readArtwork, readTags, writeTags } = require("./tags.cjs");

const ACTIONS = ["add", "compare", "keep_existing", "keep_both", "skip"];
const DECISIONS = ["add", "upgrade", "keep_existing", "keep_both", "skip"];
const NEEDS_DOWNLOAD = new Set(["add", "compare", "keep_both"]);

function moveFile(from, to) {
  if (fs.existsSync(to)) throw new Error(`"${path.basename(to)}" already exists; nothing was overwritten`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function createImporter({ db, media, artStore, upgrader, managedSource, getSettings = () => ({}), paths, logger = console }) {
  function stagingFolder(sessionId) {
    if (!paths?.stagingDir) throw new Error("The library's staging folder isn't available.");
    return path.join(paths.stagingDir, "imports", `session-${Number(sessionId)}`);
  }

  function session(sessionId, { open = false } = {}) {
    const row = db.prepare("SELECT * FROM import_sessions WHERE id = ?").get(Number(sessionId));
    if (!row) throw new Error("This import no longer exists.");
    if (open && row.status !== "open") throw new Error("This import was already finished.");
    return row;
  }

  /** The best library match for a song: { status, trackId, … } with honest wording. */
  function matchInLibrary({ title, artist, durationMs }, { excludeTrackIds = [] } = {}) {
    const tKey = titleKey(title);
    const aKey = artistKey(artist);
    if (!tKey) return { status: "new" };
    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.artist, t.album, COALESCE(t.duration_ms, f.duration_ms) AS duration_ms,
                f.codec, f.lossless, f.bitrate, f.sample_rate, f.bit_depth
         FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id
         WHERE t.state = 'active' AND (t.title_key = ? ${aKey ? "OR t.artist_key = ?" : ""}) LIMIT 400`,
      )
      .all(...(aKey ? [tKey, aKey] : [tKey]))
      .filter((row) => !excludeTrackIds.includes(row.id));
    const best = rows
      .map((row) => ({ row, match: scoreMatch({ title, artist, durationMs }, { title: row.title, artist: row.artist, lengthMs: row.duration_ms }) }))
      .sort((a, b) => b.match.score - a.match.score)[0];
    if (!best || best.match.score < 0.6) return { status: "new" };
    return {
      status: best.match.score >= 0.85 ? "existing" : "possible",
      trackId: best.row.id,
      title: best.row.title,
      artist: best.row.artist,
      album: best.row.album,
      quality: best.row.codec ? describeFile(best.row) : null,
      score: best.match.score,
      notes: best.match.notes,
    };
  }

  function itemView(row) {
    return {
      id: row.id,
      entryKey: row.entry_key,
      position: row.position,
      entry: parseJson(row.entry, {}),
      match: parseJson(row.match, { status: "new" }),
      action: row.action,
      status: row.status,
      staged: parseJson(row.staged_info, null),
      candidateId: row.candidate_id,
      resultTrackId: row.result_track_id,
      outcome: row.outcome,
      error: row.error,
    };
  }

  function view(sessionId) {
    const row = session(sessionId);
    const items = db.prepare("SELECT * FROM import_items WHERE session_id = ? ORDER BY position").all(row.id).map(itemView);
    return {
      id: row.id,
      status: row.status,
      title: row.title,
      albumFields: parseJson(row.album_fields, {}),
      report: parseJson(row.report, null),
      operationId: row.operation_id,
      hasLibraryFolder: !!managedSource(),
      items,
    };
  }

  /** Matches the playlist's entries against the library (nothing is downloaded). */
  function startSession({ title = "", url = "", entries }) {
    const id = transaction(db, () => {
      const sessionId = Number(
        db.prepare("INSERT INTO import_sessions (status, title, source_url, album_fields, created_at) VALUES ('open', ?, ?, ?, ?)").run(
          String(title || "").slice(0, 300),
          String(url || "").slice(0, 2000),
          JSON.stringify({}),
          nowIso(),
        ).lastInsertRowid,
      );
      const insert = db.prepare("INSERT INTO import_items (session_id, entry_key, position, entry, match, action) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [index, entry] of entries.entries()) {
        const clean = {
          title: String(entry.title || "").trim(),
          artist: String(entry.artist || "").trim(),
          album: String(entry.album || "").trim(),
          genre: String(entry.genre || "").trim(),
          durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
        };
        const match = matchInLibrary(clean);
        const action = match.status === "new" ? "add" : "compare";
        insert.run(sessionId, String(entry.key), index + 1, JSON.stringify(clean), JSON.stringify(match), action);
      }
      return sessionId;
    });
    return view(id);
  }

  /** Updates entry metadata (before extraction), actions and album fields. */
  function updateSession({ sessionId, albumFields, actions = [], entries = [] }) {
    const row = session(sessionId, { open: true });
    transaction(db, () => {
      if (albumFields) db.prepare("UPDATE import_sessions SET album_fields = ? WHERE id = ?").run(JSON.stringify(albumFields), row.id);
      for (const item of actions) {
        if (!ACTIONS.includes(item.action)) throw new Error("Unknown import action");
        db.prepare("UPDATE import_items SET action = ? WHERE id = ? AND session_id = ? AND status IN ('pending', 'staged', 'failed')").run(item.action, item.itemId, row.id);
      }
      // Rematch songs whose details changed in the Extract view.
      for (const entry of entries) {
        const item = db.prepare("SELECT * FROM import_items WHERE session_id = ? AND entry_key = ?").get(row.id, String(entry.key));
        if (!item || item.status !== "pending") continue;
        const clean = { ...parseJson(item.entry, {}), title: String(entry.title || "").trim(), artist: String(entry.artist || "").trim(), album: String(entry.album || "").trim(), genre: String(entry.genre || "").trim() };
        const match = matchInLibrary(clean);
        const previous = parseJson(item.match, {});
        const action = previous.status === match.status ? item.action : match.status === "new" ? "add" : "compare";
        db.prepare("UPDATE import_items SET entry = ?, match = ?, action = ? WHERE id = ?").run(JSON.stringify(clean), JSON.stringify(match), action, item.id);
      }
    });
    return view(row.id);
  }

  /** Host only: where the main process saves the extraction for an entry. */
  function prepareStaging({ sessionId, entryKey }) {
    const row = session(sessionId, { open: true });
    const item = db.prepare("SELECT * FROM import_items WHERE session_id = ? AND entry_key = ?").get(row.id, String(entryKey));
    if (!item) throw new Error("This song isn't part of the import.");
    if (!NEEDS_DOWNLOAD.has(item.action)) throw new Error("This song isn't set to be imported.");
    const folder = path.join(stagingFolder(row.id), `item-${item.id}`);
    fs.mkdirSync(folder, { recursive: true });
    return { folder };
  }

  /** Host only: a finished extraction arrived in staging; check and compare it. */
  async function addStaged({ sessionId, entryKey, filePath }) {
    const row = session(sessionId, { open: true });
    const item = db.prepare("SELECT * FROM import_items WHERE session_id = ? AND entry_key = ?").get(row.id, String(entryKey));
    if (!item) throw new Error("This song isn't part of the import.");
    const expected = pathKey(path.join(stagingFolder(row.id), `item-${item.id}`));
    if (!pathKey(path.resolve(filePath)).startsWith(`${expected}\\`)) throw new Error("The extracted file isn't in the import's staging folder.");

    try {
      const stat = fs.statSync(filePath);
      const tags = readTags(filePath, { size: stat.size });
      const check = await media.qualityCheck(filePath, { durationMs: tags.durationMs, sampleRate: tags.sampleRate });
      const file = { codec: tags.codec, lossless: tags.lossless, bitrate: tags.bitrate, sample_rate: tags.sampleRate, bit_depth: tags.bitDepth, duration_ms: tags.durationMs, status: "ok" };
      const signals = fileSignals(
        file,
        { decode_errors: check.decodeErrors, truncated: check.truncated ? 1 : 0, peak_db: check.peakDb, peak_count: check.peakCount, sample_count: check.sampleCount, band_mid_db: check.bandMidDb, band_high_db: check.bandHighDb },
        { lowBitrateKbps: getSettings().lowBitrateKbps },
      );
      const intact = !check.failed && check.decodeErrors === 0 && !check.truncated;
      const prior = parseJson(item.match, {});

      // Compare against the library now that the real file exists.
      const after = matchInLibrary({ title: tags.title, artist: tags.artist, durationMs: tags.durationMs });
      let candidateId = null;
      let comparison = null;
      const target = prior.trackId || (after.status !== "new" ? after.trackId : null);
      if (intact && target && (item.action === "compare" || after.status === "existing")) {
        const compared = await upgrader.prepare({ trackId: target, filePath, kind: "extraction" });
        candidateId = compared.candidateId;
        comparison = {
          trackId: target,
          verdict: compared.match.verdict,
          evidence: compared.match.evidence.map((note) => note.text),
          current: compared.current?.description || null,
          candidate: compared.candidate.description,
          warnings: compared.warnings.map((warning) => warning.text),
        };
      }

      const info = {
        fileName: path.basename(filePath),
        size: stat.size,
        title: tags.title,
        artist: tags.artist,
        album: tags.album,
        durationMs: tags.durationMs,
        description: describeFile(file),
        artworkHash: tags.artworkHash || null,
        intact,
        decodeProblems: check.decodeSample || [],
        signals,
        libraryMatch: after,
        comparison,
      };
      db.prepare("UPDATE import_items SET status = ?, staged_path = ?, staged_info = ?, candidate_id = ?, error = ? WHERE id = ?").run(
        intact ? "staged" : "failed",
        filePath,
        JSON.stringify(info),
        candidateId,
        intact ? null : "The extracted file failed its integrity check.",
        item.id,
      );
    } catch (error) {
      db.prepare("UPDATE import_items SET status = 'failed', staged_path = ?, error = ? WHERE id = ?").run(filePath, error.message, item.id);
    }
    return itemView(db.prepare("SELECT * FROM import_items WHERE id = ?").get(item.id));
  }

  /** Final metadata for a new song: its own details plus the album fields. */
  function finalValues(item, info, albumFields, { majorityAlbum, numbering }) {
    const entry = item.entry;
    const own = { title: info.title || entry.title, artist: info.artist || entry.artist, album: info.album || entry.album, genre: entry.genre };
    let album = own.album;
    // Album fields apply unless the song deliberately has a different album.
    if (albumFields.album && (!album || normalizeKey(album) === normalizeKey(majorityAlbum))) album = albumFields.album;
    if (albumFields.edition && album && !parseAlbum(album).edition) album = `${album} (${albumFields.edition})`;
    return {
      title: own.title || "Untitled",
      artist: own.artist || albumFields.albumArtist || "",
      album_artist: albumFields.albumArtist || "",
      album: album || "",
      year: Number.isInteger(albumFields.year) ? albumFields.year : null,
      genre: own.genre || albumFields.genre || "",
      track_no: numbering ? numbering.get(item.id)?.no ?? null : null,
      track_total: numbering ? numbering.get(item.id)?.total ?? null : null,
      disc_no: null,
      disc_total: null,
      composer: "",
      comment: "",
      compilation: 0,
    };
  }

  const TAG_NAMES = {
    title: "title",
    artist: "artist",
    album_artist: "albumArtist",
    album: "album",
    year: "year",
    genre: "genre",
    track_no: "trackNo",
    track_total: "trackTotal",
  };

  /** Copies a staged file into the library as a new song. */
  async function addSong({ operationId, item, values, artworkHash, managed }) {
    const ext = path.extname(item.stagedPath).toLowerCase();
    const pattern = getSettings().namingPattern || DEFAULT_PATTERN;
    const [planned] = planPaths([{ track: values, ext }], { root: managed.root_path, pattern, exists: (target) => fs.existsSync(target) });
    const staged = siblingPath(planned.target, "wmtmp");
    const stepId = addStep(db, operationId, { action: "import", targetPath: planned.target, stagedPath: staged, details: { itemId: item.id } });
    try {
      fs.mkdirSync(path.dirname(planned.target), { recursive: true });
      fs.rmSync(staged, { force: true });
      fs.copyFileSync(item.stagedPath, staged, fs.constants.COPYFILE_EXCL);
      if ((await sha256(staged)) !== (await sha256(item.stagedPath))) throw new Error("The copy didn't match the extracted file");
      if (canWriteTags(staged)) {
        const fields = Object.fromEntries(Object.entries(TAG_NAMES).map(([column, name]) => [name, values[column]]));
        if (artworkHash) {
          const art = artStore.read(artworkHash, db);
          if (art) fields.artwork = art;
        }
        const before = await media.audioStreamHash(staged);
        writeTags(staged, fields);
        if ((await media.audioStreamHash(staged)) !== before) throw new Error("The audio stream changed while writing tags");
      }
      moveFile(staged, planned.target);
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
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, '', '', 0, ?, ?, ?, ?, ?, ?)`,
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
              artworkHash || null,
              titleKey(values.title),
              artistKey(values.artist),
              now,
              now,
            ).lastInsertRowid,
        );
        const fileId = insertFileRow(db, { trackId: id, sourceId: managed.id, target: planned.target, relRoot: managed.root_path, snapshot });
        db.prepare("UPDATE tracks SET active_file_id = ? WHERE id = ?").run(fileId, id);
        logChange(db, operationId, { entityId: id, field: "created", oldValue: null, newValue: fileId });
        db.prepare("UPDATE import_items SET status = 'committed', result_track_id = ?, outcome = 'added' WHERE id = ?").run(id, item.id);
        updateStep(db, stepId, { state: "done", details: { itemId: item.id, trackId: id, fileId } });
        return id;
      });
      return trackId;
    } catch (error) {
      fs.rmSync(staged, { force: true });
      updateStep(db, stepId, { state: "failed", error: error.message });
      throw error;
    }
  }

  /**
   * Commits the import. `decisions` maps item id -> add | upgrade |
   * keep_existing | keep_both | skip (staged items only).
   */
  async function commitJob({ sessionId, decisions, signal, progress }) {
    const row = session(sessionId, { open: true });
    const albumFields = parseJson(row.album_fields, {});
    const items = view(row.id).items.map((item) => ({ ...item, stagedPath: db.prepare("SELECT staged_path FROM import_items WHERE id = ?").get(item.id).staged_path }));
    const chosen = new Map(decisions.map((decision) => [Number(decision.itemId), decision.decision]));
    for (const decision of chosen.values()) if (!DECISIONS.includes(decision)) throw new Error("Unknown import decision");

    const adding = items.filter((item) => item.status === "staged" && ["add", "keep_both"].includes(chosen.get(item.id)));
    const upgrading = items.filter((item) => item.status === "staged" && chosen.get(item.id) === "upgrade" && item.candidateId);
    const managed = managedSource();
    if ((adding.length || upgrading.length) && !managed) throw new Error("Choose a folder for your WaveMint Library first; imports are copied there.");
    if (managed && adding.length) {
      const needed = adding.reduce((sum, item) => sum + (item.staged?.size || 0), 0);
      const free = freeBytes(managed.root_path);
      if (free !== null && free < needed * 1.05) throw new Error("There isn't enough free space in the WaveMint Library folder.");
    }

    // Album-level values: shared album name, numbering in playlist order.
    const albums = items.map((item) => item.staged?.album || item.entry.album).filter(Boolean);
    const counts = new Map();
    for (const album of albums) counts.set(normalizeKey(album), (counts.get(normalizeKey(album)) || 0) + 1);
    const majorityKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const majorityAlbum = albums.find((album) => normalizeKey(album) === majorityKey) || "";
    const numbered = albumFields.numberTracks
      ? new Map(
          items
            .filter((item) => item.status === "staged" && ["add", "keep_both", "upgrade"].includes(chosen.get(item.id)))
            .map((item, index, all) => [item.id, { no: index + 1, total: all.length }]),
        )
      : null;
    let artworkHash = null;
    if (albumFields.artworkKey) {
      const source = items.find((item) => item.entryKey === albumFields.artworkKey && item.stagedPath && fs.existsSync(item.stagedPath));
      const art = source ? readArtwork(source.stagedPath) : null;
      if (art) artworkHash = artStore.save(art.data).hash;
    }

    const operationId = startOperation(db, { kind: "import", label: `Import "${row.title || "playlist"}"` });
    const report = { added: 0, upgraded: 0, kept: 0, skipped: 0, failed: 0, failures: [] };
    const work = items.filter((item) => chosen.has(item.id) || item.status !== "staged");

    for (const [index, item] of work.entries()) {
      if (signal?.aborted) break;
      const decision = chosen.get(item.id) || (item.status === "staged" ? "skip" : null);
      progress?.({ phase: "importing", done: index, total: work.length, current: item.staged?.title || item.entry.title });
      try {
        if (item.status === "committed") {
          report[item.outcome === "upgraded" ? "upgraded" : "added"] += 1;
        } else if (item.status !== "staged") {
          report.skipped += 1;
        } else if (decision === "add" || decision === "keep_both") {
          const values = finalValues(item, item.staged, albumFields, { majorityAlbum, numbering: numbered });
          await addSong({ operationId, item, values, artworkHash, managed });
          report.added += 1;
        } else if (decision === "upgrade") {
          const candidate = db.prepare("SELECT status FROM upgrade_candidates WHERE id = ?").get(item.candidateId);
          if (candidate?.status !== "applied") {
            const comparison = upgrader.compare({ candidateId: item.candidateId });
            const choices = Object.fromEntries(comparison.fields.map((field) => [field.field, field.choice]));
            await upgrader.applyJob({ candidateId: item.candidateId, choices, artwork: comparison.artwork.choice, signal });
          }
          db.prepare("UPDATE import_items SET status = 'committed', result_track_id = ?, outcome = 'upgraded' WHERE id = ?").run(item.staged?.comparison?.trackId ?? null, item.id);
          report.upgraded += 1;
        } else {
          db.prepare("UPDATE import_items SET status = 'skipped', outcome = ? WHERE id = ?").run(decision === "keep_existing" ? "kept" : "skipped", item.id);
          if (decision === "keep_existing") report.kept += 1;
          else report.skipped += 1;
        }
      } catch (error) {
        report.failed += 1;
        report.failures.push({ title: item.entry.title, error: error.message });
        db.prepare("UPDATE import_items SET error = ? WHERE id = ?").run(error.message, item.id);
        logger.warn(`[library] Import of "${item.entry.title}" failed: ${error.message}`);
      }
    }

    const status = report.failed ? (report.added || report.upgraded ? "partial" : "failed") : "completed";
    finishOperation(db, operationId, status, report);
    refreshTrackSearch(db, db.prepare("SELECT result_track_id AS id FROM import_items WHERE session_id = ? AND result_track_id IS NOT NULL").all(row.id).map((item) => item.id));

    if (!signal?.aborted && !report.failed) {
      db.prepare("UPDATE import_sessions SET status = 'committed', report = ?, operation_id = ?, committed_at = ? WHERE id = ?").run(JSON.stringify(report), operationId, nowIso(), row.id);
      // Staged extractions are WaveMint's own temporary files.
      fs.rmSync(stagingFolder(row.id), { recursive: true, force: true });
    } else {
      db.prepare("UPDATE import_sessions SET report = ?, operation_id = ? WHERE id = ?").run(JSON.stringify(report), operationId, row.id);
    }
    return { operationId, ...report };
  }

  function discard({ sessionId }) {
    const row = session(sessionId);
    if (row.status === "open") {
      db.prepare("UPDATE import_sessions SET status = 'discarded' WHERE id = ?").run(row.id);
      db.prepare("UPDATE upgrade_candidates SET status = 'discarded' WHERE status = 'pending' AND id IN (SELECT candidate_id FROM import_items WHERE session_id = ?)").run(row.id);
    }
    fs.rmSync(stagingFolder(row.id), { recursive: true, force: true });
    return { discarded: true };
  }

  /** Undo Import: the added songs leave the library; their files are archived. */
  function undoImport(operationId) {
    const operation = db.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'import'").get(Number(operationId));
    if (!operation) throw new Error("This import can't be undone.");
    if (db.prepare("SELECT 1 FROM operations WHERE undo_of = ? AND status = 'completed'").get(operation.id)) throw new Error("This import was already undone.");
    const created = db.prepare("SELECT entity_id, new_value FROM change_log WHERE operation_id = ? AND field = 'created'").all(operation.id);
    const managed = managedSource();
    const undoId = startOperation(db, { kind: "import", label: `Undo: ${operation.label}`, undoOf: operation.id, undoable: false });
    let removed = 0;
    for (const change of created) {
      const track = db.prepare("SELECT id, state FROM tracks WHERE id = ?").get(change.entity_id);
      if (!track || track.state !== "active") continue;
      const file = db.prepare("SELECT * FROM files WHERE track_id = ? AND id = ?").get(track.id, parseJson(change.new_value));
      let moved = null;
      if (file && managed && file.source_id === managed.id && fs.existsSync(file.path)) {
        const target = path.join(managed.root_path, ARCHIVE_DIR, "imports", `undone-${operation.id}`, file.rel_path);
        moveFile(file.path, target);
        moved = target;
      }
      transaction(db, () => {
        db.prepare("UPDATE tracks SET state = 'removed', updated_at = ? WHERE id = ?").run(nowIso(), track.id);
        logChange(db, undoId, { entityId: track.id, field: "state", oldValue: "active", newValue: "removed" });
        if (file) {
          db.prepare("UPDATE files SET role = 'archived' WHERE id = ?").run(file.id);
          if (moved) db.prepare("UPDATE files SET path = ?, path_key = ?, rel_path = ? WHERE id = ?").run(moved, pathKey(moved), path.relative(managed.root_path, moved), file.id);
        }
      });
      removed += 1;
    }
    finishOperation(db, undoId, "completed", { removed });
    refreshTrackSearch(db, created.map((change) => change.entity_id));
    return { operationId: undoId, tracks: removed };
  }

  /** Cleans up copies interrupted by a crash (staged copies are removed; placed ones parked). */
  function recover() {
    const report = [];
    const managed = managedSource();
    for (const operation of db.prepare("SELECT * FROM operations WHERE kind = 'import' AND status = 'running'").all()) {
      for (const step of db.prepare("SELECT * FROM operation_steps WHERE operation_id = ? AND state NOT IN ('done', 'failed', 'rolled_back')").all(operation.id)) {
        try {
          if (step.staged_path) fs.rmSync(step.staged_path, { force: true });
          if (step.state === "placed" && managed && step.target_path && fs.existsSync(step.target_path) && !db.prepare("SELECT 1 FROM files WHERE path_key = ?").get(pathKey(step.target_path))) {
            moveFile(step.target_path, path.join(managed.root_path, ARCHIVE_DIR, "failed", `op-${operation.id}`, path.basename(step.target_path)));
          }
          updateStep(db, step.id, { state: "rolled_back" });
          report.push({ operationId: operation.id, outcome: "rolled_back" });
        } catch (error) {
          updateStep(db, step.id, { state: "failed", error: `Recovery: ${error.message}` });
        }
      }
      finishOperation(db, operation.id, "interrupted", {});
    }
    return report;
  }

  function listSessions() {
    return db.prepare("SELECT id, status, title, created_at, committed_at, report FROM import_sessions ORDER BY id DESC LIMIT 20").all().map((row) => ({ ...row, report: parseJson(row.report, null) }));
  }

  return { addStaged, commitJob, discard, listSessions, prepareStaging, recover, startSession, undoImport, updateSession, view };
}

module.exports = { ACTIONS, DECISIONS, createImporter };
