import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openUnifiedDb, closeAllDatabases } from '@archivist/db'
import { signalJobQueued, watchJobQueue } from '../src/system/job-signal.js'
import { initDb } from '../src/db.js'
import { enqueueJob, getJob } from '../src/system/event-store.js'
import { registerJobHandler, startJobRunner, stopJobRunner, jobRunnerStatus } from '../src/system/job-runner.js'

/**
 * The worker is a different process from the API, and SQLite has no
 * notification channel — so an enqueued job used to wait for the runner's next
 * poll. These cover the wake that removes that wait, and the lane split that
 * keeps hours-long scans off the path of work a user is waiting on.
 *
 * Timings assert well under the 1000ms poll backstop rather than at the real
 * latency (tens of ms), so a slow machine cannot make them flaky while a broken
 * wake still fails them.
 */

const dir = mkdtempSync(join(tmpdir(), 'archivist-wake-'))
const POLL_BACKSTOP_MS = 1000

after(() => {
  closeAllDatabases()
  rmSync(dir, { recursive: true, force: true })
})

test('signalling creates the sentinel beside the database', () => {
  const db = openUnifiedDb(join(dir, 'sentinel', 'archivist.sqlite'))
  signalJobQueued(db)
  assert.ok(existsSync(join(dir, 'sentinel', 'job-wake')), 'the sentinel sits next to the db file')
})

test('a watcher is woken by a signal from another connection', async () => {
  const path = join(dir, 'watched', 'archivist.sqlite')
  const watching = openUnifiedDb(path)
  // A second connection to the same file — what the other process holds.
  const other = new Database(path)

  const woken = new Promise<void>(resolve => {
    const stop = watchJobQueue(watching, () => { stop(); resolve() })
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  signalJobQueued(other)

  await Promise.race([
    woken,
    new Promise((_, reject) => setTimeout(() => reject(new Error('watcher was never woken')), 3000)),
  ])
  other.close()
})

test('an in-memory database has nowhere to signal, and does not throw', () => {
  const memory = new Database(':memory:')
  assert.doesNotThrow(() => signalJobQueued(memory))
  assert.equal(watchJobQueue(memory, () => {})(), undefined, 'the stop function is a safe no-op')
  memory.close()
})

test('an enqueued job starts without waiting for the poll', async () => {
  initDb(join(dir, 'runner', 'archivist.sqlite'))
  let ran = 0
  registerJobHandler('wake-probe', async () => { ran += 1 }, { lane: 'searches' })
  registerJobHandler('wake-scan', async () => { await new Promise(r => setTimeout(r, 600)) }, { lane: 'scans' })
  registerJobHandler('wake-maintenance', async () => {}, { lane: 'maintenance' })
  startJobRunner()
  // Let the initial pump settle so we measure a wake, not the startup pump.
  await new Promise(resolve => setTimeout(resolve, 150))

  const settled = async (id: number, budgetMs: number) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs) {
      if (getJob(id)?.status === 'succeeded') return Date.now() - startedAt
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return null
  }

  const took = await settled(enqueueJob({ type: 'wake-probe' }), 5000)
  assert.ok(took !== null, 'the job ran')
  assert.ok(took < POLL_BACKSTOP_MS, `expected a wake, not a poll — took ${took}ms`)
  assert.equal(ran, 1)
})

test('a long scan no longer blocks quick maintenance work', async () => {
  const scan = enqueueJob({ type: 'wake-scan' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(getJob(scan)?.status, 'running', 'the scan is occupying its lane')

  const startedAt = Date.now()
  const maintenance = enqueueJob({ type: 'wake-maintenance' })
  while (Date.now() - startedAt < 3000) {
    if (getJob(maintenance)?.status === 'succeeded') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const took = Date.now() - startedAt
  assert.equal(getJob(maintenance)?.status, 'succeeded')
  assert.ok(took < 400, `maintenance waited ${took}ms — it should not queue behind a scan`)
  await stopJobRunner(2000)
})

test('the scans lane carries the sweeps that used to hold up maintenance', async () => {
  const { registerMediaProcessingJobs } = await import('../src/services/media-processing-jobs.js')
  const { registerBackupJobs } = await import('../src/system/backups.js')
  const { registerIntegrityJobs } = await import('../src/system/data-integrity.js')
  registerMediaProcessingJobs()
  registerBackupJobs()
  registerIntegrityJobs()

  const lanes = new Map(jobRunnerStatus().lanes.map(lane => [lane.lane, lane]))
  const scans = lanes.get('scans')
  assert.ok(scans, 'the scans lane exists')
  for (const type of ['video-library-scan', 'system-backup', 'integrity-scan']) {
    assert.ok(scans.types.includes(type), `${type} belongs in scans, not maintenance`)
  }
  assert.equal(scans.concurrency, 1, 'scans are disk-bound and stay serial')
  assert.ok((lanes.get('maintenance')?.concurrency ?? 0) > 1, 'maintenance is quick work and can overlap')
})
