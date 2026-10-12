// Versioned schema migrations for the library database. Each migration runs
// once, in order, inside a transaction (see db.cjs). Never edit a migration
// that has shipped; add a new one instead.

const MIGRATIONS = [
  {
    version: 1,
    name: "core library: sources, scans, releases, tracks, files, search",
    up(db) {
      db.exec(`
        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- A folder (or drive) imported into WaveMint.
        CREATE TABLE sources (
          id                     INTEGER PRIMARY KEY,
          name                   TEXT NOT NULL,
          root_path              TEXT NOT NULL,
          root_key               TEXT NOT NULL UNIQUE,
          role                   TEXT NOT NULL DEFAULT 'other'
                                 CHECK (role IN ('legacy', 'curated', 'managed', 'other')),
          priority               INTEGER NOT NULL DEFAULT 50,
          read_only              INTEGER NOT NULL DEFAULT 1 CHECK (read_only IN (0, 1)),
          status                 TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'unavailable')),
          created_at             TEXT NOT NULL,
          last_scan_started_at   TEXT,
          last_scan_completed_at TEXT,
          last_scan_stats        TEXT
        );

        CREATE TABLE scans (
          id          INTEGER PRIMARY KEY,
          source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          status      TEXT NOT NULL
                      CHECK (status IN ('running', 'completed', 'cancelled', 'failed', 'unavailable')),
          started_at  TEXT NOT NULL,
          finished_at TEXT,
          stats       TEXT
        );
        CREATE INDEX scans_source ON scans(source_id);

        -- An album / release, separate from the recordings on it.
        CREATE TABLE releases (
          id                  INTEGER PRIMARY KEY,
          title               TEXT NOT NULL,
          album_artist        TEXT NOT NULL DEFAULT '',
          title_key           TEXT NOT NULL,
          artist_key          TEXT NOT NULL,
          edition             TEXT NOT NULL DEFAULT '',
          year                INTEGER,
          release_type        TEXT NOT NULL DEFAULT 'album'
                              CHECK (release_type IN ('album', 'single', 'ep', 'compilation', 'soundtrack', 'live', 'other')),
          disc_total          INTEGER,
          mb_release_id       TEXT,
          mb_release_group_id TEXT,
          artwork_hash        TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          UNIQUE (title_key, artist_key, edition)
        );
        CREATE INDEX releases_artist ON releases(artist_key);

        -- A logical track: the library entry, independent of any one file.
        CREATE TABLE tracks (
          id              INTEGER PRIMARY KEY,
          title           TEXT NOT NULL DEFAULT '',
          artist          TEXT NOT NULL DEFAULT '',
          album_artist    TEXT NOT NULL DEFAULT '',
          album           TEXT NOT NULL DEFAULT '',
          release_id      INTEGER REFERENCES releases(id) ON DELETE SET NULL,
          track_no        INTEGER,
          track_total     INTEGER,
          disc_no         INTEGER,
          disc_total      INTEGER,
          year            INTEGER,
          genre           TEXT NOT NULL DEFAULT '',
          composer        TEXT NOT NULL DEFAULT '',
          comment         TEXT NOT NULL DEFAULT '',
          compilation     INTEGER NOT NULL DEFAULT 0 CHECK (compilation IN (0, 1)),
          duration_ms     INTEGER,
          active_file_id  INTEGER REFERENCES files(id) ON DELETE SET NULL,
          title_key       TEXT NOT NULL DEFAULT '',
          artist_key      TEXT NOT NULL DEFAULT '',
          review_status   TEXT NOT NULL DEFAULT 'none'
                          CHECK (review_status IN ('none', 'needs_review', 'reviewed')),
          quality_status  TEXT NOT NULL DEFAULT 'unknown'
                          CHECK (quality_status IN ('unknown', 'review_suggested', 'acceptable',
                                                    'user_marked_poor', 'upgrade_available', 'upgraded', 'keep_original')),
          rating          INTEGER CHECK (rating BETWEEN 0 AND 5),
          notes           TEXT NOT NULL DEFAULT '',
          curated_fields  TEXT NOT NULL DEFAULT '[]',
          tags_dirty      INTEGER NOT NULL DEFAULT 0 CHECK (tags_dirty IN (0, 1)),
          mb_recording_id TEXT,
          acoustid        TEXT,
          state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'merged', 'removed')),
          merged_into     INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE INDEX tracks_release ON tracks(release_id);
        CREATE INDEX tracks_match ON tracks(artist_key, title_key);
        CREATE INDEX tracks_state ON tracks(state);
        CREATE INDEX tracks_genre ON tracks(genre COLLATE NOCASE);
        CREATE INDEX tracks_artist ON tracks(artist COLLATE NOCASE);

        -- A physical audio file (a version of a logical track).
        CREATE TABLE files (
          id                INTEGER PRIMARY KEY,
          track_id          INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
          source_id         INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          path              TEXT NOT NULL,
          path_key          TEXT NOT NULL UNIQUE,
          rel_path          TEXT NOT NULL,
          ext               TEXT NOT NULL,
          size              INTEGER NOT NULL,
          mtime_ms          INTEGER NOT NULL,
          quick_sig         TEXT,
          content_hash      TEXT,
          audio_hash        TEXT,
          container         TEXT,
          codec             TEXT,
          lossless          INTEGER,
          bitrate           INTEGER,
          sample_rate       INTEGER,
          bit_depth         INTEGER,
          channels          INTEGER,
          duration_ms       INTEGER,
          tag_snapshot      TEXT,
          artwork_hash      TEXT,
          artwork_count     INTEGER NOT NULL DEFAULT 0,
          status            TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'missing', 'unreadable')),
          role              TEXT NOT NULL DEFAULT 'active' CHECK (role IN ('active', 'alternate', 'archived')),
          read_error        TEXT,
          first_seen_at     TEXT NOT NULL,
          last_seen_at      TEXT NOT NULL,
          last_seen_scan_id INTEGER
        );
        CREATE INDEX files_track ON files(track_id);
        CREATE INDEX files_source ON files(source_id);
        CREATE INDEX files_content_hash ON files(content_hash);
        CREATE INDEX files_quick_sig ON files(quick_sig);
        CREATE INDEX files_artwork ON files(artwork_hash);

        -- Full-text search over track metadata (rowid = tracks.id).
        CREATE VIRTUAL TABLE track_search USING fts5(
          title, artist, album, album_artist, genre,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `);
    },
  },
  {
    version: 2,
    name: "metadata editing: artwork, genres, rules, review queue, operations journal, change log",
    up(db) {
      db.exec(`
        -- Artwork chosen in WaveMint (overrides the active file's embedded art).
        ALTER TABLE tracks ADD COLUMN artwork_hash TEXT;

        -- The user's genre taxonomy.
        CREATE TABLE genres (
          id          INTEGER PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
          parent_id   INTEGER REFERENCES genres(id) ON DELETE SET NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL
        );

        -- Imported labels mapped to a taxonomy genre ("Alt Rock" -> "Alternative Rock").
        CREATE TABLE genre_aliases (
          alias_key  TEXT PRIMARY KEY,
          alias      TEXT NOT NULL,
          genre_id   INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        );

        -- Deterministic classification rules (artist / album defaults).
        CREATE TABLE genre_rules (
          id          INTEGER PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('artist', 'album')),
          match_key   TEXT NOT NULL,
          match_label TEXT NOT NULL,
          genre_id    INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
          enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at  TEXT NOT NULL,
          UNIQUE (kind, match_key)
        );

        -- Additional internal genre labels (the primary genre stays on tracks.genre).
        CREATE TABLE track_genres (
          track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          genre_id INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
          PRIMARY KEY (track_id, genre_id)
        );

        -- Library maintenance queue. Decisions persist across sessions and rescans.
        CREATE TABLE review_items (
          id          INTEGER PRIMARY KEY,
          kind        TEXT NOT NULL,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('track', 'release', 'file')),
          entity_id   INTEGER NOT NULL,
          status      TEXT NOT NULL DEFAULT 'needs_review'
                      CHECK (status IN ('needs_review', 'suggested', 'approved', 'ignored', 'resolved')),
          details     TEXT,
          suggestion  TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          UNIQUE (kind, entity_type, entity_id)
        );
        CREATE INDEX review_items_status ON review_items(status, kind);

        -- Journal of every change WaveMint makes (database edits and file operations).
        CREATE TABLE operations (
          id          INTEGER PRIMARY KEY,
          kind        TEXT NOT NULL,
          label       TEXT NOT NULL,
          status      TEXT NOT NULL
                      CHECK (status IN ('running', 'completed', 'failed', 'partial', 'undone', 'interrupted')),
          undoable    INTEGER NOT NULL DEFAULT 1 CHECK (undoable IN (0, 1)),
          undo_of     INTEGER REFERENCES operations(id) ON DELETE SET NULL,
          summary     TEXT,
          created_at  TEXT NOT NULL,
          finished_at TEXT
        );

        -- Per-file steps of a file operation; used for recovery after an interruption.
        CREATE TABLE operation_steps (
          id           INTEGER PRIMARY KEY,
          operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
          seq          INTEGER NOT NULL,
          action       TEXT NOT NULL,
          state        TEXT NOT NULL DEFAULT 'pending',
          file_id      INTEGER,
          track_id     INTEGER,
          target_path  TEXT,
          staged_path  TEXT,
          backup_path  TEXT,
          details      TEXT,
          error        TEXT,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX operation_steps_operation ON operation_steps(operation_id);

        -- Field-level history of metadata changes (values JSON-encoded).
        CREATE TABLE change_log (
          id           INTEGER PRIMARY KEY,
          operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL,
          entity_type  TEXT NOT NULL,
          entity_id    INTEGER NOT NULL,
          field        TEXT NOT NULL,
          old_value    TEXT,
          new_value    TEXT,
          created_at   TEXT NOT NULL
        );
        CREATE INDEX change_log_entity ON change_log(entity_type, entity_id);
        CREATE INDEX change_log_operation ON change_log(operation_id);
      `);
    },
  },
  {
    version: 3,
    name: "library merge: match decisions, merge sessions and groups",
    up(db) {
      db.exec(`
        -- The user's verdicts on pairs of songs; they outlive rescans and
        -- new analyses, so a rejected match is never suggested again.
        CREATE TABLE match_decisions (
          id         INTEGER PRIMARY KEY,
          track_a    INTEGER NOT NULL,
          track_b    INTEGER NOT NULL,
          decision   TEXT NOT NULL CHECK (decision IN ('same', 'different')),
          created_at TEXT NOT NULL,
          UNIQUE (track_a, track_b),
          CHECK (track_a < track_b)
        );

        CREATE TABLE merge_sessions (
          id          INTEGER PRIMARY KEY,
          status      TEXT NOT NULL CHECK (status IN ('analyzed', 'applied', 'discarded')),
          summary     TEXT,
          created_at  TEXT NOT NULL,
          applied_at  TEXT,
          operation_id INTEGER REFERENCES operations(id) ON DELETE SET NULL
        );

        -- One group per recording (or per uncertain pair) found by an analysis.
        CREATE TABLE merge_groups (
          id                 INTEGER PRIMARY KEY,
          session_id         INTEGER NOT NULL REFERENCES merge_sessions(id) ON DELETE CASCADE,
          category           TEXT NOT NULL
                             CHECK (category IN ('already_curated', 'legacy_only', 'curated_only', 'other_only', 'conflict')),
          confidence         REAL,
          track_ids          TEXT NOT NULL,
          preferred_track_id INTEGER,
          suggested_action   TEXT NOT NULL,
          action             TEXT NOT NULL,
          evidence           TEXT,
          decided            INTEGER NOT NULL DEFAULT 0 CHECK (decided IN (0, 1))
        );
        CREATE INDEX merge_groups_session ON merge_groups(session_id, category);
      `);
    },
  },
];

module.exports = { MIGRATIONS };
