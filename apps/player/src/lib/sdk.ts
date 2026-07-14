// Typed client for the Archivist /api/v1/player contract — the only API the
// player consumes. Small in-memory TTL cache keeps navigation snappy without a
// query library.

export interface Quality { resolution: string | null; source: string | null; codec: string | null; tier: number | null }
export interface Playback { directPlay: boolean; streamUrl: string }

export interface FilmSummary {
  id: number; type: 'film'; libraryId: number; title: string; sortTitle: string
  year: number | null; overview: string | null
  posterUrl: string | null; backdropUrl: string | null; logoUrl: string | null
  runtimeSeconds: number | null; rating: number | null; certification: string | null
  genres: string[]; status: 'available' | 'unavailable'; hasFile: boolean
  quality: Quality | null; addedAt: string | null; acquiredAt: string | null
  playback: Playback | null
}
export interface FilmDetail extends FilmSummary {
  originalTitle: string | null; studio: string | null; country: string | null
  releaseDate: string | null; cast: any[]; crew: any[]
}
export interface SeriesSummary {
  id: number; type: 'series'; libraryId: number; title: string; sortTitle: string
  year: number | null; overview: string | null
  posterUrl: string | null; backdropUrl: string | null; logoUrl: string | null
  network: string | null; seriesStatus: string | null; rating: number | null
  certification: string | null; genres: string[]
  episodeCount: number; availableEpisodeCount: number
  status: 'available' | 'unavailable'; addedAt: string | null
}
export interface EpisodeSummary {
  id: number; type: 'episode'; seriesId: number; seasonNumber: number; episodeNumber: number
  title: string | null; overview: string | null; airDate: string | null
  runtimeSeconds: number | null; stillUrl: string | null; hasFile: boolean
  status: 'available' | 'unavailable'; quality: Quality | null; playback: Playback | null
  seriesTitle?: string; seriesPosterUrl?: string | null
}
export interface Season { id: number; seasonNumber: number; title: string; posterUrl: string | null; episodes: EpisodeSummary[] }
export interface SeriesDetail extends SeriesSummary { cast: any[]; crew: any[]; seasons: Season[]; nextAvailable: EpisodeSummary | null }
export interface PlayerLibrary { id: number; name: string; mediaType: 'films' | 'series'; itemCount: number; availableCount: number }
export interface HomeRails { recentFilms: FilmSummary[]; recentEpisodes: EpisodeSummary[]; downloading: FilmSummary[] }
export interface ServerHealth { status: string; serverName: string; version: string; capabilities: Record<string, boolean> }
export interface PlaybackProgress {
  key: string; type: 'film' | 'episode'; id: number; title: string
  posterUrl: string | null; backdropUrl: string | null; streamUrl: string
  seriesId?: number; seriesTitle?: string
  positionSeconds: number; durationSeconds: number; completed: boolean; updatedAt: number
}

// ── Channels (personal TV network; archivist-channels.md) ────────────────────

export interface GuideSlot {
  id: number; channelId: number; blockId: number | null; blockName: string | null
  itemType: 'film' | 'episode'; itemId: number
  startsAt: number; endsAt: number; status: string; locked: boolean
  title: string; seriesId: number | null; seriesTitle: string | null
  seasonNumber: number | null; episodeNumber: number | null; year: number | null
  posterUrl: string | null; backdropUrl: string | null
  runtimeSeconds: number; hasFile: boolean; streamUrl: string | null
}
export interface ChannelSummary {
  id: number; number: number; name: string; description: string | null
  brandColor: string; logoUrl: string | null
  now: (GuideSlot & { offsetSeconds: number }) | null
  next: GuideSlot | null
}
export type SessionMode = 'WATCH_FROM_HERE' | 'PLAY_THIS_ONLY' | 'JOIN_LIVE'
export interface SessionItem extends GuideSlot {
  queuePosition: number; startOffsetSeconds: number; completedAt: string | null
}
export interface PlaySession {
  sessionId: number; channelId: number | null; mode: SessionMode
  status: string; currentPosition: number; items: SessionItem[]
}

// ── Media tracks (audio / subtitles) ─────────────────────────────────────────

export interface AudioTrack {
  index: number; codec: string; language: string | null; title: string | null
  channels: number | null; channelLayout: string | null; default: boolean; browserFriendly: boolean
}
export interface SubtitleTrack {
  index: number; codec: string; language: string | null; title: string | null
  default: boolean; forced: boolean; textBased: boolean
}
export interface Loudness { integratedLufs: number; truePeak: number; lra: number; threshold: number }
export interface MediaTracks {
  container: string | null
  durationSec: number | null
  video: { codec: string | null; profile: string | null; pixFmt: string | null; browserFriendly: boolean } | null
  audio: AudioTrack[]
  subtitles: SubtitleTrack[]
  directPlayable: boolean
  loudness: Loudness | null
  targetLufs: number
}

export interface Connection { url: string; apiKey: string }

const cache = new Map<string, { at: number; data: unknown }>()
const TTL = 30_000

export class ArchivistSdk {
  constructor(private conn: Connection) {}

  /** Absolute URL for artwork/stream paths returned by the API. */
  asset(path: string | null | undefined, withKey = false): string {
    if (!path) return ''
    if (/^https?:\/\//.test(path)) return path
    const url = `${this.conn.url.replace(/\/$/, '')}${path}`
    // Media elements can't send headers — the key rides the query string.
    return withKey && this.conn.apiKey ? `${url}${url.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.conn.apiKey)}` : url
  }

  private async get<T>(path: string, useCache = true): Promise<T> {
    const key = `${this.conn.url}${path}`
    const hit = cache.get(key)
    if (useCache && hit && Date.now() - hit.at < TTL) return hit.data as T
    const res = await fetch(`${this.conn.url.replace(/\/$/, '')}/api/v1/player${path}`, {
      credentials: 'include',
      headers: this.conn.apiKey ? { 'x-api-key': this.conn.apiKey } : {},
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const data = (await res.json()) as T
    cache.set(key, { at: Date.now(), data })
    return data
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.conn.url.replace(/\/$/, '')}/api/v1/player${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(this.conn.apiKey ? { 'x-api-key': this.conn.apiKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => null)
      throw new Error(err?.error ?? `${res.status} ${res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  health() { return this.get<ServerHealth>('/health', false) }
  progress() { return this.get<{ progress: PlaybackProgress[] }>('/progress', false) }
  saveProgress(input: { type: 'film' | 'episode'; id: number; positionSeconds: number; durationSeconds: number; completed: boolean }) {
    return this.post<void>('/progress', input)
  }
  async deleteProgress(type: 'film' | 'episode', id: number): Promise<void> {
    const response = await fetch(
      `${this.conn.url.replace(/\/$/, '')}/api/v1/player/progress/${type}/${id}`,
      {
        method: 'DELETE',
        credentials: 'include',
        headers: this.conn.apiKey ? { 'x-api-key': this.conn.apiKey } : {},
      },
    )
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  }
  libraries() { return this.get<{ libraries: PlayerLibrary[] }>('/libraries') }
  home() { return this.get<{ rails: HomeRails }>('/home') }
  search(q: string) { return this.get<{ results: Array<FilmSummary | SeriesSummary> }>(`/search?q=${encodeURIComponent(q)}`, false) }
  films(library?: number) { return this.get<{ films: FilmSummary[] }>(`/films${library ? `?library=${library}` : ''}`) }
  film(id: number) { return this.get<FilmDetail>(`/films/${id}`) }
  series(library?: number) { return this.get<{ series: SeriesSummary[] }>(`/series${library ? `?library=${library}` : ''}`) }
  seriesDetail(id: number) { return this.get<SeriesDetail>(`/series/${id}`) }
  episode(id: number) { return this.get<EpisodeSummary>(`/episodes/${id}`) }

  /** Probe a stream target's audio/subtitle tracks (type = 'films' | 'episodes'). */
  mediaTracks(type: 'films' | 'episodes', id: number) {
    return this.get<MediaTracks>(`/stream/${type}/${id}/tracks`, false)
  }
  /** Absolute WebVTT URL for a text subtitle track (with api key). */
  subtitleUrl(type: 'films' | 'episodes', id: number, index: number) {
    return this.asset(`/api/v1/player/stream/${type}/${id}/subtitle/${index}.vtt`, true)
  }
  /** Absolute compatibility-transcode URL (H.264+AAC), optionally seeking/track-selecting/normalizing. */
  transcodeUrl(type: 'films' | 'episodes', id: number, opts: { audio?: number; subs?: number; t?: number; norm?: number } = {}) {
    const q = new URLSearchParams()
    if (opts.audio != null) q.set('audio', String(opts.audio))
    if (opts.subs != null) q.set('subs', String(opts.subs))
    if (opts.t != null && opts.t > 0) q.set('t', String(Math.floor(opts.t)))
    if (opts.norm != null) q.set('norm', String(opts.norm))
    const qs = q.toString()
    return this.asset(`/api/v1/player/stream/${type}/${id}/transcode${qs ? `?${qs}` : ''}`, true)
  }

  channels() { return this.get<{ channels: ChannelSummary[] }>('/channels', false) }
  channelGuide(id: number, from: number, to: number) {
    return this.get<{ slots: GuideSlot[] }>(`/channels/${id}/guide?from=${from}&to=${to}`, false)
  }
  channelNow(id: number) {
    return this.get<{ now: (GuideSlot & { offsetSeconds: number }) | null; next: GuideSlot | null }>(`/channels/${id}/now`, false)
  }
  createPlaySession(channelId: number, startSlotId: number, mode: SessionMode) {
    return this.post<PlaySession>('/play-sessions', { channelId, startSlotId, mode })
  }
  completeSessionItem(sessionId: number, position: number) {
    return this.post<PlaySession>(`/play-sessions/${sessionId}/items/${position}/complete`)
  }
  stopPlaySession(sessionId: number) {
    return this.post<void>(`/play-sessions/${sessionId}/stop`)
  }
}

export function clearSdkCache() { cache.clear() }
