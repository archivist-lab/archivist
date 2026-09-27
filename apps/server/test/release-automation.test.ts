import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSessionSendFn } from '@archivist/core'
import { startTestApp, type TestHarness } from './helpers.js'
import { parseRelease } from '../src/release-pipeline/parser.js'
import { identifyRelease } from '../src/release-pipeline/identifier.js'
import { rebuildTitleIndex } from '../src/release-pipeline/title-index.js'
import { processReleaseBatch } from '../src/shared/rss-monitor.js'
import { getReleaseMonitoringSettings, setReleaseMonitoringSettings } from '../src/release-pipeline/release-monitoring-settings.js'

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

test('RSS rejects a release outside an exact tier envelope', async () => {
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
  assert.equal(outcome.grabbed, 0)
  assert.equal((db.prepare('SELECT status FROM films WHERE id = ?').get(id) as any).status, 'missing')
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

test('RSS skips an episode that already has a local file path', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series'").get() as { id: number }).id
  const seriesId = Number(db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, monitored, status)
    VALUES (?, 'Lucky File Fixture', 'Lucky File Fixture', 2026, 1, 'continuing')
  `).run(seriesLib).lastInsertRowid)
  const seasonId = Number(db.prepare(`
    INSERT INTO seasons (series_id, season_number, episode_count)
    VALUES (?, 1, 1)
  `).run(seriesId).lastInsertRowid)
  const episodeId = Number(db.prepare(`
    INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, monitored, air_date, file_path)
    VALUES (?, ?, 1, 1, 'Already Here', 'missing', 1, date('now'), '/media/Lucky File Fixture S01E01.mkv')
  `).run(seriesId, seasonId).lastInsertRowid)
  rebuildTitleIndex()

  let sendCount = 0
  registerSessionSendFn(async () => {
    sendCount++
    return { success: true, message: 'accepted', infoHash: '5555555555555555555555555555555555555555' }
  })
  const outcome = await processReleaseBatch([{
    guid: 'already-local-episode',
    title: 'Lucky.File.Fixture.S01E01.1080p.WEB.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:5555555555555555555555555555555555555555',
    size: 1024, seeders: 10, indexerName: 'Fixture', indexerPriority: 1,
  }])

  assert.equal(outcome.grabbed, 0)
  assert.equal(sendCount, 0)
  const row = db.prepare('SELECT status, info_hash FROM episodes WHERE id = ?').get(episodeId) as any
  assert.equal(row.status, 'missing')
  assert.equal(row.info_hash, null)
})

test('RSS excludes episodes whose season monitoring is off', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series'").get() as { id: number }).id
  const seriesId = Number(db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, monitored, status)
    VALUES (?, 'Unmonitored Season Fixture', 'Unmonitored Season Fixture', 2026, 1, 'continuing')
  `).run(seriesLib).lastInsertRowid)
  const seasonId = Number(db.prepare(`
    INSERT INTO seasons (series_id, season_number, episode_count, monitored)
    VALUES (?, 1, 1, 0)
  `).run(seriesId).lastInsertRowid)
  const episodeId = Number(db.prepare(`
    INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, monitored, air_date)
    VALUES (?, ?, 1, 1, 'Excluded Episode', 'missing', 1, date('now'))
  `).run(seriesId, seasonId).lastInsertRowid)
  rebuildTitleIndex()

  let sendCount = 0
  registerSessionSendFn(async () => {
    sendCount++
    return { success: true, message: 'accepted', infoHash: '6666666666666666666666666666666666666666' }
  })
  const outcome = await processReleaseBatch([{
    guid: 'unmonitored-season-episode',
    title: 'Unmonitored.Season.Fixture.S01E01.1080p.WEB.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:6666666666666666666666666666666666666666',
    size: 1024, seeders: 10, indexerName: 'Fixture', indexerPriority: 1,
  }])

  assert.equal(outcome.grabbed, 0)
  assert.equal(sendCount, 0)
  assert.deepEqual(db.prepare('SELECT status, info_hash FROM episodes WHERE id = ?').get(episodeId), { status: 'missing', info_hash: null })
})

test('RSS grabs a leaked release for an episode that has not aired yet', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series'").get() as { id: number }).id
  const seriesId = Number(db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, monitored, status)
    VALUES (?, 'Leak Fixture', 'Leak Fixture', 2026, 1, 'continuing')
  `).run(seriesLib).lastInsertRowid)
  const seasonId = Number(db.prepare(`
    INSERT INTO seasons (series_id, season_number, episode_count, monitored)
    VALUES (?, 1, 1, 1)
  `).run(seriesId).lastInsertRowid)
  // Airs a week out, with an exact timestamp — the shape that used to be
  // rejected as "not aired yet" and then never offered again.
  const airAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  const episodeId = Number(db.prepare(`
    INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, monitored, air_date, air_at)
    VALUES (?, ?, 1, 6, 'Leaked Early', 'missing', 1, ?, ?)
  `).run(seriesId, seasonId, airAt.slice(0, 10), airAt).lastInsertRowid)
  rebuildTitleIndex()

  let sendCount = 0
  registerSessionSendFn(async () => {
    sendCount++
    return { success: true, message: 'accepted', infoHash: '7777777777777777777777777777777777777777' }
  })
  const outcome = await processReleaseBatch([{
    guid: 'leaked-episode',
    title: 'Leak.Fixture.S01E06.1080p.WEB.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:7777777777777777777777777777777777777777',
    size: 1024, seeders: 10, indexerName: 'Fixture', indexerPriority: 1,
  }])

  assert.equal(outcome.grabbed, 1)
  assert.equal(sendCount, 1)
  assert.equal((db.prepare('SELECT status FROM episodes WHERE id = ?').get(episodeId) as { status: string }).status, 'acquiring')
})

test('a pre-air season pack is grabbed while its episodes are still wanted', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series'").get() as { id: number }).id
  const seriesId = Number(db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, monitored, status)
    VALUES (?, 'Pack Leak Fixture', 'Pack Leak Fixture', 2026, 1, 'continuing')
  `).run(seriesLib).lastInsertRowid)
  const seasonId = Number(db.prepare(`
    INSERT INTO seasons (series_id, season_number, episode_count, monitored)
    VALUES (?, 1, 2, 1)
  `).run(seriesId).lastInsertRowid)
  const airAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  for (const number of [1, 2]) {
    db.prepare(`
      INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, monitored, air_date, air_at)
      VALUES (?, ?, 1, ?, 'Unaired', 'missing', 1, ?, ?)
    `).run(seriesId, seasonId, number, airAt.slice(0, 10), airAt)
  }
  rebuildTitleIndex()

  let sendCount = 0
  registerSessionSendFn(async () => {
    sendCount++
    return { success: true, message: 'accepted', infoHash: '8888888888888888888888888888888888888888' }
  })
  const outcome = await processReleaseBatch([{
    guid: 'leaked-season-pack',
    title: 'Pack.Leak.Fixture.S01.1080p.WEB.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:8888888888888888888888888888888888888888',
    size: 4096, seeders: 20, indexerName: 'Fixture', indexerPriority: 1,
  }])

  assert.equal(outcome.grabbed, 1)
  assert.equal(sendCount, 1)
})

/** Builds a monitored, unaired episode and returns its ids. */
async function seedUnairedEpisode(title: string, episodeNumber: number) {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series'").get() as { id: number }).id
  const seriesId = Number(db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, monitored, status)
    VALUES (?, ?, ?, 2026, 1, 'continuing')
  `).run(seriesLib, title, title).lastInsertRowid)
  const seasonId = Number(db.prepare(`
    INSERT INTO seasons (series_id, season_number, episode_count, monitored) VALUES (?, 1, 1, 1)
  `).run(seriesId).lastInsertRowid)
  const airAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
  const episodeId = Number(db.prepare(`
    INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, monitored, air_date, air_at)
    VALUES (?, ?, 1, ?, 'Unaired', 'missing', 1, ?, ?)
  `).run(seriesId, seasonId, episodeNumber, airAt.slice(0, 10), airAt).lastInsertRowid)
  rebuildTitleIndex()
  return { db, episodeId }
}

test('the TV seeder floor rejects a thinly-seeded automatic grab', async () => {
  const { db, episodeId } = await seedUnairedEpisode('Seeder Floor Fixture', 6)
  const previous = getReleaseMonitoringSettings().seriesMinimumSeeders
  setReleaseMonitoringSettings({ seriesMinimumSeeders: 3 })
  let sendCount = 0
  registerSessionSendFn(async () => { sendCount++; return { success: true, message: 'accepted', infoHash: 'a'.repeat(40) } })
  try {
    const outcome = await processReleaseBatch([{
      guid: 'thin-swarm',
      title: 'Seeder.Floor.Fixture.S01E06.1080p.WEB.x265-GROUP',
      downloadUrl: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
      size: 1024, seeders: 1, indexerName: 'Fixture', indexerPriority: 1,
    }])
    assert.equal(outcome.grabbed, 0)
    assert.equal(sendCount, 0)
    assert.equal((db.prepare('SELECT status FROM episodes WHERE id = ?').get(episodeId) as { status: string }).status, 'missing')
    const decision = db.prepare(`
      SELECT accepted, rejection_reasons FROM acquisition_decisions
      WHERE subject_type = 'episode' AND subject_id = ? ORDER BY id DESC LIMIT 1
    `).get(String(episodeId)) as { accepted: number; rejection_reasons: string } | undefined
    assert.equal(decision?.accepted, 0)
    assert.match(decision!.rejection_reasons, /below the automatic minimum of 3/)
  } finally {
    setReleaseMonitoringSettings({ seriesMinimumSeeders: previous })
  }
})

test('the TV seeder floor never drops a release whose indexer omits seeders', async () => {
  const { db, episodeId } = await seedUnairedEpisode('No Seeder Count Fixture', 6)
  const previous = getReleaseMonitoringSettings().seriesMinimumSeeders
  setReleaseMonitoringSettings({ seriesMinimumSeeders: 5 })
  let sendCount = 0
  registerSessionSendFn(async () => { sendCount++; return { success: true, message: 'accepted', infoHash: 'b'.repeat(40) } })
  try {
    const outcome = await processReleaseBatch([{
      guid: 'no-seeder-count',
      title: 'No.Seeder.Count.Fixture.S01E06.1080p.WEB.x265-GROUP',
      downloadUrl: 'magnet:?xt=urn:btih:' + 'b'.repeat(40),
      size: 1024, indexerName: 'Fixture', indexerPriority: 1,
    }])
    assert.equal(outcome.grabbed, 1)
    assert.equal(sendCount, 1)
    assert.equal((db.prepare('SELECT status FROM episodes WHERE id = ?').get(episodeId) as { status: string }).status, 'acquiring')
  } finally {
    setReleaseMonitoringSettings({ seriesMinimumSeeders: previous })
  }
})

test('an explicit user pick is not subject to the TV seeder floor', async () => {
  const { db, episodeId } = await seedUnairedEpisode('Manual Pick Fixture', 6)
  const previous = getReleaseMonitoringSettings().seriesMinimumSeeders
  setReleaseMonitoringSettings({ seriesMinimumSeeders: 10 })
  let sendCount = 0
  registerSessionSendFn(async () => { sendCount++; return { success: true, message: 'accepted', infoHash: 'c'.repeat(40) } })
  try {
    const outcome = await processReleaseBatch([{
      guid: 'manual-thin-swarm',
      title: 'Manual.Pick.Fixture.S01E06.1080p.WEB.x265-GROUP',
      downloadUrl: 'magnet:?xt=urn:btih:' + 'c'.repeat(40),
      size: 1024, seeders: 1, indexerName: 'Fixture', indexerPriority: 1,
    }], { source: 'manual', manualSelection: true })
    assert.equal(outcome.grabbed, 1)
    assert.equal(sendCount, 1)
    assert.equal((db.prepare('SELECT status FROM episodes WHERE id = ?').get(episodeId) as { status: string }).status, 'acquiring')
  } finally {
    setReleaseMonitoringSettings({ seriesMinimumSeeders: previous })
  }
})

test('a seeder floor of zero is stored as off rather than reset to the default', () => {
  const previous = getReleaseMonitoringSettings().seriesMinimumSeeders
  try {
    assert.equal(setReleaseMonitoringSettings({ seriesMinimumSeeders: 0 }).seriesMinimumSeeders, 0)
    assert.equal(setReleaseMonitoringSettings({ seriesMinimumSeeders: 400 }).seriesMinimumSeeders, 100)
    assert.equal(setReleaseMonitoringSettings({ seriesMinimumSeeders: -5 }).seriesMinimumSeeders, 0)
  } finally {
    setReleaseMonitoringSettings({ seriesMinimumSeeders: previous })
  }
})
