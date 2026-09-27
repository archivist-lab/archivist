import type { SessionSettings } from '@torrentstack/types'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

/**
 * How many torrents Archivist downloads at once, overall and per media type.
 *
 * Per-type limits are independent pools rather than slices of the overall
 * number: a type with its own limit never draws on the shared pool, and the
 * shared pool only governs the types left unconfigured. Setting films to 3 and
 * leaving the overall limit at 3 therefore means three films *and* three of
 * everything else, which is what "add a series and it downloads too" asks for.
 */

/** Media types that reach the download client, in the order the UI lists them. */
export const QUEUE_MEDIA_TYPES = ['films', 'series', 'music', 'books', 'comics', 'games'] as const

export type QueueMediaType = typeof QUEUE_MEDIA_TYPES[number]

/** Torrents are tagged with this label when handed to the engine. */
export function queueLabelFor(mediaType: QueueMediaType): string {
  return `archivist-${mediaType}`
}

export interface DownloadQueueSettings {
  /** When false the engine starts everything at once and no limit applies. */
  enabled: boolean
  /** Slots shared by every media type without a limit of its own. */
  globalLimit: number
  /** Per-type slots. An absent or null entry leaves that type on the shared pool. */
  perType: Partial<Record<QueueMediaType, number | null>>
}

export const DEFAULT_DOWNLOAD_QUEUE_SETTINGS: DownloadQueueSettings = {
  enabled: true,
  globalLimit: 5,
  perType: {},
}

export const MAX_QUEUE_LIMIT = 50

const SETTINGS_KEY = 'downloadQueue'

function clampLimit(value: unknown): number | null {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(MAX_QUEUE_LIMIT, n)
}

/** Coerce anything stored or posted into a settings object that is safe to apply. */
export function normaliseDownloadQueueSettings(input: unknown): DownloadQueueSettings {
  const raw = (input ?? {}) as Partial<DownloadQueueSettings>
  const perType: DownloadQueueSettings['perType'] = {}
  for (const mediaType of QUEUE_MEDIA_TYPES) {
    const limit = clampLimit(raw.perType?.[mediaType])
    if (limit !== null) perType[mediaType] = limit
  }
  return {
    enabled: raw.enabled !== false,
    globalLimit: clampLimit(raw.globalLimit) ?? DEFAULT_DOWNLOAD_QUEUE_SETTINGS.globalLimit,
    perType,
  }
}

export function getDownloadQueueSettings(): DownloadQueueSettings {
  return normaliseDownloadQueueSettings(
    getAppSetting<Partial<DownloadQueueSettings>>(SETTINGS_KEY, DEFAULT_DOWNLOAD_QUEUE_SETTINGS, 0, getDb()),
  )
}

export function saveDownloadQueueSettings(input: unknown): DownloadQueueSettings {
  const settings = normaliseDownloadQueueSettings(input)
  setAppSetting(SETTINGS_KEY, settings, 0, getDb())
  return settings
}

/** Translate the stored settings into the label-keyed shape the engine expects. */
export function toSessionQueueSettings(settings: DownloadQueueSettings): Partial<SessionSettings> {
  const downloadQueuePools: Record<string, number> = {}
  for (const mediaType of QUEUE_MEDIA_TYPES) {
    const limit = settings.perType[mediaType]
    if (typeof limit === 'number') downloadQueuePools[queueLabelFor(mediaType)] = limit
  }
  return {
    downloadQueueEnabled: settings.enabled,
    downloadQueueSize: settings.globalLimit,
    downloadQueuePools,
  }
}
