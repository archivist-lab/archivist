import { request } from './api.js'

export interface Artist {
  id: number; musicbrainz_id?: string; name: string; sort_name?: string
  overview?: string; disambiguation?: string; genres: string[]; image_url?: string
  backdrop_url?: string; logo_url?: string
  monitored: boolean; album_count?: number; downloaded_albums?: number
}

export interface Album {
  id: number; artist_id: number; musicbrainz_id?: string; title: string
  release_date?: string; year?: number; album_type: string; genres: string[]
  cover_url?: string; cdart_url?: string; label?: string; track_count: number
  monitored: boolean; status: string; downloaded_tracks?: number
  downloadProgress?: number
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
  info_hash?: string | null
}

export interface Track {
  id: number; album_id: number; title: string
  track_number?: number; disc_number: number; duration?: number
  status: string; file_path?: string; quality?: string
  downloadProgress?: number
}

export const musicApi = {
  artists: {
    list:   ()           => request<Artist[]>('/music/artists'),
    get:    (id: number) => request<Artist & { albums: Album[] }>(`/music/artists/${id}`),
    add:    (mbid: string, monitored = true, albumTypes: string[] = []) =>
              request<Artist>('/music/artists', { method: 'POST', body: JSON.stringify({ mbid, monitored, albumTypes }) }),
    delete: (id: number, deleteFiles = false) => request<void>(`/music/artists/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
    acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/music/artists/${id}/acquisition-history`),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
              request<Artist>(`/music/artists/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number, type: string) =>
              request<any[]>(`/music/artists/${id}/images?type=${type}`),
    saveImage: (id: number, type: string, url: string) =>
              request<{ success: boolean; path: string }>(`/music/artists/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
    refresh: () => request<{ success: boolean; message: string }>('/music/refresh', { method: 'POST' }),
  },
  albums: {
    get:    (id: number) => request<Album>(`/music/albums/${id}`),
    update: (id: number, data: { monitored?: boolean; status?: string; upgrade_allowed?: boolean; target_tier?: string }) =>
              request<Album>(`/music/albums/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    acquisitionHistory: (id: number) =>
              request<{ decisions: any[]; blocks: any[] }>(`/music/albums/${id}/acquisition-history`),
    rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
              request<{ success: boolean }>(`/music/albums/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
              request<Album>(`/music/albums/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
  },
  lookup:   (q: string) => request<any[]>(`/music/lookup?q=${encodeURIComponent(q)}`),
  lookupArtist: (mbid: string) => request<any>(`/music/lookup/${mbid}`),
  download: (downloadUrl: string) =>
    request<{ success: boolean; message: string }>('/music/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl }),
    }),
}
