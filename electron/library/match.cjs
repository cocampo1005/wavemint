// Recording matching for duplicate detection and library merges. Pure
// functions over plain track objects, so the rules are easy to test.
//
// Signals, strongest first:
//   - identical file content (SHA-256)            -> exact duplicate
//   - MusicBrainz recording IDs (equal / different)
//   - artist + base title, version markers (live, remix, remaster, edit…)
//   - duration difference, album, track number
// Different versions (live, acoustic, remix, radio edit…) are never treated
// as the same recording. A remaster is "uncertain": it may be the same
// performance with different mastering, so the user decides.

const { artistKey, artistParts, parseAlbum, parseTitle } = require("./normalize.cjs");

const SAME_THRESHOLD = 0.85;
const CURATED_ROLES = new Set(["curated", "managed"]);

function evidence(type, text, weight = 0) {
  return { type, text, weight };
}

function durationText(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Compares two tracks. Returns { verdict, score, evidence[] } where verdict
 * is "exact" | "same" | "uncertain" | "different".
 */
function compareTracks(a, b) {
  const notes = [];

  if (a.content_hash && b.content_hash && a.content_hash === b.content_hash) {
    return { verdict: "exact", score: 1, evidence: [evidence("exact", "Identical files (same content)")] };
  }

  const ta = parseTitle(a.title);
  const tb = parseTitle(b.title);
  if (!ta.key || ta.key !== tb.key) {
    return { verdict: "different", score: 0, evidence: [evidence("title", "Different titles")] };
  }

  const sameArtist =
    artistKey(a.artist) === artistKey(b.artist) ||
    artistParts(a.artist).some((part) => artistParts(b.artist).includes(part));
  if (!sameArtist) {
    return { verdict: "different", score: 0, evidence: [evidence("artist", "Different artists")] };
  }

  if (a.mb_recording_id && b.mb_recording_id) {
    if (a.mb_recording_id !== b.mb_recording_id) {
      return { verdict: "different", score: 0, evidence: [evidence("musicbrainz", "Different MusicBrainz recordings")] };
    }
    notes.push(evidence("musicbrainz", "Same MusicBrainz recording", 0.2));
  }

  // Version markers must agree.
  const va = new Set(ta.versions);
  const vb = new Set(tb.versions);
  const onlyA = ta.versions.filter((version) => !vb.has(version));
  const onlyB = tb.versions.filter((version) => !va.has(version));
  let uncertain = false;
  if (onlyA.length || onlyB.length) {
    const differing = [...onlyA, ...onlyB];
    if (differing.every((version) => version === "remaster")) {
      uncertain = true;
      notes.push(evidence("version", "One is labeled as a remaster", -0.2));
    } else {
      const describe = (list) => (list.length ? list.join(", ") : "original");
      return {
        verdict: "different",
        score: 0.2,
        evidence: [evidence("version", `Different versions: ${describe(ta.versions)} vs ${describe(tb.versions)}`)],
      };
    }
  } else if (ta.versions.length) {
    notes.push(evidence("version", `Both: ${ta.versions.join(", ")}`));
  }

  notes.push(evidence("title", "Same artist and title", 0.75));
  let score = 0.75 + notes.filter((note) => note.type === "musicbrainz").length * 0.2;

  if (a.duration_ms && b.duration_ms) {
    const difference = Math.abs(a.duration_ms - b.duration_ms);
    if (difference <= 1000) {
      score += 0.15;
      notes.push(evidence("duration", `Same length (±${durationText(difference)})`, 0.15));
    } else if (difference <= 2000) {
      score += 0.1;
      notes.push(evidence("duration", `Lengths differ by ${durationText(difference)}`, 0.1));
    } else if (difference <= 20000) {
      uncertain = true;
      score -= 0.15;
      notes.push(evidence("duration", `Lengths differ by ${durationText(difference)} (a different edit?)`, -0.15));
    } else {
      return {
        verdict: "different",
        score: 0.3,
        evidence: [...notes, evidence("duration", `Lengths differ by ${durationText(difference)}`)],
      };
    }
  } else {
    uncertain = true;
    notes.push(evidence("duration", "Length unknown for one of them"));
  }

  const albumA = parseAlbum(a.album);
  const albumB = parseAlbum(b.album);
  if (albumA.key && albumA.key === albumB.key) {
    score += 0.05;
    notes.push(evidence("album", albumA.edition === albumB.edition ? "Same album" : "Same album, different editions", 0.05));
    if (a.track_no && a.track_no === b.track_no) score += 0.03;
  } else if (a.album && b.album) {
    notes.push(evidence("album", `Different albums: "${a.album}" / "${b.album}"`));
  }

  score = Math.min(0.99, Math.max(0, score));
  const verdict = !uncertain && score >= SAME_THRESHOLD ? "same" : "uncertain";
  return { verdict, score: Math.round(score * 100) / 100, evidence: notes };
}

/** Block key: candidates must share primary artist and base title. */
function blockKey(track) {
  const title = parseTitle(track.title).key;
  const artist = artistKey(track.artist);
  return title && artist ? `${artist}|${title}` : null;
}

function qualityRank(track) {
  return (track.lossless ? 10000 : 0) + (Number(track.bitrate) || 0);
}

/** The member to keep active: highest source priority, then audio quality. */
function choosePreferred(members) {
  return [...members].sort(
    (a, b) =>
      (b.source_priority || 0) - (a.source_priority || 0) ||
      qualityRank(b) - qualityRank(a) ||
      a.id - b.id,
  )[0];
}

function categoryFor(members) {
  const roles = new Set(members.map((track) => track.source_role));
  const curated = [...roles].some((role) => CURATED_ROLES.has(role));
  const legacy = roles.has("legacy");
  const other = roles.has("other");
  if (curated && (legacy || other)) return "already_curated";
  if (curated) return "curated_only";
  if (legacy) return "legacy_only";
  return other ? "other_only" : "legacy_only";
}

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Groups tracks into recordings. `decisions` maps "a:b" (a < b) to
 * "same" | "different". Returns { groups, conflicts, pairs }.
 */
function buildGroups(tracks, { decisions = new Map() } = {}) {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const parent = new Map(tracks.map((track) => [track.id, track.id]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => parent.set(find(a), find(b));

  // Candidate pairs: same block, or identical content anywhere.
  const blocks = new Map();
  const byHash = new Map();
  for (const track of tracks) {
    const key = blockKey(track);
    if (key) {
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(track);
    }
    if (track.content_hash) {
      if (!byHash.has(track.content_hash)) byHash.set(track.content_hash, []);
      byHash.get(track.content_hash).push(track);
    }
  }

  const pairs = new Map();
  const consider = (a, b) => {
    const key = pairKey(a.id, b.id);
    if (pairs.has(key)) return;
    const decision = decisions.get(key);
    const result = compareTracks(a, b);
    pairs.set(key, { a: a.id, b: b.id, ...result, decision: decision || null });
  };

  for (const group of [...blocks.values(), ...byHash.values()]) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) consider(group[i], group[j]);
    }
  }
  // Decisions also apply to pairs that matching would not pair up.
  for (const [key, decision] of decisions) {
    const [a, b] = key.split(":").map(Number);
    if (byId.has(a) && byId.has(b) && !pairs.has(key)) {
      pairs.set(key, { a, b, verdict: "different", score: 0, evidence: [], decision });
    }
  }

  for (const pair of pairs.values()) {
    if (pair.decision === "different") continue;
    if (pair.decision === "same" || pair.verdict === "exact" || pair.verdict === "same") union(pair.a, pair.b);
  }

  // A decided "different" pair must never end up in one group through a
  // third song; such links are reported as conflicts instead.
  const clusters = new Map();
  for (const track of tracks) {
    const root = find(track.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(track);
  }

  const groups = [];
  for (const members of clusters.values()) {
    const ids = new Set(members.map((track) => track.id));
    const memberPairs = [...pairs.values()].filter((pair) => ids.has(pair.a) && ids.has(pair.b));
    const linking = memberPairs.filter((pair) => pair.decision === "same" || pair.verdict === "exact" || pair.verdict === "same");
    const exactOnly = linking.length > 0 && linking.every((pair) => pair.verdict === "exact");
    const preferred = choosePreferred(members);

    groups.push({
      category: categoryFor(members),
      trackIds: members.map((track) => track.id).sort((a, b) => a - b),
      preferredTrackId: preferred.id,
      confidence: linking.length ? Math.min(...linking.map((pair) => (pair.decision === "same" ? 1 : pair.score))) : null,
      exact: exactOnly,
      evidence: linking.slice(0, 6).map((pair) => ({ a: pair.a, b: pair.b, verdict: pair.decision === "same" ? "confirmed" : pair.verdict, notes: pair.evidence })),
    });
  }

  // Uncertain pairs between different groups need the user's decision.
  const groupOf = new Map();
  groups.forEach((group, index) => group.trackIds.forEach((id) => groupOf.set(id, index)));
  const conflicts = [];
  for (const pair of pairs.values()) {
    if (pair.decision || pair.verdict !== "uncertain") continue;
    if (groupOf.get(pair.a) === groupOf.get(pair.b)) continue;
    const members = [byId.get(pair.a), byId.get(pair.b)];
    conflicts.push({
      category: "conflict",
      trackIds: [pair.a, pair.b].sort((x, y) => x - y),
      preferredTrackId: choosePreferred(members).id,
      confidence: pair.score,
      evidence: [{ a: pair.a, b: pair.b, verdict: pair.verdict, notes: pair.evidence }],
    });
  }

  return { groups, conflicts, pairs: [...pairs.values()] };
}

/**
 * After merging, the remaining songs of a partially superseded legacy album
 * can join the curated album they belong to. Proposals only cover albums
 * with the same (or near-identical) name and the same edition; different
 * editions are reported, never merged.
 */
function albumConsolidation({ groups, tracksById, releasesById, similarTitles }) {
  const links = new Map(); // "legacyRelease>curatedRelease" -> count
  const superseded = new Set();

  for (const group of groups) {
    if (group.category !== "already_curated" || group.action === "keep_both" || group.action === "skip") continue;
    const preferred = tracksById.get(group.preferredTrackId);
    if (!preferred?.release_id) continue;
    for (const id of group.trackIds) {
      if (id === preferred.id) continue;
      superseded.add(id);
      const member = tracksById.get(id);
      if (!member?.release_id || member.release_id === preferred.release_id) continue;
      const key = `${member.release_id}>${preferred.release_id}`;
      links.set(key, (links.get(key) || 0) + 1);
    }
  }

  const proposals = [];
  const notes = [];
  for (const [key, count] of links) {
    const [fromId, toId] = key.split(">").map(Number);
    const from = releasesById.get(fromId);
    const to = releasesById.get(toId);
    if (!from || !to) continue;
    const sameName = parseAlbum(from.title).key === parseAlbum(to.title).key || similarTitles(from.title, to.title);
    if (!sameName) continue;
    if (from.edition !== to.edition) {
      notes.push({ fromReleaseId: fromId, toReleaseId: toId, text: `"${from.title}" and "${to.title}" are different editions; their songs stay separate.` });
      continue;
    }
    const remaining = [...tracksById.values()].filter((track) => track.release_id === fromId && !superseded.has(track.id));
    if (!remaining.length) continue;
    proposals.push({
      fromReleaseId: fromId,
      toReleaseId: toId,
      fromTitle: from.title,
      toTitle: to.title,
      matched: count,
      trackIds: remaining.map((track) => track.id),
      fields: { album: to.title, albumArtist: to.album_artist || undefined, year: to.year || undefined },
    });
  }

  return { proposals, notes };
}

module.exports = {
  CURATED_ROLES,
  SAME_THRESHOLD,
  albumConsolidation,
  blockKey,
  buildGroups,
  categoryFor,
  choosePreferred,
  compareTracks,
  pairKey,
};
