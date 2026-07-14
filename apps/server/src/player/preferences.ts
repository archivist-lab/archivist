import type {
  PlayerPreferencesEnvelope,
  PlayerPreferencesV1,
  PlayerPreset,
  PlayerView,
  PlayerWidgetLimit,
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
const SOURCES = new Set<PlayerWidgetSource>(['continue', 'recent-films', 'recent-episodes', 'downloading', 'unwatched-films', 'films-az', 'series-az'])
const LIMITS = new Set<PlayerWidgetLimit>([6, 12, 18, 24, 36, 60])
const SORTS = new Set(['title', 'added', 'year', 'rating'])
const LUFS = new Set([-14, -16, -18, -23])
const TEXT_SCALE = new Set([1, 1.15, 1.3])
const PROFILE = 'default'

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

const baseWidgets: PlayerPreferencesV1['home']['widgets'] = [
  { id: 'continue', title: 'Continue Watching', source: 'continue', view: 'landscape', limit: 12, enabled: true },
  { id: 'recent-films', title: 'Recently Added Films', source: 'recent-films', view: 'poster', limit: 18, enabled: true },
  { id: 'recent-episodes', title: 'New Episodes', source: 'recent-episodes', view: 'landscape', limit: 18, enabled: true },
  { id: 'downloading', title: 'Downloading', source: 'downloading', view: 'poster', limit: 12, enabled: true },
]

export function preferencesForPreset(preset: PlayerPreset): PlayerPreferencesV1 {
  const matrix = {
    classic: { edgeRail: 'visible' as const, widgetMode: 'stacked' as const, showSpotlight: false },
    categories: { edgeRail: 'visible' as const, widgetMode: 'stacked' as const, showSpotlight: true },
    compound: { edgeRail: 'minimized' as const, widgetMode: 'stacked' as const, showSpotlight: true },
    combined: { edgeRail: 'minimized' as const, widgetMode: 'combined' as const, showSpotlight: true },
  }[preset]
  return {
    schemaVersion: 1,
    preset,
    navigation: { edgeRail: matrix.edgeRail, showClock: true },
    home: { widgetMode: matrix.widgetMode, showSpotlight: matrix.showSpotlight, widgets: structuredClone(baseWidgets) },
    libraries: {
      films: { view: 'poster', sort: 'title', hideUnavailable: false },
      series: { view: 'poster', sort: 'title', hideUnavailable: false },
    },
    playback: {
      normalizeVolume: true,
      targetLufs: -16,
      preferredAudioLanguage: null,
      preferredSubtitleLanguage: null,
      subtitles: 'forced',
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

function language(value: unknown, path: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-z]{2}$/.test(value)) throw new PlayerPreferencesValidationError('must be null or a lowercase ISO 639-1 code', path)
  return value
}

export function validatePlayerPreferences(input: unknown): PlayerPreferencesV1 {
  const root = object(input, '$')
  exactKeys(root, ['schemaVersion', 'preset', 'navigation', 'home', 'libraries', 'playback', 'accessibility', 'migration'], '$')
  if (root.schemaVersion !== 1) throw new PlayerPreferencesValidationError('must equal 1', '$.schemaVersion')
  if (!PRESETS.has(root.preset as PlayerPreset)) throw new PlayerPreferencesValidationError('invalid preset', '$.preset')

  const navigation = object(root.navigation, '$.navigation')
  exactKeys(navigation, ['edgeRail', 'showClock'], '$.navigation')
  if (!['minimized', 'visible'].includes(String(navigation.edgeRail))) throw new PlayerPreferencesValidationError('invalid edge rail', '$.navigation.edgeRail')
  if (typeof navigation.showClock !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.navigation.showClock')

  const home = object(root.home, '$.home')
  exactKeys(home, ['widgetMode', 'showSpotlight', 'widgets'], '$.home')
  if (!['stacked', 'combined'].includes(String(home.widgetMode))) throw new PlayerPreferencesValidationError('invalid widget mode', '$.home.widgetMode')
  if (typeof home.showSpotlight !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.home.showSpotlight')
  if (!Array.isArray(home.widgets) || home.widgets.length < 1 || home.widgets.length > 12) throw new PlayerPreferencesValidationError('must contain 1 to 12 widgets', '$.home.widgets')
  const ids = new Set<string>()
  let enabled = 0
  const widgets = home.widgets.map((raw, index) => {
    const path = `$.home.widgets[${index}]`
    const widget = object(raw, path)
    exactKeys(widget, ['id', 'title', 'source', 'view', 'limit', 'enabled'], path)
    if (typeof widget.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(widget.id) || ids.has(widget.id)) throw new PlayerPreferencesValidationError('must be a unique lowercase identifier', `${path}.id`)
    ids.add(widget.id)
    if (typeof widget.title !== 'string') throw new PlayerPreferencesValidationError('must be a string', `${path}.title`)
    const title = widget.title.normalize('NFC').trim()
    if ([...title].length < 1 || [...title].length > 48 || /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(title)) throw new PlayerPreferencesValidationError('must be 1 to 48 safe characters', `${path}.title`)
    if (!SOURCES.has(widget.source as PlayerWidgetSource)) throw new PlayerPreferencesValidationError('invalid source', `${path}.source`)
    if (!VIEWS.has(widget.view as PlayerView)) throw new PlayerPreferencesValidationError('invalid view', `${path}.view`)
    if (!LIMITS.has(widget.limit as PlayerWidgetLimit)) throw new PlayerPreferencesValidationError('invalid limit', `${path}.limit`)
    if (typeof widget.enabled !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', `${path}.enabled`)
    if (widget.enabled) enabled++
    return { id: widget.id, title, source: widget.source, view: widget.view, limit: widget.limit, enabled: widget.enabled }
  })
  if (!enabled) throw new PlayerPreferencesValidationError('at least one widget must be enabled', '$.home.widgets')

  const libraries = object(root.libraries, '$.libraries')
  exactKeys(libraries, ['films', 'series'], '$.libraries')
  const parseLibrary = (value: unknown, path: string) => {
    const lib = object(value, path)
    exactKeys(lib, ['view', 'sort', 'hideUnavailable'], path)
    if (!VIEWS.has(lib.view as PlayerView)) throw new PlayerPreferencesValidationError('invalid view', `${path}.view`)
    if (!SORTS.has(String(lib.sort))) throw new PlayerPreferencesValidationError('invalid sort', `${path}.sort`)
    if (typeof lib.hideUnavailable !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', `${path}.hideUnavailable`)
    return { view: lib.view, sort: lib.sort, hideUnavailable: lib.hideUnavailable }
  }

  const playback = object(root.playback, '$.playback')
  exactKeys(playback, ['normalizeVolume', 'targetLufs', 'preferredAudioLanguage', 'preferredSubtitleLanguage', 'subtitles'], '$.playback')
  if (typeof playback.normalizeVolume !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.playback.normalizeVolume')
  if (!LUFS.has(playback.targetLufs as number)) throw new PlayerPreferencesValidationError('invalid target LUFS', '$.playback.targetLufs')
  if (!['off', 'forced', 'preferred'].includes(String(playback.subtitles))) throw new PlayerPreferencesValidationError('invalid subtitle mode', '$.playback.subtitles')

  const accessibility = object(root.accessibility, '$.accessibility')
  exactKeys(accessibility, ['reducedMotion', 'highContrast', 'textScale'], '$.accessibility')
  if (!['system', 'on', 'off'].includes(String(accessibility.reducedMotion))) throw new PlayerPreferencesValidationError('invalid reduced motion mode', '$.accessibility.reducedMotion')
  if (typeof accessibility.highContrast !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.accessibility.highContrast')
  if (!TEXT_SCALE.has(accessibility.textScale as number)) throw new PlayerPreferencesValidationError('invalid text scale', '$.accessibility.textScale')

  const migration = object(root.migration, '$.migration')
  exactKeys(migration, ['legacyLocalStorageImported'], '$.migration')
  if (typeof migration.legacyLocalStorageImported !== 'boolean') throw new PlayerPreferencesValidationError('must be boolean', '$.migration.legacyLocalStorageImported')

  const validated = {
    schemaVersion: 1,
    preset: root.preset,
    navigation: { edgeRail: navigation.edgeRail, showClock: navigation.showClock },
    home: { widgetMode: home.widgetMode, showSpotlight: home.showSpotlight, widgets },
    libraries: { films: parseLibrary(libraries.films, '$.libraries.films'), series: parseLibrary(libraries.series, '$.libraries.series') },
    playback: {
      normalizeVolume: playback.normalizeVolume,
      targetLufs: playback.targetLufs,
      preferredAudioLanguage: language(playback.preferredAudioLanguage, '$.playback.preferredAudioLanguage'),
      preferredSubtitleLanguage: language(playback.preferredSubtitleLanguage, '$.playback.preferredSubtitleLanguage'),
      subtitles: playback.subtitles,
    },
    accessibility: { reducedMotion: accessibility.reducedMotion, highContrast: accessibility.highContrast, textScale: accessibility.textScale },
    migration: { legacyLocalStorageImported: migration.legacyLocalStorageImported },
  } as PlayerPreferencesV1
  if (Buffer.byteLength(JSON.stringify(validated), 'utf8') > 32 * 1024) throw new PlayerPreferencesValidationError('document exceeds 32 KiB')
  return validated
}

function rowEnvelope(row: { profile_id: string; revision: number; updated_at: string; document: string }): PlayerPreferencesEnvelope {
  return { profileId: row.profile_id, revision: row.revision, updatedAt: row.updated_at, preferences: validatePlayerPreferences(JSON.parse(row.document)) }
}

export function getPlayerPreferences(profileId: string): PlayerPreferencesEnvelope {
  if (profileId !== PROFILE) throw new PlayerPreferencesValidationError('profileId must equal default', '$.profileId')
  const db = getDb()
  const defaults = preferencesForPreset(getPlayerConfig(process.env).defaultPreset)
  db.prepare(`INSERT OR IGNORE INTO player_preferences (profile_id, schema_version, revision, document) VALUES (?, 1, 1, ?)`).run(profileId, JSON.stringify(defaults))
  const row = db.prepare('SELECT profile_id, revision, updated_at, document FROM player_preferences WHERE profile_id = ?').get(profileId) as { profile_id: string; revision: number; updated_at: string; document: string }
  return rowEnvelope(row)
}

function write(profileId: string, expectedRevision: number, preferences: PlayerPreferencesV1, action: 'saved' | 'reset'): PlayerPreferencesEnvelope {
  if (profileId !== PROFILE) throw new PlayerPreferencesValidationError('profileId must equal default', '$.profileId')
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new PlayerPreferencesValidationError('must be a positive integer', '$.expectedRevision')
  const validated = validatePlayerPreferences(preferences)
  const db = getDb()
  const transaction = db.transaction(() => {
    const current = getPlayerPreferences(profileId)
    if (current.revision !== expectedRevision) throw new PlayerPreferencesConflictError(current)
    db.prepare(`UPDATE player_preferences SET document = ?, revision = revision + 1, updated_at = datetime('now') WHERE profile_id = ? AND revision = ?`).run(JSON.stringify(validated), profileId, expectedRevision)
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
