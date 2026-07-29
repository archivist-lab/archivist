import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { enqueueUniqueJob, recordEvent, type JobRecord } from '../system/event-store.js'
import { registerJobHandler } from '../system/job-runner.js'
import { previewList, getListRow, parseFilter, type ListItemRow } from './service.js'

export const LIST_REFRESH_JOB = 'list.refresh'

export interface ListRefreshResult {
  runId: number
  fetched: number
  newItems: number
  inLibrary: number
  departed: number
  capped: number
  warning?: string
}

function heldItem(db: Database, mediaType: 'film' | 'series', libraryId: number, tmdbId: number): number | null {
  const table = mediaType === 'film' ? 'films' : 'series'
  const row = db.prepare(`SELECT id FROM ${table} WHERE library_id = ? AND tmdb_id = ?`).get(libraryId, tmdbId) as { id: number } | undefined
  return row?.id ?? null
}

export async function refreshList(listId: number, db: Database = getDb()): Promise<ListRefreshResult> {
  const list = getListRow(listId, undefined, db)
  if (!list) throw new Error(`List ${listId} not found`)
  const runId = Number(db.prepare('INSERT INTO list_refresh_runs (list_id) VALUES (?)').run(listId).lastInsertRowid)
  try {
    const result = await previewList(parseFilter(list.filter), list.media_type, list.member_cap, db)
    const seenIds = new Set(result.members.map(item => item.tmdbId))
    let newItems = 0
    let inLibrary = 0

    const find = db.prepare('SELECT * FROM list_items WHERE list_id = ? AND media_type = ? AND tmdb_id = ?')
    const insert = db.prepare(`
      INSERT INTO list_items (list_id, media_type, tmdb_id, tvdb_id, imdb_id, title, year, poster_path,
        status, library_item_id, status_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const touch = db.prepare(`
      UPDATE list_items SET title = ?, year = ?, poster_path = ?, tvdb_id = COALESCE(?, tvdb_id),
        imdb_id = COALESCE(?, imdb_id), last_seen_at = datetime('now') WHERE id = ?
    `)
    const returnDeparted = db.prepare(`
      UPDATE list_items SET status = ?, status_reason = ?, library_item_id = ?, resolved_at = ? WHERE id = ?
    `)

    db.transaction(() => {
      for (const member of result.members) {
        const existing = find.get(listId, member.mediaType, member.tmdbId) as ListItemRow | undefined
        const localId = heldItem(db, member.mediaType, list.library_id, member.tmdbId)
        if (!existing) {
          const status = localId == null ? 'new' : 'in_library'
          insert.run(
            listId, member.mediaType, member.tmdbId, member.tvdbId ?? null, member.imdbId ?? null,
            member.title, member.year ?? null, member.posterPath ?? null, status, localId,
            localId == null ? null : 'Already held in target library',
          )
          if (localId == null) newItems += 1
          else inLibrary += 1
          continue
        }
        touch.run(member.title, member.year ?? null, member.posterPath ?? null, member.tvdbId ?? null, member.imdbId ?? null, existing.id)
        if (existing.status === 'new' && localId != null) {
          returnDeparted.run('in_library', 'Already held in target library', localId, new Date().toISOString(), existing.id)
          inLibrary += 1
          continue
        }
        if (existing.status === 'departed') {
          const status = localId == null ? 'new' : 'in_library'
          returnDeparted.run(status, localId == null ? 'Returned to List membership' : 'Already held in target library', localId, localId == null ? null : new Date().toISOString(), existing.id)
          if (localId == null) newItems += 1
          else inLibrary += 1
        }
      }
    })()

    let departed = 0
    // A truncated provider window cannot prove absence. Preserve membership and
    // surface the cap instead of manufacturing departures from unseen pages.
    if (!result.capped) {
      const candidates = db.prepare("SELECT id, tmdb_id FROM list_items WHERE list_id = ? AND status IN ('new', 'failed')").all(listId) as Array<{ id: number; tmdb_id: number }>
      const markDeparted = db.prepare("UPDATE list_items SET status = 'departed', status_reason = 'No longer matched by the List filter', resolved_at = datetime('now') WHERE id = ?")
      db.transaction(() => {
        for (const candidate of candidates) {
          if (seenIds.has(candidate.tmdb_id)) continue
          markDeparted.run(candidate.id)
          departed += 1
        }
      })()
    }

    const capped = Math.max(0, result.total - result.members.length)
    db.prepare(`
      UPDATE list_refresh_runs SET finished_at = datetime('now'), fetched = ?, new_items = ?,
        auto_added = 0, departed = ?, capped = ? WHERE id = ?
    `).run(result.members.length, newItems, departed, capped, runId)
    db.prepare(`
      UPDATE lists SET last_refreshed_at = datetime('now'), last_error = ?, consecutive_failures = 0,
        updated_at = datetime('now') WHERE id = ?
    `).run(result.warning ?? null, listId)

    if (newItems > 0) {
      recordEvent({
        category: 'lists', action: 'new-items', subjectType: 'list', subjectId: String(listId),
        message: `${list.name} found ${newItems} new ${newItems === 1 ? 'item' : 'items'}`,
        data: { listId, libraryId: list.library_id, newItems, pending: true },
      }, db)
    }
    if (result.warning) {
      recordEvent({ category: 'lists', action: 'capped', severity: 'warn', subjectType: 'list', subjectId: String(listId), message: result.warning, data: { listId, total: result.total, memberCap: list.member_cap } }, db)
    }
    return { runId, fetched: result.members.length, newItems, inLibrary, departed, capped, warning: result.warning }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
    db.prepare("UPDATE list_refresh_runs SET finished_at = datetime('now'), error = ? WHERE id = ?").run(message, runId)
    db.prepare("UPDATE lists SET last_error = ?, consecutive_failures = consecutive_failures + 1, updated_at = datetime('now') WHERE id = ?").run(message, listId)
    throw error
  }
}

export function queueListRefresh(listId: number, db: Database = getDb()): number | null {
  return enqueueUniqueJob({ type: LIST_REFRESH_JOB, subjectType: 'list', subjectId: String(listId), payload: { listId }, maxAttempts: 3 }, db)
}

export function registerListJobs(): void {
  registerJobHandler(LIST_REFRESH_JOB, async (job: JobRecord) => {
    const payload = JSON.parse(job.payload) as { listId?: unknown }
    const listId = Number(payload.listId ?? job.subjectId)
    if (!Number.isSafeInteger(listId) || listId <= 0) throw new Error('Invalid list refresh payload')
    await refreshList(listId)
  })
}
