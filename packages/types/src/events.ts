// ─── Notification types ───────────────────────────────────────────────────────

export type NotificationTrigger =
  | 'torrent:added'
  | 'torrent:complete'
  | 'torrent:seeding-complete'
  | 'torrent:error'
  | 'health:issue'
  | 'app:update';

export type NotifierType =
  | 'discord'
  | 'telegram'
  | 'slack'
  | 'webhook'
  | 'email'
  | 'pushover'
  | 'ntfy'
  | 'gotify';

export interface Notifier {
  id: string;
  name: string;
  type: NotifierType;
  enabled: boolean;
  triggers: NotificationTrigger[];
  settings: Record<string, string>;  // type-specific config
}

// ─── WebSocket event payloads ─────────────────────────────────────────────────

export type WsEventType =
  | 'torrent:added'
  | 'torrent:removed'
  | 'torrent:updated'
  | 'torrent:complete'
  | 'torrent:error'
  | 'speed:update'
  | 'session:stats';

export interface WsEvent<T = unknown> {
  type: WsEventType;
  data: T;
  ts: number;                       // unix ms
}

export interface SpeedUpdatePayload {
  downloadSpeed: number;            // bytes/sec global
  uploadSpeed: number;              // bytes/sec global
  activeTorrents: number;
}

export interface TorrentUpdatedPayload {
  id: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  status: string;
  eta: number;
  peersConnected: number;
}

// ─── API response envelope ────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  ok: true;
}

export interface ApiError {
  ok: false;
  error: string;
  code?: string;
  details?: unknown;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
