import { BASE, getTabContext, request, requestWithTab } from './api.js'

export interface Indexer {
  id: number; definitionId: string; name: string; enabled: boolean
  baseUrl: string; apiKey?: string; username?: string; password?: string
  categories: string[]; priority: number; tags: string[]; useFlareSolverr: boolean
}

export interface IndexerSchema {
  id: string; name: string; description?: string
  type: string; language: string; urls: string[]
}

export interface DownloadClient {
  id: number; name: string; type: string; host: string; port: number
  useSsl: boolean; urlBase: string; username?: string; password?: string
  category: string; enabled: boolean; priority: number
}

export interface QualityProfile {
  id: number; name: string; upgradeAllowed: boolean; cutoff: string
  minFormatScore: number; items: string[]
}

export interface RootFolder {
  id: number; path: string; freeSpace: number; totalSpace: number; accessible: boolean
}

export interface FlareSolverrConfig {
  url: string; enabled: boolean
}

export interface SegmentSettings {
  enabled: boolean
  concurrency: number
  introWindowSeconds: number
  creditsWindowSeconds: number
  minimumMatchSeconds: number
  confidenceThreshold: number
  maxAttempts: number
  preferredLanguage: string
  seasonSupportRatio: number
  refineWithSilence: boolean
  refineWithBlackFrames: boolean
}

export interface SegmentStatus {
  settings: SegmentSettings
  queue: {
    enabled: boolean
    concurrency: number
    queued: number
    active: number
    activeKeys: string[]
    tools: { checkedAt: number; fpcalc: boolean; fpcalcVersion: string | null; ffmpeg: boolean }
    database: {
      states: Record<string, number>; links: number; fingerprints: number; fingerprintBytes: number
      results: Array<{
        episodeId: number; seriesId: number; seriesTitle: string; seasonNumber: number; episodeNumber: number; episodeTitle: string | null
        state: string; attempts: number; lastError: string | null; analysedAt: string | null; fingerprintCount: number
        introStart: number | null; introEnd: number | null; introMethod: string | null; introConfidence: number | null
        creditsStart: number | null; creditsEnd: number | null; creditsMethod: string | null; creditsConfidence: number | null
        audioStreamIndex: number | null; audioLanguage: string | null; audioTitle: string | null
        audioCodec: string | null; audioChannels: number | null; manuallyLocked: number
        analysisEvidence: string | null
      }>
    }
  }
}

export type TierMediaType = 'films' | 'series' | 'music' | 'games' | 'comics'
export interface TierTerm { term: string; mediaTypes: TierMediaType[] }
export interface TierConfig { tier1: TierTerm[]; tier2: TierTerm[]; tier3: TierTerm[] }
export interface RejectRules { terms: string[]; minResolution?: string | null }

export interface ApiKeysConfig {
  tmdbApiKey: string
  tvdbApiKey: string
  tvdbPin: string
  googleBooksApiKey: string
  comicvineApiKey: string
  igdbClientId: string
  igdbClientSecret: string
  fanartApiKey: string
}

export interface AcquisitionDefaults {
  tier: string
  resolution: string
  source: string
  codec: string
  /** Max missing items processed per library per missing-search pass. */
  missingSearchBatchSize?: number
}

export type ListImportSourceType = 'sonarr' | 'radarr' | 'trakt' | 'mdblist'

export interface ListImportSource {
  id: string
  name: string
  type: ListImportSourceType
  url: string
  credentialSet: boolean
  createdAt: string
  updatedAt: string
}

export interface ListImportDetection {
  type: 'sonarr' | 'radarr'
  name: string
  url: string
  detected: boolean
  status: number | null
  latencyMs: number
  alreadyConfigured: boolean
}

export interface ListImportItem {
  id: string
  mediaType: 'films' | 'series'
  title: string
  year: number | null
  tmdbId: number | null
  tvdbId: number | null
  imdbId: string | null
  monitored: boolean | null
  alreadyAdded: boolean
  importable: boolean
}

// ── Video Optimisation Engine ────────────────────────────────────────────────
export type ProcessingVideoCodec = 'h264' | 'hevc' | 'av1' | 'vc1' | 'mpeg2video' | 'vp9' | 'h266'
export interface VideoPolicy {
  convertCodecs: ProcessingVideoCodec[]
  skipCodecs: ProcessingVideoCodec[]
  targetCodec: ProcessingVideoCodec
  qualityMode: 'constant_quality' | 'target_bitrate'
  crf: number
  preserve: { resolution: boolean; hdr: boolean; dolbyVision: boolean; frameRate: boolean; chapters: boolean }
  minimumSavingPercent: number
  minimumSavingGb: number
}
export interface AudioPolicy {
  enabled: boolean
  targetCodec: 'aac' | 'opus' | 'ac3' | 'eac3' | 'flac'
  stereoBitrateKbps: number
  keepCodecs: string[]
  preserveLossless: boolean
}
export interface OptimisationPolicy {
  name: string
  description: string
  video: VideoPolicy
  audio: AudioPolicy
}
export interface StoredPolicy { presetId: string; policy: OptimisationPolicy }
export interface ProcessingPreset extends OptimisationPolicy { id: string }

export type RecommendationAction = 'convert' | 'remux' | 'keep' | 'skip'
export interface ProcessingRecommendation {
  action: RecommendationAction
  targetCodec: ProcessingVideoCodec | null
  currentSizeBytes: number
  predictedSizeBytes: number | null
  estimatedSavingBytes: number | null
  estimatedSavingPercent: number | null
  quality: string
  reason: string
  notes: string[]
}
export interface ProcessingScanItem {
  kind: 'film' | 'episode'
  id: number
  title: string
  path: string
  sizeBytes: number
  codec: string | null
  resolution: string | null
  hdr: string | null
  recommendation: ProcessingRecommendation
}
// ── Search Missing (scheduled backlog) ───────────────────────────────────────
export interface SearchMissingWindow { id: string; enabled: boolean; time: string; itemsPerRun: number | null }
export interface SearchMissingDaySchedule { dayOfWeek: string; enabled: boolean; windows: SearchMissingWindow[] }
export interface SearchMissingSettings {
  enabled: boolean
  recentReleaseExclusionHours: number
  defaultItemsPerRun: number
  maximumItemsPerRun: number
  timezone: string
  selectionStrategy: 'oldest_search_first' | 'oldest_release_first' | 'highest_priority' | 'random' | 'balanced_by_media_type'
  itemCooldownHours: number
  allowManualRun: boolean
  manualRunBypassesCooldown: boolean
  scheduleGraceMinutes: number
  schedule: SearchMissingDaySchedule[]
}
export interface SearchMissingResponse { settings: SearchMissingSettings; nextRun: string | null; eligibleBacklog: number }
export interface ReleaseMonitoringSettings {
  pollIntervalMinutes: number
  rapidPollingEnabled: boolean
  rapidStartDelayMinutes: number
  rapidPollIntervalMinutes: number
  rapidWindowAfterAirHours: number
  targetedSearchIntervalMinutes: number
  targetedSearchWindowHours: number
  imminentRefreshWithinMinutes: number
}
export interface MonitoringResponse { settings: ReleaseMonitoringSettings; rapidActive: boolean }
export interface FeedIndexer {
  id: string; name: string; enabled: boolean; rssEnabled?: boolean; health: string; mode: string; inFlight: boolean
  lastPolledAt: number | null; lastSuccessAt: number | null; lastFailureAt: number | null
  lastReleasesFound: number; lastReleasesGrabbed: number; consecutiveFailures: number
  backoffUntil: number | null; nextPollAt: number; pollIntervalMs: number; lastError: string | null
}
export interface FeedStatus {
  summary: { total: number; healthy: number; degraded: number; unhealthy: number; rapidActive: boolean }
  indexers: FeedIndexer[]
}
export interface AcquisitionDecision {
  id: number; created_at: string; media_type: string; subject_type: string; subject_id: string
  release_guid: string | null; release_title: string; accepted: number; score: number
  reasons: string; rejection_reasons: string; grabbed: number
}
export interface ScheduleRun {
  id: number
  schedule_window_id: string
  scheduled_local_date: string
  scheduled_local_time: string
  status: string
  requested_item_limit: number
  selected_item_count: number
  searched_item_count: number
  accepted_release_count: number
  started_at: number | null
  completed_at: number | null
  error: string | null
}

export type Accelerator = 'nvenc' | 'qsv' | 'vaapi' | 'videotoolbox' | 'amf' | 'software'
export interface ExecutionConfig {
  hwAccel: 'auto' | 'off' | Accelerator
  workerConcurrency: number
  quarantineRetentionDays: number
  paused: boolean
  encodeWindow: { enabled: boolean; startHour: number; endHour: number }
  vmaf: { enabled: boolean; minScore: number }
}
export interface ExecutionResponse {
  config: ExecutionConfig
  hardware: { available: Accelerator[]; compiledEncoders: string[]; gpus?: { vendor: string; node: string | null }[]; note?: string | null }
  vmafAvailable: boolean
}
export interface SystemStats {
  cpuPercent: number
  cpuCount: number
  memPercent: number
  loadAvg1: number
  gpuPercent: number | null
  encoding: number
  queued: number
  aggregateSpeed: number
}

export type JobStatus = 'queued' | 'encoding' | 'validating' | 'replacing' | 'complete' | 'failed' | 'cancelled'
export interface OptimiseJob {
  id: string
  kind: 'film' | 'episode' | 'path'
  itemId: number | null
  action: 'remux' | 'convert'
  title: string
  status: JobStatus
  progress: number
  suspended: boolean
  audioEncoding: boolean
  speed: number | null
  encoder: string | null
  accelerator: string | null
  priority: number
  vmaf: number | null
  sizeBefore: number | null
  sizeAfter: number | null
  error?: string
  validation?: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }
}

export type ProcessingNodeId = 'segments' | 'loudness' | 'video' | 'audio' | 'track-cleaning'
export interface ProcessingMonitorItem {
  id: string
  title: string
  status: 'queued' | 'running' | 'paused' | 'validating' | 'replacing'
  progress: number | null
  process: string
  detail: string
  etaSeconds: number | null
  queuePosition: number | null
  speed?: number | null
  startedAt?: number | null
  completed?: number
  total?: number
  canPause: boolean
  canCancel: boolean
  canSkip: boolean
}
export interface ProcessingMonitorNode {
  id: ProcessingNodeId
  label: string
  description: string
  state: 'idle' | 'running' | 'paused'
  paused: boolean
  pauseBehavior: 'immediate' | 'after-current' | 'shared'
  concurrency: number
  activeCount: number
  queuedCount: number
  activeItems: ProcessingMonitorItem[]
  queuedItems: ProcessingMonitorItem[]
  sharedWith?: ProcessingNodeId
}
export interface ProcessingMonitorStatus {
  generatedAt: number
  summary: { active: number; queued: number; paused: number; resources: SystemStats }
  nodes: ProcessingMonitorNode[]
}
export interface QuarantineEntry {
  id: string
  jobId: string
  title: string
  originalPath: string
  sizeBytes: number
  quarantinedAt: number
  deleteAfter: number
}
export interface ProcessingScanState {
  status: 'idle' | 'scanning' | 'complete' | 'error'
  scanned: number
  total: number
  startedAt: number | null
  finishedAt: number | null
  aggregate: {
    libraryBytes: number
    optimisableBytes: number
    estimatedSavingBytes: number
    counts: Record<RecommendationAction, number>
    filesAnalysed: number
    filesFailed: number
  }
  items: ProcessingScanItem[]
  error?: string
}

export interface TrackCleanerConfig {
  enabled: boolean
  preferredLanguage: string
  keepOriginalLanguage: boolean
  keepPreferredAudio: boolean
  keepPreferredSubs: boolean
  keepCommentary: boolean
  additionalLanguages: string[]
}

export interface SubtitleConfig {
  enabled: boolean
  provider: string
  apiKey: string
  appName: string
  username: string
  password: string
  defaultLanguage: string
  autoAcquire: boolean
  hearingImpaired: boolean
  forcedOnly: boolean
}

export interface SubtitleSearchResult {
  id: string
  fileName: string
  language: string
  downloadCount: number
  hearingImpaired: boolean
  foreignPartsOnly: boolean
  rating: number
  uploadDate: string
  fileId: number
  featureDetails?: {
    title?: string
    year?: number
    episodeNumber?: number
    seasonNumber?: number
  }
}

export interface SystemDbStatus {
  path: string
  open: boolean
  exists: boolean
  wal: boolean
  shm: boolean
  pageCount?: number
  pageSize?: number
  databaseBytes?: number
  walBytes?: number
  shmBytes?: number
  error?: string
}

export interface SystemOverview {
  generatedAt: string
  jobs: {
    byStatus: Record<string, number>
    byType: Record<string, number>
    failed: Array<{ id: number; type: string; subjectType?: string; subjectId?: string; attempts: number; maxAttempts: number; lastError?: string; updatedAt: string }>
  }
  events: {
    bySeverity: Record<string, number>
    recentProblems: Array<{ id: number; ts: string; category: string; action: string; severity: string; subjectType?: string; subjectId?: string; message: string }>
  }
  imports: {
    byStatus: Record<string, number>
    byMediaType: Record<string, number>
  }
  acquisitions: {
    byAccepted: Record<string, number>
    grabbed: Record<string, number>
  }
  torrents: {
    available: boolean
    total: number
    downloading: number
    seeding: number
    queued: number
    stalled: number
    downloadSpeed: number
    uploadSpeed: number
  }
  integrity: {
    total: number
    bySeverity: Record<'info' | 'warn' | 'error', number>
    byCategory: Record<string, number>
  }
  databases: Array<{ scope: string; id?: number; name: string; mediaType: string; dbPath: string; status: SystemDbStatus }>
  openConnections: string[]
  maintenance: {
    config: MaintenanceConfig
    lastResult: MaintenanceResult | null
  }
  integrityStatus: {
    config: IntegrityConfig
    lastReport: IntegrityReport | null
  }
  backups: {
    config: BackupConfig
    lastBackup: BackupManifest | null
    backups: BackupManifest[]
  }
}

export interface IntegrityProblem {
  id: string
  severity: 'info' | 'warn' | 'error'
  category: string
  scope: 'system' | 'tab' | 'download' | 'import'
  message: string
  tabId?: number
  tabName?: string
  mediaType?: string
  subjectType?: string
  subjectId?: string
  title?: string
  path?: string
  action?: string
}

export interface IntegrityReport {
  generatedAt: string
  summary: {
    total: number
    bySeverity: Record<'info' | 'warn' | 'error', number>
    byCategory: Record<string, number>
  }
  problems: IntegrityProblem[]
}

export interface IntegrityRepairResult {
  success: boolean
  action: string
  message: string
  changes: number
  backupId?: string
}

export interface BulkIntegrityRepairResult {
  requested: number
  repaired: number
  skipped: number
  changes: number
  results: IntegrityRepairResult[]
}

export interface IntegrityConfig {
  enabled: boolean
  intervalHours: number
  recordCleanScans: boolean
  backupBeforeRepair: boolean
}

export interface MaintenanceConfig {
  enabled: boolean
  intervalHours: number
  jobRetentionDays: number
  eventRetentionDays: number
  importRetentionDays: number
  acquisitionRetentionDays: number
  staleRunningJobMinutes: number
  checkpointDatabases: boolean
}

export interface MaintenanceResult {
  startedAt: string
  finishedAt: string
  recoveredJobs: number
  deletedJobs: number
  deletedEvents: number
  deletedImports: number
  deletedAcquisitionDecisions: number
  checkpointedDatabases: Array<{ path: string; ok: boolean; error?: string }>
}

export interface BackupConfig {
  enabled: boolean
  intervalHours: number
  retentionCount: number
  includeTorrentState: boolean
}

export interface BackupManifest {
  id: string
  createdAt: string
  appVersion: string
  backupPath: string
  files: Array<{ role: string; source: string; path: string; bytes: number }>
}

export interface SystemJob {
  id: number
  type: string
  status: string
  subjectType: string | null
  subjectId: string | null
  attempts: number
  maxAttempts: number
  payload: string
  lastError: string | null
  availableAt: string
  lockedAt: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SystemEvent {
  id: number
  ts: string
  category: string
  action: string
  severity: string
  subjectType: string | null
  subjectId: string | null
  message: string
  data: string
}

export interface ManualImportCandidate {
  tabId: number
  tabName: string
  mediaType: string
  itemId: number
  title: string
  subtitle?: string
  status?: string
  score: number
}

export interface ManualImportItem {
  sourcePath: string
  name: string
  size: number | null
  modifiedAt: string
  candidates: ManualImportCandidate[]
}

export interface ImportPlan {
  status: 'ready' | 'needs-review' | 'blocked'
  mediaType: string
  itemId: number
  sourcePath: string
  summary: string
  files: Array<{ path: string; name: string; sizeBytes: number; role: string; target?: string | null; reason?: string | null }>
  ignored: Array<{ path: string; name: string; sizeBytes: number; role: string; target?: string | null; reason?: string | null }>
  warnings: string[]
  errors: string[]
}

export interface NetworkDiagnostics {
  web: { host: string; port: number }
  tcp: { host: string; configuredPort: number; boundPort: number | null; listening: boolean; fallback: boolean }
  tracker: { advertisedPort: number; matchesTcp: boolean }
  dht: { configuredPort: number; boundPort: number | null; enabled: boolean; fallback: boolean }
  utp: { configuredPort: number; boundPort: number | null; enabled: boolean; fallback: boolean }
  lpd: { enabled: boolean; multicastPort: number; advertisedPort: number }
  warnings: string[]
}

export const sharedApi = {
  indexers: {
    list:   ()       => request<any[]>('/indexers'),
    schema: ()       => request<any[]>('/indexers/definitions/list'),
    create: (data: any) => request<any>('/indexers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<any>(`/indexers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/indexers/${id}`, { method: 'DELETE' }),
    test:   (id: string) => request<{ success: boolean; message: string; resultCount?: number; duration?: number }>(`/indexers/${id}/test`, { method: 'POST' }),
    testConfig: (data: any) => request<{ success: boolean; message: string; resultCount?: number; duration?: number }>('/indexers/test-config', { method: 'POST', body: JSON.stringify(data) }),
  },
  downloadClients: {
    list:   ()       => request<DownloadClient[]>('/download-clients'),
    create: (data: Partial<DownloadClient>) => request<DownloadClient>('/download-clients', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: Partial<DownloadClient>) => request<DownloadClient>(`/download-clients/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number) => request<void>(`/download-clients/${id}`, { method: 'DELETE' }),
    test:   (data: Partial<DownloadClient>) => request<{ success: boolean; message: string; version?: string }>('/download-clients/test', { method: 'POST', body: JSON.stringify(data) }),
    testById: (id: number) => request<{ success: boolean; message: string }>(`/download-clients/${id}/test`, { method: 'POST' }),
  },
  qualityProfiles: {
    list:   ()       => request<QualityProfile[]>('/quality-profiles'),
    create: (data: Partial<QualityProfile>) => request<QualityProfile>('/quality-profiles', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: Partial<QualityProfile>) => request<QualityProfile>(`/quality-profiles/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number) => request<void>(`/quality-profiles/${id}`, { method: 'DELETE' }),
  },
  rootFolders: {
    list:   (tabId?: number) => request<RootFolder[]>('/root-folders', tabId ? { headers: { 'x-tab-context': tabId.toString() } } : undefined),
    add:    (path: string, tabId?: number) => request<RootFolder>('/root-folders', { method: 'POST', body: JSON.stringify({ path }), headers: tabId ? { 'x-tab-context': tabId.toString() } : undefined }),
    delete: (id: number, tabId?: number) => request<void>(`/root-folders/${id}`, { method: 'DELETE', headers: tabId ? { 'x-tab-context': tabId.toString() } : undefined }),
  },
  settings: {
    getNaming: ()    => request<any>('/settings/naming'),
    setNaming: (data: any) => request<any>('/settings/naming', { method: 'PUT', body: JSON.stringify(data) }),
    getMediaManagement: () => request<any>('/settings/media-management'),
    setMediaManagement: (data: any) => request<any>('/settings/media-management', { method: 'PUT', body: JSON.stringify(data) }),
    getFlareSolverr: () => request<FlareSolverrConfig>('/settings/flaresolverr'),
    setFlareSolverr: (data: FlareSolverrConfig) => request<FlareSolverrConfig>('/settings/flaresolverr', { method: 'PUT', body: JSON.stringify(data) }),
    getApiKeys: () => request<ApiKeysConfig>('/settings/api-keys'),
    setApiKeys: (data: ApiKeysConfig) => request<{ success: boolean }>('/settings/api-keys', { method: 'PUT', body: JSON.stringify(data) }),
    factoryReset: (deleteFiles: boolean) => request<{ success: boolean; restarting: boolean }>('/settings/factory-reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET', deleteFiles }) }),
    getQualityTiers: () => request<TierConfig>('/settings/quality-tiers'),
    setQualityTiers: (data: TierConfig) => request<TierConfig>('/settings/quality-tiers', { method: 'PUT', body: JSON.stringify(data) }),
    getQualityRejects: () => request<RejectRules>('/settings/quality-rejects'),
    setQualityRejects: (data: RejectRules) => request<RejectRules>('/settings/quality-rejects', { method: 'PUT', body: JSON.stringify(data) }),
    getAcquisitionDefaults: (tabId?: number) => request<AcquisitionDefaults>('/settings/acquisition-defaults', tabId ? { headers: { 'x-tab-context': tabId.toString() } } : undefined),
    setAcquisitionDefaults: (data: AcquisitionDefaults, tabId?: number) => request<AcquisitionDefaults>('/settings/acquisition-defaults', { method: 'PUT', body: JSON.stringify(data), headers: tabId ? { 'x-tab-context': tabId.toString() } : undefined }),
    getTrackCleaner: () => request<TrackCleanerConfig>('/settings/track-cleaner'),
    setTrackCleaner: (data: TrackCleanerConfig) => request<TrackCleanerConfig>('/settings/track-cleaner', { method: 'PUT', body: JSON.stringify(data) }),
    getTrackCleanerStatus: () => request<{ available: boolean; version: string }>('/settings/track-cleaner/status'),
    getSubtitles: () => request<SubtitleConfig>('/settings/subtitles'),
    setSubtitles: (data: SubtitleConfig) => request<SubtitleConfig>('/settings/subtitles', { method: 'PUT', body: JSON.stringify(data) }),
    getMediaBaseDir: () => request<{ path: string }>('/settings/media-base-dir'),
  },
  listImports: {
    autodetect: () => request<{ targets: ListImportDetection[]; detected: number }>('/list-imports/autodetect'),
    sources: () => request<{ sources: ListImportSource[] }>('/list-imports/sources'),
    saveSource: (data: { id?: string; name: string; type: ListImportSourceType; url: string; credential?: string }) =>
      request<{ source: ListImportSource }>('/list-imports/sources', { method: 'POST', body: JSON.stringify(data) }),
    deleteSource: (id: string) => request<void>(`/list-imports/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    preview: (id: string, targets: { filmLibraryId?: number; seriesLibraryId?: number }) =>
      request<{ source: ListImportSource; items: ListImportItem[]; total: number }>(`/list-imports/sources/${encodeURIComponent(id)}/preview`, { method: 'POST', body: JSON.stringify(targets) }),
    importItem: (item: ListImportItem, tabId: number) => item.mediaType === 'films'
      ? requestWithTab(tabId, '/films', { method: 'POST', body: JSON.stringify({ tmdbId: item.tmdbId, monitored: true }) })
      : requestWithTab(tabId, '/series', { method: 'POST', body: JSON.stringify({ tvdbId: item.tvdbId ?? undefined, tmdbId: item.tmdbId ?? undefined, monitored: true, monitoredSeasons: 'all' }) }),
  },
  processing: {
    getPresets: () => request<{ defaultPresetId: string; presets: ProcessingPreset[] }>('/processing/presets'),
    getPolicy: () => request<StoredPolicy>('/processing/policy'),
    setPolicy: (data: StoredPolicy) => request<StoredPolicy>('/processing/policy', { method: 'PUT', body: JSON.stringify(data) }),
    analyze: (path: string) => request<{ analysis: any; recommendation: any }>('/processing/analyze', { method: 'POST', body: JSON.stringify({ path }) }),
    startScan: () => request<{ started: boolean; status: string }>('/processing/scan', { method: 'POST' }),
    getScan: () => request<ProcessingScanState>('/processing/scan'),
    enqueueJob: (body: { kind: 'film' | 'episode' | 'path'; itemId?: number; path?: string; action: 'remux' | 'convert'; targetCodec?: string }) =>
      request<OptimiseJob>('/processing/jobs', { method: 'POST', body: JSON.stringify(body) }),
    getJobs: () => request<{ jobs: OptimiseJob[]; quarantine: QuarantineEntry[] }>('/processing/jobs'),
    cancelJob: (id: string) => request<{ cancelled: boolean }>(`/processing/jobs/${id}/cancel`, { method: 'POST' }),
    restoreQuarantine: (id: string) => request<{ restored: boolean }>(`/processing/quarantine/${id}/restore`, { method: 'POST' }),
    getExecution: () => request<ExecutionResponse>('/processing/execution'),
    setExecution: (patch: Partial<ExecutionConfig>) => request<ExecutionResponse>('/processing/execution', { method: 'PUT', body: JSON.stringify(patch) }),
    getStats: () => request<SystemStats>('/processing/stats'),
  },
  searchMissing: {
    getSettings: () => request<SearchMissingResponse>('/release-pipeline/search-missing/settings'),
    setSettings: (patch: Partial<SearchMissingSettings>) => request<SearchMissingResponse>('/release-pipeline/search-missing/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    getRuns: () => request<{ runs: ScheduleRun[] }>('/release-pipeline/search-missing/runs'),
    run: (body: { tabId?: number; itemLimit?: number; includeRecent?: boolean; selectionStrategy?: string }) =>
      request<{ success: boolean; message: string }>('/release-pipeline/search-missing/run', { method: 'POST', body: JSON.stringify(body) }),
    getMonitoring: () => request<MonitoringResponse>('/release-pipeline/monitoring/settings'),
    setMonitoring: (patch: Partial<ReleaseMonitoringSettings>) => request<MonitoringResponse>('/release-pipeline/monitoring/settings', { method: 'PUT', body: JSON.stringify(patch) }),
    getFeedStatus: () => request<FeedStatus>('/release-pipeline/health'),
    getDecisions: (filter = 'all', limit = 100) => request<{ decisions: AcquisitionDecision[] }>(`/release-pipeline/decisions?filter=${filter}&limit=${limit}`),
  },
  media: {
    cleanTracks: (filePath: string, opts?: { originalLanguage?: string; tmdbId?: number }) =>
      request<{ success: boolean; message: string; removedAudio: number; removedSubs: number; originalSize: number; newSize: number }>(
        '/media/clean-tracks', { method: 'POST', body: JSON.stringify({ filePath, ...opts }) }
      ),
    readFileMetadata: (filePath: string) =>
      request<{
        path: string
        durationSeconds: number | null
        chapters: Array<{ number: number; title: string; startTime: number; endTime: number }>
        audioTracks: Array<{ typeIndex: number; language?: string; title?: string; codec?: string; channels?: number }>
        subtitleTracks: Array<{ typeIndex: number; language?: string; title?: string; codec?: string }>
      }>('/media/file-metadata/read', { method: 'POST', body: JSON.stringify({ filePath }) }),
    writeFileMetadata: (filePath: string, edits: {
      chapters?: Array<{ title: string; startTime: number; endTime?: number }>
      audioTitles?: Record<number, string>
      subtitleTitles?: Record<number, string>
      audioLanguages?: Record<number, string>
      subtitleLanguages?: Record<number, string>
      removeAudio?: number[]
      removeSubtitles?: number[]
    }) =>
      request<{ success: boolean; message: string; chapters: number }>(
        '/media/file-metadata', { method: 'PUT', body: JSON.stringify({ filePath, ...edits }) }
      ),
    previewTrack: async (filePath: string, type: 'audio' | 'subtitle', typeIndex: number) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const tabId = getTabContext()
      if (tabId) headers['x-tab-context'] = tabId
      const response = await fetch(`${BASE}/media/file-metadata/preview`, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ filePath, type, typeIndex }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }))
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }
      return {
        blob: await response.blob(),
        startSeconds: Number(response.headers.get('X-Preview-Start') ?? 0),
        durationSeconds: Number(response.headers.get('X-Preview-Duration') ?? 0),
      }
    },
  },
  subtitles: {
    search: (opts: { imdbId?: string; tmdbId?: number; query?: string; language?: string; seasonNumber?: number; episodeNumber?: number }) =>
      request<SubtitleSearchResult[]>('/subtitles/search', { method: 'POST', body: JSON.stringify(opts) }),
    download: (fileId: number, mediaFilePath: string, language?: string) =>
      request<{ success: boolean; message: string; filePath?: string }>('/subtitles/download', { method: 'POST', body: JSON.stringify({ fileId, mediaFilePath, language }) }),
  },
  dashboard: {
    stats: () => request<{
      counts: Record<string, { count: number }>,
      recentlyAdded: Array<{ id: number, tmdbId: number, title: string, year: number, poster_path: string, type: string, added_at: string }>
    }>('/dashboard/stats'),
    calendar: (start: string, end: string) => request<any[]>(`/dashboard/calendar?start=${start}&end=${end}`),
    system: () => request<{
      cpu: { load: number, cores: number },
      memory: { total: number, used: number, free: number },
      storage: Array<{ fs: string, mount: string, size: number, used: number }>
    }>('/dashboard/system'),
  },
  system: {
    runRss: () => request<{ success: boolean }>('/system/rss/run', { method: 'POST' }),
    overview: () => request<SystemOverview>('/system/overview'),
    integrity: () => request<{ config: IntegrityConfig; lastReport: IntegrityReport | null; current: IntegrityReport }>('/system/integrity'),
    setIntegrity: (data: Partial<IntegrityConfig>) => request<{ config: IntegrityConfig }>('/system/integrity', { method: 'PUT', body: JSON.stringify(data) }),
    runIntegrity: () => request<{ report: IntegrityReport }>('/system/integrity/run', { method: 'POST' }),
    repairIntegrity: (problem: IntegrityProblem) =>
      request<{ result: IntegrityRepairResult; backup: BackupManifest | null; integrity: IntegrityReport }>('/system/integrity/repair', { method: 'POST', body: JSON.stringify({ problem }) }),
    repairIntegrityBulk: (problems: IntegrityProblem[]) =>
      request<{ result: BulkIntegrityRepairResult; backup: BackupManifest | null; integrity: IntegrityReport }>('/system/integrity/repair-bulk', { method: 'POST', body: JSON.stringify({ problems }) }),
    jobs: (limit = 100) => request<{ jobs: SystemJob[] }>(`/system/jobs?limit=${limit}`),
    events: (limit = 100) => request<{ events: SystemEvent[] }>(`/system/events?limit=${limit}`),
    mediaImports: (limit = 100) => request<{ imports: any[] }>(`/system/media-imports?limit=${limit}`),
    manualImportCandidates: () => request<{ downloadDir: string; items: ManualImportItem[] }>('/system/manual-imports/candidates'),
    manualImportSearch: (params: { mediaType: string; query: string; sourceName?: string }) =>
      request<{ results: ManualImportCandidate[] }>(`/system/manual-imports/search?mediaType=${encodeURIComponent(params.mediaType)}&query=${encodeURIComponent(params.query)}&sourceName=${encodeURIComponent(params.sourceName ?? params.query)}`),
    queueManualImport: (data: { tabId: number; mediaType: string; itemId: number; sourcePath: string; copy?: boolean; releaseTitle?: string }) =>
      request<{ success: boolean; jobId: number | null }>('/system/manual-imports/queue', { method: 'POST', body: JSON.stringify(data) }),
    torrentAcquisitionMatch: (id: string) =>
      request<{ match: ManualImportCandidate | null }>(`/torrents/${encodeURIComponent(id)}/acquisition-match`),
    setTorrentAcquisitionMatch: (id: string, data: ManualImportCandidate) =>
      request<{ match: ManualImportCandidate }>(`/torrents/${encodeURIComponent(id)}/acquisition-match`, { method: 'PUT', body: JSON.stringify(data) }),
    torrentImportPlan: (id: string) =>
      request<{ plan: ImportPlan | null }>(`/torrents/${encodeURIComponent(id)}/import-plan`),
    torrentNetwork: () => request<NetworkDiagnostics | null>('/torrents/network'),
    acquisitionDecisions: (limit = 100) => request<{ decisions: any[] }>(`/system/acquisition-decisions?limit=${limit}`),
    releaseBlocklist: (limit = 100) => request<{ blocks: any[] }>(`/system/release-blocklist?limit=${limit}`),
    unblockRelease: (id: number) => request<{ success: boolean }>(`/system/release-blocklist/${id}`, { method: 'DELETE' }),
    db: () => request<{ shared: SystemDbStatus; tabs: Array<{ id: number; name: string; mediaType: string; dbPath: string; status: SystemDbStatus }>; openConnections: string[] }>('/system/db'),
    checkpointDb: () => request<{ results: Array<{ path: string; ok: boolean; status?: SystemDbStatus; error?: string }> }>('/system/db/checkpoint', { method: 'POST' }),
    maintenance: () => request<{ config: MaintenanceConfig; lastResult: MaintenanceResult | null }>('/system/maintenance'),
    setMaintenance: (data: Partial<MaintenanceConfig>) => request<{ config: MaintenanceConfig }>('/system/maintenance', { method: 'PUT', body: JSON.stringify(data) }),
    runMaintenance: () => request<{ result: MaintenanceResult }>('/system/maintenance/run', { method: 'POST' }),
    backups: () => request<{ config: BackupConfig; lastBackup: BackupManifest | null; backups: BackupManifest[] }>('/system/backups'),
    setBackups: (data: Partial<BackupConfig>) => request<{ config: BackupConfig }>('/system/backups', { method: 'PUT', body: JSON.stringify(data) }),
    runBackup: () => request<{ backup: BackupManifest }>('/system/backups/run', { method: 'POST' }),
    cancelJob: (id: number) => request<{ success: boolean }>(`/system/jobs/${id}/cancel`, { method: 'POST' }),
    retryJob: (id: number) => request<{ success: boolean }>(`/system/jobs/${id}/retry`, { method: 'POST' }),
    segments: () => request<SegmentStatus>('/system/segments/status'),
    setSegments: (data: Partial<SegmentSettings>) => request<{ settings: SegmentSettings }>('/system/segments/settings', { method: 'PUT', body: JSON.stringify(data) }),
    seasonSegmentSettings: (seriesId: number, seasonNumber: number) => request<{ settings: SegmentSettings }>(`/system/segments/seasons/${seriesId}/${seasonNumber}/settings`),
    setSeasonSegmentSettings: (seriesId: number, seasonNumber: number, data: Partial<SegmentSettings> | { inherit: true }) => request<{ settings: SegmentSettings }>(`/system/segments/seasons/${seriesId}/${seasonNumber}/settings`, { method: 'PUT', body: JSON.stringify(data) }),
    analyseSegments: (data: { seriesId?: number; seasonNumber?: number } = {}) => request<{ enqueued: number; key?: string }>('/system/segments/analyse', { method: 'POST', body: JSON.stringify(data) }),
    cancelSegments: (key?: string) => request<{ cancelled: number }>('/system/segments/cancel', { method: 'POST', body: JSON.stringify({ key }) }),
    updateEpisodeSegments: (episodeId: number, data: { introStart?: number | null; introEnd?: number | null; creditsStart?: number | null; creditsEnd?: number | null; locked?: boolean }) =>
      request<{ success: boolean }>(`/system/segments/episodes/${episodeId}`, { method: 'PUT', body: JSON.stringify(data) }),
    reanalyseEpisodeSegments: (episodeId: number) =>
      request<{ enqueued: number; key: string }>(`/system/segments/episodes/${episodeId}/reanalyse`, { method: 'POST' }),
    processingMonitor: () => request<ProcessingMonitorStatus>('/system/processing-monitor'),
    setProcessingNodePaused: (nodeId: ProcessingNodeId, paused: boolean) =>
      request<{ paused: boolean }>(`/system/processing-monitor/${encodeURIComponent(nodeId)}/pause`, { method: 'PUT', body: JSON.stringify({ paused }) }),
    controlProcessingItem: (nodeId: ProcessingNodeId, itemId: string, action: 'pause' | 'resume' | 'cancel' | 'skip') =>
      request<{ success: boolean }>(`/system/processing-monitor/${encodeURIComponent(nodeId)}/items/${encodeURIComponent(itemId)}/${action}`, { method: 'POST' }),
  },
}
