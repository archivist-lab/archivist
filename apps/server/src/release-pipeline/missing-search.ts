/**
 * Missing-search job — the targeted-search counterpart to the RSS firehose.
 *
 * RSS sync only catches releases that an indexer publishes in its "latest"
 * feed. For indexers that don't expose a real firehose (e.g. ExtraTorrent's
 * empty-keyword URL returns a "No search items" placeholder), or for items
 * added to the library *after* the release dropped, RSS misses them entirely.
 *
 * This job iterates every monitored item that's still wanted/missing and runs
 * a targeted keyword search per indexer. Results funnel through the same
 * parse → identify → decide pipeline as RSS, so once an indexer returns the
 * release it gets grabbed automatically.
 *
 * Strategy for query construction:
 *   - One query per series (just the title) catches every missing episode/
 *     season pack in one round-trip — the parser figures out which result
 *     matches which episode.
 *   - One query per film: `${title} ${year}`
 *   - One query per album: `${artist} ${album}`
 *   - One query per game: just title
 */

import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { getIndexerStore, searchViaIndexers, type BridgeSearchResult } from '../services/indexer-bridge.js'
import { recordEvent } from '../system/event-store.js'
import { processReleaseBatch } from '../shared/rss-monitor.js'
import { getState } from './state-store.js'
import { getTierTermsForMedia } from '../shared/settings.js'
import type { QualityOverrides } from './subject-decisions.js'

const logger = createLogger('MissingSearch')

const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000   // run a full cycle every 6h
const STARTUP_DELAY_MS = 60_000                    // 60s after boot
const ITEM_COOLDOWN_MS = 4 * 60 * 60 * 1000        // skip an item if searched <4h ago
const MAX_ITEMS_PER_CYCLE = 10                     // budget per cycle to be polite
const PER_SEARCH_TIMEOUT_MS = 30_000
const INTER_SEARCH_DELAY_MS = 750                  // slight delay between queries

type Module = 'films' | 'series' | 'music' | 'games'

interface MissingItem {
  tabId: number
  tabName: string
  dbPath: string
  mediaType: Module
  /** Stable key for cooldown tracking. */
  key: string
  /** Human-readable label for logs. */
  label: string
  /** Search query to fire at indexers. */
  query: string
  /** Module hint for `searchViaIndexers` so it filters indexers by media type. */
  module: Module
}

const lastSearchedAt = new Map<string, number>()

let started = false
let timer: NodeJS.Timeout | null = null
let inFlight = false

function withinCooldown(key: string, now = Date.now()): boolean {
  const t = lastSearchedAt.get(key)
  return t !== undefined && now - t < ITEM_COOLDOWN_MS
}

function markSearched(key: string, now = Date.now()): void {
  lastSearchedAt.set(key, now)
  // Keep map bounded
  if (lastSearchedAt.size > 5000) {
    const cutoff = now - ITEM_COOLDOWN_MS * 2
    for (const [k, v] of lastSearchedAt) if (v < cutoff) lastSearchedAt.delete(k)
  }
}

function collectFromLibrary(library: { id: number; name: string; media_type: string; db_path: string }): MissingItem[] {
  const db = getDb()
  const items: MissingItem[] = []
  const tabRef = { tabId: library.id, tabName: library.name, dbPath: library.db_path }

  if (library.media_type === 'films') {
    const rows = db.prepare(`
      SELECT id, title, year FROM films
      WHERE library_id = ? AND status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ id: number; title: string; year: number | null }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'films', module: 'films',
        key: `films:${library.id}:${r.id}`,
        label: `${r.title}${r.year ? ` (${r.year})` : ''}`,
        query: r.year ? `${r.title} ${r.year}` : r.title,
      })
    }
  } else if (library.media_type === 'series') {
    // One search per series with any missing episode in recently-aired or
    // unspecified-airdate episodes (skip far-future episodes; nothing exists
    // to search for yet).
    const rows = db.prepare(`
      SELECT s.id, s.title FROM series s
      WHERE s.library_id = ? AND EXISTS (
        SELECT 1 FROM episodes e
        WHERE e.series_id = s.id
          AND e.status IN ('wanted', 'missing')
          AND (e.air_date IS NULL OR e.air_date <= date('now'))
      )
    `).all(library.id) as Array<{ id: number; title: string }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'series', module: 'series',
        key: `series:${library.id}:${r.id}`,
        label: r.title,
        query: r.title,
      })
    }
  } else if (library.media_type === 'music') {
    const rows = db.prepare(`
      SELECT al.id as album_id, al.title as album_title, ar.name as artist_name
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      WHERE ar.library_id = ? AND al.status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ album_id: number; album_title: string; artist_name: string }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'music', module: 'music',
        key: `music:${library.id}:${r.album_id}`,
        label: `${r.artist_name} – ${r.album_title}`,
        query: `${r.artist_name} ${r.album_title}`,
      })
    }
  } else if (library.media_type === 'games') {
    const rows = db.prepare(`
      SELECT id, title FROM games
      WHERE library_id = ? AND status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ id: number; title: string }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'games', module: 'games',
        key: `games:${library.id}:${r.id}`,
        label: r.title,
        query: r.title,
      })
    }
  }

  return items
}

function collectAllMissing(filterTabId?: number): MissingItem[] {
  const sql = filterTabId
    ? "SELECT id, name, media_type, db_path FROM libraries WHERE id = ? AND media_type IN ('films','series','music','games')"
    : "SELECT id, name, media_type, db_path FROM libraries WHERE media_type IN ('films','series','music','games')"

  const libraries = filterTabId
    ? getDb().prepare(sql).all(filterTabId) as Array<{ id: number; name: string; media_type: string; db_path: string }>
    : getDb().prepare(sql).all() as Array<{ id: number; name: string; media_type: string; db_path: string }>

  const all: MissingItem[] = []
  for (const library of libraries) {
    try {
      all.push(...collectFromLibrary(library))
    } catch (err) {
      logger.warn(`collect failed for library "${library.name}":`, err instanceof Error ? err.message : String(err))
    }
  }
  return all
}

function pickHealthyIndexers(module: Module) {
  let store
  try { store = getIndexerStore() } catch { return [] }
  const enabled = store.getEnabled()
  const now = Date.now()
  return enabled.filter(ix => {
    const state = getState(ix.config.id)
    if (state.health === 'unhealthy') return false
    if (state.backoffUntil && state.backoffUntil > now) return false
    // Filter by media type (same logic searchViaIndexers uses)
    const s: any = ix.config.settings
    const mediaTypes = typeof s?.mediaTypes === 'string' ? safeJson(s.mediaTypes) : s?.mediaTypes
    if (mediaTypes && mediaTypes[module] && mediaTypes[module].enabled === false) return false
    return true
  })
}

function safeJson(s: string): any {
  try { return JSON.parse(s) } catch { return null }
}

async function runCycle(tabId?: number, overrides?: QualityOverrides): Promise<void> {
  if (inFlight) {
    logger.debug('Cycle already in flight, skipping')
    return
  }
  inFlight = true
  const cycleStart = Date.now()
  let totalQueries = 0
  let totalGrabbed = 0
  let totalIdentified = 0
  let totalUnmatched = 0

  try {
    const all = collectAllMissing(tabId)
    const due = all.filter(i => !withinCooldown(i.key))
    const queue = due.slice(0, MAX_ITEMS_PER_CYCLE)

    if (queue.length === 0) {
      logger.info(`Missing-search: nothing due (${all.length} missing items, all in cooldown)`)
      return
    }

    logger.info(`Missing-search cycle: ${queue.length}/${all.length} items due (${all.length - queue.length} in cooldown)`)

    for (const item of queue) {
      const indexers = pickHealthyIndexers(item.module)
      if (indexers.length === 0) {
        logger.debug(`No healthy indexers for ${item.module}, skipping ${item.label}`)
        continue
      }

      // Query augmentation based on target tier
      const tierTerms = overrides?.targetTier 
        ? getTierTermsForMedia(item.module as any)[`tier${overrides.targetTier}` as 'tier1' | 'tier2' | 'tier3'] ?? []
        : []
      
      const baseQuery = item.query
      const queries = tierTerms.length > 0 
        ? tierTerms.map(t => `${baseQuery} ${t}`)
        : [baseQuery]

      for (const sq of queries) {
        let results: BridgeSearchResult[] = []
        try {
          results = await searchViaIndexers(indexers, sq, {
            timeoutMs: PER_SEARCH_TIMEOUT_MS,
            module: item.module,
            type: item.module === 'series' ? 'tvsearch' : item.module === 'films' ? 'movie' : 'search',
          })
        } catch (err) {
          logger.warn(`Search failed for "${sq}": ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        totalQueries++

        if (results.length > 0) {
          const outcome = await processReleaseBatch(results, overrides)
          totalGrabbed += outcome.grabbed
          totalIdentified += outcome.identified
          totalUnmatched += outcome.unmatched
          if (outcome.grabbed > 0) {
            logger.info(`Missing-search: "${item.label}" → grabbed ${outcome.grabbed} (${results.length} results, ${outcome.identified} identified)`)
          }
        }
      }

      markSearched(item.key)
      if (INTER_SEARCH_DELAY_MS > 0) await new Promise(r => setTimeout(r, INTER_SEARCH_DELAY_MS))
    }

    recordEvent({
      category: 'missing-search',
      action: 'cycle',
      message: `cycle: queries=${totalQueries} identified=${totalIdentified} unmatched=${totalUnmatched} grabbed=${totalGrabbed}`,
      data: {
        durationMs: Date.now() - cycleStart,
        queries: totalQueries,
        identified: totalIdentified,
        unmatched: totalUnmatched,
        grabbed: totalGrabbed,
        itemsDue: due.length,
        itemsTotal: all.length,
        tabId,
      },
    })
  } catch (err) {
    logger.error('Cycle error:', err)
    recordEvent({
      category: 'missing-search', action: 'cycle-error', severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inFlight = false
  }
}

export function startMissingSearchScheduler(): void {
  if (started) return
  started = true
  logger.info('Missing-search scheduler ready (targeted per-item searches)')
  // No automatic scheduling per user request
}

export function stopMissingSearchScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}

export async function triggerMissingSearchNow(tabId?: number, overrides?: QualityOverrides): Promise<{ started: boolean }> {
  if (inFlight) return { started: false }
  void runCycle(tabId, overrides)
  return { started: true }
}
