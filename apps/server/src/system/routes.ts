import { Router } from 'express'
import { listJobsPage, listEvents, cancelJob, retryJob, jobQueueMetrics, getJob, type JobStatus } from './event-store.js'
import { cancelActiveJob, jobRunnerStatus } from './job-runner.js'
import { controlProcessingItem, processingActivityItems, processingMonitorStatus, setProcessingNodePaused, type ProcessingNodeId } from './processing-monitor.js'
import { providerLimiterStatus } from '../shared/provider-limiter.js'
import { listRuntimeProcesses } from './process-registry.js'

/**
 * System jobs/events surface. The wider admin surface (integrity, backups,
 * maintenance, db status, overview) is mounted by the system-admin router.
 */
export function createSystemRuntimeRouter(): Router {
  const router = Router()

  router.get('/jobs', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '100'), 10) || 100
    const beforeId = parseInt(String(req.query.beforeId ?? ''), 10)
    const requestedStatus = typeof req.query.status === 'string' ? req.query.status : undefined
    const statuses = new Set<JobStatus>(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
    if (requestedStatus && !statuses.has(requestedStatus as JobStatus)) return res.status(400).json({ error: 'invalid job status' })
    const jobs = listJobsPage({
      limit,
      beforeId: Number.isSafeInteger(beforeId) && beforeId > 0 ? beforeId : undefined,
      status: requestedStatus as JobStatus | undefined,
      type: typeof req.query.type === 'string' ? req.query.type : undefined,
    })
    res.json({ jobs, nextCursor: jobs.length === Math.max(1, Math.min(limit, 500)) ? jobs.at(-1)?.id ?? null : null })
  })

  router.get('/jobs/summary', (_req, res) => {
    const processes = listRuntimeProcesses()
    res.json({
      runner: jobRunnerStatus(),
      queues: jobQueueMetrics(),
      providers: providerLimiterStatus(),
      processes,
      workerHealthy: processes.some(process => process.role === 'worker' && process.healthy),
    })
  })

  router.get('/events', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '200'), 10) || 200
    res.json({ events: listEvents(limit) })
  })

  router.post('/jobs/:id/cancel', async (req, res) => {
    const id = parseInt(req.params.id, 10)
    const job = getJob(id)
    cancelJob(id)
    cancelActiveJob(id)
    if (job?.type === 'media-loudness' && job.subjectType && job.subjectId) {
      const { cancelLoudnessJob } = await import('../player/loudness.js')
      cancelLoudnessJob(`${job.subjectType}:${job.subjectId}`)
    } else if (job?.type === 'media-segments' && job.subjectId) {
      const { cancelSegmentAnalysis } = await import('../segments/queue.js')
      cancelSegmentAnalysis(job.subjectId)
    }
    res.json({ success: true })
  })

  router.post('/jobs/:id/retry', (req, res) => {
    retryJob(parseInt(req.params.id, 10))
    res.json({ success: true })
  })

  router.get('/processing-monitor', (_req, res) => {
    res.json(processingMonitorStatus())
  })

  // Compact per-item progress feed for live completion rings on library grids.
  router.get('/processing-activity', (_req, res) => {
    res.json({ items: processingActivityItems() })
  })

  router.put('/processing-monitor/:nodeId/pause', (req, res) => {
    const nodeId = req.params.nodeId as ProcessingNodeId
    const paused = setProcessingNodePaused(nodeId, Boolean(req.body?.paused))
    res.json({ paused })
  })

  router.post('/processing-monitor/:nodeId/items/:itemId/:action', (req, res) => {
    const nodeId = req.params.nodeId as ProcessingNodeId
    const action = req.params.action as 'pause' | 'resume' | 'cancel' | 'skip'
    if (!['pause', 'resume', 'cancel', 'skip'].includes(action)) return res.status(400).json({ error: 'invalid action' })
    const success = controlProcessingItem(nodeId, req.params.itemId, action)
    res.status(success ? 200 : 409).json({ success })
  })

  return router
}
