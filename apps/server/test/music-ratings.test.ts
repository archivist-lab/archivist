import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySchema } from '@archivist/db'
import { clearRating, resolveArtistRatingTree, resolveRating, resolveRatingsBulk, setRating } from '../src/services/ratings.js'

// Music mirrors the series hierarchy: artist ⇢ album ⇢ track, resolved by
// specificity, with the nearest explicit rating winning.

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const libraryId = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Music', 'music', 'ratings-music')").run().lastInsertRowid)
  const artistId = Number(db.prepare("INSERT INTO artists (library_id, name) VALUES (?, 'The Strokes')").run(libraryId).lastInsertRowid)
  const album1 = Number(db.prepare("INSERT INTO albums (artist_id, title, year, album_type) VALUES (?, 'Is This It', 2001, 'Album')").run(artistId).lastInsertRowid)
  const album2 = Number(db.prepare("INSERT INTO albums (artist_id, title, year, album_type) VALUES (?, 'Room on Fire', 2003, 'Album')").run(artistId).lastInsertRowid)
  const track1 = Number(db.prepare("INSERT INTO tracks (album_id, artist_id, title, track_number, disc_number) VALUES (?, ?, 'Last Nite', 7, 1)").run(album1, artistId).lastInsertRowid)
  const track2 = Number(db.prepare("INSERT INTO tracks (album_id, artist_id, title, track_number, disc_number) VALUES (?, ?, 'Reptilia', 2, 1)").run(album2, artistId).lastInsertRowid)
  return { db, artistId, album1, album2, track1, track2 }
}

test('a track inherits its album rating, and an album its artist rating', () => {
  const f = fixture()
  assert.deepEqual(setRating('default', 'artist', f.artistId, 4, f.db), { value: 4, source: 'own', inheritedFrom: null, scaleMax: 5 })
  assert.deepEqual(resolveRating('default', 'album', f.album1, f.db), { value: 4, source: 'inherited', inheritedFrom: { type: 'artist', id: f.artistId }, scaleMax: 5 })
  assert.deepEqual(resolveRating('default', 'track', f.track1, f.db), { value: 4, source: 'inherited', inheritedFrom: { type: 'artist', id: f.artistId }, scaleMax: 5 })

  // The album is nearer than the artist, so it wins for its own tracks only.
  setRating('default', 'album', f.album2, 2, f.db)
  assert.deepEqual(resolveRating('default', 'track', f.track2, f.db), { value: 2, source: 'inherited', inheritedFrom: { type: 'album', id: f.album2 }, scaleMax: 5 })
  assert.equal(resolveRating('default', 'track', f.track1, f.db).value, 4, 'the other album still inherits the artist')

  // A track's own rating beats both, and clearing falls back one rung at a time.
  setRating('default', 'track', f.track2, 5, f.db)
  assert.equal(resolveRating('default', 'track', f.track2, f.db).value, 5)
  assert.equal(clearRating('default', 'track', f.track2, f.db).value, 2)
  assert.equal(clearRating('default', 'album', f.album2, f.db).value, 4)
  f.db.close()
})

test('music ratings stay sparse', () => {
  const f = fixture()
  setRating('default', 'artist', f.artistId, 3, f.db)
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM media_ratings').get() as any).n, 1)
  f.db.close()
})

test('bulk resolution handles music and video subjects in one pass', () => {
  const f = fixture()
  setRating('default', 'artist', f.artistId, 4, f.db)
  setRating('default', 'track', f.track1, 1, f.db)
  const resolved = resolveRatingsBulk('default', [
    { type: 'track', id: f.track1 }, { type: 'album', id: f.album2 }, { type: 'artist', id: f.artistId },
  ], f.db)
  assert.deepEqual(resolved.map(rating => [rating.value, rating.source]), [[1, 'own'], [4, 'inherited'], [4, 'own']])
  f.db.close()
})

test('the artist tree carries every album and its tracks', () => {
  const f = fixture()
  setRating('default', 'album', f.album1, 5, f.db)
  const tree = resolveArtistRatingTree('default', f.artistId, f.db)
  assert.equal(tree.artist.title, 'The Strokes')
  assert.equal(tree.albums.length, 2)
  // Ordered by year: Is This It (2001) then Room on Fire (2003).
  assert.equal(tree.albums[0].album.title, 'Is This It')
  assert.equal(tree.albums[0].album.rating.value, 5)
  assert.equal(tree.albums[0].tracks[0].title, 'Last Nite')
  assert.equal(tree.albums[0].tracks[0].rating.source, 'inherited')
  assert.equal(tree.albums[1].tracks[0].rating.source, 'none')
  f.db.close()
})

test('an unknown artist is a 404, not an empty tree', () => {
  const f = fixture()
  assert.throws(() => resolveArtistRatingTree('default', 9999, f.db), (error: any) => error.status === 404)
  f.db.close()
})
