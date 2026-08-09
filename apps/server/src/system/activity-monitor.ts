import { createLogger } from '@archivist/core'
import { getSseBus } from './sse.js'
import { processingMonitorStatus } from './processing-monitor.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { externalDownloadActivityCount } from '../services/external-downloads.js'
import { getDb, isDbInitialised } from '../db.js'
import { getCatalogueDb } from '../catalogue-database.js'

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
  systemJobs: { processing: number; queued: number }
  catalogue: { processing: number; queued: number }
}

const PROBE_MS = 2000
const CATALOGUE_PROBE_MS = 15_000
let timer: NodeJS.Timeout | null = null
let last: ActivitySnapshot | null = null
let catalogueCache = { at: 0, processing: 0, queued: 0 }

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
  let systemProcessing = 0
  let systemQueued = 0
  let catalogueProcessing = 0
  let catalogueQueued = 0
  try {
    for (const node of processingMonitorStatus().nodes) {
      processing += Number(node.activeCount) || 0
      queued += Number(node.queuedCount) || 0
    }
  } catch (err) {
    logger.debug?.('Processing probe failed:', err instanceof Error ? err.message : String(err))
  }
  if (isDbInitialised()) {
    try {
      const row = getDb().prepare(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'running') AS processing,
          COUNT(*) FILTER (WHERE status = 'queued') AS queued
        FROM system_jobs
      `).get() as { processing: number; queued: number }
      systemProcessing = Number(row.processing) || 0
      systemQueued = Number(row.queued) || 0
    } catch (err) {
      logger.debug?.('System job activity probe failed:', err instanceof Error ? err.message : String(err))
    }
  }
  if (Date.now() - catalogueCache.at >= CATALOGUE_PROBE_MS) {
    try {
      const row = getCatalogueDb().prepare(`
        SELECT
          (SELECT COUNT(*) FROM catalog_flow_runs WHERE status IN ('running', 'processing'))
            + (SELECT COUNT(*) FROM catalog_ingest_queue WHERE status = 'processing')
            + (SELECT COUNT(*) FROM catalog_movie_queue WHERE status = 'processing')
            + (SELECT COUNT(*) FROM catalog_artwork_queue WHERE status = 'processing') AS processing,
          (SELECT COUNT(*) FROM catalog_flow_runs WHERE status = 'queued')
            + (SELECT COUNT(*) FROM catalog_ingest_queue WHERE status IN ('pending', 'failed') AND attempts < 5 AND available_at <= CURRENT_TIMESTAMP)
            + (SELECT COUNT(*) FROM catalog_movie_queue WHERE status IN ('pending', 'failed') AND attempts < 5 AND available_at <= CURRENT_TIMESTAMP)
            + (SELECT COUNT(*) FROM catalog_artwork_queue WHERE status IN ('pending', 'failed') AND attempts < 5 AND available_at <= CURRENT_TIMESTAMP) AS queued
      `).get() as { processing: number; queued: number }
      catalogueCache = { at: Date.now(), processing: Number(row.processing) || 0, queued: Number(row.queued) || 0 }
    } catch (err) {
      logger.debug?.('Catalogue activity probe failed:', err instanceof Error ? err.message : String(err))
    }
  }
  catalogueProcessing = catalogueCache.processing
  catalogueQueued = catalogueCache.queued
  processing += systemProcessing + catalogueProcessing
  queued += systemQueued + catalogueQueued
  const torrents = activeTorrentCount() + externalDownloadActivityCount()
  return {
    active: processing > 0 || queued > 0 || torrents > 0,
    processing,
    queued,
    torrents,
    systemJobs: { processing: systemProcessing, queued: systemQueued },
    catalogue: { processing: catalogueProcessing, queued: catalogueQueued },
  }
}

function changed(a: ActivitySnapshot | null, b: ActivitySnapshot): boolean {
  return !a || a.active !== b.active || a.processing !== b.processing || a.torrents !== b.torrents || a.queued !== b.queued
    || a.systemJobs.processing !== b.systemJobs.processing || a.systemJobs.queued !== b.systemJobs.queued
    || a.catalogue.processing !== b.catalogue.processing || a.catalogue.queued !== b.catalogue.queued
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
  catalogueCache = { at: 0, processing: 0, queued: 0 }
}
