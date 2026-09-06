import { availableParallelism } from 'node:os'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getDb } from '../db.js'

// One software thread per admitted task. Reserve capacity for an interactive
// transcode; all worker media paths share the same SQLite admission boundary.
export const mediaThreads = 1
// CPU affinity alone can exceed a container's CFS quota. Read the effective
// quota once per process; deployment limit changes require a runtime restart.
export function mediaCapacity(): number {
  let cpus = availableParallelism()
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number)
    if (quota > 0 && period > 0) cpus = Math.min(cpus, Math.max(1, Math.floor(quota / period)))
  } catch {
    try {
      const quota = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'))
      const period = Number(readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'))
      if (quota > 0 && period > 0) cpus = Math.min(cpus, Math.max(1, Math.floor(quota / period)))
    } catch { /* non-Linux or unrestricted host */ }
  }
  return Math.max(1, cpus - 1)
}
const capacity = mediaCapacity()
export async function acquireMediaSlot(kind: 'background' | 'playback', signal?: AbortSignal): Promise<() => void> {
  const db = getDb()
  const id = randomUUID()
  const claim = db.transaction(() => {
    db.prepare('DELETE FROM media_resource_leases WHERE heartbeat < ?').run(Date.now() - 30_000)
    const rows = db.prepare('SELECT kind,COUNT(*) AS n FROM media_resource_leases GROUP BY kind').all() as Array<{ kind: string; n: number }>
    const background = rows.find(row => row.kind === 'background')?.n ?? 0
    const playback = rows.find(row => row.kind === 'playback')?.n ?? 0
    if (kind === 'background' && (playback > 0 || background >= Math.max(1, capacity - 1))) return false
    if (kind === 'playback' && playback >= Math.max(1, capacity - background)) return false
    db.prepare('INSERT INTO media_resource_leases VALUES(?,?,?,?)').run(id, kind, process.pid, Date.now())
    return true
  })
  while (true) {
    signal?.throwIfAborted()
    if (claim.immediate()) break
    await delay(250, undefined, { signal })
  }
  let released = false
  const heartbeat = setInterval(() => {
    try { db.prepare('UPDATE media_resource_leases SET heartbeat=? WHERE id=?').run(Date.now(), id) } catch { /* retried next heartbeat */ }
  }, 5000)
  heartbeat.unref?.()
  return () => {
    if (released) return
    released = true; clearInterval(heartbeat)
    db.prepare('DELETE FROM media_resource_leases WHERE id=?').run(id)
  }
}
