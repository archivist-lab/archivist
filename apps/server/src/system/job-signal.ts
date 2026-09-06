import type { Database } from 'better-sqlite3'
import { closeSync, openSync, utimesSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createLogger } from '@archivist/core'

/**
 * Cross-process wake for the job runner.
 *
 * The API enqueues work; the worker is a different process and used to notice
 * only on its next poll, so every user action paid up to a full poll interval
 * before anything started — measurably around a second on average, on work that
 * was often instant. SQLite has no notification channel, so the queue file's
 * own directory carries the signal: enqueueing touches a sentinel file, and the
 * worker watches it.
 *
 * Deliberately best-effort on both sides. fs.watch is unavailable or unreliable
 * on some volume types, so nothing here is load-bearing — the runner's poll
 * remains the guarantee and this only removes the wait in the common case. A
 * failure to signal or to watch is a debug line, never an error.
 */

const logger = createLogger('JobSignal')
const SENTINEL = 'job-wake'

/**
 * The sentinel lives beside the database, so every process reading the same
 * queue agrees on it without needing to share configuration. Taken from the
 * connection itself rather than the environment, which the two processes could
 * in principle resolve differently.
 */
function sentinelPath(db: Database): string | null {
  if (db.memory) return null
  const file = db.name
  return file ? join(dirname(resolve(file)), SENTINEL) : null
}

/**
 * Announces that claimable work exists. Cheap enough for the request path: it
 * stamps an mtime on an empty file, creating it the first time.
 */
export function signalJobQueued(db: Database): void {
  const path = sentinelPath(db)
  if (!path) return
  try {
    const now = new Date()
    try {
      utimesSync(path, now, now)
    } catch {
      // First call of the process's life, or someone removed the file.
      closeSync(openSync(path, 'a'))
      utimesSync(path, now, now)
    }
  } catch (err) {
    logger.debug?.(`Could not signal queued work: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Calls `onWake` shortly after any process signals new work. Returns a stop
 * function; a no-op one when watching is not possible here.
 *
 * Coalesced, because a single touch commonly emits more than one event and a
 * burst of enqueues only needs one pump.
 */
export function watchJobQueue(db: Database, onWake: () => void, debounceMs = 25): () => void {
  const path = sentinelPath(db)
  if (!path) return () => {}
  try {
    closeSync(openSync(path, 'a'))
  } catch {
    logger.debug?.('Job wake sentinel could not be created; falling back to polling')
    return () => {}
  }

  let pending: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher
  try {
    watcher = watch(path, () => {
      if (pending) return
      pending = setTimeout(() => { pending = null; onWake() }, debounceMs)
      pending.unref?.()
    })
  } catch (err) {
    logger.debug?.(`Job wake watch unavailable, polling only: ${err instanceof Error ? err.message : String(err)}`)
    return () => {}
  }
  // A watch that dies (the file replaced, the volume remounted) must not take
  // the worker with it — the poll still covers everything.
  watcher.on('error', err => logger.debug?.(`Job wake watch stopped: ${err instanceof Error ? err.message : String(err)}`))
  watcher.unref?.()

  return () => {
    if (pending) clearTimeout(pending)
    try { watcher.close() } catch {}
  }
}
