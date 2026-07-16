import { Router } from 'express'
import { listJobs, listEvents, cancelJob, retryJob } from './event-store.js'
import { controlProcessingItem, processingMonitorStatus, setProcessingNodePaused, type ProcessingNodeId } from './processing-monitor.js'

/**
 * System jobs/events surface. The wider admin surface (integrity, backups,
 * maintenance, db status, overview) is mounted by the system-admin router.
 */
export function createSystemRuntimeRouter(): Router {
  const router = Router()

  router.get('/jobs', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '100'), 10) || 100
    res.json({ jobs: listJobs(limit) })
  })

  router.get('/events', (req, res) => {
    const limit = parseInt(String(req.query.limit ?? '200'), 10) || 200
    res.json({ events: listEvents(limit) })
  })

  router.post('/jobs/:id/cancel', (req, res) => {
    cancelJob(parseInt(req.params.id, 10))
    res.json({ success: true })
  })

  router.post('/jobs/:id/retry', (req, res) => {
    retryJob(parseInt(req.params.id, 10))
    res.json({ success: true })
  })

  router.get('/processing-monitor', (_req, res) => {
    res.json(processingMonitorStatus())
  })

  router.put('/processing-monitor/:nodeId/pause', (req, res) => {
    const nodeId = req.params.nodeId as ProcessingNodeId
    const paused = setProcessingNodePaused(nodeId, Boolean(req.body?.paused))
    res.json({ paused })
  })

  router.post('/processing-monitor/:nodeId/items/:itemId/:action', (req, res) => {
    const nodeId = req.params.nodeId as ProcessingNodeId
    const action = req.params.action as 'pause' | 'resume' | 'cancel'
    if (!['pause', 'resume', 'cancel'].includes(action)) return res.status(400).json({ error: 'invalid action' })
    const success = controlProcessingItem(nodeId, req.params.itemId, action)
    res.status(success ? 200 : 409).json({ success })
  })

  return router
}
