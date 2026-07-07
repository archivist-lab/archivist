import type BetterSqlite3 from 'better-sqlite3'
import { runMigrations } from './migrations.js'

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
  cast              TEXT,
  crew              TEXT,
  country           TEXT,
  rating            REAL,
  certification     TEXT,
  studio            TEXT,
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
  acquired_at       TEXT,
  download_tier     INTEGER,
  target_tier       TEXT,
  target_resolution TEXT,
  target_source     TEXT,
  target_codec      TEXT,
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
