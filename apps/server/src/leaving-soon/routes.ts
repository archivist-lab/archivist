import { Router } from 'express'
import {
  decideSweepKeepRequest, evaluateSweepCandidates, getLeavingSoonItem, getPublicSweepSettings, getSweepSettings,
  listLeavingSoon, listSweepKeepRequests, listSweepNotifications, reconcileSweepTags,
  requestSweepKeep, resetSweepTags, setLeavingSoonRule, sweepLeavingSoon, sweepReport,
  updateSweepSettings,
} from './service.js'

export function createLeavingSoonRouter(): Router {
  const router = Router()

  router.get('/', (req, res) => {
    res.json({ items: listLeavingSoon({ scheduledOnly: req.query.scheduled === 'true', includeInactive: req.query.history === 'true' }), settings: getPublicSweepSettings() })
  })

  router.get('/settings', (_req, res) => res.json(getSweepSettings()))

  router.put('/settings', (req, res) => {
    try {
      res.json(updateSweepSettings(req.body ?? {}))
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.get('/report', (_req, res) => res.json(sweepReport()))
  router.get('/requests', (_req, res) => res.json({ requests: listSweepKeepRequests() }))
  router.get('/notifications', (req, res) => res.json({ notifications: listSweepNotifications(typeof req.query.profile === 'string' ? req.query.profile : undefined) }))
  router.post('/evaluate', (_req, res) => res.json(evaluateSweepCandidates()))
  router.post('/sweep', (_req, res) => res.json(sweepLeavingSoon()))
  router.post('/tags/reset', (_req, res) => res.json({ reset: resetSweepTags() }))
  router.post('/tags/reconcile', (_req, res) => res.json({ reconciled: reconcileSweepTags() }))
  router.post('/requests/:id/decision', (req, res) => {
    try {
      const decision = req.body?.decision
      if (decision !== 'approved' && decision !== 'declined') return res.status(400).json({ error: 'decision must be approved or declined' })
      res.json({ request: decideSweepKeepRequest(Number(req.params.id), decision, String(req.body?.decidedBy ?? 'admin')) })
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })

  router.get('/:type/:id', (req, res) => {
    try {
      res.json({ item: getLeavingSoonItem(req.params.type, Number(req.params.id)), settings: getPublicSweepSettings() })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.put('/:type/:id', (req, res) => {
    try {
      res.json({ item: setLeavingSoonRule(req.params.type, Number(req.params.id), req.body?.enabled === true), settings: getPublicSweepSettings() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(message === 'Library item not found' ? 404 : 400).json({ error: message })
    }
  })

  router.post('/:type/:id/keep', (req, res) => {
    try {
      res.json({ item: setLeavingSoonRule(req.params.type, Number(req.params.id), false) })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:type/:id/keep-request', (req, res) => {
    try { res.json(requestSweepKeep(req.params.type, Number(req.params.id), String(req.body?.profileId ?? 'default'), String(req.body?.message ?? ''))) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  return router
}
