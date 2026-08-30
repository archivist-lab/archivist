import type {
  PlayerShelfRow, PlayerShelfSettings, PlayerShelfSort, PlayerShelfSource,
  PlayerShelfType, PlayerShelfView, PlayerShelfWatchState, PlayerShelfWindowField,
} from '@archivist/contracts'
import { PLAYER_SHELF_SOURCES } from '@archivist/contracts'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

/**
 * Operator-owned configuration for the Player's browsing rows.
 *
 * A row is a query: a source, a time window over one of its dates, filters,
 * a sort, a cap, and a list of sibling rows it must not repeat. Rows can be
 * added, removed and reordered, so nothing here assumes a fixed set.
 */

const SETTINGS_KEY = 'playerShelves'

export const WINDOW_DAYS = { min: 1, max: 3650 } as const
export const LIMIT = { min: 1, max: 100 } as const

const SORTS: readonly PlayerShelfSort[] = ['added', 'released', 'aired', 'title', 'rating', 'year', 'random']
const WATCH_STATES: readonly PlayerShelfWatchState[] = ['all', 'unwatched', 'watched', 'in-progress']
const WINDOW_FIELDS: readonly PlayerShelfWindowField[] = ['none', 'added', 'released', 'aired']
const VIEWS: readonly PlayerShelfView[] = ['poster', 'landscape']

const row = (id: string, source: PlayerShelfSource, label: string, overrides: Partial<PlayerShelfRow> = {}): PlayerShelfRow => ({
  id, source, label,
  enabled: true,
  windowField: 'none', windowDays: 90,
  watchState: 'all',
  genres: [], minRating: null, yearFrom: null, yearTo: null,
  sort: 'added', sortOrder: 'desc',
  limit: 18,
  view: source === 'films' || source === 'series' ? 'poster' : 'landscape',
  dedupeAgainst: [],
  ...overrides,
})

export const DEFAULT_PLAYER_SHELF_SETTINGS: PlayerShelfSettings = {
  films: {
    enabled: true,
    label: 'Films',
    rows: [
      row('films-recently-added', 'films', 'Recently Added', {
        windowField: 'added', watchState: 'unwatched', dedupeAgainst: ['films-recently-released'],
      }),
      row('films-recently-released', 'films', 'Recently Released', {
        windowField: 'released', watchState: 'unwatched', sort: 'released',
      }),
      row('films-all', 'films', 'All films', { sort: 'title', sortOrder: 'asc', limit: 100 }),
    ],
  },
  series: {
    enabled: true,
    label: 'Series',
    rows: [
      row('series-next-up', 'next-up', 'Next Up', { watchState: 'unwatched' }),
      row('series-recently-added', 'episodes', 'Recently Added', {
        windowField: 'added', dedupeAgainst: ['series-recently-aired'],
      }),
      row('series-recently-aired', 'episodes', 'Recently Aired', { windowField: 'aired', sort: 'aired' }),
      row('series-all', 'series', 'All series', { sort: 'title', sortOrder: 'asc', limit: 100, view: 'poster' }),
    ],
  },
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const optionalInt = (value: unknown, min: number, max: number): number | null => {
  if (value == null || value === '') return null
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
}

const optionalNumber = (value: unknown, min: number, max: number): number | null => {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null
}

const text = (value: unknown, fallback: string, max = 48): string => {
  const trimmed = String(value ?? '').normalize('NFC').replace(/[\p{Cc}]/gu, '').trim()
  return trimmed ? trimmed.slice(0, max) : fallback
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback

const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback

const stringList = (value: unknown, max = 20): string[] => {
  const raw = Array.isArray(value) ? value : []
  return [...new Set(raw.map(entry => text(entry, '', 40)).filter(Boolean))].slice(0, max)
}

/** Ids are used in URLs, React keys and dedupe references, so keep them tame. */
const slug = (value: unknown, fallback: string): string => {
  const cleaned = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return cleaned || fallback
}

function resolveRow(candidate: Partial<PlayerShelfRow>, typeName: keyof PlayerShelfSettings, index: number, taken: Set<string>): PlayerShelfRow {
  const allowedSources = PLAYER_SHELF_SOURCES[typeName]
  const source = oneOf(candidate.source, allowedSources, allowedSources[0])
  let id = slug(candidate.id, `${typeName}-row-${index + 1}`)
  // Two rows sharing an id would make dedupe references and React keys
  // ambiguous, so a collision is resolved rather than rejected.
  while (taken.has(id)) id = `${id}-2`.slice(0, 48)
  taken.add(id)
  const windowField = oneOf(candidate.windowField, WINDOW_FIELDS, 'none')
  return {
    id,
    source,
    label: text(candidate.label, 'Row'),
    enabled: bool(candidate.enabled, true),
    windowField,
    windowDays: clampInt(candidate.windowDays, WINDOW_DAYS.min, WINDOW_DAYS.max, 90),
    watchState: oneOf(candidate.watchState, WATCH_STATES, 'all'),
    genres: stringList(candidate.genres),
    minRating: optionalNumber(candidate.minRating, 0, 10),
    yearFrom: optionalInt(candidate.yearFrom, 1870, 2200),
    yearTo: optionalInt(candidate.yearTo, 1870, 2200),
    sort: oneOf(candidate.sort, SORTS, 'added'),
    sortOrder: oneOf(candidate.sortOrder, ['asc', 'desc'] as const, 'desc'),
    limit: clampInt(candidate.limit, LIMIT.min, LIMIT.max, 18),
    view: oneOf(candidate.view, VIEWS, source === 'episodes' || source === 'next-up' ? 'landscape' : 'poster'),
    dedupeAgainst: stringList(candidate.dedupeAgainst),
  }
}

function resolveType(stored: Partial<PlayerShelfType> | undefined, typeName: keyof PlayerShelfSettings, base: PlayerShelfType): PlayerShelfType {
  const candidates = Array.isArray(stored?.rows) ? stored.rows : null
  // No stored rows at all means the operator has not configured this type yet.
  // An explicitly empty list is a real choice and is kept.
  if (!candidates) return { enabled: bool(stored?.enabled, base.enabled), label: text(stored?.label, base.label), rows: base.rows }
  const taken = new Set<string>()
  const rows = candidates.slice(0, 24).map((candidate, index) => resolveRow(candidate ?? {}, typeName, index, taken))
  const ids = new Set(rows.map(entry => entry.id))
  return {
    enabled: bool(stored?.enabled, base.enabled),
    label: text(stored?.label, base.label),
    // A dedupe reference to a row that no longer exists would silently do
    // nothing, so it is dropped on the way in rather than left to rot.
    rows: rows.map(entry => ({ ...entry, dedupeAgainst: entry.dedupeAgainst.filter(ref => ref !== entry.id && ids.has(ref)) })),
  }
}

export function getPlayerShelfSettings(): PlayerShelfSettings {
  const stored = getAppSetting<Partial<PlayerShelfSettings>>(SETTINGS_KEY, {})
  return {
    films: resolveType(stored.films, 'films', DEFAULT_PLAYER_SHELF_SETTINGS.films),
    series: resolveType(stored.series, 'series', DEFAULT_PLAYER_SHELF_SETTINGS.series),
  }
}

export function updatePlayerShelfSettings(input: Partial<PlayerShelfSettings>): PlayerShelfSettings {
  const current = getPlayerShelfSettings()
  // Validate through the same path a read takes, so what is stored is always a
  // shape the Player can render.
  const next: PlayerShelfSettings = {
    films: resolveType(input.films ?? current.films, 'films', DEFAULT_PLAYER_SHELF_SETTINGS.films),
    series: resolveType(input.series ?? current.series, 'series', DEFAULT_PLAYER_SHELF_SETTINGS.series),
  }
  setAppSetting(SETTINGS_KEY, next)
  return getPlayerShelfSettings()
}

export function resetPlayerShelfSettings(): PlayerShelfSettings {
  setAppSetting(SETTINGS_KEY, DEFAULT_PLAYER_SHELF_SETTINGS)
  return getPlayerShelfSettings()
}
