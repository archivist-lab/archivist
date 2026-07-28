import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { getDb } from '../src/db.js'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness
let filmId: number
let seriesId: number
let seasonId: number
let episodeId: number

test('rating API fixture boots', async () => {
  h = await startTestApp()
  const db = getDb()
  const filmLibrary = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id
  const seriesLibrary = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series' LIMIT 1").get() as any).id
  filmId = Number(db.prepare("INSERT INTO films (library_id, title) VALUES (?, 'Rated Film')").run(filmLibrary).lastInsertRowid)
  seriesId = Number(db.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Rated Series')").run(seriesLibrary).lastInsertRowid)
  seasonId = Number(db.prepare("INSERT INTO seasons (series_id, season_number) VALUES (?, 1)").run(seriesId).lastInsertRowid)
  episodeId = Number(db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number, title) VALUES (?, ?, 1, 1, 'Rated Episode')").run(seriesId, seasonId).lastInsertRowid)
})

after(async () => { await h?.close() })

test('Player rating API validates, resolves inheritance, clears and advances rating sync', async () => {
  const invalid = await h.request('PUT', `/api/v1/player/ratings/series/${seriesId}`, { body: { value: 6, profileId: 'default' } })
  assert.equal(invalid.status, 400)
  const set = await h.request('PUT', `/api/v1/player/ratings/series/${seriesId}`, { body: { value: 4, profileId: 'default' } })
  assert.equal(set.status, 200)
  assert.deepEqual(set.json, { value: 4, source: 'own', inheritedFrom: null, scaleMax: 5 })
  const inherited = await h.request('GET', `/api/v1/player/ratings/episode/${episodeId}?profile=default`)
  assert.equal(inherited.json.source, 'inherited')
  assert.equal(inherited.json.inheritedFrom.type, 'series')
  const ownEpisode = await h.request('PUT', `/api/v1/player/ratings/episode/${episodeId}`, { body: { value: 2, profileId: 'default' } })
  assert.equal(ownEpisode.json.source, 'own')
  const cleared = await h.request('DELETE', `/api/v1/player/ratings/episode/${episodeId}?profile=default`)
  assert.equal(cleared.json.value, 4)
  assert.equal(cleared.json.source, 'inherited')
  assert.ok((getDb().prepare("SELECT COUNT(*) AS n FROM player_sync_changes WHERE scope = 'ratings'").get() as any).n >= 3)
})

test('admin mirror exposes film ratings and the series tree', async () => {
  const film = await h.request('PUT', `/api/v1/ratings/film/${filmId}`, { body: { value: 5, profileId: 'default' } })
  assert.equal(film.status, 200)
  const read = await h.request('GET', `/api/v1/ratings/film/${filmId}?profile=default`)
  assert.equal(read.json.value, 5)
  const tree = await h.request('GET', `/api/v1/ratings/series/${seriesId}/tree?profile=default`)
  assert.equal(tree.status, 200)
  assert.equal(tree.json.seasons[0].episodes[0].rating.value, 4)
})

test('unrated queue includes inherited episode and permanent dismissal removes it', async () => {
  getDb().prepare("INSERT OR REPLACE INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed) VALUES ('default', 'episode', ?, 100, 100, 1)").run(episodeId)
  const queue = await h.request('GET', '/api/v1/player/ratings/unrated?profile=default')
  assert.equal(queue.status, 200)
  assert.equal(queue.json.items[0].childCount, 1)
  const dismiss = await h.request('POST', `/api/v1/player/ratings/unrated/episode/${episodeId}/dismiss`, { body: { profileId: 'default' } })
  assert.equal(dismiss.status, 204)
  const afterDismiss = await h.request('GET', '/api/v1/player/ratings/unrated?profile=default')
  assert.equal(afterDismiss.json.items.length, 0)
})
