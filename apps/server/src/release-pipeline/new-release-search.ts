import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { configuredReleaseTimezone, deriveEpisodeAirtime } from '../modules/series/airtime.js'
import { recordEvent } from '../system/event-store.js'
import { searchNewReleaseEpisode } from './missing-search.js'
import { getReleaseMonitoringSettings } from './release-monitoring-settings.js'

const logger = createLogger('NewReleaseSearch')
const TICK_INTERVAL_MS = 60_000
const STARTUP_DELAY_MS = 15_000
const MAX_TARGETED_CONCURRENT = 2

type Phase = 'pending' | 'rss' | 'targeted' | 'backlog' | 'complete' | 'cancelled'

interface SearchState {
  episode_id: number
  air_at: string
  phase: Phase
  next_run_at: number
}

let timer: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null
let running = false
const targetedInFlight = new Set<number>()

function timings(airAt: string) {
  const settings = getReleaseMonitoringSettings()
  const air = Date.parse(airAt)
  return {
    settings,
    air,
    rssStart: air + settings.rapidStartDelayMinutes * 60_000,
    rssEnd: air + settings.rapidWindowAfterAirHours * 60 * 60_000,
    searchEnd: air + settings.targetedSearchWindowHours * 60 * 60_000,
    rssInterval: settings.rapidPollIntervalMinutes * 60_000,
    targetedInterval: settings.targetedSearchIntervalMinutes * 60_000,
  }
}

/** Fill exact timestamps for older metadata rows that already have a series schedule. */
function backfillAirtimes(): void {
  const rows = getDb().prepare(`
    SELECT e.id, e.air_date, s.air_time
    FROM episodes e JOIN series s ON s.id = e.series_id
    WHERE e.air_at IS NULL AND e.air_date IS NOT NULL AND s.air_time IS NOT NULL
    LIMIT 500
  `).all() as Array<{ id: number; air_date: string; air_time: string }>
  if (rows.length === 0) return
  const timezone = configuredReleaseTimezone()
  const update = getDb().prepare(`
    UPDATE episodes SET air_time = ?, air_timezone = ?, air_at = ?, air_time_source = ?, updated_at = datetime('now')
    WHERE id = ? AND air_at IS NULL
  `)
  const tx = getDb().transaction(() => {
    for (const row of rows) {
      const airtime = deriveEpisodeAirtime(row.air_date, row.air_time, timezone)
      if (airtime.airAt) update.run(airtime.airTime, airtime.airTimezone, airtime.airAt, airtime.airTimeSource, row.id)
    }
  })
  tx()
}

/** Keep durable state aligned with currently monitored, still-wanted episodes. */
export function syncNewReleaseSearchState(): void {
  backfillAirtimes()
  const db = getDb()
  const episodes = db.prepare(`
    SELECT e.id, e.air_at
    FROM episodes e
    JOIN series s ON s.id = e.series_id
    JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
    WHERE s.monitored = 1 AND se.monitored = 1 AND e.monitored = 1
      AND e.status IN ('wanted', 'missing') AND e.file_path IS NULL AND e.air_at IS NOT NULL
  `).all() as Array<{ id: number; air_at: string }>
  const read = db.prepare('SELECT episode_id, air_at, phase, next_run_at FROM new_release_search_state WHERE episode_id = ?')
  const insert = db.prepare(`
    INSERT INTO new_release_search_state (episode_id, air_at, phase, next_run_at)
    VALUES (?, ?, 'pending', ?)
  `)
  const reset = db.prepare(`
    UPDATE new_release_search_state
    SET air_at = ?, phase = 'pending', next_run_at = ?, rss_attempts = 0, targeted_attempts = 0,
        last_run_at = NULL, last_result = NULL, last_error = NULL, completed_at = NULL, updated_at = datetime('now')
    WHERE episode_id = ?
  `)
  const settings = getReleaseMonitoringSettings()
  const tx = db.transaction(() => {
    for (const episode of episodes) {
      const air = Date.parse(episode.air_at)
      if (!Number.isFinite(air)) continue
      const next = air + settings.rapidStartDelayMinutes * 60_000
      const state = read.get(episode.id) as SearchState | undefined
      if (!state) insert.run(episode.id, episode.air_at, next)
      else if (state.air_at !== episode.air_at || state.phase === 'complete' || state.phase === 'cancelled') {
        // A failed acquisition is returned to wanted/missing by the download
        // monitor. Re-open its release window so it can be found again.
        reset.run(episode.air_at, next, episode.id)
      }
    }
    db.prepare(`
      UPDATE new_release_search_state AS nr
      SET phase = CASE
            WHEN EXISTS (SELECT 1 FROM episodes e WHERE e.id = nr.episode_id AND (e.file_path IS NOT NULL OR e.status NOT IN ('wanted','missing'))) THEN 'complete'
            ELSE 'cancelled'
          END,
          completed_at = COALESCE(completed_at, ?), updated_at = datetime('now')
      WHERE phase NOT IN ('complete','cancelled','backlog') AND NOT EXISTS (
        SELECT 1 FROM episodes e
        JOIN series s ON s.id = e.series_id
        JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
        WHERE e.id = nr.episode_id AND e.monitored = 1 AND se.monitored = 1 AND s.monitored = 1
          AND e.status IN ('wanted','missing') AND e.file_path IS NULL
      )
    `).run(Date.now())
  })
  tx()
}

function transitionPhases(now: number): void {
  const db = getDb()
  const states = db.prepare(`
    SELECT episode_id, air_at, phase, next_run_at FROM new_release_search_state
    WHERE phase IN ('pending','rss','targeted')
  `).all() as SearchState[]
  const update = db.prepare(`
    UPDATE new_release_search_state SET phase = ?, next_run_at = ?, updated_at = datetime('now') WHERE episode_id = ?
  `)
  const tx = db.transaction(() => {
    for (const state of states) {
      const t = timings(state.air_at)
      if (!Number.isFinite(t.air)) continue
      if (now >= t.searchEnd) {
        update.run('backlog', now, state.episode_id)
      } else if (now >= t.rssEnd) {
        const firstTargeted = t.rssEnd + t.targetedInterval
        update.run('targeted', state.phase === 'targeted' ? state.next_run_at : firstTargeted, state.episode_id)
      } else if (now >= t.rssStart && state.phase === 'pending') {
        update.run('rss', Math.min(state.next_run_at, now), state.episode_id)
      }
    }
  })
  tx()
}

/** Claim all episodes covered by one coalesced forced RSS refresh. */
export function claimDueRssEpisodes(now = Date.now()): number[] {
  const settings = getReleaseMonitoringSettings()
  if (!settings.rapidPollingEnabled) return []
  syncNewReleaseSearchState()
  transitionPhases(now)
  const rows = getDb().prepare(`
    SELECT nr.episode_id, nr.air_at, nr.phase, nr.next_run_at
    FROM new_release_search_state nr
    JOIN episodes e ON e.id = nr.episode_id
    JOIN series s ON s.id = e.series_id
    JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
    WHERE nr.phase = 'rss' AND nr.next_run_at <= ?
      AND e.monitored = 1 AND se.monitored = 1 AND s.monitored = 1
      AND e.status IN ('wanted','missing') AND e.file_path IS NULL
    ORDER BY nr.next_run_at ASC LIMIT 250
  `).all(now) as SearchState[]
  if (rows.length === 0) return []
  const update = getDb().prepare(`
    UPDATE new_release_search_state
    SET rss_attempts = rss_attempts + 1, last_run_at = ?, next_run_at = ?, last_error = NULL, updated_at = datetime('now')
    WHERE episode_id = ? AND phase = 'rss'
  `)
  const tx = getDb().transaction(() => {
    for (const row of rows) update.run(now, now + timings(row.air_at).rssInterval, row.episode_id)
  })
  tx()
  return rows.map(row => row.episode_id)
}

export function recordReleaseRssOutcome(
  episodeIds: number[],
  outcome: { indexers: number; fetched: number; grabbed: number; errors: string[] },
  now = Date.now(),
): void {
  if (episodeIds.length === 0) return
  const db = getDb()
  const episode = db.prepare('SELECT status, file_path FROM episodes WHERE id = ?')
  const complete = db.prepare(`
    UPDATE new_release_search_state SET phase = 'complete', completed_at = ?, last_result = ?, last_error = NULL, updated_at = datetime('now')
    WHERE episode_id = ?
  `)
  const pending = db.prepare(`
    UPDATE new_release_search_state SET last_result = ?, last_error = ?, updated_at = datetime('now') WHERE episode_id = ?
  `)
  const result = `${outcome.indexers} indexers, ${outcome.fetched} releases, ${outcome.grabbed} grabs`
  const error = outcome.errors.length > 0 ? outcome.errors.join('; ').slice(0, 2000) : null
  const tx = db.transaction(() => {
    for (const id of episodeIds) {
      const row = episode.get(id) as { status: string; file_path: string | null } | undefined
      if (!row || row.file_path || !['wanted', 'missing'].includes(row.status)) complete.run(now, result, id)
      else pending.run(result, error, id)
    }
  })
  tx()
}

async function runTargetedSearch(state: SearchState, now: number): Promise<void> {
  const db = getDb()
  targetedInFlight.add(state.episode_id)
  try {
    const result = await searchNewReleaseEpisode(state.episode_id)
    const current = db.prepare('SELECT status, file_path FROM episodes WHERE id = ?').get(state.episode_id) as { status: string; file_path: string | null } | undefined
    if (!current || current.file_path || !['wanted', 'missing'].includes(current.status) || result.grabbed > 0) {
      db.prepare(`
        UPDATE new_release_search_state SET phase = 'complete', targeted_attempts = targeted_attempts + 1,
          last_run_at = ?, last_result = ?, last_error = NULL, completed_at = ?, updated_at = datetime('now')
        WHERE episode_id = ?
      `).run(now, result.message, now, state.episode_id)
      recordEvent({ category: 'new-release-search', action: 'complete', subjectType: 'episode', subjectId: String(state.episode_id), message: result.message, data: result })
    } else {
      const next = now + timings(state.air_at).targetedInterval
      db.prepare(`
        UPDATE new_release_search_state SET targeted_attempts = targeted_attempts + 1,
          last_run_at = ?, next_run_at = ?, last_result = ?, last_error = NULL, updated_at = datetime('now')
        WHERE episode_id = ? AND phase = 'targeted'
      `).run(now, next, result.message, state.episode_id)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const next = now + timings(state.air_at).targetedInterval
    db.prepare(`
      UPDATE new_release_search_state SET targeted_attempts = targeted_attempts + 1,
        last_run_at = ?, next_run_at = ?, last_error = ?, updated_at = datetime('now')
      WHERE episode_id = ? AND phase = 'targeted'
    `).run(now, next, message.slice(0, 2000), state.episode_id)
    logger.warn(`Targeted search failed for episode ${state.episode_id}: ${message}`)
  } finally {
    targetedInFlight.delete(state.episode_id)
  }
}

async function tick(now = Date.now()): Promise<void> {
  if (running || !getReleaseMonitoringSettings().rapidPollingEnabled) return
  running = true
  try {
    syncNewReleaseSearchState()
    transitionPhases(now)
    const available = Math.max(0, MAX_TARGETED_CONCURRENT - targetedInFlight.size)
    if (available === 0) return
    const due = getDb().prepare(`
      SELECT nr.episode_id, nr.air_at, nr.phase, nr.next_run_at
      FROM new_release_search_state nr
      JOIN episodes e ON e.id = nr.episode_id
      JOIN series s ON s.id = e.series_id
      JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
      WHERE nr.phase = 'targeted' AND nr.next_run_at <= ?
        AND e.monitored = 1 AND se.monitored = 1 AND s.monitored = 1
        AND e.status IN ('wanted','missing') AND e.file_path IS NULL
      ORDER BY nr.next_run_at ASC LIMIT ?
    `).all(now, available) as SearchState[]
    await Promise.all(due.filter(row => !targetedInFlight.has(row.episode_id)).map(row => runTargetedSearch(row, now)))
  } finally {
    running = false
  }
}

export function startNewReleaseSearchScheduler(): void {
  if (timer) return
  logger.info('Starting post-air release scheduler (RSS then targeted search)')
  startupTimer = setTimeout(() => { startupTimer = null; void tick() }, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  timer = setInterval(() => { void tick() }, TICK_INTERVAL_MS)
  timer.unref?.()
}

export function stopNewReleaseSearchScheduler(): void {
  if (startupTimer) clearTimeout(startupTimer)
  if (timer) clearInterval(timer)
  startupTimer = null
  timer = null
}
