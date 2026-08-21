import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import {
  torznabSearch,
  executeSearch,
} from '@torrentstack/indexer-engine'
import type { Indexer } from '@torrentstack/types'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { getCloudflareBypassUrl, getIndexerStore, getDefinitionLoader, invalidateIndexerConfigCache } from '../services/indexer-bridge.js'
import { registerEndpointRoutes } from './endpoints/routes.js'
import { seedEndpoints } from './endpoints/store.js'
import { resolveIndexerNow } from './endpoints/scheduler.js'

const logger = createLogger('Indexers')

/**
 * Indexer registry surface. Indexers are global in Archivist (as in legacy shared.db);
 * per-media routing lives in each indexer's settings JSON.
 */
export function createIndexersRouter(): Router {
  const router = Router()

  // Indexer Endpoint Resolver surface. Registered first so its specific paths
  // are matched before the generic '/:id' handlers below.
  registerEndpointRoutes(router)

  router.get('/', (_req, res) => {
    try {
      res.json(getIndexerStore().getAll().map(i => i.config))
    } catch {
      res.json([])
    }
  })

  router.get('/definitions/list', (_req, res) => {
    try {
      const defs = getDefinitionLoader().getAll().map(d => ({
        id: d.id,
        name: d.name,
        description: d.description,
        language: d.language,
        type: d.type,
        links: d.links,
        settings: d.settings,
        searchModes: d.searchModes,
      }))
      res.json(defs)
    } catch {
      res.json([])
    }
  })

  router.get('/:id', (req, res) => {
    const inst = getIndexerStore().get(req.params.id)
    if (!inst) return res.status(404).json({ error: 'Not found' })
    res.json(inst.config)
  })

  router.post('/', (req, res) => {
    try {
      const indexerStore = getIndexerStore()
      const defLoader = getDefinitionLoader()
      const db = getDb()
      const body = req.body as Partial<Indexer> & { definitionId?: string }
      const id = randomUUID()

      const def = body.definitionId ? defLoader.get(body.definitionId) : null

      const settings: Record<string, string | number | boolean> = {}
      if (def) {
        for (const s of def.settings) {
          if (s.default !== undefined) settings[s.name] = s.default
        }
      }
      Object.assign(settings, body.settings ?? {})

      const baseUrl = body.baseUrl ?? def?.links[0] ?? ''
      if (baseUrl) settings['sitelink'] = baseUrl

      const config: Indexer = {
        id,
        name: body.name ?? def?.name ?? 'New Indexer',
        type: body.type ?? 'torrent',
        protocol: body.protocol ?? (def ? 'cardigann' : 'torznab'),
        definitionId: body.definitionId ?? null,
        enabled: body.enabled ?? true,
        priority: body.priority ?? 25,
        redirect: body.redirect ?? false,
        baseUrl: baseUrl,
        apiPath: body.apiPath ?? '/api',
        apiKey: body.apiKey ?? null,
        username: body.username ?? null,
        password: body.password ?? null,
        cookieHeader: null,
        downloadLinkType: body.downloadLinkType ?? 'torrent',
        minimumSeeders: body.minimumSeeders ?? 0,
        seedRatio: body.seedRatio ?? null,
        seedTime: body.seedTime ?? null,
        syncProfileId: body.syncProfileId ?? 'default',
        tags: body.tags ?? [],
        vipExpiration: body.vipExpiration ?? null,
        additionalParameters: body.additionalParameters ?? '',
        settings,
        status: { mostRecentFailure: null, disabledTill: null, initialFailure: null, failureCount: 0 },
        lastTestedAt: null,
        capabilities: def
          ? {
              searchAvailable: def.searchModes.includes('search'),
              tvSearchAvailable: def.searchModes.includes('tvsearch'),
              movieSearchAvailable: def.searchModes.includes('movie'),
              musicSearchAvailable: def.searchModes.includes('music'),
              bookSearchAvailable: def.searchModes.includes('book'),
              categories: def.categories.map(c => ({ id: typeof c.id === 'number' ? c.id : parseInt(String(c.id), 10) || 0, name: c.cat, subCategories: [] })),
              supportsRss: true,
              supportsSearch: true,
            }
          : { searchAvailable: true, tvSearchAvailable: false, movieSearchAvailable: false, musicSearchAvailable: false, bookSearchAvailable: false, categories: [], supportsRss: true, supportsSearch: true },
      }

      db.prepare(`
        INSERT INTO indexers_ts (id, name, type, protocol, definition_id, enabled, priority, base_url, api_key, username, password, settings, capabilities, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, config.name, config.type, config.protocol, config.definitionId,
        config.enabled ? 1 : 0, config.priority, config.baseUrl,
        config.apiKey, config.username, config.password,
        JSON.stringify(config.settings),
        JSON.stringify(config.capabilities),
        JSON.stringify(config.tags),
      )

      const instance = {
        type: (config.protocol === 'cardigann' ? 'cardigann' : 'torznab') as 'cardigann' | 'torznab',
        config,
        definition: def ?? null,
        cookies: {},
        proxyUrl: undefined,
        cloudflareBypassUrl: getCloudflareBypassUrl(),
      }
      indexerStore.add(instance)
      invalidateIndexerConfigCache()

      // Seed the candidate set and measure it now, so the user is told which
      // endpoint was chosen and why rather than finding out at search time
      // (spec §4.1). Probing happens after the response: it makes real network
      // requests and must not hold up indexer creation.
      if (def) {
        seedEndpoints(config.id, def.links, def.legacyLinks, db)
        setImmediate(() => {
          resolveIndexerNow(instance, 'onboarding').catch(err =>
            logger.error(`Endpoint resolution for ${config.name} failed:`, err))
        })
      }

      res.status(201).json(config)
    } catch (err) {
      logger.error('Failed to create indexer:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.put('/:id', (req, res) => {
    try {
      const indexerStore = getIndexerStore()
      const db = getDb()
      const inst = indexerStore.get(req.params.id)
      if (!inst) return res.status(404).json({ error: 'Not found' })

      const body = req.body as Partial<Indexer>

      if (body.baseUrl && inst.config.protocol === 'cardigann') {
        body.settings = { ...inst.config.settings, ...(body.settings ?? {}), sitelink: body.baseUrl }
      }

      indexerStore.update(req.params.id, body)
      invalidateIndexerConfigCache()

      inst.cloudflareBypassUrl = getCloudflareBypassUrl()

      db.prepare(`
        UPDATE indexers_ts SET name=?, enabled=?, priority=?, base_url=?, api_key=?, settings=?, tags=?, updated_at=?
        WHERE id=?
      `).run(
        inst.config.name, inst.config.enabled ? 1 : 0, inst.config.priority,
        inst.config.baseUrl, inst.config.apiKey,
        JSON.stringify(inst.config.settings), JSON.stringify(inst.config.tags),
        Date.now(), req.params.id,
      )

      res.json(inst.config)
    } catch (err) {
      logger.error('Failed to update indexer:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.delete('/:id', (req, res) => {
    try {
      getIndexerStore().remove(req.params.id)
      invalidateIndexerConfigCache()
      getDb().prepare('DELETE FROM indexers_ts WHERE id=?').run(req.params.id)
      res.status(204).send()
    } catch (err) {
      logger.error('Failed to delete indexer:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/:id/test', async (req, res) => {
    const inst = getIndexerStore().get(req.params.id)
    if (!inst) return res.status(404).json({ error: 'Not found' })

    try {
      let results: any[] = []
      const cloudflareBypassUrl = getCloudflareBypassUrl()
      if (inst.config.protocol === 'cardigann' && inst.definition) {
        results = await executeSearch(inst.definition, { q: 'test', limit: 5 }, {
          settings: { ...inst.config.settings, sitelink: inst.config.baseUrl },
          timeoutMs: 30_000,
          cloudflareBypassUrl,
          forceCloudflareBypass: inst.config.settings?.cloudflareBypass === true || inst.config.settings?.cloudflareBypass === 'true',
        })
      } else {
        results = await torznabSearch(
          { baseUrl: inst.config.baseUrl, apiKey: inst.config.apiKey ?? undefined, timeoutMs: 15_000 },
          { q: 'test', limit: 5 },
        )
      }
      getIndexerStore().updateStatus(req.params.id, null)
      res.json({ success: true, resultCount: results.length, message: 'Test successful' })
    } catch (e) {
      getIndexerStore().updateStatus(req.params.id, String(e))
      res.status(400).json({ success: false, error: String(e), message: String(e) })
    }
  })

  router.post('/test-config', async (req, res) => {
    const body = req.body as {
      baseUrl: string
      apiKey?: string
      settings?: Record<string, string>
      definitionId?: string
    }
    if (!body.baseUrl) return res.status(400).json({ error: 'Base URL is required' })

    try {
      let results: any[] = []
      if (body.definitionId) {
        const def = getDefinitionLoader().get(body.definitionId)
        if (!def) return res.status(404).json({ error: 'Definition not found' })
        const cloudflareBypassUrl = getCloudflareBypassUrl()
        results = await executeSearch(def, { q: 'test', limit: 5 }, {
          settings: { ...body.settings, sitelink: body.baseUrl },
          timeoutMs: 30_000,
          cloudflareBypassUrl,
          forceCloudflareBypass: Boolean((body.settings as any)?.cloudflareBypass),
        })
      } else {
        results = await torznabSearch(
          { baseUrl: body.baseUrl, apiKey: body.apiKey || undefined, timeoutMs: 15_000 },
          { q: 'test', limit: 5 },
        )
      }
      res.json({ success: true, resultCount: results.length, message: 'Test successful' })
    } catch (e) {
      res.status(400).json({ success: false, error: String(e), message: String(e) })
    }
  })

  return router
}
