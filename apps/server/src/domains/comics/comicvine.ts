import axios from 'axios'
import { sanitizeConfigValue } from '@archivist/core'

const CV_BASE = process.env.COMICVINE_BASE_URL ?? 'https://comicvine.gamespot.com/api'

function apiKey(): string {
  const key = sanitizeConfigValue(process.env.COMICVINE_API_KEY)
  if (!key) throw new Error('COMICVINE_API_KEY not set in environment')
  return key
}

async function cvGet<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await axios.get(`${CV_BASE}${endpoint}`, {
    params: { api_key: apiKey(), format: 'json', ...params },
    timeout: 15000,
  })
  if (res.data.status_code !== 1) throw new Error(`ComicVine error: ${res.data.error}`)
  return res.data.results
}

export interface CvSeries {
  id: number; name: string; startYear?: number; publisher?: string
  overview?: string; genres: string[]; coverUrl?: string
  issueCount: number; seriesType: string
}

export interface CvIssue {
  id: number; issueNumber: string; title?: string
  coverDate?: string; year?: number; overview?: string; coverUrl?: string
}

export async function searchComicSeries(query: string): Promise<CvSeries[]> {
  const results = await cvGet<any[]>('/search', {
    query, resources: 'volume',
    field_list: 'id,name,start_year,publisher,description,genres,image,count_of_issues',
    limit: 20,
  })
  return (results ?? []).filter((r: any) => r.resource_type === 'volume').map(parseSeries)
}

export async function getComicSeries(cvId: number): Promise<CvSeries> {
  const result = await cvGet<any>(`/volume/4050-${cvId}/`, {
    field_list: 'id,name,start_year,publisher,description,genres,image,count_of_issues',
  })
  return parseSeries(result)
}

export async function getComicIssues(cvId: number, offset = 0): Promise<CvIssue[]> {
  const results = await cvGet<any[]>('/issues/', {
    filter: `volume:${cvId}`,
    field_list: 'id,issue_number,name,cover_date,description,image',
    sort: 'issue_number:asc', limit: 100, offset,
  })
  return (results ?? []).map((issue: any) => ({
    id: issue.id,
    issueNumber: String(issue.issue_number ?? '1'),
    title: issue.name || undefined,
    coverDate: issue.cover_date || undefined,
    year: issue.cover_date ? parseInt(issue.cover_date.slice(0, 4), 10) : undefined,
    overview: issue.description ? stripHtml(issue.description) : undefined,
    coverUrl: issue.image?.medium_url || issue.image?.original_url || undefined,
  }))
}

function parseSeries(s: any): CvSeries {
  return {
    id: s.id, name: s.name,
    startYear: s.start_year ? parseInt(s.start_year, 10) : undefined,
    publisher: s.publisher?.name,
    overview: s.description ? stripHtml(s.description) : undefined,
    genres: (s.genres ?? []).map((g: any) => g.name),
    coverUrl: s.image?.medium_url || s.image?.original_url || undefined,
    issueCount: s.count_of_issues ?? 0,
    seriesType: (s.count_of_issues ?? 0) === 1 ? 'one-shot' : (s.count_of_issues ?? 0) <= 12 ? 'limited' : 'ongoing',
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
}
