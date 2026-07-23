import { request, streamSearch } from './api.js'

export interface Movie {
  id: number; tmdb_id?: number; imdb_id?: string; title: string
  original_title?: string; year?: number; overview?: string; runtime?: number
  genres: string[]; poster_path?: string; backdrop_path?: string; rating?: number
  certification?: string; studio?: string
  status: 'wanted' | 'acquiring' | 'collected' | 'missing' | 'uncollected'
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

export const filmsApi = {
  list:     ()           => request<Movie[]>('/films'),
  get:      (id: number) => request<Movie>(`/films/${id}`),
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
  discover: (category: 'discover' | 'upcoming' | 'trending' | 'for-you') => request<TmdbResult[]>(`/films/discover?category=${category}`),
  updateMetadata: (id: number, data: any) =>
    request<Movie>(`/films/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
  searchImages: (id: number, type: string, language?: string) =>
    request<any[]>(`/films/${id}/images?type=${type}&language=${language || ''}`),
  saveImage: (id: number, type: string, url: string) =>
    request<{ success: boolean; path: string }>(`/films/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
  releases: {
    search: (q: string, year: number | undefined, options: { resolution?: string, tier?: string, source?: string, codec?: string, filmId?: number }, onBatch: (items: MovieRelease[]) => void, signal?: AbortSignal) => {
      let url = `/films/releases/search?q=${encodeURIComponent(q)}`
      if (year) url += `&year=${year}`
      if (options.resolution && options.resolution !== 'Any') url += `&resolution=${encodeURIComponent(options.resolution)}`
      if (options.tier && options.tier !== 'Any') url += `&tier=${encodeURIComponent(options.tier)}`
      if (options.source && options.source !== 'Any') url += `&source=${encodeURIComponent(options.source)}`
      if (options.codec && options.codec !== 'Any') url += `&codec=${encodeURIComponent(options.codec)}`
      if (options.filmId != null) url += `&filmId=${options.filmId}`
      return streamSearch<MovieRelease>(url, onBatch, signal)
    },
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
