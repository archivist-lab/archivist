import { request, streamSearch } from './api.js'

export interface Series {
  id: number; tvdb_id?: number; tmdb_id?: number; title: string; sort_title: string
  year?: number; overview?: string; network?: string
  status: 'continuing' | 'ended' | 'upcoming' | 'unknown'
  series_type: string; runtime?: number; genres: string[]
  poster_path?: string; backdrop_path?: string; logo_path?: string; rating?: number
  posterPath?: string; backdropPath?: string; logoPath?: string;
  monitored: boolean; quality_profile_id?: number; seasons?: Season[]
  downloaded_episodes?: number; total_episodes?: number; downloading_episodes?: number
  stats?: {
    total: number
    downloaded: number
    acquiring: number
    missing: number
  }
  cast?: Array<{ id: number, name: string, character: string, profilePath?: string }>
  crew?: Array<{ id: number, name: string, job: string, profilePath?: string }>
  country?: string
  certification?: string
  upgrade_allowed?: boolean
  target_tier?: string | null
  target_resolution?: string | null
  target_source?: string | null
  target_codec?: string | null
}

export interface Season {
  id: number; series_id: number; season_number: number; title?: string
  episode_count: number; monitored: boolean
  upgrade_allowed?: boolean
  total_episodes?: number; downloaded_episodes?: number; missing_episodes?: number
  poster_path?: string; air_date?: string
}

export interface Episode {
  id: number; series_id: number; season_number: number; episode_number: number
  title?: string; overview?: string; air_date?: string; runtime?: number
  still_path?: string; monitored: boolean
  status: 'missing' | 'wanted' | 'downloading' | 'downloaded' | 'ignored' | 'unaired'
  file_path?: string; quality?: string; downloadProgress?: number
  upgrade_allowed?: boolean
  current_tier?: number
  current_resolution?: string | null
  current_source?: string | null
  current_codec?: string | null
  current_release_group?: string | null
  current_edition?: string | null
  current_size_bytes?: number | null
  current_release_title?: string | null
}

export interface SeriesSearchResult {
  tvdbId?: number; tmdbId?: number; title: string; year?: number
  overview?: string; posterPath?: string; logoPath?: string; network?: string; status: string
  cast?: Array<{ id: number, name: string, character: string, profilePath?: string }>
  crew?: Array<{ id: number, name: string, job: string, profilePath?: string }>
  country?: string
  certification?: string
}

export interface SeriesRelease {
  guid: string; indexerName: string; title: string; downloadUrl: string
  size: number; seeders?: number; leechers?: number; publishDate: string; protocol: string
}

export const seriesApi = {
  // Flattened series methods
  list:   ()           => request<Series[]>('/series'),
  get:    async (id: number) => {
    const series = await request<Series & { seasons: Season[] }>(`/series/${id}`)
    // The backend might not return seasons in the main series GET, so we fetch them if missing
    if (!series.seasons) {
      try {
        series.seasons = await request<Season[]>(`/series/${id}/seasons`)
      } catch (err) {
        console.warn('Failed to fetch seasons for series:', id, err)
        series.seasons = []
      }
    }
    return series
  },
  add:    (data: { tvdbId?: number; tmdbId?: number; monitored?: boolean; monitoredSeasons?: string; target_tier?: string; target_resolution?: string; target_source?: string; target_codec?: string; upgrade_allowed?: boolean }) =>
            request<Series>('/series', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Series>) =>
            request<Series>(`/series/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  updateMetadata: (id: number, data: Record<string, unknown>) =>
            request<Series>(`/series/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
  searchImages: (id: number, type: string, language = 'en') =>
            request<any[]>(`/series/${id}/images?type=${type}&language=${language}`),
  saveImage: (id: number, type: string, url: string) =>
            request<{ success: boolean; path: string }>(`/series/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
  delete: (id: number, deleteFiles = false) => request<void>(`/series/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
  getTmdb: (tmdbId: number) => request<any>(`/series/tmdb/${tmdbId}`),
  acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/series/${id}/acquisition-history`),
  preview: (opts: { tvdbId?: number; tmdbId?: number }) => {
    const qs = new URLSearchParams()
    if (opts.tvdbId) qs.set('tvdbId', String(opts.tvdbId))
    if (opts.tmdbId) qs.set('tmdbId', String(opts.tmdbId))
    return request<{ seasonCount?: number; episodeCount?: number; firstAired?: string; lastAired?: string; status?: string }>(`/series/preview?${qs.toString()}`)
  },
  refresh: () => request<{ success: boolean; message: string }>('/series/refresh', { method: 'POST' }),

  seasons: {
    list:   (seriesId: number) => request<Season[]>(`/series/${seriesId}/seasons`),
    get:    async (seriesId: number, seasonNum: number) => {
      // Frontend expects { episodes: Episode[] }
      const episodes = await request<Episode[]>(`/series/${seriesId}/episodes`)
      return { episodes: episodes.filter(e => e.season_number === seasonNum) }
    },
    update: (_seriesId: number, seasonId: number, data: { monitored?: boolean; upgrade_allowed?: boolean }) =>
              request<void>(`/series/seasons/${seasonId}`, { method: 'PUT', body: JSON.stringify(data) }),
    acquisitionHistory: (seasonId: number) =>
              request<{ decisions: any[]; blocks: any[] }>(`/series/seasons/${seasonId}/acquisition-history`),
    rejectCurrentRelease: (seasonId: number, reason = 'user-rejected-release') =>
              request<{ success: boolean }>(`/series/seasons/${seasonId}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    repair: (seasonId: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
              request<Season>(`/series/seasons/${seasonId}/repair`, { method: 'POST', body: JSON.stringify(data) }),
  },
  episodes: {
    list:   (seriesId: number, season?: number) =>
              request<Episode[]>(`/series/${seriesId}/episodes${season !== undefined ? `?season=${season}` : ''}`),
    update: (id: number, data: { monitored?: boolean; upgrade_allowed?: boolean }) =>
              request<Episode>(`/series/episodes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    acquisitionHistory: (id: number) =>
              request<{ decisions: any[]; blocks: any[] }>(`/series/episodes/${id}/acquisition-history`),
    rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
              request<{ success: boolean }>(`/series/episodes/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
              request<Episode>(`/series/episodes/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
  },
  lookup:   (q: string) => request<SeriesSearchResult[]>(`/series/lookup?q=${encodeURIComponent(q)}`),
  releases: {
    search: (q: string, onBatch: (items: SeriesRelease[]) => void, signal?: AbortSignal) =>
      streamSearch<SeriesRelease>(`/series/releases/search?q=${encodeURIComponent(q)}`, onBatch, signal),
  },
  download: (downloadUrl: string, seriesId?: number, seasonNumber?: number, episodeId?: number) =>
    request<{ success: boolean; message: string }>('/series/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl, seriesId, seasonNumber, episodeId }),
    }),
  calendar: (days?: number) => request<any[]>(`/series/calendar${days ? `?days=${days}` : ''}`),
}
