import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness
let headers: Record<string, string>
let otherHeaders: Record<string, string>

test('boot quality harness', async () => {
  h = await startTestApp()
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  headers = { 'x-tab-context': String(filmsTab.id) }
  const other = await h.request('POST', '/api/v1/tabs', { body: { name: 'Kids Films', mediaType: 'films', dbPath: './data/kids-films.db' } })
  otherHeaders = { 'x-tab-context': String(other.json.id) }
})

after(async () => { await h?.close() })

test('quality profile CRUD persists upgrade/cutoff/min score semantics', async () => {
  const created = await h.request('POST', '/api/v1/quality-profiles', {
    headers,
    body: { name: 'Strict 1080p', cutoff: 'WEB-DL-1080p', items: ['WEB-DL-1080p'], upgradeAllowed: false, minFormatScore: 25 },
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.name, 'Strict 1080p')
  assert.equal(created.json.upgradeAllowed, false)
  assert.equal(created.json.cutoff, 'WEB-DL-1080p')
  assert.equal(created.json.minFormatScore, 25)

  const updated = await h.request('PUT', `/api/v1/quality-profiles/${created.json.id}`, {
    headers,
    body: { upgradeAllowed: true, cutoff: 'BluRay-1080p', minFormatScore: 50 },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.upgradeAllowed, true)
  assert.equal(updated.json.cutoff, 'BluRay-1080p')
  assert.equal(updated.json.minFormatScore, 50)

  const list = await h.request('GET', '/api/v1/quality-profiles', { headers })
  assert.ok(list.json.some((p: any) => p.id === created.json.id && p.minFormatScore === 50))

  const del = await h.request('DELETE', `/api/v1/quality-profiles/${created.json.id}`, { headers })
  assert.equal(del.status, 204)
})

test('quality definitions CRUD enforces size gates and library scope', async () => {
  const invalid = await h.request('POST', '/api/v1/quality-definitions', {
    headers,
    body: { title: 'Broken', minSize: 10, maxSize: 5 },
  })
  assert.equal(invalid.status, 400)

  const created = await h.request('POST', '/api/v1/quality-definitions', {
    headers,
    body: { title: 'WEB-DL-1080p', weight: 100, minSize: 1.2, maxSize: 12.5 },
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.title, 'WEB-DL-1080p')
  assert.equal(created.json.min_size, 1.2)
  assert.equal(created.json.max_size, 12.5)
  assert.equal(created.json.minSize, 1.2)
  assert.equal(created.json.maxSize, 12.5)

  const duplicateOtherScope = await h.request('POST', '/api/v1/quality-definitions', {
    headers: otherHeaders,
    body: { title: 'WEB-DL-1080p', weight: 100, minSize: 2, maxSize: 20 },
  })
  assert.equal(duplicateOtherScope.status, 201)

  const duplicateSameScope = await h.request('POST', '/api/v1/quality-definitions', {
    headers,
    body: { title: 'WEB-DL-1080p', weight: 100 },
  })
  assert.equal(duplicateSameScope.status, 409)

  const scopedList = await h.request('GET', '/api/v1/quality-definitions', { headers })
  assert.equal(scopedList.json.length, 1)
  assert.equal(scopedList.json[0].id, created.json.id)

  const badUpdate = await h.request('PUT', `/api/v1/quality-definitions/${created.json.id}`, {
    headers,
    body: { minSize: 30, maxSize: 20 },
  })
  assert.equal(badUpdate.status, 400)

  const updated = await h.request('PUT', `/api/v1/quality-definitions/${created.json.id}`, {
    headers,
    body: { title: 'WEB-DL-1080p Custom', weight: 110, minSize: 1.5, maxSize: 13 },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.title, 'WEB-DL-1080p Custom')
  assert.equal(updated.json.weight, 110)
  assert.equal(updated.json.minSize, 1.5)
  assert.equal(updated.json.maxSize, 13)

  const del = await h.request('DELETE', `/api/v1/quality-definitions/${created.json.id}`, { headers })
  assert.equal(del.status, 204)

  const empty = await h.request('GET', '/api/v1/quality-definitions', { headers })
  assert.equal(empty.json.length, 0)
})
