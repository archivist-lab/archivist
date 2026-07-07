import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, cpSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Database } from 'better-sqlite3'
import { createLogger } from '@archivist/core'
import { getMediaRoot } from './media-organizer.js'
import { rootForLibrary, sanitizeLibraryFolder, libraryCountForType } from './library-paths.js'

const logger = createLogger('LibraryMigration')

/** Path-bearing columns per media type, with a scope predicate keyed by library_id. */
interface PathTable {
  table: string
  /** URL-form columns stored as `/media/...`. */
  urlCols: string[]
  /** Filesystem-absolute columns stored as `<mediaRoot>/...`. */
  fsCols: string[]
  /** WHERE clause selecting rows belonging to library id `?`. */
  scope: string
}

const PATH_TABLES: Record<string, PathTable[]> = {
  films: [
    { table: 'films', urlCols: ['poster_path', 'backdrop_path', 'logo_path', 'banner_path'], fsCols: ['root_folder_path', 'file_path'], scope: 'library_id = ?' },
    { table: 'film_editions', urlCols: ['poster_path', 'backdrop_path'], fsCols: ['file_path'], scope: 'film_id IN (SELECT id FROM films WHERE library_id = ?)' },
  ],
  series: [
    { table: 'series', urlCols: ['poster_path', 'backdrop_path', 'logo_path', 'banner_path'], fsCols: ['root_folder_path'], scope: 'library_id = ?' },
    { table: 'seasons', urlCols: ['poster_path'], fsCols: [], scope: 'series_id IN (SELECT id FROM series WHERE library_id = ?)' },
    { table: 'episodes', urlCols: ['still_path'], fsCols: ['file_path'], scope: 'series_id IN (SELECT id FROM series WHERE library_id = ?)' },
    { table: 'episode_files', urlCols: [], fsCols: ['file_path'], scope: 'episode_id IN (SELECT e.id FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ?)' },
  ],
  music: [
    { table: 'artists', urlCols: ['image_url', 'backdrop_url', 'logo_url'], fsCols: ['root_folder_path'], scope: 'library_id = ?' },
    { table: 'albums', urlCols: ['cover_url', 'cdart_url'], fsCols: [], scope: 'artist_id IN (SELECT id FROM artists WHERE library_id = ?)' },
    { table: 'tracks', urlCols: [], fsCols: ['file_path'], scope: 'album_id IN (SELECT al.id FROM albums al JOIN artists ar ON al.artist_id = ar.id WHERE ar.library_id = ?)' },
  ],
  books: [
    { table: 'authors', urlCols: ['image_url'], fsCols: ['root_folder_path'], scope: 'library_id = ?' },
    { table: 'books', urlCols: ['cover_url'], fsCols: [], scope: 'author_id IN (SELECT id FROM authors WHERE library_id = ?)' },
    { table: 'book_editions', urlCols: [], fsCols: ['file_path'], scope: 'book_id IN (SELECT b.id FROM books b JOIN authors a ON b.author_id = a.id WHERE a.library_id = ?)' },
  ],
  comics: [
    { table: 'comic_series', urlCols: ['image_url'], fsCols: ['root_folder_path'], scope: 'library_id = ?' },
    { table: 'comic_issues', urlCols: ['image_url'], fsCols: ['file_path'], scope: 'series_id IN (SELECT id FROM comic_series WHERE library_id = ?)' },
  ],
  games: [
    { table: 'games', urlCols: ['cover_url', 'screenshot_url'], fsCols: ['root_folder_path', 'file_path'], scope: 'library_id = ?' },
  ],
}

function mediaUrlPrefix(absRoot: string): string {
  // absRoot is <mediaRoot>/<type>[/<name>]; the served URL prefix is /media/<rel>
  const rel = relative(getMediaRoot(), absRoot).split(sep).join('/')
  return `/media/${rel}`
}

/** Move every entry from `fromDir` into `toDir` (same filesystem → rename; falls back to copy). */
function moveDirContents(fromDir: string, toDir: string, skip: Set<string>): number {
  if (!existsSync(fromDir)) return 0
  mkdirSync(toDir, { recursive: true })
  let moved = 0
  for (const entry of readdirSync(fromDir)) {
    if (skip.has(entry)) continue
    const src = join(fromDir, entry)
    const dst = join(toDir, entry)
    try {
      renameSync(src, dst)
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        cpSync(src, dst, { recursive: true })
        rmSync(src, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    moved++
  }
  return moved
}

function rewritePaths(db: Database, mediaType: string, libraryId: number, fromRoot: string, toRoot: string): void {
  const fromUrl = mediaUrlPrefix(fromRoot)
  const toUrl = mediaUrlPrefix(toRoot)
  const tables = PATH_TABLES[mediaType] ?? []

  const rewriteCol = (table: string, col: string, scope: string, oldPrefix: string, newPrefix: string) => {
    // Anchored prefix swap: exact match or `<prefix>/...`. substr keeps the tail
    // (including the leading separator) so no delimiter is lost or doubled.
    db.prepare(
      `UPDATE ${table} SET ${col} = ? || substr(${col}, ?) WHERE (${scope}) AND (${col} = ? OR ${col} LIKE ? ESCAPE '\\')`,
    ).run(newPrefix, oldPrefix.length + 1, libraryId, oldPrefix, `${oldPrefix.replace(/[%_\\]/g, '\\$&')}/%`)
  }

  for (const t of tables) {
    for (const col of t.fsCols) rewriteCol(t.table, col, t.scope, fromRoot, toRoot)
    for (const col of t.urlCols) rewriteCol(t.table, col, t.scope, fromUrl, toUrl)
  }
}

export interface LibraryReconcileResult {
  moved: number
  fromRoot: string
  toRoot: string
  changed: boolean
}

/**
 * Reconcile one library's on-disk layout to match the current library count for
 * its type: move its item folders between the flat `media/<type>` and the
 * namespaced `media/<type>/<name>` locations, then rewrite every stored path
 * (filesystem and served-URL forms) for that library's items.
 *
 * Files move first (near-instant same-filesystem renames); the database rewrite
 * runs in a single transaction afterward, and a failure attempts to move the
 * files back so we never leave paths pointing at the wrong place.
 */
export function reconcileLibraryLayout(db: Database, library: { id: number; name: string; media_type: string }): LibraryReconcileResult {
  const typeDir = join(getMediaRoot(), library.media_type)
  const siblingCount = libraryCountForType(db, library.media_type)
  const toRoot = rootForLibrary(library.media_type, library.name, siblingCount)
  // The other possible location: whichever of flat/namespaced isn't the target.
  const namespaced = join(typeDir, sanitizeLibraryFolder(library.name))
  const fromRoot = toRoot === typeDir ? namespaced : typeDir

  if (toRoot === fromRoot) return { moved: 0, fromRoot, toRoot, changed: false }

  const goingNamespaced = toRoot !== typeDir
  // When flattening we take everything under the namespaced dir; when
  // namespacing we take everything in the flat type dir except the new subdir.
  const skip = goingNamespaced ? new Set([sanitizeLibraryFolder(library.name)]) : new Set<string>()

  let moved = 0
  try {
    moved = moveDirContents(fromRoot, toRoot, skip)
  } catch (err) {
    logger.error(`File move failed for library "${library.name}" (${fromRoot} → ${toRoot}): ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }

  try {
    db.transaction(() => rewritePaths(db, library.media_type, library.id, fromRoot, toRoot))()
  } catch (err) {
    logger.error(`DB path rewrite failed for "${library.name}"; rolling back file move`)
    try { moveDirContents(toRoot, fromRoot, goingNamespaced ? new Set<string>() : new Set([sanitizeLibraryFolder(library.name)])) } catch {}
    throw err
  }

  // Clean up an emptied namespaced folder after flattening.
  if (!goingNamespaced && existsSync(namespaced)) {
    try { if (readdirSync(namespaced).length === 0) rmdirSync(namespaced) } catch {}
  }

  logger.info(`Reconciled library "${library.name}" (${library.media_type}): ${fromRoot} → ${toRoot} (${moved} folders)`)
  return { moved, fromRoot, toRoot, changed: true }
}

/**
 * After a library is added or removed, fix up siblings that just crossed the
 * single↔multiple boundary:
 *  - added and count is now exactly 2 → namespace the pre-existing library
 *  - removed and count is now exactly 1 → flatten the remaining library
 * (Counts of 3+ or drops to 2+ leave the already-namespaced siblings alone.)
 */
export function reconcileTypeAfterChange(db: Database, mediaType: string): LibraryReconcileResult[] {
  const libs = db.prepare('SELECT id, name, media_type FROM libraries WHERE media_type = ? ORDER BY id ASC').all(mediaType) as Array<{ id: number; name: string; media_type: string }>
  const results: LibraryReconcileResult[] = []
  if (libs.length === 2) {
    // Just became multi: the older library (lower id) needs namespacing; the
    // newer one has no items yet and roots correctly on first use.
    results.push(reconcileLibraryLayout(db, libs[0]))
  } else if (libs.length === 1) {
    // Just became single: flatten the survivor.
    results.push(reconcileLibraryLayout(db, libs[0]))
  }
  return results
}
