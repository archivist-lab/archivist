/** Stable contracts for the read/play Archivist Player API. */

export const PLAYER_PREFERENCE_SCHEMA_VERSION = 1 as const

export type PlayerPreset = 'classic' | 'categories' | 'compound' | 'combined'
export type PlayerView = 'poster' | 'landscape' | 'wall' | 'list'
export type PlayerWidgetSource =
  | 'continue'
  | 'recent-films'
  | 'recent-episodes'
  | 'downloading'
  | 'unwatched-films'
  | 'films-az'
  | 'series-az'
export type PlayerHubId = 'home' | 'films' | 'series' | 'tv'
export type PlayerMediaType = 'film' | 'series' | 'episode'
export type PlayerPrimaryAction = 'play' | 'resume' | 'resume-next' | 'unavailable'
export type PlayerWidgetLimit = 6 | 12 | 18 | 24 | 36 | 60

export interface Quality {
  resolution: string | null
  source: string | null
  codec: string | null
  tier: number | null
}

export interface Playback { directPlay: boolean; streamUrl: string }

export interface PersonCredit {
  id?: number | string
  name: string
  role?: string | null
  character?: string | null
  profileUrl?: string | null
  [key: string]: unknown
}

export interface PlayerProgressSummary {
  positionSeconds: number
  durationSeconds: number
  completed: boolean
  percent: number
}

export interface PlayerBadge { label: string; tone: 'neutral' | 'accent' | 'success' | 'warning' }

export interface PlayerDisplayMetadata {
  primary: string[]
  technical: string[]
}

export interface FilmSummary {
  id: number
  type: 'film'
  libraryId: number
  title: string
  sortTitle: string
  year: number | null
  overview: string | null
  posterUrl: string | null
  backdropUrl: string | null
  logoUrl: string | null
  runtimeSeconds: number | null
  rating: number | null
  certification: string | null
  genres: string[]
  status: 'available' | 'unavailable'
  hasFile: boolean
  quality: Quality | null
  addedAt: string | null
  acquiredAt: string | null
  playback: Playback | null
  progress?: PlayerProgressSummary | null
  primaryAction?: PlayerPrimaryAction
  displayMetadata?: PlayerDisplayMetadata
}

export interface FilmDetail extends FilmSummary {
  originalTitle: string | null
  studio: string | null
  country: string | null
  releaseDate: string | null
  cast: PersonCredit[]
  crew: PersonCredit[]
}

export interface SeriesSummary {
  id: number
  type: 'series'
  libraryId: number
  title: string
  sortTitle: string
  year: number | null
  overview: string | null
  posterUrl: string | null
  backdropUrl: string | null
  logoUrl: string | null
  network: string | null
  seriesStatus: string | null
  rating: number | null
  certification: string | null
  genres: string[]
  episodeCount: number
  availableEpisodeCount: number
  status: 'available' | 'unavailable'
  addedAt: string | null
  progress?: PlayerProgressSummary | null
  primaryAction?: PlayerPrimaryAction
  displayMetadata?: PlayerDisplayMetadata
}

export interface EpisodeSummary {
  id: number
  type: 'episode'
  seriesId: number
  seasonNumber: number
  episodeNumber: number
  title: string | null
  overview: string | null
  airDate: string | null
  runtimeSeconds: number | null
  stillUrl: string | null
  hasFile: boolean
  status: 'available' | 'unavailable'
  quality: Quality | null
  playback: Playback | null
  seriesTitle?: string
  seriesPosterUrl?: string | null
  progress?: PlayerProgressSummary | null
  primaryAction?: PlayerPrimaryAction
  displayMetadata?: PlayerDisplayMetadata
}

export interface Season {
  id: number
  seasonNumber: number
  title: string
  posterUrl: string | null
  episodes: EpisodeSummary[]
}

export interface SeriesDetail extends SeriesSummary {
  cast: PersonCredit[]
  crew: PersonCredit[]
  seasons: Season[]
  nextAvailable: EpisodeSummary | null
}

export interface PlayerLibrary {
  id: number
  name: string
  mediaType: 'films' | 'series'
  itemCount: number
  availableCount: number
}

export interface HomeRails {
  recentFilms: FilmSummary[]
  recentEpisodes: EpisodeSummary[]
  downloading: FilmSummary[]
}

export interface ServerHealth {
  status: string
  serverName: string
  version: string
  capabilities: Record<string, boolean>
}

export interface PlaybackProgress {
  key: string
  type: 'film' | 'episode'
  id: number
  title: string
  posterUrl: string | null
  backdropUrl: string | null
  streamUrl: string
  seriesId?: number
  seriesTitle?: string
  positionSeconds: number
  durationSeconds: number
  completed: boolean
  updatedAt: number
}

export interface GuideSlot {
  id: number
  channelId: number
  blockId: number | null
  blockName: string | null
  itemType: 'film' | 'episode'
  itemId: number
  startsAt: number
  endsAt: number
  status: string
  locked: boolean
  title: string
  seriesId: number | null
  seriesTitle: string | null
  seasonNumber: number | null
  episodeNumber: number | null
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  runtimeSeconds: number
  hasFile: boolean
  streamUrl: string | null
}

export interface ChannelSummary {
  id: number
  number: number
  name: string
  description: string | null
  brandColor: string
  logoUrl: string | null
  now: (GuideSlot & { offsetSeconds: number }) | null
  next: GuideSlot | null
}

export type SessionMode = 'WATCH_FROM_HERE' | 'PLAY_THIS_ONLY' | 'JOIN_LIVE'
export interface SessionItem extends GuideSlot { queuePosition: number; startOffsetSeconds: number; completedAt: string | null }
export interface PlaySession {
  sessionId: number
  channelId: number | null
  mode: SessionMode
  status: string
  currentPosition: number
  items: SessionItem[]
}

export interface AudioTrack {
  index: number
  codec: string
  language: string | null
  title: string | null
  channels: number | null
  channelLayout: string | null
  default: boolean
  browserFriendly: boolean
}

export interface SubtitleTrack {
  index: number
  codec: string
  language: string | null
  title: string | null
  default: boolean
  forced: boolean
  textBased: boolean
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

export interface PlayerWidgetPreference {
  id: string
  title: string
  source: PlayerWidgetSource
  view: PlayerView
  limit: PlayerWidgetLimit
  enabled: boolean
}

export interface PlayerNavigationPreferences { edgeRail: 'minimized' | 'visible'; showClock: boolean }
export interface PlayerHomePreferences { widgetMode: 'stacked' | 'combined'; showSpotlight: boolean; widgets: PlayerWidgetPreference[] }
export interface PlayerLibraryViewPreferences { view: PlayerView; sort: 'title' | 'added' | 'year' | 'rating'; hideUnavailable: boolean }
export interface PlayerLibraryPreferences { films: PlayerLibraryViewPreferences; series: PlayerLibraryViewPreferences }
export interface PlayerPlaybackPreferences {
  normalizeVolume: boolean
  targetLufs: -14 | -16 | -18 | -23
  preferredAudioLanguage: string | null
  preferredSubtitleLanguage: string | null
  subtitles: 'off' | 'forced' | 'preferred'
}
export interface PlayerAccessibilityPreferences { reducedMotion: 'system' | 'on' | 'off'; highContrast: boolean; textScale: 1 | 1.15 | 1.3 }

export interface PlayerPreferencesV1 {
  schemaVersion: 1
  preset: PlayerPreset
  navigation: PlayerNavigationPreferences
  home: PlayerHomePreferences
  libraries: PlayerLibraryPreferences
  playback: PlayerPlaybackPreferences
  accessibility: PlayerAccessibilityPreferences
  migration: { legacyLocalStorageImported: boolean }
}

export interface PlayerPreferencesEnvelope { profileId: string; revision: number; updatedAt: string; preferences: PlayerPreferencesV1 }
export interface UpdatePlayerPreferencesRequest { profileId: string; expectedRevision: number; preferences: PlayerPreferencesV1 }
export interface ResetPlayerPreferencesRequest { profileId: string; expectedRevision: number }

export interface PlayerFeatureFlags { uiV2Enabled: boolean; telemetryEnabled: boolean }
export interface PlayerPublicConfiguration { defaultPreset: PlayerPreset; maxWidgetItems: number }

export interface PlayerMediaCard {
  key: string
  mediaType: PlayerMediaType
  id: number
  route: string
  title: string
  subtitle: string | null
  plot: string | null
  year: number | null
  posterUrl: string | null
  landscapeUrl: string | null
  backdropUrl: string | null
  logoUrl: string | null
  progress: PlayerProgressSummary | null
  badges: PlayerBadge[]
  available: boolean
  primaryAction: PlayerPrimaryAction
}

export interface PlayerHubCategory { id: string; label: string; active: boolean }
export interface PlayerWidget {
  id: string
  title: string
  source: PlayerWidgetSource
  view: PlayerView
  items: PlayerMediaCard[]
  nextCursor: string | null
  total: number
}
export interface PlayerHub { id: PlayerHubId; title: string; categories: PlayerHubCategory[]; spotlight: PlayerMediaCard | null; widgets: PlayerWidget[] }

export interface PlayerBootstrap {
  server: ServerHealth
  featureFlags: PlayerFeatureFlags
  configuration: PlayerPublicConfiguration
  preferences: PlayerPreferencesEnvelope
  libraries: PlayerLibrary[]
  progress: PlaybackProgress[]
  initialHub: PlayerHub
}

export interface PlayerSearchGroups { films: FilmSummary[]; series: SeriesSummary[]; episodes: EpisodeSummary[] }

export type PlayerTelemetryName =
  | 'player_bootstrap_ms'
  | 'player_shell_ready_ms'
  | 'player_hub_ready_ms'
  | 'player_focus_move_ms'
  | 'player_backdrop_ready_ms'
  | 'player_osd_open_ms'
  | 'player_playback_start_ms'
  | 'player_probe_ms'
  | 'player_transcode_start_ms'
  | 'player_preference_save_ms'
  | 'player_api_error_count'
  | 'player_preference_conflict_count'

export interface PlayerTelemetrySample { name: PlayerTelemetryName; valueMs: number; at: number }
export interface PlayerTelemetryBatch { sessionId: string; samples: PlayerTelemetrySample[] }
export interface PlayerMetricAggregate { count: number; sum: number; min: number | null; max: number | null; buckets: Record<string, number> }
export interface PlayerMetricSnapshot { startedAt: string; metrics: Partial<Record<PlayerTelemetryName, PlayerMetricAggregate>> }

export interface PlayerApiError {
  error: { code: string; message: string; requestId: string; details?: Record<string, string | number | boolean> }
}
