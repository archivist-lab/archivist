import type BetterSqlite3 from 'better-sqlite3'

export interface Migration {
  version: number
  description: string
  up: (db: BetterSqlite3.Database) => void
}

/**
 * Runs migrations in version order, tracking applied versions in
 * `_migrations`. Idempotent: applied versions are skipped.
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
    (db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map(r => r.version),
  )

  const pending = migrations.filter(m => !applied.has(m.version)).sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO _migrations (version, description) VALUES (?, ?)').run(migration.version, migration.description)
    })()
  }
}

/** Adds a column if it does not exist yet. */
export function ensureColumn(db: BetterSqlite3.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) db.exec(ddl)
}
