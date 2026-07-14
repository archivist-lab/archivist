import type {
  EpisodeSummary,
  FilmSummary,
  PlayerHub,
  PlayerHubId,
  PlayerLibraryViewPreferences,
  PlayerMediaCard,
  PlayerWidget,
  PlayerWidgetPreference,
  PlayerWidgetSource,
  SeriesSummary,
} from '@archivist/contracts'
import { getDb } from '../db.js'
import { getPlayerConfig } from './config.js'
import { getPlayerPreferences } from './preferences.js'
import { serializeEpisodeSummary, serializeFilmSummary, serializeSeriesSummary, toMediaCard } from './serializers.js'

export interface GetPlayerHubInput {
  hubId: PlayerHubId
  profileId: string
  libraryId?: number | null
  cursor?: string | null
  limit?: number | null
}

interface Cursor { sortValue: string | number | null; id: number }

export class PlayerCursorError extends Error {
  constructor(message = 'Invalid player cursor') { super(message); this.name = 'PlayerCursorError' }
}
export class PlayerHubNotFoundError extends Error {
  constructor(hubId: string) { super(`Player hub ${hubId} was not found`); this.name = 'PlayerHubNotFoundError' }
}

export function encodePlayerCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodePlayerCursor(raw: string): Cursor {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new PlayerCursorError()
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!value || Object.keys(value).length !== 2 || !('sortValue' in value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1) throw new Error('shape')
    if (value.sortValue !== null && typeof value.sortValue !== 'string' && typeof value.sortValue !== 'number') throw new Error('sort')
    return { sortValue: value.sortValue as string | number | null, id: Number(value.id) }
  } catch { throw new PlayerCursorError() }
}

const progressJoin = (type: 'film' | 'episode', alias: string) => `
  LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = '${type}' AND pp.media_id = ${alias}.id`
const progressColumns = `pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed`

function nextCursor(items: any[], limit: number, sort: (row: any) => string | number | null): { rows: any[]; cursor: string | null } {
  const hasMore = items.length > limit
  const rows = hasMore ? items.slice(0, limit) : items
  const last = rows.at(-1)
  return { rows, cursor: hasMore && last ? encodePlayerCursor({ sortValue: sort(last), id: Number(last.id) }) : null }
}

interface WidgetQueryOptions {
  libraryBrowse?: boolean
  libraryId?: number | null
  libraryPreferences?: PlayerLibraryViewPreferences
}

function widgetForSource(pref: PlayerWidgetPreference, profileId: string, cursorRaw?: string | null, requestedLimit?: number | null, options?: WidgetQueryOptions): PlayerWidget {
  const db = getDb()
  const config = getPlayerConfig(process.env)
  const limit = Math.max(1, Math.min(pref.limit, requestedLimit ?? pref.limit, config.maxWidgetItems))
  const cursor = cursorRaw ? decodePlayerCursor(cursorRaw) : null
  let raw: any[] = []
  let total = 0
  let sort: (row: any) => string | number | null = row => row.id

  if (pref.source === 'recent-films' || pref.source === 'downloading') {
    const status = pref.source === 'downloading' ? "AND f.status = 'acquiring'" : 'AND f.file_path IS NOT NULL'
    const cursorSql = cursor ? 'AND (COALESCE(f.acquired_at, f.added_at) < ? OR (COALESCE(f.acquired_at, f.added_at) = ? AND f.id < ?))' : ''
    const params: unknown[] = [profileId]
    if (cursor) params.push(cursor.sortValue, cursor.sortValue, cursor.id)
    params.push(limit + 1)
    raw = db.prepare(`SELECT f.*, ${progressColumns} FROM films f ${progressJoin('film', 'f')}
      WHERE 1=1 ${status} ${cursorSql}
      ORDER BY COALESCE(f.acquired_at, f.added_at) DESC, f.id DESC LIMIT ?`).all(...params) as any[]
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM films f WHERE 1=1 ${status}`).get() as any).n)
    sort = row => row.acquired_at ?? row.added_at ?? ''
  } else if (pref.source === 'recent-episodes') {
    const cursorSql = cursor ? 'AND (e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))' : ''
    const params: unknown[] = [profileId]
    if (cursor) params.push(cursor.sortValue, cursor.sortValue, cursor.id)
    params.push(limit + 1)
    raw = db.prepare(`SELECT e.*, s.title AS series_title, s.poster_path AS series_poster, ${progressColumns}
      FROM episodes e JOIN series s ON s.id = e.series_id ${progressJoin('episode', 'e')}
      WHERE e.file_path IS NOT NULL ${cursorSql}
      ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`).all(...params) as any[]
    total = Number((db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE file_path IS NOT NULL').get() as any).n)
    sort = row => row.updated_at ?? ''
  } else if (pref.source === 'films-az' || pref.source === 'unwatched-films') {
    const unwatched = pref.source === 'unwatched-films' ? 'AND (pp.completed IS NULL OR pp.completed = 0)' : ''
    const sortName = options?.libraryPreferences?.sort ?? 'title'
    const sortExpression = sortName === 'added' ? "COALESCE(f.added_at, '')"
      : sortName === 'year' ? 'COALESCE(f.year, 0)'
      : sortName === 'rating' ? 'COALESCE(f.rating, 0)'
      : 'COALESCE(f.sort_title, f.title)'
    const descending = sortName !== 'title'
    const comparator = descending ? '<' : '>'
    const direction = descending ? 'DESC' : 'ASC'
    const where: string[] = []
    const whereParams: unknown[] = []
    if (!options?.libraryBrowse || options.libraryPreferences?.hideUnavailable) where.push('f.file_path IS NOT NULL')
    if (options?.libraryId) { where.push('f.library_id = ?'); whereParams.push(options.libraryId) }
    const cursorSql = cursor ? `AND (${sortExpression} ${comparator} ? OR (${sortExpression} = ? AND f.id ${comparator} ?))` : ''
    const params: unknown[] = [profileId]
    params.push(...whereParams)
    if (cursor) params.push(cursor.sortValue, cursor.sortValue, cursor.id)
    params.push(limit + 1)
    raw = db.prepare(`SELECT f.*, ${progressColumns} FROM films f ${progressJoin('film', 'f')}
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ${unwatched} ${cursorSql}
      ORDER BY ${sortExpression} ${direction}, f.id ${direction} LIMIT ?`).all(...params) as any[]
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM films f LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id WHERE ${where.length ? where.join(' AND ') : '1=1'} ${unwatched}`).get(profileId, ...whereParams) as any).n)
    sort = row => sortName === 'added' ? row.added_at ?? '' : sortName === 'year' ? Number(row.year ?? 0) : sortName === 'rating' ? Number(row.rating ?? 0) : row.sort_title ?? row.title ?? ''
  } else if (pref.source === 'series-az') {
    const sortName = options?.libraryPreferences?.sort ?? 'title'
    const sortExpression = sortName === 'added' ? "COALESCE(s.added_at, '')"
      : sortName === 'year' ? 'COALESCE(s.year, 0)'
      : sortName === 'rating' ? 'COALESCE(s.rating, 0)'
      : 'COALESCE(s.sort_title, s.title)'
    const descending = sortName !== 'title'
    const comparator = descending ? '<' : '>'
    const direction = descending ? 'DESC' : 'ASC'
    const where: string[] = []
    const params: unknown[] = []
    if (options?.libraryId) { where.push('s.library_id = ?'); params.push(options.libraryId) }
    if (options?.libraryBrowse && options.libraryPreferences?.hideUnavailable) where.push('EXISTS (SELECT 1 FROM episodes available_episode WHERE available_episode.series_id = s.id AND available_episode.file_path IS NOT NULL)')
    const cursorSql = cursor ? `AND (${sortExpression} ${comparator} ? OR (${sortExpression} = ? AND s.id ${comparator} ?))` : ''
    if (cursor) params.push(cursor.sortValue, cursor.sortValue, cursor.id)
    params.push(limit + 1)
    raw = db.prepare(`SELECT s.*, COUNT(e.id) AS episode_count,
      SUM(CASE WHEN e.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available_count
      FROM series s LEFT JOIN episodes e ON e.series_id = s.id
      WHERE ${where.length ? where.join(' AND ') : '1=1'} ${cursorSql}
      GROUP BY s.id ORDER BY ${sortExpression} ${direction}, s.id ${direction} LIMIT ?`).all(...params) as any[]
    const totalParams = options?.libraryId ? [options.libraryId] : []
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM series s WHERE ${where.length ? where.join(' AND ') : '1=1'}`).get(...totalParams) as any).n)
    sort = row => sortName === 'added' ? row.added_at ?? '' : sortName === 'year' ? Number(row.year ?? 0) : sortName === 'rating' ? Number(row.rating ?? 0) : row.sort_title ?? row.title ?? ''
  } else if (pref.source === 'continue') {
    const progressRows = db.prepare(`SELECT * FROM playback_progress
      WHERE profile_id = ? AND completed = 0 AND position_seconds > 30
        AND (duration_seconds IS NULL OR duration_seconds <= 0 OR position_seconds / duration_seconds < 0.95)
      ORDER BY updated_at DESC LIMIT ?`).all(profileId, limit + 1) as any[]
    const cards: PlayerMediaCard[] = []
    for (const p of progressRows) {
      if (p.media_type === 'film') {
        const row = db.prepare(`SELECT f.*, pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
          FROM films f JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id WHERE f.id = ?`).get(profileId, p.media_id)
        if (row) cards.push(toMediaCard(serializeFilmSummary(row)))
      } else if (p.media_type === 'episode') {
        const row = db.prepare(`SELECT e.*, s.title AS series_title, s.poster_path AS series_poster,
          pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
          FROM episodes e JOIN series s ON s.id = e.series_id
          JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'episode' AND pp.media_id = e.id WHERE e.id = ?`).get(profileId, p.media_id)
        if (row) cards.push(toMediaCard(serializeEpisodeSummary(row)))
      }
    }
    return { id: pref.id, title: pref.title, source: pref.source, view: pref.view, items: cards.slice(0, limit), nextCursor: null, total: cards.length }
  }

  const page = nextCursor(raw, limit, sort)
  const items = page.rows.map(row => {
    if (pref.source === 'recent-episodes') return toMediaCard(serializeEpisodeSummary(row))
    if (pref.source === 'series-az') return toMediaCard(serializeSeriesSummary(row))
    return toMediaCard(serializeFilmSummary(row))
  })
  return { id: pref.id, title: pref.title, source: pref.source, view: pref.view, items, nextCursor: page.cursor, total }
}

export function getPlayerHub(input: GetPlayerHubInput): PlayerHub {
  if (!['home', 'films', 'series', 'tv'].includes(input.hubId)) throw new PlayerHubNotFoundError(input.hubId)
  const preferences = getPlayerPreferences(input.profileId).preferences
  let prefs: PlayerWidgetPreference[]
  if (input.hubId === 'home') prefs = preferences.home.widgets.filter(widget => widget.enabled)
  else if (input.hubId === 'films') prefs = [{ id: 'films', title: 'Films', source: 'films-az', view: preferences.libraries.films.view, limit: preferences.libraries.films.view === 'list' ? 60 : 36, enabled: true }]
  else if (input.hubId === 'series') prefs = [{ id: 'series', title: 'Series', source: 'series-az', view: preferences.libraries.series.view, limit: preferences.libraries.series.view === 'list' ? 60 : 36, enabled: true }]
  else prefs = []
  const libraryPreferences = input.hubId === 'films' ? preferences.libraries.films : input.hubId === 'series' ? preferences.libraries.series : undefined
  const widgets = prefs.map((pref, index) => widgetForSource(pref, input.profileId, index === 0 ? input.cursor : null, input.limit, {
    libraryBrowse: input.hubId === 'films' || input.hubId === 'series',
    libraryId: input.libraryId,
    libraryPreferences,
  })).filter(widget => widget.items.length > 0)
  const spotlight = widgets.flatMap(widget => widget.items)[0] ?? null
  const categories = input.hubId !== 'home' ? []
    : preferences.home.widgetMode === 'combined'
      ? widgets.map((widget, index) => ({ id: widget.id, label: widget.title, active: index === 0 }))
      : ['categories', 'compound'].includes(preferences.preset)
        ? [{ id: 'all', label: 'All', active: true }, { id: 'films', label: 'Films', active: false }, { id: 'series', label: 'Series', active: false }]
        : []
  return {
    id: input.hubId,
    title: input.hubId === 'tv' ? 'TV' : input.hubId[0].toUpperCase() + input.hubId.slice(1),
    categories,
    spotlight,
    widgets,
  }
}
