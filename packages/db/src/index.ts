import type BetterSqlite3 from 'better-sqlite3'
import { openDatabase, defaultDbPath } from './client.js'
import { applySchema } from './schema.js'

export { openDatabase, closeDatabase, closeAllDatabases, defaultDbPath } from './client.js'
export { runMigrations, ensureColumn, type Migration } from './migrations.js'
export {
  applySchema,
  seedQualityProfiles,
  seedEditionRules,
  DEFAULT_QUALITY_PROFILES,
  DEFAULT_EDITION_RULES,
} from './schema.js'

export type UnifiedDb = BetterSqlite3.Database

/** Opens the unified Archivist database at `path` and applies the schema. */
export function openUnifiedDb(path?: string): UnifiedDb {
  const db = openDatabase(path ?? defaultDbPath())
  applySchema(db)
  return db
}
