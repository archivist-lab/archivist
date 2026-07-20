import type {
  PlayerBrowseFilter,
  PlayerBrowsePage,
  PlayerFilterableContentType,
  PlayerMediaCard,
  PlayerSortOrder,
  PlayerWidgetSort,
} from '@archivist/contracts'
import { getDb } from '../db.js'
import { serializeEpisodeSummary, serializeFilmSummary, serializeSeriesSummary, toMediaCard } from './serializers.js'

type BrowseSort = Exclude<PlayerWidgetSort, 'source'>
interface BrowseCursor { sortValue: string | number | null; id: number }

export interface BrowseInput {
  mediaType: PlayerFilterableContentType
  profileId: string
  filters: PlayerBrowseFilter
  sort: BrowseSort
  sortOrder: PlayerSortOrder
  cursor?: string | null
  limit?: number
  libraryId?: number | null
  randomSeed?: number | null
}

export const EMPTY_BROWSE_FILTER: PlayerBrowseFilter = {
  query: '',
  genres: [],
  yearFrom: null,
  yearTo: null,
  studios: [],
  ratingMin: null,
  availability: 'available',
  watched: 'all',
  alphabet: null,
  collectionId: null,
}

function encodeCursor(cursor: BrowseCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): BrowseCursor {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('Invalid browse cursor')
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!value || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || !('sortValue' in value)) throw new Error('shape')
    if (value.sortValue !== null && typeof value.sortValue !== 'string' && typeof value.sortValue !== 'number') throw new Error('sort')
    return { sortValue: value.sortValue as string | number | null, id: Number(value.id) }
  } catch { throw new Error('Invalid browse cursor') }
}

function list(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(raw.map(entry => String(entry).normalize('NFC').trim()).filter(Boolean))].slice(0, 20)
}

function optionalInt(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Expected an integer from ${min} to ${max}`)
  return number
}

export function parseBrowseFilters(query: Record<string, unknown>): PlayerBrowseFilter {
  const text = String(query.q ?? '').normalize('NFC').trim()
  if ([...text].length > 120 || /[\p{Cc}]/u.test(text)) throw new Error('Invalid browse query')
  const availability = ['all', 'available', 'unavailable'].includes(String(query.availability)) ? String(query.availability) : 'all'
  const watched = ['all', 'watched', 'unwatched', 'in-progress'].includes(String(query.watched)) ? String(query.watched) : 'all'
  const alphabet = query.alphabet == null || query.alphabet === '' ? null : String(query.alphabet).toUpperCase()
  if (alphabet !== null && !/^(#|[A-Z])$/.test(alphabet)) throw new Error('Invalid alphabet jump')
  const ratingMin = query.ratingMin == null || query.ratingMin === '' ? null : Number(query.ratingMin)
  if (ratingMin !== null && (!Number.isFinite(ratingMin) || ratingMin < 0 || ratingMin > 10)) throw new Error('Invalid minimum rating')
  const yearFrom = optionalInt(query.yearFrom, 1870, 2200)
  const yearTo = optionalInt(query.yearTo, 1870, 2200)
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) throw new Error('yearFrom must not exceed yearTo')
  return {
    query: text,
    genres: list(query.genre),
    yearFrom,
    yearTo,
    studios: list(query.studio),
    ratingMin,
    availability: availability as PlayerBrowseFilter['availability'],
    watched: watched as PlayerBrowseFilter['watched'],
    alphabet,
    collectionId: optionalInt(query.collectionId, 1, Number.MAX_SAFE_INTEGER),
  }
}

function filterSql(input: BrowseInput, alias: string, kind: 'film' | 'series' | 'episode'): { clauses: string[]; params: unknown[] } {
  const { filters } = input
  const clauses: string[] = []
  const params: unknown[] = []
  const title = kind === 'episode' ? `COALESCE(${alias}.title, '')` : `COALESCE(${alias}.sort_title, ${alias}.title)`
  const year = kind === 'episode' ? `CAST(substr(${alias}.air_date, 1, 4) AS INTEGER)` : `${alias}.year`
  const genres = kind === 'episode' ? 's.genres' : `${alias}.genres`
  const studio = kind === 'film' ? `${alias}.studio` : 's.network'
  if (filters.query) { clauses.push(`${title} LIKE ?`); params.push(`%${filters.query}%`) }
  for (const genre of filters.genres) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(${genres}) genre WHERE lower(genre.value) = lower(?))`)
    params.push(genre)
  }
  if (filters.yearFrom !== null) { clauses.push(`${year} >= ?`); params.push(filters.yearFrom) }
  if (filters.yearTo !== null) { clauses.push(`${year} <= ?`); params.push(filters.yearTo) }
  if (filters.ratingMin !== null) {
    clauses.push(kind === 'episode' ? 'COALESCE(s.rating, 0) >= ?' : `COALESCE(${alias}.rating, 0) >= ?`)
    params.push(filters.ratingMin)
  }
  if (filters.studios.length) {
    clauses.push(`lower(COALESCE(${studio}, '')) IN (${filters.studios.map(() => 'lower(?)').join(',')})`)
    params.push(...filters.studios)
  }
  if (filters.alphabet) {
    clauses.push(filters.alphabet === '#' ? `upper(substr(${title}, 1, 1)) NOT BETWEEN 'A' AND 'Z'` : `upper(substr(${title}, 1, 1)) = ?`)
    if (filters.alphabet !== '#') params.push(filters.alphabet)
  }
  if (input.libraryId) {
    clauses.push(kind === 'episode' ? 's.library_id = ?' : `${alias}.library_id = ?`)
    params.push(input.libraryId)
  }
  if (kind === 'film' && filters.collectionId !== null) { clauses.push(`${alias}.collection_tmdb_id = ?`); params.push(filters.collectionId) }

  const available = kind === 'series'
    ? `EXISTS (SELECT 1 FROM episodes ae WHERE ae.series_id = ${alias}.id AND ae.file_path IS NOT NULL)`
    : `${alias}.file_path IS NOT NULL`
  if (filters.availability === 'available') clauses.push(available)
  if (filters.availability === 'unavailable') clauses.push(`NOT (${available})`)

  if (kind === 'series') {
    const playable = `e.series_id = ${alias}.id AND e.file_path IS NOT NULL`
    if (filters.watched === 'watched') clauses.push(`EXISTS (SELECT 1 FROM episodes e WHERE ${playable}) AND NOT EXISTS (SELECT 1 FROM episodes e LEFT JOIN playback_progress wp ON wp.profile_id = ? AND wp.media_type = 'episode' AND wp.media_id = e.id WHERE ${playable} AND COALESCE(wp.completed, 0) = 0)`)
    if (filters.watched === 'unwatched') clauses.push(`EXISTS (SELECT 1 FROM episodes e LEFT JOIN playback_progress wp ON wp.profile_id = ? AND wp.media_type = 'episode' AND wp.media_id = e.id WHERE ${playable} AND COALESCE(wp.completed, 0) = 0)`)
    if (filters.watched === 'in-progress') clauses.push(`EXISTS (SELECT 1 FROM episodes e JOIN playback_progress wp ON wp.profile_id = ? AND wp.media_type = 'episode' AND wp.media_id = e.id WHERE ${playable} AND wp.completed = 0 AND wp.position_seconds > 30)`)
    if (filters.watched !== 'all') params.push(input.profileId)
  } else {
    if (filters.watched === 'watched') clauses.push('COALESCE(pp.completed, 0) = 1')
    if (filters.watched === 'unwatched') clauses.push('COALESCE(pp.completed, 0) = 0')
    if (filters.watched === 'in-progress') clauses.push('COALESCE(pp.completed, 0) = 0 AND pp.position_seconds > 30')
  }
  return { clauses, params }
}

function facets(mediaType: PlayerFilterableContentType): PlayerBrowsePage['facets'] {
  const db = getDb()
  if (mediaType === 'episodes') {
    const genres = (db.prepare(`SELECT DISTINCT value FROM series, json_each(series.genres) WHERE trim(value) != '' ORDER BY value`).all() as Array<{ value: string }>).map(row => row.value)
    const studios = (db.prepare(`SELECT DISTINCT network AS value FROM series WHERE network IS NOT NULL AND trim(network) != '' ORDER BY network`).all() as Array<{ value: string }>).map(row => row.value)
    const years = db.prepare(`SELECT MIN(CAST(substr(air_date,1,4) AS INTEGER)) AS min, MAX(CAST(substr(air_date,1,4) AS INTEGER)) AS max FROM episodes WHERE air_date IS NOT NULL`).get() as { min: number | null; max: number | null }
    return { genres, studios, yearMin: years.min, yearMax: years.max }
  }
  const table = mediaType === 'series' ? 'series' : 'films'
  const studio = mediaType === 'series' ? 'network' : 'studio'
  const genres = (db.prepare(`SELECT DISTINCT value FROM ${table}, json_each(${table}.genres) WHERE trim(value) != '' ORDER BY value`).all() as Array<{ value: string }>).map(row => row.value)
  const studios = (db.prepare(`SELECT DISTINCT ${studio} AS value FROM ${table} WHERE ${studio} IS NOT NULL AND trim(${studio}) != '' ORDER BY ${studio}`).all() as Array<{ value: string }>).map(row => row.value)
  const years = db.prepare(`SELECT MIN(year) AS min, MAX(year) AS max FROM ${table} WHERE year IS NOT NULL`).get() as { min: number | null; max: number | null }
  return { genres, studios, yearMin: years.min, yearMax: years.max }
}

function collectionCard(row: any): PlayerMediaCard {
  const available = Number(row.available_count ?? 0) > 0
  return {
    key: `collection:${row.id}`,
    mediaType: 'collection',
    id: Number(row.id),
    route: `/films?collectionId=${row.id}`,
    title: row.title,
    subtitle: `${Number(row.film_count ?? 0)} films`,
    plot: null,
    year: row.year == null ? null : Number(row.year),
    posterUrl: row.poster_path ?? null,
    landscapeUrl: row.backdrop_path ?? null,
    backdropUrl: row.backdrop_path ?? null,
    logoUrl: null,
    progress: null,
    badges: [{ label: `${Number(row.film_count ?? 0)} films`, tone: 'neutral' }],
    available,
    primaryAction: available ? 'play' : 'unavailable',
  }
}

export function getBrowsePage(input: BrowseInput): PlayerBrowsePage {
  const db = getDb()
  const limit = Math.max(1, Math.min(60, input.limit ?? 36))
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  const direction = input.randomSeed != null ? 'ASC' : input.sortOrder === 'desc' ? 'DESC' : 'ASC'
  const comparator = direction === 'ASC' ? '>' : '<'
  const randomField = (alias: string) => input.randomSeed == null ? null : `abs((${alias}.id * 1103515245 + ${Math.trunc(input.randomSeed)}) % 2147483647)`
  let rows: any[] = []
  let total = 0
  let sortValue: (row: any) => string | number | null = row => row.player_sort

  if (input.mediaType === 'films') {
    const filtered = filterSql(input, 'f', 'film')
    const field = randomField('f') ?? (input.sort === 'added' ? `COALESCE(f.acquired_at, f.added_at, '')` : input.sort === 'year' ? 'COALESCE(f.year, 0)' : input.sort === 'rating' ? 'COALESCE(f.rating, 0)' : 'COALESCE(f.sort_title, f.title)')
    const cursorSql = cursor ? `(${field} ${comparator} ? OR (${field} = ? AND f.id ${comparator} ?))` : null
    const clauses = [...filtered.clauses, ...(cursorSql ? [cursorSql] : [])]
    const params = [input.profileId, ...filtered.params, ...(cursor ? [cursor.sortValue, cursor.sortValue, cursor.id] : [])]
    rows = db.prepare(`SELECT f.*, ${field} AS player_sort, pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
      FROM films f LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${field} ${direction}, f.id ${direction} LIMIT ?`).all(...params, limit + 1) as any[]
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM films f LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id ${filtered.clauses.length ? `WHERE ${filtered.clauses.join(' AND ')}` : ''}`).get(input.profileId, ...filtered.params) as any).n)
  } else if (input.mediaType === 'series') {
    const filtered = filterSql(input, 's', 'series')
    const field = randomField('s') ?? (input.sort === 'added' ? `COALESCE(s.added_at, '')` : input.sort === 'year' ? 'COALESCE(s.year, 0)' : input.sort === 'rating' ? 'COALESCE(s.rating, 0)' : 'COALESCE(s.sort_title, s.title)')
    const cursorSql = cursor ? `(${field} ${comparator} ? OR (${field} = ? AND s.id ${comparator} ?))` : null
    const clauses = [...filtered.clauses, ...(cursorSql ? [cursorSql] : [])]
    rows = db.prepare(`SELECT s.*, ${field} AS player_sort,
      (SELECT COUNT(*) FROM episodes ec WHERE ec.series_id = s.id) AS episode_count,
      (SELECT COUNT(*) FROM episodes ac WHERE ac.series_id = s.id AND ac.file_path IS NOT NULL) AS available_count
      FROM series s ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY ${field} ${direction}, s.id ${direction} LIMIT ?`).all(...filtered.params, ...(cursor ? [cursor.sortValue, cursor.sortValue, cursor.id] : []), limit + 1) as any[]
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM series s ${filtered.clauses.length ? `WHERE ${filtered.clauses.join(' AND ')}` : ''}`).get(...filtered.params) as any).n)
  } else if (input.mediaType === 'episodes') {
    const filtered = filterSql(input, 'e', 'episode')
    const field = randomField('e') ?? (input.sort === 'added' ? `COALESCE(e.updated_at, '')` : input.sort === 'year' ? `COALESCE(e.air_date, '')` : input.sort === 'rating' ? 'COALESCE(s.rating, 0)' : `COALESCE(s.sort_title, s.title) || printf(' %06d %06d', e.season_number, e.episode_number)`)
    const cursorSql = cursor ? `(${field} ${comparator} ? OR (${field} = ? AND e.id ${comparator} ?))` : null
    const clauses = [...filtered.clauses, ...(cursorSql ? [cursorSql] : [])]
    const params = [input.profileId, ...filtered.params, ...(cursor ? [cursor.sortValue, cursor.sortValue, cursor.id] : [])]
    rows = db.prepare(`SELECT e.*, e.episode_number = (SELECT MAX(last.episode_number) FROM episodes last WHERE last.series_id = e.series_id AND last.season_number = e.season_number) AS is_finale, s.title AS series_title, s.poster_path AS series_poster, s.rating AS series_rating, ${field} AS player_sort,
      pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
      FROM episodes e JOIN series s ON s.id = e.series_id
      LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'episode' AND pp.media_id = e.id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${field} ${direction}, e.id ${direction} LIMIT ?`).all(...params, limit + 1) as any[]
    total = Number((db.prepare(`SELECT COUNT(*) AS n FROM episodes e JOIN series s ON s.id = e.series_id LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'episode' AND pp.media_id = e.id ${filtered.clauses.length ? `WHERE ${filtered.clauses.join(' AND ')}` : ''}`).get(input.profileId, ...filtered.params) as any).n)
  } else {
    const filmInput = { ...input, mediaType: 'films' as const }
    const filtered = filterSql(filmInput, 'f', 'film')
    filtered.clauses.push('f.collection_tmdb_id IS NOT NULL', `f.collection_name IS NOT NULL`)
    const base = `SELECT f.collection_tmdb_id AS id, f.collection_name AS title,
      MAX(f.collection_poster_path) AS poster_path, MAX(f.collection_backdrop_path) AS backdrop_path,
      COUNT(*) AS film_count, SUM(CASE WHEN f.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available_count,
      MIN(f.year) AS year, MAX(COALESCE(f.acquired_at, f.added_at, '')) AS added,
      AVG(COALESCE(f.rating, 0)) AS rating
      FROM films f LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id
      WHERE ${filtered.clauses.join(' AND ')} GROUP BY f.collection_tmdb_id, f.collection_name`
    const field = input.randomSeed != null ? `abs((id * 1103515245 + ${Math.trunc(input.randomSeed)}) % 2147483647)` : input.sort === 'added' ? 'added' : input.sort === 'year' ? 'COALESCE(year, 0)' : input.sort === 'rating' ? 'COALESCE(rating, 0)' : 'title'
    const cursorSql = cursor ? `(${field} ${comparator} ? OR (${field} = ? AND id ${comparator} ?))` : null
    rows = db.prepare(`WITH collections AS (${base}) SELECT *, ${field} AS player_sort FROM collections ${cursorSql ? `WHERE ${cursorSql}` : ''} ORDER BY ${field} ${direction}, id ${direction} LIMIT ?`).all(input.profileId, ...filtered.params, ...(cursor ? [cursor.sortValue, cursor.sortValue, cursor.id] : []), limit + 1) as any[]
    total = Number((db.prepare(`WITH collections AS (${base}) SELECT COUNT(*) AS n FROM collections`).get(input.profileId, ...filtered.params) as any).n)
  }

  const pageRows = rows.slice(0, limit)
  const last = pageRows.at(-1)
  const items = pageRows.map(row => input.mediaType === 'films' ? toMediaCard(serializeFilmSummary(row))
    : input.mediaType === 'series' ? toMediaCard(serializeSeriesSummary(row))
      : input.mediaType === 'episodes' ? toMediaCard(serializeEpisodeSummary(row))
        : collectionCard(row))
  return {
    mediaType: input.mediaType,
    title: input.mediaType[0].toUpperCase() + input.mediaType.slice(1),
    items,
    total,
    nextCursor: rows.length > limit && last ? encodeCursor({ sortValue: sortValue(last), id: Number(last.id) }) : null,
    facets: facets(input.mediaType),
    filters: input.filters,
    sort: input.sort,
    sortOrder: input.sortOrder,
  }
}
