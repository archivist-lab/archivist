import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness

after(async () => { await h?.close() })

test('item searches are durable, deduplicated, FIFO queued, cancellable, and expire', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const libraryId = Number(db.prepare(`
    INSERT INTO libraries (name, media_type, db_path) VALUES ('Search Queue Films', 'films', 'search-queue-films')
  `).run().lastInsertRowid)
  const firstFilmId = Number(db.prepare("INSERT INTO films (library_id, title, year) VALUES (?, 'First Search', 2025)").run(libraryId).lastInsertRowid)
  const secondFilmId = Number(db.prepare("INSERT INTO films (library_id, title, year) VALUES (?, 'Second Search', 2026)").run(libraryId).lastInsertRowid)
  const headers = { 'x-tab-context': String(libraryId) }

  const first = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'films', subjectType: 'film', subjectId: firstFilmId, mode: 'deep' },
  })
  assert.equal(first.status, 202)
  assert.equal(first.json.search.status, 'queued')
  assert.equal(first.json.search.queuePosition, 1)

  const duplicate = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'films', subjectType: 'film', subjectId: firstFilmId, mode: 'deep' },
  })
  assert.equal(duplicate.json.search.id, first.json.search.id, 'an active subject/mode search must not be duplicated')

  const second = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'films', subjectType: 'film', subjectId: secondFilmId, mode: 'quick' },
  })
  assert.equal(second.status, 202)
  assert.equal(second.json.search.queuePosition, 2)

  const restored = await h.request('GET', `/api/v1/item-searches/latest?mediaType=films&subjectType=film&subjectId=${firstFilmId}`, { headers })
  assert.equal(restored.status, 200)
  assert.equal(restored.json.search.id, first.json.search.id, 'a later page load must recover the durable search')

  const cancelled = await h.request('DELETE', `/api/v1/item-searches/${first.json.search.id}`, { headers })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.json.search.status, 'cancelled')
  const next = await h.request('GET', `/api/v1/item-searches/${second.json.search.id}`, { headers })
  assert.equal(next.json.search.queuePosition, 1, 'cancelling the head should advance the next queued search')

  db.prepare(`
    UPDATE item_searches SET status = 'complete', completed_at = datetime('now', '-16 minutes'),
      expires_at = datetime('now', '-1 minute') WHERE id = ?
  `).run(second.json.search.id)
  const expired = await h.request('GET', `/api/v1/item-searches/${second.json.search.id}`, { headers })
  assert.equal(expired.status, 404)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM item_searches WHERE id = ?').get(second.json.search.id) as { count: number }).count, 0)
})
