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

export type TierMediaType = 'films' | 'series' | 'music' | 'games' | 'comics'
export interface TierTerm { term: string; mediaTypes: TierMediaType[] }
export interface TierConfig { tier1: TierTerm[]; tier2: TierTerm[]; tier3: TierTerm[] }

export const DEFAULT_TIERS: TierConfig = {
  tier1: [
    { term: 'QxR',        mediaTypes: ['films'] },
    { term: 'Tigole',     mediaTypes: ['films'] },
    { term: 'Bandi',      mediaTypes: ['films'] },
    { term: 'Ghost',      mediaTypes: ['films'] },
    { term: 'Kappa',      mediaTypes: ['films'] },
    { term: 'SAMPA',      mediaTypes: ['films'] },
    { term: 'Silence',    mediaTypes: ['films'] },
    { term: 't3nzin',     mediaTypes: ['films'] },
    { term: 'YOGI',       mediaTypes: ['films'] },
    { term: 'TAoE',       mediaTypes: ['films'] },
    { term: 'Ainz',       mediaTypes: ['films'] },
    { term: 'ANONAZ',     mediaTypes: ['films'] },
    { term: 'xtrem3x',    mediaTypes: ['films'] },
    { term: 'BluRay',     mediaTypes: ['series'] },
    { term: 'BDRip',      mediaTypes: ['series'] },
    { term: 'REMUX',      mediaTypes: ['series'] },
  ],
  tier2: [
    { term: 'UTR',          mediaTypes: ['films'] },
    { term: 'Joy',          mediaTypes: ['films'] },
    { term: 'Qman',         mediaTypes: ['films'] },
    { term: 'theincognito', mediaTypes: ['films'] },
    { term: 'Korach',       mediaTypes: ['films'] },
    { term: 'D0ct0rLew',    mediaTypes: ['films'] },
    { term: 'WEB-DL',       mediaTypes: ['series'] },
    { term: 'WEBRip',       mediaTypes: ['series'] },
    { term: '1080p',        mediaTypes: ['series'] },
  ],
  tier3: [
    { term: 'YIFY',    mediaTypes: ['films'] },
    { term: 'PSA',     mediaTypes: ['films'] },
    { term: 'MeGusta', mediaTypes: ['films'] },
    { term: '720p',    mediaTypes: ['series'] },
    { term: 'HDTV',    mediaTypes: ['series'] },
  ],
}

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
