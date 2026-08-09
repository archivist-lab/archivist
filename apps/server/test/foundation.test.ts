import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, readFirstSseEvent, type TestHarness } from './helpers.js'
import { cancelJob, claimJob, claimNextJob, completeJob, enqueueJob, enqueueUniqueJob, getJob, heartbeatJob, recoverExpiredJobs, recoverInterruptedJobs } from '../src/system/event-store.js'
import { pumpJobs, registerJobHandler, runOnce } from '../src/system/job-runner.js'
import { getDb as currentDb } from '../src/db.js'
import { acquireRuntimeLease, listRuntimeProcesses, registerRuntimeProcess, releaseRuntimeLease } from '../src/system/process-registry.js'

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
  assert.equal(res.json.version, '2.0.0')
  assert.equal(res.json.status, 'degraded')
  assert.equal(res.json.workerHealthy, false)
})

test('health becomes ready only for a ready worker heartbeat', async () => {
  const starting = registerRuntimeProcess('worker', { state: 'starting' })
  let response = await h.request('GET', '/api/v1/health')
  assert.equal(response.json.status, 'degraded')
  starting.stop()

  const ready = registerRuntimeProcess('worker', { state: 'ready' })
  response = await h.request('GET', '/api/v1/health')
  assert.equal(response.json.status, 'ok')
  assert.equal(response.json.workerHealthy, true)
  ready.stop()
})

test('SSE /api/v1/events emits system:ready', async () => {
  const { event, data } = await readFirstSseEvent(`${h.baseUrl}/api/v1/events`, h.authHeaders)
  assert.equal(event, 'system:ready')
  assert.ok(JSON.parse(data!).ready)
})

test('SSE relays durable events written by the worker process', async () => {
  const controller = new AbortController()
  const response = await fetch(`${h.baseUrl}/api/v1/events`, { headers: h.authHeaders, signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const waitFor = async (eventName: string): Promise<string> => {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const frameEnd = buffer.indexOf('\n\n')
      if (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        if (frame.includes(`event: ${eventName}`)) return frame
        continue
      }
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
    }
    throw new Error(`Timed out waiting for SSE event ${eventName}`)
  }
  try {
    await waitFor('system:ready')
    currentDb().prepare(`
      INSERT INTO system_events(category,action,severity,message,data)
      VALUES('system','worker-test','info','worker relay fixture','{"worker":true}')
    `).run()
    const frame = await waitFor('system:worker-test')
    assert.match(frame, /worker relay fixture/)
    assert.match(frame, /"worker":true/)
  } finally {
    controller.abort()
    await reader.cancel().catch(() => undefined)
  }
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
  assert.ok('nextCursor' in list.json)

  const summary = await h.request('GET', '/api/v1/system/jobs/summary')
  assert.equal(summary.status, 200)
  assert.ok(Array.isArray(summary.json.runner.lanes))
  assert.ok(Array.isArray(summary.json.queues))

  const invalidStatus = await h.request('GET', '/api/v1/system/jobs?status=wat')
  assert.equal(invalidStatus.status, 400)

  const events = await h.request('GET', '/api/v1/system/events?limit=10')
  assert.ok(events.json.events.length >= 1)

  const id2 = enqueueJob({ type: 'test.flaky', availableAt: new Date(Date.now() + 60_000) })
  const cancel = await h.request('POST', `/api/v1/system/jobs/${id2}/cancel`)
  assert.equal(cancel.json.success, true)
  assert.equal(getJob(id2)!.status, 'cancelled')
  getDb().prepare("UPDATE system_jobs SET attempts=3,last_error='terminal failure' WHERE id=?").run(id2)

  const retry = await h.request('POST', `/api/v1/system/jobs/${id2}/retry`)
  assert.equal(retry.json.success, true)
  assert.equal(getJob(id2)!.status, 'queued')
  assert.equal(getJob(id2)!.attempts, 0)
  assert.equal(getJob(id2)!.lastError, null)
  cancelJob(id2)

  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  registerJobHandler('test.cancellable', async (_job, signal) => {
    notifyStarted()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const cancellableId = enqueueJob({ type: 'test.cancellable' })
  const execution = runOnce()
  await started
  const cancelled = await h.request('POST', `/api/v1/system/jobs/${cancellableId}/cancel`)
  assert.equal(cancelled.json.success, true)
  await execution
  assert.equal(getJob(cancellableId)!.status, 'cancelled')
})

test('system job claims require registered types and recover interrupted rows', () => {
  const unhandledId = enqueueJob({ type: 'test.no-handler' })
  assert.equal(claimNextJob([]), null)
  assert.equal(getJob(unhandledId)!.status, 'queued')

  const uniqueId = enqueueUniqueJob({ type: 'test.unique', subjectType: 'film', subjectId: '44' })
  assert.ok(uniqueId)
  assert.equal(enqueueUniqueJob({ type: 'test.unique', subjectType: 'film', subjectId: '44' }), null)
  assert.equal(claimJob(uniqueId!)?.status, 'running')
  assert.equal(claimJob(uniqueId!), null, 'a known job can only be claimed once')

  currentDb().prepare("UPDATE system_jobs SET status='running', locked_at=datetime('now') WHERE id=?").run(unhandledId)
  assert.ok(recoverInterruptedJobs() >= 1)
  assert.equal(getJob(unhandledId)!.status, 'queued')
  cancelJob(unhandledId)
  cancelJob(uniqueId!)
})

test('system job leases enforce ownership and recover only expired work', () => {
  const ownedId = enqueueJob({ type: 'test.owned' })
  const owned = claimNextJob(['test.owned'], currentDb(), 'worker-a')
  assert.equal(owned?.id, ownedId)
  assert.equal(owned?.leaseOwner, 'worker-a')
  assert.equal(heartbeatJob(ownedId, currentDb(), 'worker-b'), false)
  assert.equal(completeJob(ownedId, currentDb(), 'worker-b'), false)
  assert.equal(completeJob(ownedId, currentDb(), 'worker-a'), true)

  const freshId = enqueueJob({ type: 'test.recovery' })
  const staleId = enqueueJob({ type: 'test.recovery' })
  claimJob(freshId, currentDb(), 'worker-fresh')
  claimJob(staleId, currentDb(), 'worker-stale')
  currentDb().prepare("UPDATE system_jobs SET locked_at=datetime('now','-10 minutes') WHERE id=?").run(staleId)
  assert.equal(recoverExpiredJobs(60_000), 1)
  assert.equal(getJob(freshId)?.status, 'running')
  assert.equal(getJob(staleId)?.status, 'queued')
  cancelJob(freshId)
  cancelJob(staleId)
})

test('runtime process heartbeats and exclusive worker leases are durable', () => {
  const first = registerRuntimeProcess('worker', { test: true })
  const second = registerRuntimeProcess('worker', { test: true })
  assert.ok(listRuntimeProcesses().some(process => process.instanceId === first.instanceId && process.healthy))
  assert.equal(acquireRuntimeLease('test-worker', first.instanceId), true)
  assert.equal(acquireRuntimeLease('test-worker', second.instanceId), false)
  releaseRuntimeLease('test-worker', first.instanceId)
  assert.equal(acquireRuntimeLease('test-worker', second.instanceId), true)
  releaseRuntimeLease('test-worker', second.instanceId)
  first.stop()
  second.stop()
})

test('independent job lanes execute without blocking each other', async () => {
  const started = new Set<string>()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let bothStarted!: () => void
  const ready = new Promise<void>(resolve => { bothStarted = resolve })
  const handler = (name: string) => async () => {
    started.add(name)
    if (started.size === 2) bothStarted()
    await blocked
  }

  registerJobHandler('test.lane.import', handler('import'), { lane: 'imports' })
  registerJobHandler('test.lane.metadata', handler('metadata'), { lane: 'metadata' })
  const importId = enqueueJob({ type: 'test.lane.import' })
  const metadataId = enqueueJob({ type: 'test.lane.metadata' })

  pumpJobs()
  await Promise.race([
    ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Job lanes did not start concurrently')), 1000)),
  ])
  assert.deepEqual([...started].sort(), ['import', 'metadata'])
  release()

  for (let i = 0; i < 20 && (getJob(importId)!.status === 'running' || getJob(metadataId)!.status === 'running'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(getJob(importId)!.status, 'succeeded')
  assert.equal(getJob(metadataId)!.status, 'succeeded')
})

test('job deadlines abort cooperative handlers and schedule retry', async () => {
  registerJobHandler('test.deadline', async (_job, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }, { lane: 'default', timeoutMs: 10 })
  const jobId = enqueueJob({ type: 'test.deadline', maxAttempts: 2 })
  await runOnce()
  const job = getJob(jobId)!
  assert.equal(job.status, 'queued')
  assert.match(job.lastError ?? '', /execution deadline/)
  cancelJob(jobId)
})

test('higher-priority jobs are claimed before older low-priority work', async () => {
  registerJobHandler('test.priority', async () => {})
  const lowId = enqueueJob({ type: 'test.priority', priority: 10 })
  const highId = enqueueJob({ type: 'test.priority', priority: 100 })
  await runOnce()
  assert.equal(getJob(highId)!.status, 'succeeded')
  assert.equal(getJob(highId)!.priority, 100)
  assert.equal(getJob(lowId)!.status, 'queued')
  cancelJob(lowId)
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
