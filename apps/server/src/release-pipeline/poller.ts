import type { IndexerInstance } from '@torrentstack/indexer-engine'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { checkCloudflareBypassReady, rssSyncViaIndexers, type BridgeSearchResult } from '../services/indexer-bridge.js'
import { recordEvent } from '../system/event-store.js'
import { processReleaseBatch } from '../shared/rss-monitor.js'
import { getState, saveState } from './state-store.js'
import { applyFailure, applySuccess } from './health.js'

const logger = createLogger('Poller')
const DEFAULT_LIMIT = 200
const FORCED_LIMIT = 500

export function persistedRssEligible(indexerId: string, db: ReturnType<typeof getDb>): boolean {
  const row = db.prepare('SELECT enabled, settings FROM indexers_ts WHERE id = ?').get(indexerId) as
    | { enabled: number; settings: string }
    | undefined
  if (!row || row.enabled !== 1) return false
  try {
    const rss = (JSON.parse(row.settings || '{}') as { rss?: unknown }).rss
    return rss === undefined || rss === null || rss === true || rss === 'true'
  } catch {
    return false
  }
}

export interface PollResult {
  indexerId: string
  indexerName: string
  fetched: number
  newReleases: number
  grabbed: number
  durationMs: number
  error: string | null
}

export function filterNewReleases(
  results: BridgeSearchResult[],
  recentGuids: string[],
  watermark: number,
  now = Date.now(),
): { newReleases: BridgeSearchResult[]; nextWatermark: number; nextGuids: string[] } {
  const seen = new Set(recentGuids)
  // A watermark in the future is not a watermark — it is a poisoned one. One
  // future-dated item (a tracker with a skewed clock, a date selector that
  // captured the wrong column) used to pin it ahead of real time, after which
  // every genuine release fell at or below it and the feed grabbed nothing,
  // while each poll still recorded success and healthy. Discard it and let
  // `recentGuids` carry the dedup for this poll; the watermark rebuilds from
  // the newest release that is actually in the past.
  const floor = watermark > now ? 0 : watermark
  let nextWatermark = floor
  const newReleases: BridgeSearchResult[] = []
  const guidAdds: string[] = []

  for (const r of results) {
    if (r.guid && seen.has(r.guid)) continue
    if (r.publishDate) {
      const pubMs = new Date(r.publishDate).getTime()
      if (Number.isFinite(pubMs)) {
        if (floor > 0 && pubMs <= floor) continue
        if (pubMs > nextWatermark && pubMs <= now) nextWatermark = pubMs
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

  const flare = await checkCloudflareBypassReady(indexer)
  if (!flare.ready) {
    const msg = `CloudflareBypass is not ready${flare.error ? `: ${flare.error}` : ''}`
    logger.warn(`Delaying ${indexerName} RSS poll — ${msg}`)
    recordEvent({
      category: 'rss',
      action: 'dependency-wait',
      severity: 'warn',
      message: `${indexerName} poll delayed: ${msg}`,
      data: { indexerId, dependency: 'cloudflareBypass' },
    }, db)
    return {
      indexerId, indexerName,
      fetched: 0, newReleases: 0, grabbed: 0,
      durationMs: Date.now() - start,
      error: msg,
    }
  }

  try {
    const { results: fetched, stats } = await rssSyncViaIndexers([indexer], { limit })

    // If the indexer's fetch errored, surface that as a poll failure so backoff
    // + health transitions kick in. The aggregator catches per-indexer errors
    // into stats[i].error rather than throwing — without this check a
    // CloudflareBypass crash or a Cloudflare wall reads as "0 results, healthy".
    const indexerStat = stats.find(s => s.indexerId === indexerId)
    if (indexerStat?.error) {
      throw new Error(indexerStat.error)
    }

    // The request may have started just before the API disabled or deleted the
    // indexer. Network timeouts are not currently abortable, so re-check the
    // durable source of truth before any stale result can enter acquisition.
    if (!persistedRssEligible(indexerId, db)) {
      recordEvent({
        category: 'rss',
        action: 'poll-discarded',
        severity: 'warn',
        message: `${indexerName}: discarded ${fetched.length} fetched releases because the indexer is no longer RSS-enabled`,
        data: { indexerId, fetched: fetched.length },
      }, db)
      return {
        indexerId, indexerName,
        fetched: fetched.length, newReleases: 0, grabbed: 0,
        durationMs: Date.now() - start,
        error: null,
      }
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
