import { z } from 'zod'

/**
 * Indexer Endpoint Resolver (IER) contracts.
 *
 * Spec: docs/11-new-feature-briefs/indexer-endpoint-resolver-spec.md
 *
 * Naming reconciliation against the spec (§0.4): the spec's "Trawl" is this
 * repository's CloudflareBypass integration, and its `@mediastack/core` is
 * `@archivist/contracts`. The concepts are unchanged; only the names differ.
 */

/** Coarse quality class of an endpoint (spec §3). */
export const EndpointTier = z.enum(['A', 'B', 'C', 'D', 'unknown'])
export type EndpointTier = z.infer<typeof EndpointTier>

/** Structured reason a probe failed. Drives the retry decision (spec §6.3). */
export const FailureClass = z.enum([
  'dns',          // resolution failed
  'connect',      // TCP/TLS failure, refused, transport-level timeout
  'timeout',      // request exceeded budget
  'challenge',    // bot wall: Cloudflare / DDoS-Guard interstitial
  'rate_limited', // 429, Retry-After, or a definition-declared throttle response
  'auth',         // 401/403 without challenge markers, or a login form came back
  'http_error',   // 5xx, unexpected 4xx
  'parse',        // 200 but the definition's row selectors did not match
  'empty',        // 200, selectors matched, zero rows on a browse probe
  'bypass_unavailable', // our Cloudflare bypass was saturated or unreachable
  'proxy_unavailable', // the configured egress proxy could not be reached
  'unknown',
])
export type FailureClass = z.infer<typeof FailureClass>

/** Where an endpoint came from (spec §5.2). */
export const EndpointOrigin = z.enum(['definition', 'legacy', 'user'])
export type EndpointOrigin = z.infer<typeof EndpointOrigin>

/** What caused a probe to run. */
export const ProbeTrigger = z.enum(['scheduled', 'reactive', 'manual', 'onboarding'])
export type ProbeTrigger = z.infer<typeof ProbeTrigger>

/** The result of one measurement. `probeEndpoint` returns this and nothing else. */
export const ProbeResult = z.object({
  outcome: z.enum(['ok', 'fail']),
  viaCloudflareBypass: z.boolean(),
  failureClass: FailureClass.optional(),
  httpStatus: z.number().int().optional(),
  latencyMs: z.number().int(),
  rowCount: z.number().int().optional(),
  errorDetail: z.string().optional(),
  /** Seconds the server asked us to wait, from Retry-After. */
  retryAfterSec: z.number().int().optional(),
})
export type ProbeResult = z.infer<typeof ProbeResult>

/** One candidate base URL with its measured state (spec §5.1). */
export const IndexerEndpoint = z.object({
  id: z.number().int(),
  indexerId: z.string(),
  url: z.string(),
  origin: EndpointOrigin,
  ordinal: z.number().int(),

  isActive: z.boolean(),
  isEnabled: z.boolean(),
  isPinned: z.boolean(),

  tier: EndpointTier,
  requiresCloudflareBypass: z.boolean(),
  score: z.number(),
  latencyP50Ms: z.number().int().nullable(),
  successRate7d: z.number().nullable(),
  consecutiveFails: z.number().int(),

  lastProbeAt: z.number().int().nullable(),
  lastOkAt: z.number().int().nullable(),
  nextProbeAt: z.number().int().nullable(),
  cooldownUntil: z.number().int().nullable(),

  lastFailureClass: FailureClass.nullable(),
  lastError: z.string().nullable(),

  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type IndexerEndpoint = z.infer<typeof IndexerEndpoint>

/** One row of append-only probe history, for the sparkline (spec §5.1). */
export const IndexerProbeRecord = z.object({
  id: z.number().int(),
  endpointId: z.number().int(),
  probedAt: z.number().int(),
  viaCloudflareBypass: z.boolean(),
  trigger: ProbeTrigger,
  outcome: z.enum(['ok', 'fail']),
  failureClass: FailureClass.nullable(),
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  rowCount: z.number().int().nullable(),
  errorDetail: z.string().nullable(),
})
export type IndexerProbeRecord = z.infer<typeof IndexerProbeRecord>

/** Health pill shown against an indexer in the list (spec §12). */
export const IndexerHealthState = z.enum(['direct', 'cloudflareBypass', 'degraded', 'down', 'unknown'])
export type IndexerHealthState = z.infer<typeof IndexerHealthState>

export const IndexerEndpointHealth = z.object({
  indexerId: z.string(),
  name: z.string(),
  state: IndexerHealthState,
  pinned: z.boolean(),
  activeUrl: z.string().nullable(),
  tier: EndpointTier,
  lastOkAt: z.number().int().nullable(),
  endpointCount: z.number().int(),
  credentialsSuspect: z.boolean(),
})
export type IndexerEndpointHealth = z.infer<typeof IndexerEndpointHealth>

// ─── Request bodies (spec §11) ────────────────────────────────────────────────

export const AddEndpointBody = z.object({
  url: z.string().url(),
})
export type AddEndpointBody = z.infer<typeof AddEndpointBody>

export const PatchEndpointBody = z.object({
  isEnabled: z.boolean().optional(),
  isPinned: z.boolean().optional(),
}).refine(body => body.isEnabled !== undefined || body.isPinned !== undefined, {
  message: 'Provide isEnabled or isPinned',
})
export type PatchEndpointBody = z.infer<typeof PatchEndpointBody>

export const ProbeEndpointBody = z.object({
  allowCloudflareBypass: z.boolean().optional(),
})
export type ProbeEndpointBody = z.infer<typeof ProbeEndpointBody>

/** Per-indexer resolver mode. `manual` is equivalent to pinning (spec §13). */
export const IerMode = z.enum(['auto', 'manual'])
export type IerMode = z.infer<typeof IerMode>

/** Global resolver settings (spec §13). */
export const IerConfig = z.object({
  enabled: z.boolean(),
  probeIntervalTierAHours: z.number().int().min(1).max(168),
  probeIntervalTierBHours: z.number().int().min(1).max(168),
  probeIntervalDegradedHours: z.number().int().min(1).max(168),
  probeIntervalDeadHours: z.number().int().min(1).max(336),
  maxConcurrentProbes: z.number().int().min(1).max(32),
  maxConcurrentCloudflareBypassProbes: z.number().int().min(1).max(8),
  perIndexerMinIntervalSec: z.number().int().min(0).max(3600),
  breakerThreshold: z.number().int().min(1).max(20),
  switchThrottleMin: z.number().int().min(0).max(1440),
  allowCloudflareBypassProbes: z.boolean(),
  probeStandbyOnPrivate: z.boolean(),
  autoDisableAfterDays: z.number().int().min(1).max(365),
  /** Phase gate: when false the resolver measures but never switches (spec §16). */
  autoSwitch: z.boolean(),
})
export type IerConfig = z.infer<typeof IerConfig>

export const DEFAULT_IER_CONFIG: IerConfig = {
  enabled: true,
  probeIntervalTierAHours: 12,
  probeIntervalTierBHours: 6,
  probeIntervalDegradedHours: 1,
  probeIntervalDeadHours: 24,
  maxConcurrentProbes: 4,
  maxConcurrentCloudflareBypassProbes: 2,
  perIndexerMinIntervalSec: 60,
  breakerThreshold: 3,
  switchThrottleMin: 10,
  allowCloudflareBypassProbes: true,
  probeStandbyOnPrivate: false,
  autoDisableAfterDays: 14,
  autoSwitch: true,
}
