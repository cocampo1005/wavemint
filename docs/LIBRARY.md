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
