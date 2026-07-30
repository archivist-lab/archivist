import type { FilterNode, ListCreateRequest, ListPatchRequest } from '@archivist/contracts'
import { request, requestWithTab } from './api.js'

export type ListStatus = 'new' | 'added' | 'dismissed' | 'in_library' | 'departed' | 'failed'

export interface ArchivistList {
  id: number
  libraryId: number
  name: string
  description: string | null
  mediaType: 'film' | 'series'
  filter: FilterNode
  mode: 'approval' | 'auto'
  enabled: boolean
  monitored: boolean
  rootFolderId: number | null
  qualityProfileId: number | null
  maxAddsPerRun: number
  memberCap: number
  refreshIntervalHours: number
  lastRefreshedAt: string | null
  lastError: string | null
  consecutiveFailures: number
  createdAt: string
  updatedAt: string
  pendingCount?: number
  memberCount?: number
  counts?: Partial<Record<ListStatus, number>>
}

export interface ListItem {
  id: number
  list_id: number
  media_type: 'film' | 'series'
  tmdb_id: number
  title: string
  year: number | null
  poster_path: string | null
  status: ListStatus
  status_reason: string | null
  first_seen_at: string
  last_seen_at: string
}

export interface ListRun {
  id: number
  started_at: string
  finished_at: string | null
  fetched: number
  new_items: number
  auto_added: number
  departed: number
  capped: number
  error: string | null
}

export interface PreviewMember {
  tmdbId: number
  title: string
  year?: number
  posterPath?: string
}

export interface ListLookupResult {
  id: number
  label: string
  subtitle: string | null
  imagePath: string | null
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export const listsApi = {
  capabilities: () => request<{ compiler: string; operations: Record<string, boolean>; ratingSources: string[]; autoAddEnabled: boolean }>('/lists/capabilities'),
  pendingCount: () => request<{ count: number }>('/lists/pending-count'),
  lookup: (kind: 'person' | 'company' | 'title', mediaType: 'film' | 'series', query: string) =>
    request<{ results: ListLookupResult[] }>(`/lists/lookup?kind=${kind}&mediaType=${mediaType}&q=${encodeURIComponent(query)}`),
  list: (tabId: number) => requestWithTab<{ lists: ArchivistList[] }>(tabId, '/lists'),
  get: (tabId: number, id: number) => requestWithTab<{ list: ArchivistList }>(tabId, `/lists/${id}`),
  create: (tabId: number, input: ListCreateRequest) => requestWithTab<{ list: ArchivistList }>(tabId, '/lists', { method: 'POST', ...json(input) }),
  update: (tabId: number, id: number, input: ListPatchRequest & { mediaType?: 'film' | 'series' }) => {
    const { mediaType: _immutableMediaType, ...patch } = input
    return requestWithTab<{ list: ArchivistList }>(tabId, `/lists/${id}`, { method: 'PATCH', ...json(patch) })
  },
  delete: (tabId: number, id: number) => requestWithTab<void>(tabId, `/lists/${id}`, { method: 'DELETE' }),
  preview: (tabId: number, input: { mediaType: 'film' | 'series'; filter: FilterNode; memberCap: number }) =>
    requestWithTab<{ matchCount: number; sample: PreviewMember[]; capped: boolean; ceilingHit: boolean; warning: string | null }>(tabId, '/lists/preview', { method: 'POST', ...json(input) }),
  refresh: (tabId: number, id: number) => requestWithTab<{ queued: boolean; jobId: number | null }>(tabId, `/lists/${id}/refresh`, { method: 'POST' }),
  items: (tabId: number, id: number, status?: ListStatus) => requestWithTab<{ items: ListItem[]; total: number; page: number; pageSize: number }>(tabId, `/lists/${id}/items?${status ? `status=${status}&` : ''}pageSize=200`),
  runs: (tabId: number, id: number) => requestWithTab<{ runs: ListRun[] }>(tabId, `/lists/${id}/runs`),
  add: (tabId: number, listId: number, itemId: number) => requestWithTab<{ item: ListItem }>(tabId, `/lists/${listId}/items/${itemId}/add`, { method: 'POST' }),
  dismiss: (tabId: number, listId: number, itemId: number) => requestWithTab<{ item: ListItem }>(tabId, `/lists/${listId}/items/${itemId}/dismiss`, { method: 'POST' }),
  bulk: (tabId: number, listId: number, action: 'add' | 'dismiss', itemIds: number[]) => requestWithTab<{ updated: ListItem[] }>(tabId, `/lists/${listId}/items/bulk`, { method: 'POST', ...json({ action, itemIds }) }),
}
