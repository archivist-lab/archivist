import { Router } from 'express'
import { getIndexerStore } from '../services/indexer-bridge.js'
import { listAllStates } from './state-store.js'
import { nextPollAt } from './health.js'
import {
  forceRefreshAll,
  forceRefreshOne,
  getInFlightIndexerIds,
} from './orchestrator.js'
import { triggerMissingSearchNow, countEligibleBacklog, listScheduleRuns } from './missing-search.js'
import { getSearchMissingSettings, setSearchMissingSettings, nextRunDescription, type SearchMissingSettings } from './search-missing-settings.js'
import { getReleaseMonitoringSettings, setReleaseMonitoringSettings, isRapidWindowActive, type ReleaseMonitoringSettings } from './release-monitoring-settings.js'
import { listAcquisitionDecisions } from '../services/acquisition-decisions.js'

export function createReleasePipelineRouter(): Router {
  const router = Router()

  // ── Release monitoring (RSS rapid air-time polling) ──────────────────────────

  router.get('/monitoring/settings', (_req, res) => {
    res.json({ settings: getReleaseMonitoringSettings(), rapidActive: isRapidWindowActive() })
  })

  router.put('/monitoring/settings', (req, res) => {
    const settings = setReleaseMonitoringSettings((req.body ?? {}) as Partial<ReleaseMonitoringSettings>)
    res.json({ settings, rapidActive: isRapidWindowActive() })
  })

  // ── Search Missing: scheduled backlog settings, schedule, runs ───────────────

  router.get('/search-missing/settings', (_req, res) => {
    const settings = getSearchMissingSettings()
    res.json({ settings, nextRun: nextRunDescription(settings, new Date()), eligibleBacklog: countEligibleBacklog() })
  })

  router.put('/search-missing/settings', (req, res) => {
    const patch = (req.body ?? {}) as Partial<SearchMissingSettings>
    const settings = setSearchMissingSettings(patch)
    res.json({ settings, nextRun: nextRunDescription(settings, new Date()), eligibleBacklog: countEligibleBacklog() })
  })

  router.get('/search-missing/runs', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50))
    res.json({ runs: listScheduleRuns(limit) })
  })

  // Manual backlog run. Body: { tabId?, itemLimit?, includeRecent?, selectionStrategy? }
  router.post('/search-missing/run', async (req, res, next) => {
    try {
      const b = req.body ?? {}
      if (!getSearchMissingSettings().allowManualRun) return res.status(403).json({ error: 'manual runs are disabled' })
      const r = await triggerMissingSearchNow(
        b.tabId ? Number(b.tabId) : undefined,
        b.overrides,
        { itemLimit: b.itemLimit != null ? Number(b.itemLimit) : undefined, includeRecent: !!b.includeRecent, selectionStrategy: b.selectionStrategy },
      )
      if (!r.started) return res.status(409).json({ error: 'a run is already in flight' })
      res.json({ success: true, message: 'backlog run started' })
    } catch (err) { next(err) }
  })

  router.get('/health', (_req, res) => {
    let indexers: any[] = []
    try { indexers = getIndexerStore().getAll() } catch {}
    const states = new Map(listAllStates().map(s => [s.indexerId, s]))
    const inFlight = new Set(getInFlightIndexerIds())
    const rapidActive = isRapidWindowActive()

    const rows = indexers.map(ix => {
      const state = states.get(ix.config.id)
      return {
        id: ix.config.id,
        name: ix.config.name,
        enabled: !!ix.config.enabled,
        health: !ix.config.enabled ? 'disabled' : (state?.health ?? 'unknown'),
        mode: !ix.config.enabled ? 'disabled' : state?.backoffUntil && state.backoffUntil > Date.now() ? 'backing off' : rapidActive ? 'rapid' : 'normal',
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
        rapidActive,
      },
      indexers: rows,
    })
  })

  // Recent release decisions (accepted + rejected, with reasons) — the "why did
  // Archivist grab / not grab this" explorer. Data already persisted by the pipeline.
  router.get('/decisions', (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100))
    let rows = listAcquisitionDecisions(limit) as any[]
    const filter = String(req.query.filter ?? 'all')
    if (filter === 'accepted') rows = rows.filter(r => r.accepted === 1)
    else if (filter === 'rejected') rows = rows.filter(r => r.accepted === 0)
    else if (filter === 'grabbed') rows = rows.filter(r => r.grabbed === 1)
    res.json({ decisions: rows })
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
