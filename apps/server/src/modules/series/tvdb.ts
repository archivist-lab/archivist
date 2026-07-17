import axios from 'axios'
import { sanitizeConfigValue, createLogger } from '@archivist/core'

const logger = createLogger('TVDB')

const TVDB_BASE = process.env.TVDB_BASE_URL ?? 'https://api4.thetvdb.com/v4'
const TMDB_BASE = process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
const SKYHOOK_BASE = process.env.SKYHOOK_BASE_URL ?? 'https://skyhook.sonarr.tv'
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

async function getTvdbToken(): Promise<string> {
  if (tvdbToken && Date.now() < tvdbExpiry) return tvdbToken
  const key = sanitizeConfigValue(process.env.TVDB_API_KEY)
  const pin = sanitizeConfigValue(process.env.TVDB_PIN)
  if (!key) throw new Error('TVDB_API_KEY not set')
  const credentials = pin ? { apikey: key, pin } : { apikey: key }
  const res = await axios.post(`${TVDB_BASE}/login`, credentials, { timeout: 10000 })
  tvdbToken = res.data.data.token
  tvdbExpiry = Date.now() + 23 * 60 * 60 * 1000
  return tvdbToken!
}

async function tvdbGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
  const token = await getTvdbToken()
  const res = await axios.get(`${TVDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 15000,
  })
  return res.data.data
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SeriesSearchResult {
  tvdbId?: number; tmdbId?: number; title: string; year?: number
  overview?: string; posterPath?: string; network?: string; status: string
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
  const response = await axios.get(`${SKYHOOK_BASE}/v1/tvdb/shows/en/${tvdbId}`, { timeout: 15000 })
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
    logger.error('TVDB search failed:', err instanceof Error ? err.message : String(err))
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
  const res = await axios.get(`${TMDB_BASE}${path}`, { params: { api_key: key, language: 'en-US', ...params }, timeout: 10000 })
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
    status: 'unknown',
  }))
}

export async function getSeriesTmdb(tmdbId: number): Promise<SeriesEntity> {
  const d = await tmdbGet<any>(`/tv/${tmdbId}`, { append_to_response: 'images,credits,content_ratings,external_ids', include_image_language: 'en,null' })
  
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
    cast: d.credits?.cast?.map((c: any) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profilePath: tmdbImageUrl(c.profile_path, 'w185')
    })),
    crew: d.credits?.crew
      ?.filter((c: any) => ['Director', 'Producer', 'Executive Producer', 'Writer', 'Screenplay'].includes(c.job))
      ?.map((c: any) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        profilePath: tmdbImageUrl(c.profile_path, 'w185')
      }))
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
