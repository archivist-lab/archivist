import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

/**
 * Scoped app settings over the unified DB. Scope 0 is the global scope
 * (legacy shared.db); a library id scopes to that library (legacy tab DB).
 */

export function getAppSetting<T>(key: string, def: T, scope = 0, db: Database = getDb()): T {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE library_id = ? AND key = ?').get(scope, key) as { value: string } | undefined
    return row ? JSON.parse(row.value) as T : def
  } catch {
    return def
  }
}

export function setAppSetting(key: string, value: unknown, scope = 0, db: Database = getDb()): void {
  db.prepare('INSERT OR REPLACE INTO app_settings (library_id, key, value) VALUES (?, ?, ?)').run(scope, key, JSON.stringify(value))
}

// ── Quality tiers (legacy defaults preserved) ────────────────────────────────

// Tier types and the built-in default group tiers live in @archivist/core so
// that search (here) and ranking (core scoring / services) share one source.
// Per-library overrides still win via getTierTermsForMedia below.
import { DEFAULT_TIERS } from '@archivist/core'
import type { TierMediaType, TierTerm, TierConfig } from '@archivist/core'
export { DEFAULT_TIERS }
export type { TierMediaType, TierTerm, TierConfig }

/**
 * Tier terms for a media type. Checks the given scope first, then the global
 * scope, then the built-in defaults (legacy read shared.db only; Archivist lets a
 * library override its own tiers because settings writes are library-scoped).
 */
export function getTierTermsForMedia(mediaType: TierMediaType, scope = 0, db: Database = getDb()): { tier1: string[]; tier2: string[]; tier3: string[] } {
  const filter = (config: TierConfig) => ({
    tier1: config.tier1.filter(t => t.mediaTypes.includes(mediaType)).map(t => t.term),
    tier2: config.tier2.filter(t => t.mediaTypes.includes(mediaType)).map(t => t.term),
    tier3: config.tier3.filter(t => t.mediaTypes.includes(mediaType)).map(t => t.term),
  })
  try {
    for (const s of scope !== 0 ? [scope, 0] : [0]) {
      const row = db.prepare("SELECT value FROM app_settings WHERE library_id = ? AND key = 'qualityTiers'").get(s) as { value: string } | undefined
      if (row) return filter(JSON.parse(row.value) as TierConfig)
    }
  } catch {}
  return filter(DEFAULT_TIERS)
}

// Media types that carry quality tiers (books have none — plain-title search).
const TIER_MEDIA_TYPES: ReadonlySet<string> = new Set(['films', 'series', 'music', 'games', 'comics'])

/**
 * Expand a query base into the tiered escalation list — `${base} ${term}` for
 * every term in Tier 1 → 2 → 3, then the bare base (Broad). A specific
 * `targetTier` narrows to just that tier. Tier terms are read at `scope` so
 * per-library overrides apply. Non-tiered media (books) get the base alone.
 */
export function tieredQueries(
  base: string,
  mediaType: string,
  scope = 0,
  targetTierRaw: string | number | null | undefined = null,
  db: Database = getDb(),
): string[] {
  if (!TIER_MEDIA_TYPES.has(mediaType)) return [base]

  const n = Number(targetTierRaw)
  const targetTier = Number.isFinite(n) && n >= 1 && n <= 3 ? n : null

  const terms = getTierTermsForMedia(mediaType as TierMediaType, scope, db)
  const tiers: Array<{ tier: number; terms: string[] }> = [
    { tier: 1, terms: terms.tier1 },
    { tier: 2, terms: terms.tier2 },
    { tier: 3, terms: terms.tier3 },
    { tier: 0, terms: [] }, // Broad — bare base, no tier terms
  ]
  const selected = targetTier ? tiers.filter(t => t.tier === targetTier) : tiers

  const out: string[] = []
  for (const t of selected) {
    if (t.terms.length > 0) for (const term of t.terms) out.push(`${base} ${term}`)
    else out.push(base)
  }
  return [...new Set(out)]
}

// ── Missing-search batch size ────────────────────────────────────────────────

/** How many missing items a single missing-search pass processes per library. */
export const DEFAULT_MISSING_SEARCH_BATCH = 5

/**
 * Effective missing-search batch size for a library. Reads the library-scoped
 * `acquisitionDefaults` first, then the global scope, then the built-in default
 * — mirroring the tier-term scope fallback. Clamped to a sane 1–100 range.
 */
export function getMissingSearchBatchSize(scope = 0, db: Database = getDb()): number {
  try {
    for (const s of scope !== 0 ? [scope, 0] : [0]) {
      const row = db.prepare("SELECT value FROM app_settings WHERE library_id = ? AND key = 'acquisitionDefaults'").get(s) as { value: string } | undefined
      if (!row) continue
      const n = Number((JSON.parse(row.value) as { missingSearchBatchSize?: unknown })?.missingSearchBatchSize)
      if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 100)
    }
  } catch {}
  return DEFAULT_MISSING_SEARCH_BATCH
}

// ── Reject rules ─────────────────────────────────────────────────────────────

export interface RejectRules {
  /** Reject if the title contains any of these tokens (anchored, case-insensitive). */
  terms: string[]
  /** Reject if the parsed resolution is below this rung (e.g. '720p'). "Any"/null = no floor. */
  minResolution?: string | null
}

export const DEFAULT_REJECTS: RejectRules = {
  terms: ['CAM', 'CAMRip', 'HDCAM', 'TS', 'HDTS', 'TELESYNC', 'TELECINE', 'SCREENER', 'WORKPRINT'],
  minResolution: null,
}

/**
 * Effective reject rules for a library — library scope first, then global, then
 * the built-in default. Mirrors the tier-term scope fallback.
 */
export function getRejectRules(scope = 0, db: Database = getDb()): RejectRules {
  try {
    for (const s of scope !== 0 ? [scope, 0] : [0]) {
      const row = db.prepare("SELECT value FROM app_settings WHERE library_id = ? AND key = 'qualityRejects'").get(s) as { value: string } | undefined
      if (row) {
        const parsed = JSON.parse(row.value) as Partial<RejectRules>
        return { terms: Array.isArray(parsed.terms) ? parsed.terms : DEFAULT_REJECTS.terms, minResolution: parsed.minResolution ?? null }
      }
    }
  } catch {}
  return DEFAULT_REJECTS
}
