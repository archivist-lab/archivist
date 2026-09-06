import { registerJobHandler } from '../system/job-runner.js'
import type { JobRecord } from '../system/event-store.js'
import { sanitizeMediaPath } from '../shared/routes.js'
import { cleanTracks } from './media-processor.js'
import { runScan } from '../tools/video-engine/scanner.js'
import { restoreQuarantine, retryReplacement } from '../tools/video-engine/queue.js'

function payload<T>(job: JobRecord): T {
  try { return JSON.parse(job.payload) as T } catch { throw new Error(`Job ${job.id} has malformed JSON payload`) }
}

export function registerMediaProcessingJobs(): void {
  registerJobHandler('media-track-clean', async (job, signal) => {
    const value = payload<{ filePath?: string; originalLanguage?: string | null }>(job)
    const filePath = value.filePath ? sanitizeMediaPath(value.filePath) : null
    if (!filePath) throw new Error('Track-cleaning path is outside the permitted roots')
    if (signal.aborted) throw signal.reason
    const result = await cleanTracks(filePath, value.originalLanguage ?? null, undefined, signal)
    if (!result.success) throw new Error(result.message)
  }, { lane: 'imports', timeoutMs: 6 * 60 * 60_000 })

  registerJobHandler('video-library-scan', async (_job, signal) => {
    await runScan(signal)
  }, { lane: 'scans', timeoutMs: 12 * 60 * 60_000 })

  registerJobHandler('video-replacement-recover', async job => {
    const value = payload<{ optimisationId?: string }>(job)
    if (!value.optimisationId || !(await retryReplacement(value.optimisationId))) throw new Error('Replacement could not be recovered; original retained')
  }, { lane: 'maintenance', timeoutMs: 30 * 60_000 })

  registerJobHandler('video-quarantine-restore', async job => {
    const value = payload<{ quarantineId?: string }>(job)
    if (!value.quarantineId || !(await restoreQuarantine(value.quarantineId))) {
      throw new Error('Quarantine entry is missing or could not be restored')
    }
  }, { lane: 'maintenance', timeoutMs: 30 * 60_000 })
}
