import axios, { type AxiosError } from 'axios'
import { sanitizeConfigValue, createLogger } from '@archivist/core'

const logger = createLogger('TVDB')

const tvdbBase = () => process.env.TVDB_BASE_URL ?? 'https://api4.thetvdb.com/v4'
const tmdbBase = () => process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
const skyhookBase = () => process.env.SKYHOOK_BASE_URL ?? 'https://skyhook.sonarr.tv'
const TMDB_IMG  = 'https://image.tmdb.org/t/p'

export function tmdbImageUrl(path: string | undefined | null, size = 'w342'): string | undefined {
  if (!path) return undefined
  if (path.startsWith('http') || path.startsWith('/media')) return path
  const cleanPath = path.startsWith('/') ? path.slice(1) : path
  return `${TMDB_IMG}/${size}/${cleanPath}`
}

// ── TVDB ──────────────────────────────────────────────────────────────────────

let tvdbToken: string | null = null
let tvdbExpiry = 0
let tvdbAuthBlockedUntil = 0
let tvdbAuthBlockedReason: string | null = null
let lastTvdbSearchLogAt = 0

const TVDB_AUTH_BACKOFF_MS = 15 * 60 * 1000

/** Clear cached credentials/circuit state after API settings are changed. */
export function resetTvdbSession(): void {
  tvdbToken = null
  tvdbExpiry = 0
  tvdbAuthBlockedUntil = 0
  tvdbAuthBlockedReason = null
  lastTvdbSearchLogAt = 0
}

function axiosDetail(err: unknown): string {
  if (!axios.isAxiosError(err)) return err instanceof Error ? err.message : String(err)
  const data = (err as AxiosError).response?.data as any
  const detail = data?.message ?? data?.error ?? (typeof data === 'string' ? data.slice(0, 240) : null)
  const status = err.response?.status
  return [status ? `HTTP ${status}` : null, detail, err.code].filter(Boolean).join(': ') || err.message
}

function transientProviderError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false
  const status = err.response?.status
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500)
    || ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED'].includes(err.code ?? '')
}

async function withProviderRetry<T>(request: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await request() } catch (err) {
      lastError = err
      if (attempt >= attempts || !transientProviderError(err)) throw err
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}

async function getTvdbToken(): Promise<string> {
  if (tvdbToken && Date.now() < tvdbExpiry) return tvdbToken
  if (Date.now() < tvdbAuthBlockedUntil && tvdbAuthBlockedReason) throw new Error(tvdbAuthBlockedReason)
  const key = sanitizeConfigValue(process.env.TVDB_API_KEY)
  const pin = sanitizeConfigValue(process.env.TVDB_PIN)
  if (!key) throw new Error('TVDB_API_KEY not set')
  const credentials = pin ? { apikey: key, pin } : { apikey: key }
  try {
    const res = await withProviderRetry(() => axios.post(`${tvdbBase()}/login`, credentials, { timeout: 10000 }))
    tvdbToken = res.data.data.token
    tvdbExpiry = Date.now() + 23 * 60 * 60 * 1000
    tvdbAuthBlockedUntil = 0
    tvdbAuthBlockedReason = null
    return tvdbToken!
  } catch (err) {
    const detail = axiosDetail(err)
    const pinHint = /pin required/i.test(detail) ? ' Add TVDB_PIN for this API key.' : ''
    const message = `TVDB authentication failed (${detail}).${pinHint}`
    if (axios.isAxiosError(err) && [400, 401, 403].includes(err.response?.status ?? 0)) {
      tvdbAuthBlockedUntil = Date.now() + TVDB_AUTH_BACKOFF_MS
      tvdbAuthBlockedReason = message
    }
    throw new Error(message)
  }
}

async function tvdbGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const token = await getTvdbToken()
  const res = await withProviderRetry(() => axios.get(`${tvdbBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 15000,
  }))
  return res.data.data
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SeriesSearchResult {
  tvdbId?: number; tmdbId?: number; title: string; year?: number
  overview?: string; posterPath?: string; backdropPath?: string; network?: string; status: string
  genres?: string[]; rating?: number; popularity?: number; firstAirDate?: string
}

export interface SeriesEntity {
  tvdbId?: number; tmdbId?: number; imdbId?: string; title: string
  originalTitle?: string; year?: number; overview?: string; network?: string
  status: string; seriesType: 'standard' | 'daily' | 'anime'; runtime?: number
  genres: string[]; posterPath?: string; backdropPath?: string; logoPath?: string; bannerPath?: string; rating?: number; language: string
  airTime?: string; airDay?: string; airTimezone?: string
  cast?: Array<{ id: number, name: string, character: string, profilePath?: string }>
  crew?: Array<{ id: number, name: string, job: string, profilePath?: string }>
  country?: string
  certification?: string
}

export interface SeriesSeason {
  seasonNumber: number; title?: string; overview?: string
  posterPath?: string; episodeCount: number; airDate?: string
}

export interface SeriesEpisode {
  seasonNumber: number; episodeNumber: number; tvdbEpisodeId?: number
  title?: string; overview?: string; airDate?: string; airDateUtc?: string; runtime?: number; stillPath?: string
}

export interface NormalizedEpisodeAirtime {
  airDate?: string
  airDateUtc: string
  tvdbEpisodeId?: number
}

export type NormalizedEpisodeAirtimes = Map<string, NormalizedEpisodeAirtime>

export async function getNormalizedEpisodeAirtimes(tvdbId: number): Promise<NormalizedEpisodeAirtimes> {
  const response = await withProviderRetry(() => axios.get(`${skyhookBase()}/v1/tvdb/shows/en/${tvdbId}`, { timeout: 15000 }))
  const episodes = Array.isArray(response.data?.episodes) ? response.data.episodes : []
  const airtimes: NormalizedEpisodeAirtimes = new Map()
  for (const episode of episodes) {
    if (!episode.airDateUtc || !Number.isInteger(episode.seasonNumber) || !Number.isInteger(episode.episodeNumber)) continue
    airtimes.set(`${episode.seasonNumber}:${episode.episodeNumber}`, {
      airDate: episode.airDate || undefined,
      airDateUtc: episode.airDateUtc,
      tvdbEpisodeId: episode.tvdbId ? Number(episode.tvdbId) : undefined,
    })
  }
  return airtimes
}

export async function getSeriesSchedule(tvdbId: number): Promise<{ airTime?: string; airDay?: string; airTimezone?: string }> {
  const data = await tvdbGet<any>(`/series/${tvdbId}/extended`, { short: true })
  return {
    airTime: data.airsTime || undefined,
    airDay: data.airsDayOfWeek || undefined,
    airTimezone: data.latestNetwork?.country?.timezone ?? data.originalNetwork?.country?.timezone ?? undefined,
  }
}

export async function searchSeries(query: string): Promise<SeriesSearchResult[]> {
  const allResults: SeriesSearchResult[] = []
  
  try {
    const results = await tvdbGet<any[]>('/search', { query, type: 'series', limit: 20 })
    if (results && results.length > 0) {
      allResults.push(...results.map(r => ({
        tvdbId: r.tvdb_id ? parseInt(r.tvdb_id, 10) : undefined,
        title: r.name ?? '',
        year: r.year ? parseInt(r.year, 10) : undefined,
        overview: r.overviews?.eng ?? r.overview ?? '',
        posterPath: tmdbImageUrl(r.image_url ?? r.thumbnail),
        network: r.network ?? undefined,
        status: r.status ?? 'unknown',
      })))
    }
  } catch (err) {
    // Authentication/configuration failures are circuit-broken above. Log at
    // most once per backoff window so every lookup does not flood the event log.
    if (Date.now() - lastTvdbSearchLogAt >= TVDB_AUTH_BACKOFF_MS) {
      lastTvdbSearchLogAt = Date.now()
      logger.error(`TVDB search failed for ${JSON.stringify(query)}: ${axiosDetail(err)}`)
    }
  }

  // Fallback to TMDB if TVDB found nothing or failed
  if (allResults.length === 0) {
    try {
      return await searchSeriesTmdb(query)
    } catch (err) {
      logger.error('TMDB search fallback failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return allResults
}

export async function getSeries(tvdbId: number): Promise<SeriesEntity> {
  const data = await tvdbGet<any>(`/series/${tvdbId}/extended`, { meta: 'translations', short: false })
  const entity: SeriesEntity = {
    tvdbId,
    tmdbId: data.remoteIds?.find((r: any) => r.sourceName === 'TheMovieDB.com')?.id,
    imdbId: data.remoteIds?.find((r: any) => r.sourceName === 'IMDB')?.id,
    title: data.name ?? '',
    originalTitle: data.originalName,
    year: data.firstAired ? parseInt(data.firstAired.slice(0, 4), 10) : undefined,
    overview: data.translations?.overviewTranslations?.find((t: any) => t.language === 'eng')?.overview ?? data.overview ?? '',
    network: data.latestNetwork?.name ?? data.originalNetwork?.name,
    status: data.status?.name === 'Ended' ? 'ended' : data.status?.name === 'Upcoming' ? 'upcoming' : 'continuing',
    seriesType: data.isAnimated ? 'anime' : 'standard',
    runtime: data.averageRuntime ?? data.runtime,
    genres: (data.genres ?? []).map((g: any) => g.name),
    posterPath: data.image ?? undefined,
    rating: data.score,
    language: data.originalLanguage ?? 'en',
    airTime: data.airsTime,
    airDay: data.airsDayOfWeek,
    bannerPath: data.artworks?.find((a: any) => a.type === 1)?.image,
  }

  if (entity.tmdbId) {
    try {
      const tmdbData = await getSeriesTmdb(parseInt(String(entity.tmdbId), 10))
      entity.country = tmdbData.country
      entity.certification = tmdbData.certification
      entity.cast = tmdbData.cast
      entity.crew = tmdbData.crew
      entity.logoPath = tmdbData.logoPath
      entity.backdropPath = entity.backdropPath || tmdbData.backdropPath
    } catch (err) {
      logger.warn('Failed to fetch TMDB data for series:', err)
    }
  }

  return entity
}

export interface SeriesPreview {
  seasonCount?: number
  episodeCount?: number
  firstAired?: string
  lastAired?: string
  status?: 'continuing' | 'ended' | 'upcoming'
}

/**
 * Lightweight detail used by the add-search popup: season/episode counts and
 * premiere/finale dates, without adding the series. Prefers TMDB's aggregate
 * counts, falling back to what TVDB's extended record provides.
 */
export async function getSeriesPreview(opts: { tvdbId?: number; tmdbId?: number }): Promise<SeriesPreview> {
  const out: SeriesPreview = {}
  let tmdbId = opts.tmdbId

  if (opts.tvdbId) {
    try {
      const data = await tvdbGet<any>(`/series/${opts.tvdbId}/extended`, { short: true })
      tmdbId = tmdbId ?? data.remoteIds?.find((r: any) => r.sourceName === 'TheMovieDB.com')?.id
      const seasons = (data.seasons ?? []).filter((s: any) => s.type?.type === 'official' && s.number !== 0)
      if (seasons.length) out.seasonCount = seasons.length
      out.firstAired = data.firstAired || undefined
      out.lastAired = data.lastAired || undefined
      out.status = data.status?.name === 'Ended' ? 'ended' : data.status?.name === 'Upcoming' ? 'upcoming' : 'continuing'
    } catch (err) {
      logger.warn('TVDB preview fetch failed:', err instanceof Error ? err.message : String(err))
    }
  }

  if (tmdbId) {
    try {
      const d = await tmdbGet<any>(`/tv/${tmdbId}`)
      if (d.number_of_seasons) out.seasonCount = d.number_of_seasons
      if (d.number_of_episodes) out.episodeCount = d.number_of_episodes
      if (d.first_air_date) out.firstAired = d.first_air_date
      if (d.last_air_date) out.lastAired = d.last_air_date
      const st = String(d.status ?? '').toLowerCase()
      out.status = (st === 'ended' || st === 'canceled') ? 'ended'
        : (st === 'upcoming' || st === 'planned' || st === 'pilot') ? 'upcoming'
        : (out.status ?? 'continuing')
    } catch (err) {
      logger.warn('TMDB preview fetch failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return out
}

export async function getSeriesSeasons(tvdbId: number): Promise<SeriesSeason[]> {
  const data = await tvdbGet<any>(`/series/${tvdbId}/extended`)
  return (data.seasons ?? [])
    .filter((s: any) => s.type?.type === 'official' && s.number !== 0)
    .map((s: any) => ({
      seasonNumber: s.number,
      episodeCount: s.episodes?.length ?? 0,
      airDate: s.episodes?.[0]?.aired,
    }))
    .sort((a: any, b: any) => a.seasonNumber - b.seasonNumber)
}

export async function getSeriesEpisodes(tvdbId: number, seasonNumber: number): Promise<SeriesEpisode[]> {
  const data = await tvdbGet<any>(`/series/${tvdbId}/episodes/official`, { season: seasonNumber, page: 0 })
  return ((data?.episodes ?? data) as any[])
    .filter((e: any) => e.seasonNumber === seasonNumber)
    .map((e: any) => ({
      seasonNumber: e.seasonNumber,
      episodeNumber: e.number,
      tvdbEpisodeId: e.id,
      title: e.name ?? `Episode ${e.number}`,
      overview: e.overview ?? '',
      airDate: e.aired ?? undefined,
      runtime: e.runtime ?? undefined,
      stillPath: e.image ?? undefined,
    }))
    .sort((a: any, b: any) => a.episodeNumber - b.episodeNumber)
}

// ── TMDB fallback ─────────────────────────────────────────────────────────────

async function tmdbGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const key = sanitizeConfigValue(process.env.TMDB_API_KEY)
  if (!key) throw new Error('TMDB_API_KEY not set')
  const res = await withProviderRetry(() => axios.get(`${tmdbBase()}${path}`, { params: { api_key: key, language: 'en-US', ...params }, timeout: 10000 }))
  return res.data
}

async function searchSeriesTmdb(query: string): Promise<SeriesSearchResult[]> {
  const data = await tmdbGet<any>('/search/tv', { query })
  return (data.results ?? []).slice(0, 20).map((r: any) => ({
    tmdbId: r.id,
    title: r.name,
    year: r.first_air_date ? parseInt(r.first_air_date.slice(0, 4), 10) : undefined,
    overview: r.overview,
    posterPath: tmdbImageUrl(r.poster_path),
    backdropPath: tmdbImageUrl(r.backdrop_path, 'w1280'),
    rating: r.vote_average || undefined,
    popularity: r.popularity || 0,
    firstAirDate: r.first_air_date || undefined,
    status: 'unknown',
  }))
}

function parseSeriesCandidate(r: any, genreMap: Map<number, string> = new Map()): SeriesSearchResult {
  return {
    tmdbId: Number(r.id),
    title: r.name ?? r.original_name ?? '',
    year: r.first_air_date ? parseInt(String(r.first_air_date).slice(0, 4), 10) : undefined,
    overview: r.overview || undefined,
    posterPath: tmdbImageUrl(r.poster_path),
    backdropPath: tmdbImageUrl(r.backdrop_path, 'w1280'),
    rating: r.vote_average || undefined,
    popularity: r.popularity || 0,
    genres: Array.isArray(r.genres) ? r.genres.map((genre: any) => genre.name).filter(Boolean)
      : (r.genre_ids ?? []).map((id: number) => genreMap.get(Number(id))).filter(Boolean) as string[],
    firstAirDate: r.first_air_date || undefined,
    status: String(r.status ?? 'unknown').toLowerCase(),
  }
}

let seriesGenreCache: { expiresAt: number; values: Map<number, string> } | null = null
async function seriesGenres(): Promise<Map<number, string>> {
  if (seriesGenreCache && seriesGenreCache.expiresAt > Date.now()) return seriesGenreCache.values
  const data = await tmdbGet<any>('/genre/tv/list')
  const values = new Map<number, string>((data.genres ?? []).map((genre: any): [number, string] => [Number(genre.id), String(genre.name)]))
  seriesGenreCache = { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, values }
  return values
}

export async function getSeriesRecommendationsTmdb(tmdbId: number): Promise<SeriesSearchResult[]> {
  const [data, genres] = await Promise.all([tmdbGet<any>(`/tv/${tmdbId}/recommendations`, { page: 1 }), seriesGenres()])
  return (data.results ?? []).map((row: any) => parseSeriesCandidate(row, genres)).slice(0, 40)
}

/** Genre id → name map, for translating library genre names back to TMDB ids. */
export function getSeriesGenreMap(): Promise<Map<number, string>> { return seriesGenres() }

/** Raw /discover/tv query, parsed into SeriesSearchResult candidates. Used by
 * the taste-based "For You" recommender. */
export async function discoverSeriesWith(params: Record<string, unknown>, pages = 1): Promise<SeriesSearchResult[]> {
  const genres = await seriesGenres()
  const out = new Map<number, SeriesSearchResult>()
  for (let p = 1; p <= pages; p++) {
    const data = await tmdbGet<{ results: any[]; total_pages?: number }>('/discover/tv', { page: p, ...params })
    for (const r of data.results ?? []) out.set(Number(r.id), parseSeriesCandidate(r, genres))
    if (!data.results?.length || (data.total_pages != null && p >= data.total_pages)) break
  }
  return [...out.values()]
}

// ── Field-aware remote discovery (Add Series) ──────────────────────────────

async function searchPersonIdTv(query: string): Promise<number | null> {
  const data = await tmdbGet<{ results: Array<{ id: number; popularity?: number }> }>('/search/person', { query, page: 1 })
  const top = (data.results ?? []).slice().sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0]
  return top?.id ?? null
}

async function tvGenreIdByName(name: string): Promise<number | null> {
  const map = await seriesGenres()
  const lower = name.trim().toLowerCase()
  for (const [id, n] of map) if (n.toLowerCase() === lower) return id
  for (const [id, n] of map) if (n.toLowerCase().includes(lower)) return id
  return null
}

function tvDecadeRange(q: string): [number, number] | null {
  const m = q.trim().match(/^(\d{2}|\d{4})s?$/)
  if (!m) return null
  let n = parseInt(m[1], 10)
  if (m[1].length === 2) n = n < 30 ? 2000 + n : 1900 + n
  const start = Math.floor(n / 10) * 10
  return [start, start + 9]
}

// /discover/tv has NO with_cast/with_crew/with_people (movie-only params), so TV
// person discovery must go through the person's TV credits instead.
const CREW_ROLE_JOBS: Record<string, string[]> = {
  creator: ['creator', 'original series creator', 'series creator'],
  director: ['director'],
  writer: ['writer', 'screenplay', 'story', 'teleplay'],
  producer: ['producer', 'co-producer'],
  executive_producer: ['executive producer', 'co-executive producer'],
  composer: ['original music composer', 'music', 'composer'],
}
const CAST_FIELDS = new Set(['starring', 'supporting_cast', 'any_cast'])
const isPersonField = (field: string) => CAST_FIELDS.has(field) || field === 'any_credit' || field in CREW_ROLE_JOBS
// Talk, News, Reality — drop self/guest appearances from cast-based results.
const NOISE_TV_GENRES = new Set([10767, 10763, 10764])
const cleanCast = (cast: any[]): any[] => cast.filter(s =>
  !/^self\b/i.test(String(s.character ?? '')) && !(s.genre_ids ?? []).some((g: number) => NOISE_TV_GENRES.has(g)))

/** The TV shows a person is credited on for a given role field (raw TMDB objects). */
async function personTvShows(personId: number, field: string): Promise<any[]> {
  const credits = await tmdbGet<{ cast: any[]; crew: any[] }>(`/person/${personId}/tv_credits`)
  if (CAST_FIELDS.has(field)) return cleanCast(credits.cast ?? [])
  if (field === 'any_credit') return [...cleanCast(credits.cast ?? []), ...(credits.crew ?? [])]
  const jobs = CREW_ROLE_JOBS[field]
  const crew = credits.crew ?? []
  if (!jobs) return crew
  const matched = crew.filter(c => jobs.includes(String(c.job ?? '').toLowerCase()))
  return matched
}

export async function discoverSeriesByField(field: string, rawQuery: string): Promise<SeriesSearchResult[]> {
  return discoverSeriesByFilters([{ field, q: rawQuery }])
}

export async function discoverSeriesByFilters(filters: Array<{ field: string; q: string }>): Promise<SeriesSearchResult[]> {
  const clean = filters.filter(f => f?.q?.trim())
  if (clean.length === 0) return []
  if (clean.length === 1 && clean[0].field === 'title') return searchSeries(clean[0].q.trim())

  const genres = await seriesGenres()
  const personSets: Array<Map<number, any>> = [] // each: showId -> raw TMDB show
  const genreIds: number[] = []
  const titleQueries: string[] = []
  let year: number | null = null
  let decade: [number, number] | null = null

  for (const f of clean) {
    const q = f.q.trim()
    if (isPersonField(f.field)) {
      const pid = await searchPersonIdTv(q)
      if (!pid) return [] // named person not found → no results
      const m = new Map<number, any>()
      for (const s of await personTvShows(pid, f.field)) if (s?.id) m.set(Number(s.id), s)
      personSets.push(m)
    } else if (f.field === 'title') titleQueries.push(q)
    else if (f.field === 'genre') { const g = await tvGenreIdByName(q); if (g) genreIds.push(g) }
    else if (f.field === 'year' || f.field === 'first_air_year') { const y = parseInt(q, 10); if (Number.isFinite(y)) year = y }
    else if (f.field === 'decade') { decade = tvDecadeRange(q) }
    // network is not usable in compound remote discovery
  }

  if (personSets.length > 0) {
    // Intersect the person credit sets (AND), then apply genre/year/decade in memory.
    let ids = [...personSets[0].keys()]
    for (let i = 1; i < personSets.length; i++) ids = ids.filter(id => personSets[i].has(id))
    const byId = new Map<number, any>()
    for (const set of personSets) for (const [id, show] of set) if (!byId.has(id)) byId.set(id, show)
    let shows = ids.map(id => byId.get(id)).filter(Boolean)
    if (genreIds.length) shows = shows.filter(s => (s.genre_ids ?? []).some((g: number) => genreIds.includes(g)))
    if (year != null) shows = shows.filter(s => String(s.first_air_date ?? '').startsWith(String(year)))
    if (decade) shows = shows.filter(s => { const y = parseInt(String(s.first_air_date ?? '').slice(0, 4), 10); return Number.isFinite(y) && y >= decade![0] && y <= decade![1] })
    shows.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    let candidates = [...new Map(shows.map(s => [Number(s.id), parseSeriesCandidate(s, genres)])).values()]
    if (titleQueries.length) {
      const titleSets = await Promise.all(titleQueries.map(async title =>
        new Set((await searchSeriesTmdb(title)).map(show => Number(show.tmdbId))),
      ))
      candidates = candidates.filter(show => titleSets.every(ids => ids.has(Number(show.tmdbId))))
    }
    return candidates
  }

  // No person filters — pure /discover/tv.
  const params: Record<string, unknown> = { sort_by: 'popularity.desc' }
  let has = false
  if (genreIds.length) { params.with_genres = genreIds.join(','); has = true }
  if (year != null) { params.first_air_date_year = year; has = true }
  if (decade) { params['first_air_date.gte'] = `${decade[0]}-01-01`; params['first_air_date.lte'] = `${decade[1]}-12-31`; has = true }
  if (!has) return titleQueries.length === 1 ? searchSeries(titleQueries[0]) : []
  const discovered = await discoverSeriesWith(params, 5)
  if (titleQueries.length === 0) return discovered
  const titleSets = await Promise.all(titleQueries.map(async title =>
    new Set((await searchSeriesTmdb(title)).map(show => Number(show.tmdbId))),
  ))
  return discovered.filter(show => titleSets.every(ids => ids.has(Number(show.tmdbId))))
}

export type SeriesDiscoverCategory = 'trending' | 'upcoming' | 'on_the_air' | 'top_rated'

/** A single TMDB TV discovery list — powers the Add Series dropdown. Each pulls a
 * few pages so the route can drop already-owned shows and still return a full set. */
export async function discoverSeriesByCategory(category: SeriesDiscoverCategory): Promise<SeriesSearchResult[]> {
  // Upcoming = shows whose first air date is still to come (TV's canonical date;
  // no re-release problem like films).
  if (category === 'upcoming') {
    const today = new Date().toISOString().slice(0, 10)
    return discoverSeriesWith({ 'first_air_date.gte': today, sort_by: 'popularity.desc' }, 3)
  }
  // Top Rated = highest-rated with a solid vote count, fenced to exclude the
  // current year (recent shows have unsettled ratings).
  if (category === 'top_rated') {
    const lastYearEnd = `${new Date().getFullYear() - 1}-12-31`
    return discoverSeriesWith({ sort_by: 'vote_average.desc', 'vote_count.gte': 200, 'first_air_date.lte': lastYearEnd }, 3)
  }
  // Trending / On The Air — list endpoints, fetched across a few pages.
  const endpoint = category === 'on_the_air' ? '/tv/on_the_air' : '/trending/tv/week'
  const genres = await seriesGenres()
  const out = new Map<number, SeriesSearchResult>()
  for (let p = 1; p <= 3; p++) {
    const data = await tmdbGet<{ results: any[]; total_pages?: number }>(endpoint, { page: p })
    for (const r of data.results ?? []) out.set(Number(r.id), parseSeriesCandidate(r, genres))
    if (!data.results?.length || (data.total_pages != null && p >= data.total_pages)) break
  }
  return [...out.values()]
}

export async function discoverSeriesTmdb(): Promise<SeriesSearchResult[]> {
  const [trending, airing, upcoming, genres] = await Promise.allSettled([
    tmdbGet<any>('/trending/tv/week'),
    tmdbGet<any>('/tv/on_the_air', { page: 1 }),
    tmdbGet<any>('/discover/tv', { page: 1, sort_by: 'popularity.desc', 'first_air_date.gte': new Date().toISOString().slice(0, 10) }),
    seriesGenres(),
  ])
  const rows = [trending, airing, upcoming].flatMap(result => result.status === 'fulfilled' ? result.value.results ?? [] : [])
  const genreMap = genres.status === 'fulfilled' ? genres.value : new Map<number, string>()
  return [...new Map(rows.map(row => [Number(row.id), parseSeriesCandidate(row, genreMap)])).values()].slice(0, 60)
}

export async function getSeriesTmdb(tmdbId: number): Promise<SeriesEntity> {
  const d = await tmdbGet<any>(`/tv/${tmdbId}`, { append_to_response: 'images,aggregate_credits,credits,content_ratings,external_ids', include_image_language: 'en,null' })
  
  // Find "regular" air time/day from the first upcoming or last episode
  const episodes = [...(d.next_episode_to_air ? [d.next_episode_to_air] : []), ...(d.last_episode_to_air ? [d.last_episode_to_air] : [])]
  const epWithTime = episodes.find(e => e.air_date)
  
  let airTime = undefined
  let airDay = undefined
  
  if (epWithTime) {
    if (epWithTime.air_date.includes('T')) {
      airTime = epWithTime.air_date.split('T')[1].slice(0, 5)
    }
    const date = new Date(epWithTime.air_date)
    airDay = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][date.getDay()]
  }

  const logo = d.images?.logos?.find((l: any) => l.iso_639_1 === 'en') || d.images?.logos?.[0]
  const cert = d.content_ratings?.results?.find((r: any) => r.iso_3166_1 === 'US')?.rating

  // Prefer aggregate_credits (comprehensive cast + crew across all seasons) so
  // series people search covers full cast, every crew role, and the creators.
  // Falls back to the flat `credits` block when aggregate isn't available.
  const aggCast: any[] = d.aggregate_credits?.cast ?? []
  const cast = (aggCast.length ? aggCast : (d.credits?.cast ?? []))
    .slice()
    .sort((a: any, b: any) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 50)
    .map((c: any) => ({ id: c.id, name: c.name, character: c.roles?.[0]?.character ?? c.character ?? null, profilePath: tmdbImageUrl(c.profile_path, 'w185') }))

  const creators = (d.created_by ?? []).map((c: any) => ({ id: c.id, name: c.name, job: 'Creator', profilePath: tmdbImageUrl(c.profile_path, 'w185') }))
  const aggCrew: any[] = d.aggregate_credits?.crew ?? []
  const flatCrew = aggCrew.length
    ? aggCrew.flatMap((c: any) => (c.jobs ?? [{ job: c.job }]).map((j: any) => ({ id: c.id, name: c.name, job: j.job, profilePath: tmdbImageUrl(c.profile_path, 'w185') })))
    : (d.credits?.crew ?? []).map((c: any) => ({ id: c.id, name: c.name, job: c.job, profilePath: tmdbImageUrl(c.profile_path, 'w185') }))
  const crewSeen = new Set<string>()
  const crew = [...creators, ...flatCrew].filter(c => {
    const k = `${c.id}:${String(c.job ?? '').toLowerCase()}`
    if (!c.name || !c.job || crewSeen.has(k)) return false
    crewSeen.add(k)
    return true
  }).slice(0, 80)

  return {
    tvdbId: d.external_ids?.tvdb_id ? Number(d.external_ids.tvdb_id) : undefined,
    tmdbId,
    title: d.name,
    originalTitle: d.original_name,
    year: d.first_air_date ? parseInt(d.first_air_date.slice(0, 4), 10) : undefined,
    overview: d.overview,
    network: d.networks?.[0]?.name,
    status: (d.status?.toLowerCase() === 'ended' || d.status?.toLowerCase() === 'canceled') 
      ? 'ended' 
      : (d.status?.toLowerCase() === 'upcoming' || d.status?.toLowerCase() === 'planned' || d.status?.toLowerCase() === 'pilot')
        ? 'upcoming'
        : 'continuing',
    seriesType: 'standard',
    runtime: d.episode_run_time?.[0],
    genres: (d.genres ?? []).map((g: any) => g.name),
    posterPath: tmdbImageUrl(d.poster_path),
    backdropPath: tmdbImageUrl(d.backdrop_path, 'w1280'),
    logoPath: logo ? tmdbImageUrl(logo.file_path, 'original') : undefined,
    bannerPath: d.backdrop_path ? tmdbImageUrl(d.backdrop_path, 'w1280') : undefined,
    rating: d.vote_average,
    certification: cert,
    country: d.origin_country?.[0],
    language: d.original_language ?? 'en',
    airTime,
    airDay,
    cast,
    crew,
  }
}

export async function getSeriesSeasonsTmdb(tmdbId: number): Promise<SeriesSeason[]> {
  const d = await tmdbGet<any>(`/tv/${tmdbId}`)
  return (d.seasons ?? []).filter((s: any) => s.season_number > 0).map((s: any) => ({
    seasonNumber: s.season_number,
    title: s.name,
    overview: s.overview,
    posterPath: tmdbImageUrl(s.poster_path),
    episodeCount: s.episode_count,
    airDate: s.air_date,
  }))
}

export async function getSeriesEpisodesTmdb(tmdbId: number, seasonNumber: number): Promise<SeriesEpisode[]> {
  const d = await tmdbGet<any>(`/tv/${tmdbId}/season/${seasonNumber}`)
  return (d.episodes ?? []).map((e: any) => ({
    seasonNumber,
    episodeNumber: e.episode_number,
    title: e.name,
    overview: e.overview,
    airDate: e.air_date,
    runtime: e.runtime,
    stillPath: tmdbImageUrl(e.still_path, 'w300'),
  }))
}
