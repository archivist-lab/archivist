import { join, resolve as resolvePath, sep } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import type { Database } from 'better-sqlite3'
import { getMediaRoot } from './media-organizer.js'

/**
 * Per-library media root resolution.
 *
 * A media type with a single library keeps the flat layout `media/<type>` so a
 * simple one-library install needs no nesting. The moment a second library of
 * the same type exists, every library of that type is namespaced under
 * `media/<type>/<library name>` (see library-migration for the on-disk move).
 */

/**
 * Folder name for a library: lower-cased, with characters that are illegal in
 * folder names stripped. (Item folders inside keep their title case; only the
 * library folder is lower-cased.) Never returns empty.
 */
export function sanitizeLibraryFolder(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().toLowerCase() || 'library'
}

export function libraryCountForType(db: Database, mediaType: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM libraries WHERE media_type = ?').get(mediaType) as { n: number }
  return row.n
}

/** Absolute base directory that a library's items live under, given current layout. */
export function rootForLibrary(mediaType: string, libraryName: string, siblingCount: number): string {
  const typeDir = join(getMediaRoot(), mediaType)
  return siblingCount > 1 ? join(typeDir, sanitizeLibraryFolder(libraryName)) : typeDir
}

/** Resolve the current base directory for a library id (used by the organizer). */
export function resolveLibraryRoot(db: Database, libraryId: number): string {
  const lib = db.prepare('SELECT name, media_type FROM libraries WHERE id = ?').get(libraryId) as
    | { name: string; media_type: string }
    | undefined
  if (!lib) return getMediaRoot()
  return rootForLibrary(lib.media_type, lib.name, libraryCountForType(db, lib.media_type))
}

/**
 * Delete a file or folder, but only if it lives strictly inside the media root.
 * Guards against removing the media root itself or any path outside it (e.g. a
 * stale absolute path from another environment). Returns true if it deleted.
 */
export function safeDeleteMediaPath(path: string | null | undefined): boolean {
  if (!path) return false
  const root = getMediaRoot()
  const resolved = resolvePath(path)
  if (resolved === root || !resolved.startsWith(root + sep)) return false
  if (!existsSync(resolved)) return false
  rmSync(resolved, { recursive: true, force: true })
  return true
}
