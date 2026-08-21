import type { Database } from 'better-sqlite3'
import type { EndpointTier, FailureClass } from '@archivist/contracts'
import { recordEvent } from '../../system/event-store.js'
import { getDb } from '../../db.js'

/**
 * Indexer Endpoint Resolver events (spec §9.3), emitted on the existing system
 * event spine — this repository's equivalent of the spec's CoreEvent bus.
 */

export function emitProbed(
  input: { indexerId: string; endpointId: number; url: string; outcome: 'ok' | 'fail'; tier: EndpointTier; latencyMs: number; viaCloudflareBypass: boolean },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'endpoint.probed',
    severity: 'debug',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: `Probed ${input.url}: ${input.outcome} (tier ${input.tier}, ${input.latencyMs}ms)`,
    data: input,
  }, db)
}

export function emitSwitched(
  input: { indexerId: string; indexerName: string; fromUrl: string | null; toUrl: string; reason: string },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'endpoint.switched',
    severity: 'info',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: input.fromUrl
      ? `${input.indexerName}: switched to ${input.toUrl} (${input.reason})`
      : `${input.indexerName}: selected ${input.toUrl}`,
    data: input,
  }, db)
}

export function emitFailed(
  input: { indexerId: string; endpointId: number; url: string; failureClass: FailureClass },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'endpoint.failed',
    severity: 'warn',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: `${input.url} failed: ${input.failureClass}`,
    data: input,
  }, db)
}

export function emitUnreachable(
  input: { indexerId: string; indexerName: string; endpointCount: number },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'unreachable',
    severity: 'error',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: `${input.indexerName} has no working endpoint (${input.endpointCount} tried)`,
    data: input,
  }, db)
}

export function emitDriftSuspected(
  input: { indexerId: string; indexerName: string; definitionId: string | null; endpointIds: number[] },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'definition.drift_suspected',
    severity: 'warn',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: `${input.indexerName}: ${input.endpointIds.length} endpoints fetched pages but matched no rows — the definition may be out of date`,
    data: input,
  }, db)
}

export function emitCredentialsSuspect(
  input: { indexerId: string; indexerName: string; endpointIds: number[] },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'credentials_suspect',
    severity: 'error',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: `${input.indexerName}: the same credentials were rejected by ${input.endpointIds.length} endpoints — check them before retrying`,
    data: input,
  }, db)
}

export function emitAutoDisabled(
  input: { indexerId: string; indexerName: string; days: number },
  db: Database = getDb(),
): void {
  recordEvent({
    category: 'indexer',
    action: 'auto_disabled',
    severity: 'warn',
    subjectType: 'indexer',
    subjectId: input.indexerId,
    message: `${input.indexerName} disabled: every endpoint has been dead for ${input.days} days`,
    data: input,
  }, db)
}
