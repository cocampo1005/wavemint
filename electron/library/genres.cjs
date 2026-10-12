// The user's genre taxonomy, label mapping and deterministic genre rules.
//
// - tracks.genre is the primary genre written into files (Apple compatible).
// - genres is the user's taxonomy; genre_aliases maps other spellings and
//   imported labels onto it.
// - genre_rules give artists or albums a default genre.
//
// Rule precedence for a track's genre (highest first):
//   1. a genre set manually in WaveMint (curated) — never changed by rules;
//   2. an album rule;
//   3. an artist rule;
//   4. an alias mapping of the track's current label.

const { nowIso, parseJson, transaction } = require("./db.cjs");
const { applyEdits } = require("./edits.cjs");
const { artistKey, normalizeKey } = require("./normalize.cjs");
const { finishOperation, logChange, startOperation } = require("./operations.cjs");

class GenreError extends Error {}

function cleanName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new GenreError("Enter a genre name.");
  return name;
}

function compactKey(value) {
  return normalizeKey(value).replace(/\band\b/g, "").replace(/\s+/g, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let last = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = temp;
    }
  }
  return previous[b.length];
}

function similar(a, b) {
  const ka = compactKey(a);
  const kb = compactKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return Math.min(ka.length, kb.length) >= 6 && levenshtein(ka, kb) <= (Math.max(ka.length, kb.length) >= 12 ? 2 : 1);
}

function getGenre(db, id) {
  const genre = db.prepare("SELECT * FROM genres WHERE id = ?").get(Number(id));
  if (!genre) throw new GenreError("This genre no longer exists.");
  return genre;
}

function listTaxonomy(db) {
  const genres = db
    .prepare(
      `SELECT g.*, p.name AS parent_name,
              (SELECT COUNT(*) FROM tracks t WHERE t.state = 'active' AND t.genre = g.name COLLATE NOCASE) AS track_count
       FROM genres g LEFT JOIN genres p ON p.id = g.parent_id
       ORDER BY COALESCE(p.name, g.name) COLLATE NOCASE, g.parent_id IS NOT NULL, g.name COLLATE NOCASE`,
    )
    .all();
  const aliases = db.prepare("SELECT alias, genre_id FROM genre_aliases ORDER BY alias COLLATE NOCASE").all();
  return genres.map((genre) => ({ ...genre, aliases: aliases.filter((alias) => alias.genre_id === genre.id).map((alias) => alias.alias) }));
}

function createGenre(db, { name, parentId = null, description = "" }) {
  const clean = cleanName(name);
  if (db.prepare("SELECT 1 FROM genres WHERE name = ? COLLATE NOCASE").get(clean)) {
    throw new GenreError(`"${clean}" is already in your genres.`);
  }
  if (parentId) getGenre(db, parentId);
  const id = Number(
    db
      .prepare("INSERT INTO genres (name, parent_id, description, created_at) VALUES (?, ?, ?, ?)")
      .run(clean, parentId || null, String(description || "").slice(0, 300), nowIso()).lastInsertRowid,
  );
  // A label that was an alias becomes a real genre.
  db.prepare("DELETE FROM genre_aliases WHERE alias_key = ?").run(normalizeKey(clean));
  return { id, name: clean };
}

/** Adds every genre label currently used in the library to the taxonomy. */
function adoptLabels(db, { labels } = {}) {
  const used = labels?.length
    ? labels
    : db.prepare("SELECT DISTINCT genre FROM tracks WHERE state = 'active' AND genre != ''").all().map((row) => row.genre);
  let added = 0;
  for (const label of used) {
    const name = String(label).trim();
    if (!name || db.prepare("SELECT 1 FROM genres WHERE name = ? COLLATE NOCASE").get(name)) continue;
    if (db.prepare("SELECT 1 FROM genre_aliases WHERE alias_key = ?").get(normalizeKey(name))) continue;
    createGenre(db, { name });
    added += 1;
  }
  return { added };
}

function setParent(db, { id, parentId }) {
  const genre = getGenre(db, id);
  if (parentId) {
    getGenre(db, parentId);
    // No cycles: the new parent can't be this genre or one of its children.
    let cursor = Number(parentId);
    while (cursor) {
      if (cursor === genre.id) throw new GenreError("A genre can't be placed under itself.");
      cursor = db.prepare("SELECT parent_id FROM genres WHERE id = ?").get(cursor)?.parent_id || 0;
    }
  }
  db.prepare("UPDATE genres SET parent_id = ? WHERE id = ?").run(parentId || null, genre.id);
  return { id: genre.id };
}

/**
 * Renames a genre and retags every song that uses it (one undoable
 * operation). The old name is kept as an alias.
 */
function renameGenre(db, { id, name }) {
  const genre = getGenre(db, id);
  const clean = cleanName(name);
  const clash = db.prepare("SELECT id FROM genres WHERE name = ? COLLATE NOCASE AND id != ?").get(clean, genre.id);
  if (clash) throw new GenreError(`"${clean}" already exists. Merge the two genres instead.`);

  let result = null;
  transaction(db, () => {
    db.prepare("UPDATE genres SET name = ? WHERE id = ?").run(clean, genre.id);
    if (normalizeKey(genre.name) !== normalizeKey(clean)) {
      db.prepare(
        "INSERT INTO genre_aliases (alias_key, alias, genre_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_key) DO UPDATE SET genre_id = excluded.genre_id",
      ).run(normalizeKey(genre.name), genre.name, genre.id, nowIso());
    }
    const trackIds = db.prepare("SELECT id FROM tracks WHERE state = 'active' AND genre = ? COLLATE NOCASE").all(genre.name).map((row) => row.id);
    result = applyEdits(
      db,
      trackIds.map((trackId) => ({ trackId, fields: { genre: clean } })),
      { label: `Rename genre "${genre.name}" to "${clean}"`, kind: "genre", markCurated: false },
    );
  });
  return { id: genre.id, name: clean, ...result };
}

/**
 * Merges genres and/or raw labels into one taxonomy genre: songs are
 * retagged and the merged names become aliases.
 */
function mergeGenres(db, { targetId, genreIds = [], labels = [] }) {
  const target = getGenre(db, targetId);
  const names = new Set(labels.map((label) => String(label).trim()).filter(Boolean));
  for (const id of genreIds) {
    if (Number(id) === target.id) continue;
    names.add(getGenre(db, id).name);
  }
  names.delete(target.name);

  let result = null;
  transaction(db, () => {
    const trackIds = [];
    for (const name of names) {
      db.prepare(
        "INSERT INTO genre_aliases (alias_key, alias, genre_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_key) DO UPDATE SET genre_id = excluded.genre_id",
      ).run(normalizeKey(name), name, target.id, nowIso());
      trackIds.push(...db.prepare("SELECT id FROM tracks WHERE state = 'active' AND genre = ? COLLATE NOCASE").all(name).map((row) => row.id));
      const merged = db.prepare("SELECT id FROM genres WHERE name = ? COLLATE NOCASE").get(name);
      if (merged) {
        db.prepare("UPDATE genres SET parent_id = ? WHERE parent_id = ?").run(target.id, merged.id);
        db.prepare("UPDATE genre_rules SET genre_id = ? WHERE genre_id = ?").run(target.id, merged.id);
        db.prepare("DELETE FROM genres WHERE id = ?").run(merged.id);
      }
    }
    result = applyEdits(
      db,
      trackIds.map((trackId) => ({ trackId, fields: { genre: target.name } })),
      { label: `Merge ${[...names].map((name) => `"${name}"`).join(", ")} into "${target.name}"`, kind: "genre", markCurated: false },
    );
  });
  return { targetId: target.id, merged: [...names], ...result };
}

/** Removes a genre from the taxonomy (songs keep their label). */
function deleteGenre(db, { id }) {
  const genre = getGenre(db, id);
  db.prepare("DELETE FROM genres WHERE id = ?").run(genre.id);
  return { deleted: genre.name };
}

function addAlias(db, { alias, genreId }) {
  const genre = getGenre(db, genreId);
  const clean = cleanName(alias);
  if (db.prepare("SELECT 1 FROM genres WHERE name = ? COLLATE NOCASE").get(clean)) {
    throw new GenreError(`"${clean}" is a genre of its own. Merge it instead.`);
  }
  db.prepare(
    "INSERT INTO genre_aliases (alias_key, alias, genre_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias_key) DO UPDATE SET genre_id = excluded.genre_id, alias = excluded.alias",
  ).run(normalizeKey(clean), clean, genre.id, nowIso());
  return { alias: clean, genre: genre.name };
}

function removeAlias(db, { alias }) {
  db.prepare("DELETE FROM genre_aliases WHERE alias_key = ?").run(normalizeKey(alias));
  return { removed: true };
}

/**
 * Labels used by songs that aren't in the taxonomy, with a suggested genre
 * (alias or similar spelling), and groups of near-identical names.
 */
function genreReport(db) {
  const taxonomy = db.prepare("SELECT id, name FROM genres").all();
  const aliases = db.prepare("SELECT a.alias_key, g.id, g.name FROM genre_aliases a JOIN genres g ON g.id = a.genre_id").all();
  const aliasByKey = new Map(aliases.map((alias) => [alias.alias_key, alias]));
  const known = new Set(taxonomy.map((genre) => genre.name.toLowerCase()));
  const labels = db
    .prepare(
      `SELECT genre AS label, COUNT(*) AS track_count FROM tracks
       WHERE state = 'active' AND genre != '' GROUP BY genre COLLATE NOCASE ORDER BY track_count DESC`,
    )
    .all();

  const unrecognized = labels
    .filter((row) => !known.has(row.label.toLowerCase()))
    .map((row) => {
      const alias = aliasByKey.get(normalizeKey(row.label));
      const near = alias ? null : taxonomy.find((genre) => similar(genre.name, row.label));
      const suggestion = alias || near;
      return {
        ...row,
        suggestion: suggestion ? { id: suggestion.id, name: suggestion.name, reason: alias ? "alias" : "similar spelling" } : null,
      };
    });

  // Near-duplicates among taxonomy genres and labels in use.
  const names = [...new Set([...taxonomy.map((genre) => genre.name), ...labels.map((row) => row.label)])];
  const groups = [];
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    const group = names.filter((other) => !seen.has(other.toLowerCase()) && similar(name, other));
    if (group.length > 1) {
      group.forEach((item) => seen.add(item.toLowerCase()));
      groups.push(group);
    }
  }

  return { unrecognized, similar: groups, taxonomyCount: taxonomy.length };
}

// --- Rules -----------------------------------------------------------------

function listRules(db) {
  return db
    .prepare(
      `SELECT r.*, g.name AS genre_name,
              CASE r.kind
                WHEN 'artist' THEN (SELECT COUNT(*) FROM tracks t WHERE t.state = 'active' AND t.artist_key = r.match_key)
                ELSE (SELECT COUNT(*) FROM tracks t WHERE t.state = 'active' AND t.release_id = CAST(r.match_key AS INTEGER))
              END AS track_count
       FROM genre_rules r JOIN genres g ON g.id = r.genre_id
       ORDER BY r.kind, r.match_label COLLATE NOCASE`,
    )
    .all();
}

function addRule(db, { kind, artist, releaseId, genreId }) {
  const genre = getGenre(db, genreId);
  let matchKey;
  let matchLabel;
  if (kind === "artist") {
    matchLabel = cleanName(artist);
    matchKey = artistKey(matchLabel);
  } else if (kind === "album") {
    const release = db.prepare("SELECT id, title, album_artist FROM releases WHERE id = ?").get(Number(releaseId));
    if (!release) throw new GenreError("This album no longer exists.");
    matchKey = String(release.id);
    matchLabel = `${release.title}${release.album_artist ? ` — ${release.album_artist}` : ""}`;
  } else {
    throw new GenreError("Unknown rule type.");
  }
  db.prepare(
    `INSERT INTO genre_rules (kind, match_key, match_label, genre_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(kind, match_key) DO UPDATE SET genre_id = excluded.genre_id, enabled = 1`,
  ).run(kind, matchKey, matchLabel, genre.id, nowIso());
  return { kind, matchLabel, genre: genre.name };
}

function updateRule(db, { id, enabled }) {
  db.prepare("UPDATE genre_rules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, Number(id));
  return { id };
}

function removeRule(db, { id }) {
  db.prepare("DELETE FROM genre_rules WHERE id = ?").run(Number(id));
  return { removed: true };
}

/**
 * Genre changes the rules (and aliases) would make. Manually set genres are
 * never touched.
 */
function previewRules(db) {
  const rules = db.prepare("SELECT r.*, g.name AS genre_name FROM genre_rules r JOIN genres g ON g.id = r.genre_id WHERE r.enabled = 1").all();
  const albumRules = new Map(rules.filter((rule) => rule.kind === "album").map((rule) => [Number(rule.match_key), rule]));
  const artistRules = new Map(rules.filter((rule) => rule.kind === "artist").map((rule) => [rule.match_key, rule]));
  const aliases = new Map(
    db.prepare("SELECT a.alias_key, g.name FROM genre_aliases a JOIN genres g ON g.id = a.genre_id").all().map((row) => [row.alias_key, row.name]),
  );

  const proposals = [];
  const tracks = db.prepare("SELECT id, title, artist, artist_key, release_id, genre, curated_fields FROM tracks WHERE state = 'active'").all();
  for (const track of tracks) {
    if (parseJson(track.curated_fields, []).includes("genre")) continue;
    let target = null;
    let reason = null;
    const albumRule = track.release_id ? albumRules.get(track.release_id) : null;
    const artistRule = artistRules.get(track.artist_key);
    if (albumRule) {
      target = albumRule.genre_name;
      reason = `Album rule: ${albumRule.match_label}`;
    } else if (artistRule) {
      target = artistRule.genre_name;
      reason = `Artist rule: ${artistRule.match_label}`;
    } else if (track.genre && aliases.has(normalizeKey(track.genre))) {
      target = aliases.get(normalizeKey(track.genre));
      reason = `"${track.genre}" maps to "${target}"`;
    }
    if (target && target !== track.genre) {
      proposals.push({ trackId: track.id, title: track.title, artist: track.artist, from: track.genre, to: target, reason });
    }
  }
  return proposals;
}

function applyRules(db, { exclude = [] } = {}) {
  const skip = new Set(exclude.map(Number));
  const proposals = previewRules(db).filter((item) => !skip.has(item.trackId));
  // Rule results are not manual curation, so later rule changes can update
  // them; a manual edit still always wins.
  return applyEdits(
    db,
    proposals.map((item) => ({ trackId: item.trackId, fields: { genre: item.to } })),
    { label: `Apply genre rules to ${proposals.length} song${proposals.length === 1 ? "" : "s"}`, kind: "genre", markCurated: false },
  );
}

/** Internal secondary genre labels (not written to files). */
function setSecondaryGenres(db, { trackIds, genreIds }) {
  const ids = genreIds.map(Number);
  for (const id of ids) getGenre(db, id);
  let operationId = null;
  transaction(db, () => {
    operationId = startOperation(db, { kind: "secondary-genres", label: "Set additional genres", undoable: false });
    for (const trackId of trackIds) {
      const before = db.prepare("SELECT genre_id FROM track_genres WHERE track_id = ?").all(trackId).map((row) => row.genre_id);
      db.prepare("DELETE FROM track_genres WHERE track_id = ?").run(trackId);
      for (const id of ids) db.prepare("INSERT OR IGNORE INTO track_genres (track_id, genre_id) VALUES (?, ?)").run(trackId, id);
      logChange(db, operationId, { entityId: trackId, field: "secondary_genres", oldValue: before, newValue: ids });
    }
    finishOperation(db, operationId, "completed", { tracks: trackIds.length });
  });
  return { operationId };
}

module.exports = {
  GenreError,
  addAlias,
  addRule,
  adoptLabels,
  applyRules,
  createGenre,
  deleteGenre,
  genreReport,
  levenshtein,
  listRules,
  listTaxonomy,
  mergeGenres,
  previewRules,
  removeAlias,
  removeRule,
  renameGenre,
  setParent,
  setSecondaryGenres,
  similar,
  updateRule,
};
