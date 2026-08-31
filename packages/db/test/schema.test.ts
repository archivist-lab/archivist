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
    'libraries',
    'app_settings',
    'root_folders',
    'quality_profiles',
    'quality_definitions',
    'custom_formats',
    'custom_format_specifications',
    'download_clients',
    'indexers_ts',
    'system_jobs',
    'item_searches',
    'system_events',
    'runtime_processes',
    'runtime_leases',
    'torrent_runtime_state',
    'torrent_runtime_commands',
    'video_optimisation_jobs',
    'auth_users',
    'auth_sessions',
    'auth_devices',
    'acquisition_decisions',
    'release_blocklist',
    'music_swarm_observations',
    'lists',
    'list_items',
    'list_refresh_runs',
    'list_query_cache',
    'collections',
    'collection_items',
    'media_segments',
    'media_segment_fingerprints',
    'media_segment_links',
    'player_bookmarks',
    'player_media_probes',
    'player_sync_changes',
    'media_ratings',
    'media_rating_dismissals',
    'leaving_soon_rules',
    'recommendation_source_candidates',
    'recommendation_snapshots',
    'recommendation_feedback',
    'recommendation_exposures',
    'engagement_events',
    'films',
    'film_editions',
    'edition_rules',
    'series',
    'seasons',
    'episodes',
    'episode_files',
    'new_release_search_state',
    'artists',
    'albums',
    'music_album_releases',
    'tracks',
    'authors',
    'books',
    'book_editions',
    'comic_series',
    'comic_issues',
    'games',
  ]) {
    assert.ok(tables.includes(required), `missing table ${required}`)
  }
  for (const table of ['films', 'series']) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
    for (const column of ['minimum_tier', 'minimum_resolution', 'minimum_source', 'minimum_codec']) {
      assert.ok(columns.includes(column), `${table} missing ${column}`)
    }
  }
  const progressColumns = (db.prepare('PRAGMA table_info(playback_progress)').all() as Array<{ name: string }>).map(column => column.name)
  assert.ok(progressColumns.includes('edition_id'), 'playback_progress missing edition_id')
  const jobColumns = (db.prepare('PRAGMA table_info(system_jobs)').all() as Array<{ name: string }>).map(column => column.name)
  assert.ok(jobColumns.includes('lease_owner'), 'system_jobs missing lease owner')
  const itemSearchColumns = (db.prepare('PRAGMA table_info(item_searches)').all() as Array<{ name: string }>).map(column => column.name)
  for (const column of ['job_id', 'subject_type', 'mode', 'results', 'expires_at']) {
    assert.ok(itemSearchColumns.includes(column), `item_searches missing ${column}`)
  }
  const videoColumns = (db.prepare('PRAGMA table_info(video_optimisation_jobs)').all() as Array<{ name: string }>).map(column => column.name)
  assert.ok(videoColumns.includes('control_requested'), 'video queue missing cross-process control column')
  const albumColumns = (db.prepare('PRAGMA table_info(albums)').all() as Array<{ name: string }>).map(column => column.name)
  for (const column of ['musicbrainz_release_id', 'discography_info_hash']) {
    assert.ok(albumColumns.includes(column), `albums missing ${column}`)
  }
  const albumIndexes = db.prepare('PRAGMA index_list(albums)').all() as Array<{ name: string }>
  assert.ok(albumIndexes.some(index => index.name === 'idx_albums_discography_info_hash'))
  const swarmIndexes = db.prepare('PRAGMA index_list(music_swarm_observations)').all() as Array<{ name: string }>
  assert.ok(swarmIndexes.some(index => index.name === 'idx_music_swarm_subject'))
  assert.ok(swarmIndexes.some(index => index.name === 'idx_music_swarm_indexer'))
})

test('segment links follow episode lifecycle without deleting shared signatures', () => {
  const db = openUnifiedDb(dbPath)
  const libraryId = db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('TV', 'series', 'tv-lib')").run().lastInsertRowid
  const seriesId = db.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Detector Fixture')").run(libraryId).lastInsertRowid
  const seasonId = db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, 1)').run(seriesId).lastInsertRowid
  const episodeId = db
    .prepare('INSERT INTO episodes (series_id, season_id, season_number, episode_number) VALUES (?, ?, 1, 1)')
    .run(seriesId, seasonId).lastInsertRowid
  db.prepare("INSERT INTO media_segments (media_signature, file_size, detector_version) VALUES ('sig', 100, 'test')").run()
  db.prepare("INSERT INTO media_segment_links (episode_id, media_signature, file_path, file_size) VALUES (?, 'sig', '/fixture.mkv', 100)").run(episodeId)

  db.prepare('DELETE FROM episodes WHERE id = ?').run(episodeId)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_segment_links WHERE media_signature = 'sig'").get() as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM media_segments WHERE media_signature = 'sig'").get() as { n: number }).n, 1)
})

test('Archivist collections span media libraries and cascade membership safely', () => {
  const db = openUnifiedDb(dbPath)
  const filmLibraryId = db
    .prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Collection Films', 'films', 'collection-films')")
    .run().lastInsertRowid
  const bookLibraryId = db
    .prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Collection Books', 'books', 'collection-books')")
    .run().lastInsertRowid
  const filmId = db.prepare("INSERT INTO films (library_id, title) VALUES (?, 'Collection Film')").run(filmLibraryId).lastInsertRowid
  const authorId = db.prepare("INSERT INTO authors (library_id, name) VALUES (?, 'Collection Author')").run(bookLibraryId).lastInsertRowid
  const bookId = db.prepare("INSERT INTO books (author_id, title) VALUES (?, 'Collection Book')").run(authorId).lastInsertRowid
  const collectionId = db
    .prepare("INSERT INTO collections (name, description) VALUES ('Cross-media fixture', 'Editorial, not provider-owned')")
    .run().lastInsertRowid
  db.prepare("INSERT INTO collection_items (collection_id, entity_type, library_id, item_id, position) VALUES (?, 'film', ?, ?, 0)").run(
    collectionId,
    filmLibraryId,
    filmId,
  )
  db.prepare("INSERT INTO collection_items (collection_id, entity_type, library_id, item_id, position) VALUES (?, 'book', ?, ?, 1)").run(
    collectionId,
    bookLibraryId,
    bookId,
  )
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id=?').get(collectionId) as { n: number }).n, 2)
  db.prepare('DELETE FROM books WHERE id=?').run(bookId)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM collection_items WHERE collection_id=? AND entity_type='book'").get(collectionId) as { n: number }).n, 0)
  db.prepare('DELETE FROM collections WHERE id=?').run(collectionId)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id=?').get(collectionId) as { n: number }).n, 0)
  assert.ok(db.prepare('SELECT id FROM films WHERE id=?').get(filmId), 'deleting a collection must not delete a library item')
})

test('migration is idempotent', () => {
  openUnifiedDb(dbPath)
  openUnifiedDb(dbPath)
  const db = openUnifiedDb(dbPath)
  const versions = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
  assert.ok(versions.n >= 1)
})

test('Music ownership migration backfills track coverage and retires only unowned stale state', () => {
  const path = join(dir, 'music-ownership-migration.sqlite')
  const seeded = openUnifiedDb(path)
  const libraryId = seeded
    .prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Migration Music', 'music', 'migration-music')")
    .run().lastInsertRowid
  const orphanArtistId = seeded.prepare("INSERT INTO artists (library_id, name) VALUES (?, 'Orphan Artist')").run(libraryId).lastInsertRowid
  const activeArtistId = seeded
    .prepare(`INSERT INTO artists (library_id, name, discography_status, discography_info_hash)
    VALUES (?, 'Active Artist', 'acquiring', ?)`)
    .run(libraryId, 'a'.repeat(40)).lastInsertRowid
  const orphanAlbumId = seeded
    .prepare(`INSERT INTO albums (artist_id, title, status, track_count, updated_at)
    VALUES (?, 'Orphan Album', 'acquiring', 0, datetime('now', '-2 hours'))`)
    .run(orphanArtistId).lastInsertRowid
  const activeAlbumId = seeded
    .prepare(`INSERT INTO albums (artist_id, title, status, track_count, updated_at)
    VALUES (?, 'Active Album', 'acquiring', 0, datetime('now', '-2 hours'))`)
    .run(activeArtistId).lastInsertRowid
  seeded.prepare("INSERT INTO tracks (album_id, artist_id, title, status) VALUES (?, ?, 'Track One', 'acquiring')").run(orphanAlbumId, orphanArtistId)
  seeded.prepare("INSERT INTO tracks (album_id, artist_id, title, status) VALUES (?, ?, 'Track Two', 'acquiring')").run(orphanAlbumId, orphanArtistId)
  seeded.prepare("INSERT INTO tracks (album_id, artist_id, title, status) VALUES (?, ?, 'Active Track', 'acquiring')").run(activeAlbumId, activeArtistId)
  seeded.prepare('DELETE FROM _migrations WHERE version = 44').run()
  closeAllDatabases()

  const migrated = openUnifiedDb(path)
  assert.deepEqual(migrated.prepare('SELECT status, track_count FROM albums WHERE id = ?').get(orphanAlbumId), {
    status: 'missing',
    track_count: 2,
  })
  assert.equal((migrated.prepare('SELECT status FROM tracks WHERE album_id = ? LIMIT 1').get(orphanAlbumId) as any).status, 'missing')
  assert.deepEqual(migrated.prepare('SELECT status, track_count FROM albums WHERE id = ?').get(activeAlbumId), {
    status: 'acquiring',
    track_count: 1,
  })
})

test('queue claims and cursor pagination have expression-aligned indexes', () => {
  const db = openUnifiedDb(dbPath)
  const indexes = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN (
    'idx_system_jobs_lane_order','idx_films_library_sort_cursor','idx_series_library_sort_cursor'
  ) ORDER BY name`)
    .all() as Array<{ name: string; sql: string }>
  assert.equal(indexes.length, 3)
  for (const name of ['idx_films_library_sort_cursor', 'idx_series_library_sort_cursor']) {
    const sql = indexes.find(index => index.name === name)?.sql ?? ''
    assert.match(sql, /COALESCE\(sort_title, ''\) COLLATE NOCASE/i, `${name} must match the cursor query expression`)
  }
})

test('native player change cursor advances for media mutations', () => {
  const db = openUnifiedDb(dbPath)
  const libraryId = db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Cursor Films', 'films', 'cursor-films')").run().lastInsertRowid
  const filmId = db.prepare("INSERT INTO films (library_id, title) VALUES (?, 'Cursor Fixture')").run(libraryId).lastInsertRowid
  const afterInsert = (db.prepare('SELECT MAX(id) AS cursor FROM player_sync_changes').get() as { cursor: number }).cursor
  db.prepare("UPDATE films SET title = 'Cursor Fixture Updated' WHERE id = ?").run(filmId)
  const afterUpdate = (db.prepare('SELECT MAX(id) AS cursor FROM player_sync_changes').get() as { cursor: number }).cursor
  db.prepare('UPDATE films SET download_progress = 50 WHERE id = ?').run(filmId)
  const afterProgress = (db.prepare('SELECT MAX(id) AS cursor FROM player_sync_changes').get() as { cursor: number }).cursor
  db.prepare('DELETE FROM films WHERE id = ?').run(filmId)
  const afterDelete = (db.prepare('SELECT MAX(id) AS cursor FROM player_sync_changes').get() as { cursor: number }).cursor
  assert.ok(afterInsert > 0)
  assert.ok(afterUpdate > afterInsert)
  assert.equal(afterProgress, afterUpdate, 'download percentage must not trigger a full native-library sync')
  assert.ok(afterDelete > afterUpdate)
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

test('player preference migration supports legacy through availability-download schemas', () => {
  const db = openUnifiedDb(dbPath)
  const columns = db.prepare("PRAGMA table_info('player_preferences')").all() as Array<{ name: string }>
  assert.deepEqual(
    columns.map(column => column.name),
    ['profile_id', 'schema_version', 'revision', 'document', 'updated_at'],
  )
  const indexes = db.prepare("PRAGMA index_list('player_preferences')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_player_preferences_updated'))
  db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('default', 1, 1, ?)").run('{"schemaVersion":1}')
  db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('hubs', 2, 1, ?)").run('{"schemaVersion":2}')
  db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('browse', 3, 1, ?)").run('{"schemaVersion":3}')
  db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('visuals', 4, 1, ?)").run('{"schemaVersion":4}')
  db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('availability', 5, 1, ?)").run('{"schemaVersion":5}')
  assert.throws(
    () => db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('future', 6, 1, '{}')").run(),
    /CHECK/,
  )
  assert.throws(
    () => db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('bad-json', 1, 1, 'nope')").run(),
    /CHECK/,
  )
  assert.throws(
    () => db.prepare("INSERT INTO player_preferences (profile_id, schema_version, revision, document) VALUES ('bad-revision', 1, 0, '{}')").run(),
    /CHECK/,
  )
})

test('episode airtime migration creates timestamp fields and durable search state', () => {
  const db = openUnifiedDb(dbPath)
  const columns = db.prepare("PRAGMA table_info('episodes')").all() as Array<{ name: string }>
  for (const name of ['air_time', 'air_timezone', 'air_at', 'air_time_source']) {
    assert.ok(
      columns.some(column => column.name === name),
      `missing episodes.${name}`,
    )
  }
  const indexes = db.prepare("PRAGMA index_list('episodes')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_episodes_air_at'))
})

test('film metadata migration creates post-release refresh state and index', () => {
  const db = openUnifiedDb(dbPath)
  const columns = db.prepare("PRAGMA table_info('films')").all() as Array<{ name: string }>
  for (const name of ['last_metadata_refresh_at', 'post_release_metadata_refreshed_at']) {
    assert.ok(
      columns.some(column => column.name === name),
      `missing films.${name}`,
    )
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
  assert.ok(columns.some(column => column.name === 'collection_metadata_checked_at'))
  const indexes = migrated.prepare("PRAGMA index_list('films')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_films_post_release_metadata'))
  const marker = migrated
    .prepare(`
    SELECT post_release_metadata_refreshed_at AS refreshedAt FROM films WHERE title = 'Already Released'
  `)
    .get() as { refreshedAt: string | null }
  assert.ok(marker.refreshedAt, 'historical films are marked during migration to prevent a refresh storm')
})

test('pre-correlation database adds acquisition columns before their indexes', () => {
  const legacyPath = join(dir, 'legacy-pre-acquisition-correlation.sqlite')
  const legacy = new Database(legacyPath)
  legacy.exec(`
    CREATE TABLE acquisition_decisions (
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
  `)
  legacy.close()

  const migrated = openUnifiedDb(legacyPath)
  const columns = migrated.prepare("PRAGMA table_info('acquisition_decisions')").all() as Array<{ name: string }>
  for (const name of ['runtime_torrent_id', 'info_hash', 'correlation_status']) {
    assert.ok(
      columns.some(column => column.name === name),
      `missing acquisition_decisions.${name}`,
    )
  }
  const indexes = migrated.prepare("PRAGMA index_list('acquisition_decisions')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_acquisition_decisions_runtime_torrent'))
  assert.ok(indexes.some(index => index.name === 'idx_acquisition_decisions_info_hash'))
})

test('pre-portrait database adds the local image column before indexing it', () => {
  const legacyPath = join(dir, 'legacy-pre-person-portraits.sqlite')
  const legacy = new Database(legacyPath)
  legacy.exec(`
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      tmdb_id INTEGER,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      known_for_department TEXT,
      profile_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  legacy.close()

  const migrated = openUnifiedDb(legacyPath)
  const columns = migrated.prepare("PRAGMA table_info('people')").all() as Array<{ name: string }>
  assert.ok(columns.some(column => column.name === 'profile_image_path'))
  const indexes = migrated.prepare("PRAGMA index_list('people')").all() as Array<{ name: string }>
  assert.ok(indexes.some(index => index.name === 'idx_people_portrait_pending'))
})

test('monitor reconciliation clears episodes stranded under an unmonitored season', () => {
  const driftPath = join(dir, 'monitor-drift.sqlite')
  const seeded = openUnifiedDb(driftPath)
  const libraryId = seeded.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Drift TV', 'series', 'drift-tv')").run().lastInsertRowid
  const seriesId = seeded.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Drift Fixture')").run(libraryId).lastInsertRowid
  const strandedSeason = seeded.prepare('INSERT INTO seasons (series_id, season_number, monitored) VALUES (?, 1, 0)').run(seriesId).lastInsertRowid
  const liveSeason = seeded.prepare('INSERT INTO seasons (series_id, season_number, monitored) VALUES (?, 2, 1)').run(seriesId).lastInsertRowid
  const addEpisode = seeded.prepare('INSERT INTO episodes (series_id, season_id, season_number, episode_number, monitored) VALUES (?, ?, ?, ?, ?)')
  addEpisode.run(seriesId, strandedSeason, 1, 1, 1)
  addEpisode.run(seriesId, strandedSeason, 1, 2, 1)
  addEpisode.run(seriesId, liveSeason, 2, 1, 1)
  addEpisode.run(seriesId, liveSeason, 2, 2, 0)
  // Replay the reconciliation against this already-drifted data.
  seeded.prepare('DELETE FROM _migrations WHERE version = 30').run()
  closeAllDatabases()

  const migrated = openUnifiedDb(driftPath)
  const flags = (season: unknown) =>
    (migrated.prepare('SELECT monitored FROM episodes WHERE season_id = ? ORDER BY episode_number').all(season) as Array<{ monitored: number }>).map(
      row => row.monitored,
    )
  assert.deepEqual(flags(strandedSeason), [0, 0], 'episodes under an unmonitored season are cleared')
  assert.deepEqual(flags(liveSeason), [1, 0], 'a monitored season keeps its own per-episode choices')
})

test('cleanup', () => {
  closeAllDatabases()
  rmSync(dir, { recursive: true, force: true })
})
