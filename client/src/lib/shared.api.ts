import { request } from './api.js'

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

export type TierMediaType = 'films' | 'series' | 'music' | 'games' | 'comics'
export interface TierTerm { term: string; mediaTypes: TierMediaType[] }
export interface TierConfig { tier1: TierTerm[]; tier2: TierTerm[]; tier3: TierTerm[] }

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
    getAcquisitionDefaults: (tabId?: number) => request<AcquisitionDefaults>('/settings/acquisition-defaults', tabId ? { headers: { 'x-tab-context': tabId.toString() } } : undefined),
    setAcquisitionDefaults: (data: AcquisitionDefaults, tabId?: number) => request<AcquisitionDefaults>('/settings/acquisition-defaults', { method: 'PUT', body: JSON.stringify(data), headers: tabId ? { 'x-tab-context': tabId.toString() } : undefined }),
    getTrackCleaner: () => request<TrackCleanerConfig>('/settings/track-cleaner'),
    setTrackCleaner: (data: TrackCleanerConfig) => request<TrackCleanerConfig>('/settings/track-cleaner', { method: 'PUT', body: JSON.stringify(data) }),
    getTrackCleanerStatus: () => request<{ available: boolean; version: string }>('/settings/track-cleaner/status'),
    getSubtitles: () => request<SubtitleConfig>('/settings/subtitles'),
    setSubtitles: (data: SubtitleConfig) => request<SubtitleConfig>('/settings/subtitles', { method: 'PUT', body: JSON.stringify(data) }),
    getMediaBaseDir: () => request<{ path: string }>('/settings/media-base-dir'),
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
      removeAudio?: number[]
      removeSubtitles?: number[]
    }) =>
      request<{ success: boolean; message: string; chapters: number }>(
        '/media/file-metadata', { method: 'PUT', body: JSON.stringify({ filePath, ...edits }) }
      ),
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
  },
}
