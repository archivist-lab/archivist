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
  assert.equal(response.json.preferences.preferences.schemaVersion, 1)
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
  const profile = await h.request('GET', '/api/v1/player/ui/bootstrap?profile=other')
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

  const first = await h.request('GET', `/api/v1/player/hubs/films?libraryId=${library.id}&limit=2`)
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.widgets[0].items.map((item: any) => item.title), ['Able', 'Beta'])
  assert.equal(first.json.widgets[0].total, 3)
  assert.ok(first.json.widgets[0].nextCursor)
  const second = await h.request('GET', `/api/v1/player/hubs/films?libraryId=${library.id}&limit=2&cursor=${first.json.widgets[0].nextCursor}`)
  assert.deepEqual(second.json.widgets[0].items.map((item: any) => item.title), ['Cedar'])

  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const preferences = structuredClone(current.preferences)
  preferences.libraries.films.sort = 'rating'
  preferences.libraries.films.hideUnavailable = true
  const saved = await h.request('PUT', '/api/v1/player/ui/preferences', { body: { profileId: 'default', expectedRevision: current.revision, preferences } })
  assert.equal(saved.status, 200)
  const filtered = await h.request('GET', `/api/v1/player/hubs/films?libraryId=${library.id}`)
  assert.deepEqual(filtered.json.widgets[0].items.map((item: any) => item.title), ['Cedar', 'Beta'])
  assert.equal(filtered.json.widgets[0].total, 2)
})

test('combined preset exposes the enabled widgets as the horizontal selector', async () => {
  const current = (await h.request('GET', '/api/v1/player/ui/bootstrap')).json.preferences as PlayerPreferencesEnvelope
  const preferences = structuredClone(current.preferences)
  preferences.preset = 'combined'
  preferences.navigation.edgeRail = 'minimized'
  preferences.home.widgetMode = 'combined'
  preferences.home.showSpotlight = true
  const saved = await h.request('PUT', '/api/v1/player/ui/preferences', { body: { profileId: 'default', expectedRevision: current.revision, preferences } })
  assert.equal(saved.status, 200)
  const home = await h.request('GET', '/api/v1/player/hubs/home')
  assert.equal(home.status, 200)
  assert.ok(home.json.categories.length > 0)
  assert.deepEqual(home.json.categories.map((category: any) => category.id), home.json.widgets.map((widget: any) => widget.id))
  assert.equal(home.json.categories[0].active, true)
})
