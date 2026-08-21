import type { Database } from 'better-sqlite3'
import { DEFAULT_IER_CONFIG, IerConfig, IerMode } from '@archivist/contracts'
import { getAppSetting, setAppSetting } from '../../shared/settings.js'
import { getDb } from '../../db.js'

/** Indexer Endpoint Resolver settings (spec §13). Global scope. */
export function getIerConfig(db: Database = getDb()): IerConfig {
  const stored = getAppSetting('indexerEndpointResolver', DEFAULT_IER_CONFIG, 0, db)
  const parsed = IerConfig.safeParse({ ...DEFAULT_IER_CONFIG, ...(stored as object) })
  return parsed.success ? parsed.data : DEFAULT_IER_CONFIG
}

export function setIerConfig(patch: Partial<IerConfig>, db: Database = getDb()): IerConfig {
  const merged = IerConfig.parse({ ...getIerConfig(db), ...patch })
  setAppSetting('indexerEndpointResolver', merged, 0, db)
  return merged
}

/**
 * Per-indexer mode. `manual` means the owner wants Prowlarr's behaviour: the
 * active endpoint never changes on its own (spec §13).
 */
export function getIndexerMode(settings: Record<string, unknown> | undefined): IerMode {
  const raw = settings?.ierMode
  return raw === 'manual' ? 'manual' : 'auto'
}
