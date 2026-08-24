import { request } from './api.js'
import { itemSearchesApi } from './item-searches.api.js'
import type { ItemSearch } from './item-searches.api.js'

export interface Artist {
  id: number
  musicbrainz_id?: string
  name: string
  sort_name?: string
  overview?: string
  disambiguation?: string
  genres: string[]
  image_url?: string
  backdrop_url?: string
  logo_url?: string
  monitored: boolean
  album_count?: number
  downloaded_albums?: number
  acquiring_albums?: number
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
  discography_torrent_status?: string | null
}

export interface MusicRelease {
  guid: string
  indexerName: string
  title: string
  downloadUrl: string
  torrentUrl?: string
  magnetUrl?: string
  size?: number
  seeders?: number
  leechers?: number
  quality?: string
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
  id: number
  artist_id: number
  musicbrainz_id?: string
  title: string
  musicbrainz_release_id?: string | null
  release_date?: string
  year?: number
  album_type: string
  genres: string[]
  cover_url?: string
  cdart_url?: string
  label?: string
  track_count: number
  overview?: string | null
  monitored: boolean
  status: string
  downloaded_tracks?: number
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
  torrent_status?: string | null
  selected_release?: AlbumRelease | null
}

/** One album MusicBrainz offers for a release type, plus what the library knows. */
export interface ReleaseCandidate {
  musicbrainzId: string
  title: string
  year: number | null
  albumType: string
  inLibrary: boolean
  /** Previously removed from the library, so a plain refresh leaves it out. */
  removed: boolean
  /** Collected or mid-download: shown as present and never removed. */
  locked: boolean
}

export interface AlbumRelease {
  id: string
  title: string
  date?: string
  country?: string
  status?: string
  disambiguation?: string
  packaging?: string
  barcode?: string
  label?: string
  mediaFormats: string[]
  discCount: number
  trackCount: number
  selected: boolean
}

export interface Track {
  id: number
  album_id: number
  title: string
  track_number?: number
  disc_number: number
  duration?: number
  status: string
  file_path?: string
  quality?: string
  monitored?: boolean
  downloadProgress?: number
  lyrics?: string | null
  lyrics_source?: string | null
  lyrics_updated_at?: string | null
}

export const musicApi = {
  artists: {
    list: (signal?: AbortSignal) => request<Artist[]>('/music/artists', { signal }),
    get: (id: number, signal?: AbortSignal) => request<Artist & { albums: Album[] }>(`/music/artists/${id}`, { signal }),
    update: (
      id: number,
      data: {
        monitored?: boolean
        albumTypes?: string[]
        upgrade_allowed?: boolean
        target_tier?: string | null
        target_resolution?: string | null
        target_codec?: string | null
        minimum_tier?: string | null
        minimum_resolution?: string | null
        minimum_codec?: string | null
      },
    ) => request<Artist>(`/music/artists/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    searchDiscography: (id: number, signal?: AbortSignal, onUpdate?: (search: ItemSearch<MusicRelease>) => void) =>
      itemSearchesApi
        .startAndWait<MusicRelease>(
          {
            mediaType: 'music',
            subjectType: 'artist',
            subjectId: id,
            mode: 'deep',
          },
          onUpdate,
          signal,
        )
        .then(search => ({ query: `${id}:discography`, releases: search.results })),
    grabDiscography: (id: number, release: MusicRelease, signal?: AbortSignal) =>
      request<{ success: boolean; message: string }>(`/music/artists/${id}/grab-discography`, {
        method: 'POST',
        body: JSON.stringify({ downloadUrl: release.downloadUrl, title: release.title, release }),
        signal,
      }),
    latestDiscographySearch: (id: number, signal?: AbortSignal) =>
      itemSearchesApi.latest<MusicRelease>({ mediaType: 'music', subjectType: 'artist', subjectId: id }, signal),
    watchDiscographySearch: (
      search: import('./item-searches.api.js').ItemSearch<MusicRelease>,
      onUpdate?: (search: import('./item-searches.api.js').ItemSearch<MusicRelease>) => void,
      signal?: AbortSignal,
    ) => itemSearchesApi.wait(search, onUpdate, signal),
    /** Albums MusicBrainz lists for these types, annotated with library state. */
    releaseCandidates: (id: number, types: string[], signal?: AbortSignal) =>
      request<{ candidates: ReleaseCandidate[] }>(
        `/music/artists/${id}/release-candidates?types=${encodeURIComponent(types.join(','))}`,
        { signal },
      ),
    /**
     * `restoreRemoved` re-adds every album for the tracked types, including
     * ones removed from the library. Left off, removals stick; types enabled
     * for the first time populate either way.
     *
     * `selectedAlbumIds` overrides both: it is the exact set the library should
     * hold for these types, so omitting an album removes it.
     */
    refreshOne: (id: number, albumTypes?: string[], restoreRemoved = false, selectedAlbumIds?: string[]) =>
      request<{ success: boolean; added: number; removed: number; skipped: number; deselected: number; types: string[] }>(
        `/music/artists/${id}/refresh`,
        { method: 'POST', body: JSON.stringify({ albumTypes, restoreRemoved, selectedAlbumIds }) },
      ),
    add: (mbid: string, monitored = true, albumTypes: string[] = []) =>
      request<Artist>('/music/artists', { method: 'POST', body: JSON.stringify({ mbid, monitored, albumTypes }) }),
    delete: (id: number, deleteFiles = false) => request<void>(`/music/artists/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
    acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/music/artists/${id}/acquisition-history`),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
      request<Artist>(`/music/artists/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number, type: string) => request<any[]>(`/music/artists/${id}/images?type=${type}`),
    saveImage: (id: number, type: string, url: string) =>
      request<{ success: boolean; path: string }>(`/music/artists/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
    refresh: () => request<{ success: boolean; message: string }>('/music/refresh', { method: 'POST' }),
  },
  albums: {
    get: (id: number) => request<Album>(`/music/albums/${id}`),
    update: (
      id: number,
      data: {
        monitored?: boolean
        status?: string
        upgrade_allowed?: boolean
        target_tier?: string | null
        target_resolution?: string | null
        target_codec?: string | null
        minimum_tier?: string | null
        minimum_resolution?: string | null
        minimum_codec?: string | null
      },
    ) => request<Album>(`/music/albums/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    /**
     * Removes the album from the library. The artist keeps its release-type
     * selection, so applying that selection again from the artist's Releases
     * dialog brings the album back.
     */
    delete: (id: number, deleteFiles = false) =>
      request<{ success: boolean; filesDeleted: number }>(
        `/music/albums/${id}${deleteFiles ? '?deleteFiles=true' : ''}`,
        { method: 'DELETE' },
      ),
    releases: (id: number, refresh = false, signal?: AbortSignal) =>
      request<{ releases: AlbumRelease[] }>(`/music/albums/${id}/releases${refresh ? '?refresh=true' : ''}`, { signal }),
    selectRelease: (id: number, releaseId: string) =>
      request<{ album: Album & { tracks: Track[] }; release: AlbumRelease }>(`/music/albums/${id}/release`, {
        method: 'PUT',
        body: JSON.stringify({ releaseId }),
      }),
    acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/music/albums/${id}/acquisition-history`),
    rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
      request<{ success: boolean }>(`/music/albums/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    search: (id: number, mode: 'quick' | 'deep', signal?: AbortSignal, onUpdate?: (search: ItemSearch<MusicRelease>) => void) =>
      itemSearchesApi
        .startAndWait<MusicRelease>(
          {
            mediaType: 'music',
            subjectType: 'album',
            subjectId: id,
            mode,
          },
          onUpdate,
          signal,
        )
        .then(search => ({ mode: search.mode, query: '', releases: search.results })),
    autoGrab: (id: number, signal?: AbortSignal) =>
      itemSearchesApi
        .startAndWait<MusicRelease>(
          {
            mediaType: 'music',
            subjectType: 'album',
            subjectId: id,
            mode: 'auto',
          },
          undefined,
          signal,
        )
        .then(search => ({ success: search.grabbed, message: search.message || 'Auto scan complete' })),
    latestSearch: (id: number, signal?: AbortSignal) =>
      itemSearchesApi.latest<MusicRelease>({ mediaType: 'music', subjectType: 'album', subjectId: id }, signal),
    watchSearch: (
      search: import('./item-searches.api.js').ItemSearch<MusicRelease>,
      onUpdate?: (search: import('./item-searches.api.js').ItemSearch<MusicRelease>) => void,
      signal?: AbortSignal,
    ) => itemSearchesApi.wait(search, onUpdate, signal),
    cancelSearch: (id: number) => itemSearchesApi.cancelLatest<MusicRelease>({ mediaType: 'music', subjectType: 'album', subjectId: id }),
    repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
      request<Album>(`/music/albums/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
      request<Album>(`/music/albums/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number, type: string) => request<any[]>(`/music/albums/${id}/images?type=${type}`),
    saveImage: (id: number, type: string, url: string) =>
      request<{ success: boolean; path: string }>(`/music/albums/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
  },
  tracks: {
    update: (id: number, data: { monitored?: boolean }) => request<Track>(`/music/tracks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    saveLyrics: (id: number, lyrics: string | null) => request<Track>(`/music/tracks/${id}/lyrics`, { method: 'PUT', body: JSON.stringify({ lyrics }) }),
  },
  lookup: (q: string) => request<any[]>(`/music/lookup?q=${encodeURIComponent(q)}`),
  lookupArtist: (mbid: string) => request<any>(`/music/lookup/${mbid}`),
  download: (release: MusicRelease, albumId: number) =>
    request<{ success: boolean; message: string }>('/music/download', {
      method: 'POST',
      body: JSON.stringify({
        downloadUrl: release.downloadUrl,
        albumId,
        releaseTitle: release.title,
        releaseGuid: release.guid,
        indexerName: release.indexerName,
        size: release.size,
        seeders: release.seeders,
        leechers: release.leechers,
      }),
    }),
}
