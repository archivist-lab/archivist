/**
 * In-memory title index. For every monitored item across every tab, stores a
 * normalized-slug → SubjectRef[] mapping. The release-identification step uses
 * this for an O(1) lookup instead of iterating every monitored row per release.
 *
 * Refreshed at startup and on a 2-minute interval. The query is cheap
 * (id+title+year per tab); if it ever isn't, switch to incremental refresh
 * triggered by series/film/album add/remove hooks.
 */

import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { normalizeTitle } from './parser.js'

const logger = createLogger('TitleIndex')

const REFRESH_INTERVAL_MS = 2 * 60 * 1000

export type SubjectMediaType = 'films' | 'series' | 'music' | 'books' | 'comics' | 'games'

export interface SubjectRef {
  tabId: number
  tabName: string
  dbPath: string
  mediaType: SubjectMediaType
  subjectType: 'film' | 'series' | 'album' | 'book' | 'comic-issue' | 'game'
  subjectId: string
  primaryTitle: string
  year: number | null
}

interface IndexState {
  byTitle: Map<string, SubjectRef[]>
  builtAt: number
  size: number
}

let state: IndexState = { byTitle: new Map(), builtAt: 0, size: 0 }
let timer: NodeJS.Timeout | null = null

function addEntry(map: Map<string, SubjectRef[]>, key: string, ref: SubjectRef) {
  if (!key) return
  const list = map.get(key)
  if (list) list.push(ref)
  else map.set(key, [ref])
}

function buildFromLibrary(library: { id: number; name: string; media_type: string; db_path: string }, byTitle: Map<string, SubjectRef[]>): number {
  const db = getDb()
  let count = 0

  const baseRef = (extras: Pick<SubjectRef, 'subjectType' | 'subjectId' | 'primaryTitle' | 'year'>): SubjectRef => ({
    tabId: library.id,
    tabName: library.name,
    dbPath: library.db_path,
    mediaType: library.media_type as SubjectMediaType,
    ...extras,
  })

  if (library.media_type === 'films') {
    const rows = db.prepare('SELECT id, title, year FROM films WHERE library_id = ? AND monitored = 1').all(library.id) as Array<{ id: number; title: string; year: number | null }>
    for (const row of rows) {
      const ref = baseRef({ subjectType: 'film', subjectId: String(row.id), primaryTitle: row.title, year: row.year })
      addEntry(byTitle, normalizeTitle(row.title), ref)
      count++
    }
  } else if (library.media_type === 'series') {
    const rows = db.prepare('SELECT id, title, year FROM series WHERE library_id = ? AND monitored = 1').all(library.id) as Array<{ id: number; title: string; year: number | null }>
    for (const row of rows) {
      const ref = baseRef({ subjectType: 'series', subjectId: String(row.id), primaryTitle: row.title, year: row.year })
      addEntry(byTitle, normalizeTitle(row.title), ref)
      // Stripped-year variant for shows whose canonical title includes the year, e.g. "Doctor Who (2005)"
      const stripped = row.title.replace(/\s*\(\d{4}\)\s*$/, '').trim()
      if (stripped !== row.title) addEntry(byTitle, normalizeTitle(stripped), ref)
      count++
    }
  } else if (library.media_type === 'music') {
    const rows = db.prepare(`
      SELECT al.id as album_id, al.title as album_title, ar.name as artist_name
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      WHERE ar.library_id = ? AND ar.monitored = 1 AND al.monitored = 1
    `).all(library.id) as Array<{ album_id: number; album_title: string; artist_name: string }>
    for (const row of rows) {
      const ref = baseRef({ subjectType: 'album', subjectId: String(row.album_id), primaryTitle: `${row.artist_name} - ${row.album_title}`, year: null })
      addEntry(byTitle, normalizeTitle(`${row.artist_name} ${row.album_title}`), ref)
      addEntry(byTitle, normalizeTitle(row.album_title), ref)
      count++
    }
  } else if (library.media_type === 'books') {
    const rows = db.prepare(`
      SELECT b.id, b.title, b.year, a.name AS author_name
      FROM books b JOIN authors a ON a.id = b.author_id
      WHERE a.library_id = ? AND a.monitored = 1 AND b.monitored = 1
    `).all(library.id) as Array<{ id: number; title: string; year: number | null; author_name: string }>
    for (const row of rows) {
      const ref = baseRef({
        subjectType: 'book',
        subjectId: String(row.id),
        primaryTitle: row.author_name + ' - ' + row.title,
        year: row.year,
      })
      addEntry(byTitle, normalizeTitle(row.author_name + ' ' + row.title), ref)
      addEntry(byTitle, normalizeTitle(row.title), ref)
      count++
    }
  } else if (library.media_type === 'comics') {
    const rows = db.prepare(`
      SELECT i.id, i.issue_number, i.year, s.title AS series_title
      FROM comic_issues i JOIN comic_series s ON s.id = i.series_id
      WHERE s.library_id = ? AND s.monitored = 1 AND i.monitored = 1
    `).all(library.id) as Array<{ id: number; issue_number: string; year: number | null; series_title: string }>
    for (const row of rows) {
      const ref = baseRef({
        subjectType: 'comic-issue',
        subjectId: String(row.id),
        primaryTitle: row.series_title + ' #' + row.issue_number,
        year: row.year,
      })
      const numeric = /^\d+$/.test(row.issue_number) ? Number(row.issue_number) : null
      const variants = new Set([
        row.series_title + ' ' + row.issue_number,
        row.series_title + ' issue ' + row.issue_number,
        ...(numeric === null ? [] : [
          row.series_title + ' ' + String(numeric).padStart(2, '0'),
          row.series_title + ' ' + String(numeric).padStart(3, '0'),
        ]),
      ])
      for (const variant of variants) addEntry(byTitle, normalizeTitle(variant), ref)
      count++
    }
  } else if (library.media_type === 'games') {
    const rows = db.prepare('SELECT id, title, year FROM games WHERE library_id = ? AND monitored = 1').all(library.id) as Array<{ id: number; title: string; year: number | null }>
    for (const row of rows) {
      const ref = baseRef({ subjectType: 'game', subjectId: String(row.id), primaryTitle: row.title, year: row.year })
      addEntry(byTitle, normalizeTitle(row.title), ref)
      count++
    }
  }

  return count
}

export function rebuildTitleIndex(): IndexState {
  const start = Date.now()
  const byTitle = new Map<string, SubjectRef[]>()
  let size = 0
  try {
    const libraries = getDb().prepare('SELECT id, name, media_type, db_path FROM libraries').all() as Array<{ id: number; name: string; media_type: string; db_path: string }>
    for (const library of libraries) {
      try {
        size += buildFromLibrary(library, byTitle)
      } catch (err) {
        logger.warn(`Index build failed for library "${library.name}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    logger.error(`Index build failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  state = { byTitle, builtAt: Date.now(), size }
  logger.info(`Title index rebuilt: ${size} subjects, ${byTitle.size} unique slugs (${Date.now() - start}ms)`)
  return state
}

export function startTitleIndex(): void {
  if (timer) return
  rebuildTitleIndex()
  timer = setInterval(() => {
    try { rebuildTitleIndex() } catch (err) { logger.error('Index refresh error:', err) }
  }, REFRESH_INTERVAL_MS)
}

export function stopTitleIndex(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function getTitleIndex(): IndexState {
  if (state.builtAt === 0) rebuildTitleIndex()
  return state
}

/** Look up a normalized title slug. Returns all matching subjects (caller disambiguates by year/etc). */
export function lookupBySlug(slug: string): SubjectRef[] {
  return getTitleIndex().byTitle.get(slug) ?? []
}
