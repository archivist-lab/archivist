import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlayerPreferencesEnvelope, PlayerPreferencesV1 } from '@archivist/contracts'
import { getDb } from '../src/db.js'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness
let initial: PlayerPreferencesEnvelope

before(async () => {
  h = await startTestApp({ env: {
    PLAYER_UI_V2_ENABLED: 'true',
    PLAYER_UI_DEFAULT_PRESET: 'categories',
    PLAYER_UI_MAX_WIDGET_ITEMS: '36',
    PLAYER_UI_TELEMETRY_ENABLED: 'true',
  } })
})
after(async () => { await h?.close() })

test('bootstrap seeds canonical preferences and returns bounded same-origin state', async () => {
  const response = await h.request('GET', '/api/v1/player/ui/bootstrap?profile=default')
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.ok(response.headers['x-request-id'])
  assert.equal(response.json.featureFlags.uiV2Enabled, true)
  assert.equal(response.json.featureFlags.telemetryEnabled, true)
  assert.deepEqual(response.json.configuration, { defaultPreset: 'categories', maxWidgetItems: 36 })
  assert.equal(response.json.preferences.preferences.schemaVersion, 5)
  assert.equal(response.json.initialHub.id, 'home')
  assert.ok(!response.text.includes(process.env.ARCHIVIST_DB!))
  initial = response.json.preferences
})

test('same-revision concurrent preference writes produce one success and one conflict', async () => {
  const current = initial ?? (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences
  const first: PlayerPreferencesV1 = structuredClone(current.preferences)
  const second: PlayerPreferencesV1 = structuredClone(current.preferences)
  first.accessibility.textScale = 1.15
  second.accessibility.highContrast = true
  const body = (preferences: PlayerPreferencesV1) => ({ profileId: 'default', expectedRevision: current.revision, preferences })
  const responses = await Promise.all([
    h.request('PUT', '/api/v1/player/ui/preferences', { body: body(first) }),
    h.request('PUT', '/api/v1/player/ui/preferences', { body: body(second) }),
  ])
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  const conflict = responses.find(response => response.status === 409)!
  assert.equal(conflict.json.error.code, 'PLAYER_PREFERENCES_CONFLICT')
  assert.ok(conflict.json.current.revision > current.revision)
})

test('invalid preferences, profiles, cursors, and telemetry use typed envelopes', async () => {
  const malformed = await h.request('PUT', '/api/v1/player/ui/preferences', { body: null })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.json.error.code, 'PLAYER_INPUT_INVALID')
  const profile = await h.request('GET', '/api/v1/player/ui/bootstrap?profile=Other!')
  assert.equal(profile.status, 400)
  const cursor = await h.request('GET', '/api/v1/player/hubs/home?cursor=***')
  assert.equal(cursor.status, 400)
  assert.equal(cursor.json.error.code, 'PLAYER_CURSOR_INVALID')
  const library = await h.request('GET', '/api/v1/player/hubs/films?libraryId=not-a-number')
  assert.equal(library.status, 400)
  assert.equal(library.json.error.code, 'PLAYER_INPUT_INVALID')
  const telemetry = await h.request('POST', '/api/v1/player/telemetry', { body: { sessionId: 'not-a-session', samples: [] } })
  assert.equal(telemetry.status, 400)
})

test('telemetry is local, aggregated, and reset preserves non-preference state', async () => {
  const now = Date.now()
  const accepted = await h.request('POST', '/api/v1/player/telemetry', { body: {
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    samples: [{ name: 'player_shell_ready_ms', valueMs: 125, at: now }],
  } })
  assert.equal(accepted.status, 204)
  const metrics = await h.request('GET', '/api/v1/player/metrics')
  assert.equal(metrics.status, 200)
  assert.equal(metrics.json.metrics.player_shell_ready_ms.count, 1)
  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const reset = await h.request('POST', '/api/v1/player/ui/preferences/reset', { body: { profileId: 'default', expectedRevision: current.revision } })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.preferences.preset, 'categories')
  assert.equal(reset.json.revision, current.revision + 1)
})

test('library hubs apply stable cursors, saved sort, and availability filters', async () => {
  const db = getDb()
  const library = db.prepare("SELECT id FROM libraries WHERE media_type = 'films' ORDER BY id LIMIT 1").get() as { id: number }
  const insert = db.prepare('INSERT INTO films (library_id, title, sort_title, year, rating, file_path, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  insert.run(library.id, 'Able', 'Able', 2000, 9, null, '2024-01-01')
  insert.run(library.id, 'Beta', 'Beta', 2010, 5, '/fixture/beta.mkv', '2025-01-01')
  insert.run(library.id, 'Cedar', 'Cedar', 2020, 8, '/fixture/cedar.mkv', '2026-01-01')
  insert.run(library.id, 'Delta', 'Delta', 2021, 4, '/fixture/delta.mkv', '2026-02-01')

  const unavailableSearch = await h.request('GET', '/api/v1/player/search?q=Able')
  assert.deepEqual(unavailableSearch.json.groups.films, [])
  const availableSearch = await h.request('GET', '/api/v1/player/search?q=Beta')
  assert.deepEqual(availableSearch.json.groups.films.map((item: any) => item.title), ['Beta'])

  const first = await h.request('GET', `/api/v1/player/hubs/films?libraryId=${library.id}&limit=2`)
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.widgets[0].items.map((item: any) => item.title), ['Beta', 'Cedar'])
  assert.equal(first.json.widgets[0].total, 3)
  assert.ok(first.json.widgets[0].nextCursor)
  const second = await h.request('GET', `/api/v1/player/hubs/films?libraryId=${library.id}&limit=2&cursor=${first.json.widgets[0].nextCursor}`)
  assert.deepEqual(second.json.widgets[0].items.map((item: any) => item.title), ['Delta'])

  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const preferences = structuredClone(current.preferences)
  preferences.libraries.films.sort = 'rating'
  preferences.libraries.films.hideUnavailable = true
  const saved = await h.request('PUT', '/api/v1/player/ui/preferences', { body: { profileId: 'default', expectedRevision: current.revision, preferences } })
  assert.equal(saved.status, 200)
  const filtered = await h.request('GET', `/api/v1/player/hubs/films?libraryId=${library.id}`)
  assert.deepEqual(filtered.json.widgets[0].items.map((item: any) => item.title), ['Cedar', 'Beta', 'Delta'])
  assert.equal(filtered.json.widgets[0].total, 3)
})

test('browse filters combine on the server and saved views power pinned widgets', async () => {
  const db = getDb()
  const library = db.prepare("SELECT id FROM libraries WHERE media_type = 'films' ORDER BY id LIMIT 1").get() as { id: number }
  db.prepare(`UPDATE films SET genres = ?, studio = ?, collection_tmdb_id = ?, collection_name = ?,
    collection_poster_path = ?, collection_backdrop_path = ? WHERE library_id = ? AND title IN ('Beta', 'Cedar')`)
    .run('["Drama","Mystery"]', 'North Studio', 701, 'Archive Pair', '/collection.jpg', '/collection-backdrop.jpg', library.id)
  const cedar = db.prepare("SELECT id FROM films WHERE library_id = ? AND title = 'Cedar'").get(library.id) as { id: number }
  const beta = db.prepare("SELECT id FROM films WHERE library_id = ? AND title = 'Beta'").get(library.id) as { id: number }
  db.prepare(`INSERT OR REPLACE INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed)
    VALUES ('default', 'film', ?, 7200, 7200, 1)`).run(beta.id)
  db.prepare(`INSERT OR REPLACE INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed)
    VALUES ('default', 'film', ?, 0, 7200, 0)`).run(cedar.id)

  const filtered = await h.request('GET', '/api/v1/player/browse/films?genre=Drama&studio=North%20Studio&yearFrom=2015&ratingMin=7&availability=available&watched=unwatched&sort=rating&direction=desc')
  assert.equal(filtered.status, 200)
  assert.deepEqual(filtered.json.items.map((item: any) => item.title), ['Cedar'])
  assert.ok(filtered.json.facets.genres.includes('Drama'))
  assert.ok(filtered.json.facets.studios.includes('North Studio'))

  const collections = await h.request('GET', '/api/v1/player/browse/collections')
  assert.equal(collections.status, 200)
  assert.deepEqual(collections.json.items.map((item: any) => [item.title, item.mediaType]), [['Archive Pair', 'collection']])
  assert.equal(collections.json.items[0].route, '/films?collectionId=701')

  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const preferences = structuredClone(current.preferences)
  preferences.browsing.savedFilters.push({
    id: 'drama-unwatched', name: 'Drama Unwatched', mediaType: 'films',
    filters: { query: '', genres: ['Drama'], yearFrom: 2015, yearTo: null, studios: ['North Studio'], ratingMin: 7, availability: 'available', watched: 'unwatched', alphabet: null, collectionId: null },
    view: 'poster', sort: 'rating', sortOrder: 'desc',
  })
  preferences.home.hubs[0].widgets.push({
    id: 'drama-unwatched', title: 'Drama Unwatched', source: 'saved-filter', savedFilterId: 'drama-unwatched', downloadMediaTypes: [],
    view: 'poster', sort: 'source', sortOrder: 'desc', limit: 6, autoscrollSeconds: 0, enabled: true,
  })
  const saved = await h.request('PUT', '/api/v1/player/ui/preferences', { body: { profileId: 'default', expectedRevision: current.revision, preferences } })
  assert.equal(saved.status, 200)
  const savedPage = await h.request('GET', '/api/v1/player/browse/saved?savedFilter=drama-unwatched')
  assert.deepEqual(savedPage.json.items.map((item: any) => item.title), ['Cedar'])
  const home = await h.request('GET', '/api/v1/player/hubs/home')
  const widget = home.json.widgets.find((entry: any) => entry.id === 'drama-unwatched')
  assert.deepEqual(widget.items.map((item: any) => item.title), ['Cedar'])
  assert.equal(widget.showMoreRoute, '/browse/saved?savedFilter=drama-unwatched')
})

test('series and episode filters aggregate availability and watched state', async () => {
  const db = getDb()
  const library = db.prepare("SELECT id FROM libraries WHERE media_type = 'series' ORDER BY id LIMIT 1").get() as { id: number }
  const series = db.prepare(`INSERT INTO series (library_id, title, sort_title, year, genres, network, rating) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(library.id, 'Player Series', 'Player Series', 2024, '["Drama","Science Fiction"]', 'Archive Network', 8.6)
  const season = db.prepare(`INSERT INTO seasons (series_id, season_number, title) VALUES (?, 1, 'Season 1')`).run(series.lastInsertRowid)
  const episode = db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, air_date, file_path, status)
    VALUES (?, ?, 1, 1, 'Pilot', '2024-02-01', '/fixture/pilot.mkv', 'available')`).run(series.lastInsertRowid, season.lastInsertRowid)
  db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, air_date, status)
    VALUES (?, ?, 1, 2, 'Second', '2024-02-08', 'missing')`).run(series.lastInsertRowid, season.lastInsertRowid)
  db.prepare(`INSERT INTO playback_progress (profile_id, media_type, media_id, position_seconds, duration_seconds, completed)
    VALUES ('default', 'episode', ?, 300, 1800, 0)`).run(episode.lastInsertRowid)

  const seriesPage = await h.request('GET', '/api/v1/player/browse/series?genre=Science%20Fiction&studio=Archive%20Network&yearFrom=2020&ratingMin=8&availability=available&watched=unwatched')
  assert.equal(seriesPage.status, 200)
  assert.deepEqual(seriesPage.json.items.map((item: any) => item.title), ['Player Series'])

  const episodes = await h.request('GET', '/api/v1/player/browse/episodes?genre=Drama&studio=Archive%20Network&availability=available&watched=in-progress&alphabet=P')
  assert.equal(episodes.status, 200)
  assert.deepEqual(episodes.json.items.map((item: any) => item.title), ['Player Series'])
  assert.match(episodes.json.items[0].subtitle, /Pilot/)
  assert.equal(episodes.json.items[0].progress.percent > 0, true)
})

test('legacy combined preset values normalize to the canonical hub', async () => {
  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const preferences = structuredClone(current.preferences)
  preferences.preset = 'combined'
  preferences.navigation.edgeRail = 'minimized'
  preferences.home.hubs[0].layout = 'combined'
  preferences.home.hubs[0].showSpotlight = true
  const saved = await h.request('PUT', '/api/v1/player/ui/preferences', { body: { profileId: 'default', expectedRevision: current.revision, preferences } })
  assert.equal(saved.status, 200)
  const home = await h.request('GET', '/api/v1/player/hubs/home')
  assert.equal(home.status, 200)
  assert.equal(home.json.layout, 'standard')
  assert.deepEqual(home.json.categories, [])
})

test('custom hubs persist layout, spotlight source, widget controls, and stable empty sources', async () => {
  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const preferences = structuredClone(current.preferences)
  preferences.home.hubs.push({
    id: 'critics', name: 'Critics Picks', icon: '★', enabled: true, layout: 'wall', showSpotlight: true, spotlightWidgetId: 'films',
    widgets: [
      { id: 'films', title: 'Films by title', source: 'films-az', view: 'poster', sort: 'title', sortOrder: 'desc', limit: 6, autoscrollSeconds: 8, savedFilterId: null, downloadMediaTypes: [], enabled: true },
      { id: 'activity', title: 'Current downloads', source: 'downloading', view: 'landscape', sort: 'source', sortOrder: 'desc', limit: 6, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: ['films', 'series'], enabled: true },
      { id: 'episodes', title: 'Rated series episodes', source: 'recent-episodes', view: 'landscape', sort: 'rating', sortOrder: 'desc', limit: 6, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true },
    ],
  })
  const saved = await h.request('PUT', '/api/v1/player/ui/preferences', { body: { profileId: 'default', expectedRevision: current.revision, preferences } })
  assert.equal(saved.status, 200)
  const hub = await h.request('GET', '/api/v1/player/hubs/critics')
  assert.equal(hub.status, 200)
  assert.deepEqual([hub.json.title, hub.json.icon, hub.json.layout, hub.json.showSpotlight], ['Critics Picks', '★', 'standard', true])
  assert.deepEqual(hub.json.widgets.map((widget: any) => widget.id), ['films', 'activity', 'episodes'])
  assert.deepEqual(hub.json.widgets[0].items.map((item: any) => item.title), [...hub.json.widgets[0].items.map((item: any) => item.title)].sort().reverse())
  assert.equal(hub.json.widgets[0].autoscrollSeconds, 8)
  assert.equal(hub.json.spotlight?.key, hub.json.widgets[0].items[0]?.key ?? null)
})
