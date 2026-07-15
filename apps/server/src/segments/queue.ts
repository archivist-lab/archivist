import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { recordEvent } from '../system/event-store.js'
import { analyseSeason, markSeasonAnalysis, segmentDatabaseStatus } from './detector.js'
import { getSegmentSettings, segmentToolAvailability } from './settings.js'

const logger = createLogger('SegmentQueue')

interface SegmentJob { seriesId: number; seasonNumber: number; key: string }
const queue: SegmentJob[] = []
const pending = new Set<string>()
interface RunningSegmentJob { job: SegmentJob; controller: AbortController; done: Promise<void> }
const active = new Map<string, RunningSegmentJob>()
let stopped = false

const keyOf = (seriesId: number, seasonNumber: number) => `${seriesId}:${seasonNumber}`

function pump(): void {
  if (stopped) return
  const concurrency = getSegmentSettings().concurrency
  while (active.size < concurrency && queue.length > 0) {
    const job = queue.shift()!
    const controller = new AbortController()
    const running: RunningSegmentJob = { job, controller, done: Promise.resolve() }
    active.set(job.key, running)
    running.done = analyseSeason(job.seriesId, job.seasonNumber, controller.signal)
      .then(result => {
        recordEvent({
          category: 'segments', action: 'analysed', subjectType: 'season', subjectId: job.key,
          message: `Segment analysis completed for ${job.key}`, data: result,
        })
      })
      .catch(error => {
        const cancelled = controller.signal.aborted
        const message = error instanceof Error ? error.message : String(error)
        markSeasonAnalysis(job.seriesId, job.seasonNumber, cancelled ? 'cancelled' : 'failed', message)
        recordEvent({
          category: 'segments', action: cancelled ? 'cancelled' : 'failed', severity: cancelled ? 'info' : 'warn',
          subjectType: 'season', subjectId: job.key, message: `Segment analysis ${cancelled ? 'cancelled' : 'failed'} for ${job.key}`,
          data: { error: message },
        })
        if (!cancelled) logger.warn(`Analysis ${job.key} failed: ${message}`)
      })
      .finally(() => {
        active.delete(job.key)
        pending.delete(job.key)
        pump()
      })
  }
}

export function enqueueSeason(seriesId: number, seasonNumber: number, options: { priority?: 'high' | 'normal'; force?: boolean } = {}): boolean {
  const settings = getSegmentSettings()
  if (!options.force && !settings.enabled) return false
  if (!options.force) {
    const retry = getDb().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN l.episode_id IS NULL OR s.last_error IS NULL OR s.attempts < ? THEN 1 ELSE 0 END) AS eligible
      FROM episodes e
      LEFT JOIN media_segment_links l ON l.episode_id = e.id
      LEFT JOIN media_segments s ON s.media_signature = l.media_signature
      WHERE e.series_id = ? AND e.season_number = ? AND e.file_path IS NOT NULL
    `).get(settings.maxAttempts, seriesId, seasonNumber) as { total: number; eligible: number | null }
    if (retry.total > 0 && (retry.eligible ?? 0) === 0) return false
  }
  const key = keyOf(seriesId, seasonNumber)
  if (pending.has(key)) return false
  pending.add(key)
  const job = { seriesId, seasonNumber, key }
  getDb().prepare(`
    UPDATE media_segments SET analysis_state = 'queued', updated_at = datetime('now')
    WHERE media_signature IN (
      SELECT l.media_signature FROM media_segment_links l
      JOIN episodes e ON e.id = l.episode_id
      WHERE e.series_id = ? AND e.season_number = ?
    ) AND analysis_state IN ('pending','failed','cancelled')
  `).run(seriesId, seasonNumber)
  if (options.priority === 'high') queue.unshift(job)
  else queue.push(job)
  pump()
  return true
}

export function enqueueSeasonForEpisode(episodeId: number, options: { priority?: 'high' | 'normal' } = {}): boolean {
  const row = getDb().prepare('SELECT series_id, season_number FROM episodes WHERE id = ?').get(episodeId) as { series_id: number; season_number: number } | undefined
  return row ? enqueueSeason(row.series_id, row.season_number, options) : false
}

export function sweepUnanalysedSeasons(options: { force?: boolean } = {}): number {
  if (!options.force && !getSegmentSettings().enabled) return 0
  const configuredLimit = Number(process.env.ARCHIVIST_SEGMENT_SWEEP_MAX)
  const limit = Number.isFinite(configuredLimit) ? Math.min(500, Math.max(1, Math.floor(configuredLimit))) : 50
  const rows = getDb().prepare(`
    SELECT DISTINCT e.series_id, e.season_number
    FROM episodes e
    WHERE e.file_path IS NOT NULL AND e.season_number >= 0
    ORDER BY e.series_id, e.season_number
    LIMIT ?
  `).all(limit) as Array<{ series_id: number; season_number: number }>
  let enqueued = 0
  for (const row of rows) if (enqueueSeason(row.series_id, row.season_number, { force: options.force })) enqueued++
  return enqueued
}

export function cancelSegmentAnalysis(key?: string): number {
  let cancelled = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    if (key && queue[i].key !== key) continue
    const [job] = queue.splice(i, 1)
    pending.delete(job.key)
    markSeasonAnalysis(job.seriesId, job.seasonNumber, 'cancelled')
    cancelled++
  }
  for (const [activeKey, running] of active) {
    if (key && activeKey !== key) continue
    running.controller.abort()
    cancelled++
  }
  return cancelled
}

export function segmentQueueStatus() {
  return {
    enabled: getSegmentSettings().enabled,
    concurrency: getSegmentSettings().concurrency,
    queued: queue.length,
    active: active.size,
    activeKeys: [...active.keys()],
    tools: segmentToolAvailability(),
    database: segmentDatabaseStatus(),
  }
}

export async function shutdownSegments(): Promise<void> {
  stopped = true
  const queued = queue.splice(0)
  for (const job of queued) markSeasonAnalysis(job.seriesId, job.seasonNumber, 'cancelled')
  pending.clear()
  const running = [...active.values()]
  for (const job of running) job.controller.abort()
  await Promise.allSettled(running.map(job => job.done))
}
