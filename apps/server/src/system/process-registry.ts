import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

export type ProcessRole = 'api' | 'worker'

export interface RuntimeProcessRecord {
  instanceId: string
  role: ProcessRole
  hostname: string
  pid: number
  startedAt: string
  heartbeatAt: string
  stoppingAt: string | null
  metadata: Record<string, unknown>
  healthy: boolean
}

export interface ProcessRegistration {
  instanceId: string
  role: ProcessRole
  stop: () => void
}

const HEARTBEAT_MS = 5_000
const HEALTHY_WITHIN_MS = 20_000

export function registerRuntimeProcess(
  role: ProcessRole,
  metadata: Record<string, unknown> = {},
  db: Database = getDb(),
): ProcessRegistration {
  db.prepare(`DELETE FROM runtime_processes WHERE unixepoch(heartbeat_at) < unixepoch('now') - 604800`).run()
  const instanceId = `${role}-${hostname()}-${process.pid}-${randomUUID()}`
  const write = db.prepare(`
    INSERT INTO runtime_processes(instance_id,role,hostname,pid,started_at,heartbeat_at,stopping_at,metadata)
    VALUES(?,?,?,?,?,?,NULL,?)
    ON CONFLICT(instance_id) DO UPDATE SET
      heartbeat_at=excluded.heartbeat_at,stopping_at=NULL,metadata=excluded.metadata
  `)
  const heartbeat = () => write.run(
    instanceId,
    role,
    hostname(),
    process.pid,
    new Date().toISOString(),
    new Date().toISOString(),
    JSON.stringify(metadata),
  )
  heartbeat()
  const timer = setInterval(() => {
    try {
      db.prepare(`UPDATE runtime_processes SET heartbeat_at=?,metadata=? WHERE instance_id=?`)
        .run(new Date().toISOString(), JSON.stringify(metadata), instanceId)
    } catch {
      // A heartbeat failure is surfaced by the stale process timestamp.
    }
  }, HEARTBEAT_MS)
  timer.unref?.()

  return {
    instanceId,
    role,
    stop: () => {
      clearInterval(timer)
      try {
        db.prepare('UPDATE runtime_processes SET stopping_at=?,heartbeat_at=? WHERE instance_id=?')
          .run(new Date().toISOString(), new Date().toISOString(), instanceId)
      } catch {
        // Database shutdown may already be in progress.
      }
    },
  }
}

export function acquireRuntimeLease(
  leaseName: string,
  ownerId: string,
  ttlMs = 20_000,
  db: Database = getDb(),
): boolean {
  const acquire = db.transaction(() => {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
    const existing = db.prepare('SELECT owner_id,expires_at FROM runtime_leases WHERE lease_name=?')
      .get(leaseName) as { owner_id: string; expires_at: string } | undefined
    if (existing && existing.owner_id !== ownerId && Date.parse(existing.expires_at) > now.getTime()) return false
    db.prepare(`
      INSERT INTO runtime_leases(lease_name,owner_id,acquired_at,expires_at,updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(lease_name) DO UPDATE SET
        owner_id=excluded.owner_id,
        acquired_at=CASE WHEN runtime_leases.owner_id=excluded.owner_id THEN runtime_leases.acquired_at ELSE excluded.acquired_at END,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at
    `).run(leaseName, ownerId, now.toISOString(), expiresAt, now.toISOString())
    return true
  })
  return acquire.immediate()
}

export function renewRuntimeLease(
  leaseName: string,
  ownerId: string,
  ttlMs = 20_000,
  db: Database = getDb(),
): boolean {
  const now = new Date()
  const result = db.prepare(`
    UPDATE runtime_leases SET expires_at=?,updated_at=?
    WHERE lease_name=? AND owner_id=?
  `).run(new Date(now.getTime() + ttlMs).toISOString(), now.toISOString(), leaseName, ownerId)
  return result.changes === 1
}

export function releaseRuntimeLease(leaseName: string, ownerId: string, db: Database = getDb()): void {
  db.prepare('DELETE FROM runtime_leases WHERE lease_name=? AND owner_id=?').run(leaseName, ownerId)
}

export function listRuntimeProcesses(db: Database = getDb()): RuntimeProcessRecord[] {
  const rows = db.prepare(`
    SELECT instance_id,role,hostname,pid,started_at,heartbeat_at,stopping_at,metadata
    FROM runtime_processes
    ORDER BY role,started_at DESC
  `).all() as Array<{
    instance_id: string
    role: ProcessRole
    hostname: string
    pid: number
    started_at: string
    heartbeat_at: string
    stopping_at: string | null
    metadata: string
  }>
  const cutoff = Date.now() - HEALTHY_WITHIN_MS
  return rows.map(row => ({
    instanceId: row.instance_id,
    role: row.role,
    hostname: row.hostname,
    pid: row.pid,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    stoppingAt: row.stopping_at,
    metadata: (() => {
      try { return JSON.parse(row.metadata) as Record<string, unknown> } catch { return {} }
    })(),
    healthy: row.stopping_at == null && Date.parse(row.heartbeat_at) >= cutoff,
  }))
}
