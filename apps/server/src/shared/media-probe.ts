import { execFile } from 'node:child_process'
import { stat, realpath } from 'node:fs/promises'
import { ffprobePath } from './ffmpeg.js'
import { getDb } from '../db.js'

// Shared bounded probe pool. Identical callers share work; aborting one caller
// does not cancel a probe another caller still needs. The subprocess deadline
// bounds abandoned work as well as broken files and stalled mounts.
const pending = new Map<string, Promise<any>>()
const cache = new Map<string, any>()
let active = 0
const waiters: Array<() => void> = []
export async function runMediaCommand(binary: string, args: string[], timeout = 30_000, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(binary, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function probeMedia(filePath: string, signal?: AbortSignal): Promise<any | null> {
  signal?.throwIfAborted()
  let path: string
  let info: import('node:fs').Stats
  try { path = await realpath(filePath); info = await stat(path); if (!info.isFile()) return null } catch { return null }
  signal?.throwIfAborted()
  const key = JSON.stringify([path, info.size, info.mtimeMs, info.ctimeMs])
  if (cache.has(key)) return cache.get(key)
  if (!pending.has(key)) {
    const work = (async () => {
      try {
        const saved = getDb().prepare('SELECT payload FROM media_probe_cache WHERE cache_key=?').get(key) as { payload: string } | undefined
        if (saved) return JSON.parse(saved.payload)
      } catch { /* probe remains usable before database initialisation */ }
      if (active >= 2) {
        if (waiters.length >= 128) return null
        await new Promise<void>(resolve => waiters.push(resolve))
      } else active++
      try {
        const raw = await runMediaCommand(ffprobePath, ['-v', 'error', '-threads', '1', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', path])
        const value = JSON.parse(raw)
        const after = await stat(path)
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return null
        try {
          const db = getDb()
          db.prepare('INSERT OR REPLACE INTO media_probe_cache(cache_key,payload,updated_at) VALUES(?,?,?)').run(key, raw, Date.now())
          db.prepare('DELETE FROM media_probe_cache WHERE cache_key IN (SELECT cache_key FROM media_probe_cache ORDER BY updated_at DESC LIMIT -1 OFFSET 2048)').run()
        } catch { /* caching must not prevent a successful probe */ }
        return value
      } catch { return null }
      finally { const next = waiters.shift(); if (next) next(); else active-- }
    })().then(value => {
      if (value) { cache.set(key, value); if (cache.size > 256) cache.delete(cache.keys().next().value!) }
      return value
    }).finally(() => pending.delete(key))
    pending.set(key, work)
  }
  return abortable(pending.get(key)!, signal)
}
