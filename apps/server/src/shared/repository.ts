import type { Statement } from 'better-sqlite3'
import { getDb } from '../db.js'

/**
 * Foundation for the per-entity repositories.
 *
 * Two problems this solves:
 *
 *  1. **Statement churn.** The codebase calls `db.prepare(...)` inline on every
 *     request. better-sqlite3 rewards preparing once and reusing, but the handle
 *     is bound to a connection and the connection does not exist at import time
 *     (and is swapped by `resetDbForTests`). `stmt()` caches per connection in a
 *     WeakMap, so statements are prepared lazily, reused for the life of the
 *     connection, and dropped with it.
 *
 *  2. **Untyped rows.** `.all()` returns `unknown`, which is why the codebase is
 *     littered with `as any[]`. Repositories declare their row types once.
 *
 * This is intentionally thin — it is a query cache with types, not an ORM. Raw
 * `getDb().prepare(...)` remains fine for one-off and dynamically-built SQL.
 */

const cache = new WeakMap<object, Map<string, Statement>>()

/** Prepared statement for `sql`, cached against the current connection. */
export function stmt(sql: string): Statement {
  const db = getDb()
  let perDb = cache.get(db as unknown as object)
  if (!perDb) {
    perDb = new Map()
    cache.set(db as unknown as object, perDb)
  }
  let prepared = perDb.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    perDb.set(sql, prepared)
  }
  return prepared
}

/**
 * Builds a `(?, ?, ?)` placeholder list for an IN clause. SQLite caps host
 * parameters (default 32766), so callers with very large sets should chunk.
 */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(',')
}

/** Splits `items` into chunks small enough for a single IN clause. */
export function chunked<T>(items: T[], size = 500): T[][] {
  if (items.length <= size) return items.length ? [items] : []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
