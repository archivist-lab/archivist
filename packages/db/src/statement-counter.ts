import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request SQL statement accounting.
 *
 * better-sqlite3 is synchronous: every statement blocks the event loop for its
 * full duration, so the number of statements a request issues — not their
 * individual speed — is what makes one route degrade every other. This counter
 * exists to find the routes that issue hundreds of them (N+1 loops) without
 * guessing.
 *
 * Attribution uses AsyncLocalStorage rather than a global counter delta. A
 * naive delta charges one request for statements other handlers executed while
 * it was awaiting; the ALS store follows the request's own async chain, and the
 * `verbose` callback fires synchronously inside it, so each tally is exact.
 *
 * Off unless ARCHIVIST_PERF_TRACE is set. better-sqlite3 builds the expanded
 * SQL (parameters substituted) for every call to `verbose`, which is real work
 * per statement — this must not run in a default install. The flag is read once
 * at module load because the hook is installed when the connection is opened:
 * changing it requires a restart.
 */

export interface StatementTally {
  total: number
  /** Normalised SQL → execution count. Bounded; see MAX_TRACKED_STATEMENTS. */
  bySql: Map<string, number>
}

const MAX_TRACKED_STATEMENTS = 200
const MAX_SQL_LENGTH = 160

const storage = new AsyncLocalStorage<StatementTally>()

const tracing = (() => {
  const flag = process.env.ARCHIVIST_PERF_TRACE?.trim().toLowerCase()
  return flag !== undefined && flag !== '' && flag !== '0' && flag !== 'false'
})()

/** Whether statement tracing was enabled for this process. */
export function statementTracingEnabled(): boolean {
  return tracing
}

/**
 * Collapses the expanded SQL better-sqlite3 hands us back to a shape, so the
 * 340 executions of one query in a loop tally as one line instead of 340.
 */
function normaliseSql(sql: string): string {
  const shape = sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\bx?"[^"]*"/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
  return shape.length > MAX_SQL_LENGTH ? `${shape.slice(0, MAX_SQL_LENGTH)}…` : shape
}

/**
 * The `verbose` hook to hand to the better-sqlite3 constructor. Returns
 * undefined when tracing is off so the driver skips expanded-SQL generation
 * entirely rather than calling a no-op.
 */
export function statementVerboseHook(): ((sql: unknown) => void) | undefined {
  if (!tracing) return undefined
  return (sql: unknown) => {
    const tally = storage.getStore()
    if (!tally) return
    tally.total += 1
    if (typeof sql !== 'string') return
    const shape = normaliseSql(sql)
    const seen = tally.bySql.get(shape)
    if (seen !== undefined) tally.bySql.set(shape, seen + 1)
    else if (tally.bySql.size < MAX_TRACKED_STATEMENTS) tally.bySql.set(shape, 1)
  }
}

/**
 * Runs `fn` with a fresh tally bound to its async context. Every statement any
 * connection executes inside it is counted against `tally`. A no-op wrapper
 * when tracing is off.
 */
export function runWithStatementTally<T>(fn: (tally: StatementTally | null) => T): T {
  if (!tracing) return fn(null)
  const tally: StatementTally = { total: 0, bySql: new Map() }
  return storage.run(tally, () => fn(tally))
}

/** The tally for the currently executing request, if any. */
export function currentStatementTally(): StatementTally | null {
  return storage.getStore() ?? null
}

/** The `n` most-executed statement shapes in a tally, busiest first. */
export function topStatements(tally: StatementTally, n = 3): Array<{ sql: string; count: number }> {
  return [...tally.bySql.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([sql, count]) => ({ sql, count }))
}
