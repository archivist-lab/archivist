import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, readFirstSseEvent, type TestHarness } from './helpers.js'
import { enqueueJob, getJob, listJobs } from '../src/system/event-store.js'
import { registerJobHandler, runOnce } from '../src/system/job-runner.js'

let h: TestHarness

test('boot', async () => {
  h = await startTestApp()
})

after(async () => { await h?.close() })

test('GET /ping is public and returns 200', async () => {
  const res = await h.request('GET', '/ping')
  assert.equal(res.status, 200)
  assert.equal(res.json.status, 'ok')
})

test('GET /api/v1/health returns ok with version', async () => {
  const res = await h.request('GET', '/api/v1/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { status: 'ok', version: '2.0.0' })
})

test('SSE /api/v1/events emits system:ready', async () => {
  const { event, data } = await readFirstSseEvent(`${h.baseUrl}/api/v1/events`, h.authHeaders)
  assert.equal(event, 'system:ready')
  assert.ok(JSON.parse(data!).ready)
})

test('default libraries exist as tabs with legacy shape', async () => {
  const res = await h.request('GET', '/api/v1/tabs')
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 6)
  const films = res.json.find((t: any) => t.media_type === 'films')
  assert.ok(films)
  assert.equal(typeof films.id, 'number')
  assert.equal(typeof films.db_path, 'string')
  assert.equal(typeof films.created_at, 'string')
})

test('tab CRUD lifecycle preserves legacy contract', async () => {
  const created = await h.request('POST', '/api/v1/tabs', { body: { name: '4K Films', mediaType: 'films', dbPath: './data/films-4k.db' } })
  assert.equal(created.status, 201)
  assert.equal(created.json.name, '4K Films')

  const dup = await h.request('POST', '/api/v1/tabs', { body: { name: 'Dup', mediaType: 'films', dbPath: './data/films-4k.db' } })
  assert.equal(dup.status, 409)

  const renamed = await h.request('PUT', `/api/v1/tabs/${created.json.id}`, { body: { name: 'UHD Films' } })
  assert.equal(renamed.json.name, 'UHD Films')

  // New films library gets its own seeded quality profiles and edition rules
  const profiles = await h.request('GET', '/api/v1/quality-profiles', { headers: { 'x-tab-context': String(created.json.id) } })
  assert.equal(profiles.status, 200)
  assert.equal(profiles.json.length, 5)
  assert.ok(Array.isArray(profiles.json[0].items))

  const rules = await h.request('GET', '/api/v1/films/edition-rules/all', { headers: { 'x-tab-context': String(created.json.id) } })
  assert.equal(rules.status, 200)
  assert.equal(rules.json.length, 8)

  const deleted = await h.request('DELETE', `/api/v1/tabs/${created.json.id}?deleteFiles=true`)
  assert.equal(deleted.status, 204)

  const missing = await h.request('GET', '/api/v1/quality-profiles', { headers: { 'x-tab-context': String(created.json.id) } })
  assert.equal(missing.status, 404)
})

test('x-tab-context error semantics match legacy', async () => {
  const bad = await h.request('GET', '/api/v1/films', { headers: { 'x-tab-context': 'abc' } })
  assert.equal(bad.status, 400)

  const gone = await h.request('GET', '/api/v1/films', { headers: { 'x-tab-context': '99999' } })
  assert.equal(gone.status, 404)

  const none = await h.request('GET', '/api/v1/films')
  assert.equal(none.status, 400)
  assert.match(none.json.error, /Tab context required/)
})

test('root folders CRUD is library-scoped', async () => {
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  const headers = { 'x-tab-context': String(filmsTab.id) }

  const rejected = await h.request('POST', '/api/v1/root-folders', { body: { path: 'relative/path' }, headers })
  assert.equal(rejected.status, 400)

  const created = await h.request('POST', '/api/v1/root-folders', { body: { path: h.dir }, headers })
  assert.equal(created.status, 201)
  assert.equal(created.json.path, h.dir)
  assert.equal(created.json.accessible, true)

  const list = await h.request('GET', '/api/v1/root-folders', { headers })
  assert.equal(list.json.length, 1)

  // Different scope sees nothing
  const globalList = await h.request('GET', '/api/v1/root-folders')
  assert.equal(globalList.json.length, 0)

  const all = await h.request('GET', '/api/v1/tabs/root-folders')
  assert.equal(all.json.length, 1)
  assert.equal(all.json[0].tabId, filmsTab.id)

  const del = await h.request('DELETE', `/api/v1/root-folders/${created.json.id}`, { headers })
  assert.equal(del.status, 204)
})

test('settings roundtrip with scoped persistence', async () => {
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  const headers = { 'x-tab-context': String(filmsTab.id) }

  const naming = await h.request('GET', '/api/v1/settings/naming', { headers })
  assert.equal(naming.json.renameMovies, true)

  const updated = await h.request('PUT', '/api/v1/settings/naming', { body: { renameMovies: false }, headers })
  assert.equal(updated.json.renameMovies, false)

  const reread = await h.request('GET', '/api/v1/settings/naming', { headers })
  assert.equal(reread.json.renameMovies, false)

  // Global scope unaffected
  const globalNaming = await h.request('GET', '/api/v1/settings/naming')
  assert.equal(globalNaming.json.renameMovies, true)

  const tiers = await h.request('GET', '/api/v1/settings/quality-tiers', { headers })
  assert.ok(tiers.json.tier1.length > 0)

  const apiKeys = await h.request('GET', '/api/v1/settings/api-keys')
  assert.equal(apiKeys.status, 200)
  assert.ok('tmdbApiKey' in apiKeys.json)
})

test('system jobs runtime: enqueue, run, retry with backoff, cancel', async () => {
  let attempts = 0
  registerJobHandler('test.flaky', async () => {
    attempts++
    if (attempts < 2) throw new Error('boom')
  })

  const jobId = enqueueJob({ type: 'test.flaky', subjectType: 'test', subjectId: '1' })
  await runOnce()
  let job = getJob(jobId)!
  assert.equal(job.status, 'queued') // failed once, requeued with backoff
  assert.equal(job.lastError, 'boom')
  assert.equal(job.attempts, 1)

  // Force availability and run again
  const { getDb } = await import('../src/db.js')
  getDb().prepare('UPDATE system_jobs SET available_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), jobId)
  await runOnce()
  job = getJob(jobId)!
  assert.equal(job.status, 'succeeded')

  const list = await h.request('GET', '/api/v1/system/jobs?limit=10')
  assert.ok(list.json.jobs.length >= 1)

  const events = await h.request('GET', '/api/v1/system/events?limit=10')
  assert.ok(events.json.events.length >= 1)

  const id2 = enqueueJob({ type: 'test.flaky', availableAt: new Date(Date.now() + 60_000) })
  const cancel = await h.request('POST', `/api/v1/system/jobs/${id2}/cancel`)
  assert.equal(cancel.json.success, true)
  assert.equal(getJob(id2)!.status, 'cancelled')

  const retry = await h.request('POST', `/api/v1/system/jobs/${id2}/retry`)
  assert.equal(retry.json.success, true)
  assert.equal(getJob(id2)!.status, 'queued')
})

test('jobs survive process-restart simulation (rows persist in DB)', async () => {
  const jobId = enqueueJob({ type: 'test.persistent', payload: { hello: 'world' } })
  // Simulate a restart by opening a second connection to the same file
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const db2 = new BetterSqlite3(process.env.ARCHIVIST_DB!)
  const row = db2.prepare('SELECT type, status, payload FROM system_jobs WHERE id = ?').get(jobId) as any
  db2.close()
  assert.equal(row.type, 'test.persistent')
  assert.equal(row.status, 'queued')
  assert.deepEqual(JSON.parse(row.payload), { hello: 'world' })
})

test('download clients CRUD (scoped) and quality profile CRUD', async () => {
  const created = await h.request('POST', '/api/v1/download-clients', {
    body: { name: 'Test TX', type: 'transmission', host: 'localhost', port: 9091 },
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.name, 'Test TX')

  const list = await h.request('GET', '/api/v1/download-clients')
  assert.equal(list.json.length, 1)

  const updated = await h.request('PUT', `/api/v1/download-clients/${created.json.id}`, { body: { enabled: false } })
  assert.equal(updated.json.enabled, false)

  const del = await h.request('DELETE', `/api/v1/download-clients/${created.json.id}`)
  assert.equal(del.status, 204)

  const profile = await h.request('POST', '/api/v1/quality-profiles', { body: { name: 'Custom', items: ['WEB-DL-1080p'] } })
  assert.equal(profile.status, 201)
  assert.equal(profile.json.upgradeAllowed, true)
  const pDel = await h.request('DELETE', `/api/v1/quality-profiles/${profile.json.id}`)
  assert.equal(pDel.status, 204)
})
