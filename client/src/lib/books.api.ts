import { request } from './api.js'

export interface Author {
  id: number; name: string; sort_name?: string
  image_url?: string; overview?: string
  monitored: boolean; book_count?: number; downloaded_books?: number
}

export interface Book {
  id: number; author_id: number; google_books_id?: string; isbn_13?: string
  title: string; subtitle?: string; series_name?: string; series_position?: number
  year?: number; publisher?: string; page_count?: number; overview?: string
  genres: string[]; cover_url?: string; language: string
  monitored: boolean; status: string; available_formats?: string; downloaded_editions?: number
  info_hash?: string | null; current_release_title?: string | null; downloadProgress?: number
}

export const booksApi = {
  authors: {
    list:   ()       => request<Author[]>('/books/authors'),
    get:    (id: number) => request<Author & { books: Book[] }>(`/books/authors/${id}`),
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
  },
  lookup:   (q: string) => request<any[]>(`/books/lookup/authors?q=${encodeURIComponent(q)}`),
  lookupAuthor: (name: string) => request<any>(`/books/lookup/author/${encodeURIComponent(name)}`),
  download: (downloadUrl: string) =>
    request<{ success: boolean; message: string }>('/books/download', {
      method: 'POST', body: JSON.stringify({ downloadUrl }),
    }),
}
