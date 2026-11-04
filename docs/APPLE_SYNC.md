# Apple Library Sync

WaveMint owns the music library. iTunes is a synchronized destination that
**plays the WaveMint Library's own files** (direct reference). The iPhone is
updated with Apple's own device sync. There is one physical copy of each song on
the PC, managed by WaveMint.

```
WaveMint Library (e.g. D:\Music)  →  iTunes (references those files)  →  iPhone
```

## How it is built

| Part | Code | State |
| --- | --- | --- |
| Which file iTunes plays for each song, and whether it can (codec, not extension) | `formats.cjs` (`appleCompatibility`) | the library's `files` (codec from the audio stream) |
| Sync engine: desired state vs. saved state vs. iTunes' real state | `applesync.cjs` | `apple_sync_tracks` (`target_path`, `mode` direct/converted, `source_file_id`, fingerprints, persistent ID, status), `apple_sync_playlists`, `apple_sync_runs`, the `apple_sync` setting (migrations 9–10) |
| Compatibility cache (only for files iTunes can't play) | `exporter.cjs` with the cache as its root | `export_state` |
| Classic iTunes adapter (COM in an out-of-process STA PowerShell) | `itunes.cjs` | — |
| Guided migration of an iTunes library that already has songs; verification | `applemigrate.cjs` | same tables |
| Formats (Library Tools → Storage) and missing files (Review → Diagnostics) | `formats.cjs`, `LibraryFiles.jsx` | — |

- **Identity** is WaveMint's song ID; an iTunes entry is its 16-digit persistent ID,
  per iTunes library. Paths and titles are never the identity, so two files with the
  same name can't be confused.
- **Direct mode (MP3, AAC/ALAC in .m4a).** The iTunes target is the song's current
  library file. Nothing is copied. WaveMint writes curated tags into that file when a
  change is saved (the normal save path); the sync then has iTunes re-read the file
  (`UpdateInfoFromFile`). An edit not yet written into the file (`tags_dirty`) waits
  ("Not saved to file yet") instead of being sent, so metadata is never written twice.
- **Converted mode (FLAC; WAV/AIFF when "convert" is on).** A converted Apple Lossless
  copy is kept in the compatibility cache (`<WaveMint data>/apple-compat`, setting
  `appleCompatRoot`), created only when such a file exists, reused across runs, re-tagged
  (not re-converted) after a tag change, set aside in `.replaced/` only when no longer
  played. Lossy audio is never converted. Unsupported files (e.g. raw `.aac`, a codec that
  doesn't match the extension, Ogg) are reported, not synced.
- **Planning** classifies every song: `add`, `adopt` (an entry already plays that file),
  `metadata`, `replacement`, `relocate` (the file moved, was renamed or replaced),
  `relink` (iTunes points elsewhere), `readd`, `drift` (edited in iTunes), `remove`,
  `waiting`, `blocked`, `unchanged`. A run does only the difference and saves each step
  at once; a second run is a no-op (no copies, conversions, entries, playlist rebuilds or
  metadata rewrites; tested).
- **Rows from the earlier export-folder design** have no `target_path`; the next sync
  re-points those entries at the library files (same entry, history kept). Old export
  copies are left on disk for you to delete or keep as a portable export.

### Safety

- Only entries WaveMint created, or that you explicitly adopt in the migration, are ever
  changed or removed.
- **Sync never deletes, moves or writes a library file.** It only tells iTunes which file
  to play.
- **Guarded removal.** Before an iTunes entry is removed, its file gets a temporary second
  name (an NTFS hard link in `<Library>\.wavemint-guard`, no extra space). If the file is gone
  afterwards (iTunes deleted it), it is put back from that name, the removal is reported
  as failed, and removals stop for good (`deleteRemovesFiles`). If the file can't be
  protected this way, the entry isn't removed.
- **Moved files.** The first batch of a run adds at most 5 songs. If iTunes moved a library
  file it was given ("Keep iTunes Media folder organized" on), the run stops at once
  (`organizeDetected`). If iTunes copied a file, it is reported and re-pointed later.
- Removals (policy `confirm` by default), re-created entries, overwriting edits made in
  iTunes, repeated failures, a different iTunes library, and batches above max(5, 5 %)
  need confirmation. Automatic sync never does any of these, never launches iTunes, and
  waits while a file task or tag write is in progress.
- iTunes' edits are never copied into WaveMint; edits made in iTunes are shown as
  "edited in iTunes" for you to resolve.

## Formats (Library Tools → Storage) and missing files (Review → Diagnostics)

- **Audio formats**: every song's current file grouped by codec (with the extensions
  seen), files, storage and share, a bar per format, totals, and "Ready for iTunes"
  (play as they are / need a converted copy / unsupported / missing). Earlier versions and
  files of removed songs are listed separately. Computed from the database (instant;
  updates with scans, adds, upgrades, removals). Click a format to list its songs.
- **Missing or unreadable files**: every file WaveMint expects but can't find, including
  leftovers of removed or merged songs (the Sources count includes those): the song, the
  expected path, why (moved/deleted, drive unavailable, unreadable, back at its path),
  same-name files and other copies in the library, and safe actions: **Locate File…**
  (relink to a file inside a library folder, same type, not tracked elsewhere), **Replace
  File…**, **Remove from Library**, **Forget Reference** (database only, never the current
  file of a song). Nothing on disk is deleted. Leftover references (removed or merged songs,
  earlier versions whose file is gone) are listed apart, aren't counted as problems, and can
  be forgotten all at once. The Sources tab's "N missing" links here.

## Before the first sync

- Library Tools → Storage → **Audio formats**: check that the library is "Ready for iTunes".
  A library of MP3 and AAC only needs no conversion at all (no compatibility cache).
- Review → **Diagnostics**: resolve what's listed.
- Audio formats → **Check Genre Tags**: MP3s written by older tools (and WaveMint before this
  fix) may store genres as ID3v1 numbers ("(145)", or a bare "7"). iTunes shows codes above
  125 as numbers; **Store Genres as Text** rewrites only the genre (verified backups, audio
  checked, undoable from History).

## First live sync (empty iTunes)

0. Use the app with your real library: the installed WaveMint, or a development run with
   `npm run start:library` (close the installed WaveMint first; a plain `npm start` uses the
   separate `WaveMint-Dev` profile). The screen shows the profile, the library folder and
   "iTunes bridge: real iTunes (COM)"; a library in the temporary folder (a test library) is
   never synced. Nothing about COM needs a packaged build: iTunes is driven through Windows
   PowerShell either way.

1. In iTunes: Edit → Preferences → Advanced, both "Keep iTunes Media folder organized"
   and "Copy files to iTunes Media folder when adding to library" **off**. Keep iTunes open.
2. Optional: resolve Review → Diagnostics findings (see above).
3. **Apple Library Sync**: check "Both settings are off in iTunes", then
   **Check What's Changed** (it should say iTunes is empty and how many songs it will add).
4. **Sync 5 Songs as a Test.** It verifies automatically. In iTunes, check the 5 songs:
   they play, show artwork, and Get Info → File shows the WaveMint Library folder. Make sure
   no `iTunes Media\Music` copy appeared and the files are still in the library folder.
5. **Sync Everything** (one COM addition per song; a few thousand take several minutes). Then
   **Verify iTunes**.
6. Turn on **Sync automatically**, connect the iPhone and sync it in iTunes.

## Recovery

- iTunes closed/unreachable: changes stay pending; open iTunes and sync (or let
  automatic sync resume). Stuck on a dialog: answer it, retry.
- "iTunes moved a file": turn off "Keep organized", move the file back or rescan the
  library (Library Tools → Sources), then sync.
- "iTunes deleted a file": the file was put back from its guard name; removals stay
  paused. Report it before re-enabling anything.
- Failed songs: listed with the reason → Retry Failed Songs.
- A deleted or moved iTunes entry is re-added or re-pointed by the next sync.

## What is verified and what is not

**Verified against a real classic iTunes 12.13.12.3, read-only:** the PowerShell/COM
bridge, persistent IDs and lookups, listing (about 4,500 songs in ~48 s), the COM members
used (`Location {get}{set}`, `UpdateInfoFromFile`, `Delete`, `AddFile`, `CreatePlaylist`,
rating/play-count setters), and a dry run of a full first sync.

**Verified by automated tests with an in-memory iTunes** (`tests/library-applesync.test.cjs`,
29 tests; the stand-in calls itself `fake`, the app's bridge `itunes-com`) and the UI end-to-end test (`tests/e2e/apple-sync.e2e.cjs`, never contacts iTunes):
direct MP3/AAC sync without copying, codec-vs-extension rules, FLAC-only conversion and
reuse, saved metadata/artwork refresh, waiting unsaved edits, rename/relocation with the old
path gone, MP3→MP3 and MP3→FLAC upgrades keeping the entry, re-creation fallback, removal
without deleting files, the delete guard restoring a file, stopping when iTunes moves files,
copy detection, drift, conflicts, bulk safeguard, playlists, interrupted runs, iTunes
closed/unreachable, migration of export-era rows, the test-then-full first sync with
verification, migration of a populated library, portable export, format statistics and
missing-file repair.

**Verified against the real iTunes with writes (2026-11-04, 5 curated songs + 1 disposable
test song, each step read back from iTunes, files hashed before/after):**

| Behavior | Result |
| --- | --- |
| Add 5 songs by direct reference (`AddFile`), no copies | pass |
| Metadata change (genre) saved into the file, same entry refreshed (`UpdateInfoFromFile`), restored | pass (after fix: iTunes re-reads changed files itself; that is not treated as an edit made in iTunes anymore) |
| Artwork change and Undo, picture compared byte for byte with iTunes' own export | pass (after fix: a cover stored as picture type "Other" is replaced, not kept beside the new one) |
| Title change and restore | pass |
| File moved: the missing-files view finds it before a rescan, Locate File, same entry re-pointed (`Location` set), moved back | pass (after fix: entries whose file iTunes can't find have an empty location and were hidden, which would have added the song twice) |
| Audio replacement (Upgrade Track, MP3 128 → 320) keeps the entry and its iTunes rating | pass |
| Playlist create, reorder, rename, delete (with confirmation); songs untouched | pass |
| Repeated sync of unchanged songs changes nothing | pass |
| Genres stored as numbers rewritten as text; iTunes shows "Anime" instead of "145" | pass (writer fixed: `useNumericGenres = false`) |
| Removal (disposable song): held without confirmation; with it, the entry left iTunes, the file stayed byte-identical, the guard link and its folder were removed | pass |

Audio fingerprints of every curated test file were unchanged by all of the above (only tags changed).
Real iTunes' `Delete` removed only the library entry: the guard never had to restore a file.

**Not yet verified:** the iPhone sync.

**Known WaveMint limitation (not Apple sync):** a file moved or renamed outside WaveMint becomes
a new, duplicate song if the library is rescanned before the move is located in Review → Diagnostics.

## Manual checklist after the full sync (real iTunes)

1. Edit a title/genre in WaveMint and save: the same iTunes entry updates (set a rating
   first to see it survive).
2. Change artwork: iTunes shows it.
3. Upgrade a song (Upgrade Track): same entry, new file path in Get Info.
4. Rename/reorganize (Library Tools → Library Organization): entries follow.
5. Create, reorder, rename and delete a WaveMint playlist: iTunes follows (delete asks).
6. Remove a song from WaveMint (with confirmation): its entry leaves iTunes and the file is
   still in the WaveMint Library folder.
7. Sync twice: the second says everything is up to date.
8. Sync the iPhone.
