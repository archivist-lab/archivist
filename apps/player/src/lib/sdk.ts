import type {
  ChannelSummary,
  FilmDetail,
  FilmSummary,
  MediaTracks,
  PlaybackProgress,
  PlaySession,
  PlayerApiError,
  PlayerBootstrap,
  PlayerHub,
  PlayerHubId,
  PlayerLibrary,
  PlayerMetricSnapshot,
  PlayerPreferencesEnvelope,
  PlayerSearchGroups,
  PlayerTelemetryBatch,
  ResetPlayerPreferencesRequest,
  SeriesDetail,
  SeriesSummary,
  EpisodeSummary,
  GuideSlot,
  ServerHealth,
  SessionMode,
  UpdatePlayerPreferencesRequest,
} from '@archivist/contracts'

export type {
  AudioTrack, ChannelSummary, EpisodeSummary, FilmDetail, FilmSummary, GuideSlot, HomeRails,
  Loudness, MediaSegment, MediaSegments, MediaTracks, SegmentAnalysis, Playback, PlaybackProgress, PlaySession, PlayerBootstrap, PlayerHub,
  PlayerLibrary, PlayerMediaCard, PlayerPreferencesEnvelope, Quality, Season, SeriesDetail,
  SeriesSummary, ServerHealth, SessionItem, SessionMode, SubtitleTrack,
} from '@archivist/contracts'

export interface Connection { url: string; apiKey: string }

interface CacheEntry { at: number; data: unknown }
interface InflightEntry { promise: Promise<unknown>; controller: AbortController; subscribers: number }
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, InflightEntry>()
const MAX_CACHE = 100

export class PlayerSdkError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly requestId: string,
    message: string,
    public readonly details?: Record<string, string | number | boolean>,
    public readonly current?: PlayerPreferencesEnvelope,
  ) {
    super(message)
    this.name = 'PlayerSdkError'
  }
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
}

export class ArchivistSdk {
  constructor(private conn: Connection) {}

  asset(path: string | null | undefined, withKey = false): string {
    if (!path) return ''
    if (/^https?:\/\//.test(path)) return path
    const url = `${this.conn.url.replace(/\/$/, '')}${path}`
    return withKey && this.conn.apiKey ? `${url}${url.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.conn.apiKey)}` : url
  }

  private url(path: string): string {
    return `${this.conn.url.replace(/\/$/, '')}/api/v1/player${path}`
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(this.conn.apiKey ? { 'x-api-key': this.conn.apiKey } : {}),
    }
  }

  private async parseError(response: Response): Promise<never> {
    const body = await response.json().catch(() => null) as (PlayerApiError & { current?: PlayerPreferencesEnvelope }) | null
    throw new PlayerSdkError(
      response.status,
      body?.error?.code ?? 'PLAYER_HTTP_ERROR',
      body?.error?.requestId ?? response.headers.get('x-request-id') ?? '',
      body?.error?.message ?? `${response.status} ${response.statusText}`,
      body?.error?.details,
      body?.current,
    )
  }

  private async get<T>(path: string, ttl = 30_000, signal?: AbortSignal): Promise<T> {
    const key = this.url(path)
    const hit = cache.get(key)
    if (ttl > 0 && hit && Date.now() - hit.at < ttl) { touch(key, hit); return hit.data as T }
    let entry = inflight.get(key)
    if (entry?.controller.signal.aborted) { inflight.delete(key); entry = undefined }
    if (!entry) {
      const controller = new AbortController()
      const created: InflightEntry = { controller, subscribers: 0, promise: Promise.resolve(undefined) }
      created.promise = fetch(key, { credentials: 'include', headers: this.headers(), signal: controller.signal }).then(async response => {
        if (!response.ok) return this.parseError(response)
        const data = await response.json() as T
        if (ttl > 0) touch(key, { at: Date.now(), data })
        return data
      }).finally(() => { if (inflight.get(key) === created) inflight.delete(key) })
      entry = created
      inflight.set(key, entry)
    }
    if (!signal) return entry.promise as Promise<T>
    if (signal.aborted) {
      if (entry.subscribers === 0) entry.controller.abort()
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    entry.subscribers++
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = () => {
        if (settled) return false
        settled = true
        signal.removeEventListener('abort', abort)
        entry!.subscribers = Math.max(0, entry!.subscribers - 1)
        return true
      }
      const abort = () => {
        if (!finish()) return
        if (entry!.subscribers === 0) entry!.controller.abort()
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      signal.addEventListener('abort', abort, { once: true })
      entry!.promise.then(value => { if (finish()) resolve(value as T) }, reason => { if (finish()) reject(reason) })
    })
  }

  private async send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.url(path), {
      method,
      credentials: 'include',
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (!response.ok) return this.parseError(response)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private invalidate(fragment: string): void {
    for (const key of cache.keys()) if (key.includes(fragment)) cache.delete(key)
  }

  bootstrap(profile = 'default', signal?: AbortSignal) {
    return this.get<PlayerBootstrap>(`/ui/bootstrap?profile=${encodeURIComponent(profile)}`, 0, signal)
  }
  health() { return this.get<ServerHealth>('/health', 0) }
  progress() { return this.get<{ progress: PlaybackProgress[] }>('/progress', 0) }
  async saveProgress(input: { type: 'film' | 'episode'; id: number; positionSeconds: number; durationSeconds: number; completed: boolean }) {
    await this.send<void>('POST', '/progress', input)
    this.invalidate('/hubs/')
    this.invalidate('/ui/bootstrap')
  }
  async deleteProgress(type: 'film' | 'episode', id: number): Promise<void> {
    await this.send<void>('DELETE', `/progress/${type}/${id}`)
    this.invalidate('/hubs/')
  }
  libraries() { return this.get<{ libraries: PlayerLibrary[] }>('/libraries', 60_000) }
  home() { return this.get<{ rails: import('@archivist/contracts').HomeRails }>('/home', 15_000) }
  search(q: string, signal?: AbortSignal) {
    return this.get<{ results: Array<FilmSummary | SeriesSummary>; groups: PlayerSearchGroups }>(`/search?q=${encodeURIComponent(q)}&limit=30`, 0, signal)
  }
  films(library?: number) { return this.get<{ films: FilmSummary[] }>(`/films${library ? `?library=${library}` : ''}`, 30_000) }
  pagedFilms(query: string, signal?: AbortSignal) { return this.get<{ films: FilmSummary[]; total: number; nextCursor: string | null }>(`/films?${query}`, 15_000, signal) }
  film(id: number) { return this.get<FilmDetail>(`/films/${id}`, 30_000) }
  series(library?: number) { return this.get<{ series: SeriesSummary[] }>(`/series${library ? `?library=${library}` : ''}`, 30_000) }
  pagedSeries(query: string, signal?: AbortSignal) { return this.get<{ series: SeriesSummary[]; total: number; nextCursor: string | null }>(`/series?${query}`, 15_000, signal) }
  seriesDetail(id: number) { return this.get<SeriesDetail>(`/series/${id}`, 30_000) }
  episode(id: number) { return this.get<EpisodeSummary>(`/episodes/${id}`, 30_000) }

  hub(hubId: PlayerHubId, options: { profile?: string; libraryId?: number | null; cursor?: string | null; limit?: number } = {}, signal?: AbortSignal) {
    const query = new URLSearchParams({ profile: options.profile ?? 'default' })
    if (options.libraryId) query.set('libraryId', String(options.libraryId))
    if (options.cursor) query.set('cursor', options.cursor)
    if (options.limit) query.set('limit', String(options.limit))
    return this.get<PlayerHub>(`/hubs/${hubId}?${query}`, 15_000, signal)
  }
  async updatePreferences(input: UpdatePlayerPreferencesRequest, signal?: AbortSignal) {
    const result = await this.send<PlayerPreferencesEnvelope>('PUT', '/ui/preferences', input, signal)
    this.invalidate('/hubs/')
    this.invalidate('/ui/bootstrap')
    return result
  }
  async resetPreferences(input: ResetPlayerPreferencesRequest, signal?: AbortSignal) {
    const result = await this.send<PlayerPreferencesEnvelope>('POST', '/ui/preferences/reset', input, signal)
    this.invalidate('/hubs/')
    this.invalidate('/ui/bootstrap')
    return result
  }
  telemetry(batch: PlayerTelemetryBatch): Promise<void> {
    return this.send<void>('POST', '/telemetry', batch).catch(() => undefined)
  }
  metrics() { return this.get<PlayerMetricSnapshot>('/metrics', 0) }

  mediaTracks(type: 'films' | 'episodes', id: number) { return this.get<MediaTracks>(`/stream/${type}/${id}/tracks`, 0) }
  subtitleUrl(type: 'films' | 'episodes', id: number, index: number) { return this.asset(`/api/v1/player/stream/${type}/${id}/subtitle/${index}.vtt`, true) }
  transcodeUrl(type: 'films' | 'episodes', id: number, opts: { audio?: number; subs?: number; t?: number; norm?: number } = {}) {
    const query = new URLSearchParams()
    if (opts.audio != null) query.set('audio', String(opts.audio))
    if (opts.subs != null) query.set('subs', String(opts.subs))
    if (opts.t != null && opts.t > 0) query.set('t', String(Math.floor(opts.t)))
    if (opts.norm != null) query.set('norm', String(opts.norm))
    return this.asset(`/api/v1/player/stream/${type}/${id}/transcode${query.size ? `?${query}` : ''}`, true)
  }

  channels() { return this.get<{ channels: ChannelSummary[] }>('/channels', 0) }
  channelGuide(id: number, from: number, to: number) { return this.get<{ slots: GuideSlot[] }>(`/channels/${id}/guide?from=${from}&to=${to}`, 0) }
  channelNow(id: number) { return this.get<{ now: (GuideSlot & { offsetSeconds: number }) | null; next: GuideSlot | null }>(`/channels/${id}/now`, 0) }
  createPlaySession(channelId: number, startSlotId: number, mode: SessionMode) { return this.send<PlaySession>('POST', '/play-sessions', { channelId, startSlotId, mode }) }
  completeSessionItem(sessionId: number, position: number) { return this.send<PlaySession>('POST', `/play-sessions/${sessionId}/items/${position}/complete`) }
  stopPlaySession(sessionId: number) { return this.send<void>('POST', `/play-sessions/${sessionId}/stop`) }
}

export function clearSdkCache(): void { cache.clear(); inflight.clear() }
