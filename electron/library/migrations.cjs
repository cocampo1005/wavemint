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
];

module.exports = { MIGRATIONS };
