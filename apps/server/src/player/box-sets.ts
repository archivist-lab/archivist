import type {
  PlayerBoxSet, PlayerBoxSetField, PlayerBoxSetSeason, PlayerBoxSetSettings, PlayerBoxSetSource,
  PlayerBoxSetTemplate, PlayerBoxSetValue, PlayerShelfSort, PlayerShelfView, PlayerShelfWatchState,
} from '@archivist/contracts'
import { PLAYER_BOX_SET_FIELDS } from '@archivist/contracts'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

/**
 * Box sets: families of rows that differ in exactly one value.
 *
 * A template fixes the field and everything presentational — "Directed by
 * {value}", posters, twelve at a time, by release date — and each set under it
 * supplies only the value. That is the whole point: adding Kubrick is one
 * entry, not a row's worth of configuration.
 *
 * Sets can also be seasonal. The window is stored without a year so it comes
 * round annually, and a window whose start is after its end wraps the turn of
 * the year rather than meaning nothing.
 *
 * A template can instead take its sets from the library's Lists. Then there is
 * nothing to configure here per set at all: a list published in the library
 * arrives as a set, carrying the artwork and overview edited beside it.
 */

const SETTINGS_KEY = 'playerBoxSets'
const SETTINGS_VERSION_KEY = 'playerBoxSetsVersion'
const SETTINGS_VERSION = 2

export const LIMIT = { min: 1, max: 100 } as const

const SORTS: readonly PlayerShelfSort[] = ['added', 'released', 'aired', 'title', 'rating', 'year', 'random']
const WATCH_STATES: readonly PlayerShelfWatchState[] = ['all', 'unwatched', 'watched', 'in-progress']
const VIEWS: readonly PlayerShelfView[] = ['poster', 'landscape']

/**
 * Canonical box-set types ship enabled. They remain absent from the Player
 * until at least one visible Library List or manually configured set has local
 * items, so an untouched installation does not gain empty rows.
 */
export const DEFAULT_PLAYER_BOX_SETS: PlayerBoxSetSettings = {
  rowLabel: 'Box Sets',
  templates: [
    template('directed-by', 'Directed By', 'director', 'Directed by {value}'),
    template('starring', 'Starring', 'starring', 'Starring {value}'),
    template('scored-by', 'Scored By', 'composer', 'Scored by {value}'),
    template('from-studio', 'Studio', 'studio', '{value}'),
    template('themes', 'Themes', 'genre', '{value}'),
    template('collections', 'Collections', 'collection', 'The {value} Collection'),
    template('film-box-sets', 'Curated', 'genre', '{value}'),
    template('series-created-by', 'Created By', 'creator', 'Created by {value}', 'series'),
    template('series-directed-by', 'Directed By', 'director', 'Directed by {value}', 'series'),
    template('series-starring', 'Starring', 'starring', 'Starring {value}', 'series'),
    template('series-scored-by', 'Scored By', 'composer', 'Scored by {value}', 'series'),
    template('series-studios', 'Studio', 'network', '{value}', 'series'),
    template('series-networks', 'Network', 'network', '{value}', 'series'),
    template('series-themes', 'Themes', 'genre', '{value}', 'series'),
    template('series-box-sets', 'Curated', 'genre', '{value}', 'series'),
    // These two need no configuration to be correct: they are empty until a
    // list is published to the Player, and then they carry whatever it says.
    listTemplate('film-lists', 'Film lists', 'films'),
    listTemplate('series-lists', 'Series lists', 'series'),
  ],
}

function template(
  id: string,
  name: string,
  field: PlayerBoxSetField,
  labelPattern: string,
  media: 'film' | 'series' = 'film',
): PlayerBoxSetTemplate {
  return {
    id, name, source: 'field', field, labelPattern, mediaType: media === 'film' ? 'films' : 'series', enabled: true,
    sort: 'released', sortOrder: 'desc', limit: 18, view: 'landscape', watchState: 'all',
    season: null, imageUrl: null, overview: null, sets: [],
  }
}

function listTemplate(id: string, name: string, mediaType: 'films' | 'series'): PlayerBoxSetTemplate {
  return {
    ...template(id, name, mediaType === 'films' ? 'director' : 'creator', '{value}'),
    source: 'lists', mediaType, sort: 'released',
  }
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

const text = (value: unknown, fallback: string, max = 64): string => {
  const trimmed = String(value ?? '').normalize('NFC').replace(/[\p{Cc}]/gu, '').trim()
  return trimmed ? trimmed.slice(0, max) : fallback
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback

const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback

/** Free text that is genuinely optional — empty and whitespace both mean unset. */
const optionalText = (value: unknown, max: number): string | null => {
  const trimmed = String(value ?? '').normalize('NFC').replace(/[\p{Cc}]/gu, '').trim()
  return trimmed ? trimmed.slice(0, max) : null
}

const slug = (value: unknown, fallback: string): string => {
  const cleaned = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return cleaned || fallback
}

/** `MM-DD`, or null when the pair is not a usable window. */
function season(value: unknown): PlayerBoxSetSeason | null {
  const candidate = value as Partial<PlayerBoxSetSeason> | null | undefined
  if (!candidate) return null
  const valid = (raw: unknown): string | null => {
    const match = /^(\d{2})-(\d{2})$/.exec(String(raw ?? ''))
    if (!match) return null
    const month = Number(match[1])
    const day = Number(match[2])
    // 02-30 never happens; 02-29 is allowed because it exists in leap years.
    const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (month < 1 || month > 12 || day < 1 || day > lengths[month - 1]) return null
    return `${match[1]}-${match[2]}`
  }
  const from = valid(candidate.from)
  const to = valid(candidate.to)
  return from && to ? { from, to } : null
}

/** Whether `date` falls inside a recurring window, wrapping the year end. */
export function inSeason(window: PlayerBoxSetSeason | null, date = new Date()): boolean {
  if (!window) return true
  const today = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return window.from <= window.to
    ? today >= window.from && today <= window.to
    : today >= window.from || today <= window.to
}

function resolveSet(candidate: Partial<PlayerBoxSet>, index: number, taken: Set<string>): PlayerBoxSet | null {
  const value = text(candidate.value, '')
  // A set with no value would match the whole library, which is never what a
  // box set means.
  if (!value) return null
  let id = slug(candidate.id, `set-${index + 1}`)
  while (taken.has(id)) id = `${id}-2`.slice(0, 48)
  taken.add(id)
  return {
    id, value,
    label: candidate.label == null || candidate.label === '' ? null : text(candidate.label, value),
    enabled: bool(candidate.enabled, true),
    season: season(candidate.season),
    imageUrl: optionalText(candidate.imageUrl, 500),
    overview: optionalText(candidate.overview, 600),
  }
}

function resolveTemplate(candidate: Partial<PlayerBoxSetTemplate>, index: number, taken: Set<string>): PlayerBoxSetTemplate {
  const mediaType = oneOf(candidate.mediaType, ['films', 'series'] as const, 'films')
  const allowed = PLAYER_BOX_SET_FIELDS[mediaType]
  let id = slug(candidate.id, `template-${index + 1}`)
  while (taken.has(id)) id = `${id}-2`.slice(0, 48)
  taken.add(id)
  const setIds = new Set<string>()
  const source: PlayerBoxSetSource = oneOf(candidate.source, ['field', 'lists'] as const, 'field')
  return {
    id,
    name: text(candidate.name, 'Box sets'),
    source,
    field: oneOf(candidate.field, allowed, allowed[0]),
    // The pattern is what makes a family read as one; without the placeholder
    // every set in it would carry the same heading.
    labelPattern: text(candidate.labelPattern, '{value}', 80).includes('{value}')
      ? text(candidate.labelPattern, '{value}', 80)
      : `${text(candidate.labelPattern, '', 80)} {value}`.trim(),
    mediaType,
    enabled: bool(candidate.enabled, true),
    sort: oneOf(candidate.sort, SORTS, 'released'),
    sortOrder: oneOf(candidate.sortOrder, ['asc', 'desc'] as const, 'desc'),
    limit: clampInt(candidate.limit, LIMIT.min, LIMIT.max, 18),
    view: oneOf(candidate.view, VIEWS, 'poster'),
    watchState: oneOf(candidate.watchState, WATCH_STATES, 'all'),
    season: season(candidate.season),
    imageUrl: optionalText(candidate.imageUrl, 500),
    overview: optionalText(candidate.overview, 600),
    // A list-backed template's sets are the published lists themselves, so
    // storing hand-written ones would only be state nothing reads.
    sets: source === 'lists' ? [] : (Array.isArray(candidate.sets) ? candidate.sets : [])
      .slice(0, 60)
      .map((entry, position) => resolveSet(entry ?? {}, position, setIds))
      .filter((entry): entry is PlayerBoxSet => entry !== null),
  }
}

export function getPlayerBoxSets(): PlayerBoxSetSettings {
  const stored = getAppSetting<Partial<PlayerBoxSetSettings>>(SETTINGS_KEY, {})
  if (!Array.isArray(stored.templates)) return DEFAULT_PLAYER_BOX_SETS
  let templates = stored.templates
  if (getAppSetting<number>(SETTINGS_VERSION_KEY, 1) < SETTINGS_VERSION) {
    const existing = new Set(templates.map(entry => entry?.id))
    templates = [...templates, ...DEFAULT_PLAYER_BOX_SETS.templates.filter(entry => !existing.has(entry.id))].slice(0, 24)
    setAppSetting(SETTINGS_KEY, { rowLabel: text(stored.rowLabel, DEFAULT_PLAYER_BOX_SETS.rowLabel), templates })
    setAppSetting(SETTINGS_VERSION_KEY, SETTINGS_VERSION)
  }
  const taken = new Set<string>()
  return {
    rowLabel: text(stored.rowLabel, DEFAULT_PLAYER_BOX_SETS.rowLabel),
    templates: templates.slice(0, 24).map((entry, index) => resolveTemplate(entry ?? {}, index, taken)),
  }
}

export function updatePlayerBoxSets(input: Partial<PlayerBoxSetSettings>): PlayerBoxSetSettings {
  const taken = new Set<string>()
  const templates = (Array.isArray(input.templates) ? input.templates : [])
    .slice(0, 24).map((entry, index) => resolveTemplate(entry ?? {}, index, taken))
  setAppSetting(SETTINGS_KEY, { rowLabel: text(input.rowLabel, DEFAULT_PLAYER_BOX_SETS.rowLabel), templates })
  setAppSetting(SETTINGS_VERSION_KEY, SETTINGS_VERSION)
  return getPlayerBoxSets()
}

export function resetPlayerBoxSets(): PlayerBoxSetSettings {
  setAppSetting(SETTINGS_KEY, DEFAULT_PLAYER_BOX_SETS)
  setAppSetting(SETTINGS_VERSION_KEY, SETTINGS_VERSION)
  return getPlayerBoxSets()
}

/** The heading a set carries: its own label, or the template's pattern filled in. */
export function boxSetLabel(template: PlayerBoxSetTemplate, set: PlayerBoxSet): string {
  return set.label ?? template.labelPattern.replace('{value}', set.value)
}

/**
 * The values a field actually takes in the library, with counts. Offered to the
 * operator so a set is picked rather than typed — a misspelled director is an
 * empty row that looks like a bug.
 */
export function boxSetValues(mediaType: 'films' | 'series', field: PlayerBoxSetField, query: string, limit = 50): PlayerBoxSetValue[] {
  const db = getDb()
  if (!PLAYER_BOX_SET_FIELDS[mediaType].includes(field)) return []
  const table = mediaType === 'films' ? 'films' : 'series'
  const mt = mediaType === 'films' ? 'film' : 'series'
  const available = mediaType === 'films'
    ? 'm.file_path IS NOT NULL'
    : 'EXISTS (SELECT 1 FROM episodes ae WHERE ae.series_id = m.id AND ae.file_path IS NOT NULL)'
  const like = `%${query.trim().toLowerCase()}%`
  const rows = (() => {
    if (field === 'genre') {
      return db.prepare(`SELECT je.value AS value, COUNT(*) AS count FROM ${table} m, json_each(m.genres) je
        WHERE ${available} AND trim(je.value) != '' AND lower(je.value) LIKE ?
        GROUP BY lower(je.value) ORDER BY count DESC, value LIMIT ?`).all(like, limit)
    }
    if (field === 'studio' || field === 'network' || field === 'country' || field === 'certification') {
      const column = field === 'studio' ? 'm.studio' : field === 'network' ? 'm.network' : field === 'country' ? 'm.country' : 'm.certification'
      return db.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} m
        WHERE ${available} AND ${column} IS NOT NULL AND trim(${column}) != '' AND lower(${column}) LIKE ?
        GROUP BY lower(${column}) ORDER BY count DESC, value LIMIT ?`).all(like, limit)
    }
    if (field === 'collection') {
      return db.prepare(`SELECT c.name AS value, COUNT(*) AS count
        FROM collections c JOIN collection_items ci ON ci.collection_id = c.id
        JOIN films m ON m.id = ci.item_id AND m.library_id = ci.library_id
        WHERE ci.entity_type = 'film' AND ${available} AND lower(c.name) LIKE ?
        GROUP BY c.id ORDER BY count DESC, value LIMIT ?`).all(like, limit)
    }
    if (field === 'decade') {
      return db.prepare(`SELECT (m.year / 10 * 10) || 's' AS value, COUNT(*) AS count FROM ${table} m
        WHERE ${available} AND m.year IS NOT NULL AND CAST((m.year / 10 * 10) AS TEXT) LIKE ?
        GROUP BY m.year / 10 ORDER BY value DESC LIMIT ?`).all(like.replace(/s%$/, '%'), limit)
    }
    // Everything else is a credited person.
    const creditFilter = field === 'starring' ? "mc.credit_type = 'cast' AND mc.is_starring = 1"
      : field === 'any_cast' ? "mc.credit_type = 'cast'"
        : `mc.credit_type = 'crew' AND mc.role = '${field}'`
    return db.prepare(`SELECT p.name AS value, COUNT(DISTINCT mc.media_id) AS count
      FROM media_credits mc JOIN people p ON p.id = mc.person_id
      JOIN ${table} m ON m.id = mc.media_id
      WHERE mc.media_type = '${mt}' AND ${creditFilter} AND ${available} AND lower(p.name) LIKE ?
      GROUP BY p.id ORDER BY count DESC, p.name LIMIT ?`).all(like, limit)
  })() as Array<{ value: string; count: number }>
  return rows.map(row => ({ value: String(row.value), count: Number(row.count) }))
}
