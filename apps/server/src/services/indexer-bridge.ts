import { join, resolve } from 'node:path'
import { DefinitionLoader, DefinitionSync, IndexerStore, aggregateSearch } from '@torrentstack/indexer-engine'
import type { IndexerInstance } from '@torrentstack/indexer-engine'
import type { SearchResult } from '@torrentstack/types'
import { getActiveEndpoint, preferEndpoint, seedEndpoints } from '../indexers/endpoints/store.js'
import { applyActiveEndpointToInstance, resolveIndexer } from '../indexers/endpoints/resolver.js'
import { searchBreakerHooks } from '../indexers/endpoints/breaker.js'
import { createLogger } from '@archivist/core'
import { CLOUDFLARE_BYPASS_INTERNAL_URL, resolveCloudflareBypassUrl, type CloudflareBypassConfig } from '@archivist/contracts'
import { getDb } from '../db.js'
import type Database from 'better-sqlite3'
import { recordSearchStats } from '../release-pipeline/state-store.js'

const logger = createLogger('IndexerBridge')

/**
 * Where 'internal' points for this deployment. Bare metal publishes the solver
 * on loopback; Compose puts it on a sibling service name, where loopback would
 * resolve to the Archivist container itself.
 */
export function internalCloudflareBypassUrl(): string {
  return process.env.ARCHIVIST_CLOUDFLARE_BYPASS_URL?.trim() || CLOUDFLARE_BYPASS_INTERNAL_URL
}

export function getCloudflareBypassUrl(): string | undefined {
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM app_settings WHERE library_id = 0 AND key = 'cloudflareBypass'").get() as { value: string } | undefined
    if (!row) return undefined
    return resolveCloudflareBypassUrl(JSON.parse(row.value) as Partial<CloudflareBypassConfig>, internalCloudflareBypassUrl())
  } catch {
    return undefined
  }
}

let _defLoader: DefinitionLoader | null = null
let _indexerStore: IndexerStore | null = null
let _definitionSync: DefinitionSync | null = null
let bypassReadiness: { url: string; ready: boolean; checkedAt: number; error?: string } | null = null

/**
 * Fast, cached dependency probe used before polling an indexer that explicitly
 * requires CloudflareBypass. A dependency that is still starting must not degrade
 * every indexer or be recorded as a failed indexer request.
 */
export async function checkCloudflareBypassReady(indexer: IndexerInstance): Promise<{ ready: boolean; error?: string }> {
  const forced = indexer.config.settings?.cloudflareBypass === true || indexer.config.settings?.cloudflareBypass === 'true'
  const url = indexer.cloudflareBypassUrl?.replace(/\/$/, '')
  if (!forced || !url) return { ready: true }

  const now = Date.now()
  const cacheMs = bypassReadiness?.ready ? 30_000 : 10_000
  if (bypassReadiness?.url === url && now - bypassReadiness.checkedAt < cacheMs) {
    return bypassReadiness.ready ? { ready: true } : { ready: false, error: bypassReadiness.error }
  }

  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`health check returned HTTP ${response.status}`)
    const body = await response.json().catch(() => null) as { status?: string } | null
    if (body?.status && body.status !== 'ok') throw new Error(`health status is ${body.status}`)
    bypassReadiness = { url, ready: true, checkedAt: now }
    return { ready: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    bypassReadiness = { url, ready: false, checkedAt: now, error }
    return { ready: false, error }
  }
}

export async function initIndexerBridge(db: Database.Database, defsPath?: string, definitionsOffline = false): Promise<void> {
  _definitionSync?.stop()
  _definitionSync = null
  _defLoader = new DefinitionLoader()
  const definitionsPath = resolve(
    defsPath ??
    process.env.ARCHIVIST_DEFINITIONS_PATH ??
    join(process.cwd(), 'data', 'indexer-definitions')
  )
  const customDefinitionsPath = resolve(
    process.env.ARCHIVIST_CUSTOM_DEFINITIONS_PATH
    ?? join(process.cwd(), 'config', 'indexer-definitions')
  )
  await _defLoader.loadDirectory(definitionsPath)
  await _defLoader.loadDirectory(customDefinitionsPath)
  logger.info(`IndexerBridge: loaded ${_defLoader.count} definitions from ${definitionsPath} and ${customDefinitionsPath}`)

  if (!definitionsOffline) {
    _definitionSync = new DefinitionSync(definitionsPath)
    await _definitionSync.start(24 * 7, async result => {
      if (result.skipped) {
        logger.info('Indexer definitions checked; upstream is unchanged')
        return
      }

      const refreshed = new DefinitionLoader()
      await refreshed.loadDirectory(definitionsPath)
      await refreshed.loadDirectory(customDefinitionsPath)
      _defLoader = refreshed

      if (_indexerStore) {
        for (const instance of _indexerStore.getAll()) {
          if (!instance.config.definitionId) continue
          instance.definition = refreshed.get(instance.config.definitionId) ?? null
          if (instance.definition) {
            seedEndpoints(instance.config.id, instance.definition.links, instance.definition.legacyLinks, db)
          }
        }
      }
      logger.info(`Indexer definitions refreshed from Jackett/Jackett: ${refreshed.count} loaded`)
    }).catch(err => logger.warn('Indexer definition scheduler failed:', err instanceof Error ? err.message : String(err)))
  }

  // Setup DB table for TorrentStack schema if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexers_ts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'torrent',
      protocol TEXT NOT NULL DEFAULT 'cardigann',
      definition_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 25,
      redirect INTEGER NOT NULL DEFAULT 0,
      base_url TEXT NOT NULL DEFAULT '',
      api_path TEXT NOT NULL DEFAULT '/api',
      api_key TEXT,
      username TEXT,
      password TEXT,
      download_link_type TEXT NOT NULL DEFAULT 'torrent',
      minimum_seeders INTEGER NOT NULL DEFAULT 0,
      seed_ratio REAL,
      seed_time INTEGER,
      sync_profile_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      vip_expiration TEXT,
      additional_parameters TEXT NOT NULL DEFAULT '',
      settings TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '{}',
      last_tested_at INTEGER,
      capabilities TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `)

  _indexerStore = new IndexerStore()
  const globalCloudflareBypassUrl = getCloudflareBypassUrl()
  const rows = db.prepare('SELECT * FROM indexers_ts').all() as Array<Record<string, unknown>>
  for (const row of rows) {
    try {
      const config: any = {
        id: row.id, name: row.name, type: row.type, protocol: row.protocol,
        definitionId: row.definition_id, enabled: Boolean(row.enabled), priority: row.priority,
        redirect: Boolean(row.redirect), baseUrl: row.base_url, apiPath: row.api_path,
        apiKey: row.api_key, username: row.username, password: row.password,
        downloadLinkType: row.download_link_type, minimumSeeders: row.minimum_seeders,
        seedRatio: row.seed_ratio, seedTime: row.seed_time, syncProfileId: row.sync_profile_id,
        tags: JSON.parse(row.tags as string), vipExpiration: row.vip_expiration,
        additionalParameters: row.additional_parameters,
        settings: JSON.parse(row.settings as string), status: JSON.parse(row.status as string),
        lastTestedAt: row.last_tested_at, capabilities: JSON.parse(row.capabilities as string),
      }
      const def = config.definitionId ? _defLoader.get(config.definitionId) : null
      const instance: IndexerInstance = {
        type: config.protocol === 'cardigann' ? 'cardigann' : 'torznab',
        config, definition: def ?? null, cookies: {}, proxyUrl: undefined,
        cloudflareBypassUrl: globalCloudflareBypassUrl,
      }
      // The candidate set follows the definition on every reload, and the
      // resolver's chosen endpoint wins over the stored base URL.
      if (def) {
        try {
          seedEndpoints(config.id, def.links, def.legacyLinks, db)
          preferEndpoint(config.id, String(row.base_url ?? ''), db, {
            activate: getActiveEndpoint(config.id, db) === null,
          })
        } catch (e) {
          logger.error(`Failed to seed endpoints for ${config.name}:`, e)
        }
      }
      try {
        const active = getActiveEndpoint(config.id, db)
        if (active) applyActiveEndpointToInstance(instance, active.url)
      } catch {
        // A database without the resolver tables yet is not a boot failure.
      }
      _indexerStore.add(instance)
      // Reconcile persisted health on every worker/API start. Otherwise a URL
      // last measured dead can remain active until its next scheduled probe.
      try {
        resolveIndexer(instance, db)
      } catch (e) {
        logger.error(`Failed to resolve active endpoint for ${config.name}:`, e)
      }
    } catch (e) {
      logger.error('Failed to load indexer:', e)
    }
  }
}

export function getDefinitionLoader(): DefinitionLoader {
  if (!_defLoader) throw new Error('IndexerBridge not initialised')
  return _defLoader
}

export function getIndexerStore(): IndexerStore {
  if (!_indexerStore) throw new Error('IndexerBridge not initialised')
  return _indexerStore
}

/** Enabled indexer instances, or [] when the bridge is not initialised. */
export function getEnabledIndexerInstances(): IndexerInstance[] {
  try {
    return getIndexerStore().getEnabled()
  } catch {
    return []
  }
}

/**
 * Effective priority for an indexer + media type and workflow. Scan/search uses
 * `priority`; RSS uses `rssPriority`, falling back to the scan priority for
 * configurations saved before separate RSS priorities were introduced.
 */
export function indexerPriorityForMedia(config: any, mediaType?: string, workflow: 'scan' | 'rss' = 'scan'): number {
  let mediaConfig: any
  if (mediaType && mediaType !== 'all') {
    const s = config?.settings?.mediaTypes
    if (s) {
      try {
        const parsed = typeof s === 'string' ? JSON.parse(s) : s
        mediaConfig = parsed?.[mediaType]
      } catch { /* fall through to global */ }
    }
  }

  if (workflow === 'rss') {
    if (typeof mediaConfig?.rssPriority === 'number') return mediaConfig.rssPriority
    if (typeof config?.settings?.rssPriority === 'number') return config.settings.rssPriority
  }
  if (typeof mediaConfig?.priority === 'number') return mediaConfig.priority
  return config?.priority ?? 25
}

/** Best enabled per-media RSS priority, used to order generic feed polling. */
export function indexerRssPollingPriority(config: any): number {
  const raw = config?.settings?.mediaTypes
  try {
    const mediaTypes = typeof raw === 'string' ? JSON.parse(raw) : raw
    const priorities = Object.values(mediaTypes ?? {})
      .filter((entry: any) => entry?.enabled !== false)
      .map((entry: any) => entry?.rssPriority ?? entry?.priority)
      .filter((priority: any) => typeof priority === 'number' && Number.isFinite(priority)) as number[]
    if (priorities.length > 0) return Math.min(...priorities)
  } catch { /* fall through to global */ }
  return indexerPriorityForMedia(config, undefined, 'rss')
}

// Short-lived cache of indexer configs by name so per-release priority lookups
// (RSS acquisition scoring) don't hit the store for every candidate.
let _cfgCache: { at: number; byName: Map<string, any> } | null = null
export function invalidateIndexerConfigCache(): void {
  _cfgCache = null
}

function indexerConfigsByName(): Map<string, any> {
  if (_cfgCache && Date.now() - _cfgCache.at < 30_000) return _cfgCache.byName
  const byName = new Map<string, any>()
  for (const ix of getEnabledIndexerInstances()) byName.set(ix.config.name, ix.config)
  _cfgCache = { at: Date.now(), byName }
  return byName
}

/** Resolve effective priority by indexer name — used where only the name is known (RSS decisions). */
export function resolveIndexerPriority(indexerName: string | undefined, mediaType?: string, workflow: 'scan' | 'rss' = 'scan'): number {
  if (!indexerName) return 25
  const cfg = indexerConfigsByName().get(indexerName)
  return cfg ? indexerPriorityForMedia(cfg, mediaType, workflow) : 25
}

export interface BridgeSearchResult {
  guid:        string
  title:       string
  downloadUrl: string
  /** Original indexer download/enclosure URL. For Music this is preferred over
   * a magnet because a real .torrent already contains its file metadata. */
  torrentUrl?:  string
  /** Magnet retained as a fallback when the indexer download URL is HTML or
   * otherwise no longer serves bencoded torrent data. */
  magnetUrl?:   string
  size?:       number
  seeders?:    number
  leechers?:   number
  publishDate?: string
  indexerName: string
  indexerPriority?: number
}

function mapBridgeResults(results: SearchResult[], activeIndexers: IndexerInstance[], moduleName?: string): BridgeSearchResult[] {
  return results.map(r => ({
    guid: r.guid,
    title: r.title,
    downloadUrl: moduleName === 'music' ? (r.downloadUrl || r.magnetUrl!) : (r.magnetUrl ?? r.downloadUrl),
    torrentUrl: r.downloadUrl?.startsWith('http') ? r.downloadUrl : undefined,
    magnetUrl: r.magnetUrl ?? undefined,
    size: r.size,
    seeders: r.seeders ?? undefined,
    leechers: r.leechers ?? undefined,
    publishDate: r.publishDate ? new Date(r.publishDate).toISOString() : undefined,
    indexerName: r.indexerName,
    indexerPriority: (() => {
      const indexer = activeIndexers.find(candidate => candidate.config.name === r.indexerName)
      return indexer ? indexerPriorityForMedia(indexer.config, moduleName) : 25
    })(),
  }))
}

export interface IndexerFetchStat {
  indexerId: string
  indexerName: string
  resultCount: number
  responseMs: number
  error: string | null
}

export interface SearchDiagnostics {
  attempted: number
  failed: number
  summary: string | null
  stats: IndexerFetchStat[]
}

export function summariseIndexerFailures(stats: IndexerFetchStat[]): SearchDiagnostics {
  const failures = stats.filter(stat => stat.error)
  const summary = failures.length === 0
    ? null
    : failures.map(stat => `${stat.indexerName}: ${String(stat.error).replace(/^Error:\s*/i, '')}`).join('; ')
  return { attempted: stats.length, failed: failures.length, summary, stats }
}

export interface RssFetchOutcome {
  results: BridgeSearchResult[]
  stats: IndexerFetchStat[]
}

export async function rssSyncViaIndexers(
  tsIndexers: IndexerInstance[],
  opts?: { timeoutMs?: number; limit?: number }
): Promise<RssFetchOutcome> {
  if (tsIndexers.length === 0) return { results: [], stats: [] }

  const activeIndexers = tsIndexers.filter(ix => ix.config.enabled)
  if (activeIndexers.length === 0) return { results: [], stats: [] }

  const limit = opts?.limit ?? 100

  try {
    const searchParams: any = { limit }
    logger.debug(`RSS Sync: fetching latest ${limit} releases across ${activeIndexers.length} indexers`)

    const { results, indexerStats } = await aggregateSearch(activeIndexers, searchParams, {
      timeoutMs: opts?.timeoutMs ?? 60_000,
      hooks: searchBreakerHooks(),
    })

    logger.debug(`RSS Sync: returned ${results.length} raw results`)

    const mapped = results.map(r => ({
      guid:        r.guid,
      title:       r.title,
      downloadUrl: r.magnetUrl ?? r.downloadUrl,
      torrentUrl:  r.downloadUrl?.startsWith('http') ? r.downloadUrl : undefined,
      magnetUrl:   r.magnetUrl ?? undefined,
      size:        r.size,
      seeders:     r.seeders ?? undefined,
      leechers:    r.leechers ?? undefined,
      publishDate: r.publishDate ? new Date(r.publishDate).toISOString() : undefined,
      indexerName: r.indexerName,
      indexerPriority: (() => {
        const idx = activeIndexers.find(i => i.config.name === r.indexerName)
        return idx ? indexerPriorityForMedia(idx.config, undefined, 'rss') : 25
      })()
    }))

    return { results: mapped, stats: indexerStats }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`RSS Sync failed:`, msg)
    return {
      results: [],
      stats: activeIndexers.map(ix => ({
        indexerId: ix.config.id,
        indexerName: ix.config.name,
        resultCount: 0,
        responseMs: 0,
        error: msg,
      })),
    }
  }
}

export async function searchViaIndexers(
  tsIndexers: IndexerInstance[],
  query: string,
  opts?: { timeoutMs?: number; deadlineAt?: number; categories?: number[]; type?: 'search' | 'tvsearch' | 'movie' | 'music' | 'book'; module?: 'films' | 'series' | 'music' | 'books' | 'comics' | 'games' | 'all'; imdbId?: string | null; tmdbId?: number | null; tvdbId?: number | null; onDiagnostics?: (diagnostics: SearchDiagnostics) => void; onPartialResults?: (results: BridgeSearchResult[]) => void | Promise<void> }
): Promise<BridgeSearchResult[]> {
  if (tsIndexers.length === 0) return []

  const categories = opts?.categories ?? []
  const type = opts?.type ?? 'search'
  const moduleName = opts?.module

  // Filter indexers based on applicable media types
  let activeIndexers = tsIndexers
  if (moduleName && moduleName !== 'all') {
    activeIndexers = tsIndexers.filter(ix => {
      const s = ix.config.settings?.mediaTypes
      if (!s) return true // Legacy fallback
      try {
        const parsed = typeof s === 'string' ? JSON.parse(s) : s
        const moduleConfig = parsed[moduleName]
        return moduleConfig ? moduleConfig.enabled : true
      } catch { return true }
    })
  }

  if (activeIndexers.length === 0) return []

  try {
    const remainingMs = () => opts?.deadlineAt == null ? Number.POSITIVE_INFINITY : Math.max(0, opts.deadlineAt - Date.now())
    if (remainingMs() === 0) return []
    const attemptTimeout = () => Math.max(1, Math.min(opts?.timeoutMs ?? 45_000, remainingMs()))
    const searchParams: any = { q: query }
    if (categories.length) searchParams.categories = categories
    if (type) searchParams.type = type
    // Codes flow to indexers that advertise id-based movie/tv search (Torznab,
    // Prowlarr, capable Cardigann defs); keyword-only defs simply ignore them
    // and use `q`, so passing both gives "codes first, keyword fallback" for free.
    if (opts?.imdbId) searchParams.imdbId = opts.imdbId
    if (opts?.tmdbId) searchParams.tmdbId = opts.tmdbId
    if (opts?.tvdbId) searchParams.tvdbId = opts.tvdbId

    logger.debug(`Searching "${query}" type=${type} module=${moduleName} indexers=${activeIndexers.length}`)

    const aggregate = await aggregateSearch(activeIndexers, searchParams, {
      timeoutMs: attemptTimeout(),
      hooks: searchBreakerHooks(),
      boundHooksToTimeout: opts?.deadlineAt != null,
      onIndexerResults: opts?.onPartialResults
        ? results => opts.onPartialResults!(mapBridgeResults(results, activeIndexers, moduleName))
        : undefined,
    })
    let results = aggregate.results
    let indexerStats = aggregate.indexerStats

    // FALLBACK: If specialized search returns 0 results, retry with standard 'search' type
    if (results.length === 0 && type !== 'search' && remainingMs() > 0) {
      logger.debug(`Specialized search "${type}" returned 0 results. Retrying with "search" fallback...`)
      const fallbackParams = { ...searchParams, type: 'search' }
      const fallbackRes = await aggregateSearch(activeIndexers, fallbackParams, {
        timeoutMs: attemptTimeout(),
        hooks: searchBreakerHooks(),
        boundHooksToTimeout: opts?.deadlineAt != null,
        onIndexerResults: opts?.onPartialResults
          ? results => opts.onPartialResults!(mapBridgeResults(results, activeIndexers, moduleName))
          : undefined,
      })
      results = fallbackRes.results
      indexerStats = fallbackRes.indexerStats
    }

    try { recordSearchStats(indexerStats, { type, module: moduleName, query }) } catch { /* diagnostics must not break search */ }
    opts?.onDiagnostics?.(summariseIndexerFailures(indexerStats))

    for (const stat of indexerStats) {
      if (stat.error) logger.warn(`Indexer search failed: ${stat.indexerName} query=${JSON.stringify(query)} error=${stat.error}`)
    }

    logger.debug(`searchViaIndexers "${query}": ${results.length} raw results`)

    return mapBridgeResults(results, activeIndexers, moduleName)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`aggregateSearch failed for "${query}":`, message)
    opts?.onDiagnostics?.({ attempted: activeIndexers.length, failed: activeIndexers.length, summary: message, stats: [] })
    return []
  }
}
