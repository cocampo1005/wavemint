// MusicBrainz web service (https://musicbrainz.org/doc/MusicBrainz_API) and
// the Cover Art Archive, normalized into small plain objects. Only data the
// services return is used; nothing is guessed or filled in.

const MB = "https://musicbrainz.org/ws/2";
const CAA = "https://coverartarchive.org";
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Escapes a value for a Lucene phrase query. */
function phrase(value) {
  return `"${String(value || "").replace(/[\\"]/g, (char) => `\\${char}`).trim()}"`;
}

function creditName(credits) {
  if (!Array.isArray(credits) || !credits.length) return null;
  return credits.map((credit) => `${credit.name ?? credit.artist?.name ?? ""}${credit.joinphrase ?? ""}`).join("").trim() || null;
}

function yearOf(date) {
  const match = /^(\d{4})/.exec(String(date || ""));
  return match ? Number(match[1]) : null;
}

function trackNumber(value) {
  const number = Number(String(value ?? "").replace(/^\D+/, ""));
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeRelease(release, recordingArtist) {
  const group = release["release-group"] || {};
  const medium = (release.media || [])[0] || null;
  const track = medium?.track?.[0] || medium?.tracks?.[0] || null;
  return {
    id: release.id,
    title: release.title,
    artist: creditName(release["artist-credit"]) || recordingArtist || null,
    date: release.date || null,
    year: yearOf(release.date),
    country: release.country || null,
    status: release.status || null,
    releaseGroupId: group.id || null,
    primaryType: group["primary-type"] || null,
    secondaryTypes: group["secondary-types"] || [],
    trackCount: medium?.["track-count"] ?? release["track-count"] ?? null,
    discNo: medium?.position ?? null,
    trackNo: trackNumber(track?.number ?? track?.position),
    format: medium?.format || null,
  };
}

function normalizeRecording(recording) {
  const artist = creditName(recording["artist-credit"]);
  return {
    id: recording.id,
    title: recording.title,
    artist,
    artistIds: (recording["artist-credit"] || []).map((credit) => credit.artist?.id).filter(Boolean),
    lengthMs: Number.isFinite(recording.length) ? recording.length : null,
    disambiguation: recording.disambiguation || "",
    firstReleaseYear: yearOf(recording["first-release-date"]),
    searchScore: Number.isFinite(recording.score) ? recording.score : null,
    tags: [...(recording.genres || []), ...(recording.tags || [])].map((tag) => ({ name: tag.name, count: tag.count ?? 0 })),
    releases: (recording.releases || []).map((release) => normalizeRelease(release, artist)),
  };
}

function normalizeFullRelease(release) {
  const group = release["release-group"] || {};
  const media = release.media || [];
  return {
    id: release.id,
    title: release.title,
    artist: creditName(release["artist-credit"]),
    date: release.date || null,
    year: yearOf(release.date),
    originalYear: yearOf(group["first-release-date"]),
    country: release.country || null,
    status: release.status || null,
    releaseGroupId: group.id || null,
    primaryType: group["primary-type"] || null,
    secondaryTypes: group["secondary-types"] || [],
    discCount: media.length,
    trackCount: media.reduce((sum, medium) => sum + (medium["track-count"] ?? medium.tracks?.length ?? 0), 0),
    tags: [...(release.genres || []), ...(group.genres || []), ...(release.tags || [])].map((tag) => ({ name: tag.name, count: tag.count ?? 0 })),
    tracks: media.flatMap((medium) =>
      (medium.tracks || []).map((track) => ({
        id: track.id,
        discNo: medium.position ?? null,
        discTrackCount: medium["track-count"] ?? medium.tracks.length,
        trackNo: trackNumber(track.number ?? track.position),
        title: track.title || track.recording?.title,
        artist: creditName(track["artist-credit"]) || creditName(track.recording?.["artist-credit"]),
        lengthMs: Number.isFinite(track.length) ? track.length : Number.isFinite(track.recording?.length) ? track.recording.length : null,
        recordingId: track.recording?.id || null,
      })),
    ),
  };
}

function normalizeReleaseSearch(release) {
  const group = release["release-group"] || {};
  return {
    id: release.id,
    title: release.title,
    artist: creditName(release["artist-credit"]),
    date: release.date || null,
    year: yearOf(release.date),
    country: release.country || null,
    status: release.status || null,
    releaseGroupId: group.id || null,
    primaryType: group["primary-type"] || null,
    secondaryTypes: group["secondary-types"] || [],
    trackCount: release["track-count"] ?? null,
    discCount: (release.media || []).length || null,
    format: (release.media || []).map((medium) => medium.format).filter(Boolean).join(" + ") || null,
    searchScore: Number.isFinite(release.score) ? release.score : null,
  };
}

function createMusicBrainz({ web }) {
  async function searchRecordings({ title, artist, recordingId = null }, { signal } = {}) {
    const query = recordingId && MBID.test(recordingId) ? `rid:${recordingId}` : `recording:${phrase(title)}${artist ? ` AND artist:${phrase(artist)}` : ""}`;
    const data = await web.getJson(`${MB}/recording?query=${encodeURIComponent(query)}&limit=15&fmt=json`, { signal });
    return (data?.recordings || []).map(normalizeRecording);
  }

  async function searchReleases({ album, artist, trackCount = null }, { signal } = {}) {
    let query = `release:${phrase(album)}`;
    if (artist) query += ` AND artist:${phrase(artist)}`;
    if (trackCount) query += ` AND tracks:${Number(trackCount)}`;
    const data = await web.getJson(`${MB}/release?query=${encodeURIComponent(query)}&limit=15&fmt=json`, { signal });
    return (data?.releases || []).map(normalizeReleaseSearch);
  }

  async function lookupRelease(id, { signal } = {}) {
    if (!MBID.test(String(id))) throw new Error("Invalid MusicBrainz release ID");
    const data = await web.getJson(`${MB}/release/${id}?inc=recordings+artist-credits+release-groups+media+genres&fmt=json`, { signal });
    return data ? normalizeFullRelease(data) : null;
  }

  /** Front cover from the Cover Art Archive (release, then release group). */
  async function frontCover({ releaseId, releaseGroupId }, { signal } = {}) {
    const urls = [];
    if (MBID.test(String(releaseId || ""))) urls.push(`${CAA}/release/${releaseId}/front-500`);
    if (MBID.test(String(releaseGroupId || ""))) urls.push(`${CAA}/release-group/${releaseGroupId}/front-500`);
    for (const url of urls) {
      const image = await web.getBytes(url, { signal });
      if (image) return { ...image, source: url };
    }
    return null;
  }

  return { frontCover, lookupRelease, searchRecordings, searchReleases };
}

module.exports = { MBID, createMusicBrainz, normalizeFullRelease, normalizeRecording, normalizeRelease, normalizeReleaseSearch, phrase, yearOf };
