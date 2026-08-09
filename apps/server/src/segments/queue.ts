import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { cancelJob as cancelSystemJob, claimJob, completeJob, enqueueUniqueJob, failJob, getJob, heartbeatJob, recordEvent, rejectQueuedJob } from '../system/event-store.js'
import { analyseSeason, DETECTOR_VERSION, markSeasonAnalysis, segmentDatabaseStatus } from './detector.js'
import { getSegmentSettings, segmentToolAvailability } from './settings.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

const logger = createLogger('SegmentQueue')

interface SegmentJob { systemJobId: number; seriesId: number; seasonNumber: number; key: string; title: string }
const queue: SegmentJob[] = []
const pending = new Set<string>()
interface RunningSegmentJob { job: SegmentJob; controller: AbortController; done: Promise<void>; progress: number; stage: string; completed: number; total: number; startedAt: number }
const active = new Map<string, RunningSegmentJob>()
let stopped = false
let paused = false
let recoveryTimer: ReturnType<typeof setInterval> | null = null
let controlTimer: ReturnType<typeof setInterval> | null = null
let queueStarted = false

const keyOf = (seriesId: number, seasonNumber: number) => `${seriesId}:${seasonNumber}`

function pump(): void {
  try { paused = getAppSetting('segmentQueuePaused', paused, 0) } catch {}
  if (!queueStarted || stopped || paused) return
  const concurrency = getSegmentSettings().concurrency
  while (active.size < concurrency && queue.length > 0) {
    const job = queue.shift()!
    if (!claimJob(job.systemJobId)) {
      pending.delete(job.key)
      continue
    }
    const controller = new AbortController()
    const running: RunningSegmentJob = { job, controller, done: Promise.resolve(), progress: 0, stage: 'Starting', completed: 0, total: 0, startedAt: Date.now() }
    active.set(job.key, running)
    running.done = analyseSeason(job.seriesId, job.seasonNumber, controller.signal, update => {
      running.progress = update.progress
      running.stage = update.stage
      running.completed = update.completed
      running.total = update.total
    })
      .then(result => {
        completeJob(job.systemJobId)
        recordEvent({
          category: 'segments', action: 'analysed', subjectType: 'season', subjectId: job.key,
          message: `Segment analysis completed for ${job.key}`, data: result,
        })
      })
      .catch(error => {
        const cancelled = controller.signal.aborted
        const message = error instanceof Error ? error.message : String(error)
        markSeasonAnalysis(job.seriesId, job.seasonNumber, cancelled ? 'cancelled' : 'failed', message)
        if (!cancelled && getJob(job.systemJobId)?.status === 'running') failJob(job.systemJobId, message)
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

function addLocalJob(systemJobId: number, seriesId: number, seasonNumber: number, priority: 'high' | 'normal' = 'normal'): boolean {
  const key = keyOf(seriesId, seasonNumber)
  if (pending.has(key)) return false
  pending.add(key)
  const series = getDb().prepare('SELECT title FROM series WHERE id = ?').get(seriesId) as { title: string } | undefined
  const job: SegmentJob = { systemJobId, seriesId, seasonNumber, key, title: `${series?.title ?? `Series ${seriesId}`} · Season ${seasonNumber}` }
  if (priority === 'high') queue.unshift(job)
  else queue.push(job)
  return true
}

function loadDurableSegmentJobs(): void {
  const rows = getDb().prepare(`
    SELECT id, payload
    FROM system_jobs
    WHERE type = 'media-segments' AND status = 'queued' AND available_at <= ?
    ORDER BY priority DESC, available_at, id
    LIMIT 250
  `).all(new Date().toISOString()) as Array<{ id: number; payload: string }>
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as { seriesId?: number; seasonNumber?: number }
      if (Number.isSafeInteger(payload.seriesId) && Number(payload.seriesId) > 0
        && Number.isSafeInteger(payload.seasonNumber) && Number(payload.seasonNumber) >= 0) {
        addLocalJob(row.id, Number(payload.seriesId), Number(payload.seasonNumber))
      } else {
        rejectQueuedJob(row.id, 'Invalid payload in durable segment job')
      }
    } catch {
      rejectQueuedJob(row.id, 'Malformed JSON payload in durable segment job')
    }
  }
  pump()
}

export function enqueueSeason(seriesId: number, seasonNumber: number, options: { priority?: 'high' | 'normal'; force?: boolean } = {}): boolean {
  const settings = getSegmentSettings()
  if (!options.force && !settings.enabled) return false
  if (!options.force) {
    const retry = getDb().prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE
               WHEN l.episode_id IS NULL OR s.media_signature IS NULL THEN 1
               WHEN l.file_path != e.file_path OR (e.file_size IS NOT NULL AND l.file_size != e.file_size) THEN 1
               WHEN s.manually_locked = 1 THEN 0
               WHEN s.detector_version IS NULL OR s.detector_version != ? THEN 1
               WHEN s.analysis_state IN ('pending','queued','analysing') THEN 1
               WHEN s.analysis_state IN ('failed','cancelled') AND s.attempts < ? THEN 1
               ELSE 0
             END) AS eligible
      FROM episodes e
      LEFT JOIN media_segment_links l ON l.episode_id = e.id
      LEFT JOIN media_segments s ON s.media_signature = l.media_signature
      WHERE e.series_id = ? AND e.season_number = ? AND e.file_path IS NOT NULL
    `).get(DETECTOR_VERSION, settings.maxAttempts, seriesId, seasonNumber) as { total: number; eligible: number | null }
    if (retry.total > 0 && (retry.eligible ?? 0) === 0) return false
  }
  const key = keyOf(seriesId, seasonNumber)
  if (pending.has(key)) return false
  if (options.force) {
    getDb().prepare(`
      UPDATE media_segments SET analysis_set_hash = NULL, analysis_state = 'pending', last_error = NULL, updated_at = datetime('now')
      WHERE manually_locked = 0 AND media_signature IN (
        SELECT l.media_signature FROM media_segment_links l
        JOIN episodes e ON e.id = l.episode_id
        WHERE e.series_id = ? AND e.season_number = ?
      )
    `).run(seriesId, seasonNumber)
  }
  const priority = options.priority ?? 'normal'
  let systemJobId = enqueueUniqueJob({
    type: 'media-segments', subjectType: 'season', subjectId: key,
    payload: { seriesId, seasonNumber }, priority: priority === 'high' ? 100 : 25,
    maxAttempts: settings.maxAttempts,
  })
  if (systemJobId == null) {
    const existing = getDb().prepare(`
      SELECT id FROM system_jobs
      WHERE type = 'media-segments' AND subject_type = 'season' AND subject_id = ?
        AND status IN ('queued','running') ORDER BY id DESC LIMIT 1
    `).get(key) as { id: number } | undefined
    systemJobId = existing?.id ?? null
  }
  if (systemJobId == null) return false
  if (queueStarted && !addLocalJob(systemJobId, seriesId, seasonNumber, priority)) return false
  getDb().prepare(`
    UPDATE media_segments SET analysis_state = 'queued', updated_at = datetime('now')
    WHERE media_signature IN (
      SELECT l.media_signature FROM media_segment_links l
      JOIN episodes e ON e.id = l.episode_id
      WHERE e.series_id = ? AND e.season_number = ?
    ) AND analysis_state IN ('pending','failed','cancelled')
  `).run(seriesId, seasonNumber)
  pump()
  return true
}

export function enqueueSeasonForEpisode(episodeId: number, options: { priority?: 'high' | 'normal' } = {}): boolean {
  const row = getDb().prepare('SELECT series_id, season_number FROM episodes WHERE id = ?').get(episodeId) as { series_id: number; season_number: number } | undefined
  return row ? enqueueSeason(row.series_id, row.season_number, options) : false
}

export function sweepUnanalysedSeasons(options: { force?: boolean } = {}): number {
  if (!options.force && !getSegmentSettings().enabled) return 0
  const settings = getSegmentSettings()
  const configuredLimit = Number(process.env.ARCHIVIST_SEGMENT_SWEEP_MAX)
  const limit = Number.isFinite(configuredLimit) ? Math.min(500, Math.max(1, Math.floor(configuredLimit))) : 50
  const rows = getDb().prepare(`
    SELECT e.series_id, e.season_number
    FROM episodes e
    LEFT JOIN media_segment_links l ON l.episode_id = e.id
    LEFT JOIN media_segments s ON s.media_signature = l.media_signature
    WHERE e.file_path IS NOT NULL AND e.season_number >= 0
    GROUP BY e.series_id, e.season_number
    HAVING SUM(CASE
      WHEN l.episode_id IS NULL OR s.media_signature IS NULL THEN 1
      WHEN l.file_path != e.file_path OR (e.file_size IS NOT NULL AND l.file_size != e.file_size) THEN 1
      WHEN s.manually_locked = 1 THEN 0
      WHEN s.detector_version IS NULL OR s.detector_version != ? THEN 1
      WHEN s.analysis_state IN ('pending','queued','analysing') THEN 1
      WHEN s.analysis_state IN ('failed','cancelled') AND s.attempts < ? THEN 1
      ELSE 0
    END) > 0
    ORDER BY e.series_id, e.season_number
    LIMIT ?
  `).all(DETECTOR_VERSION, settings.maxAttempts, limit) as Array<{ series_id: number; season_number: number }>
  let enqueued = 0
  for (const row of rows) if (enqueueSeason(row.series_id, row.season_number, { force: options.force })) enqueued++
  return enqueued
}

export function cancelSegmentAnalysis(key?: string): number {
  const rows = getDb().prepare(`
    SELECT id,subject_id,payload FROM system_jobs
    WHERE type='media-segments' AND status IN ('queued','running')
      AND (? IS NULL OR subject_id=?)
  `).all(key ?? null, key ?? null) as Array<{ id: number; subject_id: string; payload: string }>
  for (const row of rows) {
    cancelSystemJob(row.id)
    let [seriesId, seasonNumber] = row.subject_id.split(':').map(Number)
    try {
      const payload = JSON.parse(row.payload) as { seriesId?: number; seasonNumber?: number }
      seriesId = Number(payload.seriesId ?? seriesId)
      seasonNumber = Number(payload.seasonNumber ?? seasonNumber)
    } catch {}
    if (Number.isSafeInteger(seriesId) && Number.isSafeInteger(seasonNumber)) markSeasonAnalysis(seriesId, seasonNumber, 'cancelled')
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    if (key && queue[i].key !== key) continue
    const [job] = queue.splice(i, 1)
    pending.delete(job.key)
  }
  for (const [activeKey, running] of active) {
    if (key && activeKey !== key) continue
    running.controller.abort()
  }
  return rows.length
}

export function segmentQueueStatus() {
  if (!queueStarted) {
    const rows = getDb().prepare(`
      SELECT subject_id,payload,status,started_at FROM system_jobs
      WHERE type='media-segments' AND status IN ('queued','running')
      ORDER BY priority DESC,available_at,id
    `).all() as Array<{ subject_id: string; payload: string; status: 'queued' | 'running'; started_at: string | null }>
    const items = rows.map(row => {
      let seriesId = Number(row.subject_id.split(':')[0])
      let seasonNumber = Number(row.subject_id.split(':')[1])
      try {
        const value = JSON.parse(row.payload) as { seriesId?: number; seasonNumber?: number }
        seriesId = Number(value.seriesId ?? seriesId)
        seasonNumber = Number(value.seasonNumber ?? seasonNumber)
      } catch {}
      const title = Number.isSafeInteger(seriesId) && Number.isSafeInteger(seasonNumber)
        ? `${(getDb().prepare('SELECT title FROM series WHERE id=?').get(seriesId) as { title?: string } | undefined)?.title ?? `Series ${seriesId}`} · Season ${seasonNumber}`
        : row.subject_id
      return {
        id: row.subject_id, title, status: row.status, progress: 0,
        detail: row.status === 'running' ? 'Analysing season' : `Season ${seasonNumber}`,
        startedAt: row.started_at ? Date.parse(row.started_at) : null,
      }
    })
    return {
      enabled: getSegmentSettings().enabled,
      concurrency: getSegmentSettings().concurrency,
      queued: items.filter(item => item.status === 'queued').length,
      active: items.filter(item => item.status === 'running').length,
      activeKeys: items.filter(item => item.status === 'running').map(item => item.id),
      paused,
      queuedItems: items.filter(item => item.status === 'queued'),
      activeItems: items.filter(item => item.status === 'running'),
      tools: segmentToolAvailability(),
      database: segmentDatabaseStatus(),
    }
  }
  return {
    enabled: getSegmentSettings().enabled,
    concurrency: getSegmentSettings().concurrency,
    queued: queue.length,
    active: active.size,
    activeKeys: [...active.keys()],
    paused,
    queuedItems: queue.map(job => ({ id: job.key, title: job.title, status: 'queued' as const, progress: 0, detail: `Season ${job.seasonNumber}` })),
    activeItems: [...active.values()].map(running => ({
      id: running.job.key,
      title: running.job.title,
      status: 'running' as const,
      progress: running.progress,
      detail: running.stage,
      startedAt: running.startedAt,
      completed: running.completed,
      total: running.total,
    })),
    tools: segmentToolAvailability(),
    database: segmentDatabaseStatus(),
  }
}

export function setSegmentQueuePaused(value: boolean): boolean {
  paused = value
  try { setAppSetting('segmentQueuePaused', value, 0) } catch {}
  if (!paused) pump()
  return paused
}

export async function shutdownSegments(): Promise<void> {
  queueStarted = false
  stopped = true
  if (recoveryTimer) clearInterval(recoveryTimer)
  if (controlTimer) clearInterval(controlTimer)
  recoveryTimer = null
  controlTimer = null
  const queued = queue.splice(0)
  for (const job of queued) {
    failJob(job.systemJobId, 'Interrupted by application shutdown')
    markSeasonAnalysis(job.seriesId, job.seasonNumber, 'cancelled')
  }
  pending.clear()
  const running = [...active.values()]
  for (const job of running) {
    failJob(job.job.systemJobId, 'Interrupted by application shutdown')
    job.controller.abort()
  }
  await Promise.allSettled(running.map(job => job.done))
}

export function startSegmentQueue(): void {
  stopped = false
  if (recoveryTimer) return
  queueStarted = true
  try { paused = getAppSetting('segmentQueuePaused', false, 0) } catch {}
  loadDurableSegmentJobs()
  recoveryTimer = setInterval(() => {
    loadDurableSegmentJobs()
    if (queue.length < 25) sweepUnanalysedSeasons()
  }, 30_000)
  recoveryTimer.unref?.()
  controlTimer = setInterval(() => {
    for (const running of active.values()) {
      const current = getJob(running.job.systemJobId)
      if (current?.status === 'cancelled') running.controller.abort(new Error('Segment analysis cancelled by user'))
      else if (current?.status === 'running') heartbeatJob(running.job.systemJobId)
    }
  }, 2_000)
  controlTimer.unref?.()
}
