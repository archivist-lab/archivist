import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { consumeLocallyEmittedEvent, type EventRecord } from './event-store.js'
import { getSseBus } from './sse.js'

/**
 * Relays durable events written by the worker into API-process SSE clients.
 * Events emitted locally by the API are skipped because recordEvent already
 * delivered them synchronously.
 */
export function startEventRelay(db: Database = getDb()): () => void {
  let cursor = Number((db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM system_events').get() as { id: number }).id)
  const timer = setInterval(() => {
    try {
      const rows = db.prepare(`
        SELECT id,ts,category,action,severity,subject_type,subject_id,message,data
        FROM system_events WHERE id>? ORDER BY id LIMIT 500
      `).all(cursor) as Array<{
        id: number
        ts: string
        category: string
        action: string
        severity: EventRecord['severity']
        subject_type: string | null
        subject_id: string | null
        message: string
        data: string
      }>
      for (const row of rows) {
        cursor = row.id
        if (consumeLocallyEmittedEvent(row.id)) continue
        let data: unknown = {}
        try { data = JSON.parse(row.data) } catch {}
        getSseBus().emit(`${row.category}:${row.action}`, {
          category: row.category,
          action: row.action,
          severity: row.severity,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          message: row.message,
          data,
          ts: row.ts,
        })
      }
    } catch {
      // A failed poll is retried; the durable cursor only advances on reads.
    }
  }, 500)
  timer.unref?.()
  return () => clearInterval(timer)
}
