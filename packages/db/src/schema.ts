import type BetterSqlite3 from 'better-sqlite3'
import { ensureColumn, runMigrations } from './migrations.js'

/**
 * Unified Archivist schema.
 *
 * One `archivist.sqlite` replaces the legacy shared DB + per-tab DBs. Every
 * media entity carries `library_id`; per-library uniqueness replaces the old
 * per-file uniqueness (e.g. UNIQUE(library_id, tmdb_id) instead of a global
 * UNIQUE(tmdb_id) per tab database).
 *
 * Scoped configuration tables (app_settings, root_folders, quality_profiles,
 * download_clients) use `library_id = 0` for the global scope — mirroring the
 * legacy split between shared.db and tab DB settings.
 *
 * Column names are preserved from the legacy schema because the locked
 * frontend consumes them verbatim.
 */

const SCHEMA = `
-- ── Libraries (replaces physical tab DBs) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS libraries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  db_path     TEXT NOT NULL UNIQUE,      -- compat metadata only; no file exists
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Scoped configuration (library_id = 0 means global scope) ────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  library_id INTEGER NOT NULL DEFAULT 0,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (library_id, key)
);

CREATE TABLE IF NOT EXISTS root_folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL DEFAULT 0,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(library_id, path)
);

CREATE TABLE IF NOT EXISTS quality_profiles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id       INTEGER NOT NULL DEFAULT 0,
  name             TEXT NOT NULL,
  upgrade_allowed  INTEGER NOT NULL DEFAULT 1,
  cutoff           TEXT NOT NULL DEFAULT 'WEB-DL-1080p',
  min_format_score INTEGER NOT NULL DEFAULT 0,
  items            TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quality_definitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id  INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 0,
  min_size    REAL,
  max_size    REAL,
  UNIQUE(library_id, title)
);

CREATE TABLE IF NOT EXISTS custom_formats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL DEFAULT 0,
  name              TEXT NOT NULL,
  include_when_renaming INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_format_specifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  custom_format_id INTEGER NOT NULL REFERENCES custom_formats(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  implementation   TEXT NOT NULL,
  negate           INTEGER NOT NULL DEFAULT 0,
  required         INTEGER NOT NULL DEFAULT 0,
  fields           TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS download_clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL,
  use_ssl    INTEGER NOT NULL DEFAULT 0,
  url_base   TEXT NOT NULL DEFAULT '',
  username   TEXT,
  password   TEXT,
  category   TEXT NOT NULL DEFAULT 'archivist',
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 1,
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Indexers (global; per-media routing lives in settings JSON) ─────────────
CREATE TABLE IF NOT EXISTS indexers_ts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'torrent',
  protocol TEXT NOT NULL DEFAULT 'cardigann',
  definition_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 25,
  redirect INTEGER NOT NULL DEFAULT 0,
  base_url TEXT NOT NULL DEFAULT '',
  api_path TEXT NOT NULL DEFAULT '/api',
  api_key TEXT,
  username TEXT,
  password TEXT,
  download_link_type TEXT NOT NULL DEFAULT 'torrent',
  minimum_seeders INTEGER NOT NULL DEFAULT 0,
  seed_ratio REAL,
  seed_time INTEGER,
  sync_profile_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  vip_expiration TEXT,
  additional_parameters TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT '{}',
  last_tested_at INTEGER,
  capabilities TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ── System jobs and events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  subject_type TEXT,
  subject_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  payload TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_system_jobs_status ON system_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_system_jobs_subject ON system_jobs(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  subject_type TEXT,
  subject_id TEXT,
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_system_events_ts ON system_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_system_events_subject ON system_events(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS missing_search_state (
  item_key         TEXT PRIMARY KEY,
  last_searched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playback_progress (
  profile_id       TEXT NOT NULL DEFAULT 'default',
  media_type       TEXT NOT NULL,
  media_id         INTEGER NOT NULL,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed        INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, media_type, media_id)
);
CREATE INDEX IF NOT EXISTS idx_playback_progress_updated ON playback_progress(profile_id, updated_at DESC);

-- Durable cursor used by native clients such as Kodi. Triggers ensure that
-- imports, metadata refreshes, edits and removals are observed regardless of
-- which server code path performed the write.
CREATE TABLE IF NOT EXISTS player_sync_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL DEFAULT 'library',
  media_type  TEXT,
  media_id    INTEGER,
  changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_sync_changes_scope ON player_sync_changes(scope, id);

CREATE TABLE IF NOT EXISTS player_media_probes (
  media_type    TEXT NOT NULL CHECK (media_type IN ('film', 'episode')),
  media_id      INTEGER NOT NULL,
  file_path     TEXT NOT NULL,
  file_size     INTEGER NOT NULL,
  file_mtime_ms REAL NOT NULL,
  payload       TEXT NOT NULL CHECK (json_valid(payload)),
  probed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (media_type, media_id)
);
CREATE INDEX IF NOT EXISTS idx_player_media_probes_path ON player_media_probes(file_path);

CREATE TABLE IF NOT EXISTS player_bookmarks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id       TEXT NOT NULL DEFAULT 'default',
  media_type       TEXT NOT NULL CHECK (media_type IN ('film', 'episode')),
  media_id         INTEGER NOT NULL,
  position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
  label            TEXT NOT NULL DEFAULT 'Bookmark',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_bookmarks_media
  ON player_bookmarks(profile_id, media_type, media_id, position_seconds);

CREATE TABLE IF NOT EXISTS player_preferences (
  profile_id     TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2, 3, 4, 5)),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  document       TEXT NOT NULL CHECK (json_valid(document)),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_preferences_updated ON player_preferences(updated_at DESC);

-- Browser authentication is separate from the service API token. The initial
-- bootstrap credential is never stored; it is valid only while auth_users is
-- empty and can create only the first administrator account.
CREATE TABLE IF NOT EXISTS auth_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  session_type TEXT NOT NULL CHECK (session_type IN ('bootstrap', 'user')),
  user_id      INTEGER REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at   INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (session_type = 'bootstrap' AND user_id IS NULL) OR
    (session_type = 'user' AND user_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_devices (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_devices_user ON auth_devices(user_id, revoked_at, created_at DESC);

-- ── Acquisition audit ledger and blocklist ───────────────────────────────────
-- tab_id / tab_name columns are preserved verbatim for the locked UI; in Archivist
-- they carry the library id and library name.
CREATE TABLE IF NOT EXISTS acquisition_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  tab_id INTEGER,
  tab_name TEXT,
  media_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  subject_title TEXT NOT NULL,
  release_guid TEXT,
  release_title TEXT NOT NULL,
  download_url TEXT NOT NULL,
  indexer_name TEXT,
  indexer_priority INTEGER,
  size_bytes INTEGER,
  seeders INTEGER,
  leechers INTEGER,
  publish_date TEXT,
  accepted INTEGER NOT NULL,
  score INTEGER NOT NULL,
  custom_tier INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  rejection_reasons TEXT NOT NULL,
  grabbed INTEGER NOT NULL DEFAULT 0,
  grab_result TEXT
);
CREATE INDEX IF NOT EXISTS idx_acquisition_decisions_subject
  ON acquisition_decisions(media_type, subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acquisition_decisions_release
  ON acquisition_decisions(release_guid, release_title);

CREATE TABLE IF NOT EXISTS release_blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  info_hash TEXT,
  release_guid TEXT,
  download_url TEXT,
  release_title TEXT NOT NULL,
  reason TEXT NOT NULL,
  tab_id INTEGER,
  media_type TEXT,
  subject_type TEXT,
  subject_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_release_blocklist_hash ON release_blocklist(info_hash);
CREATE INDEX IF NOT EXISTS idx_release_blocklist_guid ON release_blocklist(release_guid);

-- ── Media imports and manual-import matching ────────────────────────────────
CREATE TABLE IF NOT EXISTS media_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  tab_id INTEGER,
  tab_name TEXT,
  db_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  torrent_id TEXT,
  info_hash TEXT,
  source_path TEXT NOT NULL,
  destination_path TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  copy INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_media_imports_status ON media_imports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_media_imports_item ON media_imports(media_type, item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_imports_torrent ON media_imports(info_hash, torrent_id);

CREATE TABLE IF NOT EXISTS ignored_staged_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source_path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'removed'
);

CREATE TABLE IF NOT EXISTS torrent_match_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  torrent_id TEXT,
  info_hash TEXT,
  source_path TEXT,
  name TEXT,
  tab_id INTEGER NOT NULL,
  tab_name TEXT NOT NULL,
  db_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  status TEXT,
  score INTEGER NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_torrent_match_overrides_info_hash
  ON torrent_match_overrides(info_hash)
  WHERE info_hash IS NOT NULL AND info_hash != '';
CREATE INDEX IF NOT EXISTS idx_torrent_match_overrides_torrent ON torrent_match_overrides(torrent_id);
CREATE INDEX IF NOT EXISTS idx_torrent_match_overrides_source ON torrent_match_overrides(source_path);

-- ── Indexer RSS polling state ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS indexer_rss_state (
  indexer_id TEXT PRIMARY KEY,
  last_polled_at INTEGER,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_releases_found INTEGER NOT NULL DEFAULT 0,
  last_releases_grabbed INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  backoff_until INTEGER,
  highest_pub_date INTEGER NOT NULL DEFAULT 0,
  recent_guids TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',
  poll_interval_ms INTEGER NOT NULL DEFAULT 900000
);

-- ── Films ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS films (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  tmdb_id           INTEGER,
  imdb_id           TEXT,
  title             TEXT NOT NULL,
  original_title    TEXT,
  sort_title        TEXT,
  year              INTEGER,
  overview          TEXT,
  runtime           INTEGER,
  genres            TEXT NOT NULL DEFAULT '[]',
  poster_path       TEXT,
  backdrop_path     TEXT,
  logo_path         TEXT,
  banner_path       TEXT,
  trailer_url       TEXT,
  cast              TEXT,
  crew              TEXT,
  country           TEXT,
  rating            REAL,
  certification     TEXT,
  studio            TEXT,
  collection_tmdb_id INTEGER,
  collection_name   TEXT,
  collection_poster_path TEXT,
  collection_backdrop_path TEXT,
  collection_metadata_checked_at TEXT,
  status            TEXT NOT NULL DEFAULT 'wanted',
  monitored         INTEGER NOT NULL DEFAULT 1,
  quality_profile_id INTEGER,
  root_folder_path  TEXT,
  file_path         TEXT,
  file_size         INTEGER,
  quality           TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  download_progress REAL DEFAULT 0,
  info_hash         TEXT,
  release_date      TEXT,
  digital_release_date TEXT,
  physical_release_date TEXT,
  last_metadata_refresh_at TEXT,
  post_release_metadata_refreshed_at TEXT,
  acquired_at       TEXT,
  download_tier     INTEGER,
  target_tier       TEXT,
  target_resolution TEXT,
  target_source     TEXT,
  target_codec      TEXT,
  minimum_tier       TEXT,
  minimum_resolution TEXT,
  minimum_source     TEXT,
  minimum_codec      TEXT,
  available_versions TEXT,
  expected_version  TEXT,
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  current_tier      INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source    TEXT,
  current_codec     TEXT,
  current_release_group TEXT,
  current_edition   TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  default_edition_id INTEGER,
  UNIQUE(library_id, tmdb_id)
);
CREATE INDEX IF NOT EXISTS idx_films_library ON films(library_id);
CREATE INDEX IF NOT EXISTS idx_films_status ON films(status);
CREATE INDEX IF NOT EXISTS idx_films_title ON films(sort_title);

CREATE TABLE IF NOT EXISTS film_editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  edition_name TEXT NOT NULL,
  runtime INTEGER,
  release_date TEXT,
  overview TEXT,
  poster_path TEXT,
  backdrop_path TEXT,
  status TEXT NOT NULL DEFAULT 'wanted',
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  file_path TEXT,
  file_size INTEGER,
  quality TEXT,
  current_tier INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source TEXT,
  current_codec TEXT,
  current_release_group TEXT,
  current_edition TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_film_editions_film_id ON film_editions(film_id);

CREATE TABLE IF NOT EXISTS edition_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL DEFAULT 0,
  rule_name TEXT NOT NULL,
  regex_pattern TEXT NOT NULL,
  output_label TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- ── Series (four-level model: series → seasons → episodes → episode_files) ──
CREATE TABLE IF NOT EXISTS series (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  tvdb_id           INTEGER,
  tmdb_id           INTEGER,
  imdb_id           TEXT,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  year              INTEGER,
  overview          TEXT,
  network           TEXT,
  status            TEXT DEFAULT 'continuing',
  series_type       TEXT DEFAULT 'standard',
  runtime           INTEGER,
  genres            TEXT NOT NULL DEFAULT '[]',
  poster_path       TEXT,
  backdrop_path     TEXT,
  logo_path         TEXT,
  banner_path       TEXT,
  trailer_url       TEXT,
  cast              TEXT,
  crew              TEXT,
  country           TEXT,
  rating            REAL,
  certification     TEXT,
  language          TEXT DEFAULT 'en',
  monitored         INTEGER NOT NULL DEFAULT 1,
  quality_profile_id INTEGER,
  root_folder_path  TEXT,
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  target_tier       TEXT,
  target_resolution TEXT,
  target_source     TEXT,
  target_codec      TEXT,
  minimum_tier       TEXT,
  minimum_resolution TEXT,
  minimum_source     TEXT,
  minimum_codec      TEXT,
  air_time          TEXT,
  air_day           TEXT,
  last_metadata_refresh_at TEXT,
  next_metadata_refresh_at TEXT,
  refresh_interval_hours INTEGER,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(library_id, tvdb_id)
);
CREATE INDEX IF NOT EXISTS idx_series_library ON series(library_id);

CREATE TABLE IF NOT EXISTS seasons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id       INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_number   INTEGER NOT NULL,
  title           TEXT,
  overview        TEXT,
  poster_path     TEXT,
  episode_count   INTEGER DEFAULT 0,
  monitored       INTEGER NOT NULL DEFAULT 1,
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  download_progress REAL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  info_hash       TEXT,
  UNIQUE(series_id, season_number)
);

CREATE TABLE IF NOT EXISTS episode_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id      INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_number  INTEGER,
  file_path      TEXT NOT NULL,
  file_size      INTEGER,
  quality        TEXT,
  release_title  TEXT,
  added_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_episode_files_series ON episode_files(series_id);

CREATE TABLE IF NOT EXISTS episodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id       INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_id       INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  season_number   INTEGER NOT NULL,
  episode_number  INTEGER NOT NULL,
  tvdb_episode_id INTEGER,
  title           TEXT,
  overview        TEXT,
  air_date        TEXT,
  air_time        TEXT,
  air_timezone    TEXT,
  air_at          TEXT,
  air_time_source TEXT,
  runtime         INTEGER,
  still_path      TEXT,
  monitored       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'missing',
  file_path       TEXT,
  file_size       INTEGER,
  quality         TEXT,
  episode_file_id INTEGER REFERENCES episode_files(id) ON DELETE SET NULL,
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  current_tier    INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source  TEXT,
  current_codec   TEXT,
  current_release_group TEXT,
  current_edition TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  download_progress REAL DEFAULT 0,
  info_hash       TEXT,
  UNIQUE(series_id, season_number, episode_number)
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes(series_id);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_episodes_air_date ON episodes(air_date);

CREATE TABLE IF NOT EXISTS new_release_search_state (
  episode_id       INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  air_at           TEXT NOT NULL,
  phase            TEXT NOT NULL DEFAULT 'pending'
    CHECK (phase IN ('pending','rss','targeted','backlog','complete','cancelled')),
  next_run_at      INTEGER NOT NULL,
  rss_attempts     INTEGER NOT NULL DEFAULT 0,
  targeted_attempts INTEGER NOT NULL DEFAULT 0,
  last_run_at      INTEGER,
  last_result      TEXT,
  last_error       TEXT,
  completed_at     INTEGER,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_new_release_search_due ON new_release_search_state(phase, next_run_at);

-- ── Music ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artists (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  musicbrainz_id    TEXT,
  name              TEXT NOT NULL,
  sort_name         TEXT,
  overview          TEXT,
  disambiguation    TEXT,
  genres            TEXT NOT NULL DEFAULT '[]',
  album_types       TEXT NOT NULL DEFAULT '[]',
  image_url         TEXT,
  backdrop_url      TEXT,
  logo_url          TEXT,
  monitored         INTEGER NOT NULL DEFAULT 1,
  root_folder_path  TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(library_id, musicbrainz_id)
);
CREATE INDEX IF NOT EXISTS idx_artists_library ON artists(library_id);

CREATE TABLE IF NOT EXISTS albums (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id       INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  musicbrainz_id  TEXT,
  title           TEXT NOT NULL,
  release_date    TEXT,
  year            INTEGER,
  album_type      TEXT DEFAULT 'Album',
  genres          TEXT NOT NULL DEFAULT '[]',
  cover_url       TEXT,
  cdart_url       TEXT,
  label           TEXT,
  track_count     INTEGER DEFAULT 0,
  monitored       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'missing',
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  target_tier     TEXT,
  current_tier    INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source  TEXT,
  current_codec   TEXT,
  current_release_group TEXT,
  current_edition TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  download_progress REAL DEFAULT 0,
  info_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
CREATE INDEX IF NOT EXISTS idx_albums_mbid ON albums(musicbrainz_id);

CREATE TABLE IF NOT EXISTS tracks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id        INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  artist_id       INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  musicbrainz_id  TEXT,
  title           TEXT NOT NULL,
  track_number    INTEGER,
  disc_number     INTEGER DEFAULT 1,
  duration        INTEGER,
  monitored       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'missing',
  file_path       TEXT,
  file_size       INTEGER,
  quality         TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  download_progress REAL DEFAULT 0,
  info_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);

-- ── Books and audiobooks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS authors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  sort_name         TEXT,
  overview          TEXT,
  image_url         TEXT,
  genres            TEXT NOT NULL DEFAULT '[]',
  monitored         INTEGER NOT NULL DEFAULT 1,
  root_folder_path  TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_authors_library ON authors(library_id);

CREATE TABLE IF NOT EXISTS books (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id         INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  google_books_id   TEXT,
  isbn_13           TEXT,
  title             TEXT NOT NULL,
  subtitle          TEXT,
  series_name       TEXT,
  series_position   REAL,
  published_date    TEXT,
  year              INTEGER,
  publisher         TEXT,
  page_count        INTEGER,
  overview          TEXT,
  genres            TEXT NOT NULL DEFAULT '[]',
  cover_url         TEXT,
  language          TEXT DEFAULT 'en',
  monitored         INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'missing',
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  target_tier       TEXT,
  current_tier      INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source    TEXT,
  current_codec     TEXT,
  current_release_group TEXT,
  current_edition   TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  download_progress REAL DEFAULT 0,
  info_hash         TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_author ON books(author_id);
CREATE INDEX IF NOT EXISTS idx_books_series ON books(series_name);

CREATE TABLE IF NOT EXISTS book_editions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format      TEXT NOT NULL,
  narrator    TEXT,
  duration_minutes INTEGER,
  file_path   TEXT,
  file_size   INTEGER,
  status      TEXT NOT NULL DEFAULT 'missing',
  added_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Comics ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comic_series (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  comicvine_id      INTEGER,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  start_year        INTEGER,
  publisher         TEXT,
  overview          TEXT,
  genres            TEXT NOT NULL DEFAULT '[]',
  image_url         TEXT,
  issue_count       INTEGER DEFAULT 0,
  series_type       TEXT DEFAULT 'ongoing',
  status            TEXT DEFAULT 'continuing',
  monitored         INTEGER NOT NULL DEFAULT 1,
  root_folder_path  TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(library_id, comicvine_id)
);
CREATE INDEX IF NOT EXISTS idx_comic_series_library ON comic_series(library_id);

CREATE TABLE IF NOT EXISTS comic_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id       INTEGER NOT NULL REFERENCES comic_series(id) ON DELETE CASCADE,
  comicvine_id    INTEGER,
  issue_number    TEXT NOT NULL,
  title           TEXT,
  cover_date      TEXT,
  year            INTEGER,
  overview        TEXT,
  image_url       TEXT,
  monitored       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'missing',
  file_path       TEXT,
  file_size       INTEGER,
  format          TEXT DEFAULT 'cbz',
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  current_tier    INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source  TEXT,
  current_codec   TEXT,
  current_release_group TEXT,
  current_edition TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  added_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  download_progress REAL DEFAULT 0,
  info_hash       TEXT,
  UNIQUE(series_id, issue_number)
);
CREATE INDEX IF NOT EXISTS idx_issues_series ON comic_issues(series_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON comic_issues(status);

-- ── Games ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  igdb_id           INTEGER,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  year              INTEGER,
  overview          TEXT,
  genres            TEXT NOT NULL DEFAULT '[]',
  platforms         TEXT NOT NULL DEFAULT '[]',
  cover_url         TEXT,
  screenshot_url    TEXT,
  rating            REAL,
  developer         TEXT,
  publisher         TEXT,
  release_date      TEXT,
  status            TEXT NOT NULL DEFAULT 'wanted',
  monitored         INTEGER NOT NULL DEFAULT 1,
  root_folder_path  TEXT,
  file_path         TEXT,
  file_size         INTEGER,
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  target_tier       TEXT,
  current_tier      INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT,
  current_source    TEXT,
  current_codec     TEXT,
  current_release_group TEXT,
  current_edition   TEXT,
  current_size_bytes INTEGER,
  current_release_title TEXT,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  download_progress REAL DEFAULT 0,
  info_hash         TEXT,
  UNIQUE(library_id, igdb_id)
);
CREATE INDEX IF NOT EXISTS idx_games_library ON games(library_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

-- ── Channels (personal TV network / scheduled VOD guide) ─────────────────────
-- See archivist-channels.md. A channel is a branded programming lane; blocks
-- are recurring themed windows; slots are the materialized guide; sessions are
-- "watch from here" playback queues built from the guide.
CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      INTEGER NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  brand_color TEXT NOT NULL DEFAULT '#00D4FF',
  logo_url    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  seed        INTEGER NOT NULL DEFAULT 0,     -- deterministic tie-breaks in the scheduler
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programming_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  days_of_week TEXT NOT NULL DEFAULT '[]',    -- JSON array of 0-6 (0 = Sunday)
  start_minute INTEGER NOT NULL,              -- minutes from local midnight
  end_minute   INTEGER NOT NULL,              -- > start; may pass 1440 (overnight)
  rules        TEXT NOT NULL DEFAULT '{}',    -- BlockRules JSON (see channels/scheduler.ts)
  priority     INTEGER NOT NULL DEFAULT 0,    -- higher wins when blocks overlap
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_blocks_channel ON programming_blocks(channel_id);

CREATE TABLE IF NOT EXISTS schedule_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  block_id   INTEGER REFERENCES programming_blocks(id) ON DELETE SET NULL,
  item_type  TEXT NOT NULL,                   -- 'film' | 'episode'
  item_id    INTEGER NOT NULL,
  starts_at  INTEGER NOT NULL,                -- unix millis
  ends_at    INTEGER NOT NULL,                -- unix millis
  sequence   INTEGER NOT NULL DEFAULT 0,
  slot_type  TEXT NOT NULL DEFAULT 'programme',
  status     TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | watched
  locked     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_slots_channel_time ON schedule_slots(channel_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_slots_item ON schedule_slots(item_type, item_id, starts_at DESC);

CREATE TABLE IF NOT EXISTS play_sessions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id           INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  started_from_slot_id INTEGER,
  mode                 TEXT NOT NULL DEFAULT 'WATCH_FROM_HERE', -- | PLAY_THIS_ONLY | JOIN_LIVE
  status               TEXT NOT NULL DEFAULT 'active',          -- active | ended
  current_position     INTEGER NOT NULL DEFAULT 1,
  started_at           TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at             TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS play_session_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           INTEGER NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
  schedule_slot_id     INTEGER,
  item_type            TEXT NOT NULL,
  item_id              INTEGER NOT NULL,
  queue_position       INTEGER NOT NULL,
  start_offset_seconds INTEGER NOT NULL DEFAULT 0,
  completed_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_items ON play_session_items(session_id, queue_position);

-- ── Loudness measurements (EBU R128) for volume normalization ────────────────
-- Per-file integrated loudness so playback can normalize levels across titles
-- (server-side loudnorm in the transcode; client-side gain for direct play).
CREATE TABLE IF NOT EXISTS media_loudness (
  media_type      TEXT NOT NULL,          -- 'film' | 'episode'
  media_id        INTEGER NOT NULL,
  file_path       TEXT NOT NULL,          -- detect re-imports / file changes
  integrated_lufs REAL,                   -- input_i
  true_peak       REAL,                   -- input_tp (dBTP)
  lra             REAL,                   -- input_lra
  threshold       REAL,                   -- input_thresh
  measured_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (media_type, media_id)
);

-- ── Recurring TV segments (intro / credits) ────────────────────────────────
-- Detection is keyed by a bounded content signature rather than a mutable
-- path. Episode links are replaced whenever a file changes; the expensive
-- fingerprints remain reusable while another episode references the same file.
CREATE TABLE IF NOT EXISTS media_segments (
  media_signature       TEXT PRIMARY KEY,
  signature_algorithm   TEXT NOT NULL DEFAULT 'sampled-sha256-v1',
  file_size             INTEGER NOT NULL,
  intro_start_seconds   REAL,
  intro_end_seconds     REAL,
  intro_method          TEXT,
  intro_confidence      REAL,
  credits_start_seconds REAL,
  credits_end_seconds   REAL,
  credits_method        TEXT,
  credits_confidence    REAL,
  audio_stream_index    INTEGER,
  audio_language        TEXT,
  audio_title           TEXT,
  audio_codec           TEXT,
  audio_channels        INTEGER,
  analysis_evidence     TEXT NOT NULL DEFAULT '{}',
  manually_locked       INTEGER NOT NULL DEFAULT 0,
  analysis_set_hash     TEXT,
  detector_version      TEXT NOT NULL,
  analysis_state        TEXT NOT NULL DEFAULT 'pending'
    CHECK (analysis_state IN ('pending','queued','analysing','detected','partial','no_match','failed','cancelled')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  analysed_at           TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_segments_state ON media_segments(analysis_state, updated_at);

CREATE TABLE IF NOT EXISTS media_segment_fingerprints (
  media_signature  TEXT NOT NULL REFERENCES media_segments(media_signature) ON DELETE CASCADE,
  window_kind      TEXT NOT NULL CHECK (window_kind IN ('head','tail')),
  algorithm        TEXT NOT NULL,
  encoding         TEXT NOT NULL DEFAULT 'zlib-int32le-v1',
  fingerprint      BLOB NOT NULL,
  frame_count      INTEGER NOT NULL,
  seconds_per_frame REAL NOT NULL,
  processed_start  REAL NOT NULL,
  processed_duration REAL NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (media_signature, window_kind, algorithm)
);

CREATE TABLE IF NOT EXISTS media_segment_links (
  episode_id      INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  media_signature TEXT NOT NULL REFERENCES media_segments(media_signature) ON DELETE RESTRICT,
  file_path       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  linked_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_media_segment_links_signature ON media_segment_links(media_signature);

CREATE TABLE IF NOT EXISTS media_segment_overrides (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL,
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (series_id, season_number)
);
`

/** Default quality profiles seeded per scope (library or global). */
export const DEFAULT_QUALITY_PROFILES = [
  { name: 'Any',        cutoff: 'Unknown',            items: ['Unknown', 'SDTV', 'DVD', 'HDTV-720p', 'WEB-DL-720p', 'Bluray-720p', 'WEB-DL-1080p', 'Bluray-1080p', 'WEB-DL-2160p'] },
  { name: 'HD - 720p',  cutoff: 'WEB-DL-720p',        items: ['HDTV-720p', 'WEB-DL-720p', 'Bluray-720p'] },
  { name: 'HD - 1080p', cutoff: 'WEB-DL-1080p',       items: ['WEB-DL-1080p', 'Bluray-1080p', 'WEBRip-1080p', 'HDTV-1080p'] },
  { name: '4K',         cutoff: 'WEB-DL-2160p',       items: ['WEB-DL-2160p', 'Bluray-2160p', 'Bluray-2160p-Remux'] },
  { name: 'Lossless',   cutoff: 'Bluray-1080p-Remux', items: ['Bluray-1080p-Remux', 'Bluray-2160p-Remux'] },
]

/** Legacy default edition rules, seeded per films library on first access. */
export const DEFAULT_EDITION_RULES = [
  { name: "Director's Cut", pattern: "(?i)(director'?s\\s*cut)", label: "Director's Cut", priority: 10 },
  { name: 'Extended Edition', pattern: '(?i)(extended)', label: 'Extended', priority: 10 },
  { name: 'Remastered', pattern: '(?i)(remastered)', label: 'Remastered', priority: 5 },
  { name: 'Unrated', pattern: '(?i)(unrated)', label: 'Unrated', priority: 10 },
  { name: 'Final Cut', pattern: '(?i)(final\\s*cut)', label: 'Final Cut', priority: 10 },
  { name: 'Redux', pattern: '(?i)(redux)', label: 'Redux', priority: 10 },
  { name: 'Rogue Cut', pattern: '(?i)(rogue\\s*cut)', label: 'The Rogue Cut', priority: 10 },
  { name: 'Despecialized', pattern: '(?i)(despecialized)', label: 'Despecialized Edition', priority: 20 },
]

export function seedQualityProfiles(db: BetterSqlite3.Database, libraryId: number): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM quality_profiles WHERE library_id = ?').get(libraryId) as { n: number }).n
  if (count > 0) return
  const insert = db.prepare('INSERT INTO quality_profiles (library_id, name, cutoff, items) VALUES (?, ?, ?, ?)')
  for (const p of DEFAULT_QUALITY_PROFILES) {
    insert.run(libraryId, p.name, p.cutoff, JSON.stringify(p.items))
  }
}

export function seedEditionRules(db: BetterSqlite3.Database, libraryId: number): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM edition_rules WHERE library_id = ?').get(libraryId) as { n: number }).n
  if (count > 0) return
  const insert = db.prepare('INSERT INTO edition_rules (library_id, rule_name, regex_pattern, output_label, priority) VALUES (?, ?, ?, ?, ?)')
  for (const r of DEFAULT_EDITION_RULES) {
    insert.run(libraryId, r.name, r.pattern, r.label, r.priority)
  }
}

/**
 * Applies the unified schema and all versioned migrations. Idempotent —
 * safe to run on every boot.
 */
export function applySchema(db: BetterSqlite3.Database): void {
  assertNotForeignDatabase(db)
  db.exec(SCHEMA)

  runMigrations(db, [
    {
      version: 1,
      description: 'Seed global-scope quality profiles',
      up: db => seedQualityProfiles(db, 0),
    },
    {
      version: 2,
      description: 'Add persistent automation and playback state',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS missing_search_state (
          item_key TEXT PRIMARY KEY,
          last_searched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS playback_progress (
          profile_id TEXT NOT NULL DEFAULT 'default',
          media_type TEXT NOT NULL,
          media_id INTEGER NOT NULL,
          position_seconds REAL NOT NULL DEFAULT 0,
          duration_seconds REAL,
          completed INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, media_type, media_id)
        );
        CREATE INDEX IF NOT EXISTS idx_playback_progress_updated ON playback_progress(profile_id, updated_at DESC);
      `),
    },
    {
      version: 3,
      description: 'Add local users and browser sessions',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS auth_users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token_hash   TEXT PRIMARY KEY,
          session_type TEXT NOT NULL CHECK (session_type IN ('bootstrap', 'user')),
          user_id      INTEGER REFERENCES auth_users(id) ON DELETE CASCADE,
          expires_at   INTEGER NOT NULL,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (
            (session_type = 'bootstrap' AND user_id IS NULL) OR
            (session_type = 'user' AND user_id IS NOT NULL)
          )
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
      `),
    },
    {
      version: 4,
      description: 'Add recurring TV segment analysis cache',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS media_segments (
          media_signature TEXT PRIMARY KEY,
          signature_algorithm TEXT NOT NULL DEFAULT 'sampled-sha256-v1',
          file_size INTEGER NOT NULL,
          intro_start_seconds REAL,
          intro_end_seconds REAL,
          intro_method TEXT,
          intro_confidence REAL,
          credits_start_seconds REAL,
          credits_end_seconds REAL,
          credits_method TEXT,
          credits_confidence REAL,
          analysis_set_hash TEXT,
          detector_version TEXT NOT NULL,
          analysis_state TEXT NOT NULL DEFAULT 'pending'
            CHECK (analysis_state IN ('pending','queued','analysing','detected','partial','no_match','failed','cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          analysed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_media_segments_state ON media_segments(analysis_state, updated_at);
        CREATE TABLE IF NOT EXISTS media_segment_fingerprints (
          media_signature TEXT NOT NULL REFERENCES media_segments(media_signature) ON DELETE CASCADE,
          window_kind TEXT NOT NULL CHECK (window_kind IN ('head','tail')),
          algorithm TEXT NOT NULL,
          encoding TEXT NOT NULL DEFAULT 'zlib-int32le-v1',
          fingerprint BLOB NOT NULL,
          frame_count INTEGER NOT NULL,
          seconds_per_frame REAL NOT NULL,
          processed_start REAL NOT NULL,
          processed_duration REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (media_signature, window_kind, algorithm)
        );
        CREATE TABLE IF NOT EXISTS media_segment_links (
          episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
          media_signature TEXT NOT NULL REFERENCES media_segments(media_signature) ON DELETE RESTRICT,
          file_path TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          linked_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_media_segment_links_signature ON media_segment_links(media_signature);
      `),
    },
    {
      version: 5,
      description: 'Add versioned player UI preferences',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS player_preferences (
          profile_id     TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          document       TEXT NOT NULL CHECK (json_valid(document)),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_player_preferences_updated
          ON player_preferences(updated_at DESC);
      `),
    },
    {
      version: 6,
      description: 'Add episode airtimes and durable new-release searches',
      up: db => {
        ensureColumn(db, 'episodes', 'air_time', 'ALTER TABLE episodes ADD COLUMN air_time TEXT')
        ensureColumn(db, 'episodes', 'air_timezone', 'ALTER TABLE episodes ADD COLUMN air_timezone TEXT')
        ensureColumn(db, 'episodes', 'air_at', 'ALTER TABLE episodes ADD COLUMN air_at TEXT')
        ensureColumn(db, 'episodes', 'air_time_source', 'ALTER TABLE episodes ADD COLUMN air_time_source TEXT')
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_episodes_air_at ON episodes(air_at);
          CREATE TABLE IF NOT EXISTS new_release_search_state (
            episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
            air_at TEXT NOT NULL,
            phase TEXT NOT NULL DEFAULT 'pending'
              CHECK (phase IN ('pending','rss','targeted','backlog','complete','cancelled')),
            next_run_at INTEGER NOT NULL,
            rss_attempts INTEGER NOT NULL DEFAULT 0,
            targeted_attempts INTEGER NOT NULL DEFAULT 0,
            last_run_at INTEGER,
            last_result TEXT,
            last_error TEXT,
            completed_at INTEGER,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_new_release_search_due ON new_release_search_state(phase, next_run_at);
        `)
      },
    },
    {
      version: 7,
      description: 'Track post-release film metadata refreshes',
      up: db => {
        ensureColumn(
          db,
          'films',
          'last_metadata_refresh_at',
          'ALTER TABLE films ADD COLUMN last_metadata_refresh_at TEXT',
        )
        ensureColumn(
          db,
          'films',
          'post_release_metadata_refreshed_at',
          'ALTER TABLE films ADD COLUMN post_release_metadata_refreshed_at TEXT',
        )
        db.exec(`
          UPDATE films
          SET post_release_metadata_refreshed_at = COALESCE(updated_at, datetime('now'))
          WHERE post_release_metadata_refreshed_at IS NULL
            AND date(COALESCE(release_date, digital_release_date, physical_release_date)) < date('now');
          CREATE INDEX IF NOT EXISTS idx_films_post_release_metadata
            ON films(post_release_metadata_refreshed_at, release_date);
        `)
      },
    },
    {
      version: 8,
      description: 'Allow configurable Player hub preference schema',
      up: db => db.exec(`
        ALTER TABLE player_preferences RENAME TO player_preferences_before_hubs;
        CREATE TABLE player_preferences (
          profile_id     TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
          revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          document       TEXT NOT NULL CHECK (json_valid(document)),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO player_preferences (profile_id, schema_version, revision, document, updated_at)
        SELECT profile_id, schema_version, revision, document, updated_at
        FROM player_preferences_before_hubs;
        DROP TABLE player_preferences_before_hubs;
        CREATE INDEX idx_player_preferences_updated
          ON player_preferences(updated_at DESC);
      `),
    },
    {
      version: 9,
      description: 'Add saved Player browsing and film collection metadata',
      up: db => {
        ensureColumn(db, 'films', 'collection_tmdb_id', 'ALTER TABLE films ADD COLUMN collection_tmdb_id INTEGER')
        ensureColumn(db, 'films', 'collection_name', 'ALTER TABLE films ADD COLUMN collection_name TEXT')
        ensureColumn(db, 'films', 'collection_poster_path', 'ALTER TABLE films ADD COLUMN collection_poster_path TEXT')
        ensureColumn(db, 'films', 'collection_backdrop_path', 'ALTER TABLE films ADD COLUMN collection_backdrop_path TEXT')
        ensureColumn(db, 'films', 'collection_metadata_checked_at', 'ALTER TABLE films ADD COLUMN collection_metadata_checked_at TEXT')
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_films_collection ON films(collection_tmdb_id);
          ALTER TABLE player_preferences RENAME TO player_preferences_before_browse;
          CREATE TABLE player_preferences (
            profile_id     TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2, 3)),
            revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            document       TEXT NOT NULL CHECK (json_valid(document)),
            updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO player_preferences (profile_id, schema_version, revision, document, updated_at)
          SELECT profile_id, schema_version, revision, document, updated_at
          FROM player_preferences_before_browse;
          DROP TABLE player_preferences_before_browse;
          CREATE INDEX idx_player_preferences_updated
            ON player_preferences(updated_at DESC);
        `)
      },
    },
    {
      version: 10,
      description: 'Add Player visual, detail, OSD preferences and bookmarks',
      up: db => {
        ensureColumn(db, 'films', 'trailer_url', 'ALTER TABLE films ADD COLUMN trailer_url TEXT')
        ensureColumn(db, 'series', 'trailer_url', 'ALTER TABLE series ADD COLUMN trailer_url TEXT')
        db.exec(`
        CREATE TABLE IF NOT EXISTS player_bookmarks (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id       TEXT NOT NULL DEFAULT 'default',
          media_type       TEXT NOT NULL CHECK (media_type IN ('film', 'episode')),
          media_id         INTEGER NOT NULL,
          position_seconds REAL NOT NULL CHECK (position_seconds >= 0),
          label            TEXT NOT NULL DEFAULT 'Bookmark',
          created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_player_bookmarks_media
          ON player_bookmarks(profile_id, media_type, media_id, position_seconds);
        ALTER TABLE player_preferences RENAME TO player_preferences_before_visuals;
        CREATE TABLE player_preferences (
          profile_id     TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2, 3, 4)),
          revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          document       TEXT NOT NULL CHECK (json_valid(document)),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO player_preferences (profile_id, schema_version, revision, document, updated_at)
        SELECT profile_id, schema_version, revision, document, updated_at
        FROM player_preferences_before_visuals;
        DROP TABLE player_preferences_before_visuals;
        CREATE INDEX idx_player_preferences_updated
          ON player_preferences(updated_at DESC);
        `)
      },
    },
    {
      version: 11,
      description: 'Allow Player availability and download filter preferences',
      up: db => db.exec(`
        ALTER TABLE player_preferences RENAME TO player_preferences_before_availability;
        CREATE TABLE player_preferences (
          profile_id     TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2, 3, 4, 5)),
          revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          document       TEXT NOT NULL CHECK (json_valid(document)),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO player_preferences (profile_id, schema_version, revision, document, updated_at)
        SELECT profile_id, schema_version, revision, document, updated_at
        FROM player_preferences_before_availability;
        DROP TABLE player_preferences_before_availability;
        CREATE INDEX idx_player_preferences_updated
          ON player_preferences(updated_at DESC);
      `),
    },
    {
      version: 12,
      description: 'Add advanced segment analysis evidence and overrides',
      up: db => {
        ensureColumn(db, 'media_segments', 'audio_stream_index', 'ALTER TABLE media_segments ADD COLUMN audio_stream_index INTEGER')
        ensureColumn(db, 'media_segments', 'audio_language', 'ALTER TABLE media_segments ADD COLUMN audio_language TEXT')
        ensureColumn(db, 'media_segments', 'audio_title', 'ALTER TABLE media_segments ADD COLUMN audio_title TEXT')
        ensureColumn(db, 'media_segments', 'audio_codec', 'ALTER TABLE media_segments ADD COLUMN audio_codec TEXT')
        ensureColumn(db, 'media_segments', 'audio_channels', 'ALTER TABLE media_segments ADD COLUMN audio_channels INTEGER')
        ensureColumn(db, 'media_segments', 'analysis_evidence', "ALTER TABLE media_segments ADD COLUMN analysis_evidence TEXT NOT NULL DEFAULT '{}'")
        ensureColumn(db, 'media_segments', 'manually_locked', 'ALTER TABLE media_segments ADD COLUMN manually_locked INTEGER NOT NULL DEFAULT 0')
        db.exec(`
          CREATE TABLE IF NOT EXISTS media_segment_overrides (
            series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
            season_number INTEGER NOT NULL,
            config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (series_id, season_number)
          );
        `)
      },
    },
    {
      version: 13,
      description: 'Add recommendation candidates, snapshots, feedback and engagement events',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS recommendation_source_candidates (
          media_type TEXT NOT NULL CHECK (media_type IN ('film', 'series')),
          provider_id INTEGER NOT NULL,
          source_key TEXT NOT NULL,
          payload TEXT NOT NULL CHECK (json_valid(payload)),
          fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          PRIMARY KEY (media_type, provider_id, source_key)
        );
        CREATE INDEX IF NOT EXISTS idx_recommendation_candidates_expiry
          ON recommendation_source_candidates(media_type, expires_at);

        CREATE TABLE IF NOT EXISTS recommendation_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          audience TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('film', 'series')),
          library_id INTEGER NOT NULL DEFAULT 0,
          model_version TEXT NOT NULL,
          items TEXT NOT NULL CHECK (json_valid(items)),
          generated_at TEXT NOT NULL DEFAULT (datetime('now')),
          invalidated_at TEXT,
          UNIQUE (audience, media_type, library_id)
        );
        CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_age
          ON recommendation_snapshots(generated_at, invalidated_at);

        CREATE TABLE IF NOT EXISTS recommendation_feedback (
          profile_id TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('film', 'series')),
          provider_id INTEGER NOT NULL,
          feedback TEXT NOT NULL CHECK (feedback IN ('more_like_this','less_like_this','not_interested','already_seen')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (profile_id, media_type, provider_id)
        );
        CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_profile
          ON recommendation_feedback(profile_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS recommendation_exposures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id TEXT NOT NULL,
          snapshot_id INTEGER REFERENCES recommendation_snapshots(id) ON DELETE SET NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('film', 'series')),
          provider_id INTEGER NOT NULL,
          surface TEXT NOT NULL,
          rank INTEGER NOT NULL,
          reason_code TEXT NOT NULL,
          outcome TEXT,
          exposed_at TEXT NOT NULL DEFAULT (datetime('now')),
          outcome_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_recommendation_exposures_profile
          ON recommendation_exposures(profile_id, exposed_at DESC);

        CREATE TABLE IF NOT EXISTS engagement_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('film', 'episode')),
          media_id INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('started','progress','completed','replayed','cleared')),
          progress_percent REAL,
          occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_engagement_events_profile
          ON engagement_events(profile_id, occurred_at DESC);
      `),
    },
    {
      version: 14,
      description: 'Add Film and Series quality envelope floors',
      up: db => {
        for (const table of ['films', 'series']) {
          ensureColumn(db, table, 'target_tier', `ALTER TABLE ${table} ADD COLUMN target_tier TEXT`)
          ensureColumn(db, table, 'target_resolution', `ALTER TABLE ${table} ADD COLUMN target_resolution TEXT`)
          ensureColumn(db, table, 'target_source', `ALTER TABLE ${table} ADD COLUMN target_source TEXT`)
          ensureColumn(db, table, 'target_codec', `ALTER TABLE ${table} ADD COLUMN target_codec TEXT`)
          ensureColumn(db, table, 'minimum_tier', `ALTER TABLE ${table} ADD COLUMN minimum_tier TEXT`)
          ensureColumn(db, table, 'minimum_resolution', `ALTER TABLE ${table} ADD COLUMN minimum_resolution TEXT`)
          ensureColumn(db, table, 'minimum_source', `ALTER TABLE ${table} ADD COLUMN minimum_source TEXT`)
          ensureColumn(db, table, 'minimum_codec', `ALTER TABLE ${table} ADD COLUMN minimum_codec TEXT`)
          db.exec(`UPDATE ${table} SET
            minimum_tier = COALESCE(minimum_tier, target_tier),
            minimum_resolution = COALESCE(minimum_resolution, target_resolution),
            minimum_source = COALESCE(minimum_source, target_source),
            minimum_codec = COALESCE(minimum_codec, target_codec)`)
        }
      },
    },
    {
      version: 15,
      description: 'Persist Player media probes for native client synchronization',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS player_media_probes (
          media_type    TEXT NOT NULL CHECK (media_type IN ('film', 'episode')),
          media_id      INTEGER NOT NULL,
          file_path     TEXT NOT NULL,
          file_size     INTEGER NOT NULL,
          file_mtime_ms REAL NOT NULL,
          payload       TEXT NOT NULL CHECK (json_valid(payload)),
          probed_at     TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (media_type, media_id)
        );
        CREATE INDEX IF NOT EXISTS idx_player_media_probes_path ON player_media_probes(file_path);
      `),
    },
    {
      version: 16,
      description: 'Add revocable native player device credentials',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS auth_devices (
          id           TEXT PRIMARY KEY,
          token_hash   TEXT NOT NULL UNIQUE,
          user_id      INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          name         TEXT NOT NULL,
          expires_at   INTEGER NOT NULL,
          last_seen_at INTEGER,
          revoked_at   INTEGER,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_devices_user
          ON auth_devices(user_id, revoked_at, created_at DESC);
      `),
    },
    {
      version: 17,
      description: 'Add durable native-player library change cursor',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS player_sync_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL DEFAULT 'library',
          media_type TEXT,
          media_id INTEGER,
          changed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_player_sync_changes_scope ON player_sync_changes(scope, id);
        CREATE TRIGGER IF NOT EXISTS player_sync_films_insert AFTER INSERT ON films BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('film', NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_films_update AFTER UPDATE OF
          title, original_title, sort_title, year, overview, runtime, genres,
          poster_path, backdrop_path, logo_path, banner_path, trailer_url, cast,
          crew, country, rating, certification, studio, collection_tmdb_id,
          collection_name, collection_poster_path, collection_backdrop_path,
          status, file_path, file_size, quality, acquired_at, default_edition_id,
          current_resolution, current_source, current_codec, current_edition
        ON films BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('film', NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_films_delete AFTER DELETE ON films BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('film', OLD.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_editions_insert AFTER INSERT ON film_editions BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('film', NEW.film_id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_editions_update AFTER UPDATE OF
          edition_name, runtime, release_date, overview, poster_path,
          backdrop_path, status, file_path, file_size, quality,
          current_resolution, current_source, current_codec, current_edition
        ON film_editions BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('film', NEW.film_id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_editions_delete AFTER DELETE ON film_editions BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('film', OLD.film_id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_series_insert AFTER INSERT ON series BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('series', NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_series_update AFTER UPDATE OF
          title, sort_title, year, overview, network, status, series_type,
          runtime, genres, poster_path, backdrop_path, logo_path, banner_path,
          trailer_url, cast, crew, country, rating, certification, language
        ON series BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('series', NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_series_delete AFTER DELETE ON series BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('series', OLD.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_seasons_insert AFTER INSERT ON seasons BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('series', NEW.series_id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_seasons_update AFTER UPDATE OF
          season_number, title, overview, poster_path, episode_count
        ON seasons BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('series', NEW.series_id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_seasons_delete AFTER DELETE ON seasons BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('series', OLD.series_id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_episodes_insert AFTER INSERT ON episodes BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('episode', NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_episodes_update AFTER UPDATE OF
          season_id, season_number, episode_number, title, overview, air_date,
          air_time, air_timezone, air_at, runtime, still_path, status, file_path,
          file_size, quality, current_resolution, current_source, current_codec,
          current_edition
        ON episodes BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('episode', NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS player_sync_episodes_delete AFTER DELETE ON episodes BEGIN
          INSERT INTO player_sync_changes (media_type, media_id) VALUES ('episode', OLD.id);
        END;
      `),
    },
  ])
}

/**
 * A pre-release Archivist prototype used the same default filename with an
 * incompatible schema (marker table `__archivist_migrations`). Refuse to run
 * against such a file so the failure is actionable instead of a random
 * "no such column" during CREATE INDEX.
 */
function assertNotForeignDatabase(db: BetterSqlite3.Database): void {
  const foreign = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__archivist_migrations'",
  ).get()
  if (foreign) {
    throw new Error(
      'This database was created by an incompatible pre-release Archivist prototype. '
      + 'Move or delete the file (plus its -wal/-shm siblings) and restart to let '
      + `Archivist create a fresh unified database. (${db.name})`,
    )
  }
}
