import { request } from './api.js'

export type ItemSearchMediaType = 'films' | 'series' | 'music'
export type ItemSearchSubjectType = 'film' | 'series' | 'season' | 'episode' | 'album' | 'artist'
export type ItemSearchMode = 'quick' | 'deep' | 'auto' | 'auto-episodes'
export type ItemSearchStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'

export interface ItemSearch<T = Record<string, unknown>> {
  id: number
  jobId: number | null
  libraryId: number
  mediaType: ItemSearchMediaType
  subjectType: ItemSearchSubjectType
  subjectId: number
  mode: ItemSearchMode
  status: ItemSearchStatus
  options: Record<string, unknown>
  results: T[]
  resultCount: number
  grabbed: boolean
  message: string | null
  error: string | null
  queuePosition: number | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string | null
  updatedAt: string
}

export interface EnqueueItemSearch {
  mediaType: ItemSearchMediaType
  subjectType: ItemSearchSubjectType
  subjectId: number
  mode: ItemSearchMode
  options?: Record<string, unknown>
}

const terminal = (status: ItemSearchStatus) => ['complete', 'failed', 'cancelled'].includes(status)

function abortError(): DOMException {
  return new DOMException('Polling stopped', 'AbortError')
}

async function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError()
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = window.setTimeout(finish, ms)
    const abort = () => {
      window.clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export const itemSearchesApi = {
  enqueue: <T>(input: EnqueueItemSearch) => request<{ search: ItemSearch<T> }>('/item-searches', {
    method: 'POST', body: JSON.stringify(input),
  }).then(response => response.search),

  get: <T>(id: number, signal?: AbortSignal) => request<{ search: ItemSearch<T> }>(`/item-searches/${id}`, { signal })
    .then(response => response.search),

  latest: <T>(input: Pick<EnqueueItemSearch, 'mediaType' | 'subjectType' | 'subjectId'>, signal?: AbortSignal) => {
    const query = new URLSearchParams({
      mediaType: input.mediaType,
      subjectType: input.subjectType,
      subjectId: String(input.subjectId),
    })
    return request<{ search: ItemSearch<T> | null }>(`/item-searches/latest?${query.toString()}`, { signal }).then(response => response.search)
  },

  cancel: <T>(id: number) => request<{ search: ItemSearch<T> }>(`/item-searches/${id}`, { method: 'DELETE' }).then(response => response.search),

  cancelLatest: async <T>(input: Pick<EnqueueItemSearch, 'mediaType' | 'subjectType' | 'subjectId'>) => {
    const search = await itemSearchesApi.latest<T>(input)
    return search && (search.status === 'queued' || search.status === 'running')
      ? itemSearchesApi.cancel<T>(search.id)
      : search
  },

  wait: async <T>(initial: ItemSearch<T>, onUpdate?: (search: ItemSearch<T>) => void, signal?: AbortSignal): Promise<ItemSearch<T>> => {
    let search = initial
    onUpdate?.(search)
    while (!terminal(search.status)) {
      await waitDelay(1500, signal)
      search = await itemSearchesApi.get<T>(search.id, signal)
      onUpdate?.(search)
    }
    if (search.status === 'failed') throw new Error(search.error || search.message || 'Search failed')
    return search
  },

  startAndWait: async <T>(input: EnqueueItemSearch, onUpdate?: (search: ItemSearch<T>) => void, signal?: AbortSignal) => {
    const search = await itemSearchesApi.enqueue<T>(input)
    return itemSearchesApi.wait(search, onUpdate, signal)
  },
}
