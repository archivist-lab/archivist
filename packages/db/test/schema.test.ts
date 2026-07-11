import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    'films', 'film_editions', 'edition_rules',
    'series', 'seasons', 'episodes', 'episode_files',
    'artists', 'albums', 'tracks',
    'authors', 'books', 'book_editions',
    'comic_series', 'comic_issues', 'games',
  ]) {
    assert.ok(tables.includes(required), `missing table ${required}`)
  }
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

test('cleanup', () => {
  closeAllDatabases()
  rmSync(dir, { recursive: true, force: true })
})
