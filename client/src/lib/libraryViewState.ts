import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useTabs } from './tab-context.js'

type LibraryMediaType = 'films' | 'series' | 'music' | 'books' | 'comics' | 'games'

const STORAGE_PREFIX = 'archivist.library-view.v2'

/**
 * v1 kept one set of preferences per media type, which two libraries of the
 * same type had to share. There is no honest way to split those between them,
 * so they are dropped rather than copied into whichever library is open.
 */
try {
  const stale = Object.keys(window.localStorage).filter(key => key.startsWith('archivist.library-view.v1.'))
  for (const key of stale) window.localStorage.removeItem(key)
} catch {
  // Nothing to clean when storage is unavailable.
}

/** The library whose view state a media type's pages are reading and writing. */
export function useLibraryId(mediaType: LibraryMediaType): number | null {
  const { libraryIdForMedia } = useTabs()
  return libraryIdForMedia(mediaType)
}

const encode = (value: unknown) => JSON.stringify(value instanceof Set ? [...value] : value)

/**
 * Persist a Library-page preference independently for each library.
 *
 * Two libraries of the same media type — Films and Kids Films — are separate
 * views of separate collections, so the filters, search and sort belong to the
 * library rather than to films in general. Switching libraries swaps the whole
 * set over to whatever was left set there.
 */
export function useLibraryViewState<T>(
  mediaType: LibraryMediaType,
  preference: string,
  fallback: T,
  decode: (stored: unknown) => T | undefined,
): [T, Dispatch<SetStateAction<T>>] {
  const libraryId = useLibraryId(mediaType)
  // Until a library is known there is nothing to key by, so the page holds the
  // default and stores nothing rather than writing under a shared key.
  const key = libraryId == null ? null : `${STORAGE_PREFIX}.${mediaType}.${libraryId}.${preference}`

  const read = (storageKey: string | null): T => {
    if (storageKey === null) return fallback
    try {
      const stored = window.localStorage.getItem(storageKey)
      if (stored !== null) return decode(JSON.parse(stored)) ?? fallback
    } catch {
      // Invalid or unavailable browser storage falls back to page defaults.
    }
    return fallback
  }

  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({ key, value: read(key) }))
  // A library switch is read during the render that reports it, so the page
  // never paints one library's filters over another library's list.
  if (state.key !== key) setState({ key, value: read(key) })

  useEffect(() => {
    if (key === null || state.key !== key) return
    try {
      window.localStorage.setItem(key, encode(state.value))
    } catch {
      // Filtering remains usable when storage is unavailable or full.
    }
  }, [key, state])

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(action => {
    setState(current => ({
      key: current.key,
      value: typeof action === 'function' ? (action as (previous: T) => T)(current.value) : action,
    }))
  }, [])

  return [state.value, setValue]
}

export function storedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function storedEnum<T extends string>(allowed: readonly T[]): (value: unknown) => T | undefined {
  return value => typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined
}

export function storedStringSet<T extends string>(allowed: readonly T[]): (value: unknown) => Set<T> | undefined {
  return value => {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !allowed.includes(item as T))) return undefined
    return new Set(value as T[])
  }
}

export interface StoredLibraryFilter {
  field: string
  q: string
}

export function storedLibraryFilters(value: unknown): StoredLibraryFilter[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.some(filter => !filter || typeof filter !== 'object' || typeof filter.field !== 'string' || typeof filter.q !== 'string')) return undefined
  return value as StoredLibraryFilter[]
}


/** Prevent a restored no-match search from repeatedly redirecting back to Add. */
export function claimLibrarySearchRedirect(mediaType: LibraryMediaType, query: string, libraryId: number | null): boolean {
  const key = `${STORAGE_PREFIX}.${mediaType}.${libraryId ?? 'unknown'}.redirectedSearch`
  try {
    if (window.sessionStorage.getItem(key) === query) return false
    window.sessionStorage.setItem(key, query)
  } catch {
    // Preserve the existing redirect behaviour when session storage is unavailable.
  }
  return true
}
