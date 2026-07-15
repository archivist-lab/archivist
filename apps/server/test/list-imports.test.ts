import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { startTestApp, type TestHarness } from './helpers.js'
import { getDb } from '../src/db.js'
import { ARR_AUTODETECT_TARGETS, detectArrInstances, mdblistApiUrl, traktApiUrl } from '../src/list-imports/routes.js'

let harness: TestHarness
let sourceBaseUrl = ''
let closeSource: () => Promise<void>

test('boot list import test servers', async () => {
  const app = express()
  app.get('/api/v3/movie', (req, res) => {
    if (req.header('x-api-key') !== 'radarr-secret') return res.status(401).json({ error: 'bad key' })
    res.json([
      { title: 'The Matrix', year: 1999, tmdbId: 603, imdbId: 'tt0133093', monitored: true },
      { title: 'The Matrix', year: 1999, tmdbId: 603, imdbId: 'tt0133093', monitored: true },
      { title: 'Alien', year: 1979, tmdbId: 348, imdbId: 'tt0078748', monitored: false },
    ])
  })
  app.get('/api/v3/series', (req, res) => {
    if (req.header('x-api-key') !== 'sonarr-secret') return res.status(401).json({ error: 'bad key' })
    res.json([
      { title: 'Severance', year: 2022, tvdbId: 371980, tmdbId: 95396, imdbId: 'tt11280740', monitored: true },
    ])
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  sourceBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  closeSource = () => new Promise<void>(resolve => server.close(() => resolve()))
  harness = await startTestApp()
})

after(async () => {
  await harness?.close()
  await closeSource?.()
})

test('Radarr source is saved with a redacted credential and previews deduplicated films', async () => {
  const tabs = await harness.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((tab: any) => tab.media_type === 'films')
  getDb().prepare('INSERT INTO films (library_id, tmdb_id, title) VALUES (?, ?, ?)').run(filmsTab.id, 603, 'The Matrix')

  const saved = await harness.request('POST', '/api/v1/list-imports/sources', {
    body: { name: 'Existing Radarr', type: 'radarr', url: sourceBaseUrl, credential: 'radarr-secret' },
  })
  assert.equal(saved.status, 201)
  assert.equal(saved.json.source.credentialSet, true)
  assert.equal('credential' in saved.json.source, false)

  const listed = await harness.request('GET', '/api/v1/list-imports/sources')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.sources.length, 1)
  assert.equal(JSON.stringify(listed.json).includes('radarr-secret'), false)

  const preview = await harness.request('POST', `/api/v1/list-imports/sources/${saved.json.source.id}/preview`, {
    body: { filmLibraryId: filmsTab.id },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.total, 2)
  assert.equal(preview.json.items[0].mediaType, 'films')
  assert.equal(preview.json.items[0].alreadyAdded, true)
  assert.equal(preview.json.items[1].alreadyAdded, false)
  assert.equal(preview.json.items[1].tmdbId, 348)
})

test('Sonarr source previews TVDB/TMDB identifiers as importable series', async () => {
  const tabs = await harness.request('GET', '/api/v1/tabs')
  const seriesTab = tabs.json.find((tab: any) => tab.media_type === 'series')
  const saved = await harness.request('POST', '/api/v1/list-imports/sources', {
    body: { name: 'Current Sonarr', type: 'sonarr', url: `${sourceBaseUrl}/`, credential: 'sonarr-secret' },
  })
  assert.equal(saved.status, 201)

  const preview = await harness.request('POST', `/api/v1/list-imports/sources/${saved.json.source.id}/preview`, {
    body: { seriesLibraryId: seriesTab.id },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.total, 1)
  assert.deepEqual(
    { mediaType: preview.json.items[0].mediaType, tvdbId: preview.json.items[0].tvdbId, tmdbId: preview.json.items[0].tmdbId, importable: preview.json.items[0].importable },
    { mediaType: 'series', tvdbId: 371980, tmdbId: 95396, importable: true },
  )
})

test('MDBList website filter URLs are rejected when saving a source', async () => {
  const saved = await harness.request('POST', '/api/v1/list-imports/sources', {
    body: { name: 'HBO shows', type: 'mdblist', url: 'https://mdblist.com/shows/?q_network=HBO&q_region=US', credential: 'mdb-secret' },
  })

  assert.equal(saved.status, 400)
  assert.match(saved.json.error, /saved MDBList list URL/)
})

test('autodetect probes only the two fixed Docker addresses', async () => {
  assert.deepEqual(
    ARR_AUTODETECT_TARGETS.map(target => ({ type: target.type, url: target.url })),
    [
      { type: 'radarr', url: 'http://radarr:7878' },
      { type: 'sonarr', url: 'http://sonarr:8989' },
    ],
  )

  const probed: string[] = []
  const results = await detectArrInstances(async target => {
    probed.push(`${target.url}/ping`)
    return target.type === 'radarr' ? 200 : null
  })
  assert.deepEqual(probed.sort(), ['http://radarr:7878/ping', 'http://sonarr:8989/ping'])
  assert.equal(results.find(result => result.type === 'radarr')?.detected, true)
  assert.equal(results.find(result => result.type === 'sonarr')?.detected, false)
})

test('Trakt and MDBList URLs are converted to their supported API endpoints', () => {
  const trakt = traktApiUrl('https://trakt.tv/users/demo/lists/weekend')
  assert.equal(trakt.toString(), 'https://api.trakt.tv/users/demo/lists/weekend/items')

  const mdblist = mdblistApiUrl('https://mdblist.com/lists/demo/top-films?limit=50', 'mdb-secret')
  assert.equal(mdblist.origin, 'https://api.mdblist.com')
  assert.equal(mdblist.pathname, '/lists/demo/top-films/items')
  assert.equal(mdblist.searchParams.get('limit'), '50')
  assert.equal(mdblist.searchParams.get('apikey'), 'mdb-secret')

  assert.throws(() => mdblistApiUrl('https://mdblist.com/shows/?q_network=HBO&q_region=US', 'mdb-secret'), /saved MDBList list URL/)
})

