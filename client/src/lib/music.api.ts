import { request } from './api.js'

export interface Artist {
  id: number; musicbrainz_id?: string; name: string; sort_name?: string
  overview?: string; disambiguation?: string; genres: string[]; image_url?: string
  backdrop_url?: string; logo_url?: string
  monitored: boolean; album_count?: number; downloaded_albums?: number; acquiring_albums?: number
  country?: string
  album_types?: string[] | string
  upgrade_allowed?: boolean
  target_tier?: string | null
  target_resolution?: string | null
  target_codec?: string | null
  minimum_tier?: string | null
  minimum_resolution?: string | null
  minimum_codec?: string | null
  members?: BandMember[]
  discography_status?: string | null
  discography_progress?: number
  discography_title?: string | null
}

export interface MusicRelease {
  guid: string; indexerName: string; title: string; downloadUrl: string
  size?: number; seeders?: number; leechers?: number; quality?: string
}

export interface BandMember {
  mbid: string
  name: string
  roles: string[]
  begin?: string
  end?: string
  current: boolean
}

export interface Album {
  id: number; artist_id: number; musicbrainz_id?: string; title: string
  release_date?: string; year?: number; album_type: string; genres: string[]
  cover_url?: string; cdart_url?: string; label?: string; track_count: number
  overview?: string | null
  monitored: boolean; status: string; downloaded_tracks?: number
  target_resolution?: string | null
  target_codec?: string | null
  minimum_tier?: string | null
  minimum_resolution?: string | null
  minimum_codec?: string | null
  current_quality?: string | null
  tracks?: Track[]
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
  monitored?: boolean
  downloadProgress?: number
  lyrics?: string | null
  lyrics_source?: string | null
  lyrics_updated_at?: string | null
}

export const musicApi = {
  artists: {
    list:   (signal?: AbortSignal) => request<Artist[]>('/music/artists', { signal }),
    get:    (id: number, signal?: AbortSignal) => request<Artist & { albums: Album[] }>(`/music/artists/${id}`, { signal }),
    update: (id: number, data: {
      monitored?: boolean; albumTypes?: string[]; upgrade_allowed?: boolean
      target_tier?: string | null; target_resolution?: string | null; target_codec?: string | null
      minimum_tier?: string | null; minimum_resolution?: string | null; minimum_codec?: string | null
    }) =>
              request<Artist>(`/music/artists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    searchDiscography: (id: number) =>
              request<{ query: string; releases: MusicRelease[] }>(
                `/music/artists/${id}/search-discography`, { method: 'POST', body: JSON.stringify({}) }),
    grabDiscography: (id: number, downloadUrl: string, title?: string) =>
              request<{ success: boolean; message: string }>(
                `/music/artists/${id}/grab-discography`, { method: 'POST', body: JSON.stringify({ downloadUrl, title }) }),
    refreshOne: (id: number, albumTypes?: string[]) =>
              request<{ success: boolean; added: number; removed: number; types: string[] }>(
                `/music/artists/${id}/refresh`, { method: 'POST', body: JSON.stringify({ albumTypes }) }),
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
    update: (id: number, data: {
      monitored?: boolean; status?: string; upgrade_allowed?: boolean
      target_tier?: string | null; target_resolution?: string | null; target_codec?: string | null
      minimum_tier?: string | null; minimum_resolution?: string | null; minimum_codec?: string | null
    }) =>
              request<Album>(`/music/albums/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    acquisitionHistory: (id: number) =>
              request<{ decisions: any[]; blocks: any[] }>(`/music/albums/${id}/acquisition-history`),
    rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
              request<{ success: boolean }>(`/music/albums/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    search: (id: number, mode: 'quick' | 'deep') =>
              request<{ mode: string; query: string; releases: MusicRelease[] }>(
                `/music/albums/${id}/search`, { method: 'POST', body: JSON.stringify({ mode }) }),
    autoGrab: (id: number) =>
              request<{ success: boolean; message: string }>(`/music/albums/${id}/auto-grab`, { method: 'POST' }),
    repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
              request<Album>(`/music/albums/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
              request<Album>(`/music/albums/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number, type: string) =>
              request<any[]>(`/music/albums/${id}/images?type=${type}`),
    saveImage: (id: number, type: string, url: string) =>
              request<{ success: boolean; path: string }>(`/music/albums/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
  },
  tracks: {
    update: (id: number, data: { monitored?: boolean }) =>
              request<Track>(`/music/tracks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    saveLyrics: (id: number, lyrics: string | null) =>
              request<Track>(`/music/tracks/${id}/lyrics`, { method: 'PUT', body: JSON.stringify({ lyrics }) }),
  },
  lookup:   (q: string) => request<any[]>(`/music/lookup?q=${encodeURIComponent(q)}`),
  lookupArtist: (mbid: string) => request<any>(`/music/lookup/${mbid}`),
  download: (downloadUrl: string, albumId?: number) =>
    request<{ success: boolean; message: string }>('/music/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl, albumId }),
    }),
}
