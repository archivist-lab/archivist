import type { EncryptionMode, PreallocationMode, TorrentPriority } from './torrent.js';

// ─── Session settings ─────────────────────────────────────────────────────────

export interface SessionSettings {
  // Download
  downloadDir: string;
  incompleteDir: string;
  incompleteDirEnabled: boolean;
  startAddedTorrents: boolean;
  trashOriginalTorrentFiles: boolean;
  renamePartialFiles: boolean;
  preallocation: PreallocationMode;
  cacheSize: number;                // MiB
  defaultLabels: string[];

  // Watch directory
  watchDir: string;
  watchDirEnabled: boolean;

  // Speed limits
  speedLimitDown: number;           // kB/s
  speedLimitDownEnabled: boolean;
  speedLimitUp: number;             // kB/s
  speedLimitUpEnabled: boolean;

  // Alt (turtle) speed limits
  altSpeedDown: number;             // kB/s
  altSpeedUp: number;               // kB/s
  altSpeedEnabled: boolean;         // currently active
  altSpeedTimeEnabled: boolean;     // scheduler active
  altSpeedTimeBegin: number;        // minutes from midnight
  altSpeedTimeEnd: number;          // minutes from midnight
  altSpeedTimeDays: number;         // bitfield: Sun=1 Mon=2 Tue=4 Wed=8 Thu=16 Fri=32 Sat=64

  // Queue
  downloadQueueEnabled: boolean;
  downloadQueueSize: number;
  seedQueueEnabled: boolean;
  seedQueueSize: number;
  queueStalledEnabled: boolean;
  queueStalledMinutes: number;

  // Seeding
  seedRatioLimit: number;
  seedRatioLimited: boolean;
  idleSeedingLimit: number;         // minutes
  idleSeedingLimitEnabled: boolean;

  // Peers
	  peerLimitGlobal: number;
	  peerLimitPerTorrent: number;
	  peerPort: number;
	  peerHost: string;
	  advertisedPeerPort: number;
	  dhtPort: number;
	  utpPort: number;
	  peerPortRandomOnStart: boolean;
  portForwardingEnabled: boolean;
  encryption: EncryptionMode;

  // Protocol
  dhtEnabled: boolean;
  pexEnabled: boolean;
  lpdEnabled: boolean;
  utpEnabled: boolean;
  defaultPriority: TorrentPriority;
  sequentialDownloadDefault: boolean;

  // Blocklist
  blocklistEnabled: boolean;
  blocklistUrl: string;

  // Proxy
  proxyUrl: string | null;

  // Scripts
  scriptTorrentAddedEnabled: boolean;
  scriptTorrentAddedFilename: string;
  scriptTorrentDoneEnabled: boolean;
  scriptTorrentDoneFilename: string;
  scriptTorrentDoneSeedingEnabled: boolean;
  scriptTorrentDoneSeedingFilename: string;

  // Announce
  defaultTrackers: string[];        // added to all torrents
  announceIp: string;
  announceIpEnabled: boolean;

  // Verify
  torrentAddedVerifyMode: 'fast' | 'full';
  torrentCompleteVerifyEnabled: boolean;
}

// ─── Session stats ────────────────────────────────────────────────────────────

export interface SessionStats {
  activeTorrentCount: number;
  pausedTorrentCount: number;
  totalTorrentCount: number;
  downloadSpeed: number;
  uploadSpeed: number;
  currentStats: TransferStats;
  cumulativeStats: TransferStats;
}

export interface TransferStats {
  uploadedBytes: number;
  downloadedBytes: number;
  filesAdded: number;
  sessionCount: number;
  secondsActive: number;
}

// ─── Bandwidth group ──────────────────────────────────────────────────────────

export interface BandwidthGroup {
  name: string;
  honorsSessionLimits: boolean;
  speedLimitDown: number;
  speedLimitDownEnabled: boolean;
  speedLimitUp: number;
  speedLimitUpEnabled: boolean;
}

// ─── Free space ───────────────────────────────────────────────────────────────

export interface FreeSpaceResult {
  path: string;
  freeBytes: number;
  totalBytes: number;
}
