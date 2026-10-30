// Matching for the metadata pickers (Artist, Album, Genre): names are
// compared ignoring case and surrounding/repeated whitespace, and the first
// spelling seen is the one kept and shown.

/** The comparison key of a name: trimmed, inner whitespace collapsed, lower case. */
export const nameKey = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** `names` without blanks or case/whitespace duplicates, in their original order and spelling. */
export function uniqueNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const clean = String(name ?? "").trim();
    const key = nameKey(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

/** The library's spelling of `value` when `names` has it, else null. */
export function findName(names, value) {
  const key = nameKey(value);
  return key ? names.find((name) => nameKey(name) === key) ?? null : null;
}

/**
 * The names matching `query`: names that start with it first, then names
 * with a word that starts with it, then names containing it anywhere. Each
 * group keeps the order of `names`. An empty query matches nothing.
 */
export function rankSuggestions(names, query, limit = Infinity) {
  const key = nameKey(query);
  if (!key) return [];
  const groups = [[], [], []];
  for (const name of names) {
    const candidate = nameKey(name);
    const at = candidate.indexOf(key);
    if (at < 0) continue;
    if (at === 0) groups[0].push(name);
    else if (/[\s\-/&(.,]/.test(candidate[at - 1])) groups[1].push(name);
    else groups[2].push(name);
  }
  return groups.flat().slice(0, limit);
}
