// ─── Torrent state machine ────────────────────────────────────────────────────

export type TorrentStatus =
  | 'stopped'
  | 'queued-check'
  | 'checking'
  | 'fetching-metadata'
  | 'queued-download'
  | 'downloading'
  | 'queued-seed'
  | 'seeding'
  | 'error';

export type TorrentPriority = 'low' | 'normal' | 'high';
export type FilePriority = 'skip' | 'low' | 'normal' | 'high';
export type EncryptionMode = 'preferred' | 'required' | 'allowed';
export type PreallocationMode = 'none' | 'fast' | 'full';
export type AddedVia = 'file' | 'magnet' | 'url' | 'watch-dir';

// ─── Core torrent object ──────────────────────────────────────────────────────

export interface Torrent {
  // Identity
  id: string;                       // internal UUID
  infoHash: string;                 // 40-char hex SHA1
  name: string;
  comment: string;
  creator: string;
  createdAt: number;                // unix ms — when torrent was created (from metadata)
  addedAt: number;                  // unix ms — when added to session
  isPrivate: boolean;               // private flag in info dict

  // Status
  status: TorrentStatus;
  error: string | null;
  errorCode: number | null;

  // Progress
  sizeBytes: number;                // total size of all selected files
  downloadedBytes: number;          // bytes verified on disk
  uploadedBytes: number;            // total bytes sent to peers this session
  corruptBytes: number;             // bytes discarded due to hash failure
  leftBytes: number;                // bytes remaining
  progress: number;                 // 0.0 – 1.0
  recheckProgress: number;          // 0.0 – 1.0 during verify
  pieceCount: number;
  pieceSize: number;
  pieces: string | null;            // base64 bitfield — null when complete

  // Speeds
  downloadSpeed: number;            // bytes/sec
  uploadSpeed: number;              // bytes/sec
  eta: number;                      // seconds remaining, -1 = unknown

  // Peers & trackers
  peersConnected: number;
  peersGettingFromUs: number;
  peersSendingToUs: number;
  peersSeen: number;
  seedsConnected: number;
  webSeedsPendingCount: number;
  stalledReason?: string | null;

  // Ratio
  uploadRatio: number;              // uploadedBytes / downloadedBytes
  seedRatioLimit: number;           // -1 = use session default, 0 = unlimited
  seedRatioMode: 0 | 1 | 2;        // 0=global, 1=single, 2=unlimited
  seedIdleLimit: number;            // minutes, -1 = use session default
  seedIdleMode: 0 | 1 | 2;

  // Paths
  downloadDir: string;
  incompleteDir: string | null;
  magnetLink: string | null;
  torrentFile: string | null;       // path to .torrent on disk
  addedVia: AddedVia;

  // Queue
  queuePosition: number;
  bandwidthPriority: TorrentPriority;
  downloadLimit: number;            // kB/s, -1 = unlimited
  downloadLimitEnabled: boolean;
  uploadLimit: number;              // kB/s, -1 = unlimited
  uploadLimitEnabled: boolean;
  sequentialDownload: boolean;
  honorsSessionLimits: boolean;

  // Dates
  startedAt: number | null;         // unix ms
  activityAt: number | null;        // unix ms — last data transfer
  completedAt: number | null;       // unix ms

  // Labels / groups
  labels: string[];
  group: string | null;             // bandwidth group name

  // Files, trackers, peers — returned separately by detailed endpoint
  files?: TorrentFile[];
  trackers?: TrackerInfo[];
  peers?: PeerInfo[];
  webSeeds?: WebSeed[];
  diagnostics?: TorrentDiagnostics | null;
}

// ─── Torrent file ─────────────────────────────────────────────────────────────

export interface TorrentFile {
  index: number;
  name: string;                     // relative path within torrent
  sizeBytes: number;
  downloadedBytes: number;
  progress: number;                 // 0.0 – 1.0
  priority: FilePriority;
  wanted: boolean;
}

// ─── Tracker ──────────────────────────────────────────────────────────────────

export type TrackerTier = 0 | 1 | 2 | 3;

export interface TrackerInfo {
  id: number;
  announce: string;
  scrape: string;
  sitename: string;
  tier: TrackerTier;

  // Last announce
  lastAnnounceTime: number;
  lastAnnounceSucceeded: boolean;
  lastAnnounceResult: string;
  lastAnnouncePeerCount: number;

  // Next announce
  nextAnnounceTime: number;
  isAnnouncing: boolean;

  // Last scrape
  lastScrapeTime: number;
  lastScrapeSucceeded: boolean;
  lastScrapeResult: string;
  isScraping: boolean;
  nextScrapeTime: number;

  // Counts from tracker
  seederCount: number;
  leecherCount: number;
  downloadCount: number;

  healthScore?: number;
  failureCategory?: string | null;
  augmented?: boolean;
}

// ─── Peer ─────────────────────────────────────────────────────────────────────

export interface PeerInfo {
  address: string;
  port: number;
  clientName: string;
  progress: number;

  // Speeds
  rateToPeer: number;               // bytes/sec upload to peer
  rateToClient: number;             // bytes/sec download from peer

  // Flags
  isEncrypted: boolean;
  isUtp: boolean;
  isIncoming: boolean;
  isDownloadingFrom: boolean;
  isUploadingTo: boolean;
  isChoked: boolean;
  isPeerChoked: boolean;
  isInterested: boolean;
  isPeerInterested: boolean;
  hasNeededPieces?: boolean;
  chokedForMs?: number;
  usefulBlocks?: number;
  relation?: 'useful' | 'ready' | 'choked' | 'no-needed-pieces';

  // Source
  source: 'tracker' | 'dht' | 'pex' | 'lpd' | 'incoming';

  flagStr: string;                  // Transmission-style peer flags string
}

export interface TorrentDiagnostics {
  connected: number;
  connecting: number;
  known: number;
  seen: number;
  failed: number;
  connectionAttempts: number;
  recentCloseReasons: Record<string, number>;
  failureBuckets?: Record<string, number>;
  peerStates?: Record<string, number>;
  peerSources?: Record<string, {
    discovered: number;
    connecting: number;
    connected: number;
    failed: number;
    useful: number;
  }>;
  recentFailures?: Array<{
    peer: string;
    source: PeerInfo['source'];
    reason: string;
    bucket: string;
    failures: number;
    lastFailedAt: number;
    retryAfter: number;
  }>;
  availability?: {
    explanation: string;
    hasConnectedSeed: boolean;
    peersWithNeededPieces: number;
    peersWithUsefulBlocks: number;
    chokedByPeers: number;
    longestChokedMs: number;
  };
  requests?: {
    endGame: boolean;
    missingPieces: number;
    partialPieces: number;
    outstandingBlocks: number;
    staleBlocks: number;
    duplicateOutstandingBlocks: number;
  };
}

// ─── Web seeds ────────────────────────────────────────────────────────────────

export interface WebSeed {
  url: string;
  downloadSpeed: number;
}

// ─── Torrent add options ──────────────────────────────────────────────────────

export interface AddTorrentOptions {
  // One of these is required:
  torrentFile?: Buffer;             // raw .torrent bytes
  magnetLink?: string;
  torrentUrl?: string;

  downloadDir?: string;
  incompleteDir?: string;
  paused?: boolean;                 // start paused
  priority?: TorrentPriority;
  labels?: string[];
  bandwidthGroup?: string;
  sequentialDownload?: boolean;
  filePriorities?: FilePriority[];  // per-file, indexed by file order
  wantedFiles?: boolean[];          // per-file wanted flags
  seedRatioLimit?: number;
  seedIdleLimit?: number;
  addedVia?: AddedVia;
}
