import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('Migrations')

interface Migration {
  version: number
  description: string
  up: (db: BetterSqlite3.Database) => void
}

/**
 * Runs a list of migrations against a database in order, tracking
 * which have already been applied in a `_migrations` table.
 */
export function runMigrations(db: BetterSqlite3.Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map(r => r.version)
  )

  const pending = migrations.filter(m => !applied.has(m.version)).sort((a, b) => a.version - b.version)

  if (pending.length === 0) return

  for (const migration of pending) {
    logger.info(`Applying migration v${migration.version}: ${migration.description}`)
    db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO _migrations (version, description) VALUES (?, ?)').run(migration.version, migration.description)
    })()
  }

  logger.info(`Applied ${pending.length} migration(s)`)
}
