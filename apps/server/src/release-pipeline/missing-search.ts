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
import { parseRelease, punctuationSafeQueryVariants } from './parser.js'
import {
  getSearchMissingSettings, dueWindows, type SelectionStrategy,
} from './search-missing-settings.js'

function toMs(d: string | null | undefined): number | null {
  if (!d) return null
  const t = Date.parse(d)
  return Number.isFinite(t) ? t : null
}

/** Persistent record of scheduled runs (for dedupe + run history). */
function ensureRunTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS search_missing_schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_window_id TEXT NOT NULL,
      scheduled_local_date TEXT NOT NULL,
      scheduled_local_time TEXT NOT NULL,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_item_limit INTEGER NOT NULL,
      selected_item_count INTEGER NOT NULL DEFAULT 0,
      searched_item_count INTEGER NOT NULL DEFAULT 0,
      accepted_release_count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT,
      UNIQUE (schedule_window_id, scheduled_local_date, scheduled_local_time)
    );
  `)
}

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
  /** Best-effort release/air date (ms) — used for the recent-release exclusion. */
  releaseDate: number | null
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
      SELECT id, title, year, COALESCE(digital_release_date, release_date, physical_release_date) AS rd FROM films
      WHERE library_id = ? AND monitored = 1 AND status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ id: number; title: string; year: number | null; rd: string | null }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'films', module: 'films',
        key: `films:${library.id}:${r.id}`,
        label: `${r.title}${r.year ? ` (${r.year})` : ''}`,
        query: r.year ? `${r.title} ${r.year}` : r.title,
        releaseDate: toMs(r.rd) ?? (r.year ? Date.UTC(r.year, 0, 1) : null),
      })
    }
  } else if (library.media_type === 'series') {
    // One search per series with any missing episode in recently-aired or
    // unspecified-airdate episodes (skip far-future episodes; nothing exists
    // to search for yet). releaseDate = oldest such missing episode's air date.
    const rows = db.prepare(`
      SELECT s.id, s.title,
        (SELECT MIN(CASE
            WHEN EXISTS (SELECT 1 FROM new_release_search_state nr WHERE nr.episode_id = e.id AND nr.phase = 'backlog') THEN NULL
            ELSE COALESCE(e.air_at, e.air_date)
          END) FROM episodes e
          JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
          WHERE e.series_id = s.id AND se.monitored = 1 AND e.monitored = 1 AND e.status IN ('wanted', 'missing')
            AND ((e.air_at IS NOT NULL AND datetime(e.air_at) <= datetime('now'))
              OR (e.air_at IS NULL AND (e.air_date IS NULL OR e.air_date <= date('now'))))) AS rd
      FROM series s
      WHERE s.library_id = ? AND s.monitored = 1 AND EXISTS (
        SELECT 1 FROM episodes e
        JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
        WHERE e.series_id = s.id
          AND se.monitored = 1 AND e.monitored = 1 AND e.status IN ('wanted', 'missing')
          AND ((e.air_at IS NOT NULL AND datetime(e.air_at) <= datetime('now'))
            OR (e.air_at IS NULL AND (e.air_date IS NULL OR e.air_date <= date('now'))))
      )
    `).all(library.id) as Array<{ id: number; title: string; rd: string | null }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'series', module: 'series',
        key: `series:${library.id}:${r.id}`,
        label: r.title,
        query: r.title,
        releaseDate: toMs(r.rd),
      })
    }
  } else if (library.media_type === 'music') {
    const rows = db.prepare(`
      SELECT al.id as album_id, al.title as album_title, ar.name as artist_name, al.release_date AS rd
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      WHERE ar.library_id = ? AND ar.monitored = 1 AND al.monitored = 1 AND al.status IN ('wanted', 'missing')
    `).all(library.id) as Array<{ album_id: number; album_title: string; artist_name: string; rd: string | null }>
    for (const r of rows) {
      items.push({
        ...tabRef, mediaType: 'music', module: 'music',
        key: `music:${library.id}:${r.album_id}`,
        label: `${r.artist_name} – ${r.album_title}`,
        query: `${r.artist_name} ${r.album_title}`,
        releaseDate: toMs(r.rd),
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
        releaseDate: null,
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
        releaseDate: null,
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
        releaseDate: null,
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

export interface NewReleaseEpisodeSearchResult {
  searched: boolean
  queries: number
  results: number
  grabbed: number
  message: string
}

/** Targeted, exact-episode search used after the two-hour RSS window. */
export async function searchNewReleaseEpisode(episodeId: number): Promise<NewReleaseEpisodeSearchResult> {
  const row = getDb().prepare(`
    SELECT e.id, e.season_number, e.episode_number, e.status, e.monitored, e.file_path,
           s.id AS series_id, s.title AS series_title, s.library_id, s.monitored AS series_monitored,
           se.monitored AS season_monitored
    FROM episodes e
    JOIN series s ON s.id = e.series_id
    JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
    WHERE e.id = ?
  `).get(episodeId) as any
  if (!row) return { searched: false, queries: 0, results: 0, grabbed: 0, message: 'episode no longer exists' }
  if (row.monitored !== 1 || row.season_monitored !== 1 || row.series_monitored !== 1) return { searched: false, queries: 0, results: 0, grabbed: 0, message: 'episode is not monitored' }
  if (row.file_path || !['wanted', 'missing'].includes(row.status)) return { searched: false, queries: 0, results: 0, grabbed: 0, message: `episode is ${row.status}` }

  const indexers = pickHealthyIndexers('series')
  if (indexers.length === 0) return { searched: false, queries: 0, results: 0, grabbed: 0, message: 'no healthy series indexers' }
  const token = `S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}`
  const base = `${row.series_title} ${token}`
  let queries = 0, resultCount = 0, grabbed = 0
  const queriesToTry = tieredQueries(base, 'series', row.library_id).flatMap(punctuationSafeQueryVariants)
  for (const query of [...new Set(queriesToTry)]) {
    let results: BridgeSearchResult[] = []
    try {
      results = await searchViaIndexers(indexers, query, { timeoutMs: PER_SEARCH_TIMEOUT_MS, module: 'series', type: 'tvsearch' })
    } catch (err) {
      logger.warn(`New-release episode search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    queries++
    const matching = results.filter(result => {
      const parsed = parseRelease(result.title)
      return parsed.season === row.season_number && parsed.episodes.includes(row.episode_number)
    })
    resultCount += matching.length
    if (matching.length === 0) continue
    const outcome = await processReleaseBatch(matching)
    grabbed += outcome.grabbed
    if (grabbed > 0) break
  }
  return {
    searched: true, queries, results: resultCount, grabbed,
    message: grabbed > 0 ? `grabbed ${token}` : `${resultCount} matching result${resultCount === 1 ? '' : 's'}, none grabbed`,
  }
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
      SELECT e.season_number AS s, e.episode_number AS e
      FROM episodes e
      JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
      WHERE e.series_id = ? AND se.monitored = 1 AND e.monitored = 1 AND e.status IN ('wanted', 'missing')
        AND ((e.air_at IS NOT NULL AND datetime(e.air_at) <= datetime('now'))
          OR (e.air_at IS NULL AND (e.air_date IS NULL OR substr(e.air_date, 1, 10) <= date('now'))))
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

    const targetQueries = tieredQueries(target.base, 'series', item.tabId, overrides?.targetTier)
      .flatMap(punctuationSafeQueryVariants)
    for (const q of [...new Set(targetQueries)]) {
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

interface RunOptions {
  tabId?: number
  overrides?: QualityOverrides
  /** Manual runs may bypass the per-item cooldown. */
  bypassCooldown?: boolean
  /** By default recent-release items are excluded (RSS owns them). */
  includeRecent?: boolean
  /** Global cap across libraries (scheduled backlog). If unset, uses per-library batch. */
  itemLimit?: number
  selectionStrategy?: SelectionStrategy
}

export interface RunResult { selected: number; searched: number; grabbed: number }

function withinCooldownMs(key: string, cooldownMs: number, now: number): boolean {
  if (cooldownMs <= 0) return false
  return now - lastSearchTime(key) < cooldownMs
}

function selectByStrategy(items: MissingItem[], strategy: SelectionStrategy, limit: number): MissingItem[] {
  const sorted = [...items]
  if (strategy === 'oldest_release_first') sorted.sort((a, b) => (a.releaseDate ?? Infinity) - (b.releaseDate ?? Infinity))
  else if (strategy === 'random') for (let i = sorted.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [sorted[i], sorted[j]] = [sorted[j], sorted[i]] }
  else if (strategy === 'balanced_by_media_type') {
    // Round-robin across media types so one big category can't starve the rest.
    const byType = new Map<Module, MissingItem[]>()
    for (const it of [...items].sort((a, b) => lastSearchTime(a.key) - lastSearchTime(b.key))) {
      const list = byType.get(it.module) ?? []; list.push(it); byType.set(it.module, list)
    }
    const out: MissingItem[] = []
    const buckets = [...byType.values()]
    let idx = 0
    while (out.length < limit && buckets.some(b => b.length)) {
      const b = buckets[idx % buckets.length]; idx++
      if (b.length) out.push(b.shift()!)
    }
    return out
  }
  else sorted.sort((a, b) => lastSearchTime(a.key) - lastSearchTime(b.key)) // oldest_search_first (+ highest_priority fallback)
  return sorted.slice(0, limit)
}

async function runCycle(opts: RunOptions = {}): Promise<RunResult> {
  if (inFlight) {
    logger.debug('Cycle already in flight, skipping')
    return { selected: 0, searched: 0, grabbed: 0 }
  }
  inFlight = true
  const cycleStart = Date.now()
  let totalQueries = 0
  let totalGrabbed = 0
  let totalIdentified = 0
  let totalUnmatched = 0

  try {
    const settings = getSearchMissingSettings()
    const now = Date.now()
    const exclusionMs = settings.recentReleaseExclusionHours * 60 * 60_000
    const cooldownMs = opts.bypassCooldown ? 0 : settings.itemCooldownHours * 60 * 60_000
    const all = collectAllMissing(opts.tabId)

    // Backlog discipline: exclude recently-released items (RSS owns those) and
    // items still inside their cooldown.
    const eligible = all.filter(item => {
      if (!opts.includeRecent && item.releaseDate != null && item.releaseDate > now - exclusionMs) return false
      if (withinCooldownMs(item.key, cooldownMs, now)) return false
      return true
    })
    const dueCount = eligible.length

    // Scheduled/limited runs take the next N globally by the selection strategy;
    // the legacy per-tab button keeps its per-library batch behaviour.
    let queue: MissingItem[]
    if (opts.itemLimit != null) {
      queue = selectByStrategy(eligible, opts.selectionStrategy ?? settings.selectionStrategy, opts.itemLimit)
    } else {
      const dueByLib = new Map<number, MissingItem[]>()
      for (const item of eligible) {
        const list = dueByLib.get(item.tabId) ?? []; list.push(item); dueByLib.set(item.tabId, list)
      }
      queue = []
      for (const [libId, items] of dueByLib) {
        items.sort((a, b) => lastSearchTime(a.key) - lastSearchTime(b.key))
        queue.push(...items.slice(0, getMissingSearchBatchSize(libId)))
      }
    }

    if (queue.length === 0) {
      logger.info(`Missing-search: nothing eligible (${all.length} missing, ${dueCount} eligible after recent-release + cooldown filters)`)
      return { selected: 0, searched: 0, grabbed: 0 }
    }

    logger.info(`Missing-search: processing ${queue.length} item(s) — ${dueCount} eligible backlog, ${all.length - dueCount} excluded (recent/cooldown)`)

    for (const item of queue) {
      const indexers = pickHealthyIndexers(item.module)
      if (indexers.length === 0) {
        logger.debug(`No healthy indexers for ${item.module}, skipping ${item.label}`)
        continue
      }

      const counts = item.module === 'series'
        ? await runSeriesCascade(item, indexers, opts.overrides)
        : await runFlatSearch(item, indexers, opts.overrides)

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
        tabId: opts.tabId,
      },
    })
    return { selected: queue.length, searched: queue.length, grabbed: totalGrabbed }
  } catch (err) {
    logger.error('Cycle error:', err)
    recordEvent({
      category: 'missing-search', action: 'cycle-error', severity: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
    return { selected: 0, searched: 0, grabbed: 0 }
  } finally {
    inFlight = false
  }
}

/** Evaluate the schedule every 60s; run each due window at most once (within grace). */
async function evaluateSchedule(): Promise<void> {
  const settings = getSearchMissingSettings()
  if (!settings.enabled) return
  const now = new Date()
  const due = dueWindows(settings, now)
  if (due.length === 0) return
  const db = getDb()

  for (const w of due) {
    // Claim the window/date/time slot atomically; a duplicate insert => already ran.
    let claimed: number | undefined
    try {
      const res = db.prepare(`
        INSERT INTO search_missing_schedule_runs
          (schedule_window_id, scheduled_local_date, scheduled_local_time, timezone, status, requested_item_limit, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
      `).run(w.windowId, w.scheduledDate, w.time, settings.timezone, w.itemsPerRun, Date.now())
      claimed = Number(res.lastInsertRowid)
    } catch {
      continue // UNIQUE violation → this window already ran today
    }

    logger.info(`Search Missing scheduled run: window ${w.windowId} @ ${w.time} (${w.minutesLate}m late), limit ${w.itemsPerRun}`)
    try {
      const result = await runCycle({ itemLimit: w.itemsPerRun, selectionStrategy: settings.selectionStrategy })
      db.prepare(`UPDATE search_missing_schedule_runs SET status = ?, selected_item_count = ?, searched_item_count = ?, accepted_release_count = ?, completed_at = ? WHERE id = ?`)
        .run(result.selected === 0 ? 'completed_no_candidates' : 'completed', result.selected, result.searched, result.grabbed, Date.now(), claimed)
    } catch (err) {
      db.prepare(`UPDATE search_missing_schedule_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
        .run(err instanceof Error ? err.message : String(err), Date.now(), claimed)
    }
  }
}

export function startMissingSearchScheduler(): void {
  if (started) return
  started = true
  ensureRunTable()
  logger.info('Starting Search Missing backlog scheduler (per-day windows; recent releases handled by RSS)')
  // Evaluate the schedule every 60s (spec §6). No fixed hourly full-library sweep.
  timer = setInterval(() => { void evaluateSchedule() }, 60_000)
  timer.unref?.()
}

export function stopMissingSearchScheduler(): void {
  if (timer) clearInterval(timer)
  if (startupTimer) clearTimeout(startupTimer)
  timer = null
  startupTimer = null
  started = false
}

/**
 * Manual Search Missing. Defaults (spec §14): bypass cooldown, exclude recent
 * releases (RSS owns those). `itemLimit` unset = existing per-library batch.
 */
export async function triggerMissingSearchNow(
  tabId?: number,
  overrides?: QualityOverrides,
  manual?: { itemLimit?: number; includeRecent?: boolean; selectionStrategy?: SelectionStrategy },
): Promise<{ started: boolean }> {
  if (inFlight) return { started: false }
  void runCycle({
    tabId,
    overrides,
    bypassCooldown: getSearchMissingSettings().manualRunBypassesCooldown,
    includeRecent: manual?.includeRecent ?? false,
    itemLimit: manual?.itemLimit,
    selectionStrategy: manual?.selectionStrategy,
  })
  return { started: true }
}

/** Count monitored-missing items currently eligible for a backlog run (for the UI). */
export function countEligibleBacklog(includeRecent = false): number {
  const settings = getSearchMissingSettings()
  const now = Date.now()
  const exclusionMs = settings.recentReleaseExclusionHours * 60 * 60_000
  const cooldownMs = settings.itemCooldownHours * 60 * 60_000
  let count = 0
  for (const item of collectAllMissing()) {
    if (!includeRecent && item.releaseDate != null && item.releaseDate > now - exclusionMs) continue
    if (withinCooldownMs(item.key, cooldownMs, now)) continue
    count++
  }
  return count
}

/** Recent scheduled-run history rows (for the UI). */
export function listScheduleRuns(limit = 50): unknown[] {
  ensureRunTable()
  return getDb().prepare('SELECT * FROM search_missing_schedule_runs ORDER BY id DESC LIMIT ?').all(limit)
}
