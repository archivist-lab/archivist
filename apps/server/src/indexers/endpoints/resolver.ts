import type { Database } from 'better-sqlite3'
import type { DefinitionEntry, IndexerInstance, ProbeResult } from '@torrentstack/indexer-engine'
import { chooseProbeQuery, probeEndpoint } from '@torrentstack/indexer-engine'
import type {
  EndpointTier, FailureClass, IerConfig, IndexerEndpoint, ProbeTrigger,
} from '@archivist/contracts'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { getIerConfig, getIndexerMode } from './config.js'
import * as store from './store.js'
import { scoreEndpoint, selectEndpoint, tierForFailure } from './scoring.js'
import {
  emitAutoDisabled, emitCredentialsSuspect, emitDriftSuspected, emitFailed,
  emitProbed, emitSwitched, emitUnreachable,
} from './events.js'

const logger = createLogger('IER')

/** When an indexer last changed active endpoint, for the switch throttle (§7.3). */
const lastSwitchAt = new Map<string, number>()
/** Endpoints whose next tier-B probe should test direct instead (§6.7). */
const tierBProbeCount = new Map<number, number>()
/** Drift and credential signals already reported, so they are raised once. */
const reportedDrift = new Map<string, string>()
const reportedCredentials = new Map<string, string>()
let activeCloudflareBypassProbes = 0
const cloudflareBypassWaiters: Array<() => void> = []

async function withCloudflareBypassProbeSlot<T>(limit: number, run: () => Promise<T>): Promise<T> {
  const boundedLimit = Math.max(1, limit)
  while (activeCloudflareBypassProbes >= boundedLimit) {
    await new Promise<void>(resolve => cloudflareBypassWaiters.push(resolve))
  }
  activeCloudflareBypassProbes += 1
  try {
    return await run()
  } finally {
    activeCloudflareBypassProbes -= 1
    cloudflareBypassWaiters.shift()?.()
  }
}

export interface ResolvedProbe extends ProbeResult {
  tier: EndpointTier
  requiresCloudflareBypass: boolean
}

/** The measurement function the ladder calls. Injectable so tests can assert
 *  exactly which failure classes reach for the browser. */
export type Prober = typeof probeEndpoint

/**
 * The probe ladder (spec §6.4).
 *
 * Reads and writes nothing: the caller supplies the endpoint's session and
 * persists the outcome. That is what keeps the ladder testable without a
 * database, and it is the separation §6.1 asks for.
 *
 * Direct first. A challenge — and only a challenge — earns a retry through
 * CloudflareBypass, because a bot wall is the one failure a headless browser can
 * actually clear. A parse failure retried through a browser burns an expensive
 * instance to reproduce the same selector miss.
 */
export async function probeEndpointResolved(
  endpoint: IndexerEndpoint,
  instance: IndexerInstance,
  entry: DefinitionEntry,
  opts: {
    allowCloudflareBypass: boolean
    forceDirect?: boolean
    config: IerConfig
    probe?: Prober
    /** Session for this endpoint, supplied by the caller — see the note above. */
    cookies?: Record<string, string>
  },
): Promise<ResolvedProbe> {
  const probe = opts.probe ?? probeEndpoint
  const plan = chooseProbeQuery(entry)
  const cookies = opts.cookies ?? {}
  const base = {
    mode: plan.mode,
    probeTerm: plan.term,
    proxyUrl: instance.proxyUrl,
    settings: instance.config.settings as Record<string, string | number | boolean>,
    cookies,
  }

  const direct = await probe(endpoint.url, entry, {
    ...base,
    allowCloudflareBypass: false,
  })
  if (direct.outcome === 'ok') {
    return { ...direct, tier: 'A', requiresCloudflareBypass: false }
  }

  // Browse mode is inferred from the definition, and the inference is
  // optimistic: plenty of trackers accept a keywordless request and answer with
  // an empty results page. That looks identical to a drifted selector. Rather
  // than trust the guess, ask again with a real term before concluding
  // anything — a site that answers a keyword search is working.
  if (plan.mode === 'browse' && (direct.failureClass === 'parse' || direct.failureClass === 'empty')) {
    const keyword = await probe(endpoint.url, entry, {
      ...base,
      mode: 'search',
      probeTerm: keywordFallbackFor(entry),
      allowCloudflareBypass: false,
    })
    if (keyword.outcome === 'ok') {
      return { ...keyword, tier: 'A', requiresCloudflareBypass: false }
    }
    // Both a browse and a keyword search came back without rows: now the
    // selector really is the suspect.
    if (keyword.failureClass === 'parse' || keyword.failureClass === 'empty') {
      return { ...keyword, tier: 'C', requiresCloudflareBypass: endpoint.requiresCloudflareBypass }
    }
  }

  // A definition that cannot browse makes `empty` ambiguous, so one empty
  // result is not enough to act on (spec §6.2).
  if (direct.failureClass === 'empty' && plan.confidence === 'low' && endpoint.consecutiveFails === 0) {
    return { ...direct, tier: endpoint.tier === 'unknown' ? 'C' : endpoint.tier, requiresCloudflareBypass: endpoint.requiresCloudflareBypass }
  }

  const canUseFlare = opts.allowCloudflareBypass
    && !opts.forceDirect
    && opts.config.allowCloudflareBypassProbes
    && Boolean(instance.cloudflareBypassUrl)

  if (direct.failureClass === 'challenge' && canUseFlare) {
    const solved = await withCloudflareBypassProbeSlot(
      opts.config.maxConcurrentCloudflareBypassProbes,
      () => probe(endpoint.url, entry, {
        ...base,
        allowCloudflareBypass: true,
        cloudflareBypassUrl: instance.cloudflareBypassUrl,
      }),
    )
    if (solved.outcome === 'ok') {
      return { ...solved, tier: 'B', requiresCloudflareBypass: true }
    }
    // A saturated or unreachable bypass is the absence of a tool, not a verdict
    // on the site — the same rule §6.6 applies when it is unconfigured. Marking
    // the endpoint dead here would strand every Cloudflare-fronted indexer
    // whenever the browser pool is briefly full.
    if (solved.failureClass === 'bypass_unavailable') {
      return { ...solved, tier: endpoint.tier, requiresCloudflareBypass: true }
    }
    return { ...solved, tier: 'D', requiresCloudflareBypass: true }
  }

  // CloudflareBypass is unconfigured or unhealthy: an endpoint that previously
  // needed it keeps its last-known tier rather than being demoted for the
  // absence of a tool (spec §6.6).
  if (direct.failureClass === 'challenge' && endpoint.tier === 'B') {
    return { ...direct, tier: 'B', requiresCloudflareBypass: true }
  }

  return {
    ...direct,
    tier: tierForFailure(direct.failureClass),
    requiresCloudflareBypass: endpoint.requiresCloudflareBypass,
  }
}

/** A term that should return rows on any working tracker of this kind. */
function keywordFallbackFor(entry: DefinitionEntry): string {
  const haystack = `${entry.id} ${entry.name} ${entry.description}`
  if (/music|audio|flac|mp3/i.test(haystack)) return 'flac'
  if (/book|ebook|comic|magazine/i.test(haystack)) return 'epub'
  return '1080p'
}

/** Probe cadence by tier, with the jitter that keeps installs off a shared clock (§8.2). */
export function nextProbeDelayMs(
  tier: EndpointTier,
  opts: { isActive: boolean; consecutiveFails: number; deadSinceDays: number; config: IerConfig },
  random: () => number = Math.random,
): number {
  const hour = 3_600_000
  let base: number
  switch (tier) {
    case 'A':
      base = (opts.isActive ? opts.config.probeIntervalTierAHours : opts.config.probeIntervalTierAHours * 2) * hour
      break
    case 'B':
      base = opts.config.probeIntervalTierBHours * hour
      break
    case 'C': {
      const backoff = 2 ** Math.max(0, opts.consecutiveFails - 1)
      base = Math.min(opts.config.probeIntervalDegradedHours * hour * backoff, 6 * hour)
      break
    }
    case 'D':
      base = opts.deadSinceDays >= 7 ? 72 * hour : opts.config.probeIntervalDeadHours * hour
      break
    default:
      return 0
  }
  const jitter = 1 + (random() * 0.5 - 0.25) // ±25%
  return Math.round(base * jitter)
}

/** Whether this scheduled probe of a tier-B endpoint should test direct (§6.7). */
export function shouldRunDemotionTest(endpointId: number): boolean {
  const count = (tierBProbeCount.get(endpointId) ?? 0) + 1
  tierBProbeCount.set(endpointId, count)
  return count % 4 === 0
}

export interface ProbeAndPersistOptions {
  trigger: ProbeTrigger
  allowCloudflareBypass?: boolean
  forceDirect?: boolean
  db?: Database
}

/** Probes one endpoint, writes the measurement, and returns the verdict. */
export async function probeAndPersist(
  endpoint: IndexerEndpoint,
  instance: IndexerInstance,
  entry: DefinitionEntry,
  opts: ProbeAndPersistOptions,
): Promise<ResolvedProbe> {
  const db = opts.db ?? getDb()
  const config = getIerConfig(db)
  const forceDirect = opts.forceDirect ?? (endpoint.tier === 'B' && opts.trigger === 'scheduled' && shouldRunDemotionTest(endpoint.id))

  const result = await probeEndpointResolved(endpoint, instance, entry, {
    allowCloudflareBypass: opts.allowCloudflareBypass ?? true,
    forceDirect,
    config,
    cookies: store.getEndpointSessionCookies(endpoint.id, db),
  })

  const now = Date.now()
  store.recordProbe(endpoint.id, {
    probedAt: now,
    viaCloudflareBypass: result.viaCloudflareBypass,
    trigger: opts.trigger,
    outcome: result.outcome,
    failureClass: result.failureClass,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    rowCount: result.rowCount,
    errorDetail: result.errorDetail,
  }, db)

  const stats = store.endpointStats(endpoint.id, db)
  const ok = result.outcome === 'ok'

  // Being rate limited says nothing about the endpoint's quality — it says we
  // used it. Penalising it here demotes the indexer you rely on most.
  const rateLimited = result.failureClass === 'rate_limited'
  // Likewise when our own bypass was saturated or unreachable: the endpoint was
  // never contacted, so it keeps the verdict the last real probe reached.
  const inconclusive = rateLimited
    || result.failureClass === 'bypass_unavailable'
    || result.failureClass === 'proxy_unavailable'
  const consecutiveFails = ok || inconclusive ? 0 : endpoint.consecutiveFails + 1
  const tier = inconclusive ? endpoint.tier : result.tier

  const deadSinceDays = tier === 'D' && endpoint.lastOkAt
    ? (now - endpoint.lastOkAt) / 86_400_000
    : 0

  const cooldownUntil = rateLimited
    ? now + Math.max(60, result.retryAfterSec ?? 300) * 1000
    : null

  const updated: IndexerEndpoint = {
    ...endpoint,
    tier,
    requiresCloudflareBypass: result.requiresCloudflareBypass,
    consecutiveFails,
    successRate7d: stats.successRate7d,
    latencyP50Ms: stats.latencyP50Ms,
    isActive: endpoint.isActive,
  }

  store.updateEndpointState(endpoint.id, {
    tier,
    requiresCloudflareBypass: result.requiresCloudflareBypass,
    consecutiveFails,
    successRate7d: stats.successRate7d,
    latencyP50Ms: stats.latencyP50Ms,
    score: scoreEndpoint(updated),
    lastProbeAt: now,
    lastOkAt: ok ? now : endpoint.lastOkAt,
    lastFailureClass: ok ? null : (result.failureClass ?? 'unknown'),
    lastError: ok ? null : (result.errorDetail ?? null),
    cooldownUntil,
    nextProbeAt: now + nextProbeDelayMs(tier, {
      isActive: endpoint.isActive,
      consecutiveFails,
      deadSinceDays,
      config,
    }),
  }, db)

  emitProbed({
    indexerId: endpoint.indexerId,
    endpointId: endpoint.id,
    url: endpoint.url,
    outcome: result.outcome,
    tier,
    latencyMs: result.latencyMs,
    viaCloudflareBypass: result.viaCloudflareBypass,
  }, db)

  if (!ok && result.failureClass) {
    emitFailed({
      indexerId: endpoint.indexerId,
      endpointId: endpoint.id,
      url: endpoint.url,
      failureClass: result.failureClass,
    }, db)
  }

  return result
}

export interface ResolutionOutcome {
  indexerId: string
  activeUrl: string | null
  changed: boolean
  reason: string
}

/**
 * Scores every endpoint of one indexer and applies the selection (spec §7).
 * Never probes — callers probe first, then resolve.
 */
export function resolveIndexer(
  instance: IndexerInstance,
  db: Database = getDb(),
): ResolutionOutcome {
  const indexerId = instance.config.id
  const config = getIerConfig(db)
  const endpoints = store.listEndpoints(indexerId, db)
  if (endpoints.length === 0) {
    return { indexerId, activeUrl: null, changed: false, reason: 'no-endpoints' }
  }

  const manual = getIndexerMode(instance.config.settings as Record<string, unknown>) === 'manual'
  const selection = selectEndpoint(endpoints, {
    now: Date.now(),
    lastSwitchAt: lastSwitchAt.get(indexerId) ?? null,
    switchThrottleMin: config.switchThrottleMin,
    autoSwitch: config.autoSwitch && !manual,
  })

  detectDefinitionDrift(instance, endpoints, db)
  detectCredentialTrouble(instance, endpoints, db)

  if (!selection.winner) {
    if (selection.incumbent) store.setActiveEndpoint(indexerId, null, db)
    emitUnreachable({
      indexerId,
      indexerName: instance.config.name,
      endpointCount: endpoints.length,
    }, db)
    return { indexerId, activeUrl: null, changed: selection.changed, reason: selection.reason }
  }

  if (selection.changed) {
    store.setActiveEndpoint(indexerId, selection.winner.id, db)
    lastSwitchAt.set(indexerId, Date.now())
    emitSwitched({
      indexerId,
      indexerName: instance.config.name,
      fromUrl: selection.incumbent?.url ?? null,
      toUrl: selection.winner.url,
      reason: describeReason(selection.reason, selection.incumbent?.lastFailureClass ?? null),
    }, db)
    applyActiveEndpointToInstance(instance, selection.winner.url)
  } else if (selection.winner.isActive === false) {
    // First resolution for a fresh indexer: no incumbent to announce.
    store.setActiveEndpoint(indexerId, selection.winner.id, db)
    applyActiveEndpointToInstance(instance, selection.winner.url)
  }

  return {
    indexerId,
    activeUrl: selection.winner.url,
    changed: selection.changed,
    reason: selection.reason,
  }
}

function describeReason(reason: string, failureClass: FailureClass | null): string {
  if (reason === 'incumbent-dead') {
    return failureClass ? `previous endpoint returned ${humanFailure(failureClass)}` : 'previous endpoint was unreachable'
  }
  if (reason === 'pinned-unhealthy') return 'the preferred endpoint became unhealthy'
  if (reason === 'higher-score') return 'a faster, more reliable endpoint became available'
  if (reason === 'pinned') return 'pinned by you'
  return reason
}

/** Failure classes rendered as sentences, for the activity feed and UI (spec §12). */
export function humanFailure(failureClass: FailureClass): string {
  switch (failureClass) {
    case 'dns': return 'a DNS lookup failure'
    case 'connect': return 'a connection failure'
    case 'timeout': return 'a timeout'
    case 'challenge': return 'a Cloudflare challenge'
    case 'bypass_unavailable': return 'the Cloudflare bypass being unavailable'
    case 'proxy_unavailable': return 'the configured proxy being unreachable'
    case 'rate_limited': return 'a rate limit'
    case 'auth': return 'an authentication failure'
    case 'http_error': return 'a server error'
    case 'parse': return 'a page that matched no results'
    case 'empty': return 'an empty result set'
    default: return 'an unknown failure'
  }
}

/**
 * Two endpoints of one definition fetching pages but matching no rows is a
 * near-conclusive signal that the definition broke upstream, not that both
 * sites went wrong the same way (spec §10.2).
 */
function detectDefinitionDrift(instance: IndexerInstance, endpoints: IndexerEndpoint[], db: Database): void {
  const drifting = endpoints.filter(e => e.lastFailureClass === 'parse')
  const indexerId = instance.config.id
  if (drifting.length < 2) {
    reportedDrift.delete(indexerId)
    return
  }
  // Resolution runs on every probe, so without this the same suspicion is
  // re-announced dozens of times during one sweep.
  const signature = drifting.map(e => e.id).sort((a, b) => a - b).join(',')
  if (reportedDrift.get(indexerId) === signature) return
  reportedDrift.set(indexerId, signature)
  emitDriftSuspected({
    indexerId: instance.config.id,
    indexerName: instance.config.name,
    definitionId: instance.config.definitionId ?? null,
    endpointIds: drifting.map(e => e.id),
  }, db)
}

/**
 * The same credentials rejected by two mirrors is a credentials problem.
 * Retrying them across five more is how accounts get locked (spec §6.5).
 */
function detectCredentialTrouble(instance: IndexerInstance, endpoints: IndexerEndpoint[], db: Database): void {
  const rejected = endpoints.filter(e => e.lastFailureClass === 'auth')
  const indexerId = instance.config.id
  if (rejected.length < 2) {
    reportedCredentials.delete(indexerId)
    return
  }
  const signature = rejected.map(e => e.id).sort((a, b) => a - b).join(',')
  if (reportedCredentials.get(indexerId) === signature) return
  reportedCredentials.set(indexerId, signature)
  emitCredentialsSuspect({
    indexerId: instance.config.id,
    indexerName: instance.config.name,
    endpointIds: rejected.map(e => e.id),
  }, db)
}

/** Points the live instance at the chosen endpoint so the next search uses it. */
export function applyActiveEndpointToInstance(instance: IndexerInstance, url: string): void {
  instance.config.baseUrl = url
  instance.config.settings = { ...instance.config.settings, sitelink: url }
}

/**
 * An indexer whose endpoints have all been dead for the configured window is
 * disabled rather than deleted: it stops adding latency and log noise to every
 * search, and the user can re-enable it (spec §10.1).
 */
export function autoDisableIfDead(instance: IndexerInstance, db: Database = getDb()): boolean {
  const config = getIerConfig(db)
  if (!config.enabled) return false
  const endpoints = store.listEndpoints(instance.config.id, db).filter(e => e.isEnabled)
  if (endpoints.length === 0) return false
  if (!endpoints.every(e => e.tier === 'D')) return false

  const cutoff = Date.now() - config.autoDisableAfterDays * 86_400_000
  const everOk = endpoints.some(e => e.lastOkAt !== null && e.lastOkAt > cutoff)
  if (everOk) return false
  // Never auto-disable an indexer we have not measured for long enough.
  const measuredLongEnough = endpoints.every(e => e.lastProbeAt !== null && e.createdAt < cutoff)
  if (!measuredLongEnough) return false

  db.prepare('UPDATE indexers_ts SET enabled = 0, updated_at = ? WHERE id = ?')
    .run(Date.now(), instance.config.id)
  instance.config.enabled = false
  emitAutoDisabled({
    indexerId: instance.config.id,
    indexerName: instance.config.name,
    days: config.autoDisableAfterDays,
  }, db)
  logger.warn(`Auto-disabled ${instance.config.name}: every endpoint dead for ${config.autoDisableAfterDays} days`)
  return true
}

/** Test seam: the switch throttle and demotion counters are process state. */
export function __resetResolverState(): void {
  lastSwitchAt.clear()
  tierBProbeCount.clear()
  reportedDrift.clear()
  reportedCredentials.clear()
  activeCloudflareBypassProbes = 0
  cloudflareBypassWaiters.splice(0)
}
