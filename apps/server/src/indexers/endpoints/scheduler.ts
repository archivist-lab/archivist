import type { Database } from 'better-sqlite3'
import type { IerConfig, IndexerEndpoint } from '@archivist/contracts'
import type { IndexerInstance } from '@torrentstack/indexer-engine'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { getIndexerStore, reconcileIndexerStore } from '../../services/indexer-bridge.js'
import { registerJobHandler } from '../../system/job-runner.js'
import { enqueueUniqueJob } from '../../system/event-store.js'
import { getIerConfig } from './config.js'
import * as store from './store.js'
import { autoDisableIfDead, probeAndPersist, resolveIndexer } from './resolver.js'

const logger = createLogger('IER:scheduler')

/**
 * Indexer Endpoint Resolver — scheduling (spec §8).
 *
 * A due-time queue, not a monolithic sweep: endpoints carry their own
 * `next_probe_at`, and the worker drains whatever is due. Probing is the single
 * highest-risk part of the feature, so the concurrency and pacing controls
 * below are load-bearing rather than tuning knobs.
 */

/** Per-indexer floor between any two probes of any of its endpoints (§8.3). */
const lastIndexerProbeAt = new Map<string, number>()

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Decides which of the due endpoints may be probed on this tick.
 *
 * Never probes two mirrors of one tracker back to back — from the tracker's
 * side that is one client scanning its infrastructure, which is a distinctive
 * fingerprint and a plausible route to a ban.
 */
export function planProbeBatch(
  due: IndexerEndpoint[],
  opts: {
    now: number
    config: IerConfig
    lastProbeByIndexer: Map<string, number>
    isPrivate: (indexerId: string) => boolean
  },
): IndexerEndpoint[] {
  const batch: IndexerEndpoint[] = []
  const hostsUsed = new Set<string>()
  const indexersUsed = new Set<string>()
  const minGapMs = opts.config.perIndexerMinIntervalSec * 1000

  for (const endpoint of due) {
    if (batch.length >= opts.config.maxConcurrentProbes) break

    // One in-flight probe per host, so a mirror never sees two of our requests
    // at once.
    const host = hostOf(endpoint.url)
    if (hostsUsed.has(host)) continue

    if (indexersUsed.has(endpoint.indexerId)) continue
    const last = opts.lastProbeByIndexer.get(endpoint.indexerId)
    if (last !== undefined && opts.now - last < minGapMs) continue

    // Ratio-tracking sites do not need Archivist touching four mirrors a day,
    // so standby endpoints of a private tracker are probed reactively only.
    if (!endpoint.isActive && opts.isPrivate(endpoint.indexerId) && !opts.config.probeStandbyOnPrivate) {
      continue
    }

    batch.push(endpoint)
    hostsUsed.add(host)
    indexersUsed.add(endpoint.indexerId)
  }
  return batch
}

async function runDueProbes(db: Database = getDb()): Promise<number> {
  const config = getIerConfig(db)
  if (!config.enabled) return 0

  const now = Date.now()
  const store_ = getIndexerStore()
  const instances = new Map(store_.getAll().map(i => [i.config.id, i]))

  // Plan from the complete due set. Limiting before host/indexer/private
  // filtering lets a run of ineligible rows permanently hide healthy work
  // farther down the queue.
  const due = store.dueEndpoints(null, now, db)
  if (due.length === 0) return 0

  const batch = planProbeBatch(due, {
    now,
    config,
    lastProbeByIndexer: lastIndexerProbeAt,
    isPrivate: id => instances.get(id)?.definition?.type === 'private',
  })
  if (batch.length === 0) return 0

  const touchedIndexers = new Set<string>()
  await Promise.all(batch.map(async endpoint => {
    const instance = instances.get(endpoint.indexerId)
    if (!instance?.definition) return
    lastIndexerProbeAt.set(endpoint.indexerId, Date.now())
    try {
      await probeAndPersist(endpoint, instance, instance.definition, {
        trigger: 'scheduled', allowCloudflareBypass: false, db,
      })
      touchedIndexers.add(endpoint.indexerId)
    } catch (err) {
      logger.error(`Probe of ${endpoint.url} threw:`, err)
    }
  }))

  for (const indexerId of touchedIndexers) {
    const instance = instances.get(indexerId)
    if (!instance) continue
    try {
      resolveIndexer(instance, db)
      autoDisableIfDead(instance, db)
    } catch (err) {
      logger.error(`Resolution for ${indexerId} failed:`, err)
    }
  }

  return batch.length
}

/**
 * Probes every endpoint of one indexer and resolves. Used on create, on manual
 * re-resolve, and when the breaker needs an answer now.
 *
 * Runs sequentially. Popular definitions carry dozens of mirrors and several
 * search paths per mirror; probing them concurrently can starve real searches
 * and overload CloudflareBypass. Reactive/onboarding resolution stops at the
 * first proven A/B endpoint. A manual full resolution deliberately continues
 * through the complete candidate set, but remains low-impact.
 */
export async function resolveIndexerNow(
  instance: IndexerInstance,
  trigger: 'manual' | 'onboarding' | 'reactive',
  db: Database = getDb(),
): Promise<{ activeUrl: string | null; probed: number }> {
  if (!instance.definition) return { activeUrl: null, probed: 0 }
  const definition = instance.definition
  const endpoints = store.listEndpoints(instance.config.id, db).filter(e => e.isEnabled)

  // One in-flight probe per host, and never two at once against the same host.
  const queue = [...endpoints]
  const hostsInFlight = new Set<string>()
  let probed = 0
  let foundHealthy = false

  const worker = async (): Promise<void> => {
    for (;;) {
      if (foundHealthy && trigger !== 'manual') return
      const index = queue.findIndex(candidate => !hostsInFlight.has(hostOf(candidate.url)))
      if (index === -1) return
      const [endpoint] = queue.splice(index, 1)
      const host = hostOf(endpoint.url)
      hostsInFlight.add(host)
      try {
        const result = await probeAndPersist(endpoint, instance, definition, {
          trigger,
          // Scheduled/reactive work must not compete with acquisitions for the
          // browser bypass. Operators can explicitly request a full browser-
          // assisted measurement with the manual Resolve action.
          allowCloudflareBypass: trigger === 'manual',
          db,
        })
        probed += 1
        foundHealthy = result.tier === 'A' || result.tier === 'B'
      } catch (err) {
        logger.error(`Probe of ${endpoint.url} threw:`, err)
      } finally {
        hostsInFlight.delete(host)
      }
    }
  }

  await worker()
  lastIndexerProbeAt.set(instance.config.id, Date.now())

  const outcome = resolveIndexer(instance, db)
  return { activeUrl: outcome.activeUrl, probed }
}

let ticker: ReturnType<typeof setInterval> | null = null

export function registerEndpointResolverJobs(): void {
  registerJobHandler('indexer-endpoint-sweep', async () => {
    await runDueProbes()
  }, { lane: 'maintenance' })

  registerJobHandler('indexer-endpoint-resolve', async job => {
    const payload = JSON.parse(job.payload || '{}') as { indexerId?: string; trigger?: 'manual' | 'onboarding' | 'reactive' }
    if (!payload.indexerId) return
    // The API may have created the indexer immediately before this durable job
    // was claimed. Reconcile first so the worker never drops onboarding work
    // merely because its periodic registry tick has not run yet.
    reconcileIndexerStore()
    const instance = getIndexerStore().get(payload.indexerId)
    if (!instance) return
    const trigger = payload.trigger === 'manual' || payload.trigger === 'onboarding'
      ? payload.trigger
      : 'reactive'
    await resolveIndexerNow(instance, trigger)
  }, { lane: 'maintenance' })
}

/**
 * Queues a full re-probe of one indexer.
 *
 * Deliberately not done inline on the request: §8.3 requires a pause between
 * probes of the same indexer, so a tracker with several mirrors takes minutes.
 * A request that long dies at whatever proxy sits in front of Archivist, which
 * is why this returns a job rather than a decision.
 */
export function enqueueIndexerResolve(indexerId: string, trigger: 'manual' | 'onboarding' | 'reactive', db: Database = getDb()): number | null {
  return enqueueUniqueJob({
    type: 'indexer-endpoint-resolve',
    subjectType: 'indexer',
    subjectId: indexerId,
    payload: { indexerId, trigger },
    maxAttempts: 1,
  }, db)
}

/** Enqueues the sweep on a fixed tick; the due-time queue does the real pacing. */
export function startEndpointResolverScheduler(db: Database = getDb(), pollMs = 60_000): void {
  if (ticker) return
  const tick = () => {
    try {
      if (!getIerConfig(db).enabled) return
      const now = Date.now()
      const store_ = getIndexerStore()
      const instances = new Map(store_.getAll().map(i => [i.config.id, i]))
      const due = store.dueEndpoints(null, now, db)
      const eligible = planProbeBatch(due, {
        now,
        config: getIerConfig(db),
        lastProbeByIndexer: lastIndexerProbeAt,
        isPrivate: id => instances.get(id)?.definition?.type === 'private',
      })
      if (eligible.length === 0) return
      enqueueUniqueJob({
        type: 'indexer-endpoint-sweep',
        subjectType: 'system',
        subjectId: 'indexer-endpoints',
        payload: { scheduled: true },
        maxAttempts: 1,
      }, db)
    } catch (err) {
      logger.error('Scheduler tick failed:', err)
    }
  }
  ticker = setInterval(tick, pollMs)
  if (typeof ticker.unref === 'function') ticker.unref()
}

export function stopEndpointResolverScheduler(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
}

/** Test seam. */
export function __resetSchedulerState(): void {
  lastIndexerProbeAt.clear()
}

export { runDueProbes }
