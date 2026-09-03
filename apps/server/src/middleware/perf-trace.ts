import type { Request, Response, NextFunction } from 'express'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createLogger } from '@archivist/core'
import { runWithStatementTally, statementTracingEnabled, topStatements } from '@archivist/db'

/**
 * Request-level performance instrumentation: wall time, SQL statement count and
 * event-loop lag.
 *
 * The point of the statement count is the architecture: better-sqlite3 is
 * synchronous and has no pool, so a route that issues 400 small queries costs
 * 400 sequential event-loop blocks and stalls every other request for the
 * duration. Statement count per request localises that in minutes; guessing at
 * it from wall-clock time alone does not.
 *
 * Reading the output:
 *
 *   query storm  → a list endpoint issuing statements proportional to rows is
 *                  an N+1. The logged `top` shapes name the offending query.
 *   slow request with a low statement count → not the database. Look for CPU
 *                  work on the request path (hashing, ffprobe, image work,
 *                  large JSON serialisation) and move it off the main thread.
 *   event loop lag with low statement counts across the board → same verdict,
 *                  process-wide.
 *
 * Everything here is off unless ARCHIVIST_PERF_TRACE is set, and the statement
 * hook is installed when a connection is opened, so enabling it needs a
 * restart.
 *
 *   ARCHIVIST_PERF_TRACE=1              enable
 *   ARCHIVIST_PERF_QUERY_WARN=20        warn above this many statements
 *   ARCHIVIST_PERF_SLOW_MS=250          warn above this many ms
 *   ARCHIVIST_PERF_LAG_MS=100           warn above this much loop lag
 *
 * Each traced response also carries X-Perf-Queries and X-Perf-Ms, so the
 * statement count for an action is visible in the DevTools Network tab next to
 * its TTFB — no log grepping to answer 'is this the server or the client'.
 */

const logger = createLogger('Perf')

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * Mount immediately after request-id so the tally covers every other
 * middleware. A no-op pass-through when tracing is off.
 */
export function perfTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!statementTracingEnabled()) { next(); return }
  const queryWarn = envInt('ARCHIVIST_PERF_QUERY_WARN', 20)
  const slowMs = envInt('ARCHIVIST_PERF_SLOW_MS', 250)
  const startedAt = process.hrtime.bigint()

  runWithStatementTally(tally => {
    // Stamp the count onto the response so it is readable straight from the
    // DevTools Network tab — which is where the server-vs-client split gets
    // decided in the first place. writeHead is the last moment headers can be
    // touched, so a streaming response reports what it had issued by the time
    // it started streaming.
    const writeHead = res.writeHead.bind(res)
    res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
      if (!res.headersSent) {
        res.setHeader('X-Perf-Queries', String(tally?.total ?? 0))
        res.setHeader('X-Perf-Ms', String(Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)))
        // Without this the browser hides both headers from a cross-origin dev
        // server, which is exactly where they are wanted.
        const exposed = res.getHeader('Access-Control-Expose-Headers')
        res.setHeader('Access-Control-Expose-Headers', exposed ? `${exposed}, X-Perf-Queries, X-Perf-Ms` : 'X-Perf-Queries, X-Perf-Ms')
      }
      return writeHead(...args)
    }) as typeof res.writeHead

    // 'finish' fires when the response is flushed; 'close' catches aborts, and
    // an aborted request that ran 300 statements is exactly as interesting.
    let settled = false
    const report = () => {
      if (settled) return
      settled = true
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      const queries = tally ? tally.total : 0
      const detail = {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Math.round(ms),
        queries,
        requestId: req.requestId,
      }
      if (tally && queries > queryWarn) {
        logger.warn('query storm', { ...detail, top: topStatements(tally, 3) })
      } else if (ms > slowMs) {
        // Slow with few statements is the signature of CPU work on the request
        // path, not a database problem.
        logger.warn('slow request', detail)
      } else {
        logger.debug('req', detail)
      }
    }
    res.on('finish', report)
    res.on('close', report)
    next()
  })
}

/**
 * Process-wide event-loop lag sampling. High lag with low statement counts
 * means something CPU-bound is running on the main thread — piece hashing,
 * ffprobe fan-out, segment detection, poster processing — and belongs in a
 * worker thread or a separate process.
 *
 * Returns a stop function; a no-op when tracing is off.
 */
export function startEventLoopMonitor(): () => void {
  if (!statementTracingEnabled()) return () => {}
  const lagMs = envInt('ARCHIVIST_PERF_LAG_MS', 100)
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const timer = setInterval(() => {
    const max = histogram.max / 1e6
    const p99 = histogram.percentile(99) / 1e6
    if (max > lagMs) logger.warn('event loop lag', { maxMs: Math.round(max), p99Ms: Math.round(p99) })
    histogram.reset()
  }, 5000)
  timer.unref()
  return () => { clearInterval(timer); histogram.disable() }
}
