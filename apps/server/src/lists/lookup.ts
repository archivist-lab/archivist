import axios from 'axios'
import { sanitizeConfigValue } from '@archivist/core'
import type { ListMediaType } from '@archivist/contracts'
import { withProviderRetry } from '../shared/provider-limiter.js'
import { getDb } from '../db.js'

export interface ListLookupResult {
  id: number
  label: string
  subtitle: string | null
  imagePath: string | null
}

function baseUrl(): string {
  return process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
}

function apiKey(): string {
  const key = sanitizeConfigValue(process.env.TMDB_API_KEY)
  if (!key) throw new Error('TMDB API key is not configured')
  return key
}

async function get(path: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = await withProviderRetry('tmdb', () => axios.get(`${baseUrl()}${path}`, {
    params: { api_key: apiKey(), language: 'en-US', ...params },
    timeout: 10_000,
  }))
  return response.data
}

function validId(row: any): number | null {
  const id = Number(row?.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function year(value: unknown): string | null {
  const text = String(value ?? '')
  return /^\d{4}/.test(text) ? text.slice(0, 4) : null
}

function titleResult(row: any, mediaType: ListMediaType): ListLookupResult | null {
  const id = validId(row)
  const label = String(mediaType === 'film' ? row?.title ?? '' : row?.name ?? '').trim()
  if (!id || !label) return null
  return {
    id,
    label,
    subtitle: year(mediaType === 'film' ? row?.release_date : row?.first_air_date),
    imagePath: typeof row?.poster_path === 'string' ? row.poster_path : null,
  }
}

function personResult(row: any): ListLookupResult | null {
  const id = validId(row)
  const label = String(row?.name ?? '').trim()
  if (!id || !label) return null
  const knownFor = Array.isArray(row?.known_for)
    ? row.known_for.map((credit: any) => credit?.title ?? credit?.name).filter(Boolean).slice(0, 2).join(', ')
    : ''
  return {
    id,
    label,
    subtitle: [row?.known_for_department, knownFor].filter(Boolean).join(' · ') || null,
    imagePath: typeof row?.profile_path === 'string' ? row.profile_path : null,
  }
}

function companyResult(row: any): ListLookupResult | null {
  const id = validId(row)
  const label = String(row?.name ?? '').trim()
  if (!id || !label) return null
  return {
    id,
    label,
    subtitle: typeof row?.origin_country === 'string' && row.origin_country ? row.origin_country : null,
    imagePath: typeof row?.logo_path === 'string' ? row.logo_path : null,
  }
}

type LookupKind = 'person' | 'company' | 'network' | 'genre' | 'title'

let networkCache: { base: string; expiresAt: number; rows: ListLookupResult[] } | null = null

async function networkRowsForSeriesIds(ids: number[]): Promise<ListLookupResult[]> {
  const details = await Promise.allSettled(ids.slice(0, 60).map(id => get(`/tv/${id}`)))
  const networks = new Map<number, ListLookupResult>()
  for (const detail of details) {
    if (detail.status !== 'fulfilled') continue
    for (const row of Array.isArray(detail.value?.networks) ? detail.value.networks : []) {
      const result = companyResult(row)
      if (result) networks.set(result.id, result)
    }
  }
  return [...networks.values()]
}

async function networkDirectory(): Promise<ListLookupResult[]> {
  const base = baseUrl()
  if (networkCache && networkCache.base === base && networkCache.expiresAt > Date.now()) return networkCache.rows
  const seriesIds = new Set<number>()
  try {
    const local = getDb().prepare(`SELECT tmdb_id FROM series WHERE tmdb_id IS NOT NULL AND tmdb_id > 0
      ORDER BY updated_at DESC LIMIT 40`).all() as Array<{ tmdb_id: number }>
    local.forEach(row => seriesIds.add(row.tmdb_id))
  } catch {}
  try {
    const popular = await get('/tv/popular', { page: 1 })
    for (const row of popular?.results ?? []) {
      const id = validId(row)
      if (id) seriesIds.add(id)
    }
  } catch {}
  const rows = await networkRowsForSeriesIds([...seriesIds])
  rows.sort((a, b) => a.label.localeCompare(b.label) || a.id - b.id)
  networkCache = { base, expiresAt: Date.now() + 6 * 60 * 60_000, rows }
  return rows
}

async function lookupNetworks(query: string): Promise<ListLookupResult[]> {
  const numericId = /^\d+$/.test(query) ? Number(query) : null
  if (numericId && Number.isSafeInteger(numericId) && numericId > 0) {
    try {
      const result = companyResult(await get(`/network/${numericId}`))
      return result ? [result] : []
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return []
      throw error
    }
  }

  const normalQuery = query.trim().toLocaleLowerCase()
  let rows = await networkDirectory()
  let matches = rows.filter(row => row.label.toLocaleLowerCase().includes(normalQuery))
  if (matches.length === 0) {
    try {
      const search = await get('/search/tv', { query, page: 1, include_adult: false })
      const ids = (search?.results ?? []).map(validId).filter((id: number | null): id is number => id != null).slice(0, 12)
      const discovered = await networkRowsForSeriesIds(ids)
      const merged = new Map(rows.map(row => [row.id, row]))
      discovered.forEach(row => merged.set(row.id, row))
      rows = [...merged.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id - b.id)
      networkCache = { base: baseUrl(), expiresAt: Date.now() + 6 * 60 * 60_000, rows }
      matches = rows.filter(row => row.label.toLocaleLowerCase().includes(normalQuery))
    } catch {}
  }
  return matches.sort((a, b) => {
    const aPrefix = a.label.toLocaleLowerCase().startsWith(normalQuery) ? 0 : 1
    const bPrefix = b.label.toLocaleLowerCase().startsWith(normalQuery) ? 0 : 1
    return aPrefix - bPrefix || a.label.localeCompare(b.label)
  }).slice(0, 12)
}

async function lookupGenres(mediaType: ListMediaType, query: string): Promise<ListLookupResult[]> {
  const data = await get(`/genre/${mediaType === 'film' ? 'movie' : 'tv'}/list`)
  const normalQuery = query.trim().toLocaleLowerCase()
  return (data?.genres ?? []).map((row: any) => {
    const id = validId(row)
    const label = String(row?.name ?? '').trim()
    return id && label ? { id, label, subtitle: null, imagePath: null } : null
  }).filter((row: ListLookupResult | null): row is ListLookupResult => row != null && (!normalQuery || row.label.toLocaleLowerCase().includes(normalQuery)))
    .sort((a: ListLookupResult, b: ListLookupResult) => a.label.localeCompare(b.label))
}

export async function lookupListEntities(kind: LookupKind, mediaType: ListMediaType, query: string): Promise<ListLookupResult[]> {
  if (kind === 'network') return lookupNetworks(query)
  if (kind === 'genre') return lookupGenres(mediaType, query)
  const numericId = /^\d+$/.test(query) ? Number(query) : null
  if (numericId && Number.isSafeInteger(numericId) && numericId > 0) {
    try {
      const path = kind === 'title' ? `/${mediaType === 'film' ? 'movie' : 'tv'}/${numericId}` : `/${kind}/${numericId}`
      const row = await get(path)
      const result = kind === 'title' ? titleResult(row, mediaType) : kind === 'person' ? personResult(row) : companyResult(row)
      return result ? [result] : []
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return []
      throw error
    }
  }

  const path = kind === 'title' ? `/search/${mediaType === 'film' ? 'movie' : 'tv'}` : `/search/${kind}`
  const data = await get(path, { query, page: 1, include_adult: false })
  const convert = kind === 'title' ? (row: any) => titleResult(row, mediaType) : kind === 'person' ? personResult : companyResult
  return (data.results ?? []).map(convert).filter(Boolean).slice(0, 12) as ListLookupResult[]
}
