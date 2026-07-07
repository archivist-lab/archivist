import { request } from './api.js'

// ── Comics ────────────────────────────────────────────────────────────────────

export interface ComicSeries {
  id: number; comicvine_id?: number; title: string; sort_title?: string
  start_year?: number; publisher?: string; description?: string
  issue_count?: number; downloaded_issues?: number
  image_url?: string; monitored: boolean
}

export interface ComicIssue {
  id: number; series_id: number; comicvine_id?: number; name?: string
  issue_number: string; cover_date?: string; overview?: string
  image_url?: string; monitored: boolean; status: string
  info_hash?: string | null
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

export const comicsApi = {
  series: {
    list:   ()       => request<ComicSeries[]>('/comics/series'),
    get:    (id: number) => request<ComicSeries & { issues: ComicIssue[] }>(`/comics/series/${id}`),
    add:    (cvId: number) => request<ComicSeries>('/comics/series', { method: 'POST', body: JSON.stringify({ cvId }) }),
    delete: (id: number, deleteFiles = false) => request<void>(`/comics/series/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
    acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/comics/series/${id}/acquisition-history`),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
      request<ComicSeries>(`/comics/series/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number) => request<any[]>(`/comics/series/${id}/images`),
    saveImage: (id: number, type: string, url: string) =>
      request<{ success: boolean; path: string }>(`/comics/series/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
    refresh: () => request<{ success: boolean; message: string }>('/comics/refresh', { method: 'POST' }),
  },
  issues: {
    update: (id: number, data: { monitored?: boolean; status?: string; upgrade_allowed?: boolean }) =>
      request<ComicIssue>(`/comics/issues/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    autoGrab: (id: number) =>
      request<{ success: boolean; message: string }>(`/comics/issues/${id}/auto-grab`, { method: 'POST' }),
    acquisitionHistory: (id: number) =>
      request<{ decisions: any[]; blocks: any[] }>(`/comics/issues/${id}/acquisition-history`),
    rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
      request<{ success: boolean }>(`/comics/issues/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
      request<ComicIssue>(`/comics/issues/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
  },
  lookup:   (q: string) => request<any[]>(`/comics/lookup?q=${encodeURIComponent(q)}`),
  download: (downloadUrl: string) =>
    request<{ success: boolean; message: string }>('/comics/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl }),
    }),
}

// ── Games ─────────────────────────────────────────────────────────────────────

export interface Game {
  id: number; igdb_id?: number; title: string; sort_title?: string
  year?: number; platforms?: string[]; overview?: string; genres?: string[]
  cover_url?: string; screenshot_url?: string; rating?: number;
  developer?: string; publisher?: string;
  monitored: boolean; status: string; downloadProgress?: number
  info_hash?: string | null
  upgrade_allowed?: boolean
  target_tier?: string | null
  current_tier?: number
  current_resolution?: string | null
  current_source?: string | null
  current_codec?: string | null
  current_release_group?: string | null
  current_edition?: string | null
  current_size_bytes?: number | null
  current_release_title?: string | null
}

export const gamesApi = {
  list:   ()       => request<Game[]>('/games'),
  get:    (id: number) => request<Game>(`/games/${id}`),
  add:    (igdbId: number, platforms?: string[]) => request<Game>('/games', { method: 'POST', body: JSON.stringify({ igdbId, platforms }) }),
  update: (id: number, data: Partial<Game>) => request<Game>(`/games/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  updateMetadata: (id: number, data: Record<string, unknown>) =>
    request<Game>(`/games/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
  searchImages: (id: number, type: string) => request<any[]>(`/games/${id}/images?type=${type}`),
  saveImage: (id: number, type: string, url: string) =>
    request<{ success: boolean; path: string }>(`/games/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
  delete: (id: number, deleteFiles = false) => request<void>(`/games/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
  refresh: () => request<{ success: boolean; message: string }>('/games/refresh', { method: 'POST' }),
  autoGrab: (id: number) => request<{ success: boolean; message: string }>(`/games/${id}/auto-grab`, { method: 'POST' }),
  acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/games/${id}/acquisition-history`),
  rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
    request<{ success: boolean }>(`/games/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
  repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
    request<Game>(`/games/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
  lookup: (q: string, platformId?: number) => {
    let url = `/games/lookup?q=${encodeURIComponent(q)}`
    if (platformId) url += `&platformId=${platformId}`
    return request<any[]>(url)
  },
  download: (downloadUrl: string) =>
    request<{ success: boolean; message: string }>('/games/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl }),
    }),
}
