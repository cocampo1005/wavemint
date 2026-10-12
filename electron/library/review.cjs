// The metadata review queue. Issues are found with deterministic checks;
// each becomes a review item whose status (needs review, suggested,
// approved, ignored, resolved) persists across sessions and rescans:
//
// - a new issue is added as "needs_review" (or "suggested" with a fix);
// - an ignored item stays ignored while the issue exists;
// - an item whose issue disappeared becomes "resolved";
// - a resolved item reopens if the issue comes back.

const { nowIso, parseJson, transaction } = require("./db.cjs");
const { applyEdits } = require("./edits.cjs");
const { similar } = require("./genres.cjs");
const { normalizeKey } = require("./normalize.cjs");

const KINDS = {
  missing_album: { label: "Missing album", entity: "track" },
  missing_artist: { label: "Missing artist", entity: "track" },
  missing_album_artist: { label: "Missing album artist", entity: "release" },
  unclassified_genre: { label: "Unclassified genre", entity: "track" },
  missing_artwork: { label: "Missing artwork", entity: "track" },
  track_numbering: { label: "Suspicious track numbers", entity: "release" },
  inconsistent_album: { label: "Inconsistent album details", entity: "release" },
  similar_albums: { label: "Similar album names", entity: "release" },
  file_problem: { label: "File missing or unreadable", entity: "file" },
  possible_duplicate: { label: "Possible duplicate", entity: "track" },
};

function majority(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
}

/** Runs every check; returns Map("kind:entity:id" -> issue). */
function detectIssues(db) {
  const issues = new Map();
  const add = (kind, entityId, details, suggestion = null) => {
    issues.set(`${kind}:${KINDS[kind].entity}:${entityId}`, { kind, entityType: KINDS[kind].entity, entityId, details, suggestion });
  };

  const tracks = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.album, t.album_artist, t.genre, t.release_id, t.track_no, t.track_total,
              t.disc_no, t.year, t.compilation, t.artist_key, t.title_key, t.artwork_hash AS chosen_art,
              f.artwork_hash AS file_art
       FROM tracks t LEFT JOIN files f ON f.id = t.active_file_id WHERE t.state = 'active'`,
    )
    .all();

  const taxonomy = new Set(db.prepare("SELECT name FROM genres").all().map((row) => row.name.toLowerCase()));
  const aliases = new Map(
    db.prepare("SELECT a.alias_key, g.name FROM genre_aliases a JOIN genres g ON g.id = a.genre_id").all().map((row) => [row.alias_key, row.name]),
  );

  for (const track of tracks) {
    if (!track.album) add("missing_album", track.id, {});
    if (!track.artist) add("missing_artist", track.id, {});
    if (!track.chosen_art && !track.file_art) add("missing_artwork", track.id, {});

    if (!track.genre) {
      add("unclassified_genre", track.id, { label: "" });
    } else if (taxonomy.size && !taxonomy.has(track.genre.toLowerCase())) {
      const mapped = aliases.get(normalizeKey(track.genre));
      add(
        "unclassified_genre",
        track.id,
        { label: track.genre },
        mapped ? { type: "edit", label: `Change genre to "${mapped}"`, edits: [{ trackId: track.id, fields: { genre: mapped } }] } : null,
      );
    }
  }

  // Album-level checks.
  const byRelease = new Map();
  for (const track of tracks) {
    if (!track.release_id) continue;
    if (!byRelease.has(track.release_id)) byRelease.set(track.release_id, []);
    byRelease.get(track.release_id).push(track);
  }
  const releases = new Map(db.prepare("SELECT * FROM releases").all().map((release) => [release.id, release]));

  for (const [releaseId, members] of byRelease) {
    const release = releases.get(releaseId);
    if (!release) continue;

    const missingArtist = members.filter((track) => !track.album_artist && !track.compilation);
    const artists = [...new Set(members.map((track) => track.artist).filter(Boolean))];
    if (missingArtist.length && members.length > 1) {
      const suggestion =
        artists.length === 1
          ? {
              type: "edit",
              label: `Set album artist to "${artists[0]}"`,
              edits: missingArtist.map((track) => ({ trackId: track.id, fields: { albumArtist: artists[0] } })),
            }
          : null;
      add("missing_album_artist", releaseId, { album: release.title, tracks: missingArtist.length }, suggestion);
    }

    // Duplicate positions or numbers beyond the stated total.
    const positions = new Map();
    const problems = [];
    for (const track of members) {
      if (!track.track_no) continue;
      const key = `${track.disc_no || 1}-${track.track_no}`;
      if (positions.has(key)) problems.push(`Track ${track.track_no}${track.disc_no ? ` (disc ${track.disc_no})` : ""} appears more than once`);
      positions.set(key, track.id);
      if (track.track_total && track.track_no > track.track_total) problems.push(`Track ${track.track_no} is beyond the total of ${track.track_total}`);
    }
    if (problems.length) add("track_numbering", releaseId, { album: release.title, problems: [...new Set(problems)].slice(0, 10) });

    // Album artist / year disagreements inside one album.
    const albumArtists = members.map((track) => track.album_artist).filter(Boolean);
    const years = members.map((track) => track.year).filter(Boolean);
    const differences = [];
    const edits = [];
    if (new Set(albumArtists).size > 1) {
      const [value] = majority(albumArtists);
      differences.push(`Album artist: ${[...new Set(albumArtists)].join(" / ")}`);
      for (const track of members) if (track.album_artist && track.album_artist !== value) edits.push({ trackId: track.id, fields: { albumArtist: value } });
    }
    if (new Set(years).size > 1) {
      const [value] = majority(years);
      differences.push(`Year: ${[...new Set(years)].join(" / ")}`);
      for (const track of members) if (track.year && track.year !== value) edits.push({ trackId: track.id, fields: { year: value } });
    }
    if (differences.length) {
      add("inconsistent_album", releaseId, { album: release.title, differences }, edits.length
        ? { type: "edit", label: "Use the most common values for the whole album", edits }
        : null);
    }
  }

  // The same artist's albums with near-identical names (e.g. different
  // spellings of one album). Suggest the name used by more songs.
  const releaseList = [...byRelease.keys()].map((id) => ({ ...releases.get(id), count: byRelease.get(id).length })).filter((r) => r.id);
  const byArtist = new Map();
  for (const release of releaseList) {
    if (!byArtist.has(release.artist_key)) byArtist.set(release.artist_key, []);
    byArtist.get(release.artist_key).push(release);
  }
  for (const group of byArtist.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const [a, b] = [group[i], group[j]];
        if (a.edition !== b.edition || !similar(a.title, b.title)) continue;
        const [keep, other] = a.count >= b.count ? [a, b] : [b, a];
        add(
          "similar_albums",
          other.id,
          { album: other.title, similarTo: keep.title, similarReleaseId: keep.id },
          {
            type: "edit",
            label: `Rename to "${keep.title}"`,
            edits: byRelease.get(other.id).map((track) => ({ trackId: track.id, fields: { album: keep.title } })),
          },
        );
      }
    }
  }

  // Files that are missing or can't be read.
  for (const file of db.prepare("SELECT id, status, read_error FROM files WHERE status != 'ok'").all()) {
    add("file_problem", file.id, { status: file.status, error: file.read_error });
  }

  // Same artist + title (incl. version markers): one item per group.
  const groups = new Map();
  for (const track of tracks) {
    if (!track.title_key || !track.artist_key) continue;
    const key = `${track.artist_key}|${track.title_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(track.id);
  }
  for (const ids of groups.values()) {
    if (ids.length > 1) add("possible_duplicate", Math.min(...ids), { trackIds: ids });
  }

  return issues;
}

/** Updates the queue from the current library state. */
function refreshReview(db) {
  const issues = detectIssues(db);
  const now = nowIso();
  const existing = db.prepare("SELECT * FROM review_items").all();
  const existingByKey = new Map(existing.map((item) => [`${item.kind}:${item.entity_type}:${item.entity_id}`, item]));
  let added = 0;
  let reopened = 0;
  let resolved = 0;

  transaction(db, () => {
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
        if (item.details !== details || item.suggestion !== suggestion) update.run("ignored", details, suggestion, now, item.id);
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

  return { open: [...issues.values()].length, added, reopened, resolved };
}

function reviewSummary(db) {
  const rows = db.prepare("SELECT kind, status, COUNT(*) AS count FROM review_items GROUP BY kind, status").all();
  const kinds = {};
  for (const [kind, def] of Object.entries(KINDS)) kinds[kind] = { label: def.label, open: 0, ignored: 0, resolved: 0 };
  for (const row of rows) {
    if (!kinds[row.kind]) continue;
    if (row.status === "needs_review" || row.status === "suggested") kinds[row.kind].open += row.count;
    else if (row.status === "ignored") kinds[row.kind].ignored += row.count;
    else kinds[row.kind].resolved += row.count;
  }
  const open = Object.values(kinds).reduce((sum, kind) => sum + kind.open, 0);
  return { open, kinds };
}

function listReviewItems(db, { kind, status = "open", offset = 0, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (kind) {
    where.push("r.kind = ?");
    params.push(kind);
  }
  if (status === "open") where.push("r.status IN ('needs_review', 'suggested')");
  else if (status) {
    where.push("r.status = ?");
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS n FROM review_items r ${clause}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT r.*,
              t.title AS track_title, t.artist AS track_artist, t.album AS track_album,
              COALESCE(t.artwork_hash, tf.artwork_hash) AS track_artwork,
              rel.title AS release_title, rel.album_artist AS release_artist,
              f.path AS file_path, f.track_id AS file_track_id
       FROM review_items r
       LEFT JOIN tracks t ON r.entity_type = 'track' AND t.id = r.entity_id
       LEFT JOIN files tf ON tf.id = t.active_file_id
       LEFT JOIN releases rel ON r.entity_type = 'release' AND rel.id = r.entity_id
       LEFT JOIN files f ON r.entity_type = 'file' AND f.id = r.entity_id
       ${clause}
       ORDER BY r.status = 'suggested' DESC, r.kind, r.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, Math.min(500, Number(limit) || 100), Math.max(0, Number(offset) || 0))
    .map((row) => ({
      ...row,
      label: KINDS[row.kind]?.label || row.kind,
      details: parseJson(row.details, {}),
      suggestion: parseJson(row.suggestion, null),
    }));

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

module.exports = { KINDS, approveSuggestions, detectIssues, listReviewItems, refreshReview, reviewSummary, setReviewStatus };
