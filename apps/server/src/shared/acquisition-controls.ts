import type { Router } from 'express'
import type { Database } from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { getDb } from '../db.js'
import { blockRelease, listSubjectAcquisitionHistory } from '../services/acquisition-decisions.js'

type Row = Record<string, any>

interface AcquisitionControlsConfig {
  basePath: string
  idParam: string
  mediaType: string
  subjectType: string
  table: string
  /** Must select by id AND library scope: two placeholders (id, libraryId). */
  selectSql: string
  title: (row: Row) => string
  subjectId?: (row: Row) => string | number
  deserialise?: (row: Row) => unknown
  repairChildren?: (db: Database, row: Row, deleteFiles: boolean) => void
}

function tableColumns(db: Database, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name))
  } catch {
    return new Set()
  }
}

function deletePath(path: string | null | undefined): void {
  if (!path || !existsSync(path)) return
  rmSync(path, { force: true, recursive: true })
}

function buildUpdate(table: string, columns: Set<string>, values: Record<string, unknown>, whereColumn = 'id'): string {
  const assignments = Object.keys(values)
    .filter(column => columns.has(column))
    .map(column => `${column} = @${column}`)

  if (columns.has('updated_at')) assignments.push("updated_at = datetime('now')")
  if (assignments.length === 0) return ''

  return `UPDATE ${table} SET ${assignments.join(', ')} WHERE ${whereColumn} = @id`
}

function runSparseUpdate(db: Database, table: string, id: unknown, values: Record<string, unknown>): void {
  const sql = buildUpdate(table, tableColumns(db, table), values)
  if (!sql) return
  db.prepare(sql).run({ id, ...values })
}

export function registerAcquisitionControls(router: Router, config: AcquisitionControlsConfig): void {
  const route = `${config.basePath}/:${config.idParam}`

  const loadItem = (db: Database, id: string, libraryId: number): Row | undefined => {
    return db.prepare(config.selectSql).get(id, libraryId) as Row | undefined
  }

  const getSubjectId = (row: Row) => config.subjectId ? config.subjectId(row) : row.id
  const requestId = (req: { params: Record<string, string> }) => req.params[config.idParam]
  const libId = (req: any): number => req.library?.id ?? 0

  router.get(`${route}/acquisition-history`, (req, res) => {
    try {
      const db = getDb()
      const row = loadItem(db, requestId(req as any), libId(req))
      if (!row) return res.status(404).json({ error: 'Item not found' })

      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100
      res.json(listSubjectAcquisitionHistory({
        mediaType: config.mediaType,
        subjectType: config.subjectType,
        subjectId: getSubjectId(row),
      }, Number.isFinite(limit) ? limit : 100))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post(`${route}/reject-current-release`, (req, res) => {
    try {
      const db = getDb()
      const row = loadItem(db, requestId(req as any), libId(req))
      if (!row) return res.status(404).json({ error: 'Item not found' })
      if (!row.info_hash && !row.current_release_title) {
        return res.status(400).json({ error: 'Item has no current release to reject' })
      }

      blockRelease({
        infoHash: row.info_hash,
        releaseTitle: row.current_release_title ?? config.title(row),
        reason: req.body?.reason ?? 'user-rejected-release',
        tabId: (req as any).library?.id ?? null,
        mediaType: config.mediaType,
        subjectType: config.subjectType,
        subjectId: getSubjectId(row),
      })

      const nextStatus = ['acquiring', 'downloading', 'wanted'].includes(row.status) ? 'missing' : row.status
      runSparseUpdate(db, config.table, row.id, {
        status: nextStatus,
        info_hash: null,
        download_progress: 0,
      })

      res.json({ success: true })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post(`${route}/repair`, (req, res) => {
    try {
      const db = getDb()
      const row = loadItem(db, requestId(req as any), libId(req))
      if (!row) return res.status(404).json({ error: 'Item not found' })

      const deleteFile = req.body?.deleteFile === true
      const rejectCurrent = req.body?.rejectCurrent !== false

      if (rejectCurrent && (row.info_hash || row.current_release_title)) {
        blockRelease({
          infoHash: row.info_hash,
          releaseTitle: row.current_release_title ?? config.title(row),
          reason: 'repair-rejected-current-release',
          tabId: (req as any).library?.id ?? null,
          mediaType: config.mediaType,
          subjectType: config.subjectType,
          subjectId: getSubjectId(row),
        })
      }

      if (deleteFile) deletePath(row.file_path)
      config.repairChildren?.(db, row, deleteFile)

      // current_tier resets to 0 (not NULL) — the column is NOT NULL; the
      // legacy null write hit a constraint error on tables that carry it.
      runSparseUpdate(db, config.table, row.id, {
        status: 'missing',
        file_path: null,
        file_size: null,
        quality: null,
        info_hash: null,
        download_progress: 0,
        current_tier: 0,
        current_resolution: null,
        current_source: null,
        current_codec: null,
        current_release_group: null,
        current_edition: null,
        current_size_bytes: null,
        current_release_title: null,
      })

      const updated = loadItem(db, requestId(req as any), libId(req)) as Row
      res.json(config.deserialise ? config.deserialise(updated) : updated)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })
}

export function deleteExistingPath(path: string | null | undefined): void {
  deletePath(path)
}
