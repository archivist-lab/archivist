import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { startTestApp, type TestHarness } from './helpers.js'
import { getDb } from '../src/db.js'
import { refreshList } from '../src/lists/engine.js'

let harness: TestHarness
let closeTmdb: () => Promise<void>
let filmLibraryId = 0
let listId = 0
let capturedDiscoverQuery: Record<string, unknown> = {}

const held = { id: 901, title: 'Held Horror', original_title: 'Held Horror', release_date: '1981-01-02', poster_path: null }
const dismissed = { id: 902, title: 'Dismissed Horror', original_title: 'Dismissed Horror', release_date: '1982-02-03', poster_path: null }
const approved = { id: 903, title: 'Approved Horror', original_title: 'Approved Horror', release_date: '1983-03-04', poster_path: null }
const departing = { id: 904, title: 'Departing Horror', original_title: 'Departing Horror', release_date: '1984-04-05', poster_path: null }
const nolanDirected = { id: 872585, title: 'Oppenheimer', original_title: 'Oppenheimer', release_date: '2023-07-19', poster_path: null }
const nolanProduced = { id: 49521, title: 'Man of Steel', original_title: 'Man of Steel', release_date: '2013-06-12', poster_path: null }
let discoverRows = [held, dismissed, approved, departing]

function movieDetails(row: typeof held) {
  return {
    ...row,
    imdb_id: `tt${row.id}`,
    original_language: 'en',
    overview: `${row.title} overview`,
    runtime: 95,
    genres: [{ id: 27, name: 'Horror' }],
    backdrop_path: null,
    vote_average: 7.1,
    popularity: 1,
    production_companies: [],
    production_countries: [{ iso_3166_1: 'US' }],
    release_dates: { results: [] },
    images: { logos: [], backdrops: [], posters: [] },
    credits: { cast: [], crew: [] },
    videos: { results: [] },
    alternative_titles: { titles: [] },
  }
}

before(async () => {
  const app = express()
  app.get('/discover/movie', (req, res) => {
    capturedDiscoverQuery = { ...req.query }
    res.json({ page: 1, total_pages: 1, total_results: discoverRows.length, results: discoverRows })
  })
  app.get('/search/person', (_req, res) => res.json({ results: [{ id: 31, name: 'Tom Hanks', known_for_department: 'Acting', profile_path: '/tom.jpg', known_for: [{ title: 'Cast Away' }] }] }))
  app.get('/search/company', (_req, res) => res.json({ results: [{ id: 4, name: 'Paramount Pictures', origin_country: 'US', logo_path: '/paramount.png' }] }))
  app.get('/search/movie', (_req, res) => res.json({ results: [approved] }))
  app.get('/person/:id/movie_credits', (req, res) => {
    if (Number(req.params.id) !== 525) return res.json({ cast: [], crew: [] })
    res.json({ cast: [], crew: [
      { ...nolanDirected, job: 'Director' },
      { ...nolanProduced, job: 'Executive Producer' },
    ] })
  })
  app.get('/person/:id', (req, res) => res.json({ id: Number(req.params.id), name: 'Tom Hanks', known_for_department: 'Acting', profile_path: '/tom.jpg' }))
  app.get('/company/:id', (req, res) => res.json({ id: Number(req.params.id), name: 'Paramount Pictures', origin_country: 'US', logo_path: '/paramount.png' }))
  app.get('/movie/:id', (req, res) => {
    const row = [held, dismissed, approved, departing].find(value => value.id === Number(req.params.id))
    if (!row) return res.status(404).json({ status_message: 'not found' })
    res.json(movieDetails(row))
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const tmdbUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  closeTmdb = () => new Promise<void>(resolve => server.close(() => resolve()))

  harness = await startTestApp({ env: { TMDB_BASE_URL: tmdbUrl, TMDB_API_KEY: 'lists-test-key' } })
  const tabs = await harness.request('GET', '/api/v1/tabs')
  filmLibraryId = tabs.json.find((tab: any) => tab.media_type === 'films').id
})

after(async () => {
  await harness?.close()
  await closeTmdb?.()
})

const filter = {
  op: 'and',
  nodes: [
    { op: 'genre', mode: 'includes', values: ['horror'] },
    { op: 'year', min: 1978, max: 1989 },
    { op: 'rating', source: 'provider', min: 6.5, minVotes: 100 },
    { op: 'runtime', max: 110 },
  ],
}

test('preview compiles semantic filters to a stable TMDB query and reports caps', async () => {
  const preview = await harness.request('POST', '/api/v1/lists/preview', {
    headers: { 'x-tab-context': String(filmLibraryId) },
    body: { mediaType: 'film', filter, memberCap: 2 },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.matchCount, 4)
  assert.equal(preview.json.sample.length, 2)
  assert.equal(preview.json.capped, true)
  assert.match(preview.json.warning, /member cap of 2/)
  assert.equal(capturedDiscoverQuery.sort_by, 'primary_release_date.asc')
  assert.equal(capturedDiscoverQuery.with_genres, '27')
  assert.equal(capturedDiscoverQuery['vote_average.gte'], '6.5')
  assert.equal(capturedDiscoverQuery['vote_count.gte'], '100')
  assert.equal(capturedDiscoverQuery['with_runtime.lte'], '110')
})

test('unsupported clauses are rejected rather than silently dropped', async () => {
  const preview = await harness.request('POST', '/api/v1/lists/preview', {
    headers: { 'x-tab-context': String(filmLibraryId) },
    body: { mediaType: 'film', filter: { op: 'not', node: { op: 'year', min: 2000 } } },
  })
  assert.equal(preview.status, 422)
  assert.match(preview.json.error, /cannot safely negate year/)
})

test('smart lookups resolve people, companies and specific titles with stable TMDB ids', async () => {
  const person = await harness.request('GET', '/api/v1/lists/lookup?kind=person&mediaType=film&q=Tom%20Hanks')
  assert.equal(person.status, 200)
  assert.deepEqual(person.json.results[0], { id: 31, label: 'Tom Hanks', subtitle: 'Acting · Cast Away', imagePath: '/tom.jpg' })

  const company = await harness.request('GET', '/api/v1/lists/lookup?kind=company&mediaType=film&q=4')
  assert.equal(company.status, 200)
  assert.equal(company.json.results[0].label, 'Paramount Pictures')

  const title = await harness.request('GET', '/api/v1/lists/lookup?kind=title&mediaType=film&q=Approved')
  assert.equal(title.status, 200)
  assert.equal(title.json.results[0].id, approved.id)
})

test('specific title filters resolve exact titles and retain display labels', async () => {
  const titleFilter = { op: 'title', mode: 'includes', ids: [approved.id], labels: { [approved.id]: approved.title } }
  const preview = await harness.request('POST', '/api/v1/lists/preview', {
    headers: { 'x-tab-context': String(filmLibraryId) },
    body: { mediaType: 'film', filter: titleFilter, memberCap: 10 },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.matchCount, 1)
  assert.equal(preview.json.sample[0].tmdbId, approved.id)
})

test('director filters exclude titles where the person only has a producing credit', async () => {
  const previousRows = discoverRows
  discoverRows = [nolanDirected, nolanProduced]
  getDb().prepare('DELETE FROM list_query_cache').run()
  try {
    const preview = await harness.request('POST', '/api/v1/lists/preview', {
      headers: { 'x-tab-context': String(filmLibraryId) },
      body: { mediaType: 'film', filter: { op: 'person', role: 'director', ids: [525], labels: { 525: 'Christopher Nolan' } }, memberCap: 20 },
    })
    assert.equal(preview.status, 200)
    assert.equal(capturedDiscoverQuery.with_crew, '525')
    assert.equal(preview.json.matchCount, 1)
    assert.deepEqual(preview.json.sample.map((item: any) => item.title), ['Oppenheimer'])
  } finally {
    discoverRows = previousRows
    getDb().prepare('DELETE FROM list_query_cache').run()
  }
})

test('saved List persists a provider-neutral AST and rejects unguarded auto-add', async () => {
  const created = await harness.request('POST', '/api/v1/lists', {
    headers: { 'x-tab-context': String(filmLibraryId) },
    body: { name: 'Eighties Horror', mediaType: 'film', filter, memberCap: 500 },
  })
  assert.equal(created.status, 201)
  listId = created.json.list.id
  const stored = getDb().prepare('SELECT filter, mode FROM lists WHERE id = ?').get(listId) as { filter: string; mode: string }
  assert.equal(stored.mode, 'approval')
  assert.equal(stored.filter.includes('with_genres'), false)
  assert.deepEqual(JSON.parse(stored.filter), filter)

  const auto = await harness.request('POST', '/api/v1/lists', {
    headers: { 'x-tab-context': String(filmLibraryId) },
    body: { name: 'Unsafe Auto List', mediaType: 'film', filter, mode: 'auto' },
  })
  assert.equal(auto.status, 409)
  assert.match(auto.json.error, /approval-first/)
})

test('first reconciliation suppresses held items and queues only missing members', async () => {
  getDb().prepare("INSERT INTO films (library_id, tmdb_id, title, status) VALUES (?, ?, ?, 'collected')")
    .run(filmLibraryId, held.id, held.title)
  getDb().prepare('DELETE FROM list_query_cache').run()

  const result = await refreshList(listId)
  assert.equal(result.fetched, 4)
  assert.equal(result.inLibrary, 1)
  assert.equal(result.newItems, 3)

  const statuses = getDb().prepare('SELECT tmdb_id, status FROM list_items WHERE list_id = ? ORDER BY tmdb_id').all(listId) as Array<{ tmdb_id: number; status: string }>
  assert.deepEqual(statuses, [
    { tmdb_id: 901, status: 'in_library' },
    { tmdb_id: 902, status: 'new' },
    { tmdb_id: 903, status: 'new' },
    { tmdb_id: 904, status: 'new' },
  ])
  const pending = await harness.request('GET', '/api/v1/lists/pending-count')
  assert.equal(pending.json.count, 3)
  const events = getDb().prepare("SELECT COUNT(*) AS count FROM system_events WHERE category = 'lists' AND action = 'new-items'").get() as { count: number }
  assert.equal(events.count, 1)
})

test('approval and dismissal share durable membership and departure history', async () => {
  const rows = getDb().prepare('SELECT id, tmdb_id FROM list_items WHERE list_id = ?').all(listId) as Array<{ id: number; tmdb_id: number }>
  const itemId = (tmdbId: number) => rows.find(row => row.tmdb_id === tmdbId)!.id

  const dismissedResponse = await harness.request('POST', `/api/v1/lists/${listId}/items/${itemId(902)}/dismiss`, {
    headers: { 'x-tab-context': String(filmLibraryId) },
  })
  assert.equal(dismissedResponse.status, 200)
  assert.equal(dismissedResponse.json.item.status, 'dismissed')

  const addedResponse = await harness.request('POST', `/api/v1/lists/${listId}/items/${itemId(903)}/add`, {
    headers: { 'x-tab-context': String(filmLibraryId) },
  })
  assert.equal(addedResponse.status, 200)
  assert.equal(addedResponse.json.item.status, 'added')
  const film = getDb().prepare('SELECT status, monitored FROM films WHERE library_id = ? AND tmdb_id = ?').get(filmLibraryId, 903) as { status: string; monitored: number }
  assert.deepEqual(film, { status: 'missing', monitored: 1 })

  discoverRows = [held]
  getDb().prepare('DELETE FROM list_query_cache').run()
  const result = await refreshList(listId)
  assert.equal(result.departed, 1)
  const statuses = getDb().prepare('SELECT tmdb_id, status FROM list_items WHERE list_id = ? ORDER BY tmdb_id').all(listId) as Array<{ tmdb_id: number; status: string }>
  assert.deepEqual(statuses, [
    { tmdb_id: 901, status: 'in_library' },
    { tmdb_id: 902, status: 'dismissed' },
    { tmdb_id: 903, status: 'added' },
    { tmdb_id: 904, status: 'departed' },
  ])
  const runs = await harness.request('GET', `/api/v1/lists/${listId}/runs`, { headers: { 'x-tab-context': String(filmLibraryId) } })
  assert.equal(runs.status, 200)
  assert.equal(runs.json.runs.length, 2)
  assert.equal(runs.json.runs.every((run: any) => run.finished_at && run.error == null), true)
})
