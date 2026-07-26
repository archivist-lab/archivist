import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const instances = new Map<string, BetterSqlite3.Database>()

/**
 * Opens (and caches) a SQLite connection with the Archivist durability settings:
 * WAL journaling, NORMAL sync, enforced foreign keys, 5s busy timeout — plus the
 * performance pragmas (page cache, in-memory temp tables, mmap reads) that matter
 * for a media-library-sized database on modest hardware.
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
  // Durability / correctness
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  // Performance. cache_size is negative to mean KiB (64 MB) rather than pages;
  // mmap_size is 256 MB. Both are advisory — SQLite silently uses less if it must.
  db.pragma('cache_size = -64000')
  db.pragma('temp_store = MEMORY')
  try { db.pragma('mmap_size = 268435456') } catch { /* unsupported build; harmless */ }
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
