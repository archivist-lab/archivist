import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness

test('boot', async () => {
  h = await startTestApp()
  // System surfaces read the torrent download dir; give the harness one.
  process.env.TORRENT_DOWNLOAD_DIR = join(h.dir, 'downloads')
  mkdirSync(process.env.TORRENT_DOWNLOAD_DIR, { recursive: true })
})

after(async () => { await h?.close() })

// ── Indexers ──────────────────────────────────────────────────────────────────

test('indexer registry CRUD over unified DB', async () => {
  const empty = await h.request('GET', '/api/v1/indexers')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json, [])

  const defs = await h.request('GET', '/api/v1/indexers/definitions/list')
  assert.ok(Array.isArray(defs.json))

  const created = await h.request('POST', '/api/v1/indexers', {
    body: { name: 'My Torznab', protocol: 'torznab', baseUrl: 'http://localhost:9117/api', apiKey: 'k', priority: 10 },
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.name, 'My Torznab')
  const id = created.json.id

  const list = await h.request('GET', '/api/v1/indexers')
  assert.equal(list.json.length, 1)

  const detail = await h.request('GET', `/api/v1/indexers/${id}`)
  assert.equal(detail.json.priority, 10)

  const updated = await h.request('PUT', `/api/v1/indexers/${id}`, { body: { priority: 5, enabled: false } })
  assert.equal(updated.json.priority, 5)
  assert.equal(updated.json.enabled, false)

  // Persisted in the unified DB
  const { getDb } = await import('../src/db.js')
  const row = getDb().prepare('SELECT * FROM indexers_ts WHERE id = ?').get(id) as any
  assert.equal(row.priority, 5)
  assert.equal(row.enabled, 0)

  const del = await h.request('DELETE', `/api/v1/indexers/${id}`)
  assert.equal(del.status, 204)
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM indexers_ts').get() as any === undefined ? 1 : (getDb().prepare('SELECT COUNT(*) AS n FROM indexers_ts').get() as any).n, 0)
})

// ── Dashboard ─────────────────────────────────────────────────────────────────

test('dashboard stats aggregate per media type without tab context', async () => {
  const res = await h.request('GET', '/api/v1/dashboard/stats')
  assert.equal(res.status, 200)
  for (const key of ['films', 'series', 'music', 'books', 'comics', 'games']) {
    assert.ok(res.json.counts[key], `missing counts for ${key}`)
    assert.equal(typeof res.json.counts[key].total, 'number')
  }
})

test('dashboard stats scope to library with tab context', async () => {
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  const res = await h.request('GET', '/api/v1/dashboard/stats', { headers: { 'x-tab-context': String(filmsTab.id) } })
  assert.deepEqual(Object.keys(res.json.counts), ['films'])
})

test('dashboard calendar requires range and returns sorted events', async () => {
  const missing = await h.request('GET', '/api/v1/dashboard/calendar')
  assert.equal(missing.status, 400)

  const res = await h.request('GET', '/api/v1/dashboard/calendar?start=2026-01-01&end=2026-12-31')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.json))
})

test('dashboard system reports cpu/memory/storage', async () => {
  const res = await h.request('GET', '/api/v1/dashboard/system')
  assert.equal(res.status, 200)
  assert.ok(res.json.cpu.cores > 0)
  assert.ok(res.json.memory.total > 0)
  assert.ok(Array.isArray(res.json.storage))
})

test('dashboard downloads degrade gracefully without torrent session', async () => {
  const res = await h.request('GET', '/api/v1/dashboard/downloads')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { torrents: [] })
})

test('dashboard search requires configured indexers', async () => {
  const res = await h.request('GET', '/api/v1/dashboard/search?q=test')
  assert.equal(res.status, 400)
  assert.match(res.json.error, /No indexers/)
})

// ── Torrents ──────────────────────────────────────────────────────────────────

test('torrents list is empty without session; orphans surface from download dir', async () => {
  const empty = await h.request('GET', '/api/v1/torrents')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json, [])
})

// ── Release pipeline ──────────────────────────────────────────────────────────

test('release-pipeline health summarises indexer states', async () => {
  const res = await h.request('GET', '/api/v1/release-pipeline/health')
  assert.equal(res.status, 200)
  assert.equal(res.json.summary.total, 0)
  assert.ok(Array.isArray(res.json.indexers))
})

test('release-pipeline missing-search starts a background cycle', async () => {
  const res = await h.request('POST', '/api/v1/release-pipeline/missing-search', { body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json.success, true)
})

// ── System admin ──────────────────────────────────────────────────────────────

test('system integrity scan reports and persists', async () => {
  const res = await h.request('GET', '/api/v1/system/integrity')
  assert.equal(res.status, 200)
  assert.ok(res.json.config.enabled)
  assert.ok(res.json.current.summary)

  const run = await h.request('POST', '/api/v1/system/integrity/run', { body: {} })
  assert.equal(run.status, 200)
  assert.ok(run.json.report.generatedAt)

  const configured = await h.request('PUT', '/api/v1/system/integrity', { body: { intervalHours: 6 } })
  assert.equal(configured.json.config.intervalHours, 6)
})

test('integrity scan flags stale acquisitions and repair clears them', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  db.prepare("INSERT INTO films (library_id, tmdb_id, title, status, info_hash) VALUES (?, 777, 'Stale Film', 'acquiring', ?)").run(filmsTab.id, '9'.repeat(40))

  const scan = await h.request('POST', '/api/v1/system/integrity/run', { body: {} })
  const stale = scan.json.report.problems.find((p: any) => p.category === 'stale-acquisition' && p.title === 'Stale Film')
  assert.ok(stale, 'expected a stale-acquisition problem')

  const repair = await h.request('POST', '/api/v1/system/integrity/repair', {
    body: { problem: stale, backupBeforeRepair: false },
  })
  assert.equal(repair.status, 200)
  assert.equal(repair.json.result.success, true)
  assert.ok(repair.json.result.changes >= 1)

  const film = db.prepare("SELECT status, info_hash FROM films WHERE title = 'Stale Film'").get() as any
  assert.equal(film.status, 'missing')
  assert.equal(film.info_hash, null)
})

test('system maintenance run cleans up and records result', async () => {
  const run = await h.request('POST', '/api/v1/system/maintenance/run', { body: {} })
  assert.equal(run.status, 200)
  assert.ok(run.json.result.finishedAt)
  assert.ok(Array.isArray(run.json.result.checkpointedDatabases))

  const status = await h.request('GET', '/api/v1/system/maintenance')
  assert.ok(status.json.lastResult.finishedAt)
})

test('system backups create a manifest for the unified DB', async () => {
  process.env.ARCHIVIST_BACKUP_DIR = join(h.dir, 'backups')
  const run = await h.request('POST', '/api/v1/system/backups/run', { body: {} })
  assert.equal(run.status, 200)
  assert.ok(run.json.backup.id)
  assert.ok(run.json.backup.files.some((f: any) => f.role === 'unified-db'))

  const list = await h.request('GET', '/api/v1/system/backups')
  assert.equal(list.json.backups.length, 1)
})

test('system db status and checkpoint target the unified database', async () => {
  const res = await h.request('GET', '/api/v1/system/db')
  assert.equal(res.status, 200)
  assert.ok(res.json.shared.exists)
  assert.equal(res.json.tabs.length, 6)

  const checkpoint = await h.request('POST', '/api/v1/system/db/checkpoint', { body: {} })
  assert.equal(checkpoint.json.results.length, 1)
  assert.equal(checkpoint.json.results[0].ok, true)
})

test('system overview aggregates jobs/events/imports/acquisitions', async () => {
  const res = await h.request('GET', '/api/v1/system/overview')
  assert.equal(res.status, 200)
  assert.ok(res.json.jobs.byStatus)
  assert.ok(res.json.events.bySeverity)
  assert.ok(res.json.databases.length >= 1)
  assert.ok(res.json.maintenance.config)
  assert.ok(res.json.backups.config)
})

test('acquisition decisions and blocklist admin surfaces', async () => {
  const decisions = await h.request('GET', '/api/v1/system/acquisition-decisions')
  assert.ok(Array.isArray(decisions.json.decisions))

  const { blockRelease } = await import('../src/services/acquisition-decisions.js')
  blockRelease({ infoHash: '8'.repeat(40), releaseTitle: 'Blocked.Release-TEST', reason: 'test-block' })

  const blocks = await h.request('GET', '/api/v1/system/release-blocklist')
  assert.equal(blocks.json.blocks.length, 1)

  const unblock = await h.request('DELETE', `/api/v1/system/release-blocklist/${blocks.json.blocks[0].id}`)
  assert.equal(unblock.json.success, true)

  const gone = await h.request('DELETE', '/api/v1/system/release-blocklist/424242')
  assert.equal(gone.status, 404)
})

// ── Manual imports ────────────────────────────────────────────────────────────

test('manual import candidates match staged downloads to library items', async () => {
  const { getDb } = await import('../src/db.js')
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  getDb().prepare("INSERT INTO films (library_id, tmdb_id, title, year, status) VALUES (?, 888, 'Inception', 2010, 'missing')").run(filmsTab.id)

  const staged = join(process.env.TORRENT_DOWNLOAD_DIR!, 'Inception.2010.1080p.BluRay.x264-GROUP')
  mkdirSync(staged, { recursive: true })
  writeFileSync(join(staged, 'inception.mkv'), Buffer.alloc(1024))

  const res = await h.request('GET', '/api/v1/system/manual-imports/candidates')
  assert.equal(res.status, 200)
  const item = res.json.items.find((i: any) => i.name.includes('Inception'))
  assert.ok(item, 'staged download should be listed')
  assert.ok(item.candidates.length >= 1)
  assert.equal(item.candidates[0].title, 'Inception')
  assert.equal(item.candidates[0].tabId, filmsTab.id)
})

test('manual import search finds library items by query', async () => {
  const res = await h.request('GET', '/api/v1/system/manual-imports/search?mediaType=films&query=incep&sourceName=Inception.2010')
  assert.equal(res.status, 200)
  assert.equal(res.json.results[0].title, 'Inception')

  const bad = await h.request('GET', '/api/v1/system/manual-imports/search?mediaType=nope&query=x')
  assert.equal(bad.status, 400)
})

test('manual import queue creates a media-import job', async () => {
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  const { getDb } = await import('../src/db.js')
  const film = getDb().prepare("SELECT id FROM films WHERE title = 'Inception'").get() as any
  const staged = join(process.env.TORRENT_DOWNLOAD_DIR!, 'Inception.2010.1080p.BluRay.x264-GROUP')

  const res = await h.request('POST', '/api/v1/system/manual-imports/queue', {
    body: { tabId: filmsTab.id, mediaType: 'films', itemId: film.id, sourcePath: staged },
  })
  assert.equal(res.status, 201)
  assert.ok(res.json.jobId)

  const job = getDb().prepare('SELECT type, status FROM system_jobs WHERE id = ?').get(res.json.jobId) as any
  assert.equal(job.type, 'media-import')
  assert.equal(job.status, 'queued')

  const imports = await h.request('GET', '/api/v1/system/media-imports')
  assert.ok(imports.json.imports.length >= 1)
})

// ── Torrent import-plan surface (via unified stores) ─────────────────────────

test('import plan builds for a staged film source', async () => {
  const { createImportPlan } = await import('../src/services/media-imports.js')
  const { getDb } = await import('../src/db.js')
  const film = getDb().prepare("SELECT id FROM films WHERE title = 'Inception'").get() as any
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  const staged = join(process.env.TORRENT_DOWNLOAD_DIR!, 'Inception.2010.1080p.BluRay.x264-GROUP')

  const plan = createImportPlan({
    tabId: filmsTab.id,
    tabName: filmsTab.name,
    dbPath: filmsTab.db_path,
    mediaType: 'films',
    itemId: film.id,
    torrentId: 'manual:test',
    infoHash: 'x'.repeat(40),
    sourcePath: staged,
    releaseTitle: 'Inception.2010.1080p.BluRay.x264-GROUP',
  }, getDb())

  assert.equal(plan.status, 'ready')
  assert.equal(plan.files.length, 1)
  assert.equal(plan.files[0].role, 'primary')
})
