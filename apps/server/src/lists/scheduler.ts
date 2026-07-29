import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { queueListRefresh } from './engine.js'

const logger = createLogger('ListsScheduler')
const TICK_INTERVAL_MS = 60_000
const STARTUP_DELAY_MS = 15_000
const MAX_CONCURRENT_REFRESH = 2
const BACKOFF_MAX_MS = 60 * 60 * 1000

let startup: ReturnType<typeof setTimeout> | null = null
let timer: ReturnType<typeof setInterval> | null = null

interface DueList {
  id: number
  last_refreshed_at: string | null
  refresh_interval_hours: number
  consecutive_failures: number
  last_attempt_at: string | null
}

export function listRefreshDue(row: DueList, now = Date.now()): boolean {
  const lastRefresh = row.last_refreshed_at ? Date.parse(row.last_refreshed_at) : 0
  const normalDue = lastRefresh === 0 ? 0 : lastRefresh + row.refresh_interval_hours * 60 * 60 * 1000
  const failures = Math.max(0, row.consecutive_failures)
  const lastAttempt = row.last_attempt_at ? Date.parse(row.last_attempt_at) : 0
  const backoff = failures > 0 && lastAttempt > 0
    ? lastAttempt + Math.min(60_000 * 2 ** (failures - 1), BACKOFF_MAX_MS)
    : 0
  return Math.max(normalDue, backoff) <= now
}

export function tickListScheduler(): number {
  const db = getDb()
  const active = (db.prepare("SELECT COUNT(*) AS count FROM system_jobs WHERE type = 'list.refresh' AND status IN ('queued', 'running')").get() as { count: number }).count
  let available = Math.max(0, MAX_CONCURRENT_REFRESH - active)
  if (!available) return 0
  const rows = db.prepare(`
    SELECT l.id, l.last_refreshed_at, l.refresh_interval_hours, l.consecutive_failures,
      (SELECT MAX(r.finished_at) FROM list_refresh_runs r WHERE r.list_id = l.id) AS last_attempt_at
    FROM lists l WHERE l.enabled = 1 ORDER BY COALESCE(l.last_refreshed_at, '') ASC, l.id ASC
  `).all() as DueList[]
  let queued = 0
  for (const row of rows) {
    if (!available || !listRefreshDue(row)) continue
    if (queueListRefresh(row.id, db) != null) {
      queued += 1
      available -= 1
    }
  }
  return queued
}

export function startListScheduler(): void {
  if (startup || timer) return
  startup = setTimeout(() => {
    startup = null
    try { tickListScheduler() } catch (error) { logger.error('Initial Lists refresh failed:', error) }
    timer = setInterval(() => {
      try { tickListScheduler() } catch (error) { logger.error('Lists scheduler tick failed:', error) }
    }, TICK_INTERVAL_MS)
    timer.unref?.()
  }, STARTUP_DELAY_MS)
  startup.unref?.()
}

export function stopListScheduler(): void {
  if (startup) clearTimeout(startup)
  if (timer) clearInterval(timer)
  startup = null
  timer = null
}
