import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { getPlayerConfig, PlayerConfigError } from '../src/player/config.js'
import { decodePlayerCursor, encodePlayerCursor, PlayerCursorError, toAcquisitionCard } from '../src/player/hub-service.js'
import { preferencesForPreset, validatePlayerPreferences, PlayerPreferencesValidationError, DEFAULT_PLAYER_PREFERENCES } from '../src/player/preferences.js'
import { serializeFilmDetail, serializeFilmSummary, PlayerSerializationError } from '../src/player/serializers.js'
import { getPlayerMetricSnapshot, recordPlayerTelemetry, resetPlayerTelemetryForTest, PlayerTelemetryValidationError } from '../src/player/telemetry.js'
import { probeTracks } from '../src/player/media.js'
import { createGateway } from '../src/gateway.js'

test('Player config uses exact defaults and strict environment validation', () => {
  const defaults = getPlayerConfig({})
  assert.equal(defaults.uiV2Enabled, true) // living-room UI is the default; PLAYER_UI_V2_ENABLED=false falls back to legacy
  assert.equal(getPlayerConfig({ PLAYER_UI_V2_ENABLED: 'false' }).uiV2Enabled, false)
  assert.equal(defaults.defaultPreset, 'categories')
  assert.equal(defaults.maxWidgetItems, 36)
  assert.equal(defaults.telemetryEnabled, false)
  assert.deepEqual(getPlayerConfig({ PLAYER_UI_V2_ENABLED: 'TRUE', PLAYER_UI_DEFAULT_PRESET: 'combined', PLAYER_UI_MAX_WIDGET_ITEMS: '60', PLAYER_UI_TELEMETRY_ENABLED: 'true' }).public, { defaultPreset: 'combined', maxWidgetItems: 60 })
  assert.throws(() => getPlayerConfig({ PLAYER_UI_V2_ENABLED: 'yes' }), PlayerConfigError)
  assert.throws(() => getPlayerConfig({ PLAYER_UI_MAX_WIDGET_ITEMS: '11' }), PlayerConfigError)
})

test('serializers bound summaries, retain detail plots, and never expose paths', () => {
  const overview = 'x'.repeat(400)
  const row = { id: 9, library_id: 2, title: 'Fixture', overview, genres: 'malformed', file_path: '/private/media/fixture.mkv', runtime: 90 }
  const summary = serializeFilmSummary(row)
  assert.equal([...summary.overview!].length, 280)
  assert.deepEqual(summary.genres, [])
  assert.equal(serializeFilmDetail(row).overview, overview)
  assert.ok(!JSON.stringify(summary).includes('/private/media'))
  assert.throws(() => serializeFilmSummary({ id: 0 }), PlayerSerializationError)
})

test('film activity badges interpret download progress as a fraction only for active transfers', () => {
  const base = { id: 9, library_id: 2, title: 'Fixture', genres: '[]' }

  const active = serializeFilmSummary({ ...base, status: 'acquiring', download_progress: 0.425 })
  assert.deepEqual(active.activityBadges.map(badge => badge.label), ['Downloading 43%'])

  const collected = serializeFilmSummary({
    ...base,
    status: 'collected',
    download_progress: 1,
    file_path: '/private/media/fixture.mkv',
  })
  assert.deepEqual(collected.activityBadges, [])
})

test('legacy preference presets all normalize to the canonical museum composition', () => {
  const matrix = {
    classic: ['minimized', 'standard', true], categories: ['minimized', 'standard', true],
    compound: ['minimized', 'standard', true], combined: ['minimized', 'standard', true],
  } as const
  for (const [preset, expected] of Object.entries(matrix) as Array<[keyof typeof matrix, typeof matrix[keyof typeof matrix]]>) {
    const value = preferencesForPreset(preset)
    assert.deepEqual([value.navigation.edgeRail, value.home.hubs[0].layout, value.home.hubs[0].showSpotlight], expected)
    assert.equal(value.preset, 'categories')
    assert.deepEqual(validatePlayerPreferences(value), value)
  }
  assert.ok(Object.isFrozen(DEFAULT_PLAYER_PREFERENCES.home.hubs[0].widgets))
  const invalid = structuredClone(preferencesForPreset('categories')) as any
  invalid.home.hubs[0].widgets[0].unknown = true
  assert.throws(() => validatePlayerPreferences(invalid), PlayerPreferencesValidationError)
})

test('schema-one preferences migrate into a protected standard Home hub', () => {
  const current = preferencesForPreset('categories') as any
  const { browsing: _browsing, ...withoutBrowsing } = current
  const legacy = {
    ...withoutBrowsing,
    schemaVersion: 1,
    libraries: {
      films: (({ sortOrder: _order, ...library }: any) => library)(current.libraries.films),
      series: (({ sortOrder: _order, ...library }: any) => library)(current.libraries.series),
    },
    home: { widgetMode: 'combined', showSpotlight: false, widgets: current.home.hubs[0].widgets.map(({ sort: _sort, sortOrder: _order, autoscrollSeconds: _autoscroll, savedFilterId: _saved, downloadMediaTypes: _downloads, ...widget }: any) => widget) },
  }
  const migrated = validatePlayerPreferences(legacy)
  assert.equal(migrated.schemaVersion, 5)
  assert.deepEqual(migrated.home.hubs[0], {
    ...migrated.home.hubs[0], id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null,
  })
  assert.equal(migrated.home.hubs[0].widgets[0].sort, 'source')
  assert.equal(migrated.home.hubs[0].widgets[0].savedFilterId, null)
  assert.deepEqual(migrated.browsing.savedFilters, [])
})

test('schema-two preferences migrate browse defaults and saved-filter references are strict', () => {
  const current = preferencesForPreset('categories') as any
  const schemaTwo = structuredClone(current)
  schemaTwo.schemaVersion = 2
  delete schemaTwo.browsing
  for (const library of Object.values(schemaTwo.libraries) as any[]) delete library.sortOrder
  for (const hub of schemaTwo.home.hubs) for (const widget of hub.widgets) { delete widget.savedFilterId; delete widget.downloadMediaTypes }
  const migrated = validatePlayerPreferences(schemaTwo)
  assert.equal(migrated.schemaVersion, 5)
  assert.equal(migrated.libraries.films.sortOrder, 'asc')
  assert.equal(migrated.browsing.defaultViews.episodes, 'landscape')
  assert.equal(migrated.appearance.accentColor, '#00d4ff')
  assert.equal(migrated.playback.osdTimeoutSeconds, 3)

  const invalid = structuredClone(migrated) as any
  invalid.home.hubs[0].widgets[0].source = 'saved-filter'
  invalid.home.hubs[0].widgets[0].savedFilterId = 'missing'
  assert.throws(() => validatePlayerPreferences(invalid), PlayerPreferencesValidationError)
})

test('schema-four preferences become available-only with separate film and series downloads', () => {
  const schemaFour = structuredClone(preferencesForPreset('categories')) as any
  schemaFour.schemaVersion = 4
  schemaFour.libraries.films.hideUnavailable = false
  schemaFour.libraries.series.hideUnavailable = false
  schemaFour.home.hubs[0].widgets = schemaFour.home.hubs[0].widgets
    .filter((widget: any) => widget.source !== 'downloading')
  schemaFour.home.hubs[0].widgets.push({
    id: 'downloading', title: 'Downloading', source: 'downloading', view: 'poster', sort: 'source', sortOrder: 'desc',
    limit: 12, autoscrollSeconds: 0, savedFilterId: null, enabled: true,
  })
  for (const hub of schemaFour.home.hubs) for (const widget of hub.widgets) delete widget.downloadMediaTypes
  const migrated = validatePlayerPreferences(schemaFour)
  assert.equal(migrated.schemaVersion, 5)
  assert.equal(migrated.libraries.films.hideUnavailable, true)
  assert.equal(migrated.libraries.series.hideUnavailable, true)
  const downloads = migrated.home.hubs[0].widgets.filter(widget => widget.source === 'downloading')
  assert.deepEqual(downloads.map(widget => [widget.title, widget.view, widget.downloadMediaTypes]), [
    ['Downloading Films', 'poster', ['films']],
    ['Downloading Series', 'landscape', ['series']],
  ])
})

test('cursor codec round-trips exact values and rejects malformed input', () => {
  const value = { sortValue: 'Alpha', id: 42 }
  assert.deepEqual(decodePlayerCursor(encodePlayerCursor(value)), value)
  assert.throws(() => decodePlayerCursor('***'), PlayerCursorError)
  assert.throws(() => decodePlayerCursor(Buffer.from('{"id":0}').toString('base64url')), PlayerCursorError)
})

test('acquisition cards preserve live torrent progress, speed, and ETA', () => {
  const card = toAcquisitionCard({ id: 'torrent-1', name: 'Fixture.Release', status: 'downloading', progress: 0.425, downloadSpeed: 2 * 1024 ** 2, eta: 600 })
  assert.equal(card.key, 'download:torrent-1')
  assert.equal(card.mediaType, 'download')
  assert.equal(card.acquisition?.percent, 42.5)
  assert.equal(card.subtitle, '43% · 2.0 MB/s · 10 min left')
  assert.deepEqual(card.badges.map(badge => badge.label), ['Downloading', '2.0 MB/s', '10 min left'])
  assert.equal(card.route, '')
})

test('season and episode acquisition cards preserve hierarchy presentation', () => {
  const torrent = { id: 'series-pack', name: 'Release', status: 'downloading', progress: 0.55, downloadSpeed: 0, eta: -1 }
  const season = toAcquisitionCard(torrent, null, { kind: 'season', mediaType: 'series', id: 8, route: '/series/8', title: 'Succession S02 - 55%', subtitle: 'Season Download', posterUrl: '/season.jpg' })
  assert.deepEqual([season.acquisition?.kind, season.title, season.posterUrl], ['season', 'Succession S02 - 55%', '/season.jpg'])
  const episode = toAcquisitionCard(torrent, null, { kind: 'episode', mediaType: 'episode', id: 12, route: '/series/8', title: 'E05 · Retired Janitors of Idaho', subtitle: 'Succession · S02', landscapeUrl: '/episode.jpg' })
  assert.deepEqual([episode.acquisition?.kind, episode.title, episode.subtitle, episode.landscapeUrl], ['episode', 'E05 · Retired Janitors of Idaho', 'Succession · S02', '/episode.jpg'])
})

test('telemetry validates privacy envelope and accumulates fixed buckets', () => {
  resetPlayerTelemetryForTest()
  const now = Date.now()
  recordPlayerTelemetry({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', samples: [{ name: 'player_osd_open_ms', valueMs: 32, at: now }] })
  const metric = getPlayerMetricSnapshot().metrics.player_osd_open_ms!
  assert.equal(metric.count, 1)
  assert.equal(metric.sum, 32)
  assert.equal(metric.buckets['32'], 1)
  assert.throws(() => recordPlayerTelemetry({ sessionId: 'title', samples: [] }), PlayerTelemetryValidationError)
  assert.throws(() => recordPlayerTelemetry({ sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', samples: [{ name: 'player_osd_open_ms', valueMs: 1, at: now, title: 'secret' } as any] }), PlayerTelemetryValidationError)
})

test('media probe timing fires exactly once on failure', async () => {
  const calls: Array<[string, number, string]> = []
  assert.equal(await probeTracks('/definitely/missing/player-fixture.mkv', (operation, duration, outcome) => calls.push([operation, duration, outcome])), null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'probe')
  assert.equal(calls[0][2], 'error')
})

test('the gateway serves each surface under its prefix and hands the API to Express unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archivist-gateway-static-'))
  const dist = (name: string) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), `<!doctype html><title>${name} fixture</title>`)
    return dir
  }
  const [libraryDir, playerDir, catalogueDir] = [dist('library'), dist('player'), dist('catalogue')]

  const app = express()
  app.get('/api/v1/auth/status', req => req.res!.json({ delegated: true }))
  app.get('/api/v1/player/fixture', req => req.res!.json({ cookie: req.headers.cookie ?? null, serviceKey: req.headers['x-api-key'] ?? null }))

  const server = createGateway(app, { libraryDir, playerDir, catalogueDir, emulatorDir: join(root, 'emulatorjs') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    // Each prefix serves its own build, with the SPA shell backing unknown
    // client-side routes beneath it.
    for (const [prefix, fixture] of [['/library', 'library'], ['/player', 'player'], ['/catalogue', 'catalogue']] as const) {
      const response = await fetch(`${origin}${prefix}/films`)
      assert.equal(response.status, 200, `${prefix} should serve its SPA shell`)
      assert.match(await response.text(), new RegExp(`${fixture} fixture`))
      assert.match(response.headers.get('server-timing') ?? '', /^static;dur=\d+\.\d$/)
    }

    // The player keeps the strict CSP; the admin surface deliberately carries
    // none, because it has never run under one.
    const player = await fetch(`${origin}/player/`)
    assert.match(player.headers.get('content-security-policy') ?? '', /style-src 'self'/)
    const library = await fetch(`${origin}/library/`)
    assert.equal(library.headers.get('content-security-policy'), null)
    assert.equal(library.headers.get('x-content-type-options'), 'nosniff')

    // A prefix without its trailing slash must redirect, or the SPA's relative
    // asset URLs resolve against the parent path.
    const bare = await fetch(`${origin}/player`, { redirect: 'manual' })
    assert.equal(bare.status, 308)
    assert.equal(bare.headers.get('location'), '/player/')

    // The API is shared at the root and reaches Express untouched.
    const auth = await fetch(`${origin}/api/v1/auth/status`)
    assert.deepEqual(await auth.json(), { delegated: true })
    const delegated = await fetch(`${origin}/api/v1/player/fixture`, { headers: { cookie: 'archivist_session=fixture' } })
    assert.deepEqual(await delegated.json(), { cookie: 'archivist_session=fixture', serviceKey: null })
    assert.equal(delegated.headers.get('server-timing'), null)

    // The root is a chooser; a stale bookmark from the old per-port layout
    // lands there rather than on a bare 404.
    const chooser = await fetch(`${origin}/`)
    assert.equal(chooser.status, 200)
    const chooserBody = await chooser.text()
    for (const href of ['/library/', '/player/', '/catalogue/']) assert.ok(chooserBody.includes(`href="${href}"`), `chooser should link ${href}`)
    const stale = await fetch(`${origin}/films`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    assert.equal(stale.status, 302)
    assert.equal(stale.headers.get('location'), '/')
    // Non-navigation requests still get an honest 404.
    const asset = await fetch(`${origin}/assets/app.js`)
    assert.equal(asset.status, 404)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
