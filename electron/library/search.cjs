// Keeps the FTS5 search index (track_search, rowid = tracks.id) in sync and
// turns user search text into safe FTS queries.

const { transaction } = require("./db.cjs");

const CHUNK = 500;

function refreshTrackSearch(db, trackIds) {
  const ids = [...new Set(trackIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return;

  const remove = db.prepare("DELETE FROM track_search WHERE rowid = ?");
  const insert = db.prepare(
    "INSERT INTO track_search (rowid, title, artist, album, album_artist, genre) VALUES (?, ?, ?, ?, ?, ?)",
  );

  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const rows = db
      .prepare(
        `SELECT id, title, artist, album, album_artist, genre FROM tracks
         WHERE state = 'active' AND id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk);
    const active = new Map(rows.map((row) => [row.id, row]));

    transaction(db, () => {
      for (const id of chunk) {
        remove.run(id);
        const row = active.get(id);
        if (row) insert.run(id, row.title, row.artist, row.album, row.album_artist, row.genre);
      }
    });
  }
}

/**
 * Converts free text into an FTS5 query: every word must match as a prefix,
 * in any column. User input never reaches FTS syntax unescaped.
 */
function toFtsQuery(text) {
  const words = String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");
}

module.exports = { refreshTrackSearch, toFtsQuery };
