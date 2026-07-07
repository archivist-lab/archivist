import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const instances = new Map<string, BetterSqlite3.Database>()

/**
 * Opens (and caches) a SQLite connection with the Archivist durability settings:
 * WAL journaling, NORMAL sync, enforced foreign keys, 5s busy timeout.
 */
export function openDatabase(path: string): BetterSqlite3.Database {
  const key = resolve(path)
  const existing = instances.get(key)
  if (existing) {
    try { existing.pragma('journal_mode'); return existing } catch { instances.delete(key) }
  }
  const dir = dirname(key)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new BetterSqlite3(key)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  instances.set(key, db)
  return db
}

export function closeDatabase(path: string): void {
  const key = resolve(path)
  const db = instances.get(key)
  if (db) {
    try { db.close() } catch {}
    instances.delete(key)
  }
}

export function closeAllDatabases(): void {
  for (const key of [...instances.keys()]) closeDatabase(key)
}

export function defaultDbPath(): string {
  return process.env.ARCHIVIST_DB ?? './data/archivist.sqlite'
}
