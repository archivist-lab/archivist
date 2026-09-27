import { join, relative, resolve as resolvePath, sep } from 'node:path'
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

/**
 * The `/media/…` URL the UI renders for a file inside the media root, or null
 * when the file lives outside it (an unmanaged root folder the static mount
 * cannot serve).
 *
 * Artwork keeps a fixed filename on disk (poster.jpg, logo.png …) so a replaced
 * image reuses its URL and browsers keep painting the cached copy. `version`
 * appends a cache-busting query so a newly picked poster shows up immediately.
 */
export function mediaUrlForPath(path: string, version?: number | string): string | null {
  const root = resolvePath(getMediaRoot())
  const target = resolvePath(path)
  if (target !== root && !target.startsWith(root + sep)) return null
  const url = '/media/' + relative(root, target).split(sep).join('/')
  return version === undefined ? url : `${url}?v=${version}`
}

let lastArtworkVersion = 0

/**
 * Strictly increasing cache-busting token. Wall-clock based so it stays
 * meaningful in the database, bumped by one when two saves land in the same
 * millisecond so consecutive picks never reuse a URL.
 */
export function nextArtworkVersion(): number {
  lastArtworkVersion = Math.max(Date.now(), lastArtworkVersion + 1)
  return lastArtworkVersion
}

/** A stored artwork URL without its cache-busting query. */
export function stripMediaVersion(url: string | null | undefined): string | null {
  if (!url) return null
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

/**
 * Keep the stored artwork URL when a refresh recomputed the same file — the
 * organizer never overwrites artwork that already exists on disk, so dropping
 * the stored URL would only discard its cache-busting version and send the
 * browser back to the image it has cached.
 */
export function preserveArtworkVersion(stored: string | null | undefined, next: string | undefined): string | null {
  if (stored && next && stripMediaVersion(stored) === next) return stored
  return next ?? null
}
