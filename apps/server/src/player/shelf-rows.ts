import type { PlayerShelfRow, SeriesShelves } from '@archivist/contracts'
import { getDb } from '../db.js'
import { serializeEpisodeSummary, serializeSeriesSummary } from './serializers.js'
import { getPlayerShelfSettings } from './shelf-settings.js'

/**
 * Runs the configured series rows.
 *
 * Every row is the same shape of query — a source, an optional window over one
 * of its dates, filters, a sort and a cap — so one builder covers whatever the
 * operator has configured, including rows they added themselves.
 */

/** A row's key set, used to honour `dedupeAgainst` between rows. */
const keyOf = (item: { type: string; id: number }) => `${item.type}:${item.id}`

const EPISODE_COLUMNS = `e.*, s.title AS series_title, s.poster_path AS series_poster, s.logo_path AS series_logo,
  s.genres AS series_genres, s.rating AS series_rating, pp.position_seconds AS progress_position,
  pp.duration_seconds AS progress_duration, pp.completed AS progress_completed`

const EPISODE_JOIN = `JOIN series s ON s.id = e.series_id
  LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'episode' AND pp.media_id = e.id`

/** Watch state over an episode's own progress row. */
function watchClause(row: PlayerShelfRow): string {
  switch (row.watchState) {
    case 'unwatched': return 'AND COALESCE(pp.completed, 0) = 0'
    case 'watched': return 'AND COALESCE(pp.completed, 0) = 1'
    case 'in-progress': return 'AND COALESCE(pp.completed, 0) = 0 AND COALESCE(pp.position_seconds, 0) > 30'
    default: return ''
  }
}

/** The column a row's window and date sort read. */
function dateColumn(row: PlayerShelfRow, source: 'episodes' | 'series'): string {
  if (source === 'series') return "COALESCE(s.added_at, '')"
  return row.windowField === 'aired' ? 'e.air_date' : "COALESCE(e.updated_at, e.added_at)"
}

function episodeSort(row: PlayerShelfRow): string {
  switch (row.sort) {
    case 'title': return "COALESCE(s.sort_title, s.title) || printf(' %06d %06d', e.season_number, e.episode_number)"
    case 'rating': return 'COALESCE(s.rating, 0)'
    case 'aired': case 'year': return "COALESCE(e.air_date, '')"
    case 'random': return 'abs((e.id * 1103515245 + ?) % 2147483647)'
    default: return "COALESCE(e.updated_at, e.added_at, '')"
  }
}

function seriesSort(row: PlayerShelfRow): string {
  switch (row.sort) {
    case 'title': return 'COALESCE(s.sort_title, s.title)'
    case 'rating': return 'COALESCE(s.rating, 0)'
    case 'year': case 'released': case 'aired': return 'COALESCE(s.year, 0)'
    case 'random': return 'abs((s.id * 1103515245 + ?) % 2147483647)'
    default: return "COALESCE(s.added_at, '')"
  }
}

/** Shared filters. `alias` is the table carrying genres and rating. */
function filters(row: PlayerShelfRow, genresColumn: string, ratingColumn: string, yearExpression: string): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  for (const genre of row.genres) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${genresColumn}) genre WHERE lower(genre.value) = lower(?))`)
    params.push(genre)
  }
  if (row.minRating != null) { clauses.push(`COALESCE(${ratingColumn}, 0) >= ?`); params.push(row.minRating) }
  if (row.yearFrom != null) { clauses.push(`${yearExpression} >= ?`); params.push(row.yearFrom) }
  if (row.yearTo != null) { clauses.push(`${yearExpression} <= ?`); params.push(row.yearTo) }
  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', params }
}

/** A day-count window, as SQLite modifier text. */
const windowModifier = (row: PlayerShelfRow) => `-${row.windowDays} days`
/** Random rows reshuffle daily rather than on every request. */
const randomSeed = () => Math.floor(Date.now() / 86_400_000)

function runEpisodeRow(row: PlayerShelfRow, profileId: string): any[] {
  const db = getDb()
  const params: unknown[] = [profileId]
  const where: string[] = ['e.file_path IS NOT NULL']
  if (row.windowField === 'added') {
    where.push(`date(COALESCE(e.updated_at, e.added_at)) >= date('now', ?)`)
    params.push(windowModifier(row))
  } else if (row.windowField === 'aired' || row.windowField === 'released') {
    where.push(`e.air_date IS NOT NULL AND date(e.air_date) BETWEEN date('now', ?) AND date('now')`)
    params.push(windowModifier(row))
  }
  const filter = filters(row, 's.genres', 's.rating', "CAST(substr(e.air_date, 1, 4) AS INTEGER)")
  const sortExpression = episodeSort(row)
  const sortParams = row.sort === 'random' ? [randomSeed()] : []
  return db.prepare(`SELECT ${EPISODE_COLUMNS} FROM episodes e ${EPISODE_JOIN}
    WHERE ${where.join(' AND ')} ${watchClause(row)} ${filter.sql}
    ORDER BY ${sortExpression} ${row.sortOrder === 'asc' ? 'ASC' : 'DESC'}, e.id DESC
    LIMIT ?`).all(...params, ...filter.params, ...sortParams, row.limit) as any[]
}

function runSeriesRow(row: PlayerShelfRow, profileId: string): any[] {
  const db = getDb()
  const params: unknown[] = []
  const where: string[] = ["EXISTS (SELECT 1 FROM episodes ae WHERE ae.series_id = s.id AND ae.file_path IS NOT NULL)"]
  if (row.windowField !== 'none') {
    where.push(`date(COALESCE(s.added_at, '')) >= date('now', ?)`)
    params.push(windowModifier(row))
  }
  const filter = filters(row, 's.genres', 's.rating', 'COALESCE(s.year, 0)')
  // Watch state over a series means the state of its available episodes.
  const playable = `we.series_id = s.id AND we.file_path IS NOT NULL`
  const watched = `EXISTS (SELECT 1 FROM episodes we LEFT JOIN playback_progress wp ON wp.profile_id = ? AND wp.media_type = 'episode' AND wp.media_id = we.id WHERE ${playable} AND COALESCE(wp.completed, 0) = 0)`
  const watchParams: unknown[] = []
  if (row.watchState === 'unwatched' || row.watchState === 'in-progress') { where.push(watched); watchParams.push(profileId) }
  if (row.watchState === 'watched') { where.push(`NOT ${watched}`); watchParams.push(profileId) }
  const sortParams = row.sort === 'random' ? [randomSeed()] : []
  return db.prepare(`SELECT s.*,
    (SELECT COUNT(*) FROM episodes ec WHERE ec.series_id = s.id) AS episode_count,
    (SELECT COUNT(*) FROM episodes ac WHERE ac.series_id = s.id AND ac.file_path IS NOT NULL) AS available_count
    FROM series s WHERE ${where.join(' AND ')} ${filter.sql}
    ORDER BY ${seriesSort(row)} ${row.sortOrder === 'asc' ? 'ASC' : 'DESC'}, s.id DESC
    LIMIT ?`).all(...params, ...watchParams, ...filter.params, ...sortParams, row.limit) as any[]
}

/**
 * The next unfinished available episode of each series the viewer has started,
 * most recently watched first. Its shape is fixed — an ordering over playback
 * state, not a filter — so only the cap and the filters apply.
 */
function runNextUpRow(row: PlayerShelfRow, profileId: string): any[] {
  const db = getDb()
  const filter = filters(row, 's.genres', 's.rating', "CAST(substr(e.air_date, 1, 4) AS INTEGER)")
  return db.prepare(`SELECT ${EPISODE_COLUMNS}, watched.last_watched
    FROM episodes e ${EPISODE_JOIN}
    JOIN (
      SELECT e2.series_id, MAX(pp2.updated_at) AS last_watched
      FROM playback_progress pp2 JOIN episodes e2 ON e2.id = pp2.media_id
      WHERE pp2.profile_id = ? AND pp2.media_type = 'episode'
      GROUP BY e2.series_id
    ) watched ON watched.series_id = e.series_id
    WHERE e.file_path IS NOT NULL
      AND COALESCE(pp.completed, 0) = 0
      AND e.id = (
        SELECT next.id FROM episodes next
        LEFT JOIN playback_progress np ON np.profile_id = ? AND np.media_type = 'episode' AND np.media_id = next.id
        WHERE next.series_id = e.series_id AND next.file_path IS NOT NULL AND COALESCE(np.completed, 0) = 0
        ORDER BY next.season_number, next.episode_number LIMIT 1
      ) ${filter.sql}
    ORDER BY watched.last_watched DESC LIMIT ?`)
    .all(profileId, profileId, profileId, ...filter.params, row.limit) as any[]
}

/**
 * Rows in the order they must be resolved: a row that excludes another has to
 * run after it, whatever order they are displayed in. A cycle — two rows each
 * excluding the other — has no valid order, so the remainder falls back to
 * configured order rather than failing the page.
 */
export function resolutionOrder(rows: PlayerShelfRow[]): PlayerShelfRow[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const ordered: PlayerShelfRow[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (row: PlayerShelfRow) => {
    if (done.has(row.id) || visiting.has(row.id)) return
    visiting.add(row.id)
    for (const ref of row.dedupeAgainst) {
      const target = byId.get(ref)
      if (target) visit(target)
    }
    visiting.delete(row.id)
    done.add(row.id)
    ordered.push(row)
  }
  for (const row of rows) visit(row)
  return ordered
}

export function resolveSeriesShelves(profileId: string): SeriesShelves {
  const settings = getPlayerShelfSettings()
  const produced = new Map<string, SeriesShelves['rows'][number]['items']>()

  for (const row of resolutionOrder(settings.series.rows)) {
    if (!row.enabled) { produced.set(row.id, []); continue }
    const excluded = new Set(row.dedupeAgainst.flatMap(ref => (produced.get(ref) ?? []).map(keyOf)))
    // Fetch enough to still fill the row after exclusions, so a dedupe does not
    // quietly shorten it.
    const budget = { ...row, limit: Math.min(row.limit + excluded.size, 200) }
    const raw = row.source === 'series' ? runSeriesRow(budget, profileId)
      : row.source === 'next-up' ? runNextUpRow(budget, profileId)
        : runEpisodeRow(budget, profileId)
    const items = raw.map(entry => row.source === 'series' ? serializeSeriesSummary(entry) : serializeEpisodeSummary(entry))
    produced.set(row.id, (excluded.size ? items.filter(item => !excluded.has(keyOf(item))) : items).slice(0, row.limit))
  }
  // Displayed in configured order, whatever order they had to resolve in.
  return { rows: settings.series.rows.map(row => ({ id: row.id, items: produced.get(row.id) ?? [] })) }
}
