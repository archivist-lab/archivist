import { claimNextJob, completeJob, failJob, finishJob, getJob, heartbeatJob, recordEvent, type JobRecord } from './event-store.js'
import { createLogger } from '@archivist/core'
import { getDb, isDbInitialised } from '../db.js'
import { randomUUID } from 'node:crypto'
import { watchJobQueue } from './job-signal.js'
import { hostname } from 'node:os'

const logger = createLogger('JobRunner')

type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>
export type JobLane = 'imports' | 'metadata' | 'lists' | 'maintenance' | 'scans' | 'searches' | 'default'

interface JobRegistration {
  handler: JobHandler
  lane: JobLane
  timeoutMs: number
}

const handlers = new Map<string, JobRegistration>()
let timer: ReturnType<typeof setInterval> | null = null
let unwatchQueue: (() => void) | null = null
let manualRunActive = false
const activeControllers = new Map<number, AbortController>()
const activeExecutions = new Set<Promise<void>>()
const activeByLane = new Map<JobLane, number>()
const HEARTBEAT_MS = 30_000
const CONTROL_POLL_MS = 2_000
const leaseOwner = `jobs-${hostname()}-${process.pid}-${randomUUID()}`

const LANE_ENV: Record<JobLane, string> = {
  imports: 'ARCHIVIST_JOB_CONCURRENCY_IMPORTS',
  metadata: 'ARCHIVIST_JOB_CONCURRENCY_METADATA',
  lists: 'ARCHIVIST_JOB_CONCURRENCY_LISTS',
  maintenance: 'ARCHIVIST_JOB_CONCURRENCY_MAINTENANCE',
  scans: 'ARCHIVIST_JOB_CONCURRENCY_SCANS',
  searches: 'ARCHIVIST_JOB_CONCURRENCY_SEARCHES',
  default: 'ARCHIVIST_JOB_CONCURRENCY_DEFAULT',
}

/**
 * `scans` exists to keep hours-long sweeps away from the short maintenance work
 * that user actions wait on: a library scan or a backup used to hold the only
 * maintenance slot, and an item search sitting behind indexer-endpoint-resolve
 * waited it out. Scans stay at one because they are disk-bound and gain nothing
 * from running together; maintenance can afford two now that it is only quick
 * network and database work.
 */
const LANE_DEFAULTS: Record<JobLane, number> = {
  imports: 1,
  metadata: 4,
  lists: 2,
  maintenance: 2,
  scans: 1,
  searches: 1,
  default: 1,
}

const LANE_TIMEOUTS: Record<JobLane, number> = {
  imports: 6 * 60 * 60_000,
  metadata: 30 * 60_000,
  lists: 30 * 60_000,
  maintenance: 6 * 60 * 60_000,
  scans: 12 * 60 * 60_000,
  searches: 30 * 60_000,
  default: 30 * 60_000,
}

function laneConcurrency(lane: JobLane): number {
  const configured = Number.parseInt(process.env[LANE_ENV[lane]] ?? '', 10)
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 32)
    : LANE_DEFAULTS[lane]
}

export type JobFailureCategory = 'dns' | 'tls' | 'timeout' | 'connection-reset' | 'connection-refused' | 'missing-source' | 'unsupported' | 'application'

export function classifyJobFailure(message: string): { category: JobFailureCategory; retryable: boolean } {
  if (/EAI_AGAIN|getaddrinfo/i.test(message)) return { category: 'dns', retryable: true }
  if (/certificate|self[- ]signed|unable to verify/i.test(message)) return { category: 'tls', retryable: false }
  if (/timed? ?out|timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) return { category: 'timeout', retryable: true }
  if (/ECONNRESET|socket hang up/i.test(message)) return { category: 'connection-reset', retryable: true }
  if (/ECONNREFUSED/i.test(message)) return { category: 'connection-refused', retryable: true }
  // A completed torrent may still be finalising its move from incomplete to
  // complete storage. A briefly missing source is therefore transient; truly
  // missing sources still fail normally after the job's bounded attempts.
  if (/source path (?:not found|is missing|is not readable)/i.test(message)) return { category: 'missing-source', retryable: true }
  if (/unsupported .* type/i.test(message)) return { category: 'unsupported', retryable: false }
  return { category: 'application', retryable: true }
}

export function registerJobHandler(type: string, handler: JobHandler, options: { lane?: JobLane; timeoutMs?: number } = {}): void {
  const lane = options.lane ?? 'default'
  handlers.set(type, {
    handler,
    lane,
    timeoutMs: options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : LANE_TIMEOUTS[lane],
  })
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()]
}

export function jobRunnerStatus() {
  const lanes = (Object.keys(LANE_DEFAULTS) as JobLane[]).map(lane => ({
    lane,
    active: activeByLane.get(lane) ?? 0,
    concurrency: laneConcurrency(lane),
    types: [...handlers.entries()].filter(([, registration]) => registration.lane === lane).map(([type]) => type),
  }))
  return { running: timer !== null, active: activeControllers.size, lanes }
}

/**
 * The poll is a backstop, not the mechanism. Enqueueing signals the queue (see
 * job-signal.ts) and the runner pumps within milliseconds; this interval only
 * covers the cases a signal cannot reach — a volume where fs.watch does not
 * work, or a job that became available because its retry backoff elapsed.
 */
export function startJobRunner(intervalMs = 1000): void {
  if (timer) return
  logger.info('Starting lane-aware job runner')
  timer = setInterval(() => {
    try { pumpJobs() } catch (err) { logger.error('Job runner tick failed:', err) }
  }, intervalMs)
  timer.unref?.()
  unwatchQueue = watchJobQueue(getDb(), () => {
    try { pumpJobs() } catch (err) { logger.error('Job runner wake failed:', err) }
  })
  pumpJobs()
}

export async function stopJobRunner(graceMs = 10_000): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  unwatchQueue?.()
  unwatchQueue = null
  for (const controller of activeControllers.values()) controller.abort(new Error('Archivist job runner stopped'))
  if (activeExecutions.size === 0) return
  await Promise.race([
    Promise.allSettled([...activeExecutions]),
    new Promise<void>(resolve => setTimeout(resolve, graceMs)),
  ])
}

/** Requests cooperative cancellation for the active handler, when local. */
export function cancelActiveJob(id: number): boolean {
  const controller = activeControllers.get(id)
  if (!controller) return false
  controller.abort(new Error('Job cancelled by user'))
  return true
}

/** Signals all local active handlers matching a durable subject cancellation. */
export function cancelActiveSubjectJobs(types: string[], subjectType: string, subjectId: string | number): number {
  const wantedTypes = new Set(types)
  let cancelled = 0
  for (const [id, controller] of activeControllers) {
    const job = getJob(id)
    if (!job || !wantedTypes.has(job.type) || job.subjectType !== subjectType || job.subjectId !== String(subjectId)) continue
    controller.abort(new Error('Job cancelled because its subject was removed'))
    cancelled += 1
  }
  return cancelled
}

async function executeJob(job: JobRecord, registration: JobRegistration): Promise<void> {
  recordEvent({
    category: 'job',
    action: 'started',
    subjectType: 'job',
    subjectId: String(job.id),
    message: `Started job ${job.type} #${job.id}`,
    data: { type: job.type, attempts: job.attempts, lane: registration.lane, timeoutMs: registration.timeoutMs },
  })

  const controller = new AbortController()
  activeControllers.set(job.id, controller)
  const heartbeat = setInterval(() => {
    try { heartbeatJob(job.id, getDb(), leaseOwner) } catch (err) {
      logger.warn(`Heartbeat failed for job ${job.id}:`, err instanceof Error ? err.message : String(err))
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  const controlPoll = setInterval(() => {
    try {
      const current = getJob(job.id)
      if (current?.status === 'running' && current.leaseOwner === leaseOwner) return
      controller.abort(new Error(current?.status === 'cancelled' ? 'Job cancelled by user' : 'Job lease ownership was lost'))
    } catch (err) {
      logger.warn(`Control poll failed for job ${job.id}:`, err instanceof Error ? err.message : String(err))
    }
  }, CONTROL_POLL_MS)
  controlPoll.unref?.()
  const deadline = setTimeout(() => {
    controller.abort(new Error(`Job exceeded its ${registration.timeoutMs}ms execution deadline`))
  }, registration.timeoutMs)
  deadline.unref?.()
  const hardDeadline = setTimeout(() => {
    const message = `Job ${job.id} did not stop within 30 seconds of its execution deadline`
    try { failJob(job.id, message, getDb(), leaseOwner) } catch {}
    logger.error(`${message}; terminating the isolated worker process`)
    if (process.env.ARCHIVIST_PROCESS_ROLE === 'worker') process.exit(1)
  }, registration.timeoutMs + 30_000)
  hardDeadline.unref?.()

  try {
    await registration.handler(job, controller.signal)
    const current = getJob(job.id)
    if (current?.status === 'cancelled') return
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error('Job aborted')
    }
    if (!completeJob(job.id, getDb(), leaseOwner)) return
    recordEvent({
      category: 'job',
      action: 'succeeded',
      subjectType: 'job',
      subjectId: String(job.id),
      message: `Completed job ${job.type} #${job.id}`,
    })
  } catch (err) {
    if (getJob(job.id)?.status === 'cancelled') {
      recordEvent({
        category: 'job', action: 'cancelled', subjectType: 'job', subjectId: String(job.id),
        message: `Cancelled job ${job.type} #${job.id}`,
      })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    const failure = classifyJobFailure(message)
    const retryScheduled = failure.retryable && job.attempts < job.maxAttempts
    if (failure.retryable) failJob(job.id, message, getDb(), leaseOwner)
    else finishJob(job.id, 'failed', message, getDb(), leaseOwner)
    recordEvent({
      category: 'job',
      action: retryScheduled ? 'retry-scheduled' : 'failed',
      severity: retryScheduled ? 'warn' : 'error',
      subjectType: 'job',
      subjectId: String(job.id),
      message,
      data: { type: job.type, failureCategory: failure.category, retryable: failure.retryable, retryScheduled },
    })
  } finally {
    clearTimeout(deadline)
    clearTimeout(hardDeadline)
    clearInterval(heartbeat)
    clearInterval(controlPoll)
    activeControllers.delete(job.id)
  }
}

/** Fills every lane only to its configured capacity. */
export function pumpJobs(): void {
  const typesByLane = new Map<JobLane, string[]>()
  for (const [type, registration] of handlers) {
    const types = typesByLane.get(registration.lane) ?? []
    types.push(type)
    typesByLane.set(registration.lane, types)
  }

  for (const [lane, types] of typesByLane) {
    let active = activeByLane.get(lane) ?? 0
    const capacity = laneConcurrency(lane)
    while (active < capacity) {
      const job = claimNextJob(types, getDb(), leaseOwner)
      if (!job) break
      const registration = handlers.get(job.type)
      if (!registration) {
        failJob(job.id, `No handler registered for job type "${job.type}"`, getDb(), leaseOwner)
        continue
      }
      active += 1
      activeByLane.set(lane, active)
      const execution = executeJob(job, registration)
        .catch(err => logger.error(`Unhandled runner failure for job ${job.id}:`, err))
        .finally(() => {
          activeExecutions.delete(execution)
          activeByLane.set(lane, Math.max(0, (activeByLane.get(lane) ?? 1) - 1))
          if (timer) queueMicrotask(pumpJobs)
        })
      activeExecutions.add(execution)
    }
  }
}

/** Claims and executes at most one queued job. Exposed for tests. */
export async function runOnce(): Promise<void> {
  if (manualRunActive) return
  manualRunActive = true
  try {
    const job = claimNextJob([...handlers.keys()], getDb(), leaseOwner)
    if (!job) return

    const registration = handlers.get(job.type)
    if (!registration) {
      failJob(job.id, `No handler registered for job type "${job.type}"`, getDb(), leaseOwner)
      return
    }
    await executeJob(job, registration)
  } finally {
    manualRunActive = false
  }
}

/** Drains the queue until no runnable job remains. For tests and admin ops. */
export async function drainJobs(maxIterations = 50): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (runnableJobCount() === 0) return
    await runOnce()
  }
}

function runnableJobCount(): number {
  if (!isDbInitialised()) return 0
  try {
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE status = 'queued' AND available_at <= ?")
      .get(new Date().toISOString()) as { n: number }
    return row.n
  } catch {
    return 0
  }
}
