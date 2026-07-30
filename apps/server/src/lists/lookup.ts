import axios from 'axios'
import { sanitizeConfigValue } from '@archivist/core'
import type { ListMediaType } from '@archivist/contracts'

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
  const response = await axios.get(`${baseUrl()}${path}`, {
    params: { api_key: apiKey(), language: 'en-US', ...params },
    timeout: 10_000,
  })
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

export async function lookupListEntities(kind: 'person' | 'company' | 'title', mediaType: ListMediaType, query: string): Promise<ListLookupResult[]> {
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
