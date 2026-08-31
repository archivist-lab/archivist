import { Router } from 'express'
import { AddEndpointBody, PatchEndpointBody, ProbeEndpointBody, type IndexerEndpointHealth } from '@archivist/contracts'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { enqueueIndexerReconcile, getIndexerStore } from '../../services/indexer-bridge.js'
import { validateBody } from '../../middleware/validate.js'
import * as store from './store.js'
import { humanFailure, probeAndPersist, resolveIndexer } from './resolver.js'
import { enqueueIndexerResolve } from './scheduler.js'
import { getIerConfig, setIerConfig } from './config.js'

const logger = createLogger('IER:routes')

/** Indexer Endpoint Resolver API (spec §11), mounted under /indexers. */
export function registerEndpointRoutes(router: Router): void {
  router.get('/:id/endpoints', (req, res) => {
    const endpoints = store.listEndpoints(req.params.id)
    res.json({
      endpoints: endpoints.map(endpoint => ({
        ...endpoint,
        lastErrorHuman: endpoint.lastFailureClass ? humanFailure(endpoint.lastFailureClass) : null,
      })),
    })
  })

  router.post('/:id/endpoints', validateBody(AddEndpointBody), async (req, res, next) => {
    try {
      const instance = getIndexerStore().get(req.params.id)
      if (!instance) { res.status(404).json({ error: 'Unknown indexer' }); return }

      const endpoint = store.addUserEndpoint(req.params.id, req.body.url)
      if (!endpoint) { res.status(400).json({ error: 'That URL could not be understood' }); return }

      if (instance.definition) {
        await probeAndPersist(endpoint, instance, instance.definition, { trigger: 'manual' })
        resolveIndexer(instance)
      }
      enqueueIndexerReconcile()
      res.status(201).json({ endpoint: store.getEndpoint(endpoint.id) })
    } catch (err) { next(err) }
  })

  router.delete('/:id/endpoints/:endpointId', (req, res) => {
    const endpointId = Number(req.params.endpointId)
    const endpoint = store.getEndpoint(endpointId)
    if (!endpoint || endpoint.indexerId !== req.params.id) {
      res.status(404).json({ error: 'Unknown endpoint' }); return
    }
    if (endpoint.origin !== 'user') {
      res.status(409).json({ error: 'Only endpoints you added can be removed. Disable it instead.' }); return
    }
    const removed = store.deleteUserEndpoint(endpointId)
    const instance = getIndexerStore().get(req.params.id)
    if (removed && instance) resolveIndexer(instance)
    if (removed) enqueueIndexerReconcile()
    res.json({ removed })
  })

  router.patch('/:id/endpoints/:endpointId', validateBody(PatchEndpointBody), (req, res) => {
    const endpointId = Number(req.params.endpointId)
    const endpoint = store.getEndpoint(endpointId)
    if (!endpoint || endpoint.indexerId !== req.params.id) {
      res.status(404).json({ error: 'Unknown endpoint' }); return
    }
    const updated = store.patchEndpoint(endpointId, req.body)
    const instance = getIndexerStore().get(req.params.id)
    if (instance) resolveIndexer(instance)
    enqueueIndexerReconcile()
    res.json({ endpoint: updated })
  })

  // Queued rather than awaited: §8.3 requires a pause between probes of one
  // indexer, so a tracker with several mirrors takes minutes to re-resolve.
  // Holding the request open that long dies at whatever proxy fronts Archivist.
  router.post('/:id/endpoints/resolve', (req, res) => {
    const instance = getIndexerStore().get(req.params.id)
    if (!instance) { res.status(404).json({ error: 'Unknown indexer' }); return }
    if (!instance.definition) {
      res.status(409).json({ error: 'This indexer has no definition, so there is nothing to probe' })
      return
    }
    const endpoints = store.listEndpoints(req.params.id).filter(e => e.isEnabled)
    enqueueIndexerResolve(req.params.id, 'manual')
    res.status(202).json({
      queued: true,
      endpointCount: endpoints.length,
      endpoints: store.listEndpoints(req.params.id),
    })
  })

  router.post('/:id/endpoints/:endpointId/probe', validateBody(ProbeEndpointBody), async (req, res, next) => {
    try {
      const instance = getIndexerStore().get(req.params.id)
      const endpoint = store.getEndpoint(Number(req.params.endpointId))
      if (!instance || !endpoint || endpoint.indexerId !== req.params.id) {
        res.status(404).json({ error: 'Unknown endpoint' }); return
      }
      if (!instance.definition) {
        res.status(409).json({ error: 'This indexer has no definition to probe with' }); return
      }
      const result = await probeAndPersist(endpoint, instance, instance.definition, {
        trigger: 'manual',
        allowCloudflareBypass: req.body.allowCloudflareBypass ?? true,
      })
      // A single probe reports; it only changes selection if the tier moved.
      resolveIndexer(instance)
      enqueueIndexerReconcile()
      res.json({ result, endpoint: store.getEndpoint(endpoint.id) })
    } catch (err) { next(err) }
  })

  router.get('/:id/endpoints/:endpointId/history', (req, res) => {
    const endpointId = Number(req.params.endpointId)
    const endpoint = store.getEndpoint(endpointId)
    if (!endpoint || endpoint.indexerId !== req.params.id) {
      res.status(404).json({ error: 'Unknown endpoint' }); return
    }
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7))
    res.json({ history: store.probeHistory(endpointId, days) })
  })

  router.get('/endpoints/config', (_req, res) => {
    res.json({ config: getIerConfig() })
  })

  router.put('/endpoints/config', (req, res) => {
    try {
      res.json({ config: setIerConfig(req.body ?? {}) })
    } catch (err) {
      logger.warn('Rejected resolver config:', err)
      res.status(400).json({ error: 'Invalid resolver settings' })
    }
  })
}

/** Per-indexer health for the dashboard widget and external monitoring (spec §10.3). */
export function indexerEndpointHealth(): IndexerEndpointHealth[] {
  const db = getDb()
  let instances: ReturnType<ReturnType<typeof getIndexerStore>['getAll']>
  try {
    instances = getIndexerStore().getAll()
  } catch {
    return []
  }

  return instances.map(instance => {
    const endpoints = store.listEndpoints(instance.config.id, db)
    const active = endpoints.find(e => e.isActive) ?? null
    const pinned = endpoints.some(e => e.isPinned)
    const authFailures = endpoints.filter(e => e.lastFailureClass === 'auth').length

    let state: IndexerEndpointHealth['state'] = 'unknown'
    if (!active) state = endpoints.length > 0 ? 'down' : 'unknown'
    else if (active.tier === 'A') state = 'direct'
    else if (active.tier === 'B') state = 'cloudflareBypass'
    else if (active.tier === 'C') state = 'degraded'
    else if (active.tier === 'D') state = 'down'

    return {
      indexerId: instance.config.id,
      name: instance.config.name,
      state,
      pinned,
      activeUrl: active?.url ?? null,
      tier: active?.tier ?? 'unknown',
      lastOkAt: active?.lastOkAt ?? null,
      endpointCount: endpoints.length,
      credentialsSuspect: authFailures >= 2,
    }
  })
}
