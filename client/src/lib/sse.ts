// ── Server-sent events ────────────────────────────────────────────────────────
// One EventSource for the whole app, shared by every subscriber. The server
// bus (apps/server/src/system/sse.ts) emits:
//   • `system:ready`               — on connect
//   • `<category>:<action>`        — every recorded system event
//   • `activity:state`             — live/idle work summary (see activity-monitor)
//
// Components subscribe by event name (or '*' for all). The connection is opened
// lazily on first subscribe and closed when the last subscriber goes away, with
// exponential-backoff reconnect in between.

import { BASE } from './api.js'

export interface ServerEvent<T = unknown> {
  event: string
  data: T
}

type Handler = (event: ServerEvent) => void

const handlers = new Map<string, Set<Handler>>()
let source: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let attempts = 0
/** Names we have attached a native listener for (EventSource is per-event-name). */
const attached = new Set<string>()

/** True while the stream is connected; drives fallback polling in useLiveRefresh. */
let connected = false
const connectionWatchers = new Set<(online: boolean) => void>()

function setConnected(value: boolean) {
  if (connected === value) return
  connected = value
  for (const watcher of connectionWatchers) {
    try { watcher(value) } catch { /* a bad watcher must not break the bus */ }
  }
}

export function isSseConnected(): boolean {
  return connected
}

export function watchSseConnection(watcher: (online: boolean) => void): () => void {
  connectionWatchers.add(watcher)
  return () => { connectionWatchers.delete(watcher) }
}

function dispatch(event: string, raw: string) {
  let data: unknown = raw
  try { data = JSON.parse(raw) } catch { /* non-JSON payloads pass through as text */ }
  const payload: ServerEvent = { event, data }
  for (const name of [event, '*']) {
    const set = handlers.get(name)
    if (!set) continue
    for (const handler of [...set]) {
      try { handler(payload) } catch (err) { console.error('SSE handler failed', err) }
    }
  }
}

/** EventSource dispatches by event name, so each distinct name needs its own listener. */
function attach(name: string) {
  if (!source || name === '*' || attached.has(name)) return
  attached.add(name)
  source.addEventListener(name, (e) => dispatch(name, (e as MessageEvent).data))
}

function connect() {
  if (source || handlers.size === 0) return
  const stream = new EventSource(`${BASE}/events`, { withCredentials: true })
  source = stream

  stream.onopen = () => { attempts = 0; setConnected(true) }
  // Unnamed messages arrive as `message`; named ones need explicit listeners.
  stream.onmessage = (e) => dispatch('message', e.data)
  stream.onerror = () => {
    setConnected(false)
    // EventSource auto-reconnects, but a hard failure leaves it CLOSED — take over.
    if (stream.readyState === EventSource.CLOSED) {
      teardown()
      scheduleReconnect()
    }
  }

  attached.clear()
  for (const name of handlers.keys()) attach(name)
}

function teardown() {
  if (!source) return
  try { source.close() } catch { /* already closed */ }
  source = null
  attached.clear()
  setConnected(false)
}

function scheduleReconnect() {
  if (reconnectTimer || handlers.size === 0) return
  const delay = Math.min(30_000, 1000 * 2 ** attempts++)
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
}

/**
 * Subscribe to a server event by name, or '*' for every event.
 * Returns an unsubscribe function.
 */
export function subscribe(event: string, handler: Handler): () => void {
  let set = handlers.get(event)
  if (!set) { set = new Set(); handlers.set(event, set) }
  set.add(handler)

  connect()
  attach(event)

  return () => {
    const current = handlers.get(event)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) handlers.delete(event)
    if (handlers.size === 0) {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      teardown()
    }
  }
}
