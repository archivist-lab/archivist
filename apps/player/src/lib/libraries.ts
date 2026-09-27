import type { PlayerLibrary } from '@archivist/contracts'

/**
 * A type's libraries in menu order: the one named for the type itself —
 * "Films", "Series" — first, as the default, then the rest A-Z. The menu's
 * library row and the page that picks the default read the same order, so the
 * first library shown is the one opened.
 */
export function orderLibraries(libraries: readonly PlayerLibrary[], type: 'films' | 'series'): PlayerLibrary[] {
  const own = (name: string) => name.trim().toLowerCase() === type
  return libraries
    .filter(library => library.mediaType === type)
    .sort((a, b) => Number(own(b.name)) - Number(own(a.name)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}
