import { useEffect, useRef } from 'react'
import { isSseConnected, subscribe, watchSseConnection } from './sse.js'
import { createRefreshLoop } from './refresh-loop.js'

export function subscribeActivity(fn: (signal: AbortSignal) => unknown, activeMs: number, idleMs = 60_000): () => void {
  let active = false
  const loop = createRefreshLoop(fn, () => active || !isSseConnected() ? activeMs : idleMs)
  const offState = subscribe('activity:state', event => {
    const next = Boolean((event.data as { active?: boolean } | null)?.active)
    if (next !== active) { active = next; loop.request() }
  })
  const offConnection = watchSseConnection(loop.request)
  loop.start(false)
  return () => { loop.stop(); offState(); offConnection() }
}

export interface LiveRefreshOptions {
  activeMs?: number
  idleMs?: number
  offlineMs?: number
  events?: string[]
  enabled?: boolean
  refreshKey?: string | number
}

/** Return the request promise and honour signal to participate in cancellation. */
export function useLiveRefresh(load: (signal: AbortSignal) => unknown, options: LiveRefreshOptions = {}): void {
  const { activeMs = 2000, idleMs = 30_000, offlineMs = 5000, events = [], enabled = true, refreshKey } = options
  const loadRef = useRef(load)
  loadRef.current = load
  const eventKey = events.join(',')
  useEffect(() => {
    if (!enabled) return
    let active = false
    const loop = createRefreshLoop(signal => loadRef.current(signal), () => !isSseConnected() ? offlineMs : active ? activeMs : idleMs)
    const off = [
      subscribe('activity:state', event => {
        const next = Boolean((event.data as { active?: boolean } | null)?.active)
        if (next !== active) { active = next; loop.request() }
      }),
      watchSseConnection(loop.request),
      ...events.map(name => subscribe(name, loop.request)),
    ]
    loop.start()
    return () => { loop.stop(); for (const unsubscribe of off) unsubscribe() }
  }, [enabled, activeMs, idleMs, offlineMs, eventKey, refreshKey])
}
