import { request } from './api.js'

export type LeavingSoonTargetType = 'film_edition' | 'series' | 'season' | 'episode'
export interface LeavingSoonItem {
  id: number; targetType: LeavingSoonTargetType; targetId: number; enabled: boolean
  status: 'armed' | 'scheduled' | 'deleting' | 'deleted' | 'failed' | 'cancelled'
  title: string; subtitle: string | null; posterUrl: string | null; backdropUrl: string | null
  watchedAt: string | null; deleteAfter: string | null; daysRemaining: number | null; lastError: string | null
}
export interface SweepLibraryPolicy {
  enabled: boolean; graceDays: number; autoEligibilityEnabled: boolean; contentAgeDays: number
  lastWatchedDays: number; minimumSizeGb: number; protectionPeriodDays: number
  protectChannelItems: boolean; excludeTags: string[]; taggingEnabled: boolean; tagName: string
}
export interface SweepSettings extends SweepLibraryPolicy {
  dryRun: boolean; cleanupIntervalHours: number; requireKeepApproval: boolean; manualReviewRequired: boolean
  diskUsageThresholds: Array<{ usagePercent: number; maxGraceDays: number }>
  tvCleanupMode: 'all' | 'keep_episodes' | 'keep_seasons'; keepCount: number; protectSpecials: boolean
  collectionsEnabled: boolean; movieCollectionName: string; tvCollectionName: string; warningDays: number[]
  ntfy: { enabled: boolean; serverUrl: string; topic: string; token: string }
  email: { enabled: boolean; webhookUrl: string }; webPush: { enabled: boolean; webhookUrl: string }
  libraryOverrides: Record<string, Partial<SweepLibraryPolicy>>
}
export type PublicSweepSettings = Pick<SweepSettings, 'enabled' | 'graceDays' | 'dryRun' | 'requireKeepApproval' | 'collectionsEnabled' | 'movieCollectionName' | 'tvCollectionName' | 'warningDays'>

export const leavingSoonApi = {
  list: () => request<{ items: LeavingSoonItem[]; settings: PublicSweepSettings }>('/leaving-soon'),
  get: (type: LeavingSoonTargetType, id: number) => request<{ item: LeavingSoonItem | null; settings: PublicSweepSettings }>(`/leaving-soon/${type}/${id}`),
  set: (type: LeavingSoonTargetType, id: number, enabled: boolean) => request<{ item: LeavingSoonItem; settings: PublicSweepSettings }>(`/leaving-soon/${type}/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  getSettings: () => request<SweepSettings>('/leaving-soon/settings'),
  setSettings: (settings: SweepSettings) => request<SweepSettings>('/leaving-soon/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  report: () => request<any>('/leaving-soon/report'),
  requests: () => request<{ requests: any[] }>('/leaving-soon/requests'),
  notifications: () => request<{ notifications: any[] }>('/leaving-soon/notifications'),
  decideRequest: (id: number, decision: 'approved' | 'declined') => request<any>(`/leaving-soon/requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }),
  evaluate: () => request<any>('/leaving-soon/evaluate', { method: 'POST' }),
  sweepNow: () => request<any>('/leaving-soon/sweep', { method: 'POST' }),
  resetTags: () => request<any>('/leaving-soon/tags/reset', { method: 'POST' }),
  reconcileTags: () => request<any>('/leaving-soon/tags/reconcile', { method: 'POST' }),
}
