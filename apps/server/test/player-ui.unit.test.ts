import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { getPlayerConfig, PlayerConfigError } from '../src/player/config.js'
import { decodePlayerCursor, encodePlayerCursor, PlayerCursorError } from '../src/player/hub-service.js'
import { preferencesForPreset, validatePlayerPreferences, PlayerPreferencesValidationError, DEFAULT_PLAYER_PREFERENCES } from '../src/player/preferences.js'
import { serializeFilmDetail, serializeFilmSummary, PlayerSerializationError } from '../src/player/serializers.js'
import { getPlayerMetricSnapshot, recordPlayerTelemetry, resetPlayerTelemetryForTest, PlayerTelemetryValidationError } from '../src/player/telemetry.js'
import { probeTracks } from '../src/player/media.js'
import { createPlayerFrontend } from '../src/player-frontend.js'

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

test('preference presets are canonical, deeply immutable, and structurally validated', () => {
  const matrix = {
    classic: ['visible', 'stacked', false], categories: ['visible', 'stacked', true],
    compound: ['minimized', 'stacked', true], combined: ['minimized', 'combined', true],
  } as const
  for (const [preset, expected] of Object.entries(matrix) as Array<[keyof typeof matrix, typeof matrix[keyof typeof matrix]]>) {
    const value = preferencesForPreset(preset)
    assert.deepEqual([value.navigation.edgeRail, value.home.widgetMode, value.home.showSpotlight], expected)
    assert.deepEqual(validatePlayerPreferences(value), value)
  }
  assert.ok(Object.isFrozen(DEFAULT_PLAYER_PREFERENCES.home.widgets))
  const invalid = structuredClone(preferencesForPreset('categories')) as any
  invalid.home.widgets[0].unknown = true
  assert.throws(() => validatePlayerPreferences(invalid), PlayerPreferencesValidationError)
})

test('cursor codec round-trips exact values and rejects malformed input', () => {
  const value = { sortValue: 'Alpha', id: 42 }
  assert.deepEqual(decodePlayerCursor(encodePlayerCursor(value)), value)
  assert.throws(() => decodePlayerCursor('***'), PlayerCursorError)
  assert.throws(() => decodePlayerCursor(Buffer.from('{"id":0}').toString('base64url')), PlayerCursorError)
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

test('media probe timing fires exactly once on failure', () => {
  const calls: Array<[string, number, string]> = []
  assert.equal(probeTracks('/definitely/missing/player-fixture.mkv', (operation, duration, outcome) => calls.push([operation, duration, outcome])), null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'probe')
  assert.equal(calls[0][2], 'error')
})

test('limited Player listener delegates only Player routes and times only static reads', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'archivist-player-static-'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Player fixture</title>')
  const app = express()
  app.get('/api/v1/player/fixture', req => req.res!.json({ authenticated: req.headers['x-api-key'] === 'private-test-token' }))
  const server = createPlayerFrontend(app, { distDir: dist, serviceToken: 'private-test-token' })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const staticResponse = await fetch(`${origin}/films`)
    assert.equal(staticResponse.status, 200)
    assert.match(staticResponse.headers.get('content-security-policy') ?? '', /style-src 'self'/)
    assert.match(staticResponse.headers.get('server-timing') ?? '', /^static;dur=\d+\.\d$/)
    assert.match(await staticResponse.text(), /Player fixture/)

    const delegated = await fetch(`${origin}/api/v1/player/fixture`)
    assert.deepEqual(await delegated.json(), { authenticated: true })
    assert.equal(delegated.headers.get('server-timing'), null)

    const blockedAdmin = await fetch(`${origin}/api/v1/system/overview`)
    assert.match(await blockedAdmin.text(), /Player fixture/)
    assert.equal(blockedAdmin.headers.get('content-type'), 'text/html; charset=utf-8')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dist, { recursive: true, force: true })
  }
})
