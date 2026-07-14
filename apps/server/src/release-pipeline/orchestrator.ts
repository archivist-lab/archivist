import { createLogger } from '@archivist/core'
import { getIndexerStore } from '../services/indexer-bridge.js'
import { getState } from './state-store.js'
import { isReadyToPoll } from './health.js'
import { pollIndexer, type PollResult } from './poller.js'
import { startTitleIndex, stopTitleIndex } from './title-index.js'
import { isRapidWindowActive, getReleaseMonitoringSettings, getImminentSeriesIds } from './release-monitoring-settings.js'

const logger = createLogger('ReleaseOrchestrator')
const TICK_INTERVAL_MS = 30_000
const STARTUP_DELAY_MS = 5_000
const MAX_CONCURRENT = 4
const IMMINENT_CHECK_INTERVAL_MS = 5 * 60_000

let started = false
let timer: NodeJS.Timeout | null = null
const inFlight = new Set<string>()
let rapidMode = false
let lastImminentCheck = 0

export function startReleaseOrchestrator(): void {
  if (started) return
  started = true
  logger.info('Starting release orchestrator (per-indexer polling + title index)')
  startTitleIndex()
  setTimeout(() => { void tick() }, STARTUP_DELAY_MS)
  timer = setInterval(() => { void tick() }, TICK_INTERVAL_MS)
}

export function stopReleaseOrchestrator(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
  stopTitleIndex()
}

/** Whether an indexer participates in the RSS feed. Defaults to true when unset. */
export function rssEnabled(ix: { config: { settings?: any } }): boolean {
  const raw = ix.config.settings?.rss
  return raw === undefined || raw === null || raw === true || raw === 'true'
}

async function tick(): Promise<void> {
  let store
  try { store = getIndexerStore() } catch { return }
  // Only poll indexers the user has enabled for the RSS feed (settings.rss !== false).
  const indexers = store.getEnabled().filter(rssEnabled)
  if (indexers.length === 0) return

  const now = Date.now()
  const settings = getReleaseMonitoringSettings()
  const normalIntervalMs = settings.pollIntervalMinutes * 60_000

  // Rapid air-time mode: shorten the effective poll interval while a monitored
  // episode is airing soon, so it's grabbed within a minute or two of appearing.
  const rapidActive = isRapidWindowActive(now)
  if (rapidActive !== rapidMode) {
    rapidMode = rapidActive
    logger.info(rapidActive ? 'Entered rapid polling mode (monitored episode airing soon)' : 'Exited rapid polling mode')
  }
  const rapidIntervalMs = rapidActive ? settings.rapidPollIntervalSeconds * 1000 : undefined

  // Refresh metadata for series with imminent episodes (throttled), so new
  // episodes exist in the library before their releases show up on indexers.
  if (now - lastImminentCheck >= IMMINENT_CHECK_INTERVAL_MS) {
    lastImminentCheck = now
    try {
      const { enqueueSeriesMetadataRefresh } = await import('../modules/series/metadata-refresh.js')
      for (const seriesId of getImminentSeriesIds(now)) enqueueSeriesMetadataRefresh(seriesId)
    } catch { /* best effort */ }
  }

  const due = indexers.filter(ix => {
    if (inFlight.has(ix.config.id)) return false
    return isReadyToPoll(getState(ix.config.id), now, rapidIntervalMs, normalIntervalMs)
  })

  const slots = MAX_CONCURRENT - inFlight.size
  if (slots <= 0) return
  const toPoll = due.slice(0, slots)
  if (toPoll.length === 0) return

  await Promise.all(toPoll.map(async ix => {
    inFlight.add(ix.config.id)
    try {
      await pollIndexer(ix)
    } catch (err) {
      logger.error(`Tick error for ${ix.config.name}:`, err)
    } finally {
      inFlight.delete(ix.config.id)
    }
  }))
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = new Array(Math.min(limit, queue.length || 1)).fill(null).map(async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (next === undefined) break
      await fn(next)
    }
  })
  await Promise.all(workers)
}

export async function forceRefreshAll(): Promise<PollResult[]> {
  let store
  try { store = getIndexerStore() } catch { return [] }
  const indexers = store.getEnabled().filter(rssEnabled)
  if (indexers.length === 0) return []

  const results: PollResult[] = []
  await runWithConcurrency(indexers, MAX_CONCURRENT, async ix => {
    if (inFlight.has(ix.config.id)) return
    inFlight.add(ix.config.id)
    try {
      const result = await pollIndexer(ix, { force: true })
      results.push(result)
    } finally {
      inFlight.delete(ix.config.id)
    }
  })
  return results
}

export async function forceRefreshOne(indexerId: string): Promise<PollResult | null> {
  let store
  try { store = getIndexerStore() } catch { return null }
  const indexer = store.getEnabled().find(ix => ix.config.id === indexerId)
  if (!indexer) return null
  if (inFlight.has(indexerId)) return null
  inFlight.add(indexerId)
  try {
    return await pollIndexer(indexer, { force: true })
  } finally {
    inFlight.delete(indexerId)
  }
}

export function getInFlightIndexerIds(): string[] {
  return [...inFlight]
}
