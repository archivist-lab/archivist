import type { EndpointTier, IndexerEndpoint } from '@archivist/contracts'

/**
 * Indexer Endpoint Resolver — scoring and selection (spec §7).
 *
 * Pure: no clock beyond what is passed in, no database, no side effects. The
 * scheduler and resolver decide when to call this; it only decides what wins.
 */

export const TIER_WEIGHT: Record<EndpointTier, number> = {
  A: 1000, B: 400, C: 100, D: 0, unknown: 50,
}

/**
 * Added to the endpoint already in use. Doubles as the hysteresis band: a
 * challenger must beat the incumbent on raw merit, not on noise.
 */
export const INCUMBENCY_BONUS = 150

/** Score one endpoint. Higher wins. */
export function scoreEndpoint(endpoint: IndexerEndpoint): number {
  return (
    TIER_WEIGHT[endpoint.tier]
    + (endpoint.successRate7d ?? 0.5) * 200
    - Math.min((endpoint.latencyP50Ms ?? 0) / 10, 150)
    - Math.min(endpoint.consecutiveFails * 50, 200)
    + (endpoint.isActive ? INCUMBENCY_BONUS : 0)
    + (endpoint.origin === 'user' ? 50 : 0)
    - (endpoint.origin === 'legacy' ? 100 : 0)
  )
}

/** Score without the incumbency bonus, for the hysteresis comparison. */
export function rawScore(endpoint: IndexerEndpoint): number {
  return scoreEndpoint({ ...endpoint, isActive: false })
}

export type SelectionReason =
  | 'pinned'
  | 'no-incumbent'
  | 'incumbent-dead'
  | 'higher-score'
  | 'incumbent-retained'
  | 'throttled'
  | 'unreachable'

export interface Selection {
  /** The endpoint that should be active, or null when none is viable. */
  winner: IndexerEndpoint | null
  /** The endpoint that was active going in. */
  incumbent: IndexerEndpoint | null
  changed: boolean
  reason: SelectionReason
}

export interface SelectOptions {
  now: number
  /** When the indexer last switched, for the throttle (spec §7.3). */
  lastSwitchAt?: number | null
  switchThrottleMin: number
  /** Phase gate: when false, measure and report but never switch (spec §16). */
  autoSwitch: boolean
}

/**
 * Chooses the active endpoint for one indexer (spec §7.2).
 *
 * Rules, in order: a pinned endpoint wins unconditionally; a dead incumbent is
 * replaced immediately; otherwise a challenger must clear the incumbency bonus
 * on raw score, and the switch throttle, before it takes over.
 */
export function selectEndpoint(endpoints: IndexerEndpoint[], opts: SelectOptions): Selection {
  const incumbent = endpoints.find(e => e.isActive) ?? null

  const pinned = endpoints.find(e => e.isPinned && e.isEnabled)
  if (pinned) {
    return {
      winner: pinned,
      incumbent,
      changed: pinned.id !== incumbent?.id,
      reason: 'pinned',
    }
  }

  const candidates = endpoints.filter(e =>
    e.isEnabled && (e.cooldownUntil === null || e.cooldownUntil <= opts.now))

  const viable = candidates.filter(e => scoreEndpoint(e) > 0)
  if (viable.length === 0) {
    return { winner: null, incumbent, changed: incumbent !== null, reason: 'unreachable' }
  }

  const best = viable.reduce((a, b) => (scoreEndpoint(b) > scoreEndpoint(a) ? b : a))

  if (!incumbent) {
    return { winner: best, incumbent, changed: true, reason: 'no-incumbent' }
  }

  // A dead incumbent is replaced regardless of hysteresis or throttle, and this
  // is checked before the winner is compared: the incumbency bonus is large
  // enough that a dead endpoint can otherwise outscore a working alternative
  // and keep itself selected forever.
  const incumbentDead = incumbent.tier === 'D' || !incumbent.isEnabled
  if (incumbentDead) {
    const alternatives = viable.filter(e => e.id !== incumbent.id)
    if (alternatives.length > 0) {
      const replacement = alternatives.reduce((a, b) => (scoreEndpoint(b) > scoreEndpoint(a) ? b : a))
      return { winner: replacement, incumbent, changed: true, reason: 'incumbent-dead' }
    }
  }

  if (best.id === incumbent.id) {
    return { winner: incumbent, incumbent, changed: false, reason: 'incumbent-retained' }
  }

  if (!opts.autoSwitch) {
    return { winner: incumbent, incumbent, changed: false, reason: 'incumbent-retained' }
  }

  // Hysteresis: compare on merit alone. The incumbency bonus is the margin the
  // challenger has to find, which is what stops two near-identical mirrors
  // trading places on every sweep.
  if (rawScore(best) <= rawScore(incumbent)) {
    return { winner: incumbent, incumbent, changed: false, reason: 'incumbent-retained' }
  }

  const throttleMs = Math.max(0, opts.switchThrottleMin) * 60_000
  if (opts.lastSwitchAt && opts.now - opts.lastSwitchAt < throttleMs) {
    return { winner: incumbent, incumbent, changed: false, reason: 'throttled' }
  }

  return { winner: best, incumbent, changed: true, reason: 'higher-score' }
}

/** The endpoint verdict for a failure class (spec §6.3). */
export function tierForFailure(failureClass: string | undefined): EndpointTier {
  switch (failureClass) {
    case 'dns':
    case 'connect':
      return 'D'
    case 'timeout':
    case 'auth':
    case 'http_error':
    case 'parse':
    case 'empty':
      return 'C'
    // rate_limited never demotes: penalising an endpoint for being busy
    // demotes the indexer you use most.
    case 'rate_limited':
      return 'unknown'
    case 'challenge':
      return 'D'
    default:
      return 'C'
  }
}
