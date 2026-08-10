import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

export const COLLECTION_ENTITY_TYPES = [
  'film', 'series', 'artist', 'album', 'author', 'book', 'comic_series', 'comic_issue', 'game',
] as const
export type CollectionEntityType = typeof COLLECTION_ENTITY_TYPES[number]

interface CollectionRow {
  id: number
  name: string
  description: string | null
  poster_url: string | null
  backdrop_url: string | null
  logo_url: string | null
  created_at: string
  updated_at: string
  member_count?: number
}

export interface CollectionInput {
  name: string
  description?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  logoUrl?: string | null
}

export interface CollectionCandidate {
  entityType: CollectionEntityType
  itemId: number
  libraryId: number
  libraryName: string
  mediaType: 'films' | 'series' | 'music' | 'books' | 'comics' | 'games'
  title: string
  subtitle: string | null
  year: number | null
  artworkUrl: string | null
}

const ENTITY_UNION = `
  SELECT 'film' entity_type, f.id item_id, f.library_id, l.name library_name, 'films' media_type,
    f.title, NULL subtitle, f.year, f.poster_path artwork_url FROM films f JOIN libraries l ON l.id=f.library_id
  UNION ALL SELECT 'series', s.id, s.library_id, l.name, 'series', s.title, NULL, s.year, s.poster_path
    FROM series s JOIN libraries l ON l.id=s.library_id
  UNION ALL SELECT 'artist', a.id, a.library_id, l.name, 'music', a.name, NULL, NULL, a.image_url
    FROM artists a JOIN libraries l ON l.id=a.library_id
  UNION ALL SELECT 'album', a.id, ar.library_id, l.name, 'music', a.title, ar.name, a.year, a.cover_url
    FROM albums a JOIN artists ar ON ar.id=a.artist_id JOIN libraries l ON l.id=ar.library_id
  UNION ALL SELECT 'author', a.id, a.library_id, l.name, 'books', a.name, NULL, NULL, a.image_url
    FROM authors a JOIN libraries l ON l.id=a.library_id
  UNION ALL SELECT 'book', b.id, a.library_id, l.name, 'books', b.title, a.name, b.year, b.cover_url
    FROM books b JOIN authors a ON a.id=b.author_id JOIN libraries l ON l.id=a.library_id
  UNION ALL SELECT 'comic_series', c.id, c.library_id, l.name, 'comics', c.title, c.publisher, c.start_year, c.image_url
    FROM comic_series c JOIN libraries l ON l.id=c.library_id
  UNION ALL SELECT 'comic_issue', i.id, c.library_id, l.name, 'comics',
    COALESCE(NULLIF(i.title,''), c.title || ' #' || i.issue_number), c.title || ' #' || i.issue_number, i.year, i.image_url
    FROM comic_issues i JOIN comic_series c ON c.id=i.series_id JOIN libraries l ON l.id=c.library_id
  UNION ALL SELECT 'game', g.id, g.library_id, l.name, 'games', g.title, g.developer, g.year, g.cover_url
    FROM games g JOIN libraries l ON l.id=g.library_id
`

function publicCollection(row: CollectionRow) {
  return {
    id: row.id, name: row.name, description: row.description,
    posterUrl: row.poster_url, backdropUrl: row.backdrop_url, logoUrl: row.logo_url,
    createdAt: row.created_at, updatedAt: row.updated_at, memberCount: Number(row.member_count ?? 0),
  }
}

function cleanText(value: unknown, max: number, required = false): string | null {
  if (value == null) {
    if (required) throw new Error('Name is required')
    return null
  }
  const text = String(value).trim()
  if (!text) {
    if (required) throw new Error('Name is required')
    return null
  }
  if (text.length > max) throw new Error(`Value must be ${max} characters or fewer`)
  return text
}

function cleanArtworkUrl(value: unknown): string | null {
  const text = cleanText(value, 2048)
  if (text && /^javascript:/i.test(text)) throw new Error('Artwork URL is not allowed')
  return text
}

function candidate(row: any): CollectionCandidate {
  return {
    entityType: row.entity_type, itemId: Number(row.item_id), libraryId: Number(row.library_id),
    libraryName: row.library_name, mediaType: row.media_type, title: row.title,
    subtitle: row.subtitle ?? null, year: row.year == null ? null : Number(row.year), artworkUrl: row.artwork_url ?? null,
  }
}

function findEntity(entityType: CollectionEntityType, itemId: number, libraryId: number, db: Database): CollectionCandidate | null {
  const row = db.prepare(`SELECT * FROM (${ENTITY_UNION}) WHERE entity_type=? AND item_id=? AND library_id=?`).get(entityType, itemId, libraryId)
  return row ? candidate(row) : null
}

export function listCollections(db: Database = getDb()) {
  const rows = db.prepare(`SELECT c.*, COUNT(ci.id) member_count FROM collections c
    LEFT JOIN collection_items ci ON ci.collection_id=c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE`).all() as CollectionRow[]
  return rows.map(publicCollection)
}

export function getCollection(id: number, db: Database = getDb()) {
  const row = db.prepare(`SELECT c.*, COUNT(ci.id) member_count FROM collections c
    LEFT JOIN collection_items ci ON ci.collection_id=c.id WHERE c.id=? GROUP BY c.id`).get(id) as CollectionRow | undefined
  if (!row) return null
  const memberships = db.prepare('SELECT * FROM collection_items WHERE collection_id=? ORDER BY position,id').all(id) as any[]
  const items = memberships.map(membership => ({
    membershipId: Number(membership.id), position: Number(membership.position), addedAt: membership.added_at,
    ...(findEntity(membership.entity_type, Number(membership.item_id), Number(membership.library_id), db)
      ?? { entityType: membership.entity_type, itemId: Number(membership.item_id), libraryId: Number(membership.library_id), libraryName: 'Unavailable', mediaType: 'films', title: 'Missing item', subtitle: null, year: null, artworkUrl: null }),
  }))
  return { ...publicCollection(row), items }
}

export function createCollection(input: CollectionInput, db: Database = getDb()) {
  const result = db.prepare(`INSERT INTO collections(name,description,poster_url,backdrop_url,logo_url) VALUES(?,?,?,?,?)`).run(
    cleanText(input.name, 120, true), cleanText(input.description, 5000), cleanArtworkUrl(input.posterUrl),
    cleanArtworkUrl(input.backdropUrl), cleanArtworkUrl(input.logoUrl),
  )
  return getCollection(Number(result.lastInsertRowid), db)!
}

export function updateCollection(id: number, input: Partial<CollectionInput>, db: Database = getDb()) {
  if (!db.prepare('SELECT id FROM collections WHERE id=?').get(id)) return null
  const columns: string[] = []
  const values: unknown[] = []
  const fields: Array<[keyof CollectionInput, string, (value: unknown) => string | null]> = [
    ['name', 'name', value => cleanText(value, 120, true)], ['description', 'description', value => cleanText(value, 5000)],
    ['posterUrl', 'poster_url', cleanArtworkUrl], ['backdropUrl', 'backdrop_url', cleanArtworkUrl], ['logoUrl', 'logo_url', cleanArtworkUrl],
  ]
  for (const [key, column, normalize] of fields) if (Object.prototype.hasOwnProperty.call(input, key)) {
    columns.push(`${column}=?`); values.push(normalize(input[key]))
  }
  if (columns.length) db.prepare(`UPDATE collections SET ${columns.join(',')},updated_at=datetime('now') WHERE id=?`).run(...values, id)
  return getCollection(id, db)
}

export function deleteCollection(id: number, db: Database = getDb()): boolean {
  return db.prepare('DELETE FROM collections WHERE id=?').run(id).changes === 1
}

export function searchCollectionCandidates(query: string, mediaType?: string, db: Database = getDb()): CollectionCandidate[] {
  const term = query.trim()
  if (term.length < 2) return []
  const mediaWhere = mediaType && ['films','series','music','books','comics','games'].includes(mediaType) ? ' AND media_type=?' : ''
  const args = mediaWhere ? [`%${term}%`, mediaType] : [`%${term}%`]
  return (db.prepare(`SELECT * FROM (${ENTITY_UNION}) WHERE title LIKE ? COLLATE NOCASE${mediaWhere} ORDER BY title COLLATE NOCASE LIMIT 100`).all(...args) as any[]).map(candidate)
}

export function addCollectionItem(collectionId: number, entityType: CollectionEntityType, itemId: number, libraryId: number, db: Database = getDb()) {
  if (!db.prepare('SELECT id FROM collections WHERE id=?').get(collectionId)) return null
  if (!COLLECTION_ENTITY_TYPES.includes(entityType) || !findEntity(entityType, itemId, libraryId, db)) throw new Error('The selected library item does not exist')
  const position = Number((db.prepare('SELECT COALESCE(MAX(position),-1)+1 value FROM collection_items WHERE collection_id=?').get(collectionId) as any).value)
  db.prepare(`INSERT INTO collection_items(collection_id,entity_type,library_id,item_id,position) VALUES(?,?,?,?,?)
    ON CONFLICT(collection_id,entity_type,library_id,item_id) DO NOTHING`).run(collectionId, entityType, libraryId, itemId, position)
  return getCollection(collectionId, db)
}

export function removeCollectionItem(collectionId: number, membershipId: number, db: Database = getDb()) {
  const changed = db.prepare('DELETE FROM collection_items WHERE id=? AND collection_id=?').run(membershipId, collectionId).changes
  if (!changed) return null
  const rows = db.prepare('SELECT id FROM collection_items WHERE collection_id=? ORDER BY position,id').all(collectionId) as Array<{ id: number }>
  const update = db.prepare('UPDATE collection_items SET position=? WHERE id=?')
  db.transaction(() => rows.forEach((row, index) => update.run(index, row.id)))()
  return getCollection(collectionId, db)
}

export function reorderCollectionItems(collectionId: number, membershipIds: number[], db: Database = getDb()) {
  const current = (db.prepare('SELECT id FROM collection_items WHERE collection_id=? ORDER BY position,id').all(collectionId) as Array<{ id: number }>).map(row => Number(row.id))
  if (current.length !== membershipIds.length || [...current].sort((a,b) => a-b).some((id,index) => id !== [...membershipIds].sort((a,b) => a-b)[index])) {
    throw new Error('Item order must contain every collection member exactly once')
  }
  const update = db.prepare('UPDATE collection_items SET position=? WHERE id=? AND collection_id=?')
  db.transaction(() => membershipIds.forEach((id, index) => update.run(index, id, collectionId)))()
  return getCollection(collectionId, db)
}
