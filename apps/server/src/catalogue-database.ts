import Database from 'better-sqlite3'
import { migrateLegacyCatalogue } from '@archivist/catalogue'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

let catalogueDb: Database.Database | null = null
let activeCataloguePath: string | null = null
let activeArtworkRoot: string | null = null

const SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS catalog_metadata (
  dataset_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL DEFAULT 1,
  dataset_version TEXT NOT NULL DEFAULT '', source_name TEXT NOT NULL DEFAULT 'tmdb',
  generated_at TEXT, imported_at TEXT, default_language TEXT NOT NULL DEFAULT 'en-US',
  default_region TEXT NOT NULL DEFAULT 'US', artwork_root TEXT NOT NULL DEFAULT './data/catalogue/artwork',
  checksum_algorithm TEXT NOT NULL DEFAULT 'sha256', film_count INTEGER NOT NULL DEFAULT 0,
  person_count INTEGER NOT NULL DEFAULT 0, asset_count INTEGER NOT NULL DEFAULT 0,
  manifest_checksum TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS catalog_collections (
  collection_id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_tmdb_id INTEGER UNIQUE, name TEXT NOT NULL,
  overview TEXT, poster_asset_id INTEGER, backdrop_asset_id INTEGER,
  metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS catalog_companies (
  company_id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_tmdb_id INTEGER UNIQUE, name TEXT NOT NULL,
  normalized_name TEXT NOT NULL, origin_country TEXT, logo_asset_id INTEGER,
  metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS catalog_films (
  film_id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_tmdb_id INTEGER UNIQUE, imdb_id TEXT,
  title TEXT NOT NULL, original_title TEXT, sort_title TEXT NOT NULL, original_language TEXT,
  overview TEXT, tagline TEXT, runtime_minutes INTEGER, primary_release_date TEXT, release_year INTEGER,
  adult INTEGER NOT NULL DEFAULT 0, video INTEGER NOT NULL DEFAULT 0, release_status TEXT,
  popularity REAL, vote_average REAL, vote_count INTEGER, budget INTEGER, revenue INTEGER, homepage TEXT,
  collection_id INTEGER REFERENCES catalog_collections(collection_id),
  primary_studio_company_id INTEGER REFERENCES catalog_companies(company_id), primary_country_code TEXT,
  default_poster_asset_id INTEGER, default_backdrop_asset_id INTEGER, default_logo_asset_id INTEGER,
  default_banner_asset_id INTEGER, default_trailer_video_id INTEGER, source_created_at TEXT,
  metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_films_imdb ON catalog_films(imdb_id) WHERE imdb_id IS NOT NULL AND imdb_id <> '';
CREATE INDEX IF NOT EXISTS idx_catalog_films_title ON catalog_films(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_catalog_films_release ON catalog_films(primary_release_date);
CREATE INDEX IF NOT EXISTS idx_catalog_films_discovery ON catalog_films(popularity DESC, vote_average DESC, vote_count DESC);
CREATE TABLE IF NOT EXISTS catalog_external_ids (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  id_type TEXT NOT NULL, external_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, PRIMARY KEY(film_id,id_type,external_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_external_namespace ON catalog_external_ids(id_type,external_id);
CREATE TABLE IF NOT EXISTS catalog_genres (
  genre_id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS catalog_genre_aliases (
  alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, genre_id INTEGER NOT NULL REFERENCES catalog_genres(genre_id),
  media_type TEXT NOT NULL DEFAULT 'film', active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(media_type,normalized_alias)
);
CREATE TABLE IF NOT EXISTS catalog_film_genres (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES catalog_genres(genre_id), billing_order INTEGER NOT NULL,
  PRIMARY KEY(film_id,genre_id), UNIQUE(film_id,billing_order)
);
CREATE TABLE IF NOT EXISTS catalog_countries (country_code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_film_countries (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  country_code TEXT NOT NULL REFERENCES catalog_countries(country_code), billing_order INTEGER NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(film_id,country_code)
);
CREATE TABLE IF NOT EXISTS catalog_film_companies (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES catalog_companies(company_id), company_role TEXT NOT NULL DEFAULT 'production',
  billing_order INTEGER NOT NULL, is_primary_studio INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(film_id,company_id,company_role)
);
CREATE TABLE IF NOT EXISTS catalog_people (
  person_id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_tmdb_id INTEGER UNIQUE, name TEXT NOT NULL,
  normalized_name TEXT NOT NULL, original_name TEXT, known_for_department TEXT, biography TEXT, birthday TEXT,
  deathday TEXT, place_of_birth TEXT, gender INTEGER, adult INTEGER NOT NULL DEFAULT 0, imdb_id TEXT,
  homepage TEXT, popularity REAL, profile_asset_id INTEGER,
  metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_people_name ON catalog_people(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS catalog_film_cast (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES catalog_people(person_id), credit_id TEXT,
  character_name TEXT, billing_order INTEGER NOT NULL, cast_id INTEGER, department TEXT,
  PRIMARY KEY(film_id,person_id,billing_order)
);
CREATE TABLE IF NOT EXISTS catalog_film_crew (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES catalog_people(person_id), credit_id TEXT,
  department TEXT, job TEXT NOT NULL, normalized_role TEXT NOT NULL, billing_order INTEGER NOT NULL,
  PRIMARY KEY(film_id,person_id,job,billing_order)
);
CREATE INDEX IF NOT EXISTS idx_catalog_crew_role ON catalog_film_crew(normalized_role,person_id,film_id);
CREATE TABLE IF NOT EXISTS catalog_role_aliases (
  raw_job TEXT PRIMARY KEY, normalized_job TEXT NOT NULL, department TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS catalog_person_known_for (
  person_id INTEGER NOT NULL REFERENCES catalog_people(person_id) ON DELETE CASCADE,
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE, billing_order INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'popularity', PRIMARY KEY(person_id,film_id,source)
);
CREATE TABLE IF NOT EXISTS catalog_release_type_codes (
  release_type INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_release_events (
  release_event_id INTEGER PRIMARY KEY AUTOINCREMENT, film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  country_code TEXT NOT NULL, release_date TEXT NOT NULL, release_type INTEGER NOT NULL,
  certification TEXT, note TEXT, language_code TEXT, is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(film_id,country_code,release_date,release_type,note)
);
CREATE INDEX IF NOT EXISTS idx_catalog_release_calendar ON catalog_release_events(release_date,country_code,release_type);
CREATE TABLE IF NOT EXISTS catalog_alternative_titles (
  alternative_title_id INTEGER PRIMARY KEY AUTOINCREMENT, film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  country_code TEXT, title TEXT NOT NULL, title_type TEXT, billing_order INTEGER NOT NULL,
  UNIQUE(film_id,country_code,title,title_type)
);
CREATE TABLE IF NOT EXISTS catalog_edition_labels (
  edition_label_id INTEGER PRIMARY KEY AUTOINCREMENT, film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  label TEXT NOT NULL, normalized_label TEXT NOT NULL, source TEXT NOT NULL, source_release_event_id INTEGER,
  confidence REAL NOT NULL DEFAULT 1, UNIQUE(film_id,normalized_label,source)
);
CREATE TABLE IF NOT EXISTS catalog_videos (
  video_id INTEGER PRIMARY KEY AUTOINCREMENT, film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  legacy_tmdb_key TEXT UNIQUE, site TEXT NOT NULL, video_key TEXT NOT NULL, name TEXT,
  video_type TEXT, official INTEGER NOT NULL DEFAULT 0, published_at TEXT, language_code TEXT,
  country_code TEXT, size INTEGER, billing_order INTEGER NOT NULL DEFAULT 0, is_selected INTEGER NOT NULL DEFAULT 0,
  UNIQUE(site,video_key)
);
CREATE TABLE IF NOT EXISTS catalog_keywords (
  keyword_id INTEGER PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS catalog_film_keywords (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL REFERENCES catalog_keywords(keyword_id), billing_order INTEGER NOT NULL,
  PRIMARY KEY(film_id,keyword_id)
);
CREATE TABLE IF NOT EXISTS catalog_watch_providers (
  provider_id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_tmdb_id INTEGER UNIQUE, name TEXT NOT NULL,
  normalized_name TEXT NOT NULL, logo_asset_id INTEGER, global_display_priority INTEGER,
  active INTEGER NOT NULL DEFAULT 1, metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS catalog_film_watch_availability (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES catalog_watch_providers(provider_id), country_code TEXT NOT NULL,
  monetization_type TEXT NOT NULL, display_priority INTEGER, link TEXT, observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT, PRIMARY KEY(film_id,provider_id,country_code,monetization_type)
);
CREATE TABLE IF NOT EXISTS catalog_artwork_assets (
  asset_id INTEGER PRIMARY KEY AUTOINCREMENT, owner_type TEXT NOT NULL, owner_id INTEGER NOT NULL,
  artwork_type TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'tmdb', source_asset_id TEXT,
  source_url TEXT, language_code TEXT, country_code TEXT, width INTEGER, height INTEGER,
  aspect_ratio REAL, vote_average REAL, vote_count INTEGER, billing_order INTEGER NOT NULL DEFAULT 0,
  is_selected INTEGER NOT NULL DEFAULT 0, selection_reason TEXT, file_extension TEXT,
  mime_type TEXT, byte_size INTEGER, checksum TEXT, local_path TEXT, fetched_at TEXT,
  metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT,
  UNIQUE(owner_type,owner_id,artwork_type,source,source_asset_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_artwork_owner ON catalog_artwork_assets(owner_type,owner_id,artwork_type,is_selected DESC);
CREATE TABLE IF NOT EXISTS catalog_artwork_variants (
  variant_id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL REFERENCES catalog_artwork_assets(asset_id) ON DELETE CASCADE,
  variant_name TEXT NOT NULL, width INTEGER, height INTEGER, mime_type TEXT, file_extension TEXT,
  byte_size INTEGER, checksum TEXT, local_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(asset_id,variant_name)
);
CREATE TABLE IF NOT EXISTS catalog_film_recommendations (
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  recommended_film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'tmdb', score REAL, billing_order INTEGER NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(film_id,recommended_film_id,source)
);
CREATE TABLE IF NOT EXISTS catalog_discovery_feeds (
  feed_id INTEGER PRIMARY KEY AUTOINCREMENT, feed_type TEXT NOT NULL, region TEXT, language_code TEXT,
  snapshot_date TEXT NOT NULL, page INTEGER NOT NULL DEFAULT 1, total_pages INTEGER,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(feed_type,region,language_code,snapshot_date,page)
);
CREATE TABLE IF NOT EXISTS catalog_discovery_feed_items (
  feed_id INTEGER NOT NULL REFERENCES catalog_discovery_feeds(feed_id) ON DELETE CASCADE,
  film_id INTEGER NOT NULL REFERENCES catalog_films(film_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL, score REAL, PRIMARY KEY(feed_id,film_id), UNIQUE(feed_id,rank)
);
CREATE TABLE IF NOT EXISTS catalog_sync_state (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'tmdb',
  source_updated_at TEXT, last_checked_at TEXT, last_success_at TEXT, content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending', error_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  PRIMARY KEY(entity_type,entity_id,source)
);
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_films_fts USING fts5(title, original_title, alternative_titles);
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_people_fts USING fts5(name, original_name);
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_companies_fts USING fts5(name);

CREATE TABLE IF NOT EXISTS catalog_source_ids (
  entity_type TEXT NOT NULL, tmdb_id INTEGER NOT NULL, adult INTEGER NOT NULL DEFAULT 0,
  video INTEGER NOT NULL DEFAULT 0, popularity REAL, first_seen_date TEXT NOT NULL,
  last_seen_date TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(entity_type,tmdb_id)
);
CREATE TABLE IF NOT EXISTS catalog_movie_queue (
  tmdb_id INTEGER PRIMARY KEY, reason TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_at TEXT, done_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS catalog_artwork_queue (
  asset_id INTEGER PRIMARY KEY REFERENCES catalog_artwork_assets(asset_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_at TEXT, done_at TEXT, last_error TEXT
);
CREATE TABLE IF NOT EXISTS catalog_flow_definitions (
  flow_key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
  schedule TEXT, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_flow_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT, flow_key TEXT NOT NULL REFERENCES catalog_flow_definitions(flow_key),
  trigger_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', started_at TEXT,
  finished_at TEXT, current_step TEXT, processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER, succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  message TEXT, options_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_catalog_flow_runs_latest ON catalog_flow_runs(flow_key,run_id DESC);
CREATE TABLE IF NOT EXISTS catalog_flow_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES catalog_flow_runs(run_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, level TEXT NOT NULL, message TEXT NOT NULL,
  context_json TEXT
);
CREATE TABLE IF NOT EXISTS catalog_settings (
  setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO catalog_release_type_codes(release_type,name,description,sort_order) VALUES
  (1,'Premiere','Premiere or festival release',1),(2,'Theatrical limited','Limited theatrical release',2),
  (3,'Theatrical','Wide theatrical release',3),(4,'Digital','Digital release',4),
  (5,'Physical','Physical media release',5),(6,'TV','Television release',6);
INSERT OR IGNORE INTO catalog_role_aliases(raw_job,normalized_job,department) VALUES
  ('Director','director','Directing'),('Executive Producer','executive_producer','Production'),
  ('Producer','producer','Production'),('Screenplay','writer','Writing'),('Writer','writer','Writing'),
  ('Director of Photography','cinematographer','Camera'),('Original Music Composer','composer','Sound');
INSERT OR IGNORE INTO catalog_metadata(dataset_id,schema_version,dataset_version,source_name)
  VALUES('archivist-films',1,'','tmdb');
INSERT OR IGNORE INTO catalog_flow_definitions(flow_key,name,description,schedule,sort_order) VALUES
  ('daily-sync','Daily catalogue sync','Runs ID exports, change lists, movie hydration and artwork fetching.','Daily at 09:15 UTC',10),
  ('daily-id-import','TMDB daily ID exports','Streams the five TMDB ID inventories into the local catalogue.','Part of daily sync',20),
  ('changed-movies','Changed movie queue','Queues films reported by the TMDB change list.','Part of daily sync',30),
  ('hydrate-movies','Movie metadata hydration','Fetches queued movie bundles and populates canonical tables.','Continuous/manual',40),
  ('fetch-artwork','Artwork downloader','Downloads queued original artwork into catalogue storage.','Continuous/manual',50),
  ('integrity-check','Database integrity and index maintenance','Runs integrity checks, refreshes FTS indexes and catalogue counts.','Daily/manual',60);
`

export function cataloguePath(): string {
  return activeCataloguePath ?? resolve(process.env.ARCHIVIST_CATALOGUE_DB ?? './data/catalogue/catalogue.sqlite')
}

export function catalogueArtworkRoot(): string {
  return activeArtworkRoot ?? resolve(process.env.ARCHIVIST_CATALOGUE_ARTWORK ?? './data/catalogue/artwork')
}

export function initCatalogueDb(
  path = cataloguePath(),
  artworkRoot = resolve(process.env.ARCHIVIST_CATALOGUE_ARTWORK ?? join(dirname(path), 'artwork')),
): Database.Database {
  if (catalogueDb) return catalogueDb
  const resolvedPath = resolve(path)
  const legacyPath = join(dirname(resolvedPath), 'films.sqlite')
  if (!existsSync(resolvedPath) && resolvedPath !== legacyPath && existsSync(legacyPath)) {
    renameSync(legacyPath, resolvedPath)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${legacyPath}${suffix}`)) renameSync(`${legacyPath}${suffix}`, `${resolvedPath}${suffix}`)
    }
  }
  activeCataloguePath = resolvedPath
  activeArtworkRoot = resolve(artworkRoot)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(catalogueArtworkRoot(), { recursive: true })
  catalogueDb = new Database(resolvedPath)
  catalogueDb.pragma('journal_mode = WAL')
  catalogueDb.pragma('foreign_keys = ON')
  catalogueDb.pragma('busy_timeout = 5000')
  catalogueDb.pragma('synchronous = NORMAL')
  catalogueDb.exec(SCHEMA)
  migrateLegacyCatalogue(catalogueDb)
  catalogueDb.prepare('UPDATE catalog_metadata SET artwork_root = ? WHERE dataset_id = ?')
    .run(catalogueArtworkRoot(), 'archivist-catalogue')
  return catalogueDb
}

export function getCatalogueDb(): Database.Database {
  return catalogueDb ?? initCatalogueDb()
}

export function closeCatalogueDb(): void {
  if (!catalogueDb) return
  catalogueDb.close()
  catalogueDb = null
  activeCataloguePath = null
  activeArtworkRoot = null
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}
