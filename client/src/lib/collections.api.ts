import { BASE, getTabContext, request } from './api.js'

export type CollectionEntityType = 'film' | 'series' | 'artist' | 'album' | 'author' | 'book' | 'comic_series' | 'comic_issue' | 'game'
export type CollectionMediaType = 'films' | 'series' | 'music' | 'books' | 'comics' | 'games'
export type CollectionArtworkType = 'poster' | 'backdrop' | 'logo'

export interface CollectionCandidate {
  entityType: CollectionEntityType
  itemId: number
  libraryId: number
  libraryName: string
  mediaType: CollectionMediaType
  title: string
  subtitle: string | null
  year: number | null
  artworkUrl: string | null
}

export interface CollectionMember extends CollectionCandidate {
  membershipId: number
  position: number
  addedAt: string
}

export interface ArchivistCollection {
  id: number
  name: string
  description: string | null
  posterUrl: string | null
  backdropUrl: string | null
  logoUrl: string | null
  createdAt: string
  updatedAt: string
  memberCount: number
  items?: CollectionMember[]
}

export interface CollectionInput {
  name: string
  description?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  logoUrl?: string | null
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

async function uploadArtwork(id: number, type: CollectionArtworkType, file: File) {
  const headers: Record<string, string> = { 'Content-Type': file.type }
  const tabId = getTabContext()
  if (tabId) headers['x-tab-context'] = tabId
  const response = await fetch(`${BASE}/collections/${id}/artwork/${type}`, {
    method: 'POST', credentials: 'same-origin', headers, body: file,
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `Upload failed: HTTP ${response.status}`)
  }
  return response.json() as Promise<{ collection: ArchivistCollection }>
}

export const collectionsApi = {
  list: () => request<{ collections: ArchivistCollection[] }>('/collections'),
  get: (id: number) => request<{ collection: ArchivistCollection }>(`/collections/${id}`),
  create: (input: CollectionInput) => request<{ collection: ArchivistCollection }>('/collections', { method: 'POST', ...json(input) }),
  update: (id: number, input: Partial<CollectionInput>) => request<{ collection: ArchivistCollection }>(`/collections/${id}`, { method: 'PATCH', ...json(input) }),
  uploadArtwork,
  delete: (id: number) => request<void>(`/collections/${id}`, { method: 'DELETE' }),
  candidates: (query: string, mediaType?: CollectionMediaType) => request<{ results: CollectionCandidate[] }>(`/collections/candidates?q=${encodeURIComponent(query)}${mediaType ? `&mediaType=${mediaType}` : ''}`),
  addItem: (id: number, item: Pick<CollectionCandidate, 'entityType' | 'itemId' | 'libraryId'>) => request<{ collection: ArchivistCollection }>(`/collections/${id}/items`, { method: 'POST', ...json(item) }),
  removeItem: (id: number, membershipId: number) => request<{ collection: ArchivistCollection }>(`/collections/${id}/items/${membershipId}`, { method: 'DELETE' }),
  reorder: (id: number, membershipIds: number[]) => request<{ collection: ArchivistCollection }>(`/collections/${id}/items/order`, { method: 'PUT', ...json({ membershipIds }) }),
}
