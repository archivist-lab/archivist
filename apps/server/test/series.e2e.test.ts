import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, startTmdbMock, type TestHarness } from './helpers.js'

let h: TestHarness
let tmdb: Awaited<ReturnType<typeof startTmdbMock>>
let headers: Record<string, string>
let seriesId: number
let episodeId: number
let seasonId: number

test('boot with TMDB mock', async () => {
  tmdb = await startTmdbMock()
  h = await startTestApp({ env: { TMDB_BASE_URL: tmdb.url, TVDB_BASE_URL: `${tmdb.url}/tvdb-unavailable`, SKYHOOK_BASE_URL: tmdb.url, TMDB_API_KEY: 'test-key' } })
  const tabs = await h.request('GET', '/api/v1/tabs')
  const tab = tabs.json.find((t: any) => t.media_type === 'series')
  headers = { 'x-tab-context': String(tab.id) }
})

after(async () => {
  await h?.close()
  await tmdb?.close()
})

test('lookup falls back to TMDB and reports alreadyAdded', async () => {
  const res = await h.request('GET', '/api/v1/series/lookup?q=breaking+bad', { headers })
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 1)
  assert.equal(res.json[0].tmdbId, 1396)
  assert.equal(res.json[0].alreadyAdded, false)
})

test('add series resolves and stores the TVDB identity supplied by TMDB', async () => {
  // TVDB points at the deliberately unavailable mock path. The add still uses
  // TMDB, while its external IDs retain TVDB for schedule lookup and matching.
  const res = await h.request('POST', '/api/v1/series', { body: { tmdbId: 1396, monitored: true, monitoredSeasons: 'all' }, headers })
  assert.equal(res.status, 201)
  seriesId = res.json.id
  assert.equal(res.json.title, 'Breaking Bad')
  assert.equal(res.json.year, 2008)
  assert.equal(res.json.status, 'ended')
  assert.equal(res.json.network, 'AMC')

  const { getDb } = await import('../src/db.js')
  const stored = getDb().prepare('SELECT tvdb_id, tmdb_id FROM series WHERE id = ?').get(seriesId) as any
  assert.deepEqual(stored, { tvdb_id: 81189, tmdb_id: 1396 })

  const dup = await h.request('POST', '/api/v1/series', { body: { tmdbId: 1396 }, headers })
  assert.equal(dup.status, 409)

  const seasons = await h.request('GET', `/api/v1/series/${seriesId}/seasons`, { headers })
  assert.equal(seasons.json.length, 2)
  seasonId = seasons.json[0].id
  assert.equal(seasons.json[0].total_episodes, 2)

  const episodes = await h.request('GET', `/api/v1/series/${seriesId}/episodes`, { headers })
  assert.equal(episodes.json.length, 4)
  episodeId = episodes.json[0].id
  assert.equal(episodes.json[0].status, 'missing')
  assert.equal(episodes.json[0].aired, 1)
  assert.equal(episodes.json[0].air_at, '2008-01-20T02:00:00.000Z')
  assert.equal(episodes.json[0].air_time_source, 'provider_timestamp')
  assert.match(episodes.json[0].air_time, /^\d{2}:\d{2}$/)
  assert.ok(episodes.json[0].air_timezone)
})

test('list includes stats and preserves legacy field names', async () => {
  const res = await h.request('GET', '/api/v1/series', { headers })
  assert.equal(res.json.length, 1)
  const s = res.json[0]
  assert.equal(s.stats.total, 4)
  assert.equal(s.stats.missing, 4)
  assert.ok('poster_path' in s || s.posterPath === undefined)
  assert.equal(s.aired_count, 4)
})

test('detail, tmdb compatibility lookup, and 404 semantics', async () => {
  const detail = await h.request('GET', `/api/v1/series/${seriesId}`, { headers })
  assert.equal(detail.status, 200)
  assert.equal(detail.json.title, 'Breaking Bad')

  const local = await h.request('GET', '/api/v1/series/tmdb/1396', { headers })
  assert.equal(local.json.localId, seriesId)

  const missing = await h.request('GET', '/api/v1/series/999999', { headers })
  assert.equal(missing.status, 404)
})

test('season update returns row; episode update returns row', async () => {
  const season = await h.request('PUT', `/api/v1/series/seasons/${seasonId}`, { body: { monitored: false }, headers })
  assert.equal(season.status, 200)
  assert.equal(season.json.monitored, 0)

  const ep = await h.request('PUT', `/api/v1/series/episodes/${episodeId}`, { body: { monitored: false }, headers })
  assert.equal(ep.status, 200)
  assert.equal(ep.json.monitored, 0)
})

test('season metadata and poster can be edited', async () => {
  const metadata = await h.request('PUT', `/api/v1/series/seasons/${seasonId}/metadata`, {
    body: { title: 'Edited Season One', overview: 'An edited season synopsis.' },
    headers,
  })
  assert.equal(metadata.status, 200)
  assert.equal(metadata.json.title, 'Edited Season One')
  assert.equal(metadata.json.overview, 'An edited season synopsis.')

  const candidates = await h.request('GET', `/api/v1/series/seasons/${seasonId}/images?type=poster`, { headers })
  assert.equal(candidates.status, 200)
  assert.equal(candidates.json[0].type, 'poster')
  assert.match(candidates.json[0].url, /mock-season-poster/)

  const saved = await h.request('PUT', `/api/v1/series/seasons/${seasonId}/images`, {
    body: { type: 'poster', url: `${tmdb.url}/assets/season-poster.jpg` },
    headers,
  })
  assert.equal(saved.status, 200)
  assert.match(saved.json.path, /^\/media\//)

  const { getDb } = await import('../src/db.js')
  const stored = getDb().prepare('SELECT poster_path FROM seasons WHERE id = ?').get(seasonId) as any
  assert.equal(stored.poster_path, saved.json.path)
})

test('episode metadata, airtime and backdrop can be edited', async () => {
  const metadata = await h.request('PUT', `/api/v1/series/episodes/${episodeId}/metadata`, {
    body: {
      title: 'Edited Pilot',
      overview: 'An edited episode synopsis.',
      air_date: '2008-01-20',
      air_time: '21:30',
      runtime: 61,
    },
    headers,
  })
  assert.equal(metadata.status, 200)
  assert.equal(metadata.json.title, 'Edited Pilot')
  assert.equal(metadata.json.overview, 'An edited episode synopsis.')
  assert.equal(metadata.json.air_time, '21:30')
  assert.equal(metadata.json.runtime, 61)
  assert.equal(metadata.json.air_time_source, 'manual')
  assert.ok(metadata.json.air_at)

  const candidates = await h.request('GET', `/api/v1/series/episodes/${episodeId}/images?type=backdrop`, { headers })
  assert.equal(candidates.status, 200)
  assert.equal(candidates.json[0].type, 'backdrop')
  assert.match(candidates.json[0].url, /mock-episode-still/)

  const saved = await h.request('PUT', `/api/v1/series/episodes/${episodeId}/images`, {
    body: { type: 'backdrop', url: `${tmdb.url}/assets/episode-still.jpg` },
    headers,
  })
  assert.equal(saved.status, 200)
  assert.match(saved.json.path, /^\/media\//)

  const { getDb } = await import('../src/db.js')
  const stored = getDb().prepare('SELECT still_path FROM episodes WHERE id = ?').get(episodeId) as any
  assert.equal(stored.still_path, saved.json.path)
})

test('series update persists policy fields', async () => {
  const res = await h.request('PUT', `/api/v1/series/${seriesId}`, { body: { minimum_tier: 'Tier 3', target_tier: 'Tier 2', minimum_resolution: '720p', target_resolution: '1080p', upgrade_allowed: false }, headers })
  assert.equal(res.json.target_tier, 'Tier 2')
  assert.equal(res.json.minimum_tier, 'Tier 3')
  assert.equal(res.json.minimum_resolution, '720p')
  assert.equal(res.json.upgrade_allowed, false)
})

test('episode acquisition history/reject/repair', async () => {
  const history = await h.request('GET', `/api/v1/series/episodes/${episodeId}/acquisition-history`, { headers })
  assert.deepEqual(history.json, { decisions: [], blocks: [] })

  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE episodes SET status = 'acquiring', info_hash = ?, current_release_title = 'Breaking.Bad.S01E01.1080p-TEST' WHERE id = ?").run('b'.repeat(40), episodeId)

  const reject = await h.request('POST', `/api/v1/series/episodes/${episodeId}/reject-current-release`, { body: { reason: 'fake release' }, headers })
  assert.equal(reject.json.success, true)

  const history2 = await h.request('GET', `/api/v1/series/episodes/${episodeId}/acquisition-history`, { headers })
  assert.equal(history2.json.blocks.length, 1)
  assert.equal(history2.json.blocks[0].reason, 'fake release')

  getDb().prepare("UPDATE episodes SET status = 'collected', file_path = '/nonexistent/e1.mkv', current_release_title = 'Breaking.Bad.S01E01.REPACK-TEST' WHERE id = ?").run(episodeId)
  const repair = await h.request('POST', `/api/v1/series/episodes/${episodeId}/repair`, { body: {}, headers })
  assert.equal(repair.status, 200)
  assert.equal(repair.json.status, 'missing')
  assert.equal(repair.json.file_path, null)
})

test('season acquisition controls reset child episodes', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  db.prepare("UPDATE seasons SET info_hash = ?, download_progress = 0.5 WHERE id = ?").run('c'.repeat(40), seasonId)
  db.prepare("UPDATE episodes SET status = 'acquiring' WHERE season_id = ?").run(seasonId)
  const season = db.prepare('SELECT season_number, series_id FROM seasons WHERE id = ?').get(seasonId) as any
  db.prepare("UPDATE seasons SET info_hash = ? WHERE id = ?").run('c'.repeat(40), seasonId)

  const repair = await h.request('POST', `/api/v1/series/seasons/${seasonId}/repair`, { body: {}, headers })
  assert.equal(repair.status, 200)

  const episodes = db.prepare('SELECT status FROM episodes WHERE series_id = ? AND season_number = ?').all(season.series_id, season.season_number) as any[]
  for (const ep of episodes) assert.equal(ep.status, 'missing')

  const history = await h.request('GET', `/api/v1/series/seasons/${seasonId}/acquisition-history`, { headers })
  assert.ok(history.json.blocks.length >= 1)
})

test('calendar returns empty for past-only series with legacy loose shape', async () => {
  const res = await h.request('GET', '/api/v1/series/calendar', { headers })
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.json))
})

test('release search SSE emits done with no indexers', async () => {
  const res = await fetch(`${h.baseUrl}/api/v1/series/releases/search?q=breaking+bad+S01E01`, { headers: { ...h.authHeaders, ...headers } })
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const text = await res.text()
  assert.match(text, /event: done/)
})


test('automatic scan endpoints run synchronously for series, season and episode', async () => {
  // Auto scan now runs to completion (so the UI button reflects it). With no
  // indexers/clients in the test env, each target shape resolves and reports the
  // infra error synchronously rather than firing a background 202.
  const season = (await h.request('GET', '/api/v1/series/' + seriesId + '/seasons', { headers })).json[0]
  const targets = [
    { seriesId },
    { seriesId, seasonNumber: season.season_number },
    { seriesId, episodeId },
  ]
  for (const body of targets) {
    const scan = await h.request('POST', '/api/v1/series/releases/auto', { body, headers })
    assert.equal(scan.status, 400)
    assert.match(String(scan.json.error), /indexer|download client/i)
  }
})

test('refresh queues a durable metadata job', async () => {
  const res = await h.request('POST', '/api/v1/series/refresh', { body: {}, headers })
  assert.equal(res.json.success, true)
  assert.equal(res.json.queued, 1)

  const { getDb } = await import('../src/db.js')
  const job = getDb().prepare(`
    SELECT type, status, subject_type, subject_id
    FROM system_jobs
    WHERE type = 'series-metadata-refresh' AND subject_id = ?
  `).get(String(seriesId)) as any
  assert.equal(job.type, 'series-metadata-refresh')
  assert.equal(job.status, 'queued')
  assert.equal(job.subject_type, 'series')
})

test('episode metadata refresh becomes due one hour after airtime, even when unmonitored', async () => {
  const { getDb } = await import('../src/db.js')
  const { enqueueDueSeriesMetadataRefreshes } = await import('../src/modules/series/metadata-refresh.js')
  const db = getDb()
  const now = new Date()
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60_000).toISOString()
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000).toISOString()
  const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60_000).toISOString()

  db.prepare(`
    DELETE FROM system_jobs
    WHERE type = 'series-metadata-refresh' AND subject_id = ?
  `).run(String(seriesId))
  db.prepare(`
    UPDATE series
    SET monitored = 0, last_metadata_refresh_at = ?, next_metadata_refresh_at = datetime(?, '+1 day')
    WHERE id = ?
  `).run(threeHoursAgo, now.toISOString(), seriesId)
  db.prepare('UPDATE episodes SET air_at = ? WHERE id = ?').run(thirtyMinutesAgo, episodeId)
  assert.equal(enqueueDueSeriesMetadataRefreshes(now), 0, 'the first hour after airtime is not due')

  db.prepare('UPDATE episodes SET air_at = ? WHERE id = ?').run(twoHoursAgo, episodeId)
  assert.equal(enqueueDueSeriesMetadataRefreshes(now), 1, 'post-air metadata is due after one hour')
  assert.equal(enqueueDueSeriesMetadataRefreshes(now), 0, 'an active job is not duplicated')

  const job = db.prepare(`
    SELECT type, status, subject_type, subject_id
    FROM system_jobs
    WHERE type = 'series-metadata-refresh' AND subject_id = ?
  `).get(String(seriesId)) as any
  assert.deepEqual(job, {
    type: 'series-metadata-refresh',
    status: 'queued',
    subject_type: 'series',
    subject_id: String(seriesId),
  })

  db.prepare("DELETE FROM system_jobs WHERE type = 'series-metadata-refresh' AND subject_id = ?").run(String(seriesId))
  db.prepare(`
    UPDATE series
    SET monitored = 1, last_metadata_refresh_at = datetime('now'), next_metadata_refresh_at = datetime('now', '+1 day')
    WHERE id = ?
  `).run(seriesId)
})

test('delete series cascades and returns 204', async () => {
  const res = await h.request('DELETE', `/api/v1/series/${seriesId}`, { headers })
  assert.equal(res.status, 204)

  const { getDb } = await import('../src/db.js')
  const eps = getDb().prepare('SELECT COUNT(*) AS n FROM episodes WHERE series_id = ?').get(seriesId) as any
  assert.equal(eps.n, 0)
})
