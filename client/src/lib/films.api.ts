import { request } from './api.js'
import { itemSearchesApi } from './item-searches.api.js'

export interface Movie {
  id: number; tmdb_id?: number; imdb_id?: string; title: string
  original_title?: string; sort_title?: string; year?: number; overview?: string; runtime?: number
  genres: string[]; poster_path?: string; backdrop_path?: string; rating?: number
  certification?: string; studio?: string
  status: 'wanted' | 'acquiring' | 'collected' | 'missing' | 'uncollected'
  releaseStatus?: 'upcoming' | 'in_cinemas' | 'at_home'
  scanMode?: 'acquire' | 'upgrade' | 'satisfied'
  monitored: boolean; quality_profile_id?: number
  root_folder_path?: string; file_path?: string; added_at: string
  release_date?: string; digital_release_date?: string
  downloadProgress?: number
  cast?: Array<{ id: number, name: string, character: string, profilePath?: string }>
  crew?: Array<{ id: number, name: string, job: string, profilePath?: string }>
  country?: string
  trailerPath?: string
  download_tier?: number
  target_tier?: string
  target_resolution?: string
  target_source?: string
  target_codec?: string
  minimum_tier?: string
  minimum_resolution?: string
  minimum_source?: string
  minimum_codec?: string
  upgrade_allowed?: boolean
  current_tier?: number
  current_resolution?: string | null
  current_source?: string | null
  current_codec?: string | null
  current_release_group?: string | null
  current_edition?: string | null
  current_size_bytes?: number | null
  current_release_title?: string | null
  info_hash?: string | null
  default_edition_id?: number | null
  editions?: any[]
}

export interface MovieRelease {
  guid: string; indexerName: string; title: string; downloadUrl: string
  size: number; seeders?: number; leechers?: number
  publishDate: string; protocol: string; quality?: string
  tier?: number
  customTier?: number
  matchLevel?: 'match' | 'higher' | 'lower'
}

export interface TmdbResult {
  tmdbId: number; title: string; originalTitle: string
  year?: number; overview?: string; genres: string[]
  posterPath?: string; backdropPath?: string; rating?: number
  logoPath?: string; 
  cast?: Array<{ id: number, name: string, character: string, profilePath?: string }>
  crew?: Array<{ id: number, name: string, job: string, profilePath?: string }>
  country?: string
  trailerPath?: string
  localId?: number; alreadyAdded?: boolean; status?: string; file_path?: string; acquired_at?: string
  runtime?: number; certification?: string; studio?: string; releaseDate?: string; digitalReleaseDate?: string; physicalReleaseDate?: string
  fileInfo?: {
    path: string
    size: number
    filename: string
    extension: string
    resolution?: string
    codec?: string
    audio?: Array<{ language: string, channels: number, title?: string }>
    audioChannels?: string
    subtitles?: string[]
    chapters?: Array<{ number: number, title: string, start: string }>
  } | null
}

interface FilmPage {
  items: Movie[]
  nextCursor: string | null
}

async function listAllFilms(params?: { field?: string; q?: string; filters?: Array<{ field: string; q: string }>; signal?: AbortSignal }): Promise<Movie[]> {
  const items: Movie[] = []
  let cursor: string | undefined

  do {
    const p = new URLSearchParams({ limit: '250' })
    if (params?.filters?.length) p.set('filters', JSON.stringify(params.filters))
    else if (params?.q?.trim()) { p.set('q', params.q.trim()); p.set('field', params.field ?? 'title') }
    if (cursor) p.set('cursor', cursor)

    const page = await request<FilmPage>(`/films?${p.toString()}`, { signal: params?.signal })
    items.push(...page.items)
    if (page.nextCursor === cursor) throw new Error('Film pagination cursor did not advance')
    cursor = page.nextCursor ?? undefined
  } while (cursor)

  return items
}

export const filmsApi = {
  // Fetch bounded pages while preserving the existing Promise<Movie[]> contract.
  list: listAllFilms,
  get:      (id: number, signal?: AbortSignal) => request<Movie>(`/films/${id}`, { signal }),
  getByTmdbId: (tmdbId: number) => request<TmdbResult>(`/films/tmdb/${tmdbId}`),
  add:    (data: { tmdbId: number; qualityProfileId?: number; monitored?: boolean; target_tier?: string; target_resolution?: string; target_source?: string; target_codec?: string; minimum_tier?: string; minimum_resolution?: string; minimum_source?: string; minimum_codec?: string }) =>
    request<Movie>('/films', { method: 'POST', body: JSON.stringify(data) }),
  refresh: () => request<{ success: boolean; updated: number }>('/films/refresh', { method: 'POST' }),
  autoGrab: (id: number) => request<{ success: boolean; message: string }>(`/films/${id}/auto-grab`, { method: 'POST' }),
  update: (id: number, data: Partial<Movie>) =>
    request<Movie>(`/films/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete:   (id: number, deleteFiles = false) => request<void>(`/films/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
  acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/films/${id}/acquisition-history`),
  rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
    request<{ success: boolean }>(`/films/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
  repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
    request<Movie>(`/films/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
  lookup:   (q: string)  => request<TmdbResult[]>(`/films/lookup?q=${encodeURIComponent(q)}`),
  discoverByField: (field: string, q: string) => request<TmdbResult[]>(`/films/discover-by-field?field=${encodeURIComponent(field)}&q=${encodeURIComponent(q)}`),
  discoverByFilters: (filters: Array<{ field: string; q: string }>) => request<TmdbResult[]>(`/films/discover-compound?filters=${encodeURIComponent(JSON.stringify(filters))}`),
  discover: (category: 'trending' | 'upcoming' | 'top_rated' | 'for-you') => request<TmdbResult[]>(`/films/discover?category=${category}`),
  updateMetadata: (id: number, data: any) =>
    request<Movie>(`/films/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
  searchImages: (id: number, type: string, language?: string) =>
    request<any[]>(`/films/${id}/images?type=${type}&language=${language || ''}`),
  saveImage: (id: number, type: string, url: string) =>
    request<{ success: boolean; path: string }>(`/films/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
  releases: {
    search: (q: string, year: number | undefined, options: { resolution?: string, tier?: string, source?: string, codec?: string, filmId?: number }, onBatch: (items: MovieRelease[]) => void, signal?: AbortSignal) => {
      void q
      void year
      const seen = new Set<string>()
      return itemSearchesApi.startAndWait<MovieRelease>({
        mediaType: 'films', subjectType: 'film', subjectId: options.filmId!, mode: 'deep',
        options: { tier: options.tier, resolution: options.resolution, source: options.source, codec: options.codec },
      }, search => {
        const additions = search.results.filter(result => !seen.has(result.guid))
        additions.forEach(result => seen.add(result.guid))
        if (additions.length > 0) onBatch(additions)
      }, signal).then(() => undefined)
    },
    auto: (filmId: number, signal?: AbortSignal) =>
      itemSearchesApi.startAndWait<MovieRelease>({ mediaType: 'films', subjectType: 'film', subjectId: filmId, mode: 'auto' }, undefined, signal)
        .then(search => ({ success: search.grabbed, message: search.message || 'Auto scan complete' })),
    quick: (filmId: number, signal?: AbortSignal) =>
      itemSearchesApi.startAndWait<MovieRelease>({ mediaType: 'films', subjectType: 'film', subjectId: filmId, mode: 'quick' }, undefined, signal)
        .then(search => ({ releases: search.results })),
    latest: (filmId: number, signal?: AbortSignal) =>
      itemSearchesApi.latest<MovieRelease>({ mediaType: 'films', subjectType: 'film', subjectId: filmId }, signal),
    watch: (search: import('./item-searches.api.js').ItemSearch<MovieRelease>, onUpdate?: (search: import('./item-searches.api.js').ItemSearch<MovieRelease>) => void, signal?: AbortSignal) =>
      itemSearchesApi.wait(search, onUpdate, signal),
    cancel: (filmId: number) =>
      itemSearchesApi.cancelLatest<MovieRelease>({ mediaType: 'films', subjectType: 'film', subjectId: filmId }),
  },
  download: (downloadUrl: string, filmId?: number, tier?: number) =>
    request<{ success: boolean; message: string }>('/films/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl, filmId, tier }),
    }),
  editionRules: {
    list: () => request<any[]>('/films/edition-rules/all'),
    add: (data: any) => request<any>('/films/edition-rules', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<any>(`/films/edition-rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number) => request<{ success: boolean }>(`/films/edition-rules/${id}`, { method: 'DELETE' }),
  }
}
