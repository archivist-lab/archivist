import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, startTmdbMock, type TestHarness } from './helpers.js'
import { getDb } from '../src/db.js'

let h: TestHarness
let filmsLibraryId: number
let seriesLibraryId: number
let candidateFilmId: number

test('recommendation fixture boots', async () => {
  h = await startTestApp()
  const tabs = await h.request('GET', '/api/v1/tabs')
  filmsLibraryId = tabs.json.find((tab: any) => tab.media_type === 'films').id
  seriesLibraryId = tabs.json.find((tab: any) => tab.media_type === 'series').id
  const db = getDb()
  const seedId = Number(db.prepare(`INSERT INTO films (library_id, tmdb_id, title, genres, rating, status, file_path)
    VALUES (?, 1001, 'Finished Seed', '["Science Fiction"]', 8.8, 'collected', '/media/seed.mkv')`).run(filmsLibraryId).lastInsertRowid)
  candidateFilmId = Number(db.prepare(`INSERT INTO films (library_id, tmdb_id, title, genres, rating, status, file_path)
    VALUES (?, 1002, 'Museum Candidate', '["Science Fiction"]', 8.1, 'collected', '/media/candidate.mkv')`).run(filmsLibraryId).lastInsertRowid)
  db.prepare(`INSERT INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed)
    VALUES ('default', 'film', ?, 7200, 7200, 1)`).run(seedId)

  const seriesSeed = Number(db.prepare(`INSERT INTO series (library_id, tmdb_id, tvdb_id, title, genres, rating)
    VALUES (?, 2001, 3001, 'Finished Series', '["Drama"]', 9.0)`).run(seriesLibraryId).lastInsertRowid)
  const seedSeason = Number(db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, 1)').run(seriesSeed).lastInsertRowid)
  const seedEpisode = Number(db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, status, file_path, air_date)
    VALUES (?, ?, 1, 1, 'downloaded', '/media/series-seed.mkv', '2020-01-01')`).run(seriesSeed, seedSeason).lastInsertRowid)
  db.prepare(`INSERT INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed)
    VALUES ('default', 'episode', ?, 3600, 3600, 1)`).run(seedEpisode)
  const seriesCandidate = Number(db.prepare(`INSERT INTO series (library_id, tmdb_id, tvdb_id, title, genres, rating)
    VALUES (?, 2002, 3002, 'Series Candidate', '["Drama"]', 8.5)`).run(seriesLibraryId).lastInsertRowid)
  const candidateSeason = Number(db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, 1)').run(seriesCandidate).lastInsertRowid)
  db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, status, file_path, air_date)
    VALUES (?, ?, 1, 1, 'downloaded', '/media/series-candidate.mkv', '2020-01-01')`).run(seriesCandidate, candidateSeason)
})

after(async () => { await h?.close() })

test('film recommendations are local, completion-aware and explainable without TMDB', async () => {
  const response = await h.request('GET', '/api/v1/recommendations/films?audience=default', { headers: { 'x-tab-context': String(filmsLibraryId) } })
  assert.equal(response.status, 200)
  assert.equal(response.json.mediaType, 'film')
  const items = response.json.groups.flatMap((group: any) => group.items)
  assert.ok(items.some((item: any) => item.tmdbId === 1002))
  assert.ok(!items.some((item: any) => item.tmdbId === 1001), 'completed seed must not recommend itself')
  const candidate = items.find((item: any) => item.tmdbId === 1002)
  assert.equal(candidate.alreadyAdded, true)
  assert.equal(candidate.recommendation.availability, 'available')
  assert.match(candidate.recommendation.reason, /Finished Seed/)
})

test('profile feedback suppresses a title and invalidates its snapshot', async () => {
  const feedback = await h.request('POST', '/api/v1/recommendations/feedback', { body: { profileId: 'default', mediaType: 'film', providerId: 1002, feedback: 'not_interested' } })
  assert.equal(feedback.status, 204)
  const response = await h.request('GET', '/api/v1/recommendations/films?audience=default', { headers: { 'x-tab-context': String(filmsLibraryId) } })
  assert.ok(!response.json.groups.flatMap((group: any) => group.items).some((item: any) => item.tmdbId === 1002))
})

test('series completion excludes the finished seed and recommends available related series', async () => {
  const response = await h.request('GET', '/api/v1/recommendations/series?audience=default', { headers: { 'x-tab-context': String(seriesLibraryId) } })
  assert.equal(response.status, 200)
  const items = response.json.groups.flatMap((group: any) => group.items)
  assert.ok(items.some((item: any) => item.tmdbId === 2002))
  assert.ok(!items.some((item: any) => item.tmdbId === 2001))
  assert.equal(items.find((item: any) => item.tmdbId === 2002).recommendation.availability, 'available')
})

test('first page and rebuild populate external TMDB candidates before ranking', async () => {
  const mock = await startTmdbMock()
  process.env.TMDB_BASE_URL = mock.url
  process.env.TMDB_API_KEY = 'test-key'
  try {
    getDb().prepare('DELETE FROM recommendation_source_candidates').run()
    getDb().prepare('UPDATE recommendation_snapshots SET invalidated_at = datetime(\'now\')').run()

    const firstPage = await h.request('GET', '/api/v1/recommendations/films?audience=default', { headers: { 'x-tab-context': String(filmsLibraryId) } })
    assert.equal(firstPage.status, 200)
    assert.ok(firstPage.json.groups.flatMap((group: any) => group.items).some((item: any) => item.alreadyAdded === false))
    assert.ok((getDb().prepare('SELECT COUNT(*) AS count FROM recommendation_source_candidates').get() as any).count > 0)

    getDb().prepare('DELETE FROM recommendation_source_candidates').run()
    const response = await h.request('POST', '/api/v1/recommendations/rebuild', { body: { audience: 'default' }, headers: { 'x-tab-context': String(filmsLibraryId) } })
    assert.equal(response.status, 200)
    const items = response.json.groups.flatMap((group: any) => group.items)
    const external = items.find((item: any) => item.tmdbId === 604)
    assert.ok(external)
    assert.equal(external.alreadyAdded, false)
    assert.match(external.recommendation.reason, /Finished Seed/)
    assert.equal(new Set(items.map((item: any) => `${item.mediaType}:${item.providerId}`)).size, items.length)
  } finally {
    delete process.env.TMDB_BASE_URL
    delete process.env.TMDB_API_KEY
    await mock.close()
  }
})

test('Player home receives an available recommendation widget from snapshots', async () => {
  const response = await h.request('GET', '/api/v1/player/hubs/home?profile=default')
  assert.equal(response.status, 200)
  const widget = response.json.widgets.find((entry: any) => entry.source === 'recommendations')
  assert.ok(widget)
  assert.ok(widget.items.some((item: any) => item.title === 'Series Candidate'))
  assert.ok(widget.items.every((item: any) => item.available))
})

test('recommendation health reports versioned snapshots and engagement table is populated', async () => {
  const progress = await h.request('POST', '/api/v1/player/progress', { body: { profileId: 'default', type: 'film', id: candidateFilmId, positionSeconds: 30, durationSeconds: 100, completed: false } })
  assert.equal(progress.status, 204)
  const health = await h.request('GET', '/api/v1/system/recommendations/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.modelVersion, 'hybrid-v1')
  assert.ok(Array.isArray(health.json.snapshots))
  assert.ok((getDb().prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as any).count > 0)
})

test('recommendation governance settings disable serving and validate retention', async () => {
  const invalid = await h.request('PUT', '/api/v1/system/recommendations/settings', { body: { retentionDays: 2 } })
  assert.equal(invalid.status, 400)
  const disabled = await h.request('PUT', '/api/v1/system/recommendations/settings', { body: { enabled: false, retentionDays: 30 } })
  assert.deepEqual(disabled.json, { enabled: false, retentionDays: 30 })
  const page = await h.request('GET', '/api/v1/recommendations/series?audience=default', { headers: { 'x-tab-context': String(seriesLibraryId) } })
  assert.deepEqual(page.json.groups, [])
  const enabled = await h.request('PUT', '/api/v1/system/recommendations/settings', { body: { enabled: true, retentionDays: 90 } })
  assert.deepEqual(enabled.json, { enabled: true, retentionDays: 90 })
})
