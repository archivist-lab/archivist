import { claimNextJob, completeJob, failJob, recordEvent, type JobRecord } from './event-store.js'
import { createLogger } from '@archivist/core'
import { getDb, isDbInitialised } from '../db.js'

const logger = createLogger('JobRunner')

type JobHandler = (job: JobRecord) => Promise<void>

const handlers = new Map<string, JobHandler>()
let timer: ReturnType<typeof setInterval> | null = null
let running = false

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler)
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()]
}

export function startJobRunner(intervalMs = 2000): void {
  if (timer) return
  logger.info('Starting job runner')
  timer = setInterval(() => {
    runOnce().catch(err => logger.error('Job runner tick failed:', err))
  }, intervalMs)
  timer.unref?.()
  runOnce().catch(err => logger.error('Initial job runner tick failed:', err))
}

export function stopJobRunner(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Claims and executes at most one queued job. Exposed for tests. */
export async function runOnce(): Promise<void> {
  if (running) return
  running = true
  try {
    const job = claimNextJob([...handlers.keys()])
    if (!job) return

    const handler = handlers.get(job.type)
    if (!handler) {
      failJob(job.id, `No handler registered for job type "${job.type}"`)
      return
    }

    recordEvent({
      category: 'job',
      action: 'started',
      subjectType: 'job',
      subjectId: String(job.id),
      message: `Started job ${job.type} #${job.id}`,
      data: { type: job.type, attempts: job.attempts },
    })

    try {
      await handler(job)
      completeJob(job.id)
      recordEvent({
        category: 'job',
        action: 'succeeded',
        subjectType: 'job',
        subjectId: String(job.id),
        message: `Completed job ${job.type} #${job.id}`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failJob(job.id, message)
      recordEvent({
        category: 'job',
        action: 'failed',
        severity: 'error',
        subjectType: 'job',
        subjectId: String(job.id),
        message,
        data: { type: job.type },
      })
    }
  } finally {
    running = false
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
