import { request } from './api.js'
import { itemSearchesApi } from './item-searches.api.js'

/** A rung on one of the two quality ladders. */
export interface BookQualityRung { id: string; label: string; rank: number }
export interface BookQualityTiers { ebook: BookQualityRung[]; audiobook: BookQualityRung[] }

export interface Author {
  id: number; name: string; sort_name?: string
  image_url?: string; overview?: string
  monitored: boolean; book_count?: number; downloaded_books?: number
}

export const BOOK_EDITION_KINDS = ['ebook', 'audiobook'] as const
export type BookEditionKind = (typeof BOOK_EDITION_KINDS)[number]

/**
 * One of a book's two acquisition tracks. Status, torrent and progress live
 * here rather than on the book, because the ebook and the audiobook are found
 * and completed independently.
 */
export interface BookEdition {
  id: number; book_id: number; kind: BookEditionKind
  container?: string | null; narrator?: string | null; duration_minutes?: number | null
  file_path?: string | null; file_size?: number | null
  status: string; monitored: boolean
  /** Rung on this edition's own ladder; the ladders differ per kind. */
  target_tier?: string | null
  info_hash?: string | null; downloadProgress?: number
  current_release_title?: string | null; current_size_bytes?: number | null
}

export interface Book {
  id: number; author_id: number; google_books_id?: string; isbn_13?: string
  title: string; subtitle?: string; series_name?: string; series_position?: number
  year?: number; publisher?: string; page_count?: number; overview?: string
  genres: string[]; cover_url?: string; language: string
  /** Rolled up from the editions: 'downloaded' only when every tracked one is in. */
  monitored: boolean; status: string
  editions?: BookEdition[]
  info_hash?: string | null; current_release_title?: string | null; downloadProgress?: number
}

/** The edition of a given kind, whether or not the server sent one. */
export function editionOf(book: Book, kind: BookEditionKind): BookEdition | undefined {
  return book.editions?.find(edition => edition.kind === kind)
}

export const booksApi = {
  authors: {
    list:   (signal?: AbortSignal) => request<Author[]>('/books/authors', { signal }),
    get:    (id: number, signal?: AbortSignal) => request<Author & { books: Book[] }>(`/books/authors/${id}`, { signal }),
    add:    (name: string, monitored = true, seriesNames: string[] = []) => 
              request<Author>('/books/authors', { method: 'POST', body: JSON.stringify({ name, monitored, seriesNames }) }),
    delete: (id: number, deleteFiles = false) => request<void>(`/books/authors/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
    acquisitionHistory: (id: number) => request<{ decisions: any[]; blocks: any[] }>(`/books/authors/${id}/acquisition-history`),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
      request<Author>(`/books/authors/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number) => request<any[]>(`/books/authors/${id}/images`),
    saveImage: (id: number, type: string, url: string) =>
      request<{ success: boolean; path: string }>(`/books/authors/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
    refresh: () => request<{ success: boolean; message: string }>('/books/refresh', { method: 'POST' }),
  },
  books: {
    update: (id: number, data: { monitored?: boolean; status?: string }) =>
      request<Book>(`/books/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateMetadata: (id: number, data: Record<string, unknown>) =>
      request<Book>(`/books/${id}/metadata`, { method: 'PUT', body: JSON.stringify(data) }),
    searchImages: (id: number) => request<any[]>(`/books/${id}/images`),
    saveImage: (id: number, type: string, url: string) =>
      request<{ success: boolean; path: string }>(`/books/${id}/images`, { method: 'PUT', body: JSON.stringify({ type, url }) }),
    acquisitionHistory: (id: number) =>
      request<{ decisions: any[]; blocks: any[] }>(`/books/${id}/acquisition-history`),
    rejectCurrentRelease: (id: number, reason = 'user-rejected-release') =>
      request<{ success: boolean }>(`/books/${id}/reject-current-release`, { method: 'POST', body: JSON.stringify({ reason }) }),
    repair: (id: number, data: { deleteFile?: boolean; rejectCurrent?: boolean }) =>
      request<Book>(`/books/${id}/repair`, { method: 'POST', body: JSON.stringify(data) }),
    updateEdition: (id: number, kind: BookEditionKind, data: { monitored?: boolean; status?: string; targetTier?: string | null }) =>
      request<BookEdition>(`/books/${id}/editions/${kind}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: number, deleteFiles = false) =>
      request<void>(`/books/${id}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' }),
  },

  /** The two quality ladders, best rung first. */
  qualityTiers: (signal?: AbortSignal) => request<BookQualityTiers>('/books/quality-tiers', { signal }),

  /**
   * Quick / Deep / Auto scan for a single edition. Scoped to the edition
   * because each track has its own query and its own ladder.
   */
  editions: {
    search: (editionId: number, mode: 'quick' | 'deep', signal?: AbortSignal, onUpdate?: (search: any) => void) =>
      itemSearchesApi
        .startAndWait<any>({ mediaType: 'books', subjectType: 'book-edition', subjectId: editionId, mode }, onUpdate, signal)
        .then(search => ({ mode: search.mode, releases: search.results, message: search.message })),
    autoGrab: (editionId: number, signal?: AbortSignal) =>
      itemSearchesApi
        .startAndWait<any>({ mediaType: 'books', subjectType: 'book-edition', subjectId: editionId, mode: 'auto' }, undefined, signal)
        .then(search => ({ success: search.grabbed, message: search.message || 'Auto scan complete' })),
    cancelSearch: (editionId: number) =>
      itemSearchesApi.cancelLatest<any>({ mediaType: 'books', subjectType: 'book-edition', subjectId: editionId }),
  },
  lookup:   (q: string) => request<any[]>(`/books/lookup/authors?q=${encodeURIComponent(q)}`),
  lookupAuthor: (name: string) => request<any>(`/books/lookup/author/${encodeURIComponent(name)}`),
  download: (downloadUrl: string) =>
    request<{ success: boolean; message: string }>('/books/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl }),
    }),
}
