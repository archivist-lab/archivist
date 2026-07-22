import type {
  EpisodeSummary,
  FilmSummary,
  PlayerHub,
  PlayerHubPreference,
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
import { EMPTY_BROWSE_FILTER, getBrowsePage } from './browse-service.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { getRecommendationPage } from '../recommendations/service.js'

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

function titleCaseStatus(value: unknown): string {
  return String(value ?? 'downloading').replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function formatTransferRate(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

function formatEta(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec left`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`
  return `${Math.floor(seconds / 3600)} hr ${Math.ceil(seconds % 3600 / 60)} min left`
}

export function toAcquisitionCard(torrent: any, matched: PlayerMediaCard | null = null, presentation?: Partial<PlayerMediaCard> & { kind?: 'film' | 'series' | 'season' | 'episode' | 'other' }): PlayerMediaCard {
  const fraction = Math.min(1, Math.max(0, Number(torrent.progress) || 0))
  const percent = fraction * 100
  const status = titleCaseStatus(torrent.status)
  const speed = formatTransferRate(Number(torrent.downloadSpeed))
  const eta = formatEta(Number(torrent.eta))
  return {
    key: `download:${String(torrent.id)}`,
    mediaType: presentation?.mediaType ?? matched?.mediaType ?? 'download',
    id: presentation?.id ?? matched?.id ?? String(torrent.id),
    route: presentation?.route ?? matched?.route ?? '',
    title: presentation?.title ?? String(torrent.name || matched?.title || 'Untitled Download'),
    subtitle: presentation?.subtitle ?? [matched?.title, `${Math.round(percent)}%`, speed, eta].filter(Boolean).join(' · '),
    plot: matched?.plot ?? null,
    year: matched?.year ?? null,
    posterUrl: presentation?.posterUrl ?? matched?.posterUrl ?? null,
    landscapeUrl: presentation?.landscapeUrl ?? matched?.landscapeUrl ?? null,
    backdropUrl: presentation?.backdropUrl ?? matched?.backdropUrl ?? null,
    logoUrl: presentation?.logoUrl ?? matched?.logoUrl ?? null,
    progress: null,
    badges: [
      { label: status, tone: torrent.status === 'error' ? 'warning' as const : 'accent' as const },
      speed ? { label: speed, tone: 'neutral' as const } : null,
      eta ? { label: eta, tone: 'neutral' as const } : null,
    ].filter((badge): badge is NonNullable<typeof badge> => !!badge),
    available: !!matched?.route,
    primaryAction: matched?.route ? 'unavailable' : 'unavailable',
    acquisition: {
      kind: presentation?.kind ?? (matched?.mediaType === 'film' ? 'film' : matched?.mediaType === 'episode' ? 'episode' : 'other'),
      status,
      percent,
      downloadSpeed: Math.max(0, Number(torrent.downloadSpeed) || 0),
      etaSeconds: Number.isFinite(Number(torrent.eta)) && Number(torrent.eta) >= 0 ? Number(torrent.eta) : null,
    },
  }
}

function activeAcquisitionCards(db: ReturnType<typeof getDb>, pref: PlayerWidgetPreference, limit: number): PlayerMediaCard[] {
  let torrents: any[]
  try { torrents = getTorrentSession().getAllTorrents() as any[] } catch { return [] }
  const active = torrents.filter(torrent => Number(torrent.progress) < 0.999 && !['seeding', 'queued-seed'].includes(String(torrent.status)))
  active.sort((left, right) => {
    const comparison = pref.sort === 'title'
      ? String(left.name ?? '').localeCompare(String(right.name ?? ''))
      : Number(left.addedAt ?? 0) - Number(right.addedAt ?? 0)
    return pref.sortOrder === 'desc' ? -comparison : comparison
  })
  const cards = active.map(torrent => {
    const hash = String(torrent.infoHash ?? '').toLowerCase()
    let matched: PlayerMediaCard | null = null
    let presentation: (Partial<PlayerMediaCard> & { kind: 'film' | 'series' | 'season' | 'episode' | 'other' }) | undefined
    if (hash) {
      const film = db.prepare('SELECT * FROM films WHERE LOWER(info_hash) = ? ORDER BY updated_at DESC LIMIT 1').get(hash)
      if (film) {
        matched = toMediaCard(serializeFilmSummary(film))
        presentation = { kind: 'film', title: matched.title, subtitle: `${Math.round(Math.min(1, Math.max(0, Number(torrent.progress) || 0)) * 100)}%` }
      }
      else {
        const episodes = db.prepare(`SELECT e.*, s.title AS series_title, s.poster_path AS series_poster, s.backdrop_path AS series_backdrop, s.logo_path AS series_logo,
            se.poster_path AS season_poster
          FROM episodes e JOIN series s ON s.id = e.series_id
          LEFT JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
          WHERE LOWER(e.info_hash) = ? ORDER BY e.season_number, e.episode_number`).all(hash) as any[]
        if (episodes.length) {
          const first = episodes[0]
          matched = toMediaCard(serializeEpisodeSummary(first))
          const seriesIds = new Set(episodes.map(episode => Number(episode.series_id)))
          const seasons = new Set(episodes.map(episode => Number(episode.season_number)))
          const pct = `${Math.round(Math.min(1, Math.max(0, Number(torrent.progress) || 0)) * 100)}%`
          if (seriesIds.size === 1 && episodes.length === 1) {
            presentation = {
              kind: 'episode', title: `E${String(first.episode_number).padStart(2, '0')} · ${first.title || 'Episode'}`,
              subtitle: `${first.series_title} · S${String(first.season_number).padStart(2, '0')}`,
              posterUrl: first.still_path ?? first.series_poster ?? null, landscapeUrl: first.still_path ?? first.series_backdrop ?? null,
              backdropUrl: first.still_path ?? first.series_backdrop ?? null,
            }
          } else if (seriesIds.size === 1 && seasons.size === 1) {
            presentation = {
              kind: 'season', mediaType: 'series', id: Number(first.series_id), route: `/series/${first.series_id}`,
              title: `${first.series_title} S${String(first.season_number).padStart(2, '0')} - ${pct}`, subtitle: 'Season Download',
              posterUrl: first.season_poster ?? first.series_poster ?? null, landscapeUrl: first.series_backdrop ?? null, backdropUrl: first.series_backdrop ?? null,
            }
          } else {
            presentation = {
              kind: 'series', mediaType: 'series', id: Number(first.series_id), route: `/series/${first.series_id}`,
              title: first.series_title, subtitle: pct, posterUrl: first.series_poster ?? null,
              landscapeUrl: first.series_backdrop ?? null, backdropUrl: first.series_backdrop ?? null, logoUrl: first.series_logo ?? null,
            }
          }
        }
      }
    }
    return toAcquisitionCard(torrent, matched, presentation)
  })
  const selected = new Set(pref.downloadMediaTypes)
  return cards.filter(card => selected.has(card.acquisition?.kind === 'film' ? 'films' : ['series', 'season', 'episode'].includes(card.acquisition?.kind ?? '') ? 'series' : 'other')).slice(0, limit)
}

function widgetForSource(pref: PlayerWidgetPreference, profileId: string, cursorRaw?: string | null, requestedLimit?: number | null, options?: WidgetQueryOptions): PlayerWidget {
  const db = getDb()
  const config = getPlayerConfig(process.env)
  const limit = Math.max(1, Math.min(pref.limit, requestedLimit ?? pref.limit, config.maxWidgetItems))
  const cursor = cursorRaw ? decodePlayerCursor(cursorRaw) : null
  let raw: any[] = []
  let total = 0
  let sort: (row: any) => string | number | null = row => row.id

  if (pref.source === 'downloading') {
    const items = activeAcquisitionCards(db, pref, limit)
    return widgetResult(pref, items, null, items.length)
  }

  if (pref.source === 'recommendations') {
    const libraries = db.prepare("SELECT id, media_type FROM libraries WHERE media_type IN ('films','series') ORDER BY id").all() as Array<{ id: number; media_type: string }>
    const ranked: Array<{ item: any; reason: string }> = []
    for (const library of libraries) {
      const mediaType = library.media_type === 'films' ? 'film' : 'series'
      const page = getRecommendationPage(mediaType, profileId, library.id)
      for (const group of page.groups) for (const item of group.items) {
        if (item.localId && ['available', 'partially_available'].includes(item.recommendation.availability)) ranked.push({ item, reason: item.recommendation.reason })
      }
    }
    const cards = ranked.slice(0, limit).flatMap(({ item, reason }) => {
      const row = item.mediaType === 'film'
        ? db.prepare(`SELECT f.*, ${progressColumns} FROM films f ${progressJoin('film', 'f')} WHERE f.id = ?`).get(profileId, item.localId)
        : db.prepare(`SELECT s.*, COUNT(e.id) AS episode_count, COUNT(CASE WHEN e.file_path IS NOT NULL THEN 1 END) AS available_count
            FROM series s LEFT JOIN episodes e ON e.series_id = s.id WHERE s.id = ? GROUP BY s.id`).get(item.localId)
      if (!row) return []
      const card = item.mediaType === 'film' ? toMediaCard(serializeFilmSummary(row)) : toMediaCard(serializeSeriesSummary(row))
      return [{ ...card, subtitle: reason, badges: [{ label: 'Recommended', tone: 'accent' as const }, ...card.badges].slice(0, 4) }]
    })
    return widgetResult(pref, cards, null, cards.length)
  }

  const browseSource = (() => {
    if (pref.source === 'unwatched-series') return { mediaType: 'series' as const, filters: { ...EMPTY_BROWSE_FILTER, watched: 'unwatched' as const, availability: 'available' as const }, sort: 'title' as const, order: 'asc' as const }
    if (pref.source === 'unwatched-episodes') return { mediaType: 'episodes' as const, filters: { ...EMPTY_BROWSE_FILTER, watched: 'unwatched' as const, availability: 'available' as const }, sort: 'title' as const, order: 'asc' as const }
    if (pref.source === 'top-rated-films') return { mediaType: 'films' as const, filters: { ...EMPTY_BROWSE_FILTER, availability: 'available' as const }, sort: 'rating' as const, order: 'desc' as const }
    if (pref.source === 'top-rated-series') return { mediaType: 'series' as const, filters: EMPTY_BROWSE_FILTER, sort: 'rating' as const, order: 'desc' as const }
    if (pref.source === 'random-films') return { mediaType: 'films' as const, filters: { ...EMPTY_BROWSE_FILTER, availability: 'available' as const }, sort: 'title' as const, order: 'asc' as const, random: true }
    if (pref.source === 'random-series') return { mediaType: 'series' as const, filters: EMPTY_BROWSE_FILTER, sort: 'title' as const, order: 'asc' as const, random: true }
    if (pref.source === 'collections') return { mediaType: 'collections' as const, filters: EMPTY_BROWSE_FILTER, sort: 'title' as const, order: 'asc' as const }
    if (pref.source === 'saved-filter' && pref.savedFilterId) {
      const saved = getPlayerPreferences(profileId).preferences.browsing.savedFilters.find(entry => entry.id === pref.savedFilterId)
      if (saved) return { mediaType: saved.mediaType, filters: saved.filters, sort: saved.sort, order: saved.sortOrder }
    }
    return null
  })()
  if (browseSource) {
    const browseSort = pref.sort === 'source' ? browseSource.sort : pref.sort
    const browseOrder = pref.sort === 'source' ? browseSource.order : pref.sortOrder
    const page = getBrowsePage({
      mediaType: browseSource.mediaType,
      profileId,
      filters: browseSource.filters,
      sort: browseSort,
      sortOrder: browseOrder,
      cursor: browseSource.random ? null : cursorRaw,
      limit: browseSource.random ? config.maxWidgetItems : limit,
      libraryId: options?.libraryId,
      randomSeed: browseSource.random ? Math.floor(Date.now() / 86_400_000) : null,
    })
    return widgetResult(pref, page.items.slice(0, limit), browseSource.random ? null : page.nextCursor, page.total)
  }

  if (pref.source === 'recent-films') {
    const status = 'AND f.file_path IS NOT NULL'
    const sortExpression = pref.sort === 'title' ? 'COALESCE(f.sort_title, f.title)'
      : pref.sort === 'year' ? 'COALESCE(f.year, 0)'
      : pref.sort === 'rating' ? 'COALESCE(f.rating, 0)'
      : 'COALESCE(f.acquired_at, f.added_at)'
    const comparator = pref.sortOrder === 'desc' ? '<' : '>'
    const direction = pref.sortOrder === 'desc' ? 'DESC' : 'ASC'
    const cursorSql = cursor ? `AND (${sortExpression} ${comparator} ? OR (${sortExpression} = ? AND f.id ${comparator} ?))` : ''
    const params: unknown[] = [profileId]
    if (cursor) params.push(cursor.sortValue, cursor.sortValue, cursor.id)
    params.push(limit + 1)
    raw = db.prepare(`SELECT f.*, ${progressColumns} FROM films f ${progressJoin('film', 'f')}
      WHERE 1=1 ${status} ${cursorSql}
      ORDER BY ${sortExpression} ${direction}, f.id ${direction} LIMIT ?`).all(...params) as any[]
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM films f WHERE 1=1 ${status}`).get() as any).n)
    sort = row => pref.sort === 'title' ? row.sort_title ?? row.title ?? ''
      : pref.sort === 'year' ? Number(row.year ?? 0)
      : pref.sort === 'rating' ? Number(row.rating ?? 0)
      : row.acquired_at ?? row.added_at ?? ''
  } else if (pref.source === 'recent-episodes') {
    const sortExpression = pref.sort === 'title' ? "COALESCE(e.title, '')"
      : pref.sort === 'year' ? "COALESCE(e.air_date, '')"
      : pref.sort === 'rating' ? 'COALESCE(s.rating, 0)'
      : "COALESCE(e.updated_at, '')"
    const comparator = pref.sortOrder === 'desc' ? '<' : '>'
    const direction = pref.sortOrder === 'desc' ? 'DESC' : 'ASC'
    const cursorSql = cursor ? `AND (${sortExpression} ${comparator} ? OR (${sortExpression} = ? AND e.id ${comparator} ?))` : ''
    const params: unknown[] = [profileId]
    if (cursor) params.push(cursor.sortValue, cursor.sortValue, cursor.id)
    params.push(limit + 1)
    raw = db.prepare(`SELECT e.*, s.title AS series_title, s.poster_path AS series_poster, s.rating AS series_rating, ${progressColumns}
      FROM episodes e JOIN series s ON s.id = e.series_id ${progressJoin('episode', 'e')}
      WHERE e.file_path IS NOT NULL ${cursorSql}
      ORDER BY ${sortExpression} ${direction}, e.id ${direction} LIMIT ?`).all(...params) as any[]
    total = Number((db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE file_path IS NOT NULL').get() as any).n)
    sort = row => pref.sort === 'title' ? row.title ?? ''
      : pref.sort === 'year' ? row.air_date ?? ''
      : pref.sort === 'rating' ? Number(row.series_rating ?? 0)
      : row.updated_at ?? ''
  } else if (pref.source === 'films-az' || pref.source === 'unwatched-films') {
    const unwatched = pref.source === 'unwatched-films' ? 'AND (pp.completed IS NULL OR pp.completed = 0)' : ''
    const sortName = pref.sort === 'source' ? options?.libraryPreferences?.sort ?? 'title' : pref.sort
    const sortExpression = sortName === 'added' ? "COALESCE(f.added_at, '')"
      : sortName === 'year' ? 'COALESCE(f.year, 0)'
      : sortName === 'rating' ? 'COALESCE(f.rating, 0)'
      : 'COALESCE(f.sort_title, f.title)'
    const descending = pref.sort === 'source' && options?.libraryBrowse ? sortName !== 'title' : pref.sortOrder === 'desc'
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
    const sortName = pref.sort === 'source' ? options?.libraryPreferences?.sort ?? 'title' : pref.sort
    const sortExpression = sortName === 'added' ? "COALESCE(s.added_at, '')"
      : sortName === 'year' ? 'COALESCE(s.year, 0)'
      : sortName === 'rating' ? 'COALESCE(s.rating, 0)'
      : 'COALESCE(s.sort_title, s.title)'
    const descending = pref.sort === 'source' && options?.libraryBrowse ? sortName !== 'title' : pref.sortOrder === 'desc'
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
  } else if (pref.source === 'continue' || pref.source === 'recently-played') {
    const progressRows = db.prepare(`SELECT * FROM playback_progress
      WHERE profile_id = ? ${pref.source === 'continue' ? 'AND completed = 0 AND position_seconds > 30 AND (duration_seconds IS NULL OR duration_seconds <= 0 OR position_seconds / duration_seconds < 0.95)' : 'AND (completed = 1 OR position_seconds > 30)'}
      ORDER BY updated_at DESC LIMIT ?`).all(profileId, config.maxWidgetItems) as any[]
    const entries: Array<{ card: PlayerMediaCard; added: string; rating: number; year: number }> = []
    for (const p of progressRows) {
      if (p.media_type === 'film') {
        const row = db.prepare(`SELECT f.*, pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
          FROM films f JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id WHERE f.id = ?`).get(profileId, p.media_id)
        if (row) entries.push({ card: toMediaCard(serializeFilmSummary(row)), added: String((row as any).added_at ?? ''), rating: Number((row as any).rating ?? 0), year: Number((row as any).year ?? 0) })
      } else if (p.media_type === 'episode') {
        const row = db.prepare(`SELECT e.*, s.title AS series_title, s.poster_path AS series_poster, s.rating AS series_rating,
          pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
          FROM episodes e JOIN series s ON s.id = e.series_id
          JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'episode' AND pp.media_id = e.id WHERE e.id = ?`).get(profileId, p.media_id)
        if (row) entries.push({ card: toMediaCard(serializeEpisodeSummary(row)), added: String((row as any).added_at ?? ''), rating: Number((row as any).series_rating ?? 0), year: Number(String((row as any).air_date ?? '').slice(0, 4)) || 0 })
      }
    }
    const sorted = pref.sort === 'source' ? entries : [...entries].sort((a, b) => {
      const left = pref.sort === 'year' ? a.year : pref.sort === 'rating' ? a.rating : pref.sort === 'added' ? a.added : a.card.title.toLocaleLowerCase()
      const right = pref.sort === 'year' ? b.year : pref.sort === 'rating' ? b.rating : pref.sort === 'added' ? b.added : b.card.title.toLocaleLowerCase()
      const comparison = left < right ? -1 : left > right ? 1 : 0
      return pref.sortOrder === 'desc' ? -comparison : comparison
    })
    return widgetResult(pref, sorted.slice(0, limit).map(entry => entry.card), null, sorted.length)
  }

  const page = nextCursor(raw, limit, sort)
  const items = page.rows.map(row => {
    if (pref.source === 'recent-episodes') return toMediaCard(serializeEpisodeSummary(row))
    if (pref.source === 'series-az') return toMediaCard(serializeSeriesSummary(row))
    return toMediaCard(serializeFilmSummary(row))
  })
  return widgetResult(pref, items, page.cursor, total)
}

function showMoreRoute(pref: PlayerWidgetPreference): string | null {
  const source = pref.source
  if (source === 'saved-filter' && pref.savedFilterId) return `/browse/saved?savedFilter=${encodeURIComponent(pref.savedFilterId)}`
  if (source === 'collections') return '/browse/collections'
  if (source === 'unwatched-series' || source === 'top-rated-series' || source === 'random-series') return `/browse/series?source=${source}`
  if (source === 'unwatched-episodes') return '/browse/episodes?source=unwatched-episodes'
  if (source === 'top-rated-films' || source === 'random-films') return `/browse/films?source=${source}`
  if (source === 'downloading') return null
  if (source === 'recommendations') return null
  if (['recent-films', 'unwatched-films', 'films-az'].includes(source)) return '/films'
  if (['recent-episodes', 'series-az'].includes(source)) return '/series'
  return null
}

function widgetResult(pref: PlayerWidgetPreference, items: PlayerMediaCard[], nextCursor: string | null, total: number): PlayerWidget {
  return {
    id: pref.id,
    title: pref.title,
    source: pref.source,
    view: pref.view,
    sort: pref.sort,
    sortOrder: pref.sortOrder,
    autoscrollSeconds: pref.autoscrollSeconds,
    items,
    nextCursor,
    total,
    showMoreRoute: showMoreRoute(pref),
  }
}

export function getPlayerHub(input: GetPlayerHubInput): PlayerHub {
  const preferences = getPlayerPreferences(input.profileId).preferences
  let prefs: PlayerWidgetPreference[]
  let configuredHub: PlayerHubPreference | null = null
  if (!['films', 'series', 'tv'].includes(input.hubId)) {
    configuredHub = preferences.home.hubs.find(hub => hub.id === input.hubId && hub.enabled) ?? null
    if (!configuredHub) throw new PlayerHubNotFoundError(input.hubId)
  }
  const fixedWidget = (id: 'films' | 'series', source: 'films-az' | 'series-az', view: PlayerWidgetPreference['view']): PlayerWidgetPreference => ({
    id, title: id === 'films' ? 'Films' : 'Series', source, view,
    sort: 'source', sortOrder: 'asc', limit: view === 'list' ? 60 : 36, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true,
  })
  if (configuredHub) prefs = configuredHub.widgets.filter(widget => widget.enabled)
  else if (input.hubId === 'films') prefs = [fixedWidget('films', 'films-az', preferences.libraries.films.view)]
  else if (input.hubId === 'series') prefs = [fixedWidget('series', 'series-az', preferences.libraries.series.view)]
  else prefs = []
  const libraryPreferences = input.hubId === 'films' ? preferences.libraries.films : input.hubId === 'series' ? preferences.libraries.series : undefined
  const widgets = prefs.map((pref, index) => widgetForSource(pref, input.profileId, index === 0 ? input.cursor : null, input.limit, {
    libraryBrowse: input.hubId === 'films' || input.hubId === 'series',
    libraryId: input.libraryId,
    libraryPreferences,
  }))
  const layout = configuredHub?.layout ?? 'standard'
  const spotlightWidget = configuredHub?.spotlightWidgetId
    ? widgets.find(widget => widget.id === configuredHub?.spotlightWidgetId)
    : widgets.find(widget => widget.items.length > 0)
  const spotlight = spotlightWidget?.items[0] ?? null
  const categories = layout === 'combined'
    ? widgets.map((widget, index) => ({ id: widget.id, label: widget.title, active: index === 0 }))
    : []
  return {
    id: input.hubId,
    title: configuredHub?.name ?? (input.hubId === 'tv' ? 'TV' : input.hubId[0].toUpperCase() + input.hubId.slice(1)),
    icon: configuredHub?.icon ?? (input.hubId === 'films' ? '▯' : input.hubId === 'series' ? '▤' : input.hubId === 'tv' ? '◉' : '⌂'),
    layout,
    showSpotlight: configuredHub?.showSpotlight ?? input.hubId !== 'tv',
    categories,
    spotlight,
    widgets,
  }
}
