import type { IndexerHealth, IndexerRssState } from './state-store.js'

const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 60 * 60 * 1000
const DEGRADED_AT = 3
const UNHEALTHY_AT = 6

export interface PollOutcome {
  fetched: number
  newReleases: number
  grabbed: number
}

export function applySuccess(state: IndexerRssState, outcome: PollOutcome, now = Date.now()): IndexerRssState {
  return {
    ...state,
    lastPolledAt: now,
    lastSuccessAt: now,
    lastReleasesFound: outcome.fetched,
    lastReleasesGrabbed: outcome.grabbed,
    consecutiveFailures: 0,
    backoffUntil: null,
    lastError: null,
    health: 'healthy',
  }
}

export function applyFailure(state: IndexerRssState, error: string, now = Date.now()): IndexerRssState {
  const failures = state.consecutiveFailures + 1
  const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, failures - 1), BACKOFF_MAX_MS)
  let health: IndexerHealth = state.health
  if (failures >= UNHEALTHY_AT) health = 'unhealthy'
  else if (failures >= DEGRADED_AT) health = 'degraded'
  return {
    ...state,
    lastPolledAt: now,
    lastFailureAt: now,
    consecutiveFailures: failures,
    backoffUntil: now + backoffMs,
    lastError: error.slice(0, 1000),
    health,
  }
}

/**
 * When to next poll. `rapidIntervalMs` (set during a rapid air-time window)
 * shortens the effective interval, but backoff always wins — a failing indexer
 * is never rapid-polled.
 */
export function nextPollAt(state: IndexerRssState, rapidIntervalMs?: number): number {
  const interval = rapidIntervalMs != null ? Math.min(rapidIntervalMs, state.pollIntervalMs) : state.pollIntervalMs
  const lastPoll = state.lastPolledAt ?? 0
  const scheduled = lastPoll === 0 ? 0 : lastPoll + interval
  if (state.backoffUntil && state.backoffUntil > scheduled) return state.backoffUntil
  return scheduled
}

export function isReadyToPoll(state: IndexerRssState, now = Date.now(), rapidIntervalMs?: number): boolean {
  return nextPollAt(state, rapidIntervalMs) <= now
}
