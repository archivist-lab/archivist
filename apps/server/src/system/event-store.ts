import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { getSseBus } from './sse.js'
import { signalJobQueued } from './job-signal.js'

/**
 * Persistent system jobs and events over the unified database. Port of the
 * legacy system-store: same tables, same claiming/retry/cancel semantics.
 * The tables themselves are created by @archivist/db's schema.
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type EventSeverity = 'debug' | 'info' | 'warn' | 'error'

export interface JobRecord {
  id: number
  type: string
  status: JobStatus
  subjectType: string | null
  subjectId: string | null
  priority: number
  attempts: number
  maxAttempts: number
  payload: string
  lastError: string | null
  availableAt: string
  lockedAt: string | null
  leaseOwner: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface EventRecord {
  id: number
  ts: string
  category: string
  action: string
  severity: EventSeverity
  subjectType: string | null
  subjectId: string | null
  message: string
  data: string
}

const locallyEmittedEventIds = new Set<number>()

export function consumeLocallyEmittedEvent(id: number): boolean {
  return locallyEmittedEventIds.delete(id)
}

export function recordEvent(input: {
  category: string
  action: string
  severity?: EventSeverity
  subjectType?: string
  subjectId?: string
  message: string
  data?: unknown
}, db: Database = getDb()): void {
  const result = db.prepare(`
    INSERT INTO system_events (category, action, severity, subject_type, subject_id, message, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.category,
    input.action,
    input.severity ?? 'info',
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.message,
    JSON.stringify(input.data ?? {}),
  )
  if (process.env.ARCHIVIST_PROCESS_ROLE !== 'worker') {
    locallyEmittedEventIds.add(Number(result.lastInsertRowid))
  }
  try {
    getSseBus().emit(`${input.category}:${input.action}`, {
      category: input.category,
      action: input.action,
      severity: input.severity ?? 'info',
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      message: input.message,
      data: input.data ?? {},
    })
  } catch {
    // SSE fanout must never break event recording.
  }
}

export function startJob(input: {
  type: string
  subjectType?: string
  subjectId?: string
  payload?: unknown
  maxAttempts?: number
  priority?: number
}, db: Database = getDb()): number {
  const result = db.prepare(`
    INSERT INTO system_jobs (type, status, subject_type, subject_id, priority, attempts, max_attempts, payload, started_at)
    VALUES (?, 'running', ?, ?, ?, 1, ?, ?, datetime('now'))
  `).run(
    input.type,
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.priority ?? 50,
    input.maxAttempts ?? 3,
    JSON.stringify(input.payload ?? {}),
  )
  return Number(result.lastInsertRowid)
}

export function enqueueJob(input: {
  type: string
  subjectType?: string
  subjectId?: string
  payload?: unknown
  maxAttempts?: number
  priority?: number
  availableAt?: Date
}, db: Database = getDb()): number {
  const result = db.prepare(`
    INSERT INTO system_jobs (type, status, subject_type, subject_id, priority, max_attempts, payload, available_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?)
  `).run(
    input.type,
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.priority ?? 50,
    input.maxAttempts ?? 3,
    JSON.stringify(input.payload ?? {}),
    (input.availableAt ?? new Date()).toISOString(),
  )
  // Wake the worker process now rather than letting it find this on its next
  // poll. Work scheduled for later (a retry backoff) has nothing to wake for.
  if (!input.availableAt || input.availableAt.getTime() <= Date.now()) signalJobQueued(db)
  return Number(result.lastInsertRowid)
}

export function enqueueUniqueJob(input: {
  type: string
  subjectType?: string
  subjectId?: string
  payload?: unknown
  maxAttempts?: number
  priority?: number
  availableAt?: Date
}, db: Database = getDb()): number | null {
  const enqueue = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM system_jobs
      WHERE type = ?
        AND COALESCE(subject_type, '') = COALESCE(?, '')
        AND COALESCE(subject_id, '') = COALESCE(?, '')
        AND status IN ('queued', 'running')
      ORDER BY id DESC LIMIT 1
    `).get(input.type, input.subjectType ?? null, input.subjectId ?? null) as { id: number } | undefined
    if (existing) return null
    return enqueueJob(input, db)
  })
  // IMMEDIATE serialises the read-before-insert decision across SQLite
  // connections instead of relying only on this process's event loop.
  return enqueue.immediate()
}

export function claimNextJob(types?: string[], db: Database = getDb(), leaseOwner?: string): JobRecord | null {
  // An explicitly empty allow-list means that no handlers are ready. Treating
  // it as an omitted filter can claim arbitrary work during application boot.
  if (types && types.length === 0) return null
  const whereType = types && types.length > 0 ? `AND type IN (${types.map(() => '?').join(',')})` : ''
  const args = types && types.length > 0 ? types : []
  const claim = db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM system_jobs
      WHERE status = 'queued'
        AND available_at <= ?
        ${whereType}
      ORDER BY priority DESC, available_at ASC, id ASC
      LIMIT 1
    `).get(new Date().toISOString(), ...args) as { id: number } | undefined
    if (!row) return null

    const result = db.prepare(`
      UPDATE system_jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = datetime('now'),
          lease_owner = ?,
          started_at = COALESCE(started_at, datetime('now')),
          finished_at = NULL,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `).run(leaseOwner ?? null, row.id)
    if (result.changes !== 1) return null
    return getJob(row.id, db)
  })
  return claim.immediate()
}

/** Atomically claims a known queued job for a specialised bounded worker. */
export function claimJob(id: number, db: Database = getDb(), leaseOwner?: string): JobRecord | null {
  const claim = db.transaction(() => {
    const result = db.prepare(`
      UPDATE system_jobs
      SET status = 'running', attempts = attempts + 1,
          locked_at = datetime('now'), lease_owner = ?,
          started_at = COALESCE(started_at, datetime('now')),
          finished_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'queued' AND available_at <= ?
    `).run(leaseOwner ?? null, id, new Date().toISOString())
    return result.changes === 1 ? getJob(id, db) : null
  })
  return claim.immediate()
}

/** Moves malformed or otherwise unclaimable queued work to a visible terminal state. */
export function rejectQueuedJob(id: number, error: string, db: Database = getDb()): boolean {
  const result = db.prepare(`
    UPDATE system_jobs
    SET status = 'failed', last_error = ?, locked_at = NULL,
        updated_at = datetime('now'), finished_at = datetime('now')
    WHERE id = ? AND status = 'queued'
  `).run(error, id)
  return result.changes === 1
}

export function getJob(id: number, db: Database = getDb()): JobRecord | null {
  return db.prepare(`
    SELECT id, type, status, subject_type as subjectType, subject_id as subjectId, priority,
           attempts, max_attempts as maxAttempts, payload, last_error as lastError,
           available_at as availableAt, locked_at as lockedAt, lease_owner as leaseOwner,
           created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
    FROM system_jobs
    WHERE id = ?
  `).get(id) as JobRecord | null
}

export function finishJob(id: number, status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>, error?: string, db: Database = getDb(), leaseOwner?: string): boolean {
  const ownerClause = leaseOwner ? 'AND lease_owner = ?' : ''
  const result = db.prepare(`
    UPDATE system_jobs
    SET status = ?, last_error = ?, locked_at = NULL, lease_owner = NULL,
        updated_at = datetime('now'), finished_at = datetime('now')
    WHERE id = ? AND status = 'running' ${ownerClause}
  `).run(status, error ?? null, id, ...(leaseOwner ? [leaseOwner] : []))
  return result.changes === 1
}

export function completeJob(id: number, db: Database = getDb(), leaseOwner?: string): boolean {
  return finishJob(id, 'succeeded', undefined, db, leaseOwner)
}

/** Refreshes ownership for a live durable job without changing its state. */
export function heartbeatJob(id: number, db: Database = getDb(), leaseOwner?: string): boolean {
  const ownerClause = leaseOwner ? 'AND lease_owner = ?' : ''
  const result = db.prepare(`
    UPDATE system_jobs
    SET locked_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status = 'running' ${ownerClause}
  `).run(id, ...(leaseOwner ? [leaseOwner] : []))
  return result.changes === 1
}

export function failJob(id: number, error: string, db: Database = getDb(), leaseOwner?: string): void {
  const job = getJob(id, db)
  if (!job || job.status !== 'running') return
  if (job.attempts < job.maxAttempts) {
    const delayMs = Math.min(60_000, 1000 * Math.pow(2, Math.max(0, job.attempts - 1)))
    db.prepare(`
      UPDATE system_jobs
      SET status = 'queued',
          last_error = ?,
          available_at = ?,
          locked_at = NULL,
          lease_owner = NULL,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'running' ${leaseOwner ? 'AND lease_owner = ?' : ''}
    `).run(error, new Date(Date.now() + delayMs).toISOString(), id, ...(leaseOwner ? [leaseOwner] : []))
    return
  }
  finishJob(id, 'failed', error, db, leaseOwner)
}

export function cancelJob(id: number, db: Database = getDb()): void {
  db.prepare(`
    UPDATE system_jobs
    SET status = 'cancelled', locked_at = NULL, lease_owner = NULL, updated_at = datetime('now'), finished_at = datetime('now')
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(id)
}

/** Cancels queued/running jobs of the given types for one subject. */
export function cancelSubjectJobs(types: string[], subjectType: string, subjectId: string | number, db: Database = getDb()): number {
  if (types.length === 0) return 0
  const result = db.prepare(`
    UPDATE system_jobs
    SET status = 'cancelled', locked_at = NULL, lease_owner = NULL, updated_at = datetime('now'), finished_at = datetime('now')
    WHERE type IN (${types.map(() => '?').join(',')})
      AND subject_type = ? AND subject_id = ?
      AND status IN ('queued', 'running')
  `).run(...types, subjectType, String(subjectId))
  return result.changes
}

export function retryJob(id: number, db: Database = getDb()): void {
  db.prepare(`
    UPDATE system_jobs
    SET status = 'queued',
        attempts = 0,
        available_at = ?,
        locked_at = NULL,
        lease_owner = NULL,
        started_at = NULL,
        finished_at = NULL,
        last_error = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND status IN ('failed', 'cancelled')
  `).run(new Date().toISOString(), id)
}

/**
 * A running row found during single-process application startup cannot still
 * have a live owner. Requeue it immediately rather than waiting for the daily
 * maintenance job, which itself depends on this queue.
 */
export function recoverInterruptedJobs(db: Database = getDb()): number {
  return db.prepare(`
    UPDATE system_jobs
    SET status = 'queued',
        locked_at = NULL,
        lease_owner = NULL,
        available_at = ?,
        updated_at = datetime('now'),
        last_error = COALESCE(last_error, 'Recovered after application restart')
    WHERE status = 'running'
  `).run(new Date().toISOString()).changes
}

/** Requeues only work whose renewable owner heartbeat has expired. */
export function recoverExpiredJobs(staleAfterMs = 90_000, db: Database = getDb()): number {
  const staleSeconds = Math.max(1, Math.ceil(Math.max(1_000, staleAfterMs) / 1_000))
  return db.prepare(`
    UPDATE system_jobs
    SET status = 'queued',
        locked_at = NULL,
        lease_owner = NULL,
        available_at = ?,
        updated_at = datetime('now'),
        last_error = COALESCE(last_error, 'Recovered after worker lease expired')
    WHERE status = 'running' AND locked_at IS NOT NULL
      AND unixepoch(locked_at) < unixepoch('now') - ?
  `).run(new Date().toISOString(), staleSeconds).changes
}

export function listJobs(limit = 100, db: Database = getDb()): JobRecord[] {
  return db.prepare(`
    SELECT id, type, status, subject_type as subjectType, subject_id as subjectId, priority,
           attempts, max_attempts as maxAttempts, payload, last_error as lastError,
           available_at as availableAt, locked_at as lockedAt, lease_owner as leaseOwner,
           created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
    FROM system_jobs
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 500))) as JobRecord[]
}

export function listJobsPage(input: {
  limit?: number
  beforeId?: number
  status?: JobStatus
  type?: string
} = {}, db: Database = getDb()): JobRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []
  if (input.beforeId && input.beforeId > 0) {
    clauses.push('id < ?')
    params.push(input.beforeId)
  }
  if (input.status) {
    clauses.push('status = ?')
    params.push(input.status)
  }
  if (input.type?.trim()) {
    clauses.push('type = ?')
    params.push(input.type.trim())
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500))
  return db.prepare(`
    SELECT id, type, status, subject_type as subjectType, subject_id as subjectId, priority,
           attempts, max_attempts as maxAttempts, payload, last_error as lastError,
           available_at as availableAt, locked_at as lockedAt, lease_owner as leaseOwner,
           created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
    FROM system_jobs
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, limit) as JobRecord[]
}

export interface JobQueueMetric {
  type: string
  status: JobStatus
  count: number
  oldestAt: string | null
}

export function jobQueueMetrics(db: Database = getDb()): JobQueueMetric[] {
  return db.prepare(`
    SELECT type, status, COUNT(*) AS count, MIN(created_at) AS oldestAt
    FROM system_jobs
    GROUP BY type, status
    ORDER BY type, status
  `).all() as JobQueueMetric[]
}

export function listEvents(limit = 200, db: Database = getDb()): EventRecord[] {
  return db.prepare(`
    SELECT id, ts, category, action, severity, subject_type as subjectType, subject_id as subjectId, message, data
    FROM system_events
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 1000))) as EventRecord[]
}
