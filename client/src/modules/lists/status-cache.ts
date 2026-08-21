import type { ListItem, ListStatus } from '../../lib/lists.api.js'

export interface StatusCacheEntry {
  items: ListItem[]
  total: number
  page: number
  pageSize: number
  loaded: boolean
  loading: boolean
  error: boolean
}

export type StatusCache = Partial<Record<ListStatus, StatusCacheEntry>>

interface StatusPage {
  items: ListItem[]
  total: number
  page: number
  pageSize: number
}

export const emptyStatusCacheEntry = (pageSize: number): StatusCacheEntry => ({
  items: [],
  total: 0,
  page: 0,
  pageSize,
  loaded: false,
  loading: false,
  error: false,
})

export function mergeStatusPage(previous: StatusCacheEntry | undefined, response: StatusPage, append: boolean): StatusCacheEntry {
  const preserveLoadedPages = !append && Boolean(previous?.loaded && previous.page > 1)
  const items = append
    ? [...(previous?.items ?? []), ...response.items]
    : preserveLoadedPages
      ? [...response.items, ...(previous?.items ?? [])]
      : response.items
  return {
    items: [...new Map(items.map(item => [item.id, item])).values()].slice(0, response.total),
    total: response.total,
    page: preserveLoadedPages ? previous?.page ?? response.page : response.page,
    pageSize: response.pageSize,
    loaded: true,
    loading: false,
    error: false,
  }
}

/** Reconcile only caches that have already been visited; unopened statuses load from the server on demand. */
export function reconcileStatusCache(cache: StatusCache, updatedItems: ListItem[]): StatusCache {
  const affectedIds = new Set(updatedItems.map(item => item.id))
  const next: StatusCache = { ...cache }

  for (const [status, entry] of Object.entries(cache) as Array<[ListStatus, StatusCacheEntry]>) {
    const remaining = entry.items.filter(item => !affectedIds.has(item.id))
    const removedCount = entry.items.length - remaining.length
    const arrivals = updatedItems.filter(item => item.status === status)
    next[status] = {
      ...entry,
      items: [...new Map([...arrivals, ...remaining].map(item => [item.id, item])).values()],
      total: Math.max(0, entry.total - removedCount + arrivals.length),
      loading: false,
      error: false,
    }
  }

  return next
}
