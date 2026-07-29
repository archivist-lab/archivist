import axios from 'axios'
import { sanitizeConfigValue } from '@archivist/core'
import type { FilterNode, ListMediaType } from '@archivist/contracts'
import { type CompiledQuery, type FilterCompiler, type ListMember, type ListMemberResult, UnsupportedListFilterError } from '../types.js'

const PROVIDER_CEILING = 10_000
const PAGE_SIZE = 20

const FILM_GENRES: Record<string, number> = {
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99,
  drama: 18, family: 10751, fantasy: 14, history: 36, horror: 27, music: 10402,
  mystery: 9648, romance: 10749, 'science fiction': 878, 'sci-fi': 878,
  thriller: 53, war: 10752, western: 37, 'tv movie': 10770,
}

const SERIES_GENRES: Record<string, number> = {
  'action & adventure': 10759, action: 10759, adventure: 10759, animation: 16,
  comedy: 35, crime: 80, documentary: 99, drama: 18, family: 10751, kids: 10762,
  mystery: 9648, news: 10763, reality: 10764, 'sci-fi & fantasy': 10765,
  'science fiction': 10765, 'sci-fi': 10765, fantasy: 10765, soap: 10766,
  talk: 10767, 'war & politics': 10768, war: 10768, western: 37,
}

function tmdbBase(): string {
  return process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
}

function tmdbApiKey(): string {
  const key = sanitizeConfigValue(process.env.TMDB_API_KEY)
  if (!key) throw new Error('TMDB API key is not configured')
  return key
}

function normal(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

function ids(values: string[], label: string): string {
  const parsed = values.map(value => Number.parseInt(value, 10))
  if (parsed.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new UnsupportedListFilterError([`${label} values must be provider IDs`])
  }
  return parsed.join(',')
}

function mergeParam(params: Record<string, string | number | boolean>, key: string, value: string | number | boolean): void {
  if (params[key] == null) {
    params[key] = value
    return
  }
  if (params[key] === value) return
  params[key] = `${params[key]},${value}`
}

function compileLeaf(node: Exclude<FilterNode, { op: 'and' | 'or' | 'not' }>, mediaType: ListMediaType, params: Record<string, string | number | boolean>): void {
  if (node.op === 'genre') {
    const vocabulary = mediaType === 'film' ? FILM_GENRES : SERIES_GENRES
    const mapped = node.values.map(value => vocabulary[normal(value)])
    const missing = node.values.filter((_value, index) => mapped[index] == null)
    if (missing.length) throw new UnsupportedListFilterError([`TMDB has no ${mediaType} genre for: ${missing.join(', ')}`])
    mergeParam(params, node.mode === 'includes' ? 'with_genres' : 'without_genres', mapped.join(','))
    return
  }
  if (node.op === 'year') {
    const field = mediaType === 'film' ? 'primary_release_date' : 'first_air_date'
    if (node.min != null) params[`${field}.gte`] = `${node.min}-01-01`
    if (node.max != null) params[`${field}.lte`] = `${node.max}-12-31`
    return
  }
  if (node.op === 'rating') {
    if (node.min != null) params['vote_average.gte'] = node.min
    if (node.max != null) params['vote_average.lte'] = node.max
    if (node.minVotes != null) params['vote_count.gte'] = node.minVotes
    return
  }
  if (node.op === 'runtime') {
    if (node.min != null) params['with_runtime.gte'] = node.min
    if (node.max != null) params['with_runtime.lte'] = node.max
    return
  }
  if (node.op === 'language') {
    if (node.values.length !== 1) throw new UnsupportedListFilterError(['TMDB supports one original language per discover query'])
    params.with_original_language = normal(node.values[0])
    return
  }
  if (node.op === 'certification') {
    if (node.values.length !== 1) throw new UnsupportedListFilterError(['TMDB supports one certification per discover query'])
    params.certification_country = node.country.toUpperCase()
    params.certification = node.values[0]
    return
  }
  if (node.op === 'keyword') {
    params[node.mode === 'includes' ? 'with_keywords' : 'without_keywords'] = ids(node.values, 'Keyword')
    return
  }
  if (node.op === 'person') {
    const key = node.role === 'cast' ? 'with_cast' : node.role === 'crew' ? 'with_crew' : 'with_people'
    params[key] = node.ids.join(',')
    return
  }
  if (node.op === 'company') {
    params.with_companies = node.ids.join(',')
    return
  }
  params.watch_region = node.region.toUpperCase()
  params.with_watch_providers = node.ids.join('|')
}

function compileNode(node: FilterNode, mediaType: ListMediaType, params: Record<string, string | number | boolean>): void {
  if (node.op === 'and') {
    for (const child of node.nodes) compileNode(child, mediaType, params)
    return
  }
  if (node.op === 'or') {
    const leaves = node.nodes.every(child => child.op !== 'and' && child.op !== 'or' && child.op !== 'not')
      ? node.nodes as Array<Exclude<FilterNode, { op: 'and' | 'or' | 'not' }>>
      : null
    const first = leaves?.[0]
    if (!leaves || !first || leaves.some(child => child.op !== first.op)) {
      throw new UnsupportedListFilterError(['TMDB only supports OR groups containing one filter type'])
    }
    if (first.op === 'genre' && leaves.every(child => child.op === 'genre' && child.mode === first.mode)) {
      const combined = { ...first, values: leaves.flatMap(child => child.op === 'genre' ? child.values : []) }
      const vocabulary = mediaType === 'film' ? FILM_GENRES : SERIES_GENRES
      const mapped = combined.values.map(value => vocabulary[normal(value)])
      if (mapped.some(value => value == null)) throw new UnsupportedListFilterError(['One or more genres are unavailable for this media type'])
      params[combined.mode === 'includes' ? 'with_genres' : 'without_genres'] = mapped.join('|')
      return
    }
    throw new UnsupportedListFilterError([`TMDB cannot safely compile OR for ${first.op}`])
  }
  if (node.op === 'not') {
    if (node.node.op === 'genre') return compileLeaf({ ...node.node, mode: node.node.mode === 'includes' ? 'excludes' : 'includes' }, mediaType, params)
    if (node.node.op === 'keyword') return compileLeaf({ ...node.node, mode: node.node.mode === 'includes' ? 'excludes' : 'includes' }, mediaType, params)
    throw new UnsupportedListFilterError([`TMDB cannot safely negate ${node.node.op}`])
  }
  compileLeaf(node, mediaType, params)
}

function member(row: any, mediaType: ListMediaType): ListMember | null {
  const tmdbId = Number(row?.id)
  const title = String(mediaType === 'film' ? row?.title ?? '' : row?.name ?? '').trim()
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || !title) return null
  const releaseDate = String(mediaType === 'film' ? row?.release_date ?? '' : row?.first_air_date ?? '') || undefined
  const year = releaseDate && /^\d{4}/.test(releaseDate) ? Number.parseInt(releaseDate.slice(0, 4), 10) : undefined
  return {
    mediaType,
    tmdbId,
    title,
    year,
    posterPath: typeof row?.poster_path === 'string' ? row.poster_path : undefined,
    releaseDate,
  }
}

export class TmdbDiscoverCompiler implements FilterCompiler {
  readonly id = 'tmdb-discover-v1'

  supports(op: FilterNode['op']): boolean {
    return ['and', 'or', 'not', 'genre', 'year', 'rating', 'runtime', 'language', 'certification', 'keyword', 'person', 'company', 'watchProvider'].includes(op)
  }

  compile(ast: FilterNode, mediaType: ListMediaType): CompiledQuery {
    const params: Record<string, string | number | boolean> = {
      include_adult: false,
      include_video: false,
      sort_by: mediaType === 'film' ? 'primary_release_date.asc' : 'first_air_date.asc',
    }
    compileNode(ast, mediaType, params)
    return { compilerId: this.id, mediaType, path: mediaType === 'film' ? '/discover/movie' : '/discover/tv', params }
  }

  async execute(query: CompiledQuery, opts: { limit: number }): Promise<ListMemberResult> {
    const limit = Math.max(1, Math.min(opts.limit, PROVIDER_CEILING))
    const members: ListMember[] = []
    const seen = new Set<number>()
    let page = 1
    let total = 0
    let totalPages = 1

    do {
      const response = await axios.get(`${tmdbBase()}${query.path}`, {
        params: { api_key: tmdbApiKey(), language: 'en-US', ...query.params, page },
        timeout: 15_000,
      })
      const data = response.data as { page?: number; total_pages?: number; total_results?: number; results?: any[] }
      total = Math.max(0, Number(data.total_results) || 0)
      totalPages = Math.min(Math.max(1, Number(data.total_pages) || 1), Math.ceil(PROVIDER_CEILING / PAGE_SIZE))
      for (const row of data.results ?? []) {
        const parsed = member(row, query.mediaType)
        if (!parsed || seen.has(parsed.tmdbId)) continue
        seen.add(parsed.tmdbId)
        members.push(parsed)
        if (members.length >= limit) break
      }
      page += 1
    } while (members.length < limit && page <= totalPages)

    const ceilingHit = total > PROVIDER_CEILING
    const capped = total > limit || ceilingHit
    const warning = ceilingHit
      ? 'This filter matches more than 10,000 titles — narrow it.'
      : total > limit ? `This filter matches ${total} titles, above the configured member cap of ${limit}.` : undefined
    return { members, total, capped, ceilingHit, warning }
  }
}
