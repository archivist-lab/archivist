import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  markDiscographyAcquiring,
  markDiscographyAlbumAcquiring,
  reconcileDiscographyChildren,
  resetAcquisitionsForHash,
} from '../src/services/acquisition-state.js'

const PACK_HASH = 'a'.repeat(40)
const ALBUM_HASH = 'b'.repeat(40)

function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE artists (
      id INTEGER PRIMARY KEY,
      discography_info_hash TEXT,
      discography_status TEXT,
      discography_progress REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE albums (
      id INTEGER PRIMARY KEY,
      artist_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      info_hash TEXT,
      discography_info_hash TEXT,
      download_progress REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tracks (
      id INTEGER PRIMARY KEY,
      album_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      info_hash TEXT,
      download_progress REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO artists (id) VALUES (1);
    INSERT INTO albums (id, artist_id, status) VALUES
      (10, 1, 'missing'),
      (11, 1, 'missing'),
      (12, 1, 'collected');
    INSERT INTO tracks (id, album_id, status) VALUES
      (100, 10, 'missing'),
      (110, 11, 'missing'),
      (120, 12, 'collected');
  `)
  return db
}

test('discography ownership advances only eligible albums and tracks', () => {
  const db = fixture()
  try {
    assert.equal(markDiscographyAcquiring(db, 1, PACK_HASH), 2)
    const albums = db.prepare('SELECT id, status, info_hash, discography_info_hash FROM albums ORDER BY id').all() as any[]
    assert.deepEqual(albums.map(row => [row.id, row.status, row.info_hash, row.discography_info_hash]), [
      [10, 'acquiring', null, PACK_HASH],
      [11, 'acquiring', null, PACK_HASH],
      [12, 'collected', null, null],
    ])
    const tracks = db.prepare('SELECT id, status, info_hash FROM tracks ORDER BY id').all() as any[]
    assert.deepEqual(tracks.map(row => [row.id, row.status, row.info_hash]), [
      [100, 'acquiring', null],
      [110, 'acquiring', null],
      [120, 'collected', null],
    ])
  } finally {
    db.close()
  }
})

test('orphan reconciliation resets owned children but preserves an album takeover', () => {
  const db = fixture()
  try {
    markDiscographyAcquiring(db, 1, PACK_HASH)
    db.prepare('UPDATE albums SET info_hash = ? WHERE id = 11').run(ALBUM_HASH)
    db.prepare('UPDATE tracks SET info_hash = ? WHERE album_id = 11').run(ALBUM_HASH)

    reconcileDiscographyChildren(db, 1, PACK_HASH)

    assert.deepEqual(db.prepare('SELECT status, discography_info_hash FROM albums WHERE id = 10').get(), {
      status: 'missing',
      discography_info_hash: null,
    })
    assert.deepEqual(db.prepare('SELECT status, info_hash, discography_info_hash FROM albums WHERE id = 11').get(), {
      status: 'acquiring',
      info_hash: ALBUM_HASH,
      discography_info_hash: null,
    })
    assert.equal((db.prepare('SELECT status FROM tracks WHERE id = 100').get() as any).status, 'missing')
    assert.equal((db.prepare('SELECT status FROM tracks WHERE id = 110').get() as any).status, 'acquiring')
  } finally {
    db.close()
  }
})

test('terminal torrent reset clears the parent and its exactly owned children', () => {
  const db = fixture()
  try {
    markDiscographyAlbumAcquiring(db, 1, 10, PACK_HASH, 0.4)
    db.prepare("UPDATE artists SET discography_info_hash = ?, discography_status = 'acquiring' WHERE id = 1").run(PACK_HASH)

    const changed = resetAcquisitionsForHash(PACK_HASH, db)
    assert.ok(changed >= 3)
    assert.deepEqual(db.prepare('SELECT discography_info_hash, discography_status FROM artists WHERE id = 1').get(), {
      discography_info_hash: null,
      discography_status: null,
    })
    assert.deepEqual(db.prepare('SELECT status, discography_info_hash FROM albums WHERE id = 10').get(), {
      status: 'missing',
      discography_info_hash: null,
    })
    assert.equal((db.prepare('SELECT status FROM tracks WHERE id = 100').get() as any).status, 'missing')
  } finally {
    db.close()
  }
})
