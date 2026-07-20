import type {
  PlayerAutoscrollInterval,
  PlayerBrowseContentType,
  PlayerBrowseFilter,
  PlayerDetailAction,
  PlayerDetailRow,
  PlayerFilterableContentType,
  PlayerHubLayout,
  PlayerHubPreference,
  PlayerPreferencesEnvelope,
  PlayerPreferencesV2,
  PlayerSavedFilter,
  PlayerPreset,
  PlayerRatingProvider,
  PlayerSortOrder,
  PlayerView,
  PlayerWidgetLimit,
  PlayerWidgetPreference,
  PlayerWidgetSort,
  PlayerWidgetSource,
  ResetPlayerPreferencesRequest,
  UpdatePlayerPreferencesRequest,
} from '@archivist/contracts'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { getPlayerConfig } from './config.js'

const logger = createLogger('PlayerPreferences')
const PRESETS = new Set<PlayerPreset>(['classic', 'categories', 'compound', 'combined'])
const VIEWS = new Set<PlayerView>(['poster', 'landscape', 'wall', 'list'])
const LAYOUTS = new Set<PlayerHubLayout>(['standard', 'combined', 'wall'])
const SOURCES = new Set<PlayerWidgetSource>([
  'continue', 'recent-films', 'recent-episodes', 'downloading', 'unwatched-films',
  'unwatched-series', 'unwatched-episodes', 'recently-played', 'top-rated-films',
  'top-rated-series', 'random-films', 'random-series', 'collections', 'saved-filter',
  'films-az', 'series-az',
])
const WIDGET_SORTS = new Set<PlayerWidgetSort>(['source', 'title', 'added', 'year', 'rating'])
const SORT_ORDERS = new Set<PlayerSortOrder>(['asc', 'desc'])
const LIMITS = new Set<PlayerWidgetLimit>([6, 12, 18, 24, 36, 60])
const AUTOSCROLL = new Set<PlayerAutoscrollInterval>([0, 5, 8, 10, 15, 20, 30])
const LIBRARY_SORTS = new Set(['title', 'added', 'year', 'rating'])
const CONTENT_TYPES = new Set<PlayerBrowseContentType>(['films', 'series', 'seasons', 'episodes', 'collections', 'people'])
const FILTERABLE_TYPES = new Set<PlayerFilterableContentType>(['films', 'series', 'episodes', 'collections'])
const AVAILABILITY = new Set(['all', 'available', 'unavailable'])
const WATCHED = new Set(['all', 'watched', 'unwatched', 'in-progress'])
const LUFS = new Set([-14, -16, -18, -23])
const TEXT_SCALE = new Set([1, 1.15, 1.3])
const DETAIL_ROWS = new Set<PlayerDetailRow>(['cast', 'crew', 'collection', 'gallery', 'recommendations', 'seasons', 'episodes'])
const RATING_PROVIDERS = new Set<PlayerRatingProvider>(['tmdb', 'imdb', 'trakt'])
const DETAIL_ACTIONS = new Set<PlayerDetailAction>(['play', 'trailer', 'mark-watched', 'information'])
const ARTWORK_BLUR = new Set([0, 8, 16, 24, 32])
const BACKDROP_CYCLE = new Set([0, 10, 20, 30])
const OSD_TIMEOUT = new Set([0, 3, 5, 8, 10])
const STILL_WATCHING = new Set([0, 60, 90, 120])
const DOWNLOAD_MEDIA_TYPES = new Set(['films', 'series', 'other'])
const RESERVED_HUB_IDS = new Set(['films', 'series', 'tv', 'search', 'settings'])
function profile(value: string): string {
  const id = value.normalize('NFC').trim()
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new PlayerPreferencesValidationError('must be a lowercase profile identifier', '$.profileId')
  return id
}

export class PlayerPreferencesValidationError extends Error {
  constructor(message: string, public readonly path = '$') {
    super(message)
    this.name = 'PlayerPreferencesValidationError'
  }
}

export class PlayerPreferencesConflictError extends Error {
  constructor(public readonly current: PlayerPreferencesEnvelope) {
    super('Player preferences were changed by another client')
    this.name = 'PlayerPreferencesConflictError'
  }
}

function defaultSortOrder(source: PlayerWidgetSource): PlayerSortOrder {
  return ['continue', 'recent-films', 'recent-episodes', 'downloading', 'recently-played', 'top-rated-films', 'top-rated-series'].includes(source) ? 'desc' : 'asc'
}

function widget(input: Pick<PlayerWidgetPreference, 'id' | 'title' | 'source' | 'view' | 'limit' | 'enabled'>): PlayerWidgetPreference {
  return { ...input, sort: 'source', sortOrder: defaultSortOrder(input.source), autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [] }
}

const baseWidgets: PlayerWidgetPreference[] = [
  widget({ id: 'continue', title: 'Continue Watching', source: 'continue', view: 'landscape', limit: 12, enabled: true }),
  widget({ id: 'recent-films', title: 'Recently Added Films', source: 'recent-films', view: 'poster', limit: 18, enabled: true }),
  widget({ id: 'recent-episodes', title: 'New Episodes', source: 'recent-episodes', view: 'landscape', limit: 18, enabled: true }),
  { ...widget({ id: 'downloading-films', title: 'Downloading Films', source: 'downloading', view: 'poster', limit: 12, enabled: true }), downloadMediaTypes: ['films'] },
  { ...widget({ id: 'downloading-series', title: 'Downloading Series', source: 'downloading', view: 'landscape', limit: 12, enabled: true }), downloadMediaTypes: ['series'] },
]

function homeHub(layout: PlayerHubLayout, showSpotlight: boolean): PlayerHubPreference {
  return {
    id: 'home',
    name: 'Home',
    icon: '⌂',
    enabled: true,
    layout,
    showSpotlight,
    spotlightWidgetId: null,
    widgets: structuredClone(baseWidgets),
  }
}

export function preferencesForPreset(preset: PlayerPreset): PlayerPreferencesV2 {
  // Preset names remain readable for one compatibility cycle, but all profiles
  // now receive the single Archivist museum composition.
  void preset
  return {
    schemaVersion: 5,
    preset: 'categories',
    navigation: { edgeRail: 'minimized', showClock: true },
    home: { hubs: [homeHub('standard', true)] },
    libraries: {
      films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: true },
      series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: true },
    },
    browsing: {
      defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' },
      savedFilters: [],
    },
    playback: {
      normalizeVolume: true,
      targetLufs: -16,
      preferredAudioLanguage: null,
      preferredSubtitleLanguage: null,
      subtitles: 'forced',
      osdTimeoutSeconds: 3,
      pauseBehavior: 'after-delay',
      timeDisplay: 'elapsed-total',
      stillWatchingMinutes: 0,
    },
    appearance: { accentColor: '#00d4ff', artworkBlur: 0, dialogTint: 'artwork', backdropCycleSeconds: 0 },
    details: {
      rows: ['cast', 'crew', 'collection', 'gallery', 'recommendations', 'seasons', 'episodes'],
      ratingSlots: ['tmdb', 'imdb'],
      primaryActions: ['play', 'trailer', 'mark-watched', 'information'],
    },
    accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 },
    migration: { legacyLocalStorageImported: false },
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export const DEFAULT_PLAYER_PREFERENCES = deepFreeze(preferencesForPreset('categories'))

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlayerPreferencesValidationError('must be an object', path)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) throw new PlayerPreferencesValidationError(`unknown key ${unknown[0]}`, `${path}.${unknown[0]}`)
  for (const key of keys) if (!(key in value)) throw new PlayerPreferencesValidationError('is required', `${path}.${key}`)
}

function safeText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new PlayerPreferencesValidationError('must be a string', path)
  const text = value.normalize('NFC').trim()
  if ([...text].length < 1 || [...text].length > max || /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(text)) {
    throw new PlayerPreferencesValidationError(`must be 1 to ${max} safe characters`, path)
  }
  return text
}

function language(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-z]{2}$/.test(value)) throw new PlayerPreferencesValidationError('must be null or a lowercase ISO 639-1 code', path)
  return value
}

/** Strictly upgrades the single-home schema without discarding a user's widget choices. */
function migrateSchemaOne(root: Record<string, unknown>): Record<string, unknown> {
  const legacyRoot = { ...root }
  delete legacyRoot.appearance
  delete legacyRoot.details
  exactKeys(legacyRoot, ['schemaVersion', 'preset', 'navigation', 'home', 'libraries', 'playback', 'accessibility', 'migration'], '$')
  const oldHome = object(root.home, '$.home')
  exactKeys(oldHome, ['widgetMode', 'showSpotlight', 'widgets'], '$.home')
  if (!Array.isArray(oldHome.widgets)) throw new PlayerPreferencesValidationError('must be an array', '$.home.widgets')
  const widgets = oldHome.widgets.map((raw, index) => {
    const path = `$.home.widgets[${index}]`
    const old = object(raw, path)
    exactKeys(old, ['id', 'title', 'source', 'view', 'limit', 'enabled'], path)
    return {
      id: old.id,
      title: old.title,
      source: old.source,
      view: old.view,
      sort: 'source',
      sortOrder: defaultSortOrder(old.source as PlayerWidgetSource),
      limit: old.limit,
      autoscrollSeconds: 0,
      enabled: old.enabled,
    }
  })
  return {
    schemaVersion: 2,
    preset: root.preset,
    navigation: root.navigation,
    home: { hubs: [{
      id: 'home',
      name: 'Home',
      icon: '⌂',
      enabled: true,
      layout: oldHome.widgetMode === 'combined' ? 'combined' : 'standard',
      showSpotlight: oldHome.showSpotlight,
      spotlightWidgetId: null,
      widgets,
    }] },
    libraries: root.libraries,
    playback: root.playback,
    accessibility: root.accessibility,
    migration: root.migration,
  }
}

/** Adds reusable browse state while retaining every schema-two hub and widget. */
function migrateSchemaTwo(root: Record<string, unknown>): Record<string, unknown> {
  const legacyRoot = { ...root }
  delete legacyRoot.appearance
  delete legacyRoot.details
  exactKeys(legacyRoot, ['schemaVersion', 'preset', 'navigation', 'home', 'libraries', 'playback', 'accessibility', 'migration'], '$')
  const home = object(root.home, '$.home')
  if (!Array.isArray(home.hubs)) throw new PlayerPreferencesValidationError('must be an array', '$.home.hubs')
  const hubs = home.hubs.map(rawHub => {
    const hub = object(rawHub, '$.home.hubs[]')
    const widgets = Array.isArray(hub.widgets)
      ? hub.widgets.map(rawWidget => ({ ...object(rawWidget, '$.home.hubs[].widgets[]'), savedFilterId: null }))
      : hub.widgets
    return { ...hub, widgets }
  })
  const libraries = object(root.libraries, '$.libraries')
  const withOrder = (raw: unknown) => {
    const library = object(raw, '$.libraries')
    return { ...library, sortOrder: library.sort === 'title' ? 'asc' : 'desc' }
  }
  return {
    ...legacyRoot,
    schemaVersion: 3,
    home: { hubs },
    libraries: { films: withOrder(libraries.films), series: withOrder(libraries.series) },
    browsing: {
      defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' },
      savedFilters: [],
    },
  }
}

/** Adds the visual, detail and OSD model without changing the user's existing layout. */
function migrateSchemaThree(root: Record<string, unknown>): Record<string, unknown> {
  exactKeys(root, ['schemaVersion', 'preset', 'navigation', 'home', 'libraries', 'browsing', 'playback', 'accessibility', 'migration'], '$')
  return {
    ...root,
    schemaVersion: 4,
    playback: {
      ...object(root.playback, '$.playback'),
      osdTimeoutSeconds: 3,
      pauseBehavior: 'after-delay',
      timeDisplay: 'elapsed-total',
      stillWatchingMinutes: 0,
    },
    appearance: { accentColor: '#00d4ff', artworkBlur: 0, dialogTint: 'artwork', backdropCycleSeconds: 0 },
    details: {
      rows: ['cast', 'crew', 'collection', 'gallery', 'recommendations', 'seasons', 'episodes'],
      ratingSlots: ['tmdb', 'imdb'],
      primaryActions: ['play', 'trailer', 'mark-watched', 'information'],
    },
  }
}

/** Defaults libraries to playable items and separates live film/series acquisitions. */
function migrateSchemaFour(root: Record<string, unknown>): Record<string, unknown> {
  exactKeys(root, ['schemaVersion', 'preset', 'navigation', 'home', 'libraries', 'browsing', 'playback', 'appearance', 'details', 'accessibility', 'migration'], '$')
  const home = object(root.home, '$.home')
  const hubs = Array.isArray(home.hubs) ? home.hubs.map(rawHub => {
    const hub = object(rawHub, '$.home.hubs[]')
    const widgets: Array<Record<string, unknown>> = Array.isArray(hub.widgets) ? hub.widgets.flatMap((rawWidget): Array<Record<string, unknown>> => {
      const existing = object(rawWidget, '$.home.hubs[].widgets[]')
      if (existing.source !== 'downloading') return [{ ...existing, downloadMediaTypes: [] as string[] }]
      return [
        { ...existing, id: `${String(existing.id).slice(0, 33)}-films`, title: 'Downloading Films', view: 'poster', downloadMediaTypes: ['films'] as string[] },
        { ...existing, id: `${String(existing.id).slice(0, 32)}-series`, title: 'Downloading Series', view: 'landscape', downloadMediaTypes: ['series'] as string[] },
      ]
    }) : []
    return { ...hub, spotlightWidgetId: hub.spotlightWidgetId && widgets.some((widget: any) => widget.id === hub.spotlightWidgetId) ? hub.spotlightWidgetId : null, widgets }
  }) : home.hubs
  const libraries = object(root.libraries, '$.libraries')
  return {
    ...root,
    schemaVersion: 5,
    home: { hubs },
    libraries: {
      films: { ...object(libraries.films, '$.libraries.films'), hideUnavailable: true },
      series: { ...object(libraries.series, '$.libraries.series'), hideUnavailable: true },
    },
  }
}

function enumArray<T extends string>(value: unknown, path: string, allowed: Set<T>, max: number): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new PlayerPreferencesValidationError(`must contain 1 to ${max} entries`, path)
  const result = value.map((entry, index) => {
    if (!allowed.has(entry as T)) throw new PlayerPreferencesValidationError('invalid value', `${path}[${index}]`)
    return entry as T
  })
  if (new Set(result).size !== result.length) throw new PlayerPreferencesValidationError('must not contain duplicates', path)
  return result
}

function parseWidget(raw: unknown, path: string): PlayerWidgetPreference {
  const value = object(raw, path)
  exactKeys(value, ['id', 'title', 'source', 'view', 'sort', 'sortOrder', 'limit', 'autoscrollSeconds', 'savedFilterId', 'downloadMediaTypes', 'enabled'], path)
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value.id)) throw new PlayerPreferencesValidationError('must be a lowercase identifier', `${path}.id`)
  const title = safeText(value.title, `${path}.title`, 48)
  if (!SOURCES.has(value.source as PlayerWidgetSource)) throw new PlayerPreferencesValidationError('invalid source', `${path}.source`)
  if (!VIEWS.has(value.view as PlayerView)) throw new PlayerPreferencesValidationError('invalid view', `${path}.view`)
  if (!WIDGET_SORTS.has(value.sort as PlayerWidgetSort)) throw new PlayerPreferencesValidationError('invalid sort', `${path}.sort`)
  if (!SORT_ORDERS.has(value.sortOrder as PlayerSortOrder)) throw new PlayerPreferencesValidationError('invalid sort order', `${path}.sortOrder`)
  if (!LIMITS.has(value.limit as PlayerWidgetLimit)) throw new PlayerPreferencesValidationError('invalid limit', `${path}.limit`)
  if (!AUTOSCROLL.has(value.autoscrollSeconds as PlayerAutoscrollInterval)) throw new PlayerPreferencesValidationError('invalid autoscroll interval', `${path}.autoscrollSeconds`)
  if (value.savedFilterId !== null && (typeof value.savedFilterId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value.savedFilterId))) {
    throw new PlayerPreferencesValidationError('must be a lowercase identifier or null', `${path}.savedFilterId`)
  }
  if (value.source === 'saved-filter' && value.savedFilterId === null) throw new PlayerPreferencesValidationError('is required for saved-filter widgets', `${path}.savedFilterId`)
  if (value.source !== 'saved-filter' && value.savedFilterId !== null) throw new PlayerPreferencesValidationError('must be null unless source is saved-filter', `${path}.savedFilterId`)
  const downloadMediaTypes = Array.isArray(value.downloadMediaTypes)
    ? value.downloadMediaTypes.map((entry, index) => {
        if (!DOWNLOAD_MEDIA_TYPES.has(String(entry))) throw new PlayerPreferencesValidationError('invalid download media type', `${path}.downloadMediaTypes[${index}]`)
        return entry as 'films' | 'series' | 'other'
      })
    : []
  if (new Set(downloadMediaTypes).size !== downloadMediaTypes.length) throw new PlayerPreferencesValidationError('must not contain duplicates', `${path}.downloadMediaTypes`)
  if (value.source === 'downloading' && downloadMediaTypes.length < 1) throw new PlayerPreferencesValidationError('must select at least one download media type', `${path}.downloadMediaTypes`)
  if (value.source !== 'downloading' && downloadMediaTypes.length) throw new PlayerPreferencesValidationError('must be empty unless source is downloading', `${path}.downloadMediaTypes`)
  if (typeof value.enabled !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', `${path}.enabled`)
  return {
    id: value.id,
    title,
    source: value.source,
    view: value.view,
    sort: value.sort,
    sortOrder: value.sortOrder,
    limit: value.limit,
    autoscrollSeconds: value.autoscrollSeconds,
    savedFilterId: value.savedFilterId,
    downloadMediaTypes,
    enabled: value.enabled,
  } as PlayerWidgetPreference
}

function nullableInteger(value: unknown, path: string, min: number, max: number): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new PlayerPreferencesValidationError(`must be null or an integer from ${min} to ${max}`, path)
  return Number(value)
}

function textArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new PlayerPreferencesValidationError('must be an array with at most 20 entries', path)
  const result = value.map((entry, index) => safeText(entry, `${path}[${index}]`, 48))
  if (new Set(result.map(entry => entry.toLocaleLowerCase())).size !== result.length) throw new PlayerPreferencesValidationError('must not contain duplicates', path)
  return result
}

function parseFilter(raw: unknown, path: string): PlayerBrowseFilter {
  const value = object(raw, path)
  exactKeys(value, ['query', 'genres', 'yearFrom', 'yearTo', 'studios', 'ratingMin', 'availability', 'watched', 'alphabet', 'collectionId'], path)
  if (typeof value.query !== 'string' || [...value.query].length > 120 || /[\p{Cc}]/u.test(value.query)) throw new PlayerPreferencesValidationError('must be at most 120 safe characters', `${path}.query`)
  const yearFrom = nullableInteger(value.yearFrom, `${path}.yearFrom`, 1870, 2200)
  const yearTo = nullableInteger(value.yearTo, `${path}.yearTo`, 1870, 2200)
  if (yearFrom !== null && yearTo !== null && yearFrom > yearTo) throw new PlayerPreferencesValidationError('must not exceed yearTo', `${path}.yearFrom`)
  if (value.ratingMin !== null && (typeof value.ratingMin !== 'number' || value.ratingMin < 0 || value.ratingMin > 10)) throw new PlayerPreferencesValidationError('must be null or a number from 0 to 10', `${path}.ratingMin`)
  if (!AVAILABILITY.has(String(value.availability))) throw new PlayerPreferencesValidationError('invalid availability', `${path}.availability`)
  if (!WATCHED.has(String(value.watched))) throw new PlayerPreferencesValidationError('invalid watched state', `${path}.watched`)
  if (value.alphabet !== null && (typeof value.alphabet !== 'string' || !/^(#|[A-Z])$/.test(value.alphabet))) throw new PlayerPreferencesValidationError('must be null, #, or A-Z', `${path}.alphabet`)
  return {
    query: value.query.normalize('NFC').trim(),
    genres: textArray(value.genres, `${path}.genres`),
    yearFrom,
    yearTo,
    studios: textArray(value.studios, `${path}.studios`),
    ratingMin: value.ratingMin === null ? null : Number(value.ratingMin),
    availability: value.availability,
    watched: value.watched,
    alphabet: value.alphabet,
    collectionId: nullableInteger(value.collectionId, `${path}.collectionId`, 1, Number.MAX_SAFE_INTEGER),
  } as PlayerBrowseFilter
}

function parseSavedFilter(raw: unknown, index: number, ids: Set<string>): PlayerSavedFilter {
  const path = `$.browsing.savedFilters[${index}]`
  const value = object(raw, path)
  exactKeys(value, ['id', 'name', 'mediaType', 'filters', 'view', 'sort', 'sortOrder'], path)
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value.id) || ids.has(value.id)) throw new PlayerPreferencesValidationError('must be a unique lowercase identifier', `${path}.id`)
  ids.add(value.id)
  if (!FILTERABLE_TYPES.has(value.mediaType as PlayerFilterableContentType)) throw new PlayerPreferencesValidationError('invalid media type', `${path}.mediaType`)
  if (!VIEWS.has(value.view as PlayerView)) throw new PlayerPreferencesValidationError('invalid view', `${path}.view`)
  if (!LIBRARY_SORTS.has(String(value.sort))) throw new PlayerPreferencesValidationError('invalid sort', `${path}.sort`)
  if (!SORT_ORDERS.has(value.sortOrder as PlayerSortOrder)) throw new PlayerPreferencesValidationError('invalid sort order', `${path}.sortOrder`)
  return { id: value.id, name: safeText(value.name, `${path}.name`, 48), mediaType: value.mediaType, filters: parseFilter(value.filters, `${path}.filters`), view: value.view, sort: value.sort, sortOrder: value.sortOrder } as PlayerSavedFilter
}

function parseHub(raw: unknown, index: number, hubIds: Set<string>): PlayerHubPreference {
  const path = `$.home.hubs[${index}]`
  const value = object(raw, path)
  exactKeys(value, ['id', 'name', 'icon', 'enabled', 'layout', 'showSpotlight', 'spotlightWidgetId', 'widgets'], path)
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(value.id) || hubIds.has(value.id)) throw new PlayerPreferencesValidationError('must be a unique lowercase identifier', `${path}.id`)
  if (value.id !== 'home' && RESERVED_HUB_IDS.has(value.id)) throw new PlayerPreferencesValidationError('is reserved', `${path}.id`)
  hubIds.add(value.id)
  const name = safeText(value.name, `${path}.name`, 32)
  const icon = safeText(value.icon, `${path}.icon`, 8)
  if (typeof value.enabled !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', `${path}.enabled`)
  if (value.id === 'home' && value.enabled !== true) throw new PlayerPreferencesValidationError('Home must remain enabled', `${path}.enabled`)
  if (!LAYOUTS.has(value.layout as PlayerHubLayout)) throw new PlayerPreferencesValidationError('invalid layout', `${path}.layout`)
  if (typeof value.showSpotlight !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', `${path}.showSpotlight`)
  if (!Array.isArray(value.widgets) || value.widgets.length < 1 || value.widgets.length > 12) throw new PlayerPreferencesValidationError('must contain 1 to 12 widgets', `${path}.widgets`)
  const widgetIds = new Set<string>()
  const widgets = value.widgets.map((entry, widgetIndex) => {
    const parsed = parseWidget(entry, `${path}.widgets[${widgetIndex}]`)
    if (widgetIds.has(parsed.id)) throw new PlayerPreferencesValidationError('must be unique within its hub', `${path}.widgets[${widgetIndex}].id`)
    widgetIds.add(parsed.id)
    return parsed
  })
  if (!widgets.some(entry => entry.enabled)) throw new PlayerPreferencesValidationError('at least one widget must be enabled', `${path}.widgets`)
  if (value.spotlightWidgetId !== null && (typeof value.spotlightWidgetId !== 'string' || !widgets.some(entry => entry.id === value.spotlightWidgetId && entry.enabled))) {
    throw new PlayerPreferencesValidationError('must reference an enabled widget or be null', `${path}.spotlightWidgetId`)
  }
  return {
    id: value.id,
    name,
    icon,
    enabled: value.enabled,
    layout: value.layout,
    showSpotlight: value.showSpotlight,
    spotlightWidgetId: value.spotlightWidgetId,
    widgets,
  } as PlayerHubPreference
}

export function validatePlayerPreferences(input: unknown): PlayerPreferencesV2 {
  let root = object(input, '$')
  if (root.schemaVersion === 1) root = migrateSchemaOne(root)
  if (root.schemaVersion === 2) root = migrateSchemaTwo(root)
  if (root.schemaVersion === 3) root = migrateSchemaThree(root)
  if (root.schemaVersion === 4) root = migrateSchemaFour(root)
  exactKeys(root, ['schemaVersion', 'preset', 'navigation', 'home', 'libraries', 'browsing', 'playback', 'appearance', 'details', 'accessibility', 'migration'], '$')
  if (root.schemaVersion !== 5) throw new PlayerPreferencesValidationError('must equal 5', '$.schemaVersion')
  if (!PRESETS.has(root.preset as PlayerPreset)) throw new PlayerPreferencesValidationError('invalid preset', '$.preset')

  const navigation = object(root.navigation, '$.navigation')
  exactKeys(navigation, ['edgeRail', 'showClock'], '$.navigation')
  if (!['minimized', 'visible'].includes(String(navigation.edgeRail))) throw new PlayerPreferencesValidationError('invalid edge rail', '$.navigation.edgeRail')
  if (typeof navigation.showClock !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.navigation.showClock')

  const home = object(root.home, '$.home')
  exactKeys(home, ['hubs'], '$.home')
  if (!Array.isArray(home.hubs) || home.hubs.length < 1 || home.hubs.length > 9) throw new PlayerPreferencesValidationError('must contain 1 to 9 hubs', '$.home.hubs')
  const hubIds = new Set<string>()
  const hubs = home.hubs.map((entry, index) => {
    const hub = parseHub(entry, index, hubIds)
    return { ...hub, layout: 'standard' as const, showSpotlight: true }
  })
  if (!hubs.some(hub => hub.id === 'home')) throw new PlayerPreferencesValidationError('must include the Home hub', '$.home.hubs')

  const libraries = object(root.libraries, '$.libraries')
  exactKeys(libraries, ['films', 'series'], '$.libraries')
  const parseLibrary = (value: unknown, path: string) => {
    const library = object(value, path)
    exactKeys(library, ['view', 'sort', 'sortOrder', 'hideUnavailable'], path)
    if (!VIEWS.has(library.view as PlayerView)) throw new PlayerPreferencesValidationError('invalid view', `${path}.view`)
    if (!LIBRARY_SORTS.has(String(library.sort))) throw new PlayerPreferencesValidationError('invalid sort', `${path}.sort`)
    if (!SORT_ORDERS.has(library.sortOrder as PlayerSortOrder)) throw new PlayerPreferencesValidationError('invalid sort order', `${path}.sortOrder`)
    if (typeof library.hideUnavailable !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', `${path}.hideUnavailable`)
    return { view: library.view, sort: library.sort, sortOrder: library.sortOrder, hideUnavailable: library.hideUnavailable }
  }

  const browsing = object(root.browsing, '$.browsing')
  exactKeys(browsing, ['defaultViews', 'savedFilters'], '$.browsing')
  const defaultViews = object(browsing.defaultViews, '$.browsing.defaultViews')
  exactKeys(defaultViews, [...CONTENT_TYPES], '$.browsing.defaultViews')
  for (const type of CONTENT_TYPES) if (!VIEWS.has(defaultViews[type] as PlayerView)) throw new PlayerPreferencesValidationError('invalid view', `$.browsing.defaultViews.${type}`)
  if (!Array.isArray(browsing.savedFilters) || browsing.savedFilters.length > 40) throw new PlayerPreferencesValidationError('must contain at most 40 saved filters', '$.browsing.savedFilters')
  const savedFilterIds = new Set<string>()
  const savedFilters = browsing.savedFilters.map((entry, index) => parseSavedFilter(entry, index, savedFilterIds))
  for (let hubIndex = 0; hubIndex < hubs.length; hubIndex++) {
    for (let widgetIndex = 0; widgetIndex < hubs[hubIndex].widgets.length; widgetIndex++) {
      const widget = hubs[hubIndex].widgets[widgetIndex]
      if (widget.savedFilterId && !savedFilterIds.has(widget.savedFilterId)) throw new PlayerPreferencesValidationError('must reference an existing saved filter', `$.home.hubs[${hubIndex}].widgets[${widgetIndex}].savedFilterId`)
    }
  }

  const playback = object(root.playback, '$.playback')
  exactKeys(playback, ['normalizeVolume', 'targetLufs', 'preferredAudioLanguage', 'preferredSubtitleLanguage', 'subtitles', 'osdTimeoutSeconds', 'pauseBehavior', 'timeDisplay', 'stillWatchingMinutes'], '$.playback')
  if (typeof playback.normalizeVolume !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.playback.normalizeVolume')
  if (!LUFS.has(playback.targetLufs as number)) throw new PlayerPreferencesValidationError('invalid target LUFS', '$.playback.targetLufs')
  if (!['off', 'forced', 'preferred'].includes(String(playback.subtitles))) throw new PlayerPreferencesValidationError('invalid subtitle mode', '$.playback.subtitles')
  if (!OSD_TIMEOUT.has(Number(playback.osdTimeoutSeconds))) throw new PlayerPreferencesValidationError('invalid OSD timeout', '$.playback.osdTimeoutSeconds')
  if (!['minimal', 'after-delay', 'always'].includes(String(playback.pauseBehavior))) throw new PlayerPreferencesValidationError('invalid pause behavior', '$.playback.pauseBehavior')
  if (!['elapsed-total', 'elapsed-remaining'].includes(String(playback.timeDisplay))) throw new PlayerPreferencesValidationError('invalid time display', '$.playback.timeDisplay')
  if (!STILL_WATCHING.has(Number(playback.stillWatchingMinutes))) throw new PlayerPreferencesValidationError('invalid Still Watching interval', '$.playback.stillWatchingMinutes')

  const appearance = object(root.appearance, '$.appearance')
  exactKeys(appearance, ['accentColor', 'artworkBlur', 'dialogTint', 'backdropCycleSeconds'], '$.appearance')
  if (typeof appearance.accentColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(appearance.accentColor)) throw new PlayerPreferencesValidationError('must be a six-digit hex colour', '$.appearance.accentColor')
  if (!ARTWORK_BLUR.has(Number(appearance.artworkBlur))) throw new PlayerPreferencesValidationError('invalid artwork blur', '$.appearance.artworkBlur')
  if (!['neutral', 'artwork'].includes(String(appearance.dialogTint))) throw new PlayerPreferencesValidationError('invalid dialog tint', '$.appearance.dialogTint')
  if (!BACKDROP_CYCLE.has(Number(appearance.backdropCycleSeconds))) throw new PlayerPreferencesValidationError('invalid backdrop cycle', '$.appearance.backdropCycleSeconds')

  const details = object(root.details, '$.details')
  exactKeys(details, ['rows', 'ratingSlots', 'primaryActions'], '$.details')
  const detailRows = enumArray(details.rows, '$.details.rows', DETAIL_ROWS, 7)
  const ratingSlots = enumArray(details.ratingSlots, '$.details.ratingSlots', RATING_PROVIDERS, 3)
  const primaryActions = enumArray(details.primaryActions, '$.details.primaryActions', DETAIL_ACTIONS, 4)

  const accessibility = object(root.accessibility, '$.accessibility')
  exactKeys(accessibility, ['reducedMotion', 'highContrast', 'textScale'], '$.accessibility')
  if (!['system', 'on', 'off'].includes(String(accessibility.reducedMotion))) throw new PlayerPreferencesValidationError('invalid reduced motion mode', '$.accessibility.reducedMotion')
  if (typeof accessibility.highContrast !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.accessibility.highContrast')
  if (!TEXT_SCALE.has(accessibility.textScale as number)) throw new PlayerPreferencesValidationError('invalid text scale', '$.accessibility.textScale')

  const migration = object(root.migration, '$.migration')
  exactKeys(migration, ['legacyLocalStorageImported'], '$.migration')
  if (typeof migration.legacyLocalStorageImported !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.migration.legacyLocalStorageImported')

  const validated = {
    schemaVersion: 5,
    preset: 'categories',
    navigation: { edgeRail: 'minimized', showClock: navigation.showClock },
    home: { hubs },
    libraries: { films: parseLibrary(libraries.films, '$.libraries.films'), series: parseLibrary(libraries.series, '$.libraries.series') },
    browsing: { defaultViews: defaultViews as PlayerPreferencesV2['browsing']['defaultViews'], savedFilters },
    playback: {
      normalizeVolume: playback.normalizeVolume,
      targetLufs: playback.targetLufs,
      preferredAudioLanguage: language(playback.preferredAudioLanguage, '$.playback.preferredAudioLanguage'),
      preferredSubtitleLanguage: language(playback.preferredSubtitleLanguage, '$.playback.preferredSubtitleLanguage'),
      subtitles: playback.subtitles,
      osdTimeoutSeconds: playback.osdTimeoutSeconds,
      pauseBehavior: playback.pauseBehavior,
      timeDisplay: playback.timeDisplay,
      stillWatchingMinutes: playback.stillWatchingMinutes,
    },
    appearance: { accentColor: '#00d4ff', artworkBlur: 0, dialogTint: 'artwork', backdropCycleSeconds: 0 },
    details: {
      rows: ['cast', 'crew', 'collection', 'gallery', 'recommendations', 'seasons', 'episodes'],
      ratingSlots: ['tmdb', 'imdb'],
      primaryActions: ['play', 'trailer', 'mark-watched', 'information'],
    },
    accessibility: { reducedMotion: accessibility.reducedMotion, highContrast: accessibility.highContrast, textScale: accessibility.textScale },
    migration: { legacyLocalStorageImported: migration.legacyLocalStorageImported },
  } as PlayerPreferencesV2
  if (Buffer.byteLength(JSON.stringify(validated), 'utf8') > 64 * 1024) throw new PlayerPreferencesValidationError('document exceeds 64 KiB')
  return validated
}

function rowEnvelope(row: { profile_id: string; revision: number; updated_at: string; document: string }): PlayerPreferencesEnvelope {
  return { profileId: row.profile_id, revision: row.revision, updatedAt: row.updated_at, preferences: validatePlayerPreferences(JSON.parse(row.document)) }
}

export function getPlayerPreferences(profileId: string): PlayerPreferencesEnvelope {
  profileId = profile(profileId)
  const db = getDb()
  const defaults = preferencesForPreset(getPlayerConfig(process.env).defaultPreset)
  db.prepare(`INSERT OR IGNORE INTO player_preferences (profile_id, schema_version, revision, document) VALUES (?, 5, 1, ?)`).run(profileId, JSON.stringify(defaults))
  const row = db.prepare('SELECT profile_id, revision, updated_at, document FROM player_preferences WHERE profile_id = ?').get(profileId) as { profile_id: string; revision: number; updated_at: string; document: string }
  const envelope = rowEnvelope(row)
  const canonicalDocument = JSON.stringify(envelope.preferences)
  if (row.document !== canonicalDocument) {
    db.prepare('UPDATE player_preferences SET schema_version = 5, document = ?, updated_at = datetime(\'now\') WHERE profile_id = ?').run(canonicalDocument, profileId)
    logger.info('Preferences migrated to the canonical Player composition', { profileId })
  }
  return envelope
}

function write(profileId: string, expectedRevision: number, preferences: PlayerPreferencesV2, action: 'saved' | 'reset'): PlayerPreferencesEnvelope {
  profileId = profile(profileId)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new PlayerPreferencesValidationError('must be a positive integer', '$.expectedRevision')
  const validated = validatePlayerPreferences(preferences)
  const db = getDb()
  const transaction = db.transaction(() => {
    const current = getPlayerPreferences(profileId)
    if (current.revision !== expectedRevision) throw new PlayerPreferencesConflictError(current)
    db.prepare(`UPDATE player_preferences SET schema_version = 5, document = ?, revision = revision + 1, updated_at = datetime('now') WHERE profile_id = ? AND revision = ?`).run(JSON.stringify(validated), profileId, expectedRevision)
    return rowEnvelope(db.prepare('SELECT profile_id, revision, updated_at, document FROM player_preferences WHERE profile_id = ?').get(profileId) as any)
  })
  const result = transaction.immediate()
  logger.info(`Preferences ${action}`, { profileId, oldRevision: expectedRevision, newRevision: result.revision, outcome: action })
  return result
}

export function updatePlayerPreferences(input: UpdatePlayerPreferencesRequest): PlayerPreferencesEnvelope {
  if (!input || typeof input !== 'object') throw new PlayerPreferencesValidationError('must be an object')
  return write(input.profileId, input.expectedRevision, input.preferences, 'saved')
}

export function resetPlayerPreferences(input: ResetPlayerPreferencesRequest): PlayerPreferencesEnvelope {
  if (!input || typeof input !== 'object') throw new PlayerPreferencesValidationError('must be an object')
  return write(input.profileId, input.expectedRevision, preferencesForPreset(getPlayerConfig(process.env).defaultPreset), 'reset')
}
