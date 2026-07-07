// ─── Indexer types ────────────────────────────────────────────────────────────

export type IndexerType = 'torrent' | 'usenet';
export type IndexerProtocol = 'torznab' | 'newznab' | 'cardigann';
export type DownloadLinkType = 'torrent' | 'magnet';
export type SyncLevel = 'disabled' | 'addRemoveOnly' | 'fullSync';
export type ProxyType = 'http' | 'socks4' | 'socks5' | 'flaresolverr';

export interface Indexer {
  id: string;
  name: string;
  type: IndexerType;
  protocol: IndexerProtocol;
  definitionId: string | null;      // Cardigann YML id, null for native
  enabled: boolean;
  priority: number;                 // 1 = highest
  redirect: boolean;

  // Connection
  baseUrl: string;
  apiPath: string;
  apiKey: string | null;

  // Credentials (stored encrypted)
  username: string | null;
  password: string | null;
  cookieHeader: string | null;

  // Torrent-specific
  downloadLinkType: DownloadLinkType;
  minimumSeeders: number;
  seedRatio: number | null;
  seedTime: number | null;          // minutes

  // Sync
  syncProfileId: string | null;
  tags: string[];

  // VIP
  vipExpiration: string | null;     // ISO date string

  // Additional query params
  additionalParameters: string;

  // Status
  status: IndexerStatus;
  lastTestedAt: number | null;
  capabilities: IndexerCapabilities;

  // Additional indexer-specific settings (definition-dependent)
  settings: Record<string, string | number | boolean>;
}

export interface IndexerStatus {
  mostRecentFailure: string | null;
  disabledTill: string | null;
  initialFailure: string | null;
  failureCount: number;
}

export interface IndexerCapabilities {
  searchAvailable: boolean;
  tvSearchAvailable: boolean;
  movieSearchAvailable: boolean;
  musicSearchAvailable: boolean;
  bookSearchAvailable: boolean;
  categories: IndexerCategory[];
  supportsRss: boolean;
  supportsSearch: boolean;
}

export interface IndexerCategory {
  id: number;
  name: string;
  subCategories: IndexerCategory[];
}

// ─── Standard Torznab/Newznab category IDs ───────────────────────────────────

export const Categories = {
  Console:         1000,
  Movies:          2000,
  Audio:           3000,
  PC:              4000,
  TV:              5000,
  XXX:             6000,
  Books:           7000,
  Other:           8000,
  // Sub-categories (examples)
  Movies_HD:       2040,
  Movies_UHD:      2045,
  TV_HD:           5040,
  TV_UHD:          5045,
  Audio_MP3:       3010,
  Audio_FLAC:      3040,
  Books_Ebook:     7020,
  Books_Comics:    7030,
} as const;

// ─── Search query ─────────────────────────────────────────────────────────────

export interface SearchQuery {
  q: string;
  type?: 'search' | 'tvsearch' | 'movie' | 'music' | 'book';
  categories?: number[];
  indexerIds?: string[];            // filter to specific indexers; empty = all
  limit?: number;
  offset?: number;

  // Structured fields
  season?: number;
  episode?: number;
  year?: number;
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  artist?: string;
  album?: string;
  author?: string;
  title?: string;
}

// ─── Search result ────────────────────────────────────────────────────────────

export interface SearchResult {
  guid: string;
  title: string;
  indexerId: string;
  indexerName: string;

  // Type
  type: IndexerType;
  category: number;
  categories: number[];

  // Release details
  publishDate: number;              // unix ms
  size: number;                     // bytes
  files: number | null;
  grabs: number | null;

  // Torrent-specific
  seeders: number | null;
  leechers: number | null;
  infoHash: string | null;
  magnetUrl: string | null;
  downloadUrl: string;
  infoUrl: string | null;

  // Usenet-specific
  nzbUrl: string | null;
  usenetDate: number | null;
  age: number | null;               // days

  // Quality hints
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  indexerFlags: string[];
}

// ─── Indexer proxy ────────────────────────────────────────────────────────────

export interface IndexerProxy {
  id: string;
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  requestTimeout: number;           // seconds — for FlareSolverr
  tags: string[];
}

// ─── Sync profile ─────────────────────────────────────────────────────────────

export interface SyncProfile {
  id: string;
  name: string;
  enableRss: boolean;
  enableInteractiveSearch: boolean;
  enableAutomaticSearch: boolean;
  minimumSeeders: number;
}

// ─── Connected app (for Torznab proxy / *arr sync) ───────────────────────────

export interface ConnectedApp {
  id: string;
  name: string;
  implementation: 'Sonarr' | 'Radarr' | 'Lidarr' | 'Readarr' | 'Mylar3' | 'Generic';
  syncLevel: SyncLevel;
  baseUrl: string;
  apiKey: string;
  syncCategories: number[];
  tags: string[];
}
