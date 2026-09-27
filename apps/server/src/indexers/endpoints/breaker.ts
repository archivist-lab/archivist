import type { Database } from 'better-sqlite3'
import type { SearchResult } from '@torrentstack/types'
import {
  classifyDiagnostics, runIndexerSearch,
  type AggregatorHooks, type IndexerOutcome,
} from '@torrentstack/indexer-engine'
import type { FailureClass } from '@archivist/contracts'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { getIerConfig } from './config.js'
import * as store from './store.js'
import { applyActiveEndpointToInstance, humanFailure, resolveIndexer } from './resolver.js'
import { enqueueUniqueJob } from '../../system/event-store.js'
import { emitFailed } from './events.js'

const logger = createLogger('IER:breaker')

/**
 * Circuit breaker on the search path (spec §9.2).
 *
 * The in-search retry is the point of the whole feature: when the active
 * endpoint fails mid-search, the user should see results from the failover
 * endpoint rather than an error. Everything else IER does is bookkeeping.
 */

/**
 * The only classes that mean the *endpoint* is at fault.
 *
 * `parse` and `empty` are deliberately absent. On the search path a request
 * that completed but matched nothing is an ordinary outcome — the query was
 * narrow, or the category filter removed every row. Counting that as an
 * endpoint failure demotes healthy mirrors during a normal scan and, worse,
 * queues a full re-probe of every mirror mid-scan. That is spec §14.3, the
 * failure it calls the single most likely source of wrong behaviour.
 *
 * `rate_limited` is absent for the separate reason in §6.3: being throttled
 * says we used the endpoint, not that it is bad.
 */
const ENDPOINT_AT_FAULT: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'dns', 'connect', 'timeout', 'challenge', 'auth', 'http_error',
])

/**
 * How long a search skips an indexer whose only endpoint keeps failing.
 *
 * Short on purpose. This is the open state of a breaker, not a disable: the
 * next search after it lapses is the half-open trial, and one success clears
 * the counters through the `!failureClass` branch above.
 */
const SEARCH_BREAKER_COOLDOWN_MS = 15 * 60_000

/**
 * A failover search must not outlive the search that triggered it. The
 * aggregator only bounds this hook when the caller passed a deadline, and the
 * executor's own timeout is per HTTP request, so a multi-path definition could
 * spend several of them here.
 */
const FAILOVER_SEARCH_TIMEOUT_MS = 20_000

/**
 * Whether the search path should skip this indexer entirely.
 *
 * True when its active endpoint is cooling down — either rate-limited, or the
 * breaker above opened on it. Both mean the request is expected to fail, and a
 * request expected to fail still costs a full timeout.
 */
export function searchBreakerOpen(indexerId: string, db: Database = getDb()): boolean {
  try {
    const active = store.getActiveEndpoint(indexerId, db)
    return active?.cooldownUntil != null && active.cooldownUntil > Date.now()
  } catch {
    // Never let a bookkeeping failure remove an indexer from a search.
    return false
  }
}

export function searchBreakerHooks(db: Database = getDb()): AggregatorHooks {
  return {
    async onIndexerOutcome(outcome) {
      try {
        return await handleOutcome(outcome, db)
      } catch (err) {
        logger.error('Breaker failed, keeping original results:', err)
        return null
      }
    },
  }
}

async function handleOutcome(outcome: IndexerOutcome, db: Database): Promise<SearchResult[] | null> {
  const config = getIerConfig(db)
  if (!config.enabled) return null

  const indexerId = outcome.instance.config.id
  const active = store.getActiveEndpoint(indexerId, db)
  if (!active) return null

  const diagnostics = outcome.diagnostics
  const observed = diagnostics.httpStatus !== undefined
    || diagnostics.transportCode !== undefined
    || diagnostics.transportMessage !== undefined

  // Nothing was observed — a Torznab indexer, which does not report through
  // the executor. With no evidence there is no verdict to reach.
  if (!observed) return null

  // Same classifier as the scheduled probe. Two of them would drift, and the
  // breaker would start demoting endpoints the prober thinks are healthy.
  const { failureClass, retryAfterSec } = classifyDiagnostics(diagnostics)

  if (failureClass === 'rate_limited') {
    store.updateEndpointState(active.id, {
      cooldownUntil: Date.now() + Math.max(60, retryAfterSec ?? 300) * 1000,
    }, db)
    return null
  }

  // A real successful search is stronger evidence than a synthetic probe.
  // Restore the live endpoint immediately so a transient/ambiguous probe does
  // not leave a working indexer displayed as degraded for hours.
  if (!failureClass) {
    const viaCloudflareBypass = diagnostics.viaCloudflareBypass === true
    store.updateEndpointState(active.id, {
      tier: viaCloudflareBypass ? 'B' : 'A',
      requiresCloudflareBypass: viaCloudflareBypass,
      consecutiveFails: 0,
      lastOkAt: Date.now(),
      lastFailureClass: null,
      lastError: null,
      cooldownUntil: null,
    }, db)
    return null
  }

  // The request completed. Whether it matched rows is the query's business,
  // not the endpoint's, so this clears the counter rather than raising it.
  if (!ENDPOINT_AT_FAULT.has(failureClass)) {
    if (active.consecutiveFails > 0) {
      store.updateEndpointState(active.id, { consecutiveFails: 0 }, db)
    }
    return null
  }

  const consecutiveFails = active.consecutiveFails + 1
  store.updateEndpointState(active.id, {
    consecutiveFails,
    lastFailureClass: failureClass,
    lastError: outcome.diagnostics.transportMessage ?? null,
  }, db)
  emitFailed({ indexerId, endpointId: active.id, url: active.url, failureClass }, db)

  if (consecutiveFails < config.breakerThreshold) return null

  // Threshold reached: demote, queue an urgent probe, and resolve now.
  store.updateEndpointState(active.id, { tier: 'C', nextProbeAt: Date.now() }, db)
  const resolution = resolveIndexer(outcome.instance, db)

  if (!resolution.activeUrl || resolution.activeUrl === active.url) {
    // Nothing better to move to. The scheduled probe still decides when this
    // endpoint is healthy again, but until it says so the search path must stop
    // paying for it: an indexer whose only endpoint accepts connections and
    // never answers charged every query the full per-indexer timeout, forever,
    // because a demotion with no failover left it active and no timer ever
    // reconsidered it. The cooldown is what `searchBreakerOpen` reads to skip
    // it, and it is deliberately short — this opens the breaker, it does not
    // disable the indexer.
    store.updateEndpointState(active.id, {
      cooldownUntil: Date.now() + SEARCH_BREAKER_COOLDOWN_MS,
    }, db)
    logger.warn(
      `${outcome.instance.config.name}: ${active.url} returned ${humanFailure(failureClass)} `
      + `${consecutiveFails} times with no healthy alternative; skipping it in searches for `
      + `${Math.round(SEARCH_BREAKER_COOLDOWN_MS / 60_000)} minutes`,
    )
    enqueueEndpointResolve(indexerId, db)
    return null
  }

  logger.warn(
    `${outcome.instance.config.name}: ${active.url} returned ${humanFailure(failureClass)}; `
    + `retrying this search against ${resolution.activeUrl}`,
  )
  applyActiveEndpointToInstance(outcome.instance, resolution.activeUrl)

  try {
    // Exactly one retry, against the new endpoint, with the original query.
    return await Promise.race([
      runIndexerSearch(outcome.instance, outcome.query, {}),
      new Promise<null>(resolve => setTimeout(() => resolve(null), FAILOVER_SEARCH_TIMEOUT_MS)),
    ])
  } catch (err) {
    logger.error(`Failover search against ${resolution.activeUrl} failed:`, err)
    return null
  }
}

function enqueueEndpointResolve(indexerId: string, db: Database): void {
  try {
    enqueueUniqueJob({
      type: 'indexer-endpoint-resolve',
      subjectType: 'indexer',
      subjectId: indexerId,
      payload: { indexerId },
      maxAttempts: 1,
    }, db)
  } catch (err) {
    logger.error('Failed to enqueue endpoint resolution:', err)
  }
}
