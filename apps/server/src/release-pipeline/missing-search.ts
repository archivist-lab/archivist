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
 *   - Series run a broad → narrow cascade (see runSeriesCascade): multi-season
 *     range packs → season packs → individual episodes, cycling tiers within
 *     each and stopping once every missing episode is covered.
 *   - Single-target items run a flat tiered search (see runFlatSearch) and stop
 *     at the first grab: film `${title} ${year}`, album `${artist} ${album}`,
 *     game/comic/book by title.
 */

import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { getIndexerStore, searchViaIndexers, type BridgeSearchResult } from '../services/indexer-bridge.js'
import { recordEvent } from '../system/event-store.js'
import { processReleaseBatch } from '../shared/rss-monitor.js'
import { getState } from './state-store.js'
import { getMissingSearchBatchSize, tieredQueries } from '../shared/settings.js'
import { buildSeriesTargets, type SeriesTarget } from './series-cascade.js'
import type { QualityOverrides } from './subject-decisions.js'

const logger = createLogger('MissingSearch')

const SCHEDULE_INTERVAL_MS = 60 * 60 * 1000       // run a bounded cycle every hour
const STARTUP_DELAY_MS = 60_000                    // 60s after boot
const ITEM_COOLDOWN_MS = 4 * 60 * 60 * 1000        // skip an item if searched <4h ago
const PER_SEARCH_TIMEOUT_MS = 30_000
const INTER_SEARCH_DELAY_MS = 750                  // slight delay between queries

interface CycleCounts { queries: number; grabbed: number; identified: number; unmatched: number }

type Module = 'films' | 'series' | 'music' | 'books' | 'comics' | 'games'

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

let started = false
let timer: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null
let inFlight = false

function withinCooldown(key: string, now = Date.now()): boolean {
  const row = getDb().prepare('SELECT last_searched_at FROM missing_search_state WHERE item_key = ?').get(key) as { last_searched_at: number } | undefined
  return row !== undefined && now - row.last_searched_at < ITEM_COOLDOWN_MS
}

function markSearched(key: string, now = Date.now()): void {
  getDb().prepare(`
    INSERT INTO missing_search_state (item_key, last_searched_at) VALUES (?, ?)
    ON CONFLICT(item_key) DO UPDATE SET last_searched_at = excluded.last_searched_at
  `).run(key, now)
}

function lastSearchTime(key: string): number {
  const row = getDb().prepare('SELECT last_searched_at FROM missing_search_state WHERE item_key = ?').get(key) as { last_searched_at: number } | undefined
  return row?.last_searched_at ?? 0
}

function collectFromLibrary(library: { id: number; name: string; media_type: string; db_path: string }): MissingItem[] {
  const db = getDb()
  const items: MissingItem[] = []
  const tabRef = { tabId: library.id, tabName: library.name, dbPath: library.db_path }

  if (library.media_type === 'films') {
    const rows = db.prepare(`
      SELECT id, title, year FROM films
      WHERE library_id = ? AND monitored = 1 AND status IN ('wanted', 'missing')
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
      WHERE s.library_id = ? AND s.monitored = 1 AND EXISTS (
        SELECT 1 FROM episodes e
        WHERE e.series_id = s.id
          AND e.monitored = 1 AND e.status IN ('wanted', 'missing')
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
      WHERE ar.library_id = ? AND ar.monitored = 1 AND al.monitored = 1 AND al.status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ album_id: number; album_title: string; artist_name: string }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'music', module: 'music',
        key: `music:${library.id}:${r.album_id}`,
        label: `${r.artist_name} – ${r.album_title}`,
        query: `${r.artist_name} ${r.album_title}`,
      })
    }
  } else if (library.media_type === 'books') {
    const rows = db.prepare(`
      SELECT b.id, b.title, a.name AS author_name
      FROM books b JOIN authors a ON a.id = b.author_id
      WHERE a.library_id = ? AND a.monitored = 1 AND b.monitored = 1
        AND b.status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ id: number; title: string; author_name: string }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'books', module: 'books',
        key: `books:${library.id}:${r.id}`,
        label: `${r.author_name} - ${r.title}`,
        query: `${r.author_name} ${r.title}`,
      })
    }
  } else if (library.media_type === 'comics') {
    const rows = db.prepare(`
      SELECT i.id, i.issue_number, s.title AS series_title
      FROM comic_issues i JOIN comic_series s ON s.id = i.series_id
      WHERE s.library_id = ? AND s.monitored = 1 AND i.monitored = 1
        AND i.status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ id: number; issue_number: string; series_title: string }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'comics', module: 'comics',
        key: `comics:${library.id}:${r.id}`,
        label: `${r.series_title} #${r.issue_number}`,
        query: `${r.series_title} ${r.issue_number}`,
      })
    }
  } else if (library.media_type === 'games') {
    const rows = db.prepare(`
      SELECT id, title FROM games
      WHERE library_id = ? AND monitored = 1 AND status IN ('wanted', 'missing')
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
    ? "SELECT id, name, media_type, db_path FROM libraries WHERE id = ? AND media_type IN ('films','series','music','books','comics','games')"
    : "SELECT id, name, media_type, db_path FROM libraries WHERE media_type IN ('films','series','music','books','comics','games')"

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

/**
 * Flat tiered search for a single-target item (film, album, game, book, comic
 * issue): escalate Tier 1 → 2 → 3 → Broad and stop at the first grab.
 */
async function runFlatSearch(
  item: MissingItem,
  indexers: ReturnType<typeof pickHealthyIndexers>,
  overrides?: QualityOverrides,
): Promise<CycleCounts> {
  const counts: CycleCounts = { queries: 0, grabbed: 0, identified: 0, unmatched: 0 }
  const searchType = item.module === 'films' ? 'movie' : item.module === 'books' ? 'book' : 'search'

  for (const sq of tieredQueries(item.query, item.module, item.tabId, overrides?.targetTier)) {
    let results: BridgeSearchResult[] = []
    try {
      results = await searchViaIndexers(indexers, sq, { timeoutMs: PER_SEARCH_TIMEOUT_MS, module: item.module, type: searchType })
    } catch (err) {
      logger.warn(`Search failed for "${sq}": ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    counts.queries++

    if (results.length > 0) {
      const outcome = await processReleaseBatch(results, overrides)
      counts.grabbed += outcome.grabbed
      counts.identified += outcome.identified
      counts.unmatched += outcome.unmatched
      if (outcome.grabbed > 0) {
        logger.info(`Missing-search: "${item.label}" → grabbed ${outcome.grabbed} (${results.length} results, ${outcome.identified} identified)`)
        // Single-target item satisfied — stop escalating the remaining tiers.
        logger.debug(`Missing-search: "${item.label}" grabbed — stopping tier escalation`)
        break
      }
    }
  }
  return counts
}

/**
 * Broad → narrow cascade for a series: multi-season range packs (S01-S06 →
 * S01-S02) → season packs (S01…) → individual episodes, cycling tiers within
 * each target. Coverage-aware: after each grab the still-missing set is
 * recomputed, targets whose seasons/episodes are already covered are skipped,
 * and the cascade stops once nothing is missing.
 */
async function runSeriesCascade(
  item: MissingItem,
  indexers: ReturnType<typeof pickHealthyIndexers>,
  overrides?: QualityOverrides,
): Promise<CycleCounts> {
  const counts: CycleCounts = { queries: 0, grabbed: 0, identified: 0, unmatched: 0 }
  const seriesId = Number(item.key.split(':')[2])
  if (!Number.isFinite(seriesId)) return counts
  const db = getDb()

  // Still-missing aired episodes, grouped by season.
  const readMissing = (): Map<number, Set<number>> => {
    const rows = db.prepare(`
      SELECT season_number AS s, episode_number AS e
      FROM episodes
      WHERE series_id = ? AND monitored = 1 AND status IN ('wanted', 'missing')
        AND (air_date IS NULL OR substr(air_date, 1, 10) <= date('now'))
    `).all(seriesId) as Array<{ s: number; e: number }>
    const m = new Map<number, Set<number>>()
    for (const r of rows) {
      const set = m.get(r.s) ?? new Set<number>()
      set.add(r.e)
      m.set(r.s, set)
    }
    return m
  }

  let missing = readMissing()
  if (missing.size === 0) return counts

  const missingSeasons = [...missing.keys()]
  const targets: SeriesTarget[] = [
    // Broadest & most reliable: a plain-title search. Real indexers return
    // complete packs, season packs and episodes for "Deadwood" far more
    // reliably than for a hyphenated "Deadwood S01-S03" keyword. The decision
    // engine prefers the widest-coverage release (multi-season pack), so this
    // alone usually grabs the complete pack; the structured targets below are
    // fallbacks for whatever remains uncovered.
    { kind: 'range', seasons: missingSeasons.slice(), base: item.query },
    ...buildSeriesTargets(item.query, {
      seasons: missingSeasons,
      episodesBySeason: new Map([...missing].map(([s, eps]) => [s, [...eps]])),
    }),
  ]

  for (const target of targets) {
    // Skip targets whose scope is already covered by an earlier grab.
    if (target.kind === 'episode') {
      if (!missing.get(target.episode!.season)?.has(target.episode!.episode)) continue
    } else if (!target.seasons.some(s => missing.has(s))) {
      continue
    }

    for (const q of tieredQueries(target.base, 'series', item.tabId, overrides?.targetTier)) {
      let results: BridgeSearchResult[] = []
      try {
        results = await searchViaIndexers(indexers, q, { timeoutMs: PER_SEARCH_TIMEOUT_MS, module: 'series', type: 'tvsearch' })
      } catch (err) {
        logger.warn(`Series search failed for "${q}": ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      counts.queries++

      if (results.length > 0) {
        const outcome = await processReleaseBatch(results, overrides)
        counts.grabbed += outcome.grabbed
        counts.identified += outcome.identified
        counts.unmatched += outcome.unmatched
        if (outcome.grabbed > 0) {
          logger.info(`Missing-search: "${item.label}" ${target.kind} (${target.base}) → grabbed ${outcome.grabbed}`)
          missing = readMissing()  // re-evaluate coverage after the grab
          break                    // got this target — stop cycling its tiers
        }
      }
      if (missing.size === 0) break
    }
    if (missing.size === 0) break  // whole series covered — done
  }
  return counts
}

async function runCycle(tabId?: number, overrides?: QualityOverrides, bypassCooldown = false): Promise<void> {
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

    // Take the next N oldest-searched items *per library*, where N is that
    // library's configured missing-search batch size (default 5). This caps
    // both the manual "Search Missing" button and each automatic hourly cycle.
    // A user-triggered run bypasses the 4h cooldown — clicking the button should
    // always do something, not silently no-op because a prior cycle just ran.
    const dueByLib = new Map<number, MissingItem[]>()
    for (const item of all) {
      if (!bypassCooldown && withinCooldown(item.key)) continue
      const list = dueByLib.get(item.tabId) ?? []
      list.push(item)
      dueByLib.set(item.tabId, list)
    }

    const queue: MissingItem[] = []
    let dueCount = 0
    for (const [libId, items] of dueByLib) {
      dueCount += items.length
      items.sort((a, b) => lastSearchTime(a.key) - lastSearchTime(b.key))
      queue.push(...items.slice(0, getMissingSearchBatchSize(libId)))
    }

    if (queue.length === 0) {
      logger.info(`Missing-search: nothing due (${all.length} missing items, all in cooldown)`)
      return
    }

    logger.info(`Missing-search cycle: processing ${queue.length} item(s) — next-N per library (${dueCount} due, ${all.length - dueCount} in cooldown)`)

    for (const item of queue) {
      const indexers = pickHealthyIndexers(item.module)
      if (indexers.length === 0) {
        logger.debug(`No healthy indexers for ${item.module}, skipping ${item.label}`)
        continue
      }

      const counts = item.module === 'series'
        ? await runSeriesCascade(item, indexers, overrides)
        : await runFlatSearch(item, indexers, overrides)

      totalQueries    += counts.queries
      totalGrabbed    += counts.grabbed
      totalIdentified += counts.identified
      totalUnmatched  += counts.unmatched

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
        itemsDue: dueCount,
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
  logger.info('Starting missing-search scheduler (hourly targeted searches)')
  startupTimer = setTimeout(() => { void runCycle() }, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  timer = setInterval(() => { void runCycle() }, SCHEDULE_INTERVAL_MS)
  timer.unref?.()
}

export function stopMissingSearchScheduler(): void {
  if (timer) clearInterval(timer)
  if (startupTimer) clearTimeout(startupTimer)
  timer = null
  startupTimer = null
  started = false
}

export async function triggerMissingSearchNow(tabId?: number, overrides?: QualityOverrides): Promise<{ started: boolean }> {
  if (inFlight) return { started: false }
  // Manual trigger: bypass the per-item cooldown so an explicit click always searches.
  void runCycle(tabId, overrides, true)
  return { started: true }
}
