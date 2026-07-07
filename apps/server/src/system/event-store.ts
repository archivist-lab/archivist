import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { getSseBus } from './sse.js'

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
  attempts: number
  maxAttempts: number
  payload: string
  lastError: string | null
  availableAt: string
  lockedAt: string | null
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

export function recordEvent(input: {
  category: string
  action: string
  severity?: EventSeverity
  subjectType?: string
  subjectId?: string
  message: string
  data?: unknown
}, db: Database = getDb()): void {
  db.prepare(`
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
}, db: Database = getDb()): number {
  const result = db.prepare(`
    INSERT INTO system_jobs (type, status, subject_type, subject_id, attempts, max_attempts, payload, started_at)
    VALUES (?, 'running', ?, ?, 1, ?, ?, datetime('now'))
  `).run(
    input.type,
    input.subjectType ?? null,
    input.subjectId ?? null,
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
  availableAt?: Date
}, db: Database = getDb()): number {
  const result = db.prepare(`
    INSERT INTO system_jobs (type, status, subject_type, subject_id, max_attempts, payload, available_at)
    VALUES (?, 'queued', ?, ?, ?, ?, ?)
  `).run(
    input.type,
    input.subjectType ?? null,
    input.subjectId ?? null,
    input.maxAttempts ?? 3,
    JSON.stringify(input.payload ?? {}),
    (input.availableAt ?? new Date()).toISOString(),
  )
  return Number(result.lastInsertRowid)
}

export function enqueueUniqueJob(input: {
  type: string
  subjectType?: string
  subjectId?: string
  payload?: unknown
  maxAttempts?: number
  availableAt?: Date
}, db: Database = getDb()): number | null {
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
}

export function claimNextJob(types?: string[], db: Database = getDb()): JobRecord | null {
  const whereType = types && types.length > 0 ? `AND type IN (${types.map(() => '?').join(',')})` : ''
  const args = types && types.length > 0 ? types : []
  const row = db.prepare(`
    SELECT id FROM system_jobs
    WHERE status = 'queued'
      AND available_at <= ?
      ${whereType}
    ORDER BY id ASC
    LIMIT 1
  `).get(new Date().toISOString(), ...args) as { id: number } | undefined
  if (!row) return null

  const result = db.prepare(`
    UPDATE system_jobs
    SET status = 'running',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        started_at = COALESCE(started_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ? AND status = 'queued'
  `).run(row.id)
  if (result.changes !== 1) return null
  return getJob(row.id, db)
}

export function getJob(id: number, db: Database = getDb()): JobRecord | null {
  return db.prepare(`
    SELECT id, type, status, subject_type as subjectType, subject_id as subjectId,
           attempts, max_attempts as maxAttempts, payload, last_error as lastError,
           available_at as availableAt, locked_at as lockedAt,
           created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
    FROM system_jobs
    WHERE id = ?
  `).get(id) as JobRecord | null
}

export function finishJob(id: number, status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>, error?: string, db: Database = getDb()): void {
  db.prepare(`
    UPDATE system_jobs
    SET status = ?, last_error = ?, updated_at = datetime('now'), finished_at = datetime('now')
    WHERE id = ?
  `).run(status, error ?? null, id)
}

export function completeJob(id: number, db: Database = getDb()): void {
  finishJob(id, 'succeeded', undefined, db)
}

export function failJob(id: number, error: string, db: Database = getDb()): void {
  const job = getJob(id, db)
  if (!job) return
  if (job.attempts < job.maxAttempts) {
    const delayMs = Math.min(60_000, 1000 * Math.pow(2, Math.max(0, job.attempts - 1)))
    db.prepare(`
      UPDATE system_jobs
      SET status = 'queued',
          last_error = ?,
          available_at = ?,
          locked_at = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(error, new Date(Date.now() + delayMs).toISOString(), id)
    return
  }
  finishJob(id, 'failed', error, db)
}

export function cancelJob(id: number, db: Database = getDb()): void {
  db.prepare(`
    UPDATE system_jobs
    SET status = 'cancelled', updated_at = datetime('now'), finished_at = datetime('now')
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(id)
}

/** Cancels queued/running jobs of the given types for one subject. */
export function cancelSubjectJobs(types: string[], subjectType: string, subjectId: string | number, db: Database = getDb()): number {
  if (types.length === 0) return 0
  const result = db.prepare(`
    UPDATE system_jobs
    SET status = 'cancelled', updated_at = datetime('now'), finished_at = datetime('now')
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
        available_at = ?,
        locked_at = NULL,
        finished_at = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND status IN ('failed', 'cancelled')
  `).run(new Date().toISOString(), id)
}

export function listJobs(limit = 100, db: Database = getDb()): JobRecord[] {
  return db.prepare(`
    SELECT id, type, status, subject_type as subjectType, subject_id as subjectId,
           attempts, max_attempts as maxAttempts, payload, last_error as lastError,
           available_at as availableAt, locked_at as lockedAt,
           created_at as createdAt, updated_at as updatedAt, started_at as startedAt, finished_at as finishedAt
    FROM system_jobs
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 500))) as JobRecord[]
}

export function listEvents(limit = 200, db: Database = getDb()): EventRecord[] {
  return db.prepare(`
    SELECT id, ts, category, action, severity, subject_type as subjectType, subject_id as subjectId, message, data
    FROM system_events
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 1000))) as EventRecord[]
}
