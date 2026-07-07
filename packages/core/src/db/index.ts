import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, existsSync, statSync } from 'fs'
import { dirname, resolve } from 'path'

const instances = new Map<string, BetterSqlite3.Database>()

export interface DbStatus {
  path: string
  open: boolean
  exists: boolean
  wal: boolean
  shm: boolean
  pageCount?: number
  pageSize?: number
  databaseBytes?: number
  walBytes?: number
  shmBytes?: number
  error?: string
}

export function openDb(path: string): BetterSqlite3.Database {
  const existing = instances.get(path)
  if (existing) {
    // Verify the cached connection is still usable
    try { existing.pragma('journal_mode'); return existing } catch { instances.delete(path) }
  }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new BetterSqlite3(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  instances.set(path, db)
  return db
}

/** Close and remove a cached DB connection. Safe to call if path isn't cached. */
export function closeDb(path: string): void {
  const db = instances.get(path)
  if (db) {
    try { db.close() } catch {}
    instances.delete(path)
  }
}

/** Close every cached DB connection. Intended for graceful process shutdown. */
export function closeAllDbs(): void {
  for (const path of [...instances.keys()]) closeDb(path)
}

export function listOpenDbs(): string[] {
  return [...instances.keys()]
}

function fileSize(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).size : undefined
  } catch {
    return undefined
  }
}

/** Run a passive WAL checkpoint so backup tools can see current durability state. */
export function checkpointDb(path: string): void {
  openDb(path).pragma('wal_checkpoint(PASSIVE)')
}

export function getDbStatus(path: string): DbStatus {
  const resolved = resolve(path)
  const status: DbStatus = {
    path: resolved,
    open: instances.has(path),
    exists: existsSync(resolved),
    wal: existsSync(`${resolved}-wal`),
    shm: existsSync(`${resolved}-shm`),
    databaseBytes: fileSize(resolved),
    walBytes: fileSize(`${resolved}-wal`),
    shmBytes: fileSize(`${resolved}-shm`),
  }

  try {
    const db = openDb(path)
    status.open = true
    status.pageCount = db.pragma('page_count', { simple: true }) as number
    status.pageSize = db.pragma('page_size', { simple: true }) as number
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }

  return status
}

export function getSharedDb(path?: string): BetterSqlite3.Database {
  return openDb(path ?? process.env.ARCHIVIST_SHARED_DB ?? './data/shared.db')
}
