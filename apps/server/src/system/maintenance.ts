import type { Database } from 'better-sqlite3'
import { createLogger } from '@archivist/core'
import { defaultDbPath } from '@archivist/db'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'
import { enqueueUniqueJob, recordEvent } from './event-store.js'
import { registerJobHandler } from './job-runner.js'

const logger = createLogger('Maintenance')

export interface MaintenanceConfig {
  enabled: boolean
  intervalHours: number
  jobRetentionDays: number
  eventRetentionDays: number
  importRetentionDays: number
  acquisitionRetentionDays: number
  staleRunningJobMinutes: number
  checkpointDatabases: boolean
}

export interface MaintenanceResult {
  startedAt: string
  finishedAt: string
  recoveredJobs: number
  deletedJobs: number
  deletedEvents: number
  deletedImports: number
  deletedAcquisitionDecisions: number
  checkpointedDatabases: Array<{ path: string; ok: boolean; error?: string }>
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  enabled: true,
  intervalHours: 24,
  jobRetentionDays: 30,
  eventRetentionDays: 30,
  importRetentionDays: 60,
  acquisitionRetentionDays: 30,
  staleRunningJobMinutes: 120,
  checkpointDatabases: true,
}

let scheduler: ReturnType<typeof setInterval> | null = null

function clampConfig(config: MaintenanceConfig): MaintenanceConfig {
  return {
    enabled: !!config.enabled,
    intervalHours: Math.max(1, Math.min(168, Number(config.intervalHours) || DEFAULT_CONFIG.intervalHours)),
    jobRetentionDays: Math.max(1, Math.min(3650, Number(config.jobRetentionDays) || DEFAULT_CONFIG.jobRetentionDays)),
    eventRetentionDays: Math.max(1, Math.min(3650, Number(config.eventRetentionDays) || DEFAULT_CONFIG.eventRetentionDays)),
    importRetentionDays: Math.max(1, Math.min(3650, Number(config.importRetentionDays) || DEFAULT_CONFIG.importRetentionDays)),
    acquisitionRetentionDays: Math.max(1, Math.min(3650, Number(config.acquisitionRetentionDays) || DEFAULT_CONFIG.acquisitionRetentionDays)),
    staleRunningJobMinutes: Math.max(5, Math.min(1440, Number(config.staleRunningJobMinutes) || DEFAULT_CONFIG.staleRunningJobMinutes)),
    checkpointDatabases: !!config.checkpointDatabases,
  }
}

export function getMaintenanceConfig(db: Database = getDb()): MaintenanceConfig {
  return clampConfig(getAppSetting('systemMaintenance', DEFAULT_CONFIG, 0, db))
}

export function setMaintenanceConfig(config: Partial<MaintenanceConfig>, db: Database = getDb()): MaintenanceConfig {
  const merged = clampConfig({ ...getMaintenanceConfig(db), ...config })
  setAppSetting('systemMaintenance', merged, 0, db)
  recordEvent({
    category: 'maintenance',
    action: 'configured',
    message: 'System maintenance settings updated',
    data: merged,
  }, db)
  return merged
}

export function getLastMaintenanceResult(db: Database = getDb()): MaintenanceResult | null {
  return getAppSetting<MaintenanceResult | null>('lastSystemMaintenance', null, 0, db)
}

function deleteOlderThan(db: Database, sql: string, days: number): number {
  return db.prepare(sql).run(`-${days} days`).changes
}

export async function runSystemMaintenance(db: Database = getDb(), config = getMaintenanceConfig(db)): Promise<MaintenanceResult> {
  const startedAt = new Date().toISOString()

  const recoveredJobs = db.prepare(`
    UPDATE system_jobs
    SET status = 'queued',
        locked_at = NULL,
        available_at = ?,
        updated_at = datetime('now'),
        last_error = COALESCE(last_error, 'Recovered stale running job')
    WHERE status = 'running'
      AND locked_at IS NOT NULL
      AND locked_at < datetime('now', ?)
  `).run(new Date().toISOString(), `-${config.staleRunningJobMinutes} minutes`).changes

  const deletedJobs = deleteOlderThan(db, `
    DELETE FROM system_jobs
    WHERE status IN ('succeeded', 'failed', 'cancelled')
      AND COALESCE(finished_at, updated_at, created_at) < datetime('now', ?)
  `, config.jobRetentionDays)

  const deletedEvents = deleteOlderThan(db, `
    DELETE FROM system_events
    WHERE ts < datetime('now', ?)
  `, config.eventRetentionDays)

  const deletedImports = deleteOlderThan(db, `
    DELETE FROM media_imports
    WHERE status IN ('succeeded', 'failed')
      AND updated_at < datetime('now', ?)
  `, config.importRetentionDays)

  const deletedAcquisitionDecisions = deleteOlderThan(db, `
    DELETE FROM acquisition_decisions
    WHERE created_at < datetime('now', ?)
  `, config.acquisitionRetentionDays)

  const checkpointedDatabases: MaintenanceResult['checkpointedDatabases'] = []
  if (config.checkpointDatabases) {
    const path = process.env.ARCHIVIST_DB ?? defaultDbPath()
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
      checkpointedDatabases.push({ path, ok: true })
    } catch (err) {
      checkpointedDatabases.push({ path, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const result: MaintenanceResult = {
    startedAt,
    finishedAt: new Date().toISOString(),
    recoveredJobs,
    deletedJobs,
    deletedEvents,
    deletedImports,
    deletedAcquisitionDecisions,
    checkpointedDatabases,
  }

  setAppSetting('lastSystemMaintenance', result, 0, db)
  recordEvent({
    category: 'maintenance',
    action: 'completed',
    message: 'System maintenance completed',
    data: result,
  }, db)
  return result
}

export function registerMaintenanceJobs(): void {
  registerJobHandler('system-maintenance', async () => {
    await runSystemMaintenance()
  })
}

export function startMaintenanceScheduler(db: Database = getDb(), pollMs = 15 * 60_000): void {
  if (scheduler) return
  const tick = () => {
    try {
      const config = getMaintenanceConfig(db)
      if (!config.enabled) return
      const last = getLastMaintenanceResult(db)
      const lastAt = last?.finishedAt ? new Date(last.finishedAt).getTime() : 0
      if (Date.now() - lastAt < config.intervalHours * 60 * 60_000) return
      const jobId = enqueueUniqueJob({
        type: 'system-maintenance',
        subjectType: 'system',
        subjectId: 'maintenance',
        payload: { scheduled: true },
        maxAttempts: 2,
      }, db)
      if (jobId) logger.info(`Queued system maintenance job #${jobId}`)
    } catch (err) {
      logger.warn('Maintenance scheduler tick failed:', err instanceof Error ? err.message : String(err))
    }
  }
  scheduler = setInterval(tick, pollMs)
  scheduler.unref?.()
  tick()
}

export function stopMaintenanceScheduler(): void {
  if (scheduler) clearInterval(scheduler)
  scheduler = null
}
