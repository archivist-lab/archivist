import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

// Normalized people & credit index derived from the cast/crew JSON on films and
// series. Rebuilt per-item on add/refresh and by an idempotent backfill. People
// are deduplicated by their TMDB id (every provider credit carries one); a
// name-only fallback exists only for the rare credit with no provider id.

export function normalizePersonName(name: string): string {
  return String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase().replace(/\s+/g, ' ').trim()
}

// Raw provider crew "job" (lower-cased) → Archivist normalized role.
const ROLE_MAP: Record<string, string> = {
  'director': 'director', 'series director': 'director',
  'writer': 'writer', 'screenplay': 'writer', 'teleplay': 'writer', 'story': 'writer', 'author': 'writer', 'novel': 'writer',
  'producer': 'producer', 'co-producer': 'producer',
  'executive producer': 'executive_producer', 'co-executive producer': 'executive_producer',
  'original music composer': 'composer', 'music': 'composer', 'composer': 'composer', 'music by': 'composer',
  'director of photography': 'cinematographer', 'cinematography': 'cinematographer', 'cinematographer': 'cinematographer',
  'editor': 'editor', 'film editor': 'editor',
  'creator': 'creator', 'original series creator': 'creator', 'series creator': 'creator',
}

export function normalizeCrewRole(job: string | null | undefined): string | null {
  if (!job) return null
  return ROLE_MAP[String(job).toLowerCase().trim()] ?? null
}

type CreditPerson = { id?: number; name?: string; character?: string; job?: string; profilePath?: string }
type MediaType = 'film' | 'series'

function upsertPerson(db: Database, p: CreditPerson): number | null {
  if (!p?.name) return null
  const norm = normalizePersonName(p.name)
  if (p.id != null && Number.isFinite(p.id)) {
    const existing = db.prepare('SELECT id FROM people WHERE tmdb_id = ?').get(p.id) as { id: number } | undefined
    if (existing) {
      db.prepare("UPDATE people SET name = ?, normalized_name = ?, profile_path = COALESCE(?, profile_path), updated_at = datetime('now') WHERE id = ?")
        .run(p.name, norm, p.profilePath ?? null, existing.id)
      return existing.id
    }
    const r = db.prepare('INSERT INTO people (tmdb_id, name, normalized_name, profile_path) VALUES (?, ?, ?, ?)')
      .run(p.id, p.name, norm, p.profilePath ?? null)
    return Number(r.lastInsertRowid)
  }
  // No provider id — dedupe on normalized name among id-less people only.
  const existing = db.prepare('SELECT id FROM people WHERE tmdb_id IS NULL AND normalized_name = ?').get(norm) as { id: number } | undefined
  if (existing) return existing.id
  const r = db.prepare('INSERT INTO people (name, normalized_name) VALUES (?, ?)').run(p.name, norm)
  return Number(r.lastInsertRowid)
}

/** Rebuilds the credit rows for a single media item (delete + reinsert = idempotent). */
export function indexMediaCredits(db: Database, mediaType: MediaType, mediaId: number, cast: CreditPerson[], crew: CreditPerson[]): void {
  const run = db.transaction(() => {
    db.prepare('DELETE FROM media_credits WHERE media_type = ? AND media_id = ?').run(mediaType, mediaId)
    const ins = db.prepare(`INSERT INTO media_credits
      (media_type, media_id, person_id, credit_type, role, job, character, billing_order, is_starring)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const seen = new Set<string>()
    cast.forEach((c, i) => {
      const pid = upsertPerson(db, c)
      if (pid == null) return
      const key = `${pid}:cast`
      if (seen.has(key)) return
      seen.add(key)
      ins.run(mediaType, mediaId, pid, 'cast', null, null, c.character ?? null, i, i < 5 ? 1 : 0)
    })
    for (const c of crew) {
      const pid = upsertPerson(db, c)
      if (pid == null) continue
      const role = normalizeCrewRole(c.job)
      const key = `${pid}:crew:${role ?? c.job ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      ins.run(mediaType, mediaId, pid, 'crew', role, c.job ?? null, null, null, 0)
    }
  })
  run()
}

function safeArray(json: unknown): CreditPerson[] {
  try { const a = JSON.parse(String(json ?? '[]')); return Array.isArray(a) ? a : [] } catch { return [] }
}

/** Convenience: reindex a media item straight from its stored cast/crew JSON. */
export function indexMediaCreditsFromJson(db: Database, mediaType: MediaType, mediaId: number, castJson: unknown, crewJson: unknown): void {
  try { indexMediaCredits(db, mediaType, mediaId, safeArray(castJson), safeArray(crewJson)) }
  catch { /* indexing is best-effort; never block a write path */ }
}

export function isCreditIndexEmpty(db: Database = getDb()): boolean {
  return (db.prepare('SELECT COUNT(*) AS c FROM media_credits').get() as { c: number }).c === 0
}

export function hasLibraryMedia(db: Database = getDb()): boolean {
  const f = (db.prepare('SELECT 1 FROM films LIMIT 1').get()) ?? (db.prepare('SELECT 1 FROM series LIMIT 1').get())
  return !!f
}

/** Idempotent full backfill over every film and series. */
export function reindexAllCredits(db: Database = getDb()): { films: number; series: number } {
  let films = 0, series = 0
  for (const row of db.prepare('SELECT id, "cast" AS c, crew FROM films').all() as Array<{ id: number; c: unknown; crew: unknown }>) {
    indexMediaCreditsFromJson(db, 'film', row.id, row.c, row.crew); films++
  }
  for (const row of db.prepare('SELECT id, "cast" AS c, crew FROM series').all() as Array<{ id: number; c: unknown; crew: unknown }>) {
    indexMediaCreditsFromJson(db, 'series', row.id, row.c, row.crew); series++
  }
  return { films, series }
}
