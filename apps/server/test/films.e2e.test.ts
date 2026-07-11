import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, startTmdbMock, type TestHarness } from './helpers.js'

let h: TestHarness
let tmdb: Awaited<ReturnType<typeof startTmdbMock>>
let headers: Record<string, string>
let filmId: number

test('boot with TMDB mock', async () => {
  tmdb = await startTmdbMock()
  h = await startTestApp({ env: { TMDB_BASE_URL: tmdb.url, TMDB_API_KEY: 'test-key' } })
  const tabs = await h.request('GET', '/api/v1/tabs')
  const filmsTab = tabs.json.find((t: any) => t.media_type === 'films')
  headers = { 'x-tab-context': String(filmsTab.id) }
})

after(async () => {
  await h?.close()
  await tmdb?.close()
})

test('lookup returns TMDB results with alreadyAdded=false', async () => {
  const res = await h.request('GET', '/api/v1/films/lookup?q=matrix', { headers })
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 1)
  assert.equal(res.json[0].tmdbId, 603)
  assert.equal(res.json[0].alreadyAdded, false)
})

test('add film persists metadata and creates the media folder', async () => {
  const res = await h.request('POST', '/api/v1/films', { body: { tmdbId: 603 }, headers })
  assert.equal(res.status, 201)
  filmId = res.json.id
  assert.equal(res.json.title, 'The Matrix')
  assert.equal(res.json.year, 1999)
  assert.equal(res.json.status, 'missing')
  assert.equal(res.json.imdb_id, 'tt0133093')
  assert.deepEqual(res.json.genres, ['Action', 'Science Fiction'])
  assert.equal(res.json.certification, 'R')
  assert.equal(res.json.studio, 'Warner Bros.')
  assert.ok(res.json.cast.length > 0)
  assert.ok(existsSync(res.json.root_folder_path))

  const dup = await h.request('POST', '/api/v1/films', { body: { tmdbId: 603 }, headers })
  assert.equal(dup.status, 409)
})

test('lookup now reports alreadyAdded=true', async () => {
  const res = await h.request('GET', '/api/v1/films/lookup?q=matrix', { headers })
  assert.equal(res.json[0].alreadyAdded, true)
})

test('list and detail preserve legacy field names', async () => {
  const list = await h.request('GET', '/api/v1/films', { headers })
  assert.equal(list.json.length, 1)
  assert.ok('poster_path' in list.json[0])
  assert.ok('posterPath' in list.json[0])
  assert.equal(list.json[0].downloadProgress, 0)
  assert.equal(list.json[0].monitored, true)

  const detail = await h.request('GET', `/api/v1/films/${filmId}`, { headers })
  assert.equal(detail.status, 200)
  assert.ok(Array.isArray(detail.json.editions))
  assert.equal(detail.json.upgrade_allowed, true)

  const missing = await h.request('GET', '/api/v1/films/424242', { headers })
  assert.equal(missing.status, 404)
})

test('list reports loudnessMeasured flag for the normalization badge', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  // Give the film a file and a loudness measurement.
  db.prepare("UPDATE films SET file_path = '/media/x.mkv', status = 'collected' WHERE id = ?").run(filmId)
  const before = await h.request('GET', '/api/v1/films', { headers })
  assert.equal(before.json[0].loudnessMeasured, false, 'not measured yet')

  db.prepare(`INSERT INTO media_loudness (media_type, media_id, file_path, integrated_lufs, true_peak, lra, threshold)
              VALUES ('film', ?, '/media/x.mkv', -18.2, -1.4, 7.0, -28.0)`).run(filmId)
  const after = await h.request('GET', '/api/v1/films', { headers })
  assert.equal(after.json[0].loudnessMeasured, true, 'measured → badge shows')

  // A measurement for a different file path does not count (re-import invalidates).
  db.prepare("UPDATE media_loudness SET file_path = '/media/old.mkv' WHERE media_type='film' AND media_id=?").run(filmId)
  const stale = await h.request('GET', '/api/v1/films', { headers })
  assert.equal(stale.json[0].loudnessMeasured, false, 'stale measurement (different file) ignored')

  // Restore the shared film to its pre-test state for the tests that follow.
  db.prepare("UPDATE films SET file_path = NULL, status = 'wanted' WHERE id = ?").run(filmId)
  db.prepare("DELETE FROM media_loudness WHERE media_type='film' AND media_id=?").run(filmId)
})

test('tmdb-keyed compatibility lookup: local hit and uncollected fallback', async () => {
  const local = await h.request('GET', '/api/v1/films/tmdb/603', { headers })
  assert.equal(local.status, 200)
  assert.equal(local.json.localId, filmId)

  // Library scoping: the same tmdb id in another films library is not local
  const other = await h.request('POST', '/api/v1/tabs', { body: { name: 'Kids', mediaType: 'films', dbPath: './data/films-kids.db' } })
  const kidsHeaders = { 'x-tab-context': String(other.json.id) }
  const fallback = await h.request('GET', '/api/v1/films/tmdb/603', { headers: kidsHeaders })
  assert.equal(fallback.status, 200)
  assert.equal(fallback.json.status, 'uncollected')
  assert.equal(fallback.json.localId, undefined)
})

test('update film policy fields', async () => {
  const res = await h.request('PUT', `/api/v1/films/${filmId}`, {
    body: { upgrade_allowed: false, target_tier: 'Tier 1', target_resolution: '1080p' },
    headers,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.upgrade_allowed, false)
  assert.equal(res.json.target_tier, 'Tier 1')
})

test('metadata edit rewrites NFO on disk', async () => {
  const res = await h.request('PUT', `/api/v1/films/${filmId}/metadata`, {
    body: { overview: 'Edited overview text.' },
    headers,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.overview, 'Edited overview text.')

  const nfoPath = join(res.json.root_folder_path, 'The Matrix (1999).nfo')
  assert.ok(existsSync(nfoPath))
  assert.match(readFileSync(nfoPath, 'utf8'), /Edited overview text\./)
})

test('acquisition history starts empty; reject requires an active release', async () => {
  const history = await h.request('GET', `/api/v1/films/${filmId}/acquisition-history`, { headers })
  assert.equal(history.status, 200)
  assert.deepEqual(history.json, { decisions: [], blocks: [] })

  const reject = await h.request('POST', `/api/v1/films/${filmId}/reject-current-release`, { body: {}, headers })
  assert.equal(reject.status, 400)
})

test('reject-current-release blocklists the active release', async () => {
  const { getDb } = await import('../src/db.js')
  const infoHash = 'a'.repeat(40)
  getDb().prepare("UPDATE films SET info_hash = ?, current_release_title = 'The.Matrix.1999.1080p.BluRay.x264-TEST' WHERE id = ?").run(infoHash, filmId)

  const reject = await h.request('POST', `/api/v1/films/${filmId}/reject-current-release`, { body: { reason: 'bad quality' }, headers })
  assert.equal(reject.status, 200)
  assert.equal(reject.json.success, true)

  const history = await h.request('GET', `/api/v1/films/${filmId}/acquisition-history`, { headers })
  assert.equal(history.json.blocks.length, 1)
  assert.equal(history.json.blocks[0].reason, 'bad quality')

  const detail = await h.request('GET', `/api/v1/films/${filmId}`, { headers })
  assert.equal(detail.json.status, 'missing')
  assert.equal(detail.json.info_hash, null)
})

test('repair resets film state and can blocklist current release', async () => {
  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE films SET status = 'collected', file_path = '/nonexistent/file.mkv', current_release_title = 'The.Matrix.1999.REPACK-TEST', current_tier = 2 WHERE id = ?").run(filmId)

  const repair = await h.request('POST', `/api/v1/films/${filmId}/repair`, { body: { deleteFile: false }, headers })
  assert.equal(repair.status, 200)
  assert.equal(repair.json.status, 'missing')
  assert.equal(repair.json.file_path, null)
  assert.equal(repair.json.current_tier, 0)

  const history = await h.request('GET', `/api/v1/films/${filmId}/acquisition-history`, { headers })
  assert.equal(history.json.blocks.length, 2)
})

test('release search SSE contract: done event with no indexers', async () => {
  const controller = new AbortController()
  const res = await fetch(`${h.baseUrl}/api/v1/films/releases/search?q=matrix&year=1999`, {
    headers: { ...h.authHeaders, ...headers }, signal: controller.signal,
  })
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const text = await res.text()
  assert.match(text, /event: done/)
  controller.abort()
})

test('edition rules CRUD is library-scoped', async () => {
  const all = await h.request('GET', '/api/v1/films/edition-rules/all', { headers })
  assert.equal(all.json.length, 8)

  const created = await h.request('POST', '/api/v1/films/edition-rules', {
    body: { rule_name: 'Anniversary', regex_pattern: '(?i)(anniversary)', output_label: 'Anniversary Edition', priority: 15 },
    headers,
  })
  assert.equal(created.json.rule_name, 'Anniversary')

  const updated = await h.request('PUT', `/api/v1/films/edition-rules/${created.json.id}`, {
    body: { priority: 25 }, headers,
  })
  assert.equal(updated.json.priority, 25)

  const deleted = await h.request('DELETE', `/api/v1/films/edition-rules/${created.json.id}`, { headers })
  assert.deepEqual(deleted.json, { success: true })
})

test('refresh returns immediately with background contract shape', async () => {
  const res = await h.request('POST', '/api/v1/films/refresh', { body: {}, headers })
  assert.equal(res.status, 200)
  assert.equal(res.json.success, true)
  assert.match(res.json.message, /Refresh started/)
})

test('delete film preserves 204 semantics and scoping', async () => {
  const res = await h.request('DELETE', `/api/v1/films/${filmId}`, { headers })
  assert.equal(res.status, 204)
  const detail = await h.request('GET', `/api/v1/films/${filmId}`, { headers })
  assert.equal(detail.status, 404)
})
