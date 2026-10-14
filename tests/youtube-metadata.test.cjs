const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAnalysisResult,
  buildFinalFileName,
  cleanAlbumName,
  extractYouTubeMusicDescriptionMetadata,
  getArtworkThumbnailCandidates,
  getBestThumbnailUrl,
  getExtractedMetadata,
  getUsefulGenre,
  resolveFinalMetadata,
} = require("../electron/youtubeMetadata.cjs");

// A YouTube Music upload as yt-dlp reports it (trimmed).
const MUSIC_UPLOAD = {
  id: "abc123",
  title: "Song",
  channel: "Artist - Topic",
  uploader: "Artist - Topic",
  genre: "Music",
  description: "Provided to YouTube by Label\n\nSong · Artist · Guest\n\nThe Album\n\n℗ 2020 Label\n\nReleased on: 2020-01-01",
  thumbnail: "https://i.ytimg.com/vi/abc123/maxresdefault.jpg",
};

// An ordinary music video: only the title and uploader say anything.
const MUSIC_VIDEO = {
  id: "def456",
  title: "Artist - Song (Official Video)",
  uploader: "ArtistVEVO",
  genre: "Music",
  thumbnails: [
    { url: "https://i.ytimg.com/vi/def456/hqdefault.jpg", width: 480, height: 360 },
    { url: "https://i.ytimg.com/sb/def456/storyboard3_L2/M0.jpg", width: 1600, height: 900 },
    { url: "https://i.ytimg.com/vi/def456/maxresdefault.jpg", width: 1280, height: 720 },
  ],
};

test("YouTube Music descriptions provide title, artist and album", () => {
  assert.deepEqual(extractYouTubeMusicDescriptionMetadata(MUSIC_UPLOAD), { title: "Song", artist: "Artist", album: "The Album" });
  assert.deepEqual(extractYouTubeMusicDescriptionMetadata({ description: "Provided to YouTube by X\nT · A\nReleased on: 2020" }), { title: "T", artist: "A", album: "" });
  assert.deepEqual(extractYouTubeMusicDescriptionMetadata(MUSIC_VIDEO), { title: "", artist: "", album: "" });
  assert.deepEqual(getExtractedMetadata(MUSIC_UPLOAD), { title: "Song", artist: "Artist", album: "The Album", genre: "" });
});

test("video categories aren't genres; album names lose artist prefixes and 'Full Album'", () => {
  assert.equal(getUsefulGenre("Music"), "");
  assert.equal(getUsefulGenre("People & Blogs"), "");
  assert.equal(getUsefulGenre(" Synthwave "), "Synthwave");
  assert.equal(cleanAlbumName("Artist - The Album (Full Album)", "Artist"), "The Album");
  assert.equal(cleanAlbumName("Artist – Album [Official Album 2019]", "Artist - Topic"), "Album");
  assert.equal(cleanAlbumName("(Regex) [chars]+ - Album", "(Regex) [chars]+"), "Album", "artist names are matched literally");
});

test("thumbnails: yt-dlp's choice first, storyboards never, constructed URLs last", () => {
  assert.equal(getBestThumbnailUrl(MUSIC_UPLOAD), MUSIC_UPLOAD.thumbnail);
  assert.equal(getBestThumbnailUrl(MUSIC_VIDEO), "https://i.ytimg.com/vi/def456/maxresdefault.jpg", "the largest real thumbnail");
  assert.equal(getBestThumbnailUrl({ url: "xyz" }), "https://i.ytimg.com/vi/xyz/hqdefault.jpg");

  const shown = "https://i.ytimg.com/vi/def456/hqdefault.jpg";
  const candidates = getArtworkThumbnailCandidates(MUSIC_VIDEO, shown);
  assert.equal(candidates[0], shown, "the artwork uses the thumbnail the user saw");
  // Shown first, then the real thumbnails (largest first, no storyboards),
  // then constructed fallbacks; each URL once.
  assert.deepEqual(candidates, [
    shown,
    "https://i.ytimg.com/vi/def456/maxresdefault.jpg",
    "https://i.ytimg.com/vi/def456/hq720.jpg",
    "https://i.ytimg.com/vi/def456/sddefault.jpg",
  ]);
});

test("an analysis marks guessed fields, and the final metadata keeps the user's edits", () => {
  const analysis = buildAnalysisResult(MUSIC_VIDEO);
  assert.equal(analysis.isPlaylist, false);
  assert.equal(analysis.metadata.title, "Artist - Song (Official Video)");
  assert.deepEqual(analysis.metadata.__wavemintProvisional, { title: true, artist: true, album: true, genre: true });

  // Untouched guesses take the full extraction's better data…
  assert.deepEqual(resolveFinalMetadata(analysis.metadata, MUSIC_UPLOAD), { title: "Song", artist: "Artist", album: "The Album", genre: "" });
  // …but anything the user edited is written as edited.
  const edited = { ...analysis.metadata, title: "My Title", genre: " Pop " };
  assert.deepEqual(resolveFinalMetadata(edited, MUSIC_UPLOAD), { title: "My Title", artist: "Artist", album: "The Album", genre: "Pop" });
  // Without extraction details, what was shown is written.
  assert.equal(resolveFinalMetadata(analysis.metadata, null).title, "Artist - Song (Official Video)");
});

test("playlist entries inherit the playlist's artist and album as fallbacks", () => {
  const analysis = buildAnalysisResult({
    id: "pl",
    title: "Artist - Greatest Hits (Full Album)",
    uploader: "Artist",
    entries: [{ id: "e1", title: "One", url: "e1", duration: 100 }],
  });
  assert.equal(analysis.isPlaylist, true);
  const [entry] = analysis.entries;
  assert.equal(entry.webpage_url, "https://www.youtube.com/watch?v=e1");
  assert.equal(entry.thumbnail, "https://i.ytimg.com/vi/e1/hqdefault.jpg");
  assert.equal(entry.metadata.artist, "Artist");
  assert.equal(entry.metadata.album, "Greatest Hits");
  assert.equal(entry.selected, true);
});

test("file names drop characters Windows doesn't allow", () => {
  assert.equal(buildFinalFileName({ artist: 'AC/DC', title: 'What? "Now" <live>' }), "ACDC - What Now live.mp3");
  assert.equal(buildFinalFileName({}), "Unknown Artist - Unknown Title.mp3");
});
