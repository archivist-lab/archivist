import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

export type IndexerHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | 'disabled'

export interface IndexerRssState {
  indexerId: string
  lastPolledAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastReleasesFound: number
  lastReleasesGrabbed: number
  consecutiveFailures: number
  backoffUntil: number | null
  highestPubDate: number
  recentGuids: string[]
  lastError: string | null
  health: IndexerHealth
  pollIntervalMs: number
}

export interface IndexerSearchState {
  indexerId: string
  lastSearchAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastResultCount: number
  consecutiveFailures: number
  lastError: string | null
  health: IndexerHealth
  searchType: string | null
  module: string | null
  query: string | null
}

const RECENT_GUID_WINDOW = 200
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000

let migrated = false

export function initStateStore(db: Database = getDb()): void {
  if (migrated) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_rss_state (
      indexer_id TEXT PRIMARY KEY,
      last_polled_at INTEGER,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      last_releases_found INTEGER NOT NULL DEFAULT 0,
      last_releases_grabbed INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      backoff_until INTEGER,
      highest_pub_date INTEGER NOT NULL DEFAULT 0,
      recent_guids TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      health TEXT NOT NULL DEFAULT 'unknown',
      poll_interval_ms INTEGER NOT NULL DEFAULT ${DEFAULT_POLL_INTERVAL_MS}
    );
    CREATE TABLE IF NOT EXISTS indexer_search_state (
      indexer_id TEXT PRIMARY KEY,
      last_search_at INTEGER,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      last_result_count INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      health TEXT NOT NULL DEFAULT 'unknown',
      search_type TEXT,
      module TEXT,
      query TEXT
    );
  `)
  migrated = true
}

function rowToState(row: any): IndexerRssState {
  let recentGuids: string[] = []
  try { recentGuids = JSON.parse(row.recent_guids ?? '[]') } catch {}
  return {
    indexerId: row.indexer_id,
    lastPolledAt: row.last_polled_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastReleasesFound: row.last_releases_found ?? 0,
    lastReleasesGrabbed: row.last_releases_grabbed ?? 0,
    consecutiveFailures: row.consecutive_failures ?? 0,
    backoffUntil: row.backoff_until,
    highestPubDate: row.highest_pub_date ?? 0,
    recentGuids,
    lastError: row.last_error,
    health: row.health ?? 'unknown',
    pollIntervalMs: row.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS,
  }
}

export function defaultState(indexerId: string): IndexerRssState {
  return {
    indexerId,
    lastPolledAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastReleasesFound: 0,
    lastReleasesGrabbed: 0,
    consecutiveFailures: 0,
    backoffUntil: null,
    highestPubDate: 0,
    recentGuids: [],
    lastError: null,
    health: 'unknown',
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  }
}

export function getState(indexerId: string, db: Database = getDb()): IndexerRssState {
  initStateStore(db)
  const row = db.prepare('SELECT * FROM indexer_rss_state WHERE indexer_id = ?').get(indexerId) as any
  return row ? rowToState(row) : defaultState(indexerId)
}

export function listAllStates(db: Database = getDb()): IndexerRssState[] {
  initStateStore(db)
  const rows = db.prepare('SELECT * FROM indexer_rss_state').all() as any[]
  return rows.map(rowToState)
}

export function saveState(state: IndexerRssState, db: Database = getDb()): void {
  initStateStore(db)
  db.prepare(`
    INSERT INTO indexer_rss_state (
      indexer_id, last_polled_at, last_success_at, last_failure_at,
      last_releases_found, last_releases_grabbed,
      consecutive_failures, backoff_until, highest_pub_date,
      recent_guids, last_error, health, poll_interval_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(indexer_id) DO UPDATE SET
      last_polled_at = excluded.last_polled_at,
      last_success_at = excluded.last_success_at,
      last_failure_at = excluded.last_failure_at,
      last_releases_found = excluded.last_releases_found,
      last_releases_grabbed = excluded.last_releases_grabbed,
      consecutive_failures = excluded.consecutive_failures,
      backoff_until = excluded.backoff_until,
      highest_pub_date = excluded.highest_pub_date,
      recent_guids = excluded.recent_guids,
      last_error = excluded.last_error,
      health = excluded.health,
      poll_interval_ms = excluded.poll_interval_ms
  `).run(
    state.indexerId,
    state.lastPolledAt,
    state.lastSuccessAt,
    state.lastFailureAt,
    state.lastReleasesFound,
    state.lastReleasesGrabbed,
    state.consecutiveFailures,
    state.backoffUntil,
    state.highestPubDate,
    JSON.stringify(state.recentGuids.slice(-RECENT_GUID_WINDOW)),
    state.lastError,
    state.health,
    state.pollIntervalMs,
  )
}

export function deleteState(indexerId: string, db: Database = getDb()): void {
  initStateStore(db)
  db.prepare('DELETE FROM indexer_rss_state WHERE indexer_id = ?').run(indexerId)
  db.prepare('DELETE FROM indexer_search_state WHERE indexer_id = ?').run(indexerId)
}

export function listSearchStates(db: Database = getDb()): IndexerSearchState[] {
  initStateStore(db)
  return (db.prepare('SELECT * FROM indexer_search_state').all() as any[]).map(row => ({
    indexerId: row.indexer_id,
    lastSearchAt: row.last_search_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastResultCount: row.last_result_count ?? 0,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastError: row.last_error,
    health: row.health ?? 'unknown',
    searchType: row.search_type,
    module: row.module,
    query: row.query,
  }))
}

export function recordSearchStats(
  stats: Array<{ indexerId: string; resultCount: number; error: string | null }>,
  context: { type: string; module?: string; query: string },
  now = Date.now(),
  db: Database = getDb(),
): void {
  initStateStore(db)
  const current = db.prepare('SELECT consecutive_failures FROM indexer_search_state WHERE indexer_id = ?')
  const write = db.prepare(`
    INSERT INTO indexer_search_state (
      indexer_id, last_search_at, last_success_at, last_failure_at,
      last_result_count, consecutive_failures, last_error, health,
      search_type, module, query
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(indexer_id) DO UPDATE SET
      last_search_at = excluded.last_search_at,
      last_success_at = excluded.last_success_at,
      last_failure_at = excluded.last_failure_at,
      last_result_count = excluded.last_result_count,
      consecutive_failures = excluded.consecutive_failures,
      last_error = excluded.last_error,
      health = excluded.health,
      search_type = excluded.search_type,
      module = excluded.module,
      query = excluded.query
  `)
  const tx = db.transaction(() => {
    for (const stat of stats) {
      const prior = current.get(stat.indexerId) as { consecutive_failures: number } | undefined
      const failures = stat.error ? (prior?.consecutive_failures ?? 0) + 1 : 0
      const health: IndexerHealth = stat.error ? (failures >= 3 ? 'unhealthy' : 'degraded') : 'healthy'
      write.run(
        stat.indexerId,
        now,
        stat.error ? null : now,
        stat.error ? now : null,
        stat.resultCount,
        failures,
        stat.error?.slice(0, 2000) ?? null,
        health,
        context.type,
        context.module ?? null,
        context.query.slice(0, 500),
      )
    }
  })
  tx()
}
