import { join, resolve } from 'node:path'
import { DefinitionLoader, IndexerStore, aggregateSearch } from '@torrentstack/indexer-engine'
import type { IndexerInstance } from '@torrentstack/indexer-engine'
import type { SearchResult } from '@torrentstack/types'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import type Database from 'better-sqlite3'

const logger = createLogger('IndexerBridge')

export function getFlareSolverrUrl(): string | undefined {
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM app_settings WHERE library_id = 0 AND key = 'flaresolverr'").get() as { value: string } | undefined
    if (!row) return undefined
    const config = JSON.parse(row.value) as { url?: string; enabled?: boolean }
    return config.enabled && config.url ? config.url : undefined
  } catch {
    return undefined
  }
}

let _defLoader: DefinitionLoader | null = null
let _indexerStore: IndexerStore | null = null

export async function initIndexerBridge(db: Database.Database, defsPath?: string): Promise<void> {
  _defLoader = new DefinitionLoader()
  const definitionsPath = resolve(
    defsPath ??
    process.env.ARCHIVIST_DEFINITIONS_PATH ??
    join(process.cwd(), 'data', 'indexer-definitions')
  )
  await _defLoader.loadDirectory(definitionsPath)
  logger.info(`IndexerBridge: loaded ${_defLoader.count} definitions from ${definitionsPath}`)

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
  const globalFlareSolverrUrl = getFlareSolverrUrl()
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
      _indexerStore.add({
        type: config.protocol === 'cardigann' ? 'cardigann' : 'torznab',
        config, definition: def ?? null, cookies: {}, proxyUrl: undefined,
        flareSolverrUrl: globalFlareSolverrUrl,
      })
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
  size?:       number
  seeders?:    number
  leechers?:   number
  publishDate?: string
  indexerName: string
  indexerPriority?: number
}

export interface IndexerFetchStat {
  indexerId: string
  indexerName: string
  resultCount: number
  responseMs: number
  error: string | null
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
    })

    logger.debug(`RSS Sync: returned ${results.length} raw results`)

    const mapped = results.map(r => ({
      guid:        r.guid,
      title:       r.title,
      downloadUrl: r.magnetUrl ?? r.downloadUrl,
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
  opts?: { timeoutMs?: number; categories?: number[]; type?: 'search' | 'tvsearch' | 'movie' | 'music' | 'book'; module?: 'films' | 'series' | 'music' | 'books' | 'comics' | 'games' | 'all' }
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
    const searchParams: any = { q: query }
    if (categories.length) searchParams.categories = categories
    if (type) searchParams.type = type

    logger.debug(`Searching "${query}" type=${type} module=${moduleName} indexers=${activeIndexers.length}`)

    let { results } = await aggregateSearch(activeIndexers, searchParams, {
      timeoutMs: opts?.timeoutMs ?? 45_000,
    })

    // FALLBACK: If specialized search returns 0 results, retry with standard 'search' type
    if (results.length === 0 && type !== 'search') {
      logger.debug(`Specialized search "${type}" returned 0 results. Retrying with "search" fallback...`)
      const fallbackParams = { ...searchParams, type: 'search' }
      const fallbackRes = await aggregateSearch(activeIndexers, fallbackParams, {
        timeoutMs: opts?.timeoutMs ?? 45_000,
      })
      results = fallbackRes.results
    }

    logger.debug(`searchViaIndexers "${query}": ${results.length} raw results`)

    return results.map(r => ({
      guid:        r.guid,
      title:       r.title,
      downloadUrl: r.magnetUrl ?? r.downloadUrl,
      size:        r.size,
      seeders:     r.seeders ?? undefined,
      leechers:    r.leechers ?? undefined,
      publishDate: r.publishDate ? new Date(r.publishDate).toISOString() : undefined,
      indexerName: r.indexerName,
      indexerPriority: (() => {
        const idx = activeIndexers.find(i => i.config.name === r.indexerName)
        return idx ? indexerPriorityForMedia(idx.config, moduleName) : 25
      })()
    }))
  } catch (err) {
    logger.error(`aggregateSearch failed for "${query}":`, err instanceof Error ? err.message : String(err))
    return []
  }
}
