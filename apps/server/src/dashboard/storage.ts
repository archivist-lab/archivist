import { existsSync, statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { resolveLibraryRoot } from '../shared/library-paths.js'

export interface LibraryStorage {
  libraryId: number
  name: string
  mediaType: string
  path: string
  size: number
  used: number
  free: number
  usedPercent: number
  available: boolean
}

function nearestExistingPath(input: string): string | null {
  let current = resolve(input)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return current
}

/** Filesystem capacity for every actual Archivist item-library root. */
export function getLibraryStorage(db: Database): LibraryStorage[] {
  const libraries = db.prepare('SELECT id, name, media_type FROM libraries ORDER BY media_type, name, id').all() as Array<{
    id: number
    name: string
    media_type: string
  }>
  return libraries.map(library => {
    const path = resolveLibraryRoot(db, library.id)
    const existing = nearestExistingPath(path)
    if (!existing) return {
      libraryId: library.id, name: library.name, mediaType: library.media_type, path,
      size: 0, used: 0, free: 0, usedPercent: 0, available: false,
    }
    try {
      const stats = statfsSync(existing)
      const size = Number(stats.bsize) * Number(stats.blocks)
      const free = Number(stats.bsize) * Number(stats.bavail)
      const used = Math.max(0, size - free)
      return {
        libraryId: library.id,
        name: library.name,
        mediaType: library.media_type,
        path,
        size,
        used,
        free,
        usedPercent: size > 0 ? Math.min(100, Math.max(0, used / size * 100)) : 0,
        available: true,
      }
    } catch {
      return {
        libraryId: library.id, name: library.name, mediaType: library.media_type, path,
        size: 0, used: 0, free: 0, usedPercent: 0, available: false,
      }
    }
  })
}
