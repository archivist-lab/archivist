import axios from 'axios'
import { sanitizeConfigValue } from '@archivist/core'

const TMDB_BASE = () => process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
const IMAGE_BASE = 'https://image.tmdb.org/t/p'

function apiKey(): string {
  return sanitizeConfigValue(process.env.TMDB_API_KEY)
}

function get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  return axios.get(`${TMDB_BASE()}${path}`, {
    params: { api_key: apiKey(), language: 'en-US', ...params },
    timeout: 10000,
  }).then(r => r.data)
}

export interface TmdbMovie {
  tmdbId: number
  imdbId?: string
  title: string
  originalTitle: string
  year?: number
  overview?: string
  runtime?: number
  genres: string[]
  posterPath?: string
  backdropPath?: string
  logoPath?: string
  bannerPath?: string
  rating?: number
  certification?: string
  studio?: string
  collection?: { tmdbId: number; name: string; posterPath?: string; backdropPath?: string }
  country?: string
  popularity?: number
  releaseDate?: string
  digitalReleaseDate?: string
  physicalReleaseDate?: string
  cast?: Array<{ id: number, name: string, character: string, profilePath?: string }>
  crew?: Array<{ id: number, name: string, job: string, profilePath?: string }>
  videos?: Array<{ key: string, site: string, type: string }>
  originalLanguage?: string
  availableVersions?: string[]
}

export async function searchMovies(query: string): Promise<TmdbMovie[]> {
  const data = await get<{ results: any[] }>('/search/movie', { query, include_adult: false })
  
  return (data.results ?? [])
    .map(row => parseMovie(row))
    .sort((a, b) => {
      // 1. Prioritize results with posters (removes obscure/experimental entries)
      if (a.posterPath && !b.posterPath) return -1
      if (!a.posterPath && b.posterPath) return 1
      
      // 2. Pure popularity sort (the most famous match wins)
      return (b.popularity ?? 0) - (a.popularity ?? 0)
    })
    .slice(0, 20)
}

export async function getMovie(tmdbId: number): Promise<TmdbMovie> {
  const details = await get<any>(`/movie/${tmdbId}`, { 
    append_to_response: 'release_dates,images,credits,videos,alternative_titles',
    include_image_language: 'en,null'
  })

  // Extract versions (Directors Cut, Extended, etc.)
  const versions = new Set<string>()
  const versionKeywords = [
    { pattern: /\b(director's cut|directors cut|director cut|dc)\b/i, label: "Director's Cut" },
    { pattern: /\b(extended cut|extended edition|extended|ee)\b/i, label: "Extended" },
    { pattern: /\b(unrated|uncut)\b/i, label: "Unrated" },
    { pattern: /\b(final cut)\b/i, label: "Final Cut" },
    { pattern: /\b(redux)\b/i, label: "Redux" },
    { pattern: /\b(ultimate edition|ultimate cut)\b/i, label: "Ultimate" },
    { pattern: /\b(special edition|se)\b/i, label: "Special Edition" },
    { pattern: /\b(international cut|international version|international)\b/i, label: "International Cut" },
    { pattern: /\b(workprint)\b/i, label: "Workprint" },
    { pattern: /\b(remastered|remaster)\b/i, label: "Remastered" },
  ]

  // Scan release date notes
  details.release_dates?.results?.forEach((r: any) => {
    r.release_dates?.forEach((d: any) => {
      if (d.note) {
        versionKeywords.forEach(v => {
          if (v.pattern.test(d.note)) versions.add(v.label)
        })
      }
    })
  })

  // Scan alternative titles
  details.alternative_titles?.titles?.forEach((t: any) => {
    versionKeywords.forEach(v => {
      if (v.pattern.test(t.title)) versions.add(v.label)
    })
  })

  const cert = details.release_dates?.results
    ?.find((r: any) => r.iso_3166_1 === 'US')
    ?.release_dates?.find((d: any) => d.certification)
    ?.certification

  const studio = details.production_companies?.[0]?.name

  const usReleases = details.release_dates?.results?.find((r: any) => r.iso_3166_1 === 'US')?.release_dates ?? []
  
  // Type 1: Premiere, Type 2: Limited Theatrical, Type 3: Theatrical
  const theatrical = usReleases
    .filter((r: any) => [1, 2, 3].includes(r.type))
    .map((r: any) => r.release_date)
    .sort()[0] || details.release_date
  
  // Type 4: Digital
  const digital = usReleases
    .filter((r: any) => r.type === 4)
    .map((r: any) => r.release_date)
    .sort()[0]

  // Type 5: Physical
  const physical = usReleases
    .filter((r: any) => r.type === 5)
    .map((r: any) => r.release_date)
    .sort()[0]

  const logo = details.images?.logos?.find((l: any) => l.iso_639_1 === 'en') || details.images?.logos?.[0]
  const banner = details.images?.backdrops?.[1] || details.images?.backdrops?.[0]

  return {
    tmdbId: details.id,
    imdbId: details.imdb_id || undefined,
    title: details.title,
    originalTitle: details.original_title,
    year: details.release_date ? parseInt(details.release_date.slice(0, 4), 10) : undefined,
    overview: details.overview || undefined,
    runtime: details.runtime || undefined,
    genres: (details.genres ?? []).map((g: any) => g.name),
    posterPath: tmdbImageUrl(details.poster_path),
    backdropPath: tmdbImageUrl(details.backdrop_path, 'w1280'),
    logoPath: logo ? tmdbImageUrl(logo.file_path, 'original') : undefined,
    bannerPath: banner ? tmdbImageUrl(banner.file_path, 'w1280') : undefined,
    rating: details.vote_average || undefined,
    certification: cert || undefined,
    studio: studio || undefined,
    collection: details.belongs_to_collection ? {
      tmdbId: details.belongs_to_collection.id,
      name: details.belongs_to_collection.name,
      posterPath: tmdbImageUrl(details.belongs_to_collection.poster_path),
      backdropPath: tmdbImageUrl(details.belongs_to_collection.backdrop_path, 'w1280'),
    } : undefined,
    country: details.production_countries?.[0]?.iso_3166_1,
    popularity: details.popularity,
    releaseDate: theatrical,
    digitalReleaseDate: digital || undefined,
    physicalReleaseDate: physical || undefined,
    cast: details.credits?.cast?.map((c: any) => ({
      id: c.id,
      name: c.name,
      character: c.character,
      profilePath: tmdbImageUrl(c.profile_path, 'w185')
    })),
    crew: details.credits?.crew
      ?.filter((c: any) => ['Director', 'Producer', 'Writer', 'Screenplay'].includes(c.job))
      ?.map((c: any) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        profilePath: tmdbImageUrl(c.profile_path, 'w185')
      })),
    videos: details.videos?.results?.map((v: any) => ({
      key: v.key,
      site: v.site,
      type: v.type
    })),
    originalLanguage: details.original_language || undefined,
    availableVersions: versions.size > 0 ? Array.from(versions) : undefined,
  }
}

function parseMovie(r: any, genreMap: Map<number, string> = new Map()): TmdbMovie {
  return {
    tmdbId: r.id,
    title: r.title,
    originalTitle: r.original_title,
    year: r.release_date ? parseInt(r.release_date.slice(0, 4), 10) : undefined,
    overview: r.overview || undefined,
    genres: Array.isArray(r.genres) ? r.genres.map((genre: any) => genre.name).filter(Boolean)
      : (r.genre_ids ?? []).map((id: number) => genreMap.get(Number(id))).filter(Boolean) as string[],
    posterPath: tmdbImageUrl(r.poster_path),
    backdropPath: tmdbImageUrl(r.backdrop_path, 'w1280'),
    rating: r.vote_average || undefined,
    popularity: r.popularity || 0,
    releaseDate: r.release_date,
  }
}

let movieGenreCache: { expiresAt: number; values: Map<number, string> } | null = null
async function movieGenres(): Promise<Map<number, string>> {
  if (movieGenreCache && movieGenreCache.expiresAt > Date.now()) return movieGenreCache.values
  const data = await get<{ genres: Array<{ id: number; name: string }> }>('/genre/movie/list')
  const values = new Map((data.genres ?? []).map(genre => [Number(genre.id), genre.name]))
  movieGenreCache = { expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, values }
  return values
}

export async function getMovieRecommendations(tmdbId: number): Promise<TmdbMovie[]> {
  const [data, genres] = await Promise.all([get<{ results: any[] }>(`/movie/${tmdbId}/recommendations`, { page: 1 }), movieGenres()])
  return (data.results ?? []).map(row => parseMovie(row, genres)).slice(0, 40)
}

export async function discoverMovies(): Promise<TmdbMovie[]> {
  const [trending, upcoming, genres] = await Promise.allSettled([
    get<{ results: any[] }>('/trending/movie/week'),
    get<{ results: any[] }>('/movie/upcoming', { region: 'US', page: 1 }),
    movieGenres(),
  ])
  const rows = [trending, upcoming].flatMap(result => result.status === 'fulfilled' ? result.value.results ?? [] : [])
  const genreMap = genres.status === 'fulfilled' ? genres.value : new Map<number, string>()
  return [...new Map(rows.map(row => [Number(row.id), parseMovie(row, genreMap)])).values()].slice(0, 60)
}

export function tmdbImageUrl(path: string | undefined | null, size = 'w342'): string | undefined {
  if (!path) return undefined
  if (path.startsWith('http') || path.startsWith('/media')) return path
  const cleanPath = path.startsWith('/') ? path.slice(1) : path
  return `${IMAGE_BASE}/${size}/${cleanPath}`
}
