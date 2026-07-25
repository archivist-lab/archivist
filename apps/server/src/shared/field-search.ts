import { normalizePersonName } from '../services/credit-index.js'

// Builds a SQL WHERE fragment for a single field-aware library search. People
// fields resolve through the normalized `media_credits`/`people` index; the
// rest use item columns or json_each over the stored JSON. Everything is
// parameterized. `alias` is the media table's alias in the caller's query.

export interface FieldSearchClause { sql: string; params: unknown[] }

const FILM_FIELDS = new Set([
  'title', 'original_title', 'genre', 'year', 'decade', 'certification', 'country', 'runtime',
  'starring', 'supporting_cast', 'any_cast', 'director', 'writer', 'producer', 'executive_producer',
  'composer', 'cinematographer', 'editor', 'any_credit', 'studio', 'collection',
])
const SERIES_FIELDS = new Set([
  'title', 'genre', 'first_air_year', 'decade', 'certification', 'country', 'original_language', 'status',
  'starring', 'supporting_cast', 'any_cast', 'creator', 'director', 'writer', 'producer', 'executive_producer',
  'composer', 'any_credit', 'network',
])
const CREW_ROLE_FIELDS = new Set(['director', 'writer', 'producer', 'executive_producer', 'composer', 'cinematographer', 'editor', 'creator'])

export function fieldValidFor(mediaType: 'films' | 'series', field: string): boolean {
  return (mediaType === 'films' ? FILM_FIELDS : SERIES_FIELDS).has(field)
}

export interface CompoundFilter { field: string; q: string }

/**
 * Combines several field filters into one clause (AND/OR). Returns null when
 * nothing is filterable, or `{ error }` when any field is invalid for the media
 * type (the caller should reject with 400 rather than silently drop it).
 */
export function buildCompoundSearch(
  mediaType: 'films' | 'series',
  filters: CompoundFilter[],
  alias = 'f',
  logic: 'and' | 'or' = 'and',
): FieldSearchClause | { error: string } | null {
  const clauses: string[] = []
  const params: unknown[] = []
  for (const f of filters) {
    if (!f?.q || !f.q.trim()) continue
    if (!fieldValidFor(mediaType, f.field)) return { error: `Unsupported search field for ${mediaType}: ${f.field}` }
    const c = buildFieldSearch(mediaType, f.field, f.q, alias)
    if (c) { clauses.push(`(${c.sql})`); params.push(...c.params) }
  }
  if (clauses.length === 0) return null
  return { sql: clauses.join(logic === 'or' ? ' OR ' : ' AND '), params }
}

function parseDecade(q: string): [number, number] | null {
  const m = q.match(/^(\d{2}|\d{4})s?$/)
  if (!m) return null
  let n = parseInt(m[1], 10)
  if (m[1].length === 2) n = n < 30 ? 2000 + n : 1900 + n
  const start = Math.floor(n / 10) * 10
  return [start, start + 9]
}

const NONE: FieldSearchClause = { sql: '1 = 0', params: [] }

/**
 * Returns a WHERE clause for `field`/`query`, or null when there's nothing to
 * filter (empty query). A malformed numeric query yields a matches-nothing
 * clause rather than silently widening to everything.
 */
export function buildFieldSearch(mediaType: 'films' | 'series', field: string, rawQuery: string, alias = 'f'): FieldSearchClause | null {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return null
  const like = `%${q}%`
  const nameLike = `%${normalizePersonName(rawQuery)}%`
  const mt = mediaType === 'films' ? 'film' : 'series'
  const credit = (cond: string, params: unknown[]): FieldSearchClause => ({
    sql: `EXISTS (SELECT 1 FROM media_credits mc JOIN people p ON p.id = mc.person_id WHERE mc.media_type = '${mt}' AND mc.media_id = ${alias}.id AND ${cond})`,
    params,
  })

  switch (field) {
    case 'title':
      return mediaType === 'films'
        ? { sql: `(lower(${alias}.title) LIKE ? OR lower(${alias}.original_title) LIKE ?)`, params: [like, like] }
        : { sql: `lower(${alias}.title) LIKE ?`, params: [like] }
    case 'original_title': return { sql: `lower(${alias}.original_title) LIKE ?`, params: [like] }
    case 'genre': return { sql: `EXISTS (SELECT 1 FROM json_each(${alias}.genres) je WHERE lower(je.value) LIKE ?)`, params: [like] }
    case 'year': case 'first_air_year': { const y = parseInt(q, 10); return Number.isFinite(y) ? { sql: `${alias}.year = ?`, params: [y] } : NONE }
    case 'decade': { const d = parseDecade(q); return d ? { sql: `${alias}.year BETWEEN ? AND ?`, params: d } : NONE }
    case 'certification': return { sql: `lower(${alias}.certification) LIKE ?`, params: [like] }
    case 'country': return { sql: `lower(${alias}.country) LIKE ?`, params: [like] }
    case 'original_language': return { sql: `lower(${alias}.language) LIKE ?`, params: [like] }
    case 'status': return { sql: `lower(${alias}.status) LIKE ?`, params: [like] }
    case 'runtime': { const r = parseInt(q, 10); return Number.isFinite(r) ? { sql: `${alias}.runtime = ?`, params: [r] } : NONE }
    case 'studio': return { sql: `lower(${alias}.studio) LIKE ?`, params: [like] }
    case 'network': return { sql: `lower(${alias}.network) LIKE ?`, params: [like] }
    case 'collection': return { sql: `lower(${alias}.collection_name) LIKE ?`, params: [like] }
    case 'starring': return credit(`mc.credit_type = 'cast' AND mc.is_starring = 1 AND p.normalized_name LIKE ?`, [nameLike])
    case 'supporting_cast': return credit(`mc.credit_type = 'cast' AND mc.is_starring = 0 AND p.normalized_name LIKE ?`, [nameLike])
    case 'any_cast': return credit(`mc.credit_type = 'cast' AND p.normalized_name LIKE ?`, [nameLike])
    case 'any_credit': return credit(`p.normalized_name LIKE ?`, [nameLike])
    default:
      if (CREW_ROLE_FIELDS.has(field)) return credit(`mc.credit_type = 'crew' AND mc.role = ? AND p.normalized_name LIKE ?`, [field, nameLike])
      return null
  }
}
