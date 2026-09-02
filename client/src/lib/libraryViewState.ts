import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

type LibraryMediaType = 'films' | 'series' | 'music' | 'books' | 'comics' | 'games'

const STORAGE_PREFIX = 'archivist.library-view.v1'

/** Persist a Library-page preference independently for each media type. */
export function useLibraryViewState<T>(
  mediaType: LibraryMediaType,
  preference: string,
  fallback: T,
  decode: (stored: unknown) => T | undefined,
): [T, Dispatch<SetStateAction<T>>] {
  const key = `${STORAGE_PREFIX}.${mediaType}.${preference}`
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key)
      if (stored !== null) return decode(JSON.parse(stored)) ?? fallback
    } catch {
      // Invalid or unavailable browser storage falls back to page defaults.
    }
    return fallback
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value instanceof Set ? [...value] : value))
    } catch {
      // Filtering remains usable when storage is unavailable or full.
    }
  }, [key, value])

  return [value, setValue]
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
export function claimLibrarySearchRedirect(mediaType: LibraryMediaType, query: string): boolean {
  const key = `${STORAGE_PREFIX}.${mediaType}.redirectedSearch`
  try {
    if (window.sessionStorage.getItem(key) === query) return false
    window.sessionStorage.setItem(key, query)
  } catch {
    // Preserve the existing redirect behaviour when session storage is unavailable.
  }
  return true
}
