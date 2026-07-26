import { useEffect, useRef } from 'react'
import { isSseConnected, subscribe, watchSseConnection } from './sse.js'

/**
 * Imperative form of {@link useLiveRefresh}, for use inside an existing effect
 * that already owns its own lifecycle. Runs `fn` every `activeMs` while the
 * server reports work in flight, and every `idleMs` otherwise. Returns a stop
 * function. Does NOT invoke `fn` immediately — the caller usually just did.
 */
export function subscribeActivity(fn: () => void, activeMs: number, idleMs = 60_000): () => void {
  let stopped = false
  let active = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { if (!stopped) { fn(); schedule() } }, active || !isSseConnected() ? activeMs : idleMs)
  }
  schedule()

  const offState = subscribe('activity:state', (event) => {
    const next = Boolean((event.data as { active?: boolean } | null)?.active)
    if (next === active) return
    active = next
    fn()
    schedule()
  })
  const offConn = watchSseConnection(() => schedule())

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    offState()
    offConn()
  }
}

export interface LiveRefreshOptions {
  /** Poll cadence while the server reports work in progress. */
  activeMs?: number
  /** Poll cadence while idle. Long by design — SSE covers the interesting moments. */
  idleMs?: number
  /** Cadence used when the SSE stream is unavailable (fallback to old behaviour). */
  offlineMs?: number
  /** Extra server events that should trigger an immediate refresh. */
  events?: string[]
  /** Set false to suspend refreshing entirely. */
  enabled?: boolean
}

/**
 * Replaces the `setInterval(load, 1500)` pattern.
 *
 * The server emits `activity:state` describing whether any work is running. While
 * work is live we poll quickly (progress is continuous and not event-shaped);
 * while idle we mostly sit silent on the SSE connection and refresh rarely. If the
 * stream is down we fall back to a steady poll so behaviour never regresses.
 *
 * `load` is kept in a ref, so callers may pass an inline closure without
 * resetting the timer on every render.
 */
export function useLiveRefresh(load: () => void | Promise<unknown>, options: LiveRefreshOptions = {}): void {
  const {
    activeMs = 2000,
    idleMs = 30_000,
    offlineMs = 5000,
    events = [],
    enabled = true,
  } = options

  const loadRef = useRef(load)
  loadRef.current = load
  const eventKey = events.join(',')

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let active = false

    const run = () => { if (!cancelled) void loadRef.current() }

    const schedule = () => {
      if (cancelled) return
      if (timer) clearTimeout(timer)
      const delay = !isSseConnected() ? offlineMs : active ? activeMs : idleMs
      timer = setTimeout(() => { run(); schedule() }, delay)
    }

    // Immediate first load, then settle into the appropriate cadence.
    run()
    schedule()

    const unsubscribers = [
      subscribe('activity:state', (event) => {
        const next = Boolean((event.data as { active?: boolean } | null)?.active)
        if (next === active) return
        active = next
        // Transitioning in either direction is itself news — refresh now.
        run()
        schedule()
      }),
      watchSseConnection(() => schedule()),
      ...events.map(name => subscribe(name, () => run())),
    ]

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      for (const off of unsubscribers) off()
    }
  }, [enabled, activeMs, idleMs, offlineMs, eventKey])
}
