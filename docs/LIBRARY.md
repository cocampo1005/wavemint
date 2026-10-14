# WaveMint Library — design and implementation plan

WaveMint 2.0 adds a local-first music library manager next to the existing
YouTube **Extract** workflow. This document is the design reference: data
model, processes, IPC surface, file-safety model and the phased plan. Status
per phase is tracked at the end.

## Principles

1. **Source libraries are never modified.** Scans are read-only. Imported
   folders are `read_only` by default; WaveMint writes only to its own
   **Managed Library**, its backup/archive folders, and folders the user
   explicitly marks writable.
2. **The database is the source of truth for curated metadata.** Edits to
   tracks whose files live in read-only sources are stored in SQLite and
   written to file *copies* when tracks are consolidated or exported.
3. **A song is not a file.** A *logical track* can have several *file
   versions* (different sources, formats, upgrades).
4. **Every file operation is journaled, staged, verified and reversible.**
   Nothing is deleted automatically.
5. **Local and offline first.** Online identification (MusicBrainz, Cover Art
   Archive) is optional, user-initiated, rate limited and cached.

## Technology decisions

| Need | Choice | Why |
|---|---|---|
| Database | `node:sqlite` (built into Electron 41 / Node 24.18, SQLite 3.53) | No native module, no Electron ABI rebuilds, nothing new to package. Verified in a worker thread: WAL, foreign keys, FTS5 with `remove_diacritics`, JSON functions, backup API; 50 000 inserts in 177 ms. |
| Tag read/write | `node-taglib-sharp` 6.0.3 (LGPL-2.1, pure JS, 7 packages, 7.7 MB) | In-process read and write for MP3/M4A/ALAC/FLAC/WAV/AIFF. Verified on synthetic files: audio stream byte-identical after writes (MP3, AAC, ALAC, FLAC), comment/lyrics/custom TXXX frames preserved, ID3v2.3 when forced at write time, ~0.3 ms per read. |
| Technical probe fallback | bundled FFprobe | Files taglib can't parse; audio-stream hashing (`ffmpeg -c:a copy -f md5`) for write verification. |
| Background work | one `worker_threads` worker owning the DB and long jobs | Main process and UI stay responsive during scans of tens of thousands of files. |
| Audio preview / artwork | custom `wavemint-media:` and `wavemint-art:` protocols | The renderer never gets filesystem paths; only DB file IDs are resolvable, with Range support for seeking. |

`music-metadata` was considered for reading but was skipped: it is read-only
(a second library would be needed for writing) and its current release was
published the same day it was evaluated.

### Editable formats

| Format | Read | Write tags in WaveMint |
|---|---|---|
| MP3 | ✔ | ✔ (ID3v2.3 for Apple compatibility) |
| AAC / M4A | ✔ | ✔ |
| ALAC (M4A) | ✔ | ✔ |
| FLAC | ✔ | ✔ |
| WAV | ✔ | ✘ (scan only — RIFF/ID3 tag support in Apple Music is inconsistent) |
| AIFF | ✔ | ✘ (scan only — a test write lost the year field) |

## Processes

```
renderer (React)                 main process                         library worker (worker_threads)
src/library/*  ──invoke──▶  electron/library/host.cjs  ──RPC──▶  electron/library/worker.cjs
   window.waveMintAPI.library      validates method + params           owns SQLite (WAL)
                                   folder/file dialogs                 scanner, queries, genres,
                                   wavemint-media / wavemint-art       review, matching, merge,
                                   protocol handlers                   file operations, playlists
                     ◀──events── (progress, job state)  ◀──events──
```

- The renderer calls `window.waveMintAPI.library.<method>()`; preload maps
  each to one IPC channel; the host checks the method against an allowlist and
  validates parameters before forwarding to the worker. No SQL and no
  arbitrary paths cross the bridge — folders and files are chosen through
  main-process dialogs.
- Long jobs (scan, merge analysis, consolidation, tag writes) run one at a
  time, report progress events, and can be cancelled.

## Data model (migration 1)

```
library_meta(key, value)                    schema version, created_at
settings(key, value JSON)                   library settings (managed root, naming pattern, …)

sources            library folders           id, name, root_path, root_key UNIQUE, role
                                             (legacy|curated|managed|other), priority,
                                             read_only, status (ok|unavailable), scan times, stats
scans              scan sessions             id, source_id, status, started/finished, stats JSON

releases           albums / releases         id, title, album_artist, title_key, artist_key,
                                             year, edition, release_type, disc_total,
                                             mb_release_id, mb_release_group_id
tracks             logical tracks            id, title, artist, album_artist, release_id,
                                             track_no/total, disc_no/total, year, genre,
                                             composer, comment, compilation, active_file_id,
                                             review_status, quality_status, rating, notes,
                                             curated_fields JSON, keys for matching,
                                             mb_recording_id, acoustid, state (active|merged)
files              file versions             id, track_id, source_id, path, path_key UNIQUE,
                                             size, mtime_ms, quick_sig, content_hash,
                                             audio_hash, container, codec, bitrate,
                                             sample_rate, bit_depth, channels, duration_ms,
                                             tag_snapshot JSON (original tags), artwork_hash,
                                             status (ok|missing|unreadable), role
                                             (active|alternate|archived), scan bookkeeping
genres, genre_aliases, genre_rules          custom taxonomy, label mapping, rules
track_genres                                additional (internal) genre labels
review_items                                maintenance queue with persistent status
match_candidates, match_decisions           duplicate/merge candidates; persisted decisions
                                            keyed by stable file identity (survive rescans)
operations, operation_steps                 file-operation journal (staged → verified → done)
change_log                                  per-field metadata history (old → new)
playlists, playlist_entries                 manual + smart playlists (stable track IDs)
export_runs, export_items                   iPhone preparation state
```

Later migrations add tables only when their phase lands, so every migration
is exercised by real code.

## File safety model

- **Copy into the Managed Library:** copy to `<dest>.wmtmp` → verify size and
  SHA-256 against the source → rename to the final name (never overwriting) →
  update the DB. Journal step per file; on restart, unfinished steps are
  inspected and either completed or rolled back (temp files removed).
- **Tag writes (writable sources only):** back up the original into
  `<userData>/library/backups/<operation>/` → write tags into a staged copy next
  to the file → verify tags read back and the audio-stream hash is unchanged →
  swap (`original → .wmold`, `staged → original`, remove `.wmold`) → DB update.
  Undo restores the backup.
- **Upgrades:** the replacement is copied into the Managed Library and becomes
  the active version; the previous file is kept (read-only sources) or moved to
  the Managed Library's archive folder. Undo Upgrade reactivates it.
- **Recovery:** at startup the worker finishes or rolls back any operation left
  `running`, and the Activity view lists every operation.

## Phases

1. Core foundation: navigation, DB + migrations, sources, scanner, browsing,
   search, dashboard, audio preview.
2. Metadata + genres: editor (single/bulk/album), artwork, genre manager and
   rules, review queue, safe tag writing, change history and rollback.
3. Multi-library merge: source roles/priority, matching, merge analysis and
   review, album consolidation, Managed Library copy with verification, reports.
4. Quality + upgrades: quality signals and queue, version management,
   comparison and A/B preview, Upgrade Track with undo.
5. Identification: MusicBrainz, release candidates, Cover Art Archive,
   optional AcoustID/Chromaprint.
6. Smart album import from YouTube playlists.
7. Playlists and Prepare for iPhone.
8. Advanced evaluations.

## Status

### Phase 1 — Core foundation: done

- Library section next to Extract (Extract stays mounted, so a running
  extraction keeps its progress while you browse).
- SQLite library in `%APPDATA%\WaveMint\library\wavemint-library.db` with
  versioned migrations, automatic pre-migration backups and rollback of a
  failed migration.
- Sources: add (legacy / curated / other), overlap protection, iTunes layout
  detection, role and priority, relink after a move, remove (catalog only).
- Read-only scanner: incremental, cancellable and restartable, Unicode and
  long paths, junction/symlink loops skipped, corrupt files cataloged as
  unreadable, deleted files marked missing (never on an unreachable drive),
  folder-layout fallbacks for untagged iTunes files.
- Dashboard with real counts, issue shortcuts and format distribution;
  virtualized song list (paged, sortable, multi-select), albums, artists,
  genres, details panel with every file version, audio preview (ALAC/AIFF via
  a cached FLAC conversion).
- Measured: 1 500 synthetic files scan in 1.7 s (1.1 ms/file); an unchanged
  rescan takes 0.2 s.
- Verified in the packaged app (isolated profile): worker thread and taglib
  load from app.asar, artwork and audio protocols work.

### Phase 2 — Metadata and genre editing: done

- Migration 2: genres, aliases, rules, secondary genres, review items, the
  operations journal (operations + operation_steps) and a field-level change
  log; tracks gain WaveMint-chosen artwork.
- Editing (`electron/library/edits.cjs`): single, bulk and album edits with a
  preview of existing → proposed values per song and field; untick anything
  to keep it. Bulk edits only change fields you fill in. Edited fields become
  curated and survive rescans. Title Case and track numbering tools.
- Artwork (`artstore.cjs`): JPEG/PNG stored once by hash with the original
  bytes (no recompression); per song or per album; revert to the file's own art.
- Writing tags (`fileops.cjs`): only in writable sources (imported folders are
  read-only unless you allow writing, with a warning) and editable formats
  (MP3 as ID3v2.3, M4A/ALAC, FLAC). Per file: verified backup → staged copy →
  tags read back and audio-stream hash compared → swap with a rollback path →
  database. Interrupted writes are rolled back at the next start; Undo
  restores files from their backups. Files changed outside WaveMint since the
  last scan are never overwritten.
- Genres (`genres.cjs`): your own taxonomy with parents, rename/merge (old
  names kept as aliases), unrecognized labels with suggestions, near-duplicate
  names, and rules (album > artist > alias mapping; a genre you set by hand
  always wins and rule results never count as manual).
- Review queue (`review.cjs`): missing album/artist/album artist, unclassified
  genres, missing artwork, suspicious track numbers, inconsistent album
  details and similar album names (with suggested fixes), missing or
  unreadable files, possible duplicates. Ignored stays ignored, fixed issues
  resolve themselves, returning issues reopen.
- History: every change with details and Undo (metadata changes field by
  field, conflicts with later edits reported instead of overwritten).
- Verified in the real app on synthetic libraries: legacy folder byte-identical
  throughout; a written AAC file kept a bit-identical audio stream.

### Phase 3 — Multi-library merge and the WaveMint Library: done

- Migration 3: `match_decisions` (remembered "same" / "different" verdicts per
  pair of songs), `merge_sessions` and `merge_groups` (one analysis, its groups,
  suggested and chosen actions, evidence).
- Matching (`match.cjs`): songs are compared only within blocks of the same
  artist and base title. Exact copies are found by content hash (computed only
  where the cheap signature collides). Version markers (live, remix, remaster,
  acoustic, radio edit, …) and length decide the rest: within 2 s is the same
  recording, 2–20 s needs a decision, over 20 s is different. Different
  MusicBrainz recording IDs always mean different songs. Remembered decisions
  override everything. Each group gets a category (already in curated, only in
  legacy, only in curated, only in other folders, needs a decision), a
  preferred copy (highest source priority, then quality), a confidence and
  readable evidence.
- Merge (`merge.cjs`): analysis changes nothing but cached hashes. Applying a
  merge only links files: the other copies become alternate versions of the
  preferred song (state `merged`, `merged_into` kept for stable references).
  "Merge, fill gaps" also copies missing fields from the other copies; "Keep
  separate" is remembered so the pair isn't offered again. Undecided groups
  are left alone. Undo restores tracks, file links and decisions.
- Album consolidation: when the merge keeps legacy songs that belong to an
  album the curated library has under a similar name (and the same edition),
  the Apply dialog offers to move them into the curated album (name, album
  artist, year) as an ordinary undoable edit. Different editions stay apart.
- WaveMint Library (`consolidate.cjs`, `organize.cjs`): a destination folder
  chosen in a dialog becomes the `managed` source. Naming pattern with tokens
  and live preview, Windows-safe names (reserved names, invalid characters,
  length limits), case-insensitive collision handling with `(2)` suffixes.
  Per file: copy to a `.wmtmp` sibling (never overwriting) → SHA-256 compared
  with the source → WaveMint's metadata and artwork written into the copy
  (verified by reading back; audio-stream hash unchanged) → rename into place
  → the copy becomes the song's active version. Free space is checked first.
  Interrupted copies are completed or cleaned up at the next start. Undo
  switches songs back to their previous files and keeps the copies on disk.
  Sources are only ever read; rescanning the managed folder recognizes the
  copies.
- Verified in the real app on synthetic iTunes + curated libraries: analysis,
  decisions, apply, undo and re-apply; 22 songs copied with curated tags; both
  source folders byte-identical throughout.

### Phase 4 — Audio quality and Upgrade Track: done

- Migration 4: `quality_checks` (per file version; stale when size or mtime
  change), `tracks.quality_set_by` (auto / user / upgrade) and
  `tracks.quality_reasons`, `upgrade_candidates`.
- Quality signals (`quality.cjs`, `media.qualityCheck`): one FFmpeg pass per
  file decodes the whole file (decoding errors, audio ending before the
  stated length) and measures a 90-second window from the middle: level,
  samples at full scale (possible clipping), and the energy above 16.5 kHz
  relative to 12–15 kHz. A sharp drop there is reported as "almost nothing
  above 16 kHz": for a 256+ kbps or lossless file it suggests a transcode
  from a lower-quality source. About 0.6 s per song. Every signal is worded
  as a hint; nothing claims one file sounds better than another.
- Statuses: Quality unknown (not checked), Acceptable (checked, no concerns),
  Quality review suggested, Upgrade candidate available (another version of
  the song in the library is technically higher resolution and not damaged),
  plus the user's own Marked poor quality, Kept in original form, Acceptable
  and Upgraded. User statuses are never recomputed; "Let WaveMint decide"
  hands a song back. Decisions are journaled and undoable.
- Quality & Upgrades view: views by status with counts, search, bitrate and
  sort filters, bulk decisions, per-song Upgrade and decisions, "Check
  Unchecked Songs" (background job, cancellable, results stream in).
- Upgrade Track (`upgrade.cjs`): from a chosen file (main-process dialog) or
  another version of the song. Side-by-side comparison (file, source,
  format, length, size, artwork, album/artist, MusicBrainz ID, quality
  signals of both), A/B playback that keeps the position, a match verdict
  with evidence and warnings (different version or recording, lower
  technical resolution, damaged replacement; a strong warning needs explicit
  confirmation), and per-field metadata choice where curated values are kept
  by default and the replacement only fills gaps.
- Applying copies the replacement into the WaveMint Library (pattern name,
  its own extension/format) → SHA-256 check → chosen metadata and artwork
  written into the copy and verified (audio stream unchanged) → a managed
  previous file moves to `.wavemint-archive/` (other folders are never
  touched; their file is kept as an archived version) → rename into place →
  one transaction activates it. Failure at any step restores the files;
  interrupted upgrades are rolled back at the next start. Undo Upgrade
  reactivates the previous version and archives the copy. Without a WaveMint
  Library folder, switching to another existing version only changes the
  database; upgrading from a chosen file asks for a folder first.
- Upgrade Track (2.2): two sources, **Choose File** and **Analyze URL**. A
  URL is analyzed with `analyze-url` and extracted with `download-mp3`
  (`upgradeTrackId`, square-cropped thumbnail) into the library's staging
  folder, then prepared as an `extraction` candidate; nothing changes in the
  library until the user upgrades. The dialog's metadata form (the shared
  `MetadataFields`) is prefilled from the song once and only the user
  changes it; detected values (the analysis or the replacement's own tags)
  are only offered through "Use Detected Metadata" with per-field ticks.
  `applyUpgrade` takes the final `metadata` and an `artwork` choice
  (`current` / `candidate` / `custom` via `chooseUpgradeArtwork` / `none`);
  every tag field and the front cover are written into WaveMint's copy and
  read back. The comparison adds channels, a lengths warning, alternate
  version words (live, remix…) and a note that streamed audio's bitrate
  overstates its quality. Unused candidates are discarded when the dialog
  closes (a staged extraction's folder with them); a used one's staging
  folder is removed after the upgrade. If the upgraded song is playing, the
  player continues from the same position in the new file.
- Apple Music / iTunes: WaveMint never writes to Apple's library. An upgrade
  of a song from an iTunes folder leaves that file in place, so Apple Music
  keeps playing (and showing the details of) the old file; Prepare for
  iPhone lists the new file under "Replaced" so it can be re-added there.
- Consolidation now reuses an earlier managed copy (e.g. after undoing a
  copy) instead of making a "(2)" duplicate. Rescans check archived files
  directly instead of marking them missing.
- Verified in the real app: quality checks of 22 songs, decisions, upgrade
  from a downloaded FLAC with A/B playback and a metadata choice, undo, and
  "Use This Version…" from a song's versions; legacy, curated and the chosen
  file's folder byte-identical throughout.

### Phase 5 — Identification with MusicBrainz: done

- Migration 5: `web_cache` (MusicBrainz / Cover Art Archive answers, 404s
  included, 30 days), `identifications` (latest result per song: status,
  method, confidence, recordings, grouped releases, chosen release,
  suggested fields, what was applied), `tracks.mb_release_id` and
  `tracks.mb_release_group_id`.
- Off by default. Settings → `musicBrainzEnabled` is turned on from a notice
  that says what is sent (title, artist, album and length of the songs you
  identify) and to whom. Every network method refuses while it's off.
- `webclient.cjs`: one queue per host (MusicBrainz ≈ 1 request/s, Cover Art
  Archive 0.3 s), User-Agent `WaveMint/<version> ( https://github.com/cocampo1005/wavemint )`,
  15 s timeout, at most 2 retries on 429/5xx/network errors honouring
  Retry-After, cached in SQLite.
- `identify.cjs`: songs with an album are looked up album-first (release
  search → tracklist → the recording and all its releases), which finds the
  studio recording reliably; others by recording search on the base title
  (versions such as "(Live)" are compared against MusicBrainz's
  disambiguation instead). Confidence is computed only from title, artist,
  length and version agreement and shown with its reasons (≥ 85 %
  identified, ≥ 60 % uncertain). Releases are grouped by release group and
  labelled Original album / Album / Single / EP / Soundtrack / Live /
  Compilation; bootleg-only groups are hidden. The suggestion uses the
  song's current album when it is a candidate, otherwise the original album
  (the "prefer original releases" setting), and the user can pick another.
  Disc totals are only suggested when the full release was read; genres only
  when a MusicBrainz genre/tag matches the user's genre list or aliases.
- Review before applying: per field current vs suggested with checkboxes
  (gaps and identifiers preselected, fields you edited never preselected,
  title/artist/genre only fill gaps by default), alternative releases, the
  MusicBrainz tags, and the cover from the Cover Art Archive (stored in the
  local artwork store). Applying is one ordinary undoable edit.
- Whole albums: Identify Album lists matching releases (sorted by relevance,
  official, same track count, earliest, worldwide/US/UK), maps your songs to
  the tracklist (low-confidence rows unticked), lists tracks you don't have,
  and applies album-level fields to all chosen songs in one edit.
- Identify view: background identification of songs not looked up yet,
  results by status, review, dismiss, and "Apply Confident Matches" (≥ 90 %,
  with confirmation, default field choices only). Uncertain matches appear in
  the review queue.
- Verified against the live service with a handful of requests: "Yellow"
  found through Parachutes (35 editions grouped as the original album, plus
  the single, a soundtrack and compilations), the real cover applied, and
  "Lungs" matched to its 13-track release.

#### AcoustID / Chromaprint evaluation (not integrated)

- Needs two things WaveMint doesn't have: the `fpcalc` tool (Chromaprint,
  LGPL-2.1; the official Windows build is a few MB and links FFmpeg) and an
  AcoustID application API key, which each application must register itself
  (free for non-commercial use, 3 requests/s).
- Benefit for this library: most files are tagged, and album-first MusicBrainz
  lookups identify tagged songs well. Fingerprints mainly help untagged files
  ("Unknown Artist/Track 01") and wrongly tagged ones.
- Recommendation: add it later as an opt-in: pin `fpcalc` in
  `scripts/binaries.manifest.json` (SHA-256, license notice in About), store
  the user's own API key in settings, and use the existing `acoustid` column
  and the `acoustid` identification method. Fingerprinting costs about one
  decode per song (≈ 0.2–0.5 s).

### Phase 6 — Smart playlist and album import: done

- Migration 6: `import_sessions` (playlist, album fields, report, operation)
  and `import_items` (entry, pre-download match, action, staged file and its
  checks, upgrade candidate, outcome).
- Extract view: an analyzed playlist offers **Extract to Folder** (unchanged:
  output folder, batch selection, metadata fields, artwork options, progress,
  Open All in iTunes) or **Import into WaveMint Library**.
- Before anything is downloaded, every entry is matched against the library
  (title/artist/length scoring) and shows a Library Match indicator (New /
  Possibly in library / In library, with the existing copy's album and
  format). Actions: Add New Track, Compare & Upgrade, Keep Existing, Keep
  Both, Skip. Nothing is said about audio quality before the file exists.
- Album details for the import: album title, album artist, year, genre (for
  songs without one), edition, numbering in playlist order, and one cover for
  all (from a chosen entry) or each song's own. They apply to every new song
  except ones deliberately given a different album.
- Staged extraction: in import mode `download-mp3` saves the finished MP3 in
  the session's private staging folder (`<userData>/library/staging/imports`,
  chosen by the library, never by the renderer) and the main process hands it
  to the worker, which checks it (decoding, truncation, real tags), compares
  it with the library again, and prepares an upgrade candidate when the song
  already exists (side-by-side compare with A/B available).
- Review: per song the checked file, comparison and signals; owned songs need
  an explicit choice (Upgrade my copy / Keep my copy / Keep both / Skip).
  Committing copies new songs into the WaveMint Library (verified copy, album
  details written in, registered), runs approved upgrades through Upgrade
  Track (curated metadata kept), removes the staging folder and reports e.g.
  "9 tracks added, 1 upgraded, 0 skipped". Undo Import removes the added
  songs and archives their files; upgrades undo separately.
- Verified in the real app with a real YouTube playlist: import as new (album
  details and cover in the copied file), re-import matched as "In library"
  and kept, and Extract to Folder plus Open All in iTunes still working.

### Phase 7 — Playlists and Prepare for iPhone: done

- Migration 7: `playlists`, `playlist_tracks` (logical song IDs, order),
  `export_state` (per export folder and song: path, file and metadata
  signatures, format) and `exports` (reports).
- Playlists (`playlists.cjs`): manual playlists (add from the song panel or
  the selection toolbar, reorder, remove, name and description) and smart
  playlists (all/any of genre, artist, album, year, quality status, date
  added, open review issues, rating, format/lossless, source; sort and
  limit), compiled from an allowlist only. Entries survive upgrades (the
  song's ID doesn't change) and follow merges via `merged_into`.
- M3U8: export (UTF-8, CRLF, `#EXTINF`, absolute or relative paths) through
  a save dialog; import of M3U8/M3U (UTF-8, falling back to the Windows code
  page for old .m3u) matching by file path, then by artist and title, with a
  list of songs not found.
- Prepare for iPhone (`exporter.cjs`): a stable export folder (it may not
  overlap a library source). MP3, AAC and Apple Lossless are copied as they
  are; FLAC is converted to Apple Lossless (lossless, required by Apple's
  apps); WAV/AIFF optionally (default on, so tags and artwork travel). Never
  lossy to lossy. Each copy gets the curated tags and artwork (audio stream
  verified). A song keeps its path across exports; unchanged songs are
  skipped; changed details are refreshed in place; a new file (e.g. an
  upgrade to another format) gets a new name and the old file is set aside in
  `.replaced/` (never deleted); songs no longer selected are reported and
  left. Writes `wavemint-export.json` (manifest), `WaveMint Export
  Report.txt` (what to add, replace or refresh in Apple Music) and M3U8
  playlists. Scope: whole library, playlists or genres (albums and songs in
  the API).
- Hand-off: "Send to Apple Music" copies the new and changed files into
  Apple's "Automatically Add to iTunes" / "…to Music" folder (detected under
  the user's Music folder and next to library sources, or chosen in a
  dialog; only those folders are accepted). Apple's app imports them itself.

#### Apple Music / iPhone workflow (documented, partly unverified)

- WaveMint never writes to the iPhone or to Apple's library database.
- Supported path: files → Apple Music (Windows app) or iTunes → iPhone sync
  with the Apple Devices app (or iTunes). Importing is done by Apple's app:
  its "Automatically Add" folder, adding files/folders from its File menu,
  or (iTunes) importing M3U/M3U8 playlists.
- Apple's app keeps its own copy of song details (and, with "copy files to
  the media folder" on, its own copy of the file), so replacing a file or
  changing tags in the export folder does not update a song it already has.
  The report lists those songs: delete and re-add replaced songs; edit or
  re-add songs whose details changed.
- Not verified on this PC: the exact menu names in the current Apple Music
  for Windows app and whether it imports M3U8 playlists; the guidance in the
  app says so.
- Verified in the real app: playlists (manual, smart, M3U8 round trip),
  export of 8 songs with a FLAC→ALAC conversion carrying tags and cover, a
  second run with nothing to write, and the hand-off into a stand-in
  "Automatically Add to iTunes" folder.

### Phase 8 — Evaluations and small improvements: done

Implemented (cheap, local, clearly useful):

- **Album completion report**: the review queue lists albums missing songs
  ("Gaps: 3 of 5 songs; missing tracks 3, 5"), per disc, only when the
  albums' own track totals are known and agree. Identify Album additionally
  lists the release's tracks you don't have.
- **Spectrograms** in the Upgrade comparison (FFmpeg `showspectrumpic`,
  cached): both versions side by side, presented as a hint (a flat ceiling
  in the high frequencies suggests a lossy encode).

Evaluated, not implemented:

- **AI-assisted genre classification.** Cloud models would make an online,
  usually paid service part of a core feature; local audio-embedding models
  (e.g. Essentia/Discogs-EfficientNet via ONNX) add 100 MB+ and native
  runtimes for uncertain gains over what exists: your own rules and aliases,
  MusicBrainz genres mapped to your list, and per-artist/album rules. Not
  worth it now; could be an optional plug-in later.
- **More quality diagnostics.** True peak and loudness range (FFmpeg
  `ebur128`) could join the existing single pass for little cost; they
  describe mastering rather than encoding quality, so they're left out until
  there's a concrete use (e.g. choosing between two masters).
- **Advanced duplicate matching.** Chromaprint fingerprints compared locally
  (no AcoustID web service or key needed) would catch the same recording
  under different titles. It needs the `fpcalc` binary (see the AcoustID
  evaluation); recommended as the next step if mismatched titles turn out to
  be common in the merged library.
- **Library health score.** The Overview, Review and Quality views already
  show concrete counts; a single score would hide what to fix.
- **More metadata providers.** Discogs (token, strict limits), Last.fm (API
  key) and the iTunes Search API (no key; good artwork, restrictive terms)
  were considered. None is needed for the core workflow; none is added.

### Library-first app, Add to Library and audio editing (2.1)

- **Navigation.** The app opens on the library (Songs). One sidebar (`src/AppNav.jsx`)
  holds **Add Music**, the library sections, Maintain/Manage and Settings;
  the old Extract/Library tabs and the library's own sidebar are gone. The
  Overview page is now **Library Health** under Maintain; an empty library
  shows a welcome in Songs. `App.jsx` is the shell: it owns the route and the
  library job state, and keeps both workspaces (Library, Add Music) mounted
  so switching never loses an extraction, its progress listeners or edits.
- **Add to Library.** `download-mp3` no longer takes an output folder. The
  finished MP3 goes into `<userData>/library/staging/extractions/<token>/`
  (`prepareExtractionStaging`, host-only) and `commitStagedExtraction`
  copies it into the WaveMint Library (verified SHA-256, naming pattern,
  never overwriting) and registers one song in a journaled `import`
  operation ("Add "Title"", undoable from History; crash recovery is the
  importer's). A failed extraction or failed copy leaves no song behind; the
  staging folder is removed after the add, on failure, and at worker start.
  The renderer only ever holds the random token. `holdForEditing` keeps the
  staged file for the editor instead of adding it. A `library-changed` event
  refreshes the views; the review queue is refreshed a few seconds after the
  last add. Possible duplicates are flagged before adding
  (`checkLibraryMatches`, same scoring as the album import) but not blocked.
  The album import (Phase 6) remains as **Import as Album…** for playlists;
  Extract to Folder and Open in iTunes were removed.
- **Audio editor** (`src/editor/AudioEditor.jsx`, one component for both
  entry points): waveform peaks from FFmpeg (`media.waveform`, mono PCM at
  6 kHz reduced to 1,600 peaks), draggable/keyboard trim handles, time
  inputs, fade sliders (fades sit inside the trim and can't overlap), and a
  preview that plays the real file with the edits applied live (stops at the
  end handle; the fades are the same linear ramps FFmpeg's `afade` applies).
  Nothing plays until asked.
- **Saving edits** (`electron/library/audioedit.cjs`). A plain trim of an
  MP3/AAC file is a stream copy (cut on frame boundaries, ~26 ms, no
  re-encoding); fades re-encode (MP3 at the smallest standard bitrate at or
  above the original's, AAC 192–320 kbps, lossless formats losslessly). Tags
  and artwork are copied from the original with taglib, and the result's
  length is checked. For a library song the render becomes the song's new
  active version through Upgrade Track (`applyJob` with `purpose: "edit"`:
  verified copy into the WaveMint Library, tags and artwork written and
  checked, a previous version WaveMint owns archived, one transaction; the
  quality status is left alone). The song keeps its id, metadata and
  playlists; History undoes it. Files in other sources are never touched,
  so editing their songs needs the WaveMint Library folder. Repeated edits
  or upgrades of a managed song now archive each earlier version under its
  own name (previously the second archive move would have collided).
- Tests: `tests/library-audio-edit.test.cjs` (validation, encoders, add with
  and without edits, in-place edit + undo, read-only source untouched, no
  temp files left) and `tests/editor-math.test.mjs`. Verified in the real app
  with a YouTube video and playlist: add, View in Library, Edit Audio from
  the song panel (13.0 s result, original archived, same song), edit before
  adding (nothing in the library until saved), a held playlist song while the
  batch continues, and the library after a restart.

### Overview, favorites, the player and removing songs (2.1)

- **Overview** (the home page; the app opens on it): totals, **Recently
  Added** as artwork cards (`t.created_at`, i.e. when a song entered the
  library by scan or import, never a file date; play or open each, View All
  opens Songs newest first), genre composition (one-hue bars with counts and
  shares; a bar opens its songs), the artists with most songs, and a short
  "Needs attention" list. File formats and sources left the overview (Sources
  and Quality still show them).
- **Songs**: a Sort menu (Recently/Oldest Added, Title, Artist, Album, Genre,
  Duration, File size) plus clickable headers; the order is remembered per
  list. Columns: Title, Artist, Album, Genre, Time, Added, Size, a favorite
  heart and a ⋯ menu (Format and Source are gone from the table). Columns
  resize by dragging a header edge (double-click resets); widths are kept in
  `localStorage` (`wavemint.trackColumns.v1`); the header scrolls sideways
  with the body and reserves the body's scrollbar width so columns stay
  aligned.
- **Favorites**: migration 8 adds `tracks.favorite` (plus an index on
  `state, created_at`). `setFavorite`, a `favorite` filter (Favorites
  view, a chip in Songs), and a Favorites total on the Overview.
- **Song menu** (right-click or ⋯, one builder in `LibraryView`): Play Now,
  Play Next, Add to Queue, Add to Playlist, Remove from This Playlist (in a
  playlist), Edit Metadata, Edit Audio, Favorite, Show in Explorer, Remove
  from Library, Delete File. It acts on the selection when the clicked song
  is part of it.
- **Player** (`src/player/`): one `<audio>` element in `PlayerProvider`;
  the player bar, queue panel and Listen Mode are views of it. The queue
  model is pure (`queue.js`, unit-tested): the *context* (the list that was
  started: Songs in its current filter and order, Favorites, an album, a
  playlist) with a play order that is sequential or a shuffled permutation
  (no repeats until every song played; turning shuffle on keeps what played
  and shuffles the rest, turning it off continues the list after the current
  song), plus *Up next* (Play Next / Add to Queue), which always plays first
  and never changes a playlist. Several Play Next picks keep their order;
  after the song changes, Play Next goes to the front again. Repeat Off stops
  on the last song, Repeat All restarts (reshuffled), Repeat One replays.
  Previous goes back through what actually played. The queue can be
  reordered by dragging, trimmed, cleared, and upcoming list songs skipped
  for the session. Shuffle, repeat and volume are remembered; Windows media
  keys work (Media Session).
- **Listen Mode**: a full-window view (large artwork over a still, blurred
  copy of it; title, artist · album, progress, transport, volume, queue) with
  a Fullscreen button (HTML fullscreen). Esc leaves fullscreen, a second Esc
  closes Listen Mode; playback never restarts.
- **Remove from Library** (`removal.cjs`): songs get `state = 'removed'`;
  files and file records stay, so a rescan doesn't bring them back. One
  "remove" operation, undoable from History or the Undo in the notice (it
  restores playlist membership too, since playlists hide non-active songs).
  No confirmation, since nothing on disk changes.
- **Delete File**: the library plans which files (the songs' own audio files
  in the WaveMint Library folder or in a source the user allowed changes to;
  a song whose current file is in a read-only folder is refused), the main
  process moves them to the Recycle Bin (`shell.trashItem`), and the songs
  leave the library with their trashed file records removed (a journaled
  "delete" operation, not undoable in WaveMint; the Recycle Bin is the way
  back). A confirmation lists the files. Artwork lives in WaveMint's store
  and is never touched. Removed or deleted songs leave the play queue.
- Tests: `tests/library-removal.test.cjs`, `tests/player-queue.test.mjs`.
  Verified in the real app on synthetic libraries (Overview, sorts, resize
  and its persistence, favorites, the menu, queue order and drag, shuffle,
  Repeat One, Listen Mode fullscreen and Esc, remove + Undo, delete with a
  stubbed Recycle Bin, playlist shuffle, restart).

### Storage, editor zoom and Listen Mode polish (2.2)

- **Where space goes.** Metadata edits, artwork choices (one stored copy per
  distinct image), favorites, playlists and added sources are database rows
  or small files. What grows: previous versions after Edit Audio/Upgrade
  (`<WaveMint Library>/.wavemint-archive`), Write Tags backups
  (`userData/library/backups/op-N`), playable FLAC copies of ALAC/AIFF songs,
  thumbnails/spectrograms, unused artwork, abandoned album-import staging,
  and database backups taken before migrations.
- **Retention** (`keepPreviousVersions`: 1 day, **3 days** (default), 7 days,
  30 days, or "until I clean up") applies to previous versions and Write Tags
  backups; their age comes from the operation that archived them, never only
  from file times. Afterwards they're cleaned up and History marks the
  change "Recovery period ended" (`operations.undoable = 0` with
  `summary.expired`); `undoOperation` refuses such operations.
- **`storage.cjs`** measures and plans (worker); the main process carries out
  the plan (`cleanUpStorage` host method): audio and backups go to the
  Recycle Bin (`shell.trashItem`), generated files are deleted. Every target
  is `lstat`ed (links are refused), `realpath`ed and must be strictly inside
  one of WaveMint's own folders (`isInsideRoots`): the library's
  `.wavemint-archive`, `backups`, `cache`, `artwork-store`, `staging`,
  `db-backups`, and the extraction work folder. Never planned: a file a song
  is using, anything in the user's own music folders, artwork referenced by
  songs, albums, files, pending upgrades/imports or a still-undoable change.
  Failures (file in use, no Recycle Bin on that drive) leave the item in
  place and are reported. Then `finish` deletes the records of removed
  versions, retires the undo of affected operations, discards abandoned
  imports, records the last cleanup and checkpoints the WAL.
- **Caches:** playable copies are dropped when their song changed or is gone,
  and kept under 1 GB least-recently-used first (each use touches the file;
  copies used in the last 2 hours always stay). Thumbnails of unused images
  and spectrograms of changed files (or untouched for 30 days) go. The
  newest 3 database backups are kept.
- **Automatic cleanup** (on by default): checked 3 minutes after start and
  every 3 hours; it runs only if the last run was 24 hours or more ago and no
  library task or extraction is running; one cleanup at a time.
- **Storage page** (Manage → Storage): total size, what can be freed, a row
  per category (your songs, the database and engine updates are shown as
  kept), Clean Up (all or per category), the retention setting, automatic
  cleanup, the last run, and an info note about the user's own folders
  (including copies of songs that now play from the WaveMint Library, which
  WaveMint never removes).
- **Genre read-back fix:** WaveMint writes ID3v2.3 tags, and TagLib# splits
  every v2.3 text frame on "/", so "Hip Hop/R&B" read back as "Hip Hop" and
  every edit, upgrade or tag write of such a song failed its verification.
  v2.3 genres are now read whole (`readGenres` in `tags.cjs`); "/" only
  separates people in v2.3, never genres. Rescans also store the full genre.
- **Editor:** zoom (buttons, Ctrl + wheel around the pointer, a scroll bar,
  Fit to View; down to 1 second across the waveform) with a finer waveform
  of the visible stretch loaded on demand (`audioWaveform` with
  `startMs`/`endMs`). Playback has one animation loop that runs while the
  audio plays and reads `audio.currentTime`, moving the playhead and clock
  directly (no re-render per frame); seeking during playback keeps it
  moving, and a zoomed view follows the playhead. Times show hundredths;
  Alt + arrow nudges a handle by 10 ms.
- **Listen Mode:** a visualizer frame around the artwork from a Web Audio
  analyser on the player's single audio element (created the first time
  Listen Mode opens; suspended while paused; `wavemint-media` is
  CORS-enabled for this). Title and artist have fixed heights (two lines /
  one line), so the artwork and controls never move between songs.
- **Song table:** every column has its own width and a filler absorbs spare
  room, so dragging a column's right edge moves only that edge (and the
  columns after it). The ⋯ button had collided with an older `.lib-more`
  class (with a top margin) and is now `.lib-actions-button`.

## Importing your two libraries (step by step)

Nothing in these steps changes your iTunes or curated folders.

1. **Library → Overview → Add iTunes / Legacy Folder**: choose the `iTunes
   Media` folder (or its `Music` subfolder). WaveMint scans it read-only. It
   doesn't read the `.itl` database; ratings and play counts stored only there
   aren't imported.
2. **Add Curated Folder**: choose your newer collection. Curated sources have
   a higher priority, so their copies win when the same song is in both.
3. **Merge & Duplicates → Analyze Libraries**. Check "Needs a decision"
   (remasters, different lengths), choose Merge / Keep separate per group,
   then **Accept Suggestions** and **Apply Merge…**. Only WaveMint's database
   changes; undo from History.
4. Optional cleanup: **Review** (missing details, albums missing songs),
   **Genres**, **Identify** (MusicBrainz, opt-in), **Quality & Upgrades**
   ("Check Unchecked Songs" takes about half a second per song).
5. **WaveMint Library → Choose Folder…** (an empty folder on a drive with
   enough space), check the naming preview, then **Copy N Songs…**. Each song
   is copied once from its best source, verified, and gets your edited tags.
   Your original folders stay as a backup.
6. **Prepare for iPhone**: choose an export folder, check what's changed,
   prepare, then follow the in-app steps (or Send to Apple Music) and sync the
   iPhone with the Apple Devices app.

Rescan sources any time from **Sources**; songs you edited keep your edits.
