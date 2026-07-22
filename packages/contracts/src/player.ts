/** Stable contracts for the read/play Archivist Player API. */

export const PLAYER_PREFERENCE_SCHEMA_VERSION = 5 as const

export type PlayerPreset = 'classic' | 'categories' | 'compound' | 'combined'
export type PlayerView = 'poster' | 'landscape' | 'wall' | 'list'
export type PlayerHubLayout = 'standard' | 'combined' | 'wall'
export type PlayerWidgetSort = 'source' | 'title' | 'added' | 'year' | 'rating'
export type PlayerSortOrder = 'asc' | 'desc'
export type PlayerAutoscrollInterval = 0 | 5 | 8 | 10 | 15 | 20 | 30
export type PlayerBrowseContentType = 'films' | 'series' | 'seasons' | 'episodes' | 'collections' | 'people'
export type PlayerFilterableContentType = 'films' | 'series' | 'episodes' | 'collections'
export type PlayerAvailabilityFilter = 'all' | 'available' | 'unavailable'
export type PlayerWatchedFilter = 'all' | 'watched' | 'unwatched' | 'in-progress'
export type PlayerWidgetSource =
  | 'continue'
  | 'recommendations'
  | 'recent-films'
  | 'recent-episodes'
  | 'downloading'
  | 'unwatched-films'
  | 'unwatched-series'
  | 'unwatched-episodes'
  | 'recently-played'
  | 'top-rated-films'
  | 'top-rated-series'
  | 'random-films'
  | 'random-series'
  | 'collections'
  | 'saved-filter'
  | 'films-az'
  | 'series-az'
export type PlayerHubId = string
export type PlayerMediaType = 'film' | 'series' | 'episode' | 'collection' | 'download'
export type PlayerPrimaryAction = 'play' | 'resume' | 'resume-next' | 'unavailable'
export type PlayerWidgetLimit = 6 | 12 | 18 | 24 | 36 | 60
export type PlayerDetailRow = 'cast' | 'crew' | 'collection' | 'gallery' | 'recommendations' | 'seasons' | 'episodes'
export type PlayerRatingProvider = 'tmdb' | 'imdb' | 'trakt'
export type PlayerDetailAction = 'play' | 'trailer' | 'mark-watched' | 'information'

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
  activityBadges?: PlayerBadge[]
}

export interface FilmDetail extends FilmSummary {
  originalTitle: string | null
  studio: string | null
  country: string | null
  releaseDate: string | null
  cast: PersonCredit[]
  crew: PersonCredit[]
  collection: { id: number; name: string; posterUrl: string | null; backdropUrl: string | null } | null
  editions: PlayerEdition[]
  ratings: PlayerRating[]
  trailerUrl: string | null
  file: PlayerFileInformation | null
  recommendations: PlayerMediaCard[]
  artworkUrls: string[]
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
  activityBadges?: PlayerBadge[]
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
  activityBadges?: PlayerBadge[]
  airTime?: string | null
  airAt?: string | null
}

export interface Season {
  id: number
  seasonNumber: number
  title: string
  posterUrl: string | null
  episodes: EpisodeSummary[]
  overview?: string | null
}

export interface SeriesDetail extends SeriesSummary {
  cast: PersonCredit[]
  crew: PersonCredit[]
  seasons: Season[]
  nextAvailable: EpisodeSummary | null
  ratings: PlayerRating[]
  trailerUrl: string | null
  recommendations: PlayerMediaCard[]
  artworkUrls: string[]
}

export interface PlayerRating { provider: PlayerRatingProvider; value: number; scale: number }
export interface PlayerEdition {
  id: number
  name: string
  isDefault: boolean
  available: boolean
  runtimeSeconds: number | null
  posterUrl: string | null
  backdropUrl: string | null
  quality: Quality | null
  playback: Playback | null
}
export interface PlayerFileInformation {
  sizeBytes: number | null
  container: string | null
  videoCodec: string | null
  resolution: string | null
  audioCodec: string | null
  edition: string | null
}
export interface PlayerPersonDetail {
  id: number | string
  name: string
  biography: string | null
  profileUrl: string | null
  credits: PlayerMediaCard[]
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
  /** Original ffprobe language tag (for example eng, en, or en-US). */
  languageCode?: string | null
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
  /** Original ffprobe language tag (for example eng, en, or en-US). */
  languageCode?: string | null
  language: string | null
  title: string | null
  default: boolean
  forced: boolean
  textBased: boolean
}

export interface Loudness { integratedLufs: number; truePeak: number; lra: number; threshold: number }
export interface MediaSegment { start: number; end: number; confidence: number; method: string }
export interface MediaSegments { intro?: MediaSegment; credits?: MediaSegment }
export interface SegmentAnalysis {
  state: 'pending' | 'queued' | 'analysing' | 'detected' | 'partial' | 'no_match' | 'failed' | 'cancelled' | string
  analysedAt: string | null
  detectorVersion: string | null
  error?: string
}
export interface MediaTracks {
  container: string | null
  durationSec: number | null
  video: { codec: string | null; profile: string | null; pixFmt: string | null; width?: number | null; height?: number | null; browserFriendly: boolean } | null
  audio: AudioTrack[]
  subtitles: SubtitleTrack[]
  directPlayable: boolean
  loudness: Loudness | null
  targetLufs: number
  /** Optional so clients remain compatible with servers predating segment detection. */
  segments?: MediaSegments | null
  segmentAnalysis?: SegmentAnalysis | null
  chapters: PlayerChapter[]
}
export interface PlayerChapter { index: number; start: number; end: number | null; title: string }
export interface PlayerBookmark { id: number; mediaType: 'film' | 'episode'; mediaId: number; positionSeconds: number; label: string; createdAt: string }
export interface PlayerSubtitleSearchResult {
  id: string
  fileName: string
  language: string
  downloadCount: number
  hearingImpaired: boolean
  foreignPartsOnly: boolean
  rating: number
  uploadDate: string
  fileId: number
}

export interface PlayerWidgetPreference {
  id: string
  title: string
  source: PlayerWidgetSource
  view: PlayerView
  sort: PlayerWidgetSort
  sortOrder: PlayerSortOrder
  limit: PlayerWidgetLimit
  autoscrollSeconds: PlayerAutoscrollInterval
  savedFilterId: string | null
  downloadMediaTypes: Array<'films' | 'series' | 'other'>
  enabled: boolean
}

export interface PlayerBrowseFilter {
  query: string
  genres: string[]
  yearFrom: number | null
  yearTo: number | null
  studios: string[]
  ratingMin: number | null
  availability: PlayerAvailabilityFilter
  watched: PlayerWatchedFilter
  alphabet: string | null
  collectionId: number | null
}

export interface PlayerSavedFilter {
  id: string
  name: string
  mediaType: PlayerFilterableContentType
  filters: PlayerBrowseFilter
  view: PlayerView
  sort: Exclude<PlayerWidgetSort, 'source'>
  sortOrder: PlayerSortOrder
}

export interface PlayerNavigationPreferences { edgeRail: 'minimized' | 'visible'; showClock: boolean }
export interface PlayerHubPreference {
  id: string
  name: string
  icon: string
  enabled: boolean
  layout: PlayerHubLayout
  showSpotlight: boolean
  spotlightWidgetId: string | null
  widgets: PlayerWidgetPreference[]
}
export interface PlayerHomePreferences { hubs: PlayerHubPreference[] }
export interface PlayerLibraryViewPreferences { view: PlayerView; sort: 'title' | 'added' | 'year' | 'rating'; sortOrder: PlayerSortOrder; hideUnavailable: boolean }
export interface PlayerLibraryPreferences { films: PlayerLibraryViewPreferences; series: PlayerLibraryViewPreferences }
export interface PlayerBrowsePreferences {
  defaultViews: Record<PlayerBrowseContentType, PlayerView>
  savedFilters: PlayerSavedFilter[]
}
export interface PlayerPlaybackPreferences {
  normalizeVolume: boolean
  targetLufs: -14 | -16 | -18 | -23
  preferredAudioLanguage: string | null
  preferredSubtitleLanguage: string | null
  subtitles: 'off' | 'forced' | 'preferred'
  osdTimeoutSeconds: 0 | 3 | 5 | 8 | 10
  pauseBehavior: 'minimal' | 'after-delay' | 'always'
  timeDisplay: 'elapsed-total' | 'elapsed-remaining'
  stillWatchingMinutes: 0 | 60 | 90 | 120
}
export interface PlayerAccessibilityPreferences { reducedMotion: 'system' | 'on' | 'off'; highContrast: boolean; textScale: 1 | 1.15 | 1.3 }
export interface PlayerAppearancePreferences {
  accentColor: string
  artworkBlur: 0 | 8 | 16 | 24 | 32
  dialogTint: 'neutral' | 'artwork'
  backdropCycleSeconds: 0 | 10 | 20 | 30
}
export interface PlayerDetailPreferences {
  rows: PlayerDetailRow[]
  ratingSlots: PlayerRatingProvider[]
  primaryActions: PlayerDetailAction[]
}

export interface PlayerPreferencesV5 {
  schemaVersion: 5
  preset: PlayerPreset
  navigation: PlayerNavigationPreferences
  home: PlayerHomePreferences
  libraries: PlayerLibraryPreferences
  browsing: PlayerBrowsePreferences
  playback: PlayerPlaybackPreferences
  appearance: PlayerAppearancePreferences
  details: PlayerDetailPreferences
  accessibility: PlayerAccessibilityPreferences
  migration: { legacyLocalStorageImported: boolean }
}

/** Retained as source-compatible aliases for Player extensions. */
export type PlayerPreferencesV4 = PlayerPreferencesV5
export type PlayerPreferencesV3 = PlayerPreferencesV5
export type PlayerPreferencesV2 = PlayerPreferencesV5
export type PlayerPreferencesV1 = PlayerPreferencesV5
export interface PlayerPreferencesEnvelope { profileId: string; revision: number; updatedAt: string; preferences: PlayerPreferencesV5 }
export interface UpdatePlayerPreferencesRequest { profileId: string; expectedRevision: number; preferences: PlayerPreferencesV5 }
export interface ResetPlayerPreferencesRequest { profileId: string; expectedRevision: number }

export interface PlayerFeatureFlags { uiV2Enabled: boolean; telemetryEnabled: boolean }
export interface PlayerPublicConfiguration { defaultPreset: PlayerPreset; maxWidgetItems: number }

export interface PlayerMediaCard {
  key: string
  mediaType: PlayerMediaType
  id: number | string
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
  acquisition?: {
    kind: 'film' | 'series' | 'season' | 'episode' | 'other'
    status: string
    percent: number
    downloadSpeed: number
    etaSeconds: number | null
  } | null
}

export interface PlayerHubCategory { id: string; label: string; active: boolean }
export interface PlayerWidget {
  id: string
  title: string
  source: PlayerWidgetSource
  view: PlayerView
  sort: PlayerWidgetSort
  sortOrder: PlayerSortOrder
  autoscrollSeconds: PlayerAutoscrollInterval
  items: PlayerMediaCard[]
  nextCursor: string | null
  total: number
  showMoreRoute: string | null
}

export interface PlayerBrowseFacets {
  genres: string[]
  studios: string[]
  yearMin: number | null
  yearMax: number | null
}

export interface PlayerBrowsePage {
  mediaType: PlayerFilterableContentType
  title: string
  items: PlayerMediaCard[]
  total: number
  nextCursor: string | null
  facets: PlayerBrowseFacets
  filters: PlayerBrowseFilter
  sort: Exclude<PlayerWidgetSort, 'source'>
  sortOrder: PlayerSortOrder
}
export interface PlayerHub {
  id: PlayerHubId
  title: string
  icon: string
  layout: PlayerHubLayout
  showSpotlight: boolean
  categories: PlayerHubCategory[]
  spotlight: PlayerMediaCard | null
  widgets: PlayerWidget[]
}

export interface PlayerBootstrap {
  server: ServerHealth
  featureFlags: PlayerFeatureFlags
  configuration: PlayerPublicConfiguration
  preferences: PlayerPreferencesEnvelope
  libraries: PlayerLibrary[]
  progress: PlaybackProgress[]
  initialHub: PlayerHub
}

export interface PlayerSearchGroups { films: FilmSummary[]; series: SeriesSummary[]; episodes: EpisodeSummary[]; collections: PlayerMediaCard[] }

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
