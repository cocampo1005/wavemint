// Metadata editing for logical tracks. Edits change the database (the source
// of truth); they are written into audio files separately and only where
// WaveMint may write (see fileops.cjs).
//
// - Every edit is an operation with a field-level change log, so it can be
//   reviewed and undone.
// - Edited fields become "curated": rescans never overwrite them with values
//   from the files.
// - Bulk edits only touch the fields explicitly given; nothing is cleared
//   because selected tracks had different values.

const { nowIso, parseJson, transaction } = require("./db.cjs");
const { artistKey, titleKey } = require("./normalize.cjs");
const { finishOperation, logChange, startOperation } = require("./operations.cjs");
const { releaseFor } = require("./scanner.cjs");
const { refreshTrackSearch } = require("./search.cjs");

// API field -> column, and whether it is written into audio tags.
const FIELDS = {
  title: { column: "title", type: "text", tag: true },
  artist: { column: "artist", type: "text", tag: true },
  albumArtist: { column: "album_artist", type: "text", tag: true },
  album: { column: "album", type: "text", tag: true },
  genre: { column: "genre", type: "text", tag: true },
  year: { column: "year", type: "year", tag: true },
  trackNo: { column: "track_no", type: "count", tag: true },
  trackTotal: { column: "track_total", type: "count", tag: true },
  discNo: { column: "disc_no", type: "count", tag: true },
  discTotal: { column: "disc_total", type: "count", tag: true },
  composer: { column: "composer", type: "text", tag: true },
  comment: { column: "comment", type: "text", tag: true },
  compilation: { column: "compilation", type: "bool", tag: true },
  rating: { column: "rating", type: "rating", tag: false },
  notes: { column: "notes", type: "text", tag: false },
};

const COLUMN_TO_FIELD = Object.fromEntries(Object.entries(FIELDS).map(([field, def]) => [def.column, field]));
const RELEASE_COLUMNS = new Set(["album", "album_artist", "artist", "compilation", "year"]);

function normalizeValue(field, value) {
  const def = FIELDS[field];
  if (!def) throw new Error(`"${field}" can't be edited`);

  switch (def.type) {
    case "text":
      return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, field === "comment" || field === "notes" ? 2000 : 500);
    case "year": {
      const number = Number(value);
      return Number.isInteger(number) && number >= 1000 && number <= 9999 ? number : null;
    }
    case "count": {
      const number = Number(value);
      return Number.isInteger(number) && number > 0 && number < 1000 ? number : null;
    }
    case "bool":
      return value ? 1 : 0;
    case "rating": {
      const number = Number(value);
      return Number.isInteger(number) && number >= 0 && number <= 5 ? number : null;
    }
    default:
      return value;
  }
}

/**
 * Computes what `edits` ([{ trackId, fields }]) would change. Returns only
 * real changes: [{ trackId, title, artist, changes: [{ field, from, to }] }].
 */
function previewEdits(db, edits) {
  const byTrack = new Map();
  for (const edit of edits) {
    const id = Number(edit.trackId);
    byTrack.set(id, { ...(byTrack.get(id) || {}), ...edit.fields });
  }

  const ids = [...byTrack.keys()];
  if (!ids.length) return [];
  const rows = new Map();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    for (const row of db.prepare(`SELECT * FROM tracks WHERE id IN (${chunk.map(() => "?").join(",")}) AND state = 'active'`).all(...chunk)) {
      rows.set(row.id, row);
    }
  }

  const preview = [];
  for (const [trackId, fields] of byTrack) {
    const track = rows.get(trackId);
    if (!track) continue;
    const changes = [];
    for (const [field, raw] of Object.entries(fields)) {
      if (!FIELDS[field]) continue;
      const to = normalizeValue(field, raw);
      const from = track[FIELDS[field].column];
      if ((from ?? null) !== (to ?? null)) changes.push({ field, from: from ?? null, to });
    }
    if (changes.length) preview.push({ trackId, title: track.title, artist: track.artist, changes });
  }
  return preview;
}

function syncDerived(db, trackId) {
  const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
  const releaseId = releaseFor(db, {
    album: track.album,
    albumArtist: track.album_artist,
    artist: track.artist,
    compilation: track.compilation,
    year: track.year,
  });
  db.prepare("UPDATE tracks SET title_key = ?, artist_key = ?, release_id = ? WHERE id = ?").run(
    titleKey(track.title),
    artistKey(track.artist),
    releaseId,
    trackId,
  );
}

/**
 * Applies edits in one operation. `exclude` lists { trackId, field } pairs
 * the user unticked in the preview. `markCurated: false` is for automatic
 * changes (rules, renames) that must not count as manual curation.
 * Returns { operationId, tracks, changes }.
 */
function applyEdits(db, edits, { label = "Edit metadata", exclude = [], kind = "metadata", markCurated = true } = {}) {
  const skipped = new Set(exclude.map((item) => `${Number(item.trackId)}:${item.field}`));
  const preview = previewEdits(db, edits)
    .map((item) => ({ ...item, changes: item.changes.filter((change) => !skipped.has(`${item.trackId}:${change.field}`)) }))
    .filter((item) => item.changes.length);

  if (!preview.length) return { operationId: null, tracks: 0, changes: 0 };

  let operationId = null;
  let changeCount = 0;

  transaction(db, () => {
    operationId = startOperation(db, { kind, label });
    const now = nowIso();

    for (const item of preview) {
      const track = db.prepare("SELECT curated_fields FROM tracks WHERE id = ?").get(item.trackId);
      const curated = new Set(parseJson(track.curated_fields, []));
      const assignments = [];
      const values = [];
      let tagChange = false;
      let releaseChange = false;

      for (const change of item.changes) {
        const def = FIELDS[change.field];
        assignments.push(`${def.column} = ?`);
        values.push(change.to);
        if (markCurated) curated.add(def.column);
        tagChange = tagChange || def.tag;
        releaseChange = releaseChange || RELEASE_COLUMNS.has(def.column);
        logChange(db, operationId, { entityId: item.trackId, field: def.column, oldValue: change.from, newValue: change.to });
        changeCount += 1;
      }

      assignments.push("curated_fields = ?", "updated_at = ?");
      values.push(JSON.stringify([...curated]), now);
      if (tagChange) assignments.push("tags_dirty = 1");

      db.prepare(`UPDATE tracks SET ${assignments.join(", ")} WHERE id = ?`).run(...values, item.trackId);
      if (releaseChange || item.changes.some((change) => change.field === "title" || change.field === "artist")) {
        syncDerived(db, item.trackId);
      }
    }

    finishOperation(db, operationId, "completed", { tracks: preview.length, changes: changeCount });
  });

  refreshTrackSearch(db, preview.map((item) => item.trackId));
  return { operationId, tracks: preview.length, changes: changeCount };
}

/** Sets (or clears) the WaveMint artwork for tracks; logged and undoable. */
function setTrackArtwork(db, trackIds, artworkHash, { label = "Change artwork" } = {}) {
  const ids = [...new Set(trackIds.map(Number))];
  let operationId = null;
  let changed = 0;

  transaction(db, () => {
    operationId = startOperation(db, { kind: "artwork", label });
    for (const id of ids) {
      const track = db
        .prepare("SELECT t.artwork_hash, t.curated_fields FROM tracks t WHERE t.id = ? AND t.state = 'active'")
        .get(id);
      if (!track || track.artwork_hash === artworkHash) continue;
      const curated = new Set(parseJson(track.curated_fields, []));
      curated.add("artwork_hash");
      db.prepare("UPDATE tracks SET artwork_hash = ?, tags_dirty = 1, curated_fields = ?, updated_at = ? WHERE id = ?").run(
        artworkHash,
        JSON.stringify([...curated]),
        nowIso(),
        id,
      );
      logChange(db, operationId, { entityId: id, field: "artwork_hash", oldValue: track.artwork_hash, newValue: artworkHash });
      changed += 1;
    }
    finishOperation(db, operationId, changed ? "completed" : "completed", { tracks: changed });
  });

  return { operationId, tracks: changed };
}

/**
 * Undoes a metadata/artwork operation by restoring old values. A field that
 * was changed again since is left alone and reported as a conflict.
 */
function undoMetadataOperation(db, operationId) {
  const operation = db.prepare("SELECT * FROM operations WHERE id = ?").get(Number(operationId));
  if (!operation) throw new Error("This change no longer exists.");
  if (!["metadata", "artwork", "genre", "quality"].includes(operation.kind)) {
    throw new Error("This kind of change is undone differently.");
  }
  if (db.prepare("SELECT 1 FROM operations WHERE undo_of = ? AND status IN ('completed', 'partial')").get(operation.id)) {
    throw new Error("This change was already undone.");
  }

  const changes = db
    .prepare("SELECT * FROM change_log WHERE operation_id = ? AND entity_type = 'track' ORDER BY id DESC")
    .all(operation.id);

  let undoId = null;
  const conflicts = [];
  const touched = new Set();

  transaction(db, () => {
    undoId = startOperation(db, { kind: operation.kind, label: `Undo: ${operation.label}`, undoOf: operation.id, undoable: false });
    for (const change of changes) {
      const column = change.field;
      if (!/^[a-z_]+$/.test(column)) continue;
      const current = db.prepare(`SELECT ${column} AS value FROM tracks WHERE id = ?`).get(change.entity_id);
      if (!current) continue;
      const expected = parseJson(change.new_value);
      const previous = parseJson(change.old_value);
      if ((current.value ?? null) !== (expected ?? null)) {
        conflicts.push({ trackId: change.entity_id, field: column });
        continue;
      }
      const tagRelated = column === "artwork_hash" || FIELDS[COLUMN_TO_FIELD[column]]?.tag;
      db.prepare(`UPDATE tracks SET ${column} = ?, ${tagRelated ? "tags_dirty = 1," : ""} updated_at = ? WHERE id = ?`).run(
        previous,
        nowIso(),
        change.entity_id,
      );
      logChange(db, undoId, { entityId: change.entity_id, field: column, oldValue: expected, newValue: previous });
      touched.add(change.entity_id);
    }
    for (const id of touched) syncDerived(db, id);
    finishOperation(db, undoId, conflicts.length ? "partial" : "completed", { tracks: touched.size, conflicts: conflicts.length });
  });

  refreshTrackSearch(db, [...touched]);
  return { operationId: undoId, tracks: touched.size, conflicts };
}

/** Title Case suitable for song and album titles (keeps ALL-CAPS words). */
function titleCase(value) {
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "vs", "via", "with"]);
  const words = String(value || "").split(/(\s+|-|\()/);
  let index = 0;
  return words
    .map((word) => {
      if (/^\s+$|^-$|^\($/.test(word) || !word) return word;
      const position = index++;
      if (/^[A-Z0-9]{2,}$/.test(word) || /[A-Z].*[A-Z]/.test(word.slice(1))) return word; // acronyms, McCartney
      const lower = word.toLowerCase();
      if (position > 0 && small.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

module.exports = {
  FIELDS,
  applyEdits,
  normalizeValue,
  previewEdits,
  setTrackArtwork,
  syncDerived,
  titleCase,
  undoMetadataOperation,
};
