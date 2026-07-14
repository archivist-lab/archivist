import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSessionSendFn } from '@archivist/core'
import { startTestApp, type TestHarness } from './helpers.js'
import { parseRelease } from '../src/release-pipeline/parser.js'
import { identifyRelease } from '../src/release-pipeline/identifier.js'
import { rebuildTitleIndex } from '../src/release-pipeline/title-index.js'
import { processReleaseBatch } from '../src/shared/rss-monitor.js'

let h: TestHarness
let filmId: number

test('boot and seed monitored automation subjects', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const library = (type: string) => (db.prepare('SELECT id FROM libraries WHERE media_type = ?').get(type) as { id: number }).id

  filmId = Number(db.prepare(`
    INSERT INTO films (library_id, title, sort_title, year, genres, monitored, status)
    VALUES (?, 'Search Fixture', 'Search Fixture', 2024, '[]', 1, 'missing')
  `).run(library('films')).lastInsertRowid)

  const authorId = Number(db.prepare(`
    INSERT INTO authors (library_id, name, monitored) VALUES (?, 'Frank Herbert', 1)
  `).run(library('books')).lastInsertRowid)
  db.prepare(`
    INSERT INTO books (author_id, title, year, monitored, status)
    VALUES (?, 'Dune', 1965, 1, 'missing')
  `).run(authorId)

  const comicSeriesId = Number(db.prepare(`
    INSERT INTO comic_series (library_id, title, start_year, monitored)
    VALUES (?, 'Saga', 2012, 1)
  `).run(library('comics')).lastInsertRowid)
  db.prepare(`
    INSERT INTO comic_issues (series_id, issue_number, year, monitored, status)
    VALUES (?, '1', 2012, 1, 'missing')
  `).run(comicSeriesId)

  rebuildTitleIndex()
})

after(async () => { await h?.close() })

test('book and comic releases identify monitored subjects', () => {
  const book = identifyRelease(parseRelease('Frank.Herbert.Dune.1965.EPUB'))
  assert.equal(book?.subject.mediaType, 'books')
  assert.equal(book?.subject.subjectType, 'book')

  const comic = identifyRelease(parseRelease('Saga.001.2012.Digital.CBZ'))
  assert.equal(comic?.subject.mediaType, 'comics')
  assert.equal(comic?.subject.subjectType, 'comic-issue')
})

test('client rejection does not mark a film acquiring', async () => {
  registerSessionSendFn(async () => ({ success: false, message: 'rejected by test client' }))
  const outcome = await processReleaseBatch([{
    guid: 'failed-grab',
    title: 'Search.Fixture.2024.1080p.WEB.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111',
    size: 1024,
    seeders: 10,
    indexerName: 'Fixture',
    indexerPriority: 1,
  }])
  assert.equal(outcome.grabbed, 0)

  const { getDb } = await import('../src/db.js')
  const row = getDb().prepare('SELECT status, info_hash FROM films WHERE id = ?').get(filmId) as any
  assert.equal(row.status, 'missing')
  assert.equal(row.info_hash, null)
})

test('successful client submission persists acquiring status and hash', async () => {
  const hash = '2222222222222222222222222222222222222222'
  registerSessionSendFn(async () => ({ success: true, message: 'accepted', infoHash: hash }))
  const outcome = await processReleaseBatch([{
    guid: 'successful-grab',
    title: 'Search.Fixture.2024.1080p.WEB.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:' + hash,
    size: 1024,
    seeders: 10,
    indexerName: 'Fixture',
    indexerPriority: 1,
  }])
  assert.equal(outcome.grabbed, 1)

  const { getDb } = await import('../src/db.js')
  const row = getDb().prepare('SELECT status, info_hash FROM films WHERE id = ?').get(filmId) as any
  assert.equal(row.status, 'acquiring')
  assert.equal(row.info_hash, hash)
})

test('RSS grabs a wanted item whose group tier differs from the target tier (soft tier gate)', async () => {
  // Regression for the systemic "RSS fetches but never grabs" bug: evaluateRelease
  // (the RSS-only decision path) used to HARD-reject any release whose group tier
  // did not equal the subject's target_tier. A Tier-1 target therefore rejected
  // every non-Tier-1 release, so RSS grabbed nothing. It is now a soft ranking
  // signal. (Auto/manual search bypass evaluateRelease, which is why they worked.)
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films'").get() as { id: number }).id
  const id = Number(db.prepare(`
    INSERT INTO films (library_id, title, sort_title, year, genres, monitored, status, target_tier)
    VALUES (?, 'Tier Gate Fixture', 'Tier Gate Fixture', 2024, '[]', 1, 'missing', 'Tier 1')
  `).run(filmsLib).lastInsertRowid)
  rebuildTitleIndex()

  const hash = '3333333333333333333333333333333333333333'
  registerSessionSendFn(async () => ({ success: true, message: 'accepted', infoHash: hash }))
  const outcome = await processReleaseBatch([{
    guid: 'tier-gate-grab',
    title: 'Tier.Gate.Fixture.2024.1080p.WEB.x265-YIFY', // YIFY = Tier 3, not the Tier-1 target
    downloadUrl: 'magnet:?xt=urn:btih:' + hash,
    size: 1024, seeders: 10, indexerName: 'Fixture', indexerPriority: 1,
  }])
  assert.equal(outcome.grabbed, 1)
  assert.equal((db.prepare('SELECT status FROM films WHERE id = ?').get(id) as any).status, 'acquiring')
})

test('RSS title matching treats ampersands and "and" equivalently', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films'").get() as { id: number }).id
  const id = Number(db.prepare(`
    INSERT INTO films (library_id, title, sort_title, year, genres, monitored, status)
    VALUES (?, 'Ampersand Fixture: Red, White & Blonde', 'Ampersand Fixture', 2024, '[]', 1, 'missing')
  `).run(filmsLib).lastInsertRowid)
  rebuildTitleIndex()

  const hash = '4444444444444444444444444444444444444444'
  registerSessionSendFn(async () => ({ success: true, message: 'accepted', infoHash: hash }))
  const outcome = await processReleaseBatch([{
    guid: 'ampersand-title-grab',
    title: 'Ampersand.Fixture.Red.White.and.Blonde.2024.1080p.BluRay.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:' + hash,
    size: 1024, seeders: 10, indexerName: 'Fixture', indexerPriority: 1,
  }])
  assert.equal(outcome.grabbed, 1)
  assert.equal((db.prepare('SELECT status FROM films WHERE id = ?').get(id) as any).status, 'acquiring')
})
