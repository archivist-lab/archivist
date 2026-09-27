import axios from 'axios'
import { sanitizeConfigValue } from '@archivist/core'
import type { FilterNode, ListMediaType } from '@archivist/contracts'
import { type CompiledQuery, type FilterCompiler, type ListMember, type ListMemberResult, UnsupportedListFilterError } from '../types.js'
import { withProviderRetry } from '../../shared/provider-limiter.js'

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

/**
 * Title text is compared with punctuation removed on both sides, so an operator
 * typing "Mission Impossible" still matches "Mission: Impossible — Fallout" and
 * "Star Wars" matches "Star Wars: Episode IV".
 */
function normalTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function titleTextMatches(title: string, values: string[], match: 'all' | 'any' | undefined): boolean {
  const haystack = normalTitle(title)
  const phrases = values.map(normalTitle).filter(Boolean)
  if (!phrases.length) return false
  return match === 'all'
    ? phrases.every(phrase => haystack.includes(phrase))
    : phrases.some(phrase => haystack.includes(phrase))
}

function ids(values: string[], label: string, match?: 'all' | 'any'): string {
  const parsed = values.map(value => Number.parseInt(value, 10))
  if (parsed.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new UnsupportedListFilterError([`${label} values must be provider IDs`])
  }
  return joinValues(parsed, match)
}

/** TMDB joins multi-value discover params with `,` for AND and `|` for OR. */
const JOIN: Record<'all' | 'any', string> = { all: ',', any: '|' }
const joinValues = (values: Array<string | number>, match: 'all' | 'any' | undefined, fallback: 'all' | 'any' = 'all') =>
  values.join(JOIN[match ?? fallback])

function mergeParam(params: Record<string, string | number | boolean>, key: string, value: string | number | boolean): void {
  if (params[key] == null) {
    params[key] = value
    return
  }
  if (params[key] === value) return
  // TMDB has no grouping syntax, so `a|b,c` is not "either a or b, and also c".
  // Two rules on the same field can only be combined when both use "all".
  if (String(params[key]).includes('|') || String(value).includes('|')) {
    throw new UnsupportedListFilterError([`TMDB cannot combine a "match any" rule with another rule on the same field — put those values in one rule`])
  }
  params[key] = `${params[key]},${value}`
}

function compileLeaf(node: Exclude<FilterNode, { op: 'and' | 'or' | 'not' }>, mediaType: ListMediaType, params: Record<string, string | number | boolean>): void {
  if (node.op === 'genre') {
    const vocabulary = mediaType === 'film' ? FILM_GENRES : SERIES_GENRES
    const mapped = node.values.map(value => vocabulary[normal(value)])
    const missing = node.values.filter((_value, index) => mapped[index] == null)
    if (missing.length) throw new UnsupportedListFilterError([`TMDB has no ${mediaType} genre for: ${missing.join(', ')}`])
    mergeParam(params, node.mode === 'includes' ? 'with_genres' : 'without_genres', joinValues(mapped, node.match))
    return
  }
  if (node.op === 'year') {
    const field = mediaType === 'film' ? 'primary_release_date' : 'first_air_date'
    if (node.relative) {
      const today = new Date()
      const year = today.getUTCFullYear() + (node.relative === 'next_year' ? 1 : 0)
      params[`${field}.gte`] = node.relative === 'future' ? today.toISOString().slice(0, 10) : `${year}-01-01`
      if (node.relative !== 'future') params[`${field}.lte`] = `${year}-12-31`
      return
    }
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
    mergeParam(params, node.mode === 'includes' ? 'with_keywords' : 'without_keywords', ids(node.values, 'Keyword', node.match))
    return
  }
  if (node.op === 'title') {
    mergeParam(params, node.mode === 'includes' ? '__include_title_ids' : '__exclude_title_ids', node.ids.join(','))
    return
  }
  if (node.op === 'titleText') {
    // Discover has no title parameter. An "includes" rule therefore seeds the
    // query from /search instead, and an "excludes" rule is applied to whatever
    // the query returns — both are recorded here and honoured by execute().
    const key = node.mode === 'includes' ? '__title_search' : '__title_text_exclude'
    const existing = JSON.parse(String(params[key] ?? '[]')) as unknown[]
    existing.push({ values: node.values, match: node.match ?? 'any' })
    params[key] = JSON.stringify(existing)
    return
  }
  if (node.op === 'person') {
    const castRoles = new Set(['starring', 'cast'])
    const key = castRoles.has(node.role) ? 'with_cast' : node.role === 'any' ? 'with_people' : 'with_crew'
    if (mediaType === 'film') mergeParam(params, key, joinValues(node.ids, node.match))
    if (!['cast', 'crew', 'any'].includes(node.role)) {
      const filters = JSON.parse(String(params.__exact_person_roles ?? '[]')) as unknown[]
      filters.push({ role: node.role, ids: node.ids, match: node.match ?? 'all' })
      params.__exact_person_roles = JSON.stringify(filters)
    }
    return
  }
  if (node.op === 'company') {
    mergeParam(params, 'with_companies', joinValues(node.ids, node.match))
    return
  }
  if (node.op === 'network') {
    if (mediaType !== 'series') throw new UnsupportedListFilterError(['Network filters are available only for Series Lists'])
    mergeParam(params, 'with_networks', joinValues(node.ids, node.match))
    return
  }
  params.watch_region = node.region.toUpperCase()
  // Watch providers have always been OR'd; "all" narrows that to titles carried
  // by every selected service.
  params.with_watch_providers = joinValues(node.ids, node.match, 'any')
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
    if (first.op === 'titleText' && leaves.every(child => child.op === 'titleText' && child.mode === first.mode)) {
      // Several title phrases are one search either way, so an OR group folds
      // into a single "match any of these" rule rather than being rejected.
      const values = leaves.flatMap(child => child.op === 'titleText' ? child.values : [])
      compileLeaf({ op: 'titleText', mode: first.mode, values, match: 'any' }, mediaType, params)
      return
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
    if (node.node.op === 'title') return compileLeaf({ ...node.node, mode: node.node.mode === 'includes' ? 'excludes' : 'includes' }, mediaType, params)
    if (node.node.op === 'titleText') {
      compileLeaf({ ...node.node, mode: node.node.mode === 'includes' ? 'excludes' : 'includes' }, mediaType, params)
      return
    }
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
    overview: typeof row?.overview === 'string' && row.overview.trim() ? row.overview.trim() : undefined,
    providerRating: Number.isFinite(Number(row?.vote_average)) && Number(row.vote_average) > 0 ? Number(row.vote_average) : undefined,
    providerVotes: Number.isFinite(Number(row?.vote_count)) ? Number(row.vote_count) : undefined,
  }
}

/**
 * Ops that can be decided from a single /search result row, which is all a
 * title-text List has to work with — discover never runs for one.
 */
const LOCALLY_EVALUABLE = new Set<FilterNode['op']>(['and', 'or', 'not', 'genre', 'year', 'rating', 'language', 'title', 'titleText'])

function rowDate(row: any, mediaType: ListMediaType): string {
  return String((mediaType === 'film' ? row?.release_date : row?.first_air_date) ?? '')
}

function evaluateLocal(node: FilterNode, row: any, mediaType: ListMediaType): boolean {
  if (node.op === 'and') return node.nodes.every(child => evaluateLocal(child, row, mediaType))
  if (node.op === 'or') return node.nodes.some(child => evaluateLocal(child, row, mediaType))
  if (node.op === 'not') return !evaluateLocal(node.node, row, mediaType)
  if (node.op === 'titleText') {
    const title = String((mediaType === 'film' ? row?.title : row?.name) ?? '')
    const matched = titleTextMatches(title, node.values, node.match)
    return node.mode === 'includes' ? matched : !matched
  }
  if (node.op === 'title') {
    const held = node.ids.includes(Number(row?.id))
    return node.mode === 'includes' ? held : !held
  }
  if (node.op === 'genre') {
    const vocabulary = mediaType === 'film' ? FILM_GENRES : SERIES_GENRES
    const wanted = node.values.map(value => vocabulary[normal(value)])
    const missing = node.values.filter((_value, index) => wanted[index] == null)
    if (missing.length) throw new UnsupportedListFilterError([`TMDB has no ${mediaType} genre for: ${missing.join(', ')}`])
    const held = new Set((Array.isArray(row?.genre_ids) ? row.genre_ids : []).map(Number))
    const present = node.match === 'any' ? wanted.some(id => held.has(id)) : wanted.every(id => held.has(id))
    return node.mode === 'includes' ? present : !present
  }
  if (node.op === 'year') {
    const date = rowDate(row, mediaType)
    if (node.relative === 'future') return Boolean(date) && date >= new Date().toISOString().slice(0, 10)
    const year = /^\d{4}/.test(date) ? Number.parseInt(date.slice(0, 4), 10) : null
    if (year == null) return false
    if (node.relative) return year === new Date().getUTCFullYear() + (node.relative === 'next_year' ? 1 : 0)
    return (node.min == null || year >= node.min) && (node.max == null || year <= node.max)
  }
  if (node.op === 'rating') {
    const score = Number(row?.vote_average ?? 0)
    const votes = Number(row?.vote_count ?? 0)
    return (node.min == null || score >= node.min) && (node.max == null || score <= node.max) && (node.minVotes == null || votes >= node.minVotes)
  }
  if (node.op === 'language') return node.values.map(normal).includes(String(row?.original_language ?? '').toLowerCase())
  throw new UnsupportedListFilterError([`A "title contains" rule cannot be combined with ${node.op}`])
}

const SEARCH_PAGE_LIMIT = 10

async function searchRows(phrase: string, mediaType: ListMediaType, into: Map<number, any>, signal?: AbortSignal): Promise<void> {
  let page = 1
  let totalPages = 1
  do {
    const response = await withProviderRetry('tmdb', () => axios.get(`${tmdbBase()}/search/${mediaType === 'film' ? 'movie' : 'tv'}`, {
      params: { api_key: tmdbApiKey(), language: 'en-US', query: phrase, include_adult: false, page },
      timeout: 15_000,
      signal,
    }), signal)
    const data = response.data as { total_pages?: number; results?: any[] }
    totalPages = Math.min(Math.max(1, Number(data.total_pages) || 1), SEARCH_PAGE_LIMIT)
    for (const row of data.results ?? []) {
      const id = Number(row?.id)
      if (Number.isSafeInteger(id) && id > 0 && !into.has(id)) into.set(id, row)
    }
    page += 1
  } while (page <= totalPages)
}

type ExactPersonFilter = { role: Extract<FilterNode, { op: 'person' }>['role']; ids: number[]; match?: 'all' | 'any' }

const ROLE_JOBS: Partial<Record<ExactPersonFilter['role'], string[]>> = {
  director: ['director'],
  producer: ['producer', 'co-producer'],
  executive_producer: ['executive producer', 'co-executive producer'],
  writer: ['writer', 'screenplay', 'story', 'teleplay'],
  creator: ['creator', 'series creator', 'original series creator'],
  composer: ['original music composer', 'composer', 'music'],
  cinematographer: ['director of photography', 'cinematography', 'cinematographer'],
  editor: ['editor'],
}

function roleRows(credits: { cast?: any[]; crew?: any[] }, role: ExactPersonFilter['role']): any[] {
  if (role === 'starring') return (credits.cast ?? []).filter(row => Number(row.order) >= 0 && Number(row.order) <= 2)
  if (role === 'cast') return credits.cast ?? []
  if (role === 'crew') return credits.crew ?? []
  if (role === 'any') return [...(credits.cast ?? []), ...(credits.crew ?? [])]
  const jobs = ROLE_JOBS[role] ?? []
  return (credits.crew ?? []).filter(row => jobs.includes(String(row.job ?? '').trim().toLowerCase()))
}

async function exactPersonCandidates(filters: ExactPersonFilter[], mediaType: ListMediaType, signal?: AbortSignal): Promise<Map<number, any>> {
  const intersect = (left: Map<number, any>, right: Map<number, any>): Map<number, any> => {
    const result = new Map<number, any>()
    for (const [id, row] of left) if (right.has(id)) result.set(id, row)
    return result
  }
  const union = (left: Map<number, any>, right: Map<number, any>): Map<number, any> => {
    const result = new Map<number, any>(left)
    for (const [id, row] of right) if (!result.has(id)) result.set(id, row)
    return result
  }
  let combined: Map<number, any> | null = null
  for (const filter of filters) {
    // Within one rule the people combine per its own match setting; separate
    // rules always intersect, which is what the list-level AND means.
    const combineWithin = filter.match === 'any' ? union : intersect
    let filterMatches: Map<number, any> | null = null
    for (const personId of filter.ids) {
      const response = await withProviderRetry('tmdb', () => axios.get(`${tmdbBase()}/person/${personId}/${mediaType === 'film' ? 'movie' : 'tv'}_credits`, {
        params: { api_key: tmdbApiKey(), language: 'en-US' }, timeout: 15_000,
        signal,
      }), signal)
      const personMatches = new Map<number, any>()
      for (const row of roleRows(response.data ?? {}, filter.role)) {
        const id = Number(row?.id)
        if (Number.isSafeInteger(id) && id > 0) personMatches.set(id, row)
      }
      filterMatches = filterMatches == null
        ? personMatches
        : combineWithin(filterMatches, personMatches)
    }
    combined = combined == null
      ? filterMatches ?? new Map<number, any>()
      : intersect(combined, filterMatches ?? new Map<number, any>())
  }
  return combined ?? new Map()
}

export class TmdbDiscoverCompiler implements FilterCompiler {
  readonly id = 'tmdb-discover-v2'

  supports(op: FilterNode['op']): boolean {
    return ['and', 'or', 'not', 'genre', 'year', 'rating', 'runtime', 'language', 'certification', 'keyword', 'title', 'titleText', 'person', 'company', 'network', 'watchProvider'].includes(op)
  }

  compile(ast: FilterNode, mediaType: ListMediaType): CompiledQuery {
    const leaves = (node: FilterNode): FilterNode[] => node.op === 'and' || node.op === 'or'
      ? node.nodes.flatMap(leaves)
      : node.op === 'not' ? leaves(node.node) : [node]
    const allLeaves = leaves(ast)
    const includesSpecificTitles = allLeaves.some(node => node.op === 'title' && node.mode === 'includes')
    if (includesSpecificTitles && allLeaves.some(node => node.op !== 'title')) {
      throw new UnsupportedListFilterError(['Specific title inclusion must be used on its own; use exclusions alongside broader discovery rules'])
    }
    const hasExactSeriesRole = mediaType === 'series' && allLeaves.some(node => node.op === 'person' && !['cast', 'crew', 'any'].includes(node.role))
    const filterExactSeriesCandidates = hasExactSeriesRole && allLeaves.some(node => node.op !== 'person' && !(node.op === 'title' && node.mode === 'excludes'))
    const params: Record<string, string | number | boolean> = {
      include_adult: false,
      include_video: false,
      sort_by: mediaType === 'film' ? 'primary_release_date.asc' : 'first_air_date.asc',
    }
    if (filterExactSeriesCandidates) params.__filter_exact_candidates = true
    compileNode(ast, mediaType, params)
    const path = mediaType === 'film' ? '/discover/movie' : '/discover/tv'

    // A "title contains" rule is answered by /search, not /discover, so the
    // whole filter has to be decidable from a search result row. Say which rule
    // makes that impossible rather than quietly ignoring it.
    if (params.__title_search != null) {
      const unsupported = [...new Set(allLeaves.map(node => node.op).filter(op => !LOCALLY_EVALUABLE.has(op)))]
      if (unsupported.length) {
        throw new UnsupportedListFilterError([`A "title contains" rule searches by name, so it cannot be combined with: ${unsupported.join(', ')}. Genre, release year, rating, language and title rules work alongside it`])
      }
      params.__local_ast = JSON.stringify(ast)
    }

    // A minimum-runtime rule fails every title TMDB has not yet timed, which
    // includes anything unreleased — see CompiledQuery.unreleasedParams.
    const runtimeMin = params['with_runtime.gte']
    let unreleasedParams: Record<string, string | number | boolean> | undefined
    if (typeof runtimeMin === 'number' && runtimeMin > 0) {
      const dateField = mediaType === 'film' ? 'primary_release_date' : 'first_air_date'
      const today = new Date().toISOString().slice(0, 10)
      const existingGte = params[`${dateField}.gte`]
      unreleasedParams = { ...params, [`${dateField}.gte`]: typeof existingGte === 'string' && existingGte > today ? existingGte : today }
      unreleasedParams = Object.fromEntries(Object.entries(unreleasedParams).filter(([key]) => key !== 'with_runtime.gte' && key !== 'with_runtime.lte'))
    }
    return { compilerId: this.id, mediaType, path, params, unreleasedParams }
  }

  async execute(query: CompiledQuery, opts: { limit: number; signal?: AbortSignal }): Promise<ListMemberResult> {
    const limit = Math.max(1, Math.min(opts.limit, PROVIDER_CEILING))
    const members: ListMember[] = []
    const providerIds = (value: unknown) => String(value ?? '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
    const includeIds = new Set(providerIds(query.params.__include_title_ids))
    const excludeIds = new Set(providerIds(query.params.__exclude_title_ids))
    const providerParams = Object.fromEntries(Object.entries(query.params).filter(([key]) => !key.startsWith('__')))
    const exactFilters = JSON.parse(String(query.params.__exact_person_roles ?? '[]')) as ExactPersonFilter[]
    const exactCandidates = exactFilters.length > 0 ? await exactPersonCandidates(exactFilters, query.mediaType, opts.signal) : null
    const titleTextRules = (key: string) => JSON.parse(String(query.params[key] ?? '[]')) as Array<{ values: string[]; match?: 'all' | 'any' }>
    const titleExcludes = titleTextRules('__title_text_exclude')
    const excludedByTitle = (title: string) => titleExcludes.some(rule => titleTextMatches(title, rule.values, rule.match))

    const titleSearches = titleTextRules('__title_search')
    if (titleSearches.length > 0) {
      const localAst = JSON.parse(String(query.params.__local_ast ?? 'null')) as FilterNode | null
      const rows = new Map<number, any>()
      for (const rule of titleSearches) {
        for (const phrase of rule.values) await searchRows(phrase, query.mediaType, rows, opts.signal)
      }
      const matched = [...rows.values()]
        .filter(row => !excludeIds.has(Number(row?.id)) && (localAst == null || evaluateLocal(localAst, row, query.mediaType)))
        .map(row => member(row, query.mediaType))
        .filter((value): value is ListMember => value != null)
        .sort((a, b) => String(a.releaseDate ?? '').localeCompare(String(b.releaseDate ?? '')) || a.tmdbId - b.tmdbId)
      return { members: matched.slice(0, limit), total: matched.length, capped: matched.length > limit, ceilingHit: false,
        warning: matched.length > limit ? `This filter matches ${matched.length} titles, above the configured member cap of ${limit}.` : undefined }
    }

    if (includeIds.size > 0) {
      const rows = await Promise.all([...includeIds].filter(id => !excludeIds.has(id)).map(async id => {
        try {
          const response = await withProviderRetry('tmdb', () => axios.get(`${tmdbBase()}/${query.mediaType === 'film' ? 'movie' : 'tv'}/${id}`, {
            params: { api_key: tmdbApiKey(), language: 'en-US' }, timeout: 15_000,
            signal: opts.signal,
          }), opts.signal)
          return member(response.data, query.mediaType)
        } catch (error) {
          if (axios.isAxiosError(error) && error.response?.status === 404) return null
          throw error
        }
      }))
      const exact = rows.filter((value): value is ListMember => value != null)
        .sort((a, b) => String(a.releaseDate ?? '').localeCompare(String(b.releaseDate ?? '')) || a.tmdbId - b.tmdbId)
      return { members: exact.slice(0, limit), total: exact.length, capped: exact.length > limit, ceilingHit: false,
        warning: exact.length > limit ? `This List contains ${exact.length} titles, above the configured member cap of ${limit}.` : undefined }
    }
    if (exactCandidates && query.mediaType === 'series' && query.params.__filter_exact_candidates !== true) {
      const exact = [...exactCandidates.values()].map(row => member(row, query.mediaType))
        .filter((value): value is ListMember => value != null && !excludeIds.has(value.tmdbId))
        .sort((a, b) => String(a.releaseDate ?? '').localeCompare(String(b.releaseDate ?? '')) || a.tmdbId - b.tmdbId)
      return { members: exact.slice(0, limit), total: exact.length, capped: exact.length > limit, ceilingHit: false,
        warning: exact.length > limit ? `This filter matches ${exact.length} titles, above the configured member cap of ${limit}.` : undefined }
    }
    const seen = new Set<number>()
    let exactTotal = 0
    let titleExcluded = 0

    const runDiscover = async (discoverParams: Record<string, string | number | boolean>): Promise<number> => {
      let page = 1
      let rawTotal = 0
      let totalPages = 1
      do {
        const response = await withProviderRetry('tmdb', () => axios.get(`${tmdbBase()}${query.path}`, {
          params: { api_key: tmdbApiKey(), language: 'en-US', ...discoverParams, page },
          timeout: 15_000,
          signal: opts.signal,
        }), opts.signal)
        const data = response.data as { page?: number; total_pages?: number; total_results?: number; results?: any[] }
        rawTotal = Math.max(0, Number(data.total_results) || 0)
        totalPages = Math.min(Math.max(1, Number(data.total_pages) || 1), Math.ceil(PROVIDER_CEILING / PAGE_SIZE))
        for (const row of data.results ?? []) {
          const parsed = member(row, query.mediaType)
          if (!parsed || seen.has(parsed.tmdbId) || excludeIds.has(parsed.tmdbId) || (exactCandidates && !exactCandidates.has(parsed.tmdbId))) continue
          if (excludedByTitle(parsed.title)) {
            seen.add(parsed.tmdbId)
            titleExcluded += 1
            continue
          }
          seen.add(parsed.tmdbId)
          exactTotal += 1
          if (members.length < limit) members.push(parsed)
          if (!exactCandidates && members.length >= limit) break
        }
        page += 1
      } while ((exactCandidates || members.length < limit) && page <= totalPages)
      return rawTotal
    }

    let total = await runDiscover(providerParams)
    // Runs as a second, separate discover query rather than a post-filter:
    // TMDB's list responses don't carry per-title runtime, so there is nothing
    // in `providerParams`'s results to exempt after the fact.
    if (query.unreleasedParams && (exactCandidates || members.length < limit)) {
      const unreleasedProviderParams = Object.fromEntries(Object.entries(query.unreleasedParams).filter(([key]) => !key.startsWith('__')))
      total += await runDiscover(unreleasedProviderParams)
    }

    // Title exclusions are applied to the pages actually walked, so the deduction
    // is only as complete as the window — an over-count leaves the List capped,
    // which is the safe direction: capped runs never manufacture departures.
    total = exactCandidates ? exactTotal : Math.max(0, total - excludeIds.size - titleExcluded)
    const ceilingHit = total > PROVIDER_CEILING
    const capped = total > limit || ceilingHit
    const warning = ceilingHit
      ? 'This filter matches more than 10,000 titles — narrow it.'
      : total > limit ? `This filter matches ${total} titles, above the configured member cap of ${limit}.` : undefined
    return { members, total, capped, ceilingHit, warning }
  }
}
