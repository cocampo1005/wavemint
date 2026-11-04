// Duplicate detection inside the library (Review → Possible Duplicates).
// Pure functions over plain track objects, so the rules are easy to test.
//
// Conservative by design: precision over recall. Three tiers:
//   - identical: the same file content (SHA-256, the same audio stream, or the
//     same size and first/last 64 KB);
//   - likely:    the same artist and title (version markers included) and the
//     same length, as the library merge's matcher (match.cjs) decides;
//   - possible:  the matcher is unsure (a remaster label, lengths a few seconds
//     apart) or the titles are nearly identical ("The Blinding Lights" vs
//     "Blinding Lights") with the same artist, versions and length.
// Different versions (live, remix, acoustic, radio edit, instrumental…) and
// different lengths are never paired. Nothing here changes anything: merging
// or keeping both is always the user's decision.

const { compareTracks, pairKey } = require("./match.cjs");
const { artistParts, parseTitle } = require("./normalize.cjs");

const TIER_RANK = { identical: 3, likely: 2, possible: 1 };
const FUZZY_MAX_LENGTH_DIFFERENCE_MS = 2000;

/** Levenshtein similarity in [0, 1] (1 = equal). */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** The title's key without a leading article and spaces ("the blinding lights" → "blindinglights"). */
function looseTitle(key) {
  return key.replace(/^(?:the|a|an) /, "").replace(/ /g, "");
}

/**
 * Titles that differ only slightly: the same words once articles and spacing
 * are ignored, or a one- or two-letter difference in a longer title. Version
 * markers must be equal (checked by the caller through parseTitle).
 */
function nearlySameTitle(ta, tb) {
  const a = looseTitle(ta.key);
  const b = looseTitle(tb.key);
  if (!a || !b) return null;
  if (a === b) return "The titles differ only in spacing or a leading “The”";
  // Short titles ("Home" / "Hope") are too easily confused to compare loosely.
  if (Math.min(a.length, b.length) < 8) return null;
  // Numbers distinguish songs ("Part 1" / "Part 2", "22" / "23").
  if (a.replace(/\D/g, "") !== b.replace(/\D/g, "")) return null;
  return similarity(a, b) >= 0.9 ? "The titles are nearly identical" : null;
}

function sameVersions(ta, tb) {
  return ta.versions.length === tb.versions.length && ta.versions.every((version, index) => version === tb.versions[index]);
}

function identicalReason(a, b) {
  if (a.content_hash && a.content_hash === b.content_hash) return "Identical files (same content)";
  if (a.audio_hash && a.audio_hash === b.audio_hash) return "The same audio (only the tags differ)";
  if (a.quick_sig && a.quick_sig === b.quick_sig && a.size && a.size === b.size) return "Identical files (same size and content signature)";
  return null;
}

/**
 * Compares two tracks for the duplicate review. Returns null (not a duplicate)
 * or { tier, confidence, reasons[] }.
 */
function compareForDuplicates(a, b) {
  const identical = identicalReason(a, b);
  if (identical) return { tier: "identical", confidence: 1, reasons: [identical] };

  const result = compareTracks(a, b);
  const positive = result.evidence.filter((item) => item.weight >= 0 && item.type !== "title").map((item) => item.text);
  if (result.verdict === "same") return { tier: "likely", confidence: result.score, reasons: ["Same artist and title", ...positive] };
  if (result.verdict === "uncertain") {
    // An unknown length is too little to go on.
    if (!a.duration_ms || !b.duration_ms) return null;
    return { tier: "possible", confidence: result.score, reasons: ["Same artist and title", ...result.evidence.filter((item) => item.type !== "title").map((item) => item.text)] };
  }

  // Nearly identical titles by the same artist, same versions, same length.
  const ta = parseTitle(a.title);
  const tb = parseTitle(b.title);
  if (!ta.key || !tb.key || ta.key === tb.key || !sameVersions(ta, tb)) return null;
  const partsB = artistParts(b.artist);
  if (!artistParts(a.artist).some((part) => partsB.includes(part))) return null;
  if (a.mb_recording_id && b.mb_recording_id && a.mb_recording_id !== b.mb_recording_id) return null;
  if (!a.duration_ms || !b.duration_ms || Math.abs(a.duration_ms - b.duration_ms) > FUZZY_MAX_LENGTH_DIFFERENCE_MS) return null;
  const titleReason = nearlySameTitle(ta, tb);
  if (!titleReason) return null;
  const difference = Math.abs(a.duration_ms - b.duration_ms);
  return { tier: "possible", confidence: 0.6, reasons: [titleReason, "Same artist", `Same length (±${(difference / 1000).toFixed(1)} s)`] };
}

/**
 * Finds duplicate groups among active tracks. `decisions` maps "a:b" (a < b)
 * to "same" | "different" (Keep Both records "different", which is final).
 * Returns { strong: [...], possible: [...] }: identical/likely groups, and
 * possible matches that aren't already inside one strong group. Each group is
 * { trackIds, tier, confidence, reasons }.
 */
function findDuplicates(tracks, { decisions = new Map() } = {}) {
  const pairs = [];
  const seen = new Set();
  const consider = (a, b) => {
    if (a.id === b.id) return;
    const key = pairKey(a.id, b.id);
    if (seen.has(key)) return;
    seen.add(key);
    if (decisions.get(key) === "different") return;
    const result = compareForDuplicates(a, b);
    if (result) pairs.push({ a: Math.min(a.id, b.id), b: Math.max(a.id, b.id), ...result });
  };

  // Candidates: identical signatures anywhere, and songs sharing a credited artist.
  const buckets = new Map();
  const bucket = (key, track) => {
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(track);
  };
  for (const track of tracks) {
    if (track.content_hash) bucket(`c:${track.content_hash}`, track);
    if (track.audio_hash) bucket(`a:${track.audio_hash}`, track);
    if (track.quick_sig) bucket(`q:${track.quick_sig}`, track);
    for (const part of artistParts(track.artist)) bucket(`artist:${part}`, track);
  }
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) consider(list[i], list[j]);
    }
  }

  const components = (links) => {
    const parent = new Map();
    const find = (id) => {
      if (!parent.has(id)) parent.set(id, id);
      while (parent.get(id) !== id) {
        parent.set(id, parent.get(parent.get(id)));
        id = parent.get(id);
      }
      return id;
    };
    for (const link of links) parent.set(find(link.a), find(link.b));
    const groups = new Map();
    for (const link of links) {
      const root = find(link.a);
      if (!groups.has(root)) groups.set(root, { ids: new Set(), links: [] });
      const group = groups.get(root);
      group.ids.add(link.a);
      group.ids.add(link.b);
      group.links.push(link);
    }
    return [...groups.values()];
  };

  const describe = ({ ids, links }) => {
    const weakest = links.reduce((low, link) => (TIER_RANK[link.tier] < TIER_RANK[low.tier] ? link : low), links[0]);
    return {
      trackIds: [...ids].sort((x, y) => x - y),
      tier: weakest.tier,
      confidence: Math.min(...links.map((link) => link.confidence)),
      reasons: [...new Set(links.flatMap((link) => link.reasons))].slice(0, 6),
    };
  };

  const strong = components(pairs.filter((pair) => pair.tier !== "possible")).map(describe);
  const groupOf = new Map();
  strong.forEach((group, index) => group.trackIds.forEach((id) => groupOf.set(id, index)));
  const possibleLinks = pairs.filter((pair) => pair.tier === "possible" && !(groupOf.has(pair.a) && groupOf.get(pair.a) === groupOf.get(pair.b)));
  const possible = components(possibleLinks).map(describe);
  return { strong, possible };
}

/**
 * What the files of a group are right now: a dismissed warning comes back only
 * when this changes (a song's file replaced or edited, a song joining).
 */
function filesSignature(tracks) {
  return tracks
    .map((track) => `${track.id}:${track.file_id || 0}:${track.size || 0}:${track.quick_sig || ""}`)
    .sort()
    .join("|");
}

module.exports = { compareForDuplicates, filesSignature, findDuplicates, nearlySameTitle, similarity };
