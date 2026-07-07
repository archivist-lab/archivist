import { Router } from 'express'
import { getIndexerStore } from '../services/indexer-bridge.js'
import { listAllStates } from './state-store.js'
import { nextPollAt } from './health.js'
import {
  forceRefreshAll,
  forceRefreshOne,
  getInFlightIndexerIds,
} from './orchestrator.js'
import { triggerMissingSearchNow } from './missing-search.js'

export function createReleasePipelineRouter(): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    let indexers: any[] = []
    try { indexers = getIndexerStore().getAll() } catch {}
    const states = new Map(listAllStates().map(s => [s.indexerId, s]))
    const inFlight = new Set(getInFlightIndexerIds())

    const rows = indexers.map(ix => {
      const state = states.get(ix.config.id)
      return {
        id: ix.config.id,
        name: ix.config.name,
        enabled: !!ix.config.enabled,
        health: !ix.config.enabled ? 'disabled' : (state?.health ?? 'unknown'),
        inFlight: inFlight.has(ix.config.id),
        lastPolledAt: state?.lastPolledAt ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastFailureAt: state?.lastFailureAt ?? null,
        lastReleasesFound: state?.lastReleasesFound ?? 0,
        lastReleasesGrabbed: state?.lastReleasesGrabbed ?? 0,
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        backoffUntil: state?.backoffUntil ?? null,
        nextPollAt: state ? nextPollAt(state) : 0,
        pollIntervalMs: state?.pollIntervalMs ?? 15 * 60 * 1000,
        lastError: state?.lastError ?? null,
      }
    })

    const healthyCount = rows.filter(r => r.health === 'healthy').length
    const degradedCount = rows.filter(r => r.health === 'degraded').length
    const unhealthyCount = rows.filter(r => r.health === 'unhealthy').length

    res.json({
      summary: {
        total: rows.length,
        healthy: healthyCount,
        degraded: degradedCount,
        unhealthy: unhealthyCount,
      },
      indexers: rows,
    })
  })

  router.post('/refresh', async (_req, res, next) => {
    try {
      const results = await forceRefreshAll()
      res.json({ results })
    } catch (err) { next(err) }
  })

  router.post('/refresh/:indexerId', async (req, res, next) => {
    try {
      const result = await forceRefreshOne(req.params.indexerId)
      if (!result) return res.status(404).json({ error: 'indexer not found, disabled, or in flight' })
      res.json({ result })
    } catch (err) { next(err) }
  })

  router.post('/missing-search', async (req, res, next) => {
    try {
      const tabId = req.body?.tabId ? Number(req.body.tabId) : undefined
      const overrides = req.body?.overrides
      const r = await triggerMissingSearchNow(tabId, overrides)
      if (!r.started) return res.status(409).json({ error: 'cycle already in flight' })
      res.json({ success: true, message: 'cycle started in background' })
    } catch (err) { next(err) }
  })

  return router
}
