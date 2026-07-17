import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveEpisodeAirtime, normaliseAirTime } from '../src/modules/series/airtime.js'
import { claimDueRssEpisodes, recordReleaseRssOutcome } from '../src/release-pipeline/new-release-search.js'
import { setReleaseMonitoringSettings } from '../src/release-pipeline/release-monitoring-settings.js'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness

after(async () => { await h?.close() })

test('episode airtime converts provider schedule into canonical UTC', () => {
  assert.equal(normaliseAirTime('8:05 PM'), '20:05')
  const result = deriveEpisodeAirtime('2026-07-16', '20:00', 'Asia/Dubai')
  assert.equal(result.airDate, '2026-07-16')
  assert.equal(result.airTime, '20:00')
  assert.equal(result.airTimezone, 'Asia/Dubai')
  assert.equal(result.airAt, '2026-07-16T16:00:00.000Z')
  assert.equal(result.airTimeSource, 'series_schedule')
})

test('date-only metadata without a real schedule is not assigned a guessed time', () => {
  const result = deriveEpisodeAirtime('2026-07-16', null, 'Asia/Dubai')
  assert.equal(result.airDate, '2026-07-16')
  assert.equal(result.airTime, null)
  assert.equal(result.airAt, null)
})

test('release scheduler moves episodes through rss, targeted, backlog, and complete states', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  // The server test runner can be invoked before workspace package builds, in
  // which case @archivist/db/dist still reflects the previous source schema.
  // The package-level schema test covers the migration itself; make this
  // scheduler integration fixture independent of that build cache.
  const episodeColumns = new Set((db.prepare("PRAGMA table_info('episodes')").all() as Array<{ name: string }>).map(column => column.name))
  for (const [name, sqlType] of [['air_time', 'TEXT'], ['air_timezone', 'TEXT'], ['air_at', 'TEXT'], ['air_time_source', 'TEXT']] as const) {
    if (!episodeColumns.has(name)) db.exec(`ALTER TABLE episodes ADD COLUMN ${name} ${sqlType}`)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS new_release_search_state (
      episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      air_at TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'pending',
      next_run_at INTEGER NOT NULL,
      rss_attempts INTEGER NOT NULL DEFAULT 0,
      targeted_attempts INTEGER NOT NULL DEFAULT 0,
      last_run_at INTEGER,
      last_result TEXT,
      last_error TEXT,
      completed_at INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  setReleaseMonitoringSettings({
    rapidPollingEnabled: true,
    rapidStartDelayMinutes: 5,
    rapidPollIntervalMinutes: 5,
    rapidWindowAfterAirHours: 2,
    targetedSearchIntervalMinutes: 60,
    targetedSearchWindowHours: 24,
  })
  const libraryId = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series'").get() as { id: number }).id
  const seriesId = Number(db.prepare("INSERT INTO series (library_id, title, monitored, air_time) VALUES (?, 'Airtime Fixture', 1, '20:00')").run(libraryId).lastInsertRowid)
  const seasonId = Number(db.prepare('INSERT INTO seasons (series_id, season_number, monitored) VALUES (?, 1, 1)').run(seriesId).lastInsertRowid)
  const now = Date.UTC(2026, 6, 16, 20, 0, 0)
  const addEpisode = (number: number, airAt: number) => Number(db.prepare(`
    INSERT INTO episodes
      (series_id, season_id, season_number, episode_number, air_date, air_time, air_timezone, air_at, monitored, status)
    VALUES (?, ?, 1, ?, ?, '20:00', 'UTC', ?, 1, 'missing')
  `).run(seriesId, seasonId, number, new Date(airAt).toISOString().slice(0, 10), new Date(airAt).toISOString()).lastInsertRowid)

  const rssId = addEpisode(1, now - 10 * 60_000)
  const targetedId = addEpisode(2, now - 3 * 60 * 60_000)
  const backlogId = addEpisode(3, now - 25 * 60 * 60_000)

  assert.deepEqual(claimDueRssEpisodes(now), [rssId])
  assert.deepEqual(db.prepare('SELECT phase, rss_attempts FROM new_release_search_state WHERE episode_id = ?').get(rssId), { phase: 'rss', rss_attempts: 1 })
  assert.equal((db.prepare('SELECT phase FROM new_release_search_state WHERE episode_id = ?').get(targetedId) as { phase: string }).phase, 'targeted')
  assert.equal((db.prepare('SELECT phase FROM new_release_search_state WHERE episode_id = ?').get(backlogId) as { phase: string }).phase, 'backlog')

  db.prepare("UPDATE episodes SET status = 'acquiring' WHERE id = ?").run(rssId)
  recordReleaseRssOutcome([rssId], { indexers: 1, fetched: 4, grabbed: 1, errors: [] }, now)
  assert.equal((db.prepare('SELECT phase FROM new_release_search_state WHERE episode_id = ?').get(rssId) as { phase: string }).phase, 'complete')

  db.prepare("UPDATE episodes SET status = 'missing' WHERE id = ?").run(rssId)
  assert.deepEqual(claimDueRssEpisodes(now + 5 * 60_000), [rssId])
  assert.deepEqual(db.prepare('SELECT phase, rss_attempts FROM new_release_search_state WHERE episode_id = ?').get(rssId), { phase: 'rss', rss_attempts: 1 })

  db.prepare('UPDATE seasons SET monitored = 0 WHERE id = ?').run(seasonId)
  assert.deepEqual(claimDueRssEpisodes(now + 10 * 60_000), [])
  assert.equal((db.prepare('SELECT phase FROM new_release_search_state WHERE episode_id = ?').get(rssId) as { phase: string }).phase, 'cancelled')
})
