// Field-aware library search — Phase 1 (local, client-side).
//
// The library grids already load every item with its full cast/crew/genres
// metadata, so field-aware search runs entirely against that in-memory list —
// no provider calls, works offline, matches the current architecture. A future
// phase can move this server-side over normalized tables; the field ids defined
// here are the stable contract that migration would preserve.

import type { DashboardMediaTypeOption } from '../modules/home/DashboardMediaTypeDropdown.js'

export type LibraryMediaType = 'films' | 'series'

interface FieldDef {
  id: string
  label: string
  group: string
  /** Media types this field applies to. */
  media: LibraryMediaType[]
  /** Contextual search placeholder. */
  placeholder: string
}

// Provider crew "job" strings (lower-cased) that map to each Archivist role.
const CREW_ROLES: Record<string, string[]> = {
  director: ['director'],
  writer: ['writer', 'screenplay', 'teleplay', 'story', 'author'],
  producer: ['producer', 'co-producer'],
  executive_producer: ['executive producer', 'co-executive producer'],
  composer: ['original music composer', 'music', 'composer'],
  cinematographer: ['director of photography', 'cinematography', 'cinematographer'],
  editor: ['editor', 'film editor'],
  creator: ['creator', 'original series creator', 'series creator'],
}

const FIELDS: FieldDef[] = [
  // ── Film / Series core ──
  { id: 'title', label: 'Title', group: 'Film', media: ['films', 'series'], placeholder: 'Search titles…' },
  { id: 'original_title', label: 'Original Title', group: 'Film', media: ['films'], placeholder: 'Search original titles…' },
  { id: 'genre', label: 'Genre', group: 'Film', media: ['films', 'series'], placeholder: 'Search by genre…' },
  { id: 'year', label: 'Year', group: 'Film', media: ['films'], placeholder: 'Search by year (e.g. 1999)…' },
  { id: 'first_air_year', label: 'First Air Year', group: 'Series', media: ['series'], placeholder: 'Search by first-air year…' },
  { id: 'decade', label: 'Decade', group: 'Film', media: ['films', 'series'], placeholder: 'Search by decade (e.g. 1980s)…' },
  { id: 'certification', label: 'Certification', group: 'Film', media: ['films', 'series'], placeholder: 'Search by certification…' },
  { id: 'country', label: 'Country', group: 'Film', media: ['films', 'series'], placeholder: 'Search by country…' },
  { id: 'original_language', label: 'Original Language', group: 'Series', media: ['series'], placeholder: 'Search by language…' },
  { id: 'runtime', label: 'Runtime', group: 'Film', media: ['films'], placeholder: 'Search by runtime (minutes)…' },
  { id: 'status', label: 'Status', group: 'Series', media: ['series'], placeholder: 'Search by status…' },
  // ── People ──
  { id: 'starring', label: 'Starring', group: 'People', media: ['films', 'series'], placeholder: 'Search by starring cast…' },
  { id: 'supporting_cast', label: 'Supporting Cast', group: 'People', media: ['films', 'series'], placeholder: 'Search by supporting cast…' },
  { id: 'any_cast', label: 'Any Cast', group: 'People', media: ['films', 'series'], placeholder: 'Search by any cast member…' },
  { id: 'creator', label: 'Creator', group: 'People', media: ['series'], placeholder: 'Search by creator…' },
  { id: 'director', label: 'Director', group: 'People', media: ['films', 'series'], placeholder: 'Search by director…' },
  { id: 'writer', label: 'Writer', group: 'People', media: ['films', 'series'], placeholder: 'Search by writer…' },
  { id: 'producer', label: 'Producer', group: 'People', media: ['films', 'series'], placeholder: 'Search by producer…' },
  { id: 'executive_producer', label: 'Executive Producer', group: 'People', media: ['films', 'series'], placeholder: 'Search by executive producer…' },
  { id: 'composer', label: 'Composer', group: 'People', media: ['films', 'series'], placeholder: 'Search by composer…' },
  { id: 'cinematographer', label: 'Cinematographer', group: 'People', media: ['films'], placeholder: 'Search by cinematographer…' },
  { id: 'editor', label: 'Editor', group: 'People', media: ['films'], placeholder: 'Search by editor…' },
  { id: 'any_credit', label: 'Any Credit', group: 'People', media: ['films', 'series'], placeholder: 'Search by any cast or crew…' },
  // ── Studio / Network / Collection ──
  { id: 'studio', label: 'Studio', group: 'Studio', media: ['films'], placeholder: 'Search by studio…' },
  { id: 'network', label: 'Network', group: 'Network', media: ['series'], placeholder: 'Search by network…' },
  { id: 'collection', label: 'Collection', group: 'Collection', media: ['films'], placeholder: 'Search collections…' },
]

const FIELD_BY_ID = new Map(FIELDS.map(f => [f.id, f]))

/** Dropdown options (with group headings) valid for the active media type. */
export function fieldOptions(media: LibraryMediaType, accent: string): DashboardMediaTypeOption[] {
  return FIELDS
    .filter(f => f.media.includes(media))
    .map(f => ({ value: f.id, label: f.label, icon: '', color: accent, group: f.group === 'Film' && media === 'series' ? 'Series' : f.group }))
}

export function fieldPlaceholder(fieldId: string): string {
  return FIELD_BY_ID.get(fieldId)?.placeholder ?? 'Search library…'
}

/** True when `fieldId` is valid for the given media type (else caller resets to title). */
export function fieldValidFor(fieldId: string, media: LibraryMediaType): boolean {
  return FIELD_BY_ID.get(fieldId)?.media.includes(media) ?? false
}

function parseDecade(q: string): [number, number] | null {
  const m = q.match(/^(\d{2}|\d{4})s?$/)
  if (!m) return null
  let n = parseInt(m[1], 10)
  if (m[1].length === 2) n = n < 30 ? 2000 + n : 1900 + n
  const start = Math.floor(n / 10) * 10
  return [start, start + 9]
}

/**
 * Field-aware predicate against a loaded library item (Movie or Series).
 * An empty query matches everything (unfiltered library). An unknown field
 * matches nothing rather than silently falling back to title search.
 */
export function matchItem(item: any, fieldId: string, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true

  const inc = (v: unknown) => String(v ?? '').toLowerCase().includes(q)
  const cast: any[] = Array.isArray(item?.cast) ? item.cast : []
  const crew: any[] = Array.isArray(item?.crew) ? item.crew : []
  const genres: any[] = Array.isArray(item?.genres) ? item.genres : []
  const anyName = (arr: any[]) => arr.some(p => inc(p?.name))
  const crewRole = (roles: string[]) => crew.some(p => roles.includes(String(p?.job ?? '').toLowerCase()) && inc(p?.name))

  switch (fieldId) {
    case 'title': return inc(item?.title) || inc(item?.original_title)
    case 'original_title': return inc(item?.original_title)
    case 'genre': return genres.some(g => inc(g))
    case 'year':
    case 'first_air_year': return String(item?.year ?? '') === q
    case 'decade': { const d = parseDecade(q); return !!d && typeof item?.year === 'number' && item.year >= d[0] && item.year <= d[1] }
    case 'certification': return inc(item?.certification)
    case 'country': return inc(item?.country)
    case 'original_language': return inc(item?.language)
    case 'status': return inc(item?.status)
    case 'runtime': { const r = parseInt(q, 10); return Number.isFinite(r) && item?.runtime === r }
    case 'studio': return inc(item?.studio)
    case 'network': return inc(item?.network)
    case 'collection': return inc(item?.collection_name)
    case 'starring': return cast.slice(0, 5).some(p => inc(p?.name))
    case 'supporting_cast': return cast.slice(5).some(p => inc(p?.name))
    case 'any_cast': return anyName(cast)
    case 'any_credit': return anyName(cast) || anyName(crew)
    default: { const roles = CREW_ROLES[fieldId]; return roles ? crewRole(roles) : false }
  }
}
