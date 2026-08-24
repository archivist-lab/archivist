import type { Database } from 'better-sqlite3'
import type {
  EndpointOrigin, EndpointTier, FailureClass, IndexerEndpoint,
  IndexerProbeRecord, ProbeTrigger,
} from '@archivist/contracts'
import { getDb } from '../../db.js'

/**
 * Indexer Endpoint Resolver — persistence (spec §5).
 *
 * Every read returns the camelCase contract shape so nothing above this file
 * deals in column names.
 */

interface EndpointRow {
  id: number
  indexer_id: string
  url: string
  origin: string
  ordinal: number
  is_active: number
  is_enabled: number
  is_pinned: number
  tier: string
  requires_cloudflare_bypass: number
  score: number
  latency_p50_ms: number | null
  success_rate_7d: number | null
  consecutive_fails: number
  last_probe_at: number | null
  last_ok_at: number | null
  next_probe_at: number | null
  cooldown_until: number | null
  last_failure_class: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

function toEndpoint(row: EndpointRow): IndexerEndpoint {
  return {
    id: row.id,
    indexerId: row.indexer_id,
    url: row.url,
    origin: row.origin as EndpointOrigin,
    ordinal: row.ordinal,
    isActive: row.is_active === 1,
    isEnabled: row.is_enabled === 1,
    isPinned: row.is_pinned === 1,
    tier: row.tier as EndpointTier,
    requiresCloudflareBypass: row.requires_cloudflare_bypass === 1,
    score: row.score,
    latencyP50Ms: row.latency_p50_ms,
    successRate7d: row.success_rate_7d,
    consecutiveFails: row.consecutive_fails,
    lastProbeAt: row.last_probe_at,
    lastOkAt: row.last_ok_at,
    nextProbeAt: row.next_probe_at,
    cooldownUntil: row.cooldown_until,
    lastFailureClass: row.last_failure_class as FailureClass | null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Canonical endpoint URL: lowercase host, no trailing slash, https unless the
 * definition explicitly said http. Two spellings of one mirror must collapse to
 * one row or the measured history splits in half (spec §5.2.3).
 */
export function normaliseEndpointUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // A scheme we do not speak is rejected, not silently prefixed — otherwise
  // "ftp://site.org" would normalise to "https://ftp//site.org".
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (scheme && !/^https?$/i.test(scheme[1])) return null
  const withScheme = scheme ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hostname = url.hostname.toLowerCase()
  url.hash = ''
  url.search = ''
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

export function listEndpoints(indexerId: string, db: Database = getDb()): IndexerEndpoint[] {
  const rows = db.prepare(
    'SELECT * FROM indexer_endpoint WHERE indexer_id = ? ORDER BY ordinal ASC, id ASC',
  ).all(indexerId) as EndpointRow[]
  return rows.map(toEndpoint)
}

export function getEndpoint(endpointId: number, db: Database = getDb()): IndexerEndpoint | null {
  const row = db.prepare('SELECT * FROM indexer_endpoint WHERE id = ?').get(endpointId) as EndpointRow | undefined
  return row ? toEndpoint(row) : null
}

export function getActiveEndpoint(indexerId: string, db: Database = getDb()): IndexerEndpoint | null {
  const row = db.prepare(
    'SELECT * FROM indexer_endpoint WHERE indexer_id = ? AND is_active = 1 LIMIT 1',
  ).get(indexerId) as EndpointRow | undefined
  return row ? toEndpoint(row) : null
}

/**
 * Reconciles an indexer's candidate set with its definition (spec §5.2).
 *
 * Endpoints that vanish from a definition are disabled, never deleted: their
 * measured history is the expensive part, and a URL that comes back later
 * should resume with it intact. `origin='user'` rows are left alone entirely.
 */
export function seedEndpoints(
  indexerId: string,
  links: string[],
  legacyLinks: string[],
  db: Database = getDb(),
): { added: number; disabled: number; reenabled: number } {
  const now = Date.now()
  const wanted = new Map<string, { origin: EndpointOrigin; ordinal: number }>()

  links.forEach((link, index) => {
    const url = normaliseEndpointUrl(link)
    if (url && !wanted.has(url)) wanted.set(url, { origin: 'definition', ordinal: index })
  })
  legacyLinks.forEach((link, index) => {
    const url = normaliseEndpointUrl(link)
    if (url && !wanted.has(url)) wanted.set(url, { origin: 'legacy', ordinal: 1000 + index })
  })

  const existing = listEndpoints(indexerId, db)
  const byUrl = new Map(existing.map(e => [e.url, e]))

  const insert = db.prepare(`
    INSERT INTO indexer_endpoint
      (indexer_id, url, origin, ordinal, is_enabled, next_probe_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `)
  const reenable = db.prepare(
    'UPDATE indexer_endpoint SET is_enabled = 1, ordinal = ?, updated_at = ? WHERE id = ?',
  )
  const reorder = db.prepare('UPDATE indexer_endpoint SET ordinal = ?, updated_at = ? WHERE id = ?')
  const disable = db.prepare(
    'UPDATE indexer_endpoint SET is_enabled = 0, updated_at = ? WHERE id = ?',
  )

  let added = 0
  let disabled = 0
  let reenabled = 0

  const apply = db.transaction(() => {
    for (const [url, meta] of wanted) {
      const current = byUrl.get(url)
      if (!current) {
        insert.run(indexerId, url, meta.origin, meta.ordinal, now, now, now)
        added += 1
        continue
      }
      if (current.origin === 'user') continue
      if (!current.isEnabled) {
        reenable.run(meta.ordinal, now, current.id)
        reenabled += 1
      } else if (current.ordinal !== meta.ordinal) {
        reorder.run(meta.ordinal, now, current.id)
      }
    }
    for (const endpoint of existing) {
      if (endpoint.origin === 'user') continue
      if (wanted.has(endpoint.url)) continue
      if (!endpoint.isEnabled) continue
      disable.run(now, endpoint.id)
      disabled += 1
    }
  })
  apply()

  return { added, disabled, reenabled }
}

export function addUserEndpoint(indexerId: string, url: string, db: Database = getDb()): IndexerEndpoint | null {
  const normalised = normaliseEndpointUrl(url)
  if (!normalised) return null
  const now = Date.now()
  db.prepare(`
    INSERT INTO indexer_endpoint
      (indexer_id, url, origin, ordinal, is_enabled, next_probe_at, created_at, updated_at)
    VALUES (?, ?, 'user', 0, 1, ?, ?, ?)
    ON CONFLICT (indexer_id, url) DO UPDATE SET
      origin = 'user', is_enabled = 1, next_probe_at = excluded.next_probe_at, updated_at = excluded.updated_at
  `).run(indexerId, normalised, now, now, now)
  const row = db.prepare(
    'SELECT * FROM indexer_endpoint WHERE indexer_id = ? AND url = ?',
  ).get(indexerId, normalised) as EndpointRow | undefined
  return row ? toEndpoint(row) : null
}

/** Reconcile a Base URL chosen in the indexer form with the resolver. */
export function preferEndpoint(
  indexerId: string,
  url: string,
  db: Database = getDb(),
  options: { activate?: boolean } = {},
): IndexerEndpoint | null {
  const normalised = normaliseEndpointUrl(url)
  if (!normalised) return null

  let endpoint = listEndpoints(indexerId, db).find(candidate => candidate.url === normalised) ?? null
  if (!endpoint) endpoint = addUserEndpoint(indexerId, normalised, db)
  if (!endpoint) return null

  patchEndpoint(endpoint.id, { isEnabled: true, isPinned: true }, db)
  if (options.activate !== false) setActiveEndpoint(indexerId, endpoint.id, db)
  return getEndpoint(endpoint.id, db)
}

export function deleteUserEndpoint(endpointId: number, db: Database = getDb()): boolean {
  const result = db.prepare(
    "DELETE FROM indexer_endpoint WHERE id = ? AND origin = 'user'",
  ).run(endpointId)
  return result.changes > 0
}

export function patchEndpoint(
  endpointId: number,
  patch: { isEnabled?: boolean; isPinned?: boolean },
  db: Database = getDb(),
): IndexerEndpoint | null {
  const endpoint = getEndpoint(endpointId, db)
  if (!endpoint) return null
  const now = Date.now()
  const apply = db.transaction(() => {
    if (patch.isEnabled !== undefined) {
      db.prepare('UPDATE indexer_endpoint SET is_enabled = ?, updated_at = ? WHERE id = ?')
        .run(patch.isEnabled ? 1 : 0, now, endpointId)
    }
    if (patch.isPinned !== undefined) {
      // Pinning is exclusive: two pinned endpoints would make selection
      // non-deterministic.
      if (patch.isPinned) {
        db.prepare('UPDATE indexer_endpoint SET is_pinned = 0, updated_at = ? WHERE indexer_id = ?')
          .run(now, endpoint.indexerId)
      }
      db.prepare('UPDATE indexer_endpoint SET is_pinned = ?, updated_at = ? WHERE id = ?')
        .run(patch.isPinned ? 1 : 0, now, endpointId)
    }
  })
  apply()
  return getEndpoint(endpointId, db)
}

export function setActiveEndpoint(indexerId: string, endpointId: number | null, db: Database = getDb()): void {
  const now = Date.now()
  const apply = db.transaction(() => {
    db.prepare('UPDATE indexer_endpoint SET is_active = 0, updated_at = ? WHERE indexer_id = ? AND is_active = 1')
      .run(now, indexerId)
    if (endpointId !== null) {
      db.prepare('UPDATE indexer_endpoint SET is_active = 1, updated_at = ? WHERE id = ?').run(now, endpointId)
    }
  })
  apply()
}

export interface EndpointStateUpdate {
  tier?: EndpointTier
  requiresCloudflareBypass?: boolean
  score?: number
  latencyP50Ms?: number | null
  successRate7d?: number | null
  consecutiveFails?: number
  lastProbeAt?: number
  lastOkAt?: number | null
  nextProbeAt?: number | null
  cooldownUntil?: number | null
  lastFailureClass?: FailureClass | null
  lastError?: string | null
}

const STATE_COLUMNS: Record<keyof EndpointStateUpdate, string> = {
  tier: 'tier',
  requiresCloudflareBypass: 'requires_cloudflare_bypass',
  score: 'score',
  latencyP50Ms: 'latency_p50_ms',
  successRate7d: 'success_rate_7d',
  consecutiveFails: 'consecutive_fails',
  lastProbeAt: 'last_probe_at',
  lastOkAt: 'last_ok_at',
  nextProbeAt: 'next_probe_at',
  cooldownUntil: 'cooldown_until',
  lastFailureClass: 'last_failure_class',
  lastError: 'last_error',
}

export function updateEndpointState(
  endpointId: number,
  update: EndpointStateUpdate,
  db: Database = getDb(),
): void {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, column] of Object.entries(STATE_COLUMNS) as Array<[keyof EndpointStateUpdate, string]>) {
    const value = update[key]
    if (value === undefined) continue
    sets.push(`${column} = ?`)
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  values.push(Date.now(), endpointId)
  db.prepare(`UPDATE indexer_endpoint SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function recordProbe(
  endpointId: number,
  entry: {
    probedAt: number
    viaCloudflareBypass: boolean
    trigger: ProbeTrigger
    outcome: 'ok' | 'fail'
    failureClass?: FailureClass
    httpStatus?: number
    latencyMs?: number
    rowCount?: number
    errorDetail?: string
  },
  db: Database = getDb(),
): void {
  db.prepare(`
    INSERT INTO indexer_probe_result
      (endpoint_id, probed_at, via_cloudflare_bypass, trigger, outcome, failure_class,
       http_status, latency_ms, row_count, error_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    endpointId, entry.probedAt, entry.viaCloudflareBypass ? 1 : 0, entry.trigger, entry.outcome,
    entry.failureClass ?? null, entry.httpStatus ?? null, entry.latencyMs ?? null,
    entry.rowCount ?? null, entry.errorDetail?.slice(0, 500) ?? null,
  )
}

export function probeHistory(endpointId: number, days: number, db: Database = getDb()): IndexerProbeRecord[] {
  const since = Date.now() - Math.max(1, days) * 86_400_000
  const rows = db.prepare(`
    SELECT * FROM indexer_probe_result
    WHERE endpoint_id = ? AND probed_at >= ?
    ORDER BY probed_at DESC LIMIT 500
  `).all(endpointId, since) as Array<Record<string, unknown>>
  return rows.map(row => ({
    id: row.id as number,
    endpointId: row.endpoint_id as number,
    probedAt: row.probed_at as number,
    viaCloudflareBypass: row.via_cloudflare_bypass === 1,
    trigger: row.trigger as ProbeTrigger,
    outcome: row.outcome as 'ok' | 'fail',
    failureClass: (row.failure_class ?? null) as FailureClass | null,
    httpStatus: (row.http_status ?? null) as number | null,
    latencyMs: (row.latency_ms ?? null) as number | null,
    rowCount: (row.row_count ?? null) as number | null,
    errorDetail: (row.error_detail ?? null) as string | null,
  }))
}

/**
 * Rolling 7-day statistics. A counter alone cannot separate "flaky" from
 * "dead", which is the whole reason the probe log exists (spec §5.1).
 */
export function endpointStats(
  endpointId: number,
  db: Database = getDb(),
): { successRate7d: number | null; latencyP50Ms: number | null } {
  const since = Date.now() - 7 * 86_400_000
  const totals = db.prepare(`
    SELECT COUNT(*) AS n, SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok
    FROM indexer_probe_result WHERE endpoint_id = ? AND probed_at >= ?
  `).get(endpointId, since) as { n: number; ok: number | null }

  const successRate7d = totals.n > 0 ? (totals.ok ?? 0) / totals.n : null

  const latencies = db.prepare(`
    SELECT latency_ms FROM indexer_probe_result
    WHERE endpoint_id = ? AND probed_at >= ? AND outcome = 'ok' AND latency_ms IS NOT NULL
    ORDER BY latency_ms ASC
  `).all(endpointId, since) as Array<{ latency_ms: number }>

  const latencyP50Ms = latencies.length > 0
    ? latencies[Math.floor((latencies.length - 1) / 2)].latency_ms
    : null

  return { successRate7d, latencyP50Ms }
}

/** Endpoints whose probe is due, oldest first (spec §8.1). */
export function dueEndpoints(limit: number | null, now: number, db: Database = getDb()): IndexerEndpoint[] {
  const limitClause = limit === null ? '' : 'LIMIT ?'
  const statement = db.prepare(`
    SELECT * FROM indexer_endpoint
    WHERE is_enabled = 1
      AND (next_probe_at IS NULL OR next_probe_at <= ?)
      AND (cooldown_until IS NULL OR cooldown_until <= ?)
    ORDER BY (next_probe_at IS NULL) DESC, next_probe_at ASC
    ${limitClause}
  `)
  const rows = (limit === null ? statement.all(now, now) : statement.all(now, now, limit)) as EndpointRow[]
  return rows.map(toEndpoint)
}

/** Prunes probe history past its retention window (spec §5.1). */
export function pruneProbeHistory(retentionDays = 30, db: Database = getDb()): number {
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000
  return db.prepare('DELETE FROM indexer_probe_result WHERE probed_at < ?').run(cutoff).changes
}

export function getEndpointSessionCookies(endpointId: number, db: Database = getDb()): Record<string, string> {
  const row = db.prepare(
    'SELECT cookie_jar FROM indexer_endpoint_session WHERE endpoint_id = ?',
  ).get(endpointId) as { cookie_jar: string | null } | undefined
  if (!row?.cookie_jar) return {}
  try {
    return JSON.parse(row.cookie_jar) as Record<string, string>
  } catch {
    return {}
  }
}

export function setEndpointSessionCookies(
  endpointId: number,
  cookies: Record<string, string>,
  expiresAt: number | null = null,
  db: Database = getDb(),
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO indexer_endpoint_session (endpoint_id, cookie_jar, established_at, expires_at, last_used_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint_id) DO UPDATE SET
      cookie_jar = excluded.cookie_jar,
      established_at = excluded.established_at,
      expires_at = excluded.expires_at,
      last_used_at = excluded.last_used_at
  `).run(endpointId, JSON.stringify(cookies), now, expiresAt, now)
}

export function clearEndpointSession(endpointId: number, db: Database = getDb()): void {
  db.prepare('DELETE FROM indexer_endpoint_session WHERE endpoint_id = ?').run(endpointId)
}
