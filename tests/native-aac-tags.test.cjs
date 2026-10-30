const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { SKIP_REASON, makeTempDir, makeTrack, coverBytes, mediaForTests } = require('./library-fixtures.cjs');
const { readTags, writeTags } = require('../electron/library/tags.cjs');
const { buildTaggingArgs } = require('../electron/songExtraction.cjs');
const ffmpeg = path.resolve('resources/bin/win32-x64/ffmpeg.exe');

test('editing a v2.4 genre preserves long existing title, artist and album frames', { skip: SKIP_REASON }, async (t) => {
  const dir = makeTempDir(t, 'wavemint-id3v4-');
  const input = path.join(dir, 'input.mp3');
  makeTrack(dir, 'input.mp3');
  const output = path.join(dir, 'v4.mp3');
  const title = 'A long title '.repeat(20);
  const artist = 'Artist name '.repeat(20);
  const album = 'Album name '.repeat(20);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', input, '-c', 'copy', '-id3v2_version', '4', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${album}`, output]);
  const before = readTags(output);
  writeTags(output, { genre: 'Synth-Pop' });
  const after = readTags(output);
  for (const field of ['title', 'artist', 'album']) assert.equal(after[field], before[field]);
  assert.equal(after.genre, 'Synth-Pop');
  assert.equal(await mediaForTests().audioStreamHash(input), await mediaForTests().audioStreamHash(output));
});

test('M4A extraction tagging embeds Apple-readable artwork and tags without changing audio', { skip: SKIP_REASON }, async (t) => {
  const dir = makeTempDir(t, 'wavemint-native-aac-');
  makeTrack(dir, 'input.m4a', { base: 'm4a' });
  const input = path.join(dir, 'input.m4a');
  const cover = path.join(dir, 'cover.jpg');
  fs.writeFileSync(cover, coverBytes());
  const metadata = { title: 'Song', artist: 'Artist', album: 'Album', genre: 'Synth-Pop' };
  for (const withCover of [true, false]) {
    const output = path.join(dir, `output-${withCover}.m4a`);
    execFileSync(ffmpeg, ['-v', 'error', ...buildTaggingArgs({ input, output, metadata, cover: withCover ? cover : null })]);
    const tags = readTags(output);
    for (const field of Object.keys(metadata)) assert.equal(tags[field], metadata[field]);
    assert.equal(tags.codec, 'aac');
    assert.equal(tags.artworkCount, withCover ? 1 : 0);
    assert.equal(await mediaForTests().audioStreamHash(input), await mediaForTests().audioStreamHash(output));
  }
});
