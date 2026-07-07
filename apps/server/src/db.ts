import { openUnifiedDb, type UnifiedDb } from '@archivist/db'

/**
 * Module-level handle to the unified database. Mirrors the legacy
 * `getSharedDb()` convention so ported services keep their call shape, but
 * there is exactly one database in Archivist.
 */

let _db: UnifiedDb | null = null

export function initDb(path: string): UnifiedDb {
  _db = openUnifiedDb(path)
  return _db
}

export function getDb(): UnifiedDb {
  if (!_db) throw new Error('Archivist database not initialised — call initDb() first')
  return _db
}

export function isDbInitialised(): boolean {
  return _db !== null
}

export function resetDbForTests(): void {
  _db = null
}
