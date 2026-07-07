import type { IndexerInstance } from '@torrentstack/indexer-engine'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { rssSyncViaIndexers, type BridgeSearchResult } from '../services/indexer-bridge.js'
import { recordEvent } from '../system/event-store.js'
import { processReleaseBatch } from '../shared/rss-monitor.js'
import { getState, saveState } from './state-store.js'
import { applyFailure, applySuccess } from './health.js'

const logger = createLogger('Poller')
const DEFAULT_LIMIT = 200
const FORCED_LIMIT = 500

export interface PollResult {
  indexerId: string
  indexerName: string
  fetched: number
  newReleases: number
  grabbed: number
  durationMs: number
  error: string | null
}

function filterNewReleases(
  results: BridgeSearchResult[],
  recentGuids: string[],
  watermark: number,
): { newReleases: BridgeSearchResult[]; nextWatermark: number; nextGuids: string[] } {
  const seen = new Set(recentGuids)
  let nextWatermark = watermark
  const newReleases: BridgeSearchResult[] = []
  const guidAdds: string[] = []

  for (const r of results) {
    if (r.guid && seen.has(r.guid)) continue
    if (r.publishDate) {
      const pubMs = new Date(r.publishDate).getTime()
      if (Number.isFinite(pubMs)) {
        if (watermark > 0 && pubMs <= watermark) continue
        if (pubMs > nextWatermark) nextWatermark = pubMs
      }
    }
    newReleases.push(r)
    if (r.guid) guidAdds.push(r.guid)
  }

  return {
    newReleases,
    nextWatermark,
    nextGuids: [...recentGuids, ...guidAdds],
  }
}

export async function pollIndexer(
  indexer: IndexerInstance,
  opts?: { force?: boolean; limit?: number },
): Promise<PollResult> {
  const start = Date.now()
  const indexerId = indexer.config.id
  const indexerName = indexer.config.name
  const db = getDb()

  let state = getState(indexerId, db)
  const limit = opts?.limit ?? (opts?.force ? FORCED_LIMIT : DEFAULT_LIMIT)

  try {
    const { results: fetched, stats } = await rssSyncViaIndexers([indexer], { limit })

    // If the indexer's fetch errored, surface that as a poll failure so backoff
    // + health transitions kick in. The aggregator catches per-indexer errors
    // into stats[i].error rather than throwing — without this check a
    // FlareSolverr crash or a Cloudflare wall reads as "0 results, healthy".
    const indexerStat = stats.find(s => s.indexerId === indexerId)
    if (indexerStat?.error) {
      throw new Error(indexerStat.error)
    }

    // Force-mode bypasses watermark/dedup so a manual refresh actually re-evaluates
    // every result (useful when you've just added new monitored items).
    const { newReleases, nextWatermark, nextGuids } = opts?.force
      ? { newReleases: fetched, nextWatermark: state.highestPubDate, nextGuids: state.recentGuids }
      : filterNewReleases(fetched, state.recentGuids, state.highestPubDate)

    let grabbed = 0
    let identified = 0
    let unmatched = 0
    let rejected = 0
    if (newReleases.length > 0) {
      const outcome = await processReleaseBatch(newReleases)
      grabbed = outcome.grabbed
      identified = outcome.identified
      unmatched = outcome.unmatched
      rejected = outcome.rejected
    }

    state = applySuccess(
      { ...state, recentGuids: nextGuids, highestPubDate: nextWatermark },
      { fetched: fetched.length, newReleases: newReleases.length, grabbed },
    )
    saveState(state, db)

    recordEvent({
      category: 'rss',
      action: 'poll',
      message: `${indexerName}: fetched=${fetched.length} new=${newReleases.length} identified=${identified} grabbed=${grabbed}`,
      data: {
        indexerId,
        fetched: fetched.length,
        newReleases: newReleases.length,
        identified,
        unmatched,
        rejected,
        grabbed,
        force: !!opts?.force,
      },
    }, db)

    return {
      indexerId, indexerName,
      fetched: fetched.length,
      newReleases: newReleases.length,
      grabbed,
      durationMs: Date.now() - start,
      error: null,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    state = applyFailure(state, msg)
    saveState(state, db)
    logger.error(`Poll failed for ${indexerName}: ${msg}`)
    recordEvent({
      category: 'rss',
      action: 'poll-error',
      severity: state.health === 'unhealthy' ? 'error' : 'warn',
      message: `${indexerName} poll failed: ${msg}`,
      data: { indexerId, consecutiveFailures: state.consecutiveFailures, health: state.health },
    }, db)
    return {
      indexerId, indexerName,
      fetched: 0, newReleases: 0, grabbed: 0,
      durationMs: Date.now() - start,
      error: msg,
    }
  }
}
