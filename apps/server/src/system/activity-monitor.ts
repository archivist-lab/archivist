import { createLogger } from '@archivist/core'
import { getSseBus } from './sse.js'
import { processingMonitorStatus } from './processing-monitor.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { externalDownloadActivityCount } from '../services/external-downloads.js'

const logger = createLogger('Activity')

/**
 * Broadcasts whether Archivist currently has work in flight, so the UI can stop
 * polling when it does not.
 *
 * Progress (download %, encode %) is continuous rather than event-shaped, so the
 * client still polls while work is live — but the overwhelmingly common state is
 * *idle*, and previously the UI polled every 1.5–5s regardless. This emits
 * `activity:state` on every transition plus a heartbeat while active, letting the
 * client drop to a long idle cadence the rest of the time.
 *
 * The probe only runs while at least one SSE client is connected, so a headless
 * server does no work at all.
 */

export interface ActivitySnapshot {
  active: boolean
  processing: number
  queued: number
  torrents: number
}

const PROBE_MS = 2000
let timer: NodeJS.Timeout | null = null
let last: ActivitySnapshot | null = null

function activeTorrentCount(): number {
  // The embedded engine is optional (external client, or downloads disabled) and
  // getTorrentSession() throws when it was never started — treat that as "idle"
  // rather than letting a probe disturb the server. Only the built-in engine is
  // counted; external clients are polled by the dashboard route on demand.
  try {
    return getTorrentSession().getAllTorrents()
      .filter((t: any) => (t?.progress ?? 0) < 1 && t?.state !== 'paused' && t?.status !== 'paused')
      .length
  } catch {
    return 0
  }
}

export function readActivity(): ActivitySnapshot {
  let processing = 0
  let queued = 0
  try {
    for (const node of processingMonitorStatus().nodes) {
      processing += Number(node.activeCount) || 0
      queued += Number(node.queuedCount) || 0
    }
  } catch (err) {
    logger.debug?.('Processing probe failed:', err instanceof Error ? err.message : String(err))
  }
  const torrents = activeTorrentCount() + externalDownloadActivityCount()
  return { active: processing > 0 || queued > 0 || torrents > 0, processing, queued, torrents }
}

function changed(a: ActivitySnapshot | null, b: ActivitySnapshot): boolean {
  return !a || a.active !== b.active || a.processing !== b.processing || a.torrents !== b.torrents || a.queued !== b.queued
}

function probe(): void {
  const bus = getSseBus()
  // No listeners — do no work and forget the last state so the next connect
  // always receives a fresh snapshot.
  if (bus.clientCount === 0) { last = null; return }

  const snapshot = readActivity()
  // Emit on any change, and keep a heartbeat flowing while work is live so a
  // client that connected mid-job learns about it promptly.
  if (changed(last, snapshot) || snapshot.active) {
    bus.emit('activity:state', snapshot)
    last = snapshot
  }
}

export function startActivityMonitor(): void {
  if (timer) return
  timer = setInterval(() => {
    try { probe() } catch (err) { logger.warn('Activity probe failed:', err instanceof Error ? err.message : String(err)) }
  }, PROBE_MS)
  timer.unref?.()
}

export function stopActivityMonitor(): void {
  if (timer) clearInterval(timer)
  timer = null
  last = null
}
