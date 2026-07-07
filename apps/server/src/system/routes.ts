import { Router } from 'express'
import { listJobs, listEvents, cancelJob, retryJob } from './event-store.js'

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

  return router
}
