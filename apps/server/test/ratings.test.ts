import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySchema } from '@archivist/db'
import { clearRating, dismissUnrated, listUnratedQueue, resolveRating, resolveRatingsBulk, resolveSeriesRatingTree, setRating } from '../src/services/ratings.js'

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const libraryId = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('TV', 'series', 'ratings-tv')").run().lastInsertRowid)
  const filmLibraryId = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films', 'films', 'ratings-films')").run().lastInsertRowid)
  const filmId = Number(db.prepare("INSERT INTO films (library_id, title) VALUES (?, 'The Archive')").run(filmLibraryId).lastInsertRowid)
  const seriesId = Number(db.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Specificity')").run(libraryId).lastInsertRowid)
  const season1 = Number(db.prepare("INSERT INTO seasons (series_id, season_number, title) VALUES (?, 1, 'Season 1')").run(seriesId).lastInsertRowid)
  const season2 = Number(db.prepare("INSERT INTO seasons (series_id, season_number, title) VALUES (?, 2, 'Season 2')").run(seriesId).lastInsertRowid)
  const episode1 = Number(db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number, title) VALUES (?, ?, 1, 1, 'Pilot')").run(seriesId, season1).lastInsertRowid)
  const episode2 = Number(db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number, title) VALUES (?, ?, 2, 1, 'Override')").run(seriesId, season2).lastInsertRowid)
  return { db, filmId, seriesId, season1, season2, episode1, episode2 }
}

test('ratings stay sparse while specificity resolves series, season and episode inheritance', () => {
  const f = fixture()
  assert.deepEqual(setRating('default', 'series', f.seriesId, 4, f.db), { value: 4, source: 'own', inheritedFrom: null, scaleMax: 5 })
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM media_ratings').get() as any).n, 1)
  assert.deepEqual(resolveRating('default', 'episode', f.episode1, f.db), { value: 4, source: 'inherited', inheritedFrom: { type: 'series', id: f.seriesId }, scaleMax: 5 })
  setRating('default', 'season', f.season2, 2, f.db)
  assert.deepEqual(resolveRating('default', 'episode', f.episode2, f.db), { value: 2, source: 'inherited', inheritedFrom: { type: 'season', id: f.season2 }, scaleMax: 5 })
  setRating('default', 'episode', f.episode2, 5, f.db)
  assert.equal(resolveRating('default', 'episode', f.episode2, f.db).value, 5)
  assert.equal(clearRating('default', 'episode', f.episode2, f.db).value, 2)
  assert.equal(clearRating('default', 'season', f.season2, f.db).value, 4)
  setRating('default', 'series', f.seriesId, 3, f.db)
  assert.equal(resolveRating('default', 'episode', f.episode1, f.db).value, 3)
  f.db.close()
})

test('bulk resolution preserves input order and resolves a whole tree without per-row reads', () => {
  const f = fixture()
  setRating('default', 'series', f.seriesId, 4, f.db)
  setRating('default', 'episode', f.episode2, 1, f.db)
  const resolved = resolveRatingsBulk('default', [
    { type: 'episode', id: f.episode2 }, { type: 'season', id: f.season1 }, { type: 'film', id: f.filmId },
  ], f.db)
  assert.deepEqual(resolved.map(rating => [rating.value, rating.source]), [[1, 'own'], [4, 'inherited'], [null, 'none']])
  const tree = resolveSeriesRatingTree('default', f.seriesId, f.db)
  assert.equal(tree.seasons.length, 2)
  assert.equal(tree.seasons[1].episodes[0].rating.source, 'own')
  f.db.close()
})

test('unrated queue includes inherited episodes, collapses them by series and honours dismissal', () => {
  const f = fixture()
  setRating('default', 'series', f.seriesId, 4, f.db)
  f.db.prepare("INSERT INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed) VALUES ('default', 'episode', ?, 90, 100, 0)").run(f.episode1)
  f.db.prepare("INSERT INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed) VALUES ('default', 'episode', ?, 100, 100, 1)").run(f.episode2)
  const queue = listUnratedQueue('default', 30, 20, f.db)
  assert.equal(queue.length, 1)
  assert.equal(queue[0].subject.type, 'series')
  assert.equal(queue[0].childCount, 2)
  assert.ok(queue[0].children?.every(child => child.rating.source === 'inherited'))
  dismissUnrated('default', 'episode', f.episode1, f.db)
  assert.equal(listUnratedQueue('default', 30, 20, f.db)[0].childCount, 1)
  f.db.close()
})
