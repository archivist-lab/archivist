import type Database from 'better-sqlite3'

export const UNIVERSAL_CATALOGUE_SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS catalog_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL CHECK(media_type IN ('film','series','season','episode','book','music_release_group')),
  source TEXT NOT NULL, source_id TEXT NOT NULL,
  canonical_title TEXT NOT NULL, original_title TEXT, sort_title TEXT NOT NULL,
  description TEXT, original_language TEXT, first_release_date TEXT, release_year INTEGER,
  status TEXT, adult INTEGER NOT NULL DEFAULT 0,
  popularity REAL, rating REAL, rating_count INTEGER,
  completeness_status TEXT NOT NULL DEFAULT 'pending' CHECK(completeness_status IN ('pending','partial','complete','failed')),
  completeness_score REAL NOT NULL DEFAULT 0,
  default_poster_asset_id INTEGER, default_backdrop_asset_id INTEGER, default_logo_asset_id INTEGER,
  source_created_at TEXT, source_updated_at TEXT,
  metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT,
  UNIQUE(source,source_id,media_type)
);
CREATE INDEX IF NOT EXISTS idx_catalog_items_type_status ON catalog_items(media_type,completeness_status,deleted_at);
CREATE INDEX IF NOT EXISTS idx_catalog_items_title ON catalog_items(canonical_title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_catalog_items_release ON catalog_items(first_release_date);

CREATE TABLE IF NOT EXISTS catalog_item_external_ids (
  item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  source TEXT NOT NULL, external_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, PRIMARY KEY(item_id,source,external_id), UNIQUE(source,external_id)
);
CREATE TABLE IF NOT EXISTS catalog_item_titles (
  title_id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  title TEXT NOT NULL, normalized_title TEXT NOT NULL, title_type TEXT NOT NULL DEFAULT 'alternative',
  language_code TEXT, country_code TEXT, source TEXT, billing_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(item_id,title,title_type,language_code,country_code)
);
CREATE TABLE IF NOT EXISTS catalog_item_relations (
  source_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  target_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL, source TEXT, confidence REAL NOT NULL DEFAULT 1,
  PRIMARY KEY(source_item_id,target_item_id,relation_type)
);
CREATE TABLE IF NOT EXISTS catalog_item_genres (
  item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL REFERENCES catalog_genres(genre_id), billing_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(item_id,genre_id)
);

CREATE TABLE IF NOT EXISTS catalog_person_external_ids (
  person_id INTEGER NOT NULL REFERENCES catalog_people(person_id) ON DELETE CASCADE,
  source TEXT NOT NULL, external_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, PRIMARY KEY(person_id,source,external_id), UNIQUE(source,external_id)
);
CREATE TABLE IF NOT EXISTS catalog_person_aliases (
  alias_id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES catalog_people(person_id) ON DELETE CASCADE,
  name TEXT NOT NULL, normalized_name TEXT NOT NULL, language_code TEXT, source TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0, UNIQUE(person_id,normalized_name,source)
);
CREATE TABLE IF NOT EXISTS catalog_person_matches (
  match_id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES catalog_people(person_id) ON DELETE CASCADE,
  candidate_person_id INTEGER NOT NULL REFERENCES catalog_people(person_id) ON DELETE CASCADE,
  match_score REAL NOT NULL, match_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested' CHECK(status IN ('suggested','confirmed','rejected')),
  reviewed_at TEXT, reviewed_by TEXT, UNIQUE(person_id,candidate_person_id)
);
CREATE TABLE IF NOT EXISTS catalog_person_merges (
  merge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_person_id INTEGER NOT NULL, canonical_person_id INTEGER NOT NULL REFERENCES catalog_people(person_id),
  reason TEXT NOT NULL, snapshot_json TEXT NOT NULL, merged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_at TEXT, reversed_by TEXT
);

CREATE TABLE IF NOT EXISTS catalog_organisations (
  organisation_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  organisation_type TEXT NOT NULL DEFAULT 'organisation', country_code TEXT, founded_date TEXT,
  dissolved_date TEXT, description TEXT, homepage TEXT, default_logo_asset_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_organisations_name ON catalog_organisations(normalized_name);
CREATE TABLE IF NOT EXISTS catalog_organisation_external_ids (
  organisation_id INTEGER NOT NULL REFERENCES catalog_organisations(organisation_id) ON DELETE CASCADE,
  source TEXT NOT NULL, external_id TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, PRIMARY KEY(organisation_id,source,external_id), UNIQUE(source,external_id)
);
CREATE TABLE IF NOT EXISTS catalog_item_organisations (
  item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  organisation_id INTEGER NOT NULL REFERENCES catalog_organisations(organisation_id),
  role TEXT NOT NULL, billing_order INTEGER NOT NULL DEFAULT 0, is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(item_id,organisation_id,role)
);
CREATE TABLE IF NOT EXISTS catalog_credits (
  credit_id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES catalog_people(person_id), organisation_id INTEGER REFERENCES catalog_organisations(organisation_id),
  credit_type TEXT NOT NULL, role TEXT, raw_role TEXT, character_name TEXT, credited_as TEXT,
  department TEXT, billing_order INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
  source_credit_id TEXT, is_primary INTEGER NOT NULL DEFAULT 0,
  CHECK(person_id IS NOT NULL OR organisation_id IS NOT NULL),
  UNIQUE(item_id,person_id,organisation_id,credit_type,role,character_name,billing_order,source)
);
CREATE INDEX IF NOT EXISTS idx_catalog_credits_person ON catalog_credits(person_id,role,item_id);
CREATE INDEX IF NOT EXISTS idx_catalog_credits_item ON catalog_credits(item_id,credit_type,billing_order);

CREATE TABLE IF NOT EXISTS catalog_film_details (
  item_id INTEGER PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  legacy_film_id INTEGER UNIQUE, runtime_minutes INTEGER, tagline TEXT, budget INTEGER, revenue INTEGER,
  collection_source_id TEXT, homepage TEXT, video INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS catalog_series_details (
  item_id INTEGER PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  series_type TEXT, tagline TEXT, homepage TEXT, episode_runtime_minutes INTEGER,
  number_of_seasons INTEGER, number_of_episodes INTEGER, in_production INTEGER NOT NULL DEFAULT 0,
  last_air_date TEXT, next_air_date TEXT
);
CREATE TABLE IF NOT EXISTS catalog_seasons (
  item_id INTEGER PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  series_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL, episode_count INTEGER, air_date TEXT,
  UNIQUE(series_item_id,season_number)
);
CREATE TABLE IF NOT EXISTS catalog_episodes (
  item_id INTEGER PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  series_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  season_item_id INTEGER REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL, episode_number INTEGER NOT NULL,
  runtime_minutes INTEGER, air_date TEXT, production_code TEXT,
  UNIQUE(series_item_id,season_number,episode_number)
);

CREATE TABLE IF NOT EXISTS catalog_book_works (
  item_id INTEGER PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  work_type TEXT NOT NULL DEFAULT 'book', original_publication_date TEXT,
  subtitle TEXT, first_sentence TEXT, table_of_contents_json TEXT
);
CREATE TABLE IF NOT EXISTS catalog_book_editions (
  edition_id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT, subtitle TEXT,
  isbn_10 TEXT, isbn_13 TEXT, language_code TEXT, edition_statement TEXT,
  format TEXT, page_count INTEGER, publication_date TEXT, country_code TEXT,
  duration_seconds INTEGER, abridged INTEGER, cover_asset_id INTEGER,
  UNIQUE(source,source_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_book_isbn13 ON catalog_book_editions(isbn_13) WHERE isbn_13 IS NOT NULL;
CREATE TABLE IF NOT EXISTS catalog_book_series (
  series_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  description TEXT, source TEXT, source_id TEXT, UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_book_series_entries (
  series_id INTEGER NOT NULL REFERENCES catalog_book_series(series_id) ON DELETE CASCADE,
  work_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  position_text TEXT, position_number REAL, reading_order INTEGER,
  PRIMARY KEY(series_id,work_item_id)
);
CREATE TABLE IF NOT EXISTS catalog_book_contributions (
  contribution_id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  edition_id INTEGER REFERENCES catalog_book_editions(edition_id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES catalog_people(person_id), organisation_id INTEGER REFERENCES catalog_organisations(organisation_id),
  role TEXT NOT NULL, credited_as TEXT, billing_order INTEGER NOT NULL DEFAULT 0, source TEXT,
  CHECK(person_id IS NOT NULL OR organisation_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS catalog_book_publishers (
  publisher_id INTEGER PRIMARY KEY AUTOINCREMENT,
  organisation_id INTEGER NOT NULL REFERENCES catalog_organisations(organisation_id),
  parent_publisher_id INTEGER REFERENCES catalog_book_publishers(publisher_id), imprint_name TEXT
);
CREATE TABLE IF NOT EXISTS catalog_book_edition_publishers (
  edition_id INTEGER NOT NULL REFERENCES catalog_book_editions(edition_id) ON DELETE CASCADE,
  publisher_id INTEGER NOT NULL REFERENCES catalog_book_publishers(publisher_id),
  country_code TEXT, publication_date TEXT, PRIMARY KEY(edition_id,publisher_id,country_code)
);
CREATE TABLE IF NOT EXISTS catalog_book_contents (
  content_id INTEGER PRIMARY KEY AUTOINCREMENT, edition_id INTEGER NOT NULL REFERENCES catalog_book_editions(edition_id) ON DELETE CASCADE,
  parent_content_id INTEGER REFERENCES catalog_book_contents(content_id), content_type TEXT NOT NULL,
  title TEXT NOT NULL, position INTEGER NOT NULL, start_page INTEGER, duration_seconds INTEGER,
  contained_work_item_id INTEGER REFERENCES catalog_items(item_id)
);
CREATE TABLE IF NOT EXISTS catalog_book_awards (
  award_id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  award_name TEXT NOT NULL, category TEXT, award_year INTEGER, result TEXT, source TEXT
);
CREATE TABLE IF NOT EXISTS catalog_book_relations (
  source_work_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  target_work_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL, PRIMARY KEY(source_work_item_id,target_work_item_id,relation_type)
);

CREATE TABLE IF NOT EXISTS catalog_music_artists (
  artist_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL, artist_type TEXT NOT NULL DEFAULT 'person',
  person_id INTEGER REFERENCES catalog_people(person_id), organisation_id INTEGER REFERENCES catalog_organisations(organisation_id),
  begin_date TEXT, end_date TEXT, country_code TEXT, gender TEXT, disambiguation TEXT,
  source TEXT NOT NULL, source_id TEXT NOT NULL, default_image_asset_id INTEGER,
  UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_music_artist_members (
  artist_id INTEGER NOT NULL REFERENCES catalog_music_artists(artist_id) ON DELETE CASCADE,
  member_artist_id INTEGER REFERENCES catalog_music_artists(artist_id), person_id INTEGER REFERENCES catalog_people(person_id),
  role TEXT, begin_date TEXT, end_date TEXT, billing_order INTEGER NOT NULL DEFAULT 0,
  CHECK(member_artist_id IS NOT NULL OR person_id IS NOT NULL),
  UNIQUE(artist_id,member_artist_id,person_id,role,begin_date)
);
CREATE TABLE IF NOT EXISTS catalog_music_release_groups (
  item_id INTEGER PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  primary_artist_id INTEGER REFERENCES catalog_music_artists(artist_id),
  release_group_type TEXT NOT NULL, secondary_types_json TEXT, first_release_date TEXT,
  disambiguation TEXT
);
CREATE TABLE IF NOT EXISTS catalog_music_releases (
  release_id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_group_item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT, country_code TEXT, release_date TEXT, barcode TEXT,
  packaging TEXT, disambiguation TEXT, cover_asset_id INTEGER, UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_music_media (
  medium_id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL REFERENCES catalog_music_releases(release_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, format TEXT, title TEXT, track_count INTEGER,
  UNIQUE(release_id,position)
);
CREATE TABLE IF NOT EXISTS catalog_music_recordings (
  recording_id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT NOT NULL, duration_ms INTEGER, disambiguation TEXT, video INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_music_tracks (
  track_id INTEGER PRIMARY KEY AUTOINCREMENT, medium_id INTEGER NOT NULL REFERENCES catalog_music_media(medium_id) ON DELETE CASCADE,
  recording_id INTEGER REFERENCES catalog_music_recordings(recording_id), position INTEGER NOT NULL,
  number_text TEXT, title TEXT NOT NULL, duration_ms INTEGER, artist_credit_text TEXT,
  UNIQUE(medium_id,position)
);
CREATE TABLE IF NOT EXISTS catalog_music_works (
  work_id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id TEXT NOT NULL,
  title TEXT NOT NULL, work_type TEXT, language_code TEXT, iswc TEXT, UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_music_recording_works (
  recording_id INTEGER NOT NULL REFERENCES catalog_music_recordings(recording_id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES catalog_music_works(work_id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'performance', PRIMARY KEY(recording_id,work_id,relation_type)
);
CREATE TABLE IF NOT EXISTS catalog_music_credits (
  music_credit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER REFERENCES catalog_music_artists(artist_id), person_id INTEGER REFERENCES catalog_people(person_id),
  release_group_item_id INTEGER REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  release_id INTEGER REFERENCES catalog_music_releases(release_id) ON DELETE CASCADE,
  recording_id INTEGER REFERENCES catalog_music_recordings(recording_id) ON DELETE CASCADE,
  work_id INTEGER REFERENCES catalog_music_works(work_id) ON DELETE CASCADE,
  role TEXT NOT NULL, credited_as TEXT, instrument TEXT, billing_order INTEGER NOT NULL DEFAULT 0,
  CHECK(artist_id IS NOT NULL OR person_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS catalog_music_labels (
  label_id INTEGER PRIMARY KEY AUTOINCREMENT, organisation_id INTEGER REFERENCES catalog_organisations(organisation_id),
  source TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL, label_type TEXT,
  country_code TEXT, UNIQUE(source,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_music_release_labels (
  release_id INTEGER NOT NULL REFERENCES catalog_music_releases(release_id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES catalog_music_labels(label_id), catalog_number TEXT,
  PRIMARY KEY(release_id,label_id,catalog_number)
);

CREATE TABLE IF NOT EXISTS catalog_source_payloads (
  source TEXT NOT NULL, entity_type TEXT NOT NULL, source_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, content_hash TEXT, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source,entity_type,source_id)
);
CREATE TABLE IF NOT EXISTS catalog_imdb_snapshots (
  dataset_key TEXT PRIMARY KEY, source_url TEXT NOT NULL, snapshot_date TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, row_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0, media_types_json TEXT, status TEXT NOT NULL DEFAULT 'complete',
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS catalog_imdb_intake_titles (
  imdb_id TEXT PRIMARY KEY
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS catalog_provider_enrichment (
  item_id INTEGER NOT NULL REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  provider TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT, last_success_at TEXT, last_error TEXT, content_hash TEXT,
  PRIMARY KEY(item_id,provider)
);
CREATE TABLE IF NOT EXISTS catalog_ingest_queue (
  queue_id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, entity_type TEXT NOT NULL, source_id TEXT NOT NULL,
  reason TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at TEXT, done_at TEXT, last_error TEXT, UNIQUE(source,entity_type,source_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_ingest_queue_work ON catalog_ingest_queue(status,priority DESC,available_at);

CREATE TABLE IF NOT EXISTS catalog_flow_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_key TEXT NOT NULL REFERENCES catalog_flow_definitions(flow_key) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  UNIQUE(flow_key,version_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_flow_published ON catalog_flow_versions(flow_key) WHERE status='published';
CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_flow_draft ON catalog_flow_versions(flow_key) WHERE status='draft';
CREATE TABLE IF NOT EXISTS catalog_flow_node_runs (
  node_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES catalog_flow_runs(run_id) ON DELETE CASCADE,
  version_id INTEGER REFERENCES catalog_flow_versions(version_id),
  node_key TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT, finished_at TEXT,
  processed INTEGER NOT NULL DEFAULT 0, total INTEGER,
  succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
  message TEXT, error_json TEXT,
  UNIQUE(run_id,node_key)
);
CREATE INDEX IF NOT EXISTS idx_catalog_node_runs_run ON catalog_flow_node_runs(run_id,node_run_id);
CREATE TABLE IF NOT EXISTS catalog_mapping_rules (
  rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL, source TEXT NOT NULL, source_value TEXT NOT NULL,
  target_type TEXT NOT NULL, target_value TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(rule_type,source,source_value,target_type,target_value)
);
CREATE TABLE IF NOT EXISTS catalog_mapping_issues (
  issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_key TEXT, issue_type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warning',
  source TEXT, source_id TEXT, title TEXT NOT NULL, description TEXT,
  context_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open',
  resolution_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_mapping_issues_status ON catalog_mapping_issues(status,severity,created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS catalog_items_fts USING fts5(canonical_title,original_title,description);

INSERT OR IGNORE INTO catalog_flow_definitions(flow_key,name,description,schedule,sort_order) VALUES
  ('imdb-seed','IMDb dataset import','Streams filtered IMDb datasets to create canonical film and television records, people and credits.','Daily/initial import',10),
  ('enrich-items','Provider enrichment','Uses IMDb IDs to enrich accepted records from OMDb, TVDB and TMDB.','After IMDb import/manual',20),
  ('changed-series','Changed TV queue','Queues series reported by the TMDB TV change list.','Part of daily sync',35),
  ('hydrate-series','TV metadata hydration','Fetches queued series, seasons and episodes into canonical tables.','Continuous/manual',45),
  ('resolve-identities','Global identity resolution','Scores duplicate people and organisation candidates without unsafe name-only merges.','Daily/manual',55);
`

export function migrateLegacyCatalogue(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(UNIVERSAL_CATALOGUE_SCHEMA)
    for (const [table, columns] of [
      ['catalog_films_fts', 'title,original_title,alternative_titles'],
      ['catalog_people_fts', 'name,original_name'],
      ['catalog_companies_fts', 'name'],
      ['catalog_items_fts', 'canonical_title,original_title,description'],
    ] as const) {
      const definition = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as { sql?: string } | undefined
      if (definition?.sql?.replace(/\s/g, '').includes("content=''")) db.exec(`DROP TABLE ${table}; CREATE VIRTUAL TABLE ${table} USING fts5(${columns});`)
    }
    db.prepare(`UPDATE catalog_flow_definitions SET enabled=0 WHERE flow_key IN ('daily-id-import','changed-movies','hydrate-movies','changed-series','hydrate-series')`).run()
    db.prepare(`UPDATE catalog_flow_definitions SET name='IMDb-led daily sync',description='Imports filtered IMDb snapshots, enriches accepted IDs through OMDb, TVDB and TMDB, downloads artwork and verifies the catalogue.',sort_order=5 WHERE flow_key='daily-sync'`).run()
    db.prepare(`UPDATE catalog_flow_definitions SET sort_order=30 WHERE flow_key='fetch-artwork'`).run()
    db.prepare(`UPDATE catalog_flow_definitions SET sort_order=40 WHERE flow_key='resolve-identities'`).run()
    db.prepare(`UPDATE catalog_flow_definitions SET sort_order=50 WHERE flow_key='integrity-check'`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_items(media_type,source,source_id,canonical_title,original_title,sort_title,description,original_language,first_release_date,release_year,status,adult,popularity,rating,rating_count,completeness_status,completeness_score,source_created_at,source_updated_at,ingested_at,deleted_at)
      SELECT 'film','tmdb',CAST(legacy_tmdb_id AS TEXT),title,original_title,sort_title,overview,original_language,primary_release_date,release_year,release_status,adult,popularity,vote_average,vote_count,
        CASE WHEN deleted_at IS NOT NULL THEN 'failed' WHEN overview IS NOT NULL AND default_poster_asset_id IS NOT NULL THEN 'complete' ELSE 'partial' END,
        CASE WHEN overview IS NOT NULL AND default_poster_asset_id IS NOT NULL THEN 1 ELSE 0.65 END,
        source_created_at,metadata_updated_at,ingested_at,deleted_at
      FROM catalog_films f WHERE legacy_tmdb_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM catalog_film_details d WHERE d.legacy_film_id=f.film_id)`).run()
    const legacyFilmCount = Number((db.prepare(`SELECT count(*) count FROM catalog_films WHERE legacy_tmdb_id IS NOT NULL`).get() as { count: number }).count)
    const migratedFilmCount = Number((db.prepare(`SELECT count(*) count FROM catalog_films f WHERE f.legacy_tmdb_id IS NOT NULL AND (EXISTS(SELECT 1 FROM catalog_film_details d WHERE d.legacy_film_id=f.film_id) OR EXISTS(SELECT 1 FROM catalog_items i WHERE i.media_type='film' AND i.source='tmdb' AND i.source_id=CAST(f.legacy_tmdb_id AS TEXT)))`).get() as { count: number }).count)
    if (migratedFilmCount < legacyFilmCount) throw new Error(`Catalogue migration refused to continue: ${migratedFilmCount}/${legacyFilmCount} legacy films mapped`)
    db.prepare(`INSERT OR IGNORE INTO catalog_film_details(item_id,legacy_film_id,runtime_minutes,tagline,budget,revenue,homepage,video)
      SELECT i.item_id,f.film_id,f.runtime_minutes,f.tagline,f.budget,f.revenue,f.homepage,f.video
      FROM catalog_films f JOIN catalog_items i ON i.source='tmdb' AND i.media_type='film' AND i.source_id=CAST(f.legacy_tmdb_id AS TEXT)`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_item_external_ids(item_id,source,external_id,is_primary,verified_at)
      SELECT item_id,'tmdb',source_id,1,CURRENT_TIMESTAMP FROM catalog_items WHERE source='tmdb'`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_item_external_ids(item_id,source,external_id,is_primary,verified_at)
      SELECT i.item_id,e.id_type,e.external_id,e.is_primary,e.verified_at FROM catalog_external_ids e
      JOIN catalog_film_details d ON d.legacy_film_id=e.film_id JOIN catalog_items i ON i.item_id=d.item_id`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_person_external_ids(person_id,source,external_id,is_primary,verified_at)
      SELECT person_id,'tmdb',CAST(legacy_tmdb_id AS TEXT),1,CURRENT_TIMESTAMP FROM catalog_people WHERE legacy_tmdb_id IS NOT NULL`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_person_external_ids(person_id,source,external_id,is_primary,verified_at)
      SELECT person_id,'imdb',imdb_id,0,CURRENT_TIMESTAMP FROM catalog_people WHERE imdb_id IS NOT NULL AND imdb_id<>''`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_person_aliases(person_id,name,normalized_name,source,is_primary)
      SELECT person_id,name,normalized_name,'tmdb',1 FROM catalog_people`).run()
    db.prepare(`INSERT INTO catalog_organisations(name,normalized_name,organisation_type,country_code)
      SELECT c.name,c.normalized_name,'production_company',c.origin_country FROM catalog_companies c
      WHERE (c.legacy_tmdb_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM catalog_organisation_external_ids e WHERE e.source='tmdb' AND e.external_id=CAST(c.legacy_tmdb_id AS TEXT)))
         OR (c.legacy_tmdb_id IS NULL AND NOT EXISTS(SELECT 1 FROM catalog_organisations o WHERE o.normalized_name=c.normalized_name AND o.organisation_type='production_company'))`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_organisation_external_ids(organisation_id,source,external_id,is_primary,verified_at)
      SELECT o.organisation_id,'tmdb',CAST(c.legacy_tmdb_id AS TEXT),1,CURRENT_TIMESTAMP FROM catalog_companies c
      JOIN catalog_organisations o ON o.normalized_name=c.normalized_name AND o.organisation_type='production_company'
      WHERE c.legacy_tmdb_id IS NOT NULL`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_item_genres(item_id,genre_id,billing_order)
      SELECT d.item_id,g.genre_id,g.billing_order FROM catalog_film_genres g JOIN catalog_film_details d ON d.legacy_film_id=g.film_id`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_item_titles(item_id,title,normalized_title,title_type,country_code,source,billing_order)
      SELECT d.item_id,t.title,lower(trim(t.title)),'alternative',t.country_code,'tmdb',t.billing_order
      FROM catalog_alternative_titles t JOIN catalog_film_details d ON d.legacy_film_id=t.film_id`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_item_organisations(item_id,organisation_id,role,billing_order,is_primary)
      SELECT d.item_id,e.organisation_id,c.company_role,c.billing_order,c.is_primary_studio
      FROM catalog_film_companies c JOIN catalog_film_details d ON d.legacy_film_id=c.film_id
      JOIN catalog_companies legacy ON legacy.company_id=c.company_id
      JOIN catalog_organisation_external_ids e ON e.source='tmdb' AND e.external_id=CAST(legacy.legacy_tmdb_id AS TEXT)`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_credits(item_id,person_id,credit_type,role,raw_role,character_name,department,billing_order,source,source_credit_id,is_primary)
      SELECT d.item_id,c.person_id,'cast','actor','actor',c.character_name,c.department,c.billing_order,'tmdb',c.credit_id,CASE WHEN c.billing_order<5 THEN 1 ELSE 0 END
      FROM catalog_film_cast c JOIN catalog_film_details d ON d.legacy_film_id=c.film_id`).run()
    db.prepare(`INSERT OR IGNORE INTO catalog_credits(item_id,person_id,credit_type,role,raw_role,department,billing_order,source,source_credit_id,is_primary)
      SELECT d.item_id,c.person_id,'crew',c.normalized_role,c.job,c.department,c.billing_order,'tmdb',c.credit_id,CASE WHEN c.normalized_role='director' THEN 1 ELSE 0 END
      FROM catalog_film_crew c JOIN catalog_film_details d ON d.legacy_film_id=c.film_id`).run()
    db.prepare(`UPDATE catalog_artwork_assets SET owner_id=(SELECT d.item_id FROM catalog_film_details d WHERE d.legacy_film_id=catalog_artwork_assets.owner_id),owner_type='item'
      WHERE owner_type='film' AND EXISTS(SELECT 1 FROM catalog_film_details d WHERE d.legacy_film_id=catalog_artwork_assets.owner_id)`).run()
    db.prepare(`UPDATE catalog_items SET
      default_poster_asset_id=(SELECT asset_id FROM catalog_artwork_assets a WHERE a.owner_type='item' AND a.owner_id=catalog_items.item_id AND a.artwork_type='poster' ORDER BY a.is_selected DESC,a.billing_order LIMIT 1),
      default_backdrop_asset_id=(SELECT asset_id FROM catalog_artwork_assets a WHERE a.owner_type='item' AND a.owner_id=catalog_items.item_id AND a.artwork_type='backdrop' ORDER BY a.is_selected DESC,a.billing_order LIMIT 1)
      WHERE media_type='film'`).run()
    db.prepare(`UPDATE catalog_items SET
      completeness_status=CASE WHEN description IS NOT NULL AND trim(description)<>'' AND EXISTS(SELECT 1 FROM catalog_artwork_assets a WHERE a.owner_type='item' AND a.owner_id=catalog_items.item_id AND a.artwork_type='poster' AND a.local_path IS NOT NULL AND a.deleted_at IS NULL) THEN 'complete' ELSE 'partial' END,
      completeness_score=CASE WHEN description IS NOT NULL AND trim(description)<>'' AND EXISTS(SELECT 1 FROM catalog_artwork_assets a WHERE a.owner_type='item' AND a.owner_id=catalog_items.item_id AND a.artwork_type='poster' AND a.local_path IS NOT NULL AND a.deleted_at IS NULL) THEN 1 WHEN description IS NOT NULL AND trim(description)<>'' THEN 0.75 ELSE 0.5 END
      WHERE deleted_at IS NULL`).run()
    const legacyMetadata = db.prepare(`SELECT 1 FROM catalog_metadata WHERE dataset_id='archivist-films'`).get()
    const universalMetadata = db.prepare(`SELECT 1 FROM catalog_metadata WHERE dataset_id='archivist-catalogue'`).get()
    if (legacyMetadata && universalMetadata) db.prepare(`DELETE FROM catalog_metadata WHERE dataset_id='archivist-films'`).run()
    else if (legacyMetadata) db.prepare(`UPDATE catalog_metadata SET schema_version=3,dataset_id='archivist-catalogue',source_name='imdb-led-multi-source' WHERE dataset_id='archivist-films'`).run()
    db.prepare(`UPDATE catalog_metadata SET schema_version=3,source_name='imdb-led-multi-source' WHERE dataset_id='archivist-catalogue'`).run()
  })
  migrate()
}
