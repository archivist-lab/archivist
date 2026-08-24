import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createImportPlan } from '../src/services/media-imports.js'
import { organizeMusic } from '../src/shared/media-organizer.js'

function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE artists (id INTEGER PRIMARY KEY, library_id INTEGER, name TEXT);
    CREATE TABLE albums (
      id INTEGER PRIMARY KEY, artist_id INTEGER, title TEXT, year INTEGER, album_type TEXT,
      status TEXT, download_progress REAL, updated_at TEXT
    );
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY, album_id INTEGER, artist_id INTEGER, title TEXT,
      track_number INTEGER, disc_number INTEGER, monitored INTEGER, status TEXT,
      file_path TEXT, file_size INTEGER, download_progress REAL, updated_at TEXT
    );
    INSERT INTO artists VALUES (1, 1, 'Parity Artist');
    INSERT INTO albums VALUES (7, 1, 'Parity Album', 2026, 'Album', 'acquiring', 1, datetime('now'));
    INSERT INTO tracks VALUES (71, 7, 1, 'First Song', 1, 1, 1, 'acquiring', NULL, NULL, 1, datetime('now'));
    INSERT INTO tracks VALUES (72, 7, 1, 'Second Song', 2, 1, 1, 'acquiring', NULL, NULL, 1, datetime('now'));
  `)
  const root = mkdtempSync(join(tmpdir(), 'archivist-music-partial-'))
  const source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, '01 - First Song.flac'), 'first')
  writeFileSync(join(source, '01 - First Song duplicate.flac'), 'duplicate')
  return { db, root, source }
}

test('Music import plans identify missing and duplicate tracks, and execution remains partial', async () => {
  const { db, root, source } = fixture()
  try {
    const plan = createImportPlan({
      mediaType: 'music-album', itemId: 7, sourcePath: source, torrentId: 'torrent', infoHash: 'hash',
    } as any, db as any)

    assert.equal(plan.status, 'needs-review')
    assert.equal(plan.files.filter(file => file.role === 'track').length, 1)
    assert.equal(plan.ignored.filter(file => file.role === 'duplicate').length, 1)
    assert.ok(plan.warnings.some(warning => warning.includes('1 monitored album track')))
    assert.ok(plan.warnings.some(warning => warning.includes('1 duplicate audio file')))

    const destination = await organizeMusic(7, source, db as any, join(root, 'library'), plan.files.map(file => ({
      path: file.path,
      trackId: file.trackId,
      trackNumber: file.trackNumber,
      discNumber: file.discNumber,
    })))
    const album = db.prepare('SELECT status, download_progress FROM albums WHERE id = 7').get() as any
    const tracks = db.prepare('SELECT id, status, file_path FROM tracks ORDER BY id').all() as any[]

    assert.equal(album.status, 'partial')
    assert.equal(album.download_progress, 0.5)
    assert.equal(tracks[0].status, 'collected')
    assert.ok(existsSync(tracks[0].file_path))
    assert.equal(tracks[1].status, 'missing')
    assert.equal(tracks[1].file_path, null)
    assert.ok(existsSync(join(source, '01 - First Song duplicate.flac')), 'duplicate remains staged for review')
    assert.ok(existsSync(destination))

    writeFileSync(join(source, '02 - Second Song.flac'), 'second')
    const followup = createImportPlan({
      mediaType: 'music-album', itemId: 7, sourcePath: source, torrentId: 'torrent', infoHash: 'hash',
    } as any, db as any)
    assert.equal(followup.files.length, 1, 'a follow-up plan targets only the still-missing track')
    await organizeMusic(7, source, db as any, join(root, 'library'), followup.files.map(file => ({
      path: file.path, trackId: file.trackId, trackNumber: file.trackNumber, discNumber: file.discNumber,
    })))
    const completed = db.prepare('SELECT status, download_progress FROM albums WHERE id = 7').get() as any
    assert.equal(completed.status, 'collected')
    assert.equal(completed.download_progress, 1)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing-library Music adoption links tracks in place without moving them', async () => {
  const { db, root, source } = fixture()
  try {
    const original = join(source, '01 - First Song.flac')
    const plan = createImportPlan({
      mediaType: 'music-album', itemId: 7, sourcePath: source, torrentId: 'scan', infoHash: 'scan', inPlace: true,
    } as any, db as any)
    const destination = await organizeMusic(7, source, db as any, join(root, 'canonical-library'), plan.files.map(file => ({
      path: file.path, trackId: file.trackId, trackNumber: file.trackNumber, discNumber: file.discNumber,
    })), true)

    assert.equal(destination, source)
    assert.equal(existsSync(original), true, 'the existing audio file must remain at its original path')
    assert.equal((db.prepare('SELECT file_path FROM tracks WHERE id = 71').get() as any).file_path, original)
    assert.equal(existsSync(join(root, 'canonical-library')), false, 'in-place adoption must not create a canonical destination')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
