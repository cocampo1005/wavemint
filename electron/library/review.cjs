// The review queue: meaningful, actionable library problems only. Issues are
// found with deterministic checks; each becomes a review item whose status
// (needs review, suggested, approved, ignored, resolved) persists across
// sessions and rescans:
//
// - a new issue is added as "needs_review" (or "suggested" with a fix);
// - an ignored item stays ignored while the issue exists (a dismissed
//   duplicate comes back only when the files involved change);
// - an item whose issue disappeared becomes "resolved";
// - a resolved item reopens if the issue comes back.
//
// Three groups, matching Review's tabs:
//   attention   - essential metadata: title, artist, album (unless turned
//                 off: singles and standalone songs often have none), artwork,
//                 and values that look like a ripper's placeholder;
//   duplicates  - songs that may be the same recording (duplicates.cjs);
//   diagnostics - songs whose current file is missing or unreadable, or that
//                 have no file at all.
// Optional fields (year, track/disc numbers, genre, composer…) are never
// flagged, and nothing here judges audio quality.

const path = require("path");
const { nowIso, parseJson, transaction } = require("./db.cjs");
const { applyEdits } = require("./edits.cjs");
const { filesSignature, findDuplicates } = require("./duplicates.cjs");
const { pairKey } = require("./match.cjs");

const KINDS = {
  missing_title: { label: "Missing title", group: "attention", entity: "track" },
  missing_artist: { label: "Missing artist", group: "attention", entity: "track" },
  missing_album: { label: "Missing album", group: "attention", entity: "track" },
  missing_artwork: { label: "Missing artwork", group: "attention", entity: "track" },
  placeholder: { label: "Placeholder details", group: "attention", entity: "track" },
  duplicate: { label: "Duplicate", group: "duplicates", entity: "track" },
  possible_duplicate: { label: "Possible duplicate", group: "duplicates", entity: "track" },
  file_problem: { label: "File missing or unreadable", group: "diagnostics", entity: "file" },
  no_file: { label: "No audio file", group: "diagnostics", entity: "track" },
};
const GROUPS = ["attention", "duplicates", "diagnostics"];
const kindsOf = (group) => Object.keys(KINDS).filter((kind) => KINDS[kind].group === group);
// Counted in the navigation badge: everything open except "possible" duplicates (suggestions).
const COUNTED_KINDS = Object.keys(KINDS).filter((kind) => kind !== "possible_duplicate");

// Values that taggers and rippers fill in when they know nothing. Compared
// after trimming and lowercasing. Real titles such as "Untitled" are left alone.
const PLACEHOLDER_ARTISTS = new Set(["unknown", "unknown artist", "<unknown>", "[unknown]", "unknown_artist", "no artist"]);
const PLACEHOLDER_ALBUMS = new Set(["unknown", "unknown album", "<unknown>", "[unknown]", "unknown_album", "no album"]);
const PLACEHOLDER_TITLE = /^(?:(?:audio\s*)?track|piste|titel|pista|faixa)\s*[-_#.]?\s*\d{1,3}$/i;
const FILE_NAME_TITLE = /\.(?:mp3|m4a|m4b|aac|flac|wav|aiff?|ogg|opus|wma)$/i;

function placeholderFields(track) {
  const found = [];
  const artist = String(track.artist || "").trim().toLowerCase();
  const album = String(track.album || "").trim().toLowerCase();
  const title = String(track.title || "").trim();
  if (artist && PLACEHOLDER_ARTISTS.has(artist)) found.push({ field: "artist", value: track.artist });
  if (album && PLACEHOLDER_ALBUMS.has(album)) found.push({ field: "album", value: track.album });
  if (title && (PLACEHOLDER_TITLE.test(title) || FILE_NAME_TITLE.test(title))) found.push({ field: "title", value: track.title });
  return found;
}

function loadTracks(db) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album, t.release_id, t.duration_ms, t.track_no, t.disc_no, t.mb_recording_id,
              t.artwork_hash AS chosen_art, t.active_file_id,
              f.id AS file_id, f.status AS file_status, f.read_error, f.artwork_hash AS file_art, f.size, f.quick_sig,
              f.content_hash, f.audio_hash, f.path
       FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id WHERE t.state = 'active'`,
    )
    .all();
}

/**
 * Runs every check; returns Map("kind:entity:id" -> issue). Options:
 * `flagMissingAlbum` (default true) reports songs without an album.
 */
function detectIssues(db, { flagMissingAlbum = true } = {}) {
  const issues = new Map();
  const add = (kind, entityId, details, suggestion = null) => {
    issues.set(`${kind}:${KINDS[kind].entity}:${entityId}`, { kind, entityType: KINDS[kind].entity, entityId, details, suggestion });
  };

  const tracks = loadTracks(db);
  for (const track of tracks) {
    if (!String(track.title || "").trim()) {
      const name = track.path ? path.basename(track.path, path.extname(track.path)) : "";
      add(
        "missing_title",
        track.id,
        { fileName: name || null },
        name ? { type: "edit", label: `Use the file name "${name}" as the title`, edits: [{ trackId: track.id, fields: { title: name } }] } : null,
      );
    }
    if (!String(track.artist || "").trim()) add("missing_artist", track.id, {});
    if (flagMissingAlbum && !String(track.album || "").trim()) {
      add(
        "missing_album",
        track.id,
        {},
        track.title ? { type: "edit", label: `Use "${track.title}" as the album (a single)`, edits: [{ trackId: track.id, fields: { album: track.title } }] } : null,
      );
    }
    if (!track.chosen_art && !track.file_art) add("missing_artwork", track.id, { releaseId: track.release_id || null, album: track.album || "" });
    const placeholders = placeholderFields(track);
    if (placeholders.length) add("placeholder", track.id, { fields: placeholders });

    if (!track.file_id) add("no_file", track.id, {});
    else if (track.file_status !== "ok") add("file_problem", track.file_id, { status: track.file_status, error: track.read_error, trackId: track.id });
  }

  // Duplicates: one item per group, keyed by its lowest song id.
  const decisions = new Map(db.prepare("SELECT track_a, track_b, decision FROM match_decisions").all().map((row) => [pairKey(row.track_a, row.track_b), row.decision]));
  const candidates = tracks.filter((track) => track.file_id && track.file_status === "ok");
  const byId = new Map(candidates.map((track) => [track.id, track]));
  const { strong, possible } = findDuplicates(candidates, { decisions });
  for (const [kind, groups] of [["duplicate", strong], ["possible_duplicate", possible]]) {
    for (const group of groups) {
      add(kind, group.trackIds[0], {
        trackIds: group.trackIds,
        tier: group.tier,
        confidence: group.confidence,
        reasons: group.reasons,
        filesSig: filesSignature(group.trackIds.map((id) => byId.get(id))),
      });
    }
  }

  return issues;
}

/** Updates the queue from the current library state (options as detectIssues). */
function refreshReview(db, options = {}) {
  const issues = detectIssues(db, options);
  const now = nowIso();
  let added = 0;
  let reopened = 0;
  let resolved = 0;

  transaction(db, () => {
    // Checks that are no longer part of Review leave no stale items behind.
    const known = Object.keys(KINDS);
    db.prepare(`DELETE FROM review_items WHERE kind NOT IN (${known.map(() => "?").join(",")})`).run(...known);

    const existing = db.prepare("SELECT * FROM review_items").all();
    const existingByKey = new Map(existing.map((item) => [`${item.kind}:${item.entity_type}:${item.entity_id}`, item]));
    const insert = db.prepare(
      `INSERT INTO review_items (kind, entity_type, entity_id, status, details, suggestion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare("UPDATE review_items SET status = ?, details = ?, suggestion = ?, updated_at = ? WHERE id = ?");

    for (const [key, issue] of issues) {
      const details = JSON.stringify(issue.details || {});
      const suggestion = issue.suggestion ? JSON.stringify(issue.suggestion) : null;
      const item = existingByKey.get(key);
      const openStatus = issue.suggestion ? "suggested" : "needs_review";

      if (!item) {
        insert.run(issue.kind, issue.entityType, issue.entityId, openStatus, details, suggestion, now, now);
        added += 1;
      } else if (item.status === "resolved" || item.status === "approved") {
        update.run(openStatus, details, suggestion, now, item.id);
        reopened += 1;
      } else if (item.status === "ignored") {
        // A dismissed duplicate returns only when its files changed.
        const before = parseJson(item.details, {});
        if (issue.details?.filesSig && before.filesSig && before.filesSig !== issue.details.filesSig) {
          update.run(openStatus, details, suggestion, now, item.id);
          reopened += 1;
        } else if (item.details !== details || item.suggestion !== suggestion) update.run("ignored", details, suggestion, now, item.id);
      } else if (item.details !== details || item.suggestion !== suggestion || item.status !== openStatus) {
        update.run(openStatus, details, suggestion, now, item.id);
      }
    }

    for (const item of existing) {
      const key = `${item.kind}:${item.entity_type}:${item.entity_id}`;
      if (!issues.has(key) && ["needs_review", "suggested", "approved"].includes(item.status)) {
        update.run("resolved", item.details, item.suggestion, now, item.id);
        resolved += 1;
      }
    }
  });

  return { open: issues.size, added, reopened, resolved };
}

const OPEN = "status IN ('needs_review', 'suggested')";

/** Open counts per kind and group; `open` is what the navigation badge shows. */
function reviewSummary(db) {
  const rows = db.prepare("SELECT kind, status, COUNT(*) AS count FROM review_items GROUP BY kind, status").all();
  const kinds = {};
  for (const kind of Object.keys(KINDS)) kinds[kind] = { label: KINDS[kind].label, group: KINDS[kind].group, open: 0, ignored: 0, resolved: 0 };
  for (const row of rows) {
    if (!kinds[row.kind]) continue;
    if (row.status === "needs_review" || row.status === "suggested") kinds[row.kind].open += row.count;
    else if (row.status === "ignored") kinds[row.kind].ignored += row.count;
    else kinds[row.kind].resolved += row.count;
  }
  const groups = Object.fromEntries(GROUPS.map((group) => [group, kindsOf(group).reduce((sum, kind) => sum + kinds[kind].open, 0)]));
  const open = COUNTED_KINDS.reduce((sum, kind) => sum + kinds[kind].open, 0);
  return { open, groups, kinds };
}

/** The badge count alone (cheap; used by the app status). */
function openCount(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM review_items WHERE ${OPEN} AND kind IN (${COUNTED_KINDS.map(() => "?").join(",")})`).get(...COUNTED_KINDS).n;
}

const MEMBER_SQL = `SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.year, t.genre, t.duration_ms, t.track_no, t.release_id, t.favorite,
         t.created_at, COALESCE(t.artwork_hash, f.artwork_hash) AS artwork_hash,
         f.id AS file_id, f.codec, f.bitrate, f.lossless, f.sample_rate, f.bit_depth, f.size, f.path, f.rel_path, f.status AS file_status,
         s.name AS source_name,
         (SELECT COUNT(*) FROM playlist_tracks p WHERE p.track_id = t.id) AS playlist_count
  FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id LEFT JOIN sources s ON s.id = f.source_id
  WHERE t.id = ? AND t.state = 'active'`;

function listReviewItems(db, { group, kind, status = "open", offset = 0, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (kind) {
    where.push("r.kind = ?");
    params.push(kind);
  } else {
    const kinds = group ? kindsOf(group) : kindsOf("attention");
    where.push(`r.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (status === "open") where.push(`r.${OPEN}`);
  else if (status) {
    where.push("r.status = ?");
    params.push(status);
  }
  const clause = `WHERE ${where.join(" AND ")}`;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM review_items r ${clause}`).get(...params).n;
  const memberQuery = db.prepare(MEMBER_SQL);
  const rows = db
    .prepare(
      `SELECT r.*,
              t.title AS track_title, t.artist AS track_artist, t.album AS track_album, t.release_id AS track_release_id,
              COALESCE(t.artwork_hash, tf.artwork_hash) AS track_artwork,
              f.path AS file_path, f.track_id AS file_track_id,
              ft.title AS file_track_title, ft.artist AS file_track_artist, COALESCE(ft.artwork_hash, f.artwork_hash) AS file_track_artwork
       FROM review_items r
       LEFT JOIN tracks t ON r.entity_type = 'track' AND t.id = r.entity_id
       LEFT JOIN files tf ON tf.id = t.active_file_id
       LEFT JOIN files f ON r.entity_type = 'file' AND f.id = r.entity_id
       LEFT JOIN tracks ft ON ft.id = f.track_id
       ${clause}
       ORDER BY CASE r.kind WHEN 'duplicate' THEN 0 WHEN 'missing_title' THEN 1 WHEN 'missing_artist' THEN 2 WHEN 'placeholder' THEN 3
                WHEN 'missing_album' THEN 4 WHEN 'missing_artwork' THEN 5 ELSE 6 END,
                t.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.track_no, r.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(500, Number(limit) || 100), Math.max(0, Number(offset) || 0))
    .map((row) => {
      const details = parseJson(row.details, {});
      return {
        ...row,
        label: KINDS[row.kind]?.label || row.kind,
        group: KINDS[row.kind]?.group || "attention",
        details,
        suggestion: parseJson(row.suggestion, null),
        members: Array.isArray(details.trackIds) ? details.trackIds.map((id) => memberQuery.get(id)).filter(Boolean) : undefined,
      };
    });

  return { total, rows };
}

function setReviewStatus(db, { ids, status }) {
  if (!["needs_review", "ignored", "resolved"].includes(status)) throw new Error("Unknown review status");
  const now = nowIso();
  transaction(db, () => {
    for (const id of ids) db.prepare("UPDATE review_items SET status = ?, updated_at = ? WHERE id = ?").run(status, now, Number(id));
  });
  return { updated: ids.length };
}

/** Applies the suggested fix of each item (one undoable operation per item). */
function approveSuggestions(db, { ids }) {
  const results = [];
  for (const id of ids) {
    const item = db.prepare("SELECT * FROM review_items WHERE id = ?").get(Number(id));
    const suggestion = parseJson(item?.suggestion, null);
    if (!item || !suggestion || suggestion.type !== "edit") continue;
    const result = applyEdits(db, suggestion.edits, { label: `Review: ${suggestion.label}` });
    db.prepare("UPDATE review_items SET status = 'approved', updated_at = ? WHERE id = ?").run(nowIso(), item.id);
    results.push({ id: item.id, ...result });
  }
  return { applied: results.length, results };
}

module.exports = { GROUPS, KINDS, approveSuggestions, detectIssues, listReviewItems, openCount, placeholderFields, refreshReview, reviewSummary, setReviewStatus };
