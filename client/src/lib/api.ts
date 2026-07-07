export const BASE = '/api/v1'

let activeTabId: string | null = null
let tabGeneration = 0

/** Sets the global tab context for all subsequent API requests. */
export function setTabContext(id: string | null) {
  activeTabId = id
  tabGeneration++
}

export function getTabContext() {
  return activeTabId
}

/** Returns the current tab generation counter. Use to detect stale responses after a tab switch. */
export function getTabGeneration() {
  return tabGeneration
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers as any
  }

  if (activeTabId && !headers['x-tab-context']) {
    headers['x-tab-context'] = activeTabId
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return res.json()
}

/** Make a single request using a specific tab context without changing the global state. */
export async function requestWithTab<T>(tabId: number, path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tab-context': tabId.toString(),
    ...options?.headers as any
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return res.json()
}

export async function streamSearch<T>(url: string, onBatch: (items: T[]) => void, signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { 
    Accept: 'text/event-stream' 
  }
  
  if (activeTabId) {
    headers['x-tab-context'] = activeTabId
  }

  const res = await fetch(`${BASE}${url}`, { signal, headers })
  if (!res.ok || !res.body) throw new Error(`Search failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let pos: number
      while ((pos = buffer.indexOf('\n\n')) !== -1) {
        const msg = buffer.slice(0, pos)
        buffer = buffer.slice(pos + 2)

        let eventType = 'message'
        let data = ''
        for (const line of msg.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim()
          else if (line.startsWith('data: ')) data = line.slice(6)
        }

        if (eventType === 'done') return
        if (eventType === 'error') throw new Error(JSON.parse(data)?.error ?? 'Search error')
        if (data) {
          try {
            const items = JSON.parse(data) as T[]
            if (Array.isArray(items) && items.length > 0) onBatch(items)
          } catch {}
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// Shared helpers
export const tmdbImage = (path?: string | null, size = 'w342') => {
  if (!path) return null
  if (path.startsWith('http') || path.startsWith('/media')) return path
  const cleanPath = path.startsWith('/') ? path.slice(1) : path
  return `https://image.tmdb.org/t/p/${size}/${cleanPath}`
}

export const formatSize = (bytes?: number) => {
  if (!bytes) return '—'
  const gb = bytes / (1024 ** 3)
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`
}

export const formatRuntime = (min?: number) => {
  if (!min) return ''
  const h = Math.floor(min / 60), m = min % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export const formatDuration = (sec?: number) => {
  if (!sec) return '—'
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}
