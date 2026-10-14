// Text normalization for grouping and matching. Keys are only used to find
// candidates; they never replace the user's displayed metadata.

const VERSION_PATTERNS = [
  ["live", /\blive\b|\bin concert\b|\bunplugged\b/],
  ["acoustic", /\bacoustic\b/],
  ["remix", /\bremix(?:ed)?\b|\brmx\b|\bbootleg\b/],
  ["remaster", /\bremaster(?:ed)?\b/],
  ["radio-edit", /\bradio (?:edit|version|mix)\b/],
  ["edit", /\b(?:single|album|clean|short) (?:edit|version)\b|\bedit\b/],
  ["extended", /\bextended\b|\bclub mix\b|\b12(?:''|"| inch)\b/],
  ["instrumental", /\binstrumental\b|\bkaraoke\b|\boff vocal\b/],
  ["demo", /\bdemo\b/],
  ["mix", /\bmix\b/],
  ["version", /\bversion\b|\bver\.?\b/],
  ["cover", /\bcover\b/],
  ["orchestral", /\borchestra(?:l)?\b|\bsymphonic\b/],
  ["piano", /\bpiano\b/],
  ["reprise", /\breprise\b/],
  ["sped-up", /\bsped up\b|\bnightcore\b|\bslowed\b/],
];

// Parenthesized or dashed segments that never distinguish recordings.
const NOISE_SEGMENT = /\b(?:official (?:music )?(?:video|audio)|lyric(?:s)? video|audio|hq|hd|explicit|clean|visualizer|mv)\b/;

function stripDiacritics(value) {
  return String(value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Lowercase, accent-free, punctuation-free, single-spaced. */
function normalizeKey(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[’'`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/\+/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Artist key: leading "The" and featured-artist credits removed. */
function artistKey(value) {
  const primary = String(value || "")
    .split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0];
  return normalizeKey(primary).replace(/^the /, "");
}

/** All credited artists, normalized (for "A & B" vs "A, B" comparisons). */
function artistParts(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/\s*(?:,|;|\/|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i)
        .map((part) => normalizeKey(part).replace(/^the /, ""))
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Splits a title into its base key and version markers, e.g.
 * "Simple and Clean (Live at Budokan) [Remastered 2021]" →
 * { key: "simple and clean", versions: ["live", "remaster"] }.
 * Featured-artist credits are dropped from the key.
 */
function parseTitle(value) {
  const raw = stripDiacritics(value).toLowerCase();
  const versions = new Set();
  let base = raw;

  // Bracketed and dash-separated qualifiers.
  const segments = [];
  base = base.replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner) => {
    segments.push(inner);
    return " ";
  });
  const dash = /\s[-–—]\s(.+)$/.exec(base);
  if (dash) {
    segments.push(dash[1]);
    base = base.slice(0, dash.index);
  }

  for (const segment of segments) {
    if (/\b(?:feat\.?|ft\.?|featuring|with)\b/.test(segment) && !VERSION_PATTERNS.some(([, re]) => re.test(segment))) {
      continue;
    }
    if (NOISE_SEGMENT.test(segment) && !VERSION_PATTERNS.some(([, re]) => re.test(segment))) continue;
    let matched = false;
    for (const [name, pattern] of VERSION_PATTERNS) {
      if (pattern.test(segment)) {
        versions.add(name);
        matched = true;
      }
    }
    // An unrecognized qualifier is kept as part of the identity, so
    // "(Part 2)" and "(Part 1)" never collapse together.
    if (!matched) base = `${base} ${segment}`;
  }

  // "Song feat. X" without brackets.
  base = base.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/)[0];

  // Generic "mix"/"version" only matter when nothing more specific was found.
  if (versions.size > 1) {
    if (versions.has("radio-edit")) versions.delete("edit");
    versions.delete("version");
    if ([...versions].some((name) => name !== "mix")) versions.delete("mix");
  }

  return { key: normalizeKey(base), versions: [...versions].sort() };
}

function titleKey(value) {
  const parsed = parseTitle(value);
  return parsed.versions.length ? `${parsed.key} [${parsed.versions.join(",")}]` : parsed.key;
}

/** Album key with edition qualifiers kept separately. */
function parseAlbum(value) {
  const raw = String(value || "");
  const editionMatch = /[([]\s*((?:[^)\]]*?\b(?:deluxe|expanded|anniversary|special|collector'?s|remaster(?:ed)?|bonus|edition|version)\b[^)\]]*?))\s*[)\]]/i.exec(raw);
  const edition = editionMatch ? editionMatch[1].trim() : "";
  const base = editionMatch ? raw.replace(editionMatch[0], " ") : raw;
  return { key: normalizeKey(base), edition: normalizeKey(edition) };
}

/** Windows-style path key for uniqueness (case-insensitive, normalized separators). */
function pathKey(filePath) {
  return String(filePath || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

module.exports = {
  artistKey,
  artistParts,
  normalizeKey,
  parseAlbum,
  parseTitle,
  pathKey,
  stripDiacritics,
  titleKey,
};
