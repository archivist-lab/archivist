import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openUnifiedDb, closeAllDatabases, seedQualityProfiles, seedEditionRules } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'archivist-db-'))
const dbPath = join(dir, 'archivist.sqlite')

test('fresh database migrates cleanly with WAL enabled', () => {
  const db = openUnifiedDb(dbPath)
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)
  for (const required of [
    'libraries', 'app_settings', 'root_folders', 'quality_profiles', 'quality_definitions',
    'custom_formats', 'custom_format_specifications', 'download_clients', 'indexers_ts',
    'system_jobs', 'system_events', 'auth_users', 'auth_sessions', 'acquisition_decisions', 'release_blocklist',
    'media_segments', 'media_segment_fingerprints', 'media_segment_links',
    'films', 'film_editions', 'edition_rules',
    'series', 'seasons', 'episodes', 'episode_files', 'new_release_search_state',
    'artists', 'albums', 'tracks',
    'authors', 'books', 'book_editions',
    'comic_series', 'comic_issues', 'games',
  ]) {
    assert.ok(tables.includes(required), `missing table ${required}`)
  }
})

test('segment links follow episode lifecycle without deleting shared signatures', () => {
  const db = openUnifiedDb(dbPath)
  const libraryId = db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('TV', 'series', 'tv-lib')").run().lastInsertRowid
  const seriesId = db.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Detector Fixture')").run(libraryId).lastInsertRowid
  const seasonId = db.prepare("INSERT INTO seasons (series_id, season_number) VALUES (?, 1)").run(seriesId).lastInsertRowid
  const episodeId = db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number) VALUES (?, ?, 1, 1)").run(seriesId, seasonId).lastInsertRowid
  db.prepare("INSERT INTO media_segments (media_signature, file_size, detector_version) VALUES ('sig', 100, 'test')").run()
  db.prepare("INSERT INTO media_segment_links (episode_id, media_signature, file_path, file_size) VALUES (?, 'sig', '/fixture.mkv', 100)").run(episodeId)

  db.prepare('DELETE FROM episodes WHERE id = ?').run(episodeId)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_segment_links WHERE media_signature = 'sig'").get() as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_segments WHERE media_signature = 'sig'").get() as { n: number }).n, 1)
})

test('migration is idempotent', () => {
  openUnifiedDb(dbPath)
  openUnifiedDb(dbPath)
  const db = openUnifiedDb(dbPath)
  const versions = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
  assert.ok(versions.n >= 1)
})

test('global quality profiles are seeded exactly once', () => {
  const db = openUnifiedDb(dbPath)
  seedQualityProfiles(db, 0)
  const count = (db.prepare('SELECT COUNT(*) AS n FROM quality_profiles WHERE library_id = 0').get() as { n: number }).n
  assert.equal(count, 5)
})

test('library scoping: same tmdb_id can exist in two libraries but not one', () => {
  const db = openUnifiedDb(dbPath)
  const lib1 = db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films', 'films', 'lib-1')").run().lastInsertRowid
  const lib2 = db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Kids', 'films', 'lib-2')").run().lastInsertRowid

  db.prepare('INSERT INTO films (library_id, tmdb_id, title) VALUES (?, 603, ?)').run(lib1, 'The Matrix')
  db.prepare('INSERT INTO films (library_id, tmdb_id, title) VALUES (?, 603, ?)').run(lib2, 'The Matrix')

  assert.throws(() => {
    db.prepare('INSERT INTO films (library_id, tmdb_id, title) VALUES (?, 603, ?)').run(lib1, 'The Matrix')
  }, /UNIQUE/)
})

test('edition rules seed per films library', () => {
  const db = openUnifiedDb(dbPath)
  const lib = (db.prepare("SELECT id FROM libraries WHERE db_path = 'lib-1'").get() as { id: number }).id
  seedEditionRules(db, lib)
  seedEditionRules(db, lib)
  const count = (db.prepare('SELECT COUNT(*) AS n FROM edition_rules WHERE library_id = ?').get(lib) as { n: number }).n
  assert.equal(count, 8)
})

test('player preference migration creates constrained table and index', () => {
  const db = openUnifiedDb(dbPath)
  const columns = db.prepare("PRAGMA table_info('player_preferences')").all() as Array<{ name: string }>
  assert.deepEqual(columns.map(column => column.name), ['profile_id', 'schema_version', 'revision', 'document', 'updated_at'])
  const indexes = db.prepare("PRAGMA index_list('player_preferences')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_player_preferences_updated'))
  db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('default', 1, 1, ?)").run('{"schemaVersion":1}')
  assert.throws(() => db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('bad-json', 1, 1, 'nope')").run(), /CHECK/)
  assert.throws(() => db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('bad-revision', 1, 0, '{}')").run(), /CHECK/)
})

test('episode airtime migration creates timestamp fields and durable search state', () => {
  const db = openUnifiedDb(dbPath)
  const columns = db.prepare("PRAGMA table_info('episodes')").all() as Array<{ name: string }>
  for (const name of ['air_time', 'air_timezone', 'air_at', 'air_time_source']) {
    assert.ok(columns.some(column => column.name === name), `missing episodes.${name}`)
  }
  const indexes = db.prepare("PRAGMA index_list('episodes')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_episodes_air_at'))
})

test('film metadata migration creates post-release refresh state and index', () => {
  const db = openUnifiedDb(dbPath)
  const columns = db.prepare("PRAGMA table_info('films')").all() as Array<{ name: string }>
  for (const name of ['last_metadata_refresh_at', 'post_release_metadata_refreshed_at']) {
    assert.ok(columns.some(column => column.name === name), `missing films.${name}`)
  }
  const indexes = db.prepare("PRAGMA index_list('films')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_films_post_release_metadata'))
})

test('pre-airtime database adds columns before creating the air_at index', () => {
  const legacyPath = join(dir, 'legacy-pre-airtime.sqlite')
  const legacy = new Database(legacyPath)
  legacy.exec(`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'missing',
      air_date TEXT
    );
  `)
  legacy.close()

  const migrated = openUnifiedDb(legacyPath)
  const columns = migrated.prepare("PRAGMA table_info('episodes')").all() as Array<{ name: string }>
  assert.ok(columns.some(column => column.name === 'air_at'))
  const indexes = migrated.prepare("PRAGMA index_list('episodes')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_episodes_air_at'))
})

test('pre-film-refresh database adds metadata columns before creating its index', () => {
  const legacyPath = join(dir, 'legacy-pre-film-refresh.sqlite')
  const legacy = new Database(legacyPath)
  legacy.exec(`
    CREATE TABLE films (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      sort_title TEXT,
      status TEXT NOT NULL DEFAULT 'wanted',
      release_date TEXT,
      digital_release_date TEXT,
      physical_release_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO films (library_id, title, release_date)
    VALUES (1, 'Already Released', '2000-01-01');
  `)
  legacy.close()

  const migrated = openUnifiedDb(legacyPath)
  const columns = migrated.prepare("PRAGMA table_info('films')").all() as Array<{ name: string }>
  assert.ok(columns.some(column => column.name === 'last_metadata_refresh_at'))
  assert.ok(columns.some(column => column.name === 'post_release_metadata_refreshed_at'))
  const indexes = migrated.prepare("PRAGMA index_list('films')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_films_post_release_metadata'))
  const marker = migrated.prepare(`
    SELECT post_release_metadata_refreshed_at AS refreshedAt FROM films WHERE title = 'Already Released'
  `).get() as { refreshedAt: string | null }
  assert.ok(marker.refreshedAt, 'historical films are marked during migration to prevent a refresh storm')
})

test('cleanup', () => {
  closeAllDatabases()
  rmSync(dir, { recursive: true, force: true })
})
