import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { FilterNodeSchema, type FilterNode, type ListCreateRequest, type ListItemsQuery, type ListMediaType, type ListPatchRequest } from '@archivist/contracts'
import { getDb } from '../db.js'
import { createFilmFromTmdb } from '../modules/films/create.js'
import { createSeriesFromMetadata } from '../modules/series/create.js'
import type { ListAddQuality } from '@archivist/contracts'
import { recordEvent } from '../system/event-store.js'
import { activeListCompiler } from './compilers/index.js'
import type { ListMemberResult } from './types.js'

export interface ListRow {
  id: number
  library_id: number
  name: string
  description: string | null
  media_type: ListMediaType
  filter: string
  mode: 'approval' | 'auto'
  enabled: number
  root_folder_id: number | null
  quality_profile_id: number | null
  monitored: number
  target_tier: string | null
  target_resolution: string | null
  target_source: string | null
  target_codec: string | null
  max_adds_per_run: number
  member_cap: number
  refresh_interval_hours: number
  last_refreshed_at: string | null
  last_error: string | null
  consecutive_failures: number
  created_at: string
  updated_at: string
}

export interface ListItemRow {
  id: number
  list_id: number
  media_type: ListMediaType
  tmdb_id: number
  tvdb_id: number | null
  imdb_id: string | null
  title: string
  year: number | null
  poster_path: string | null
  status: 'new' | 'added' | 'dismissed' | 'in_library' | 'departed' | 'failed'
  status_reason: string | null
  library_item_id: number | null
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
}

function parseFilter(raw: string): FilterNode {
  return FilterNodeSchema.parse(JSON.parse(raw))
}

function publicList(row: ListRow): Record<string, unknown> {
  return {
    id: row.id,
    libraryId: row.library_id,
    name: row.name,
    description: row.description,
    mediaType: row.media_type,
    filter: parseFilter(row.filter),
    mode: row.mode,
    enabled: row.enabled === 1,
    rootFolderId: row.root_folder_id,
    qualityProfileId: row.quality_profile_id,
    monitored: row.monitored === 1,
    targetTier: row.target_tier,
    targetResolution: row.target_resolution,
    targetSource: row.target_source,
    targetCodec: row.target_codec,
    maxAddsPerRun: row.max_adds_per_run,
    memberCap: row.member_cap,
    refreshIntervalHours: row.refresh_interval_hours,
    lastRefreshedAt: row.last_refreshed_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assertLibraryMediaType(db: Database, libraryId: number, mediaType: ListMediaType): void {
  const row = db.prepare('SELECT media_type FROM libraries WHERE id = ?').get(libraryId) as { media_type: string } | undefined
  const expected = mediaType === 'film' ? 'films' : 'series'
  if (!row || row.media_type !== expected) throw new Error(`A ${mediaType} List requires a ${expected} library`)
}

function assertScopedTarget(db: Database, table: 'root_folders' | 'quality_profiles', id: number | null | undefined, libraryId: number): void {
  if (id == null) return
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND library_id IN (0, ?)`).get(id, libraryId)
  if (!row) throw new Error(`${table === 'root_folders' ? 'Root folder' : 'Quality profile'} does not belong to this library`)
}

function assertApprovalOnly(mode: 'approval' | 'auto' | undefined): void {
  if (mode === 'auto') throw new Error('Auto-add is not enabled in the approval-first Lists release')
}

export async function previewList(filter: FilterNode, mediaType: ListMediaType, memberCap: number, db: Database = getDb()): Promise<ListMemberResult> {
  const compiler = activeListCompiler()
  const query = compiler.compile(filter, mediaType)
  const hash = createHash('sha256').update(JSON.stringify({ query, memberCap })).digest('hex')
  const cached = db.prepare(`
    SELECT payload FROM list_query_cache
    WHERE compiler_id = ? AND media_type = ? AND query_hash = ? AND expires_at > datetime('now')
  `).get(compiler.id, mediaType, hash) as { payload: string } | undefined
  if (cached) return JSON.parse(cached.payload) as ListMemberResult

  const result = await compiler.execute(query, { limit: memberCap })
  db.prepare(`
    INSERT INTO list_query_cache (compiler_id, media_type, query_hash, payload, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+30 minutes'))
    ON CONFLICT(compiler_id, media_type, query_hash) DO UPDATE SET
      payload = excluded.payload, fetched_at = datetime('now'), expires_at = excluded.expires_at
  `).run(compiler.id, mediaType, hash, JSON.stringify(result))
  return result
}

export function getListRow(id: number, libraryId?: number, db: Database = getDb()): ListRow | null {
  const sql = `SELECT * FROM lists WHERE id = ?${libraryId == null ? '' : ' AND library_id = ?'}`
  return (libraryId == null ? db.prepare(sql).get(id) : db.prepare(sql).get(id, libraryId)) as ListRow | null
}

export function listLists(libraryId: number, db: Database = getDb()): Array<Record<string, unknown>> {
  const rows = db.prepare(`
    SELECT l.*,
      SUM(CASE WHEN li.status = 'new' THEN 1 ELSE 0 END) AS pending_count,
      COUNT(li.id) AS member_count
    FROM lists l LEFT JOIN list_items li ON li.list_id = l.id
    WHERE l.library_id = ? GROUP BY l.id ORDER BY l.name COLLATE NOCASE
  `).all(libraryId) as Array<ListRow & { pending_count: number; member_count: number }>
  return rows.map(row => ({ ...publicList(row), pendingCount: row.pending_count, memberCount: row.member_count }))
}

export function getListDetail(id: number, libraryId: number, db: Database = getDb()): Record<string, unknown> | null {
  const row = getListRow(id, libraryId, db)
  if (!row) return null
  const counts = db.prepare('SELECT status, COUNT(*) AS count FROM list_items WHERE list_id = ? GROUP BY status').all(id) as Array<{ status: string; count: number }>
  return { ...publicList(row), counts: Object.fromEntries(counts.map(value => [value.status, value.count])) }
}

export function createList(libraryId: number, input: ListCreateRequest, db: Database = getDb()): Record<string, unknown> {
  assertApprovalOnly(input.mode)
  assertLibraryMediaType(db, libraryId, input.mediaType)
  assertScopedTarget(db, 'root_folders', input.rootFolderId, libraryId)
  assertScopedTarget(db, 'quality_profiles', input.qualityProfileId, libraryId)
  const result = db.prepare(`
    INSERT INTO lists (library_id, name, description, media_type, filter, mode, enabled,
      root_folder_id, quality_profile_id, monitored, target_tier, target_resolution, target_source,
      target_codec, max_adds_per_run, member_cap, refresh_interval_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    libraryId, input.name, input.description ?? null, input.mediaType, JSON.stringify(input.filter), input.mode,
    input.enabled ? 1 : 0, input.rootFolderId ?? null, input.qualityProfileId ?? null, input.monitored ? 1 : 0,
    input.targetTier ?? null, input.targetResolution ?? null, input.targetSource ?? null, input.targetCodec ?? null,
    input.maxAddsPerRun, input.memberCap, input.refreshIntervalHours,
  )
  return getListDetail(Number(result.lastInsertRowid), libraryId, db) as Record<string, unknown>
}

const PATCH_COLUMNS: Record<string, string> = {
  name: 'name', description: 'description', filter: 'filter', mode: 'mode', enabled: 'enabled',
  rootFolderId: 'root_folder_id', qualityProfileId: 'quality_profile_id', monitored: 'monitored',
  targetTier: 'target_tier', targetResolution: 'target_resolution', targetSource: 'target_source', targetCodec: 'target_codec',
  maxAddsPerRun: 'max_adds_per_run', memberCap: 'member_cap', refreshIntervalHours: 'refresh_interval_hours',
}

export function updateList(id: number, libraryId: number, input: ListPatchRequest, db: Database = getDb()): Record<string, unknown> | null {
  const current = getListRow(id, libraryId, db)
  if (!current) return null
  assertApprovalOnly(input.mode)
  assertScopedTarget(db, 'root_folders', input.rootFolderId, libraryId)
  assertScopedTarget(db, 'quality_profiles', input.qualityProfileId, libraryId)
  const entries = Object.entries(input)
  if (!entries.length) return getListDetail(id, libraryId, db)
  const values = entries.map(([key, value]) => {
    if (key === 'filter') return JSON.stringify(value)
    if (key === 'enabled' || key === 'monitored') return value ? 1 : 0
    return value
  })
  db.prepare(`UPDATE lists SET ${entries.map(([key]) => `${PATCH_COLUMNS[key]} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ? AND library_id = ?`)
    .run(...values, id, libraryId)
  return getListDetail(id, libraryId, db)
}

export function deleteList(id: number, libraryId: number, db: Database = getDb()): boolean {
  return db.prepare('DELETE FROM lists WHERE id = ? AND library_id = ?').run(id, libraryId).changes === 1
}

export function listListItems(id: number, libraryId: number, query: ListItemsQuery, db: Database = getDb()): { items: ListItemRow[]; total: number; page: number; pageSize: number } | null {
  if (!getListRow(id, libraryId, db)) return null
  const where = query.status ? ' AND status = ?' : ''
  const args = query.status ? [id, query.status] : [id]
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM list_items WHERE list_id = ?${where}`).get(...args) as { count: number }).count
  const items = db.prepare(`SELECT * FROM list_items WHERE list_id = ?${where} ORDER BY first_seen_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, query.pageSize, (query.page - 1) * query.pageSize) as ListItemRow[]
  return { items, total, page: query.page, pageSize: query.pageSize }
}

export function listRuns(id: number, libraryId: number, db: Database = getDb()): unknown[] | null {
  if (!getListRow(id, libraryId, db)) return null
  return db.prepare('SELECT * FROM list_refresh_runs WHERE list_id = ? ORDER BY id DESC LIMIT 100').all(id)
}

export function pendingListCount(db: Database = getDb()): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.status = 'new' AND l.enabled = 1").get() as { count: number }).count
}

export async function addListItem(listId: number, itemId: number, libraryId: number, quality: ListAddQuality = {}, db: Database = getDb()): Promise<ListItemRow | null> {
  const list = getListRow(listId, libraryId, db)
  if (!list) return null
  const item = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?').get(itemId, listId) as ListItemRow | undefined
  if (!item) return null
  if (item.status === 'added' || item.status === 'in_library') return item
  try {
    const localId = item.media_type === 'film'
      ? await createFilmFromTmdb(db, list.library_id, item.tmdb_id, {
          monitored: list.monitored === 1,
          qualityProfileId: list.quality_profile_id,
          target_tier: quality.target_tier ?? list.target_tier,
          target_resolution: quality.target_resolution ?? list.target_resolution,
          target_source: quality.target_source ?? list.target_source,
          target_codec: quality.target_codec ?? list.target_codec,
          minimum_tier: quality.minimum_tier ?? quality.target_tier ?? list.target_tier,
          minimum_resolution: quality.minimum_resolution ?? quality.target_resolution ?? list.target_resolution,
          minimum_source: quality.minimum_source ?? quality.target_source ?? list.target_source,
          minimum_codec: quality.minimum_codec ?? quality.target_codec ?? list.target_codec,
        })
      : await createSeriesFromMetadata(db, list.library_id, { tmdbId: item.tmdb_id, tvdbId: item.tvdb_id ?? undefined }, {
          monitored: list.monitored === 1,
          qualityProfileId: list.quality_profile_id,
          target_tier: quality.target_tier ?? list.target_tier,
          target_resolution: quality.target_resolution ?? list.target_resolution,
          target_source: quality.target_source ?? list.target_source,
          target_codec: quality.target_codec ?? list.target_codec,
          minimum_tier: quality.minimum_tier ?? quality.target_tier ?? list.target_tier,
          minimum_resolution: quality.minimum_resolution ?? quality.target_resolution ?? list.target_resolution,
          minimum_source: quality.minimum_source ?? quality.target_source ?? list.target_source,
          minimum_codec: quality.minimum_codec ?? quality.target_codec ?? list.target_codec,
        })
    db.prepare("UPDATE list_items SET status = 'added', library_item_id = ?, status_reason = NULL, resolved_at = datetime('now') WHERE id = ?").run(localId, itemId)
    recordEvent({ category: 'lists', action: 'item-added', subjectType: 'list', subjectId: String(listId), message: `Added ${item.title} from ${list.name}`, data: { listId, itemId, localId, mediaType: item.media_type } }, db)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db.prepare("UPDATE list_items SET status = 'failed', status_reason = ?, resolved_at = datetime('now') WHERE id = ?").run(message.slice(0, 1000), itemId)
    throw error
  }
  return db.prepare('SELECT * FROM list_items WHERE id = ?').get(itemId) as ListItemRow
}

export function dismissListItem(listId: number, itemId: number, libraryId: number, db: Database = getDb()): ListItemRow | null {
  if (!getListRow(listId, libraryId, db)) return null
  const result = db.prepare("UPDATE list_items SET status = 'dismissed', status_reason = 'Dismissed by user', resolved_at = datetime('now') WHERE id = ? AND list_id = ?").run(itemId, listId)
  if (!result.changes) return null
  return db.prepare('SELECT * FROM list_items WHERE id = ?').get(itemId) as ListItemRow
}

export { parseFilter, publicList }
