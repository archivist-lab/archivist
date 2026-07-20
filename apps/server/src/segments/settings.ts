import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

const require = createRequire(import.meta.url)
let probeFfmpegPath = 'ffmpeg'
try { probeFfmpegPath = require('ffmpeg-static') as string } catch {}

export interface SegmentSettings {
  enabled: boolean
  concurrency: number
  introWindowSeconds: number
  creditsWindowSeconds: number
  minimumMatchSeconds: number
  confidenceThreshold: number
  maxAttempts: number
  preferredLanguage: string
  seasonSupportRatio: number
  refineWithSilence: boolean
  refineWithBlackFrames: boolean
}

export const DEFAULT_SEGMENT_SETTINGS: SegmentSettings = {
  enabled: false,
  concurrency: 1,
  introWindowSeconds: 12 * 60,
  creditsWindowSeconds: 10 * 60,
  minimumMatchSeconds: 15,
  confidenceThreshold: 0.72,
  maxAttempts: 3,
  preferredLanguage: 'eng',
  seasonSupportRatio: 0.5,
  refineWithSilence: true,
  refineWithBlackFrames: true,
}

const boolEnv = (value: string | undefined): boolean | undefined => {
  if (value == null) return undefined
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  return undefined
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function getSegmentSettings(): SegmentSettings {
  const stored = getAppSetting<Partial<SegmentSettings>>('skipIntro', {}, 0, getDb())
  const enabledByEnv = boolEnv(process.env.ARCHIVIST_SKIP_INTRO_ENABLED)
  const concurrencyEnv = Number(process.env.ARCHIVIST_SEGMENT_CONCURRENCY)
  return {
    // The environment value is a boot default. Once Manager has stored an
    // explicit choice, that choice remains authoritative.
    enabled: typeof stored.enabled === 'boolean'
      ? stored.enabled
      : (enabledByEnv ?? DEFAULT_SEGMENT_SETTINGS.enabled),
    concurrency: Math.floor(clamp(
      Number.isFinite(concurrencyEnv) ? concurrencyEnv : stored.concurrency,
      1, Math.max(1, Math.min(4, os.cpus().length - 1)), DEFAULT_SEGMENT_SETTINGS.concurrency,
    )),
    introWindowSeconds: Math.floor(clamp(stored.introWindowSeconds, 120, 1800, DEFAULT_SEGMENT_SETTINGS.introWindowSeconds)),
    creditsWindowSeconds: Math.floor(clamp(stored.creditsWindowSeconds, 120, 1800, DEFAULT_SEGMENT_SETTINGS.creditsWindowSeconds)),
    minimumMatchSeconds: clamp(stored.minimumMatchSeconds, 6, 60, DEFAULT_SEGMENT_SETTINGS.minimumMatchSeconds),
    confidenceThreshold: clamp(stored.confidenceThreshold, 0.5, 0.98, DEFAULT_SEGMENT_SETTINGS.confidenceThreshold),
    maxAttempts: Math.floor(clamp(stored.maxAttempts, 1, 10, DEFAULT_SEGMENT_SETTINGS.maxAttempts)),
    preferredLanguage: String(stored.preferredLanguage || DEFAULT_SEGMENT_SETTINGS.preferredLanguage).trim().toLowerCase().slice(0, 3),
    seasonSupportRatio: clamp(stored.seasonSupportRatio, 0.3, 1, DEFAULT_SEGMENT_SETTINGS.seasonSupportRatio),
    refineWithSilence: typeof stored.refineWithSilence === 'boolean' ? stored.refineWithSilence : DEFAULT_SEGMENT_SETTINGS.refineWithSilence,
    refineWithBlackFrames: typeof stored.refineWithBlackFrames === 'boolean' ? stored.refineWithBlackFrames : DEFAULT_SEGMENT_SETTINGS.refineWithBlackFrames,
  }
}

export function updateSegmentSettings(input: Partial<SegmentSettings>): SegmentSettings {
  const current = getSegmentSettings()
  const next = { ...current, ...input }
  // Persist only the validated effective shape. After this explicit Manager
  // choice exists, it remains authoritative over the boot-time environment default.
  setAppSetting('skipIntro', {
    enabled: Boolean(next.enabled),
    concurrency: Math.floor(clamp(next.concurrency, 1, 4, current.concurrency)),
    introWindowSeconds: Math.floor(clamp(next.introWindowSeconds, 120, 1800, current.introWindowSeconds)),
    creditsWindowSeconds: Math.floor(clamp(next.creditsWindowSeconds, 120, 1800, current.creditsWindowSeconds)),
    minimumMatchSeconds: clamp(next.minimumMatchSeconds, 6, 60, current.minimumMatchSeconds),
    confidenceThreshold: clamp(next.confidenceThreshold, 0.5, 0.98, current.confidenceThreshold),
    maxAttempts: Math.floor(clamp(next.maxAttempts, 1, 10, current.maxAttempts)),
    preferredLanguage: String(next.preferredLanguage || current.preferredLanguage).trim().toLowerCase().slice(0, 3),
    seasonSupportRatio: clamp(next.seasonSupportRatio, 0.3, 1, current.seasonSupportRatio),
    refineWithSilence: Boolean(next.refineWithSilence),
    refineWithBlackFrames: Boolean(next.refineWithBlackFrames),
  })
  return getSegmentSettings()
}

const SEASON_FIELDS: Array<keyof SegmentSettings> = [
  'introWindowSeconds', 'creditsWindowSeconds', 'minimumMatchSeconds', 'confidenceThreshold',
  'preferredLanguage', 'seasonSupportRatio', 'refineWithSilence', 'refineWithBlackFrames',
]

export function getSeasonSegmentSettings(seriesId: number, seasonNumber: number): SegmentSettings {
  const global = getSegmentSettings()
  const row = getDb().prepare('SELECT config FROM media_segment_overrides WHERE series_id = ? AND season_number = ?').get(seriesId, seasonNumber) as { config: string } | undefined
  if (!row) return global
  let stored: Partial<SegmentSettings> = {}
  try { stored = JSON.parse(row.config) } catch {}
  const selected = Object.fromEntries(SEASON_FIELDS.filter(field => stored[field] !== undefined).map(field => [field, stored[field]])) as Partial<SegmentSettings>
  const merged = { ...global, ...selected }
  return {
    ...global,
    introWindowSeconds: Math.floor(clamp(merged.introWindowSeconds, 120, 1800, global.introWindowSeconds)),
    creditsWindowSeconds: Math.floor(clamp(merged.creditsWindowSeconds, 120, 1800, global.creditsWindowSeconds)),
    minimumMatchSeconds: clamp(merged.minimumMatchSeconds, 6, 60, global.minimumMatchSeconds),
    confidenceThreshold: clamp(merged.confidenceThreshold, 0.5, 0.98, global.confidenceThreshold),
    preferredLanguage: String(merged.preferredLanguage || global.preferredLanguage).trim().toLowerCase().slice(0, 3),
    seasonSupportRatio: clamp(merged.seasonSupportRatio, 0.3, 1, global.seasonSupportRatio),
    refineWithSilence: Boolean(merged.refineWithSilence),
    refineWithBlackFrames: Boolean(merged.refineWithBlackFrames),
  }
}

export function updateSeasonSegmentSettings(seriesId: number, seasonNumber: number, input: Partial<SegmentSettings> | null): SegmentSettings {
  const db = getDb()
  if (input === null) db.prepare('DELETE FROM media_segment_overrides WHERE series_id = ? AND season_number = ?').run(seriesId, seasonNumber)
  else {
    const current = getSeasonSegmentSettings(seriesId, seasonNumber)
    const selected = Object.fromEntries(SEASON_FIELDS.filter(field => input[field] !== undefined).map(field => [field, input[field]]))
    const validated = getSeasonSegmentSettingsFromValues({ ...current, ...selected }, current)
    const stored = Object.fromEntries(SEASON_FIELDS.map(field => [field, validated[field]]))
    db.prepare(`INSERT INTO media_segment_overrides (series_id, season_number, config, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(series_id, season_number) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`).run(seriesId, seasonNumber, JSON.stringify(stored))
  }
  return getSeasonSegmentSettings(seriesId, seasonNumber)
}

function getSeasonSegmentSettingsFromValues(merged: SegmentSettings, fallback: SegmentSettings): SegmentSettings {
  return {
    ...fallback,
    introWindowSeconds: Math.floor(clamp(merged.introWindowSeconds, 120, 1800, fallback.introWindowSeconds)),
    creditsWindowSeconds: Math.floor(clamp(merged.creditsWindowSeconds, 120, 1800, fallback.creditsWindowSeconds)),
    minimumMatchSeconds: clamp(merged.minimumMatchSeconds, 6, 60, fallback.minimumMatchSeconds),
    confidenceThreshold: clamp(merged.confidenceThreshold, 0.5, 0.98, fallback.confidenceThreshold),
    preferredLanguage: String(merged.preferredLanguage || fallback.preferredLanguage).trim().toLowerCase().slice(0, 3),
    seasonSupportRatio: clamp(merged.seasonSupportRatio, 0.3, 1, fallback.seasonSupportRatio),
    refineWithSilence: Boolean(merged.refineWithSilence),
    refineWithBlackFrames: Boolean(merged.refineWithBlackFrames),
  }
}

let availabilityCache: { checkedAt: number; fpcalc: boolean; fpcalcVersion: string | null; ffmpeg: boolean } | null = null
export function segmentToolAvailability(force = false) {
  if (!force && availabilityCache && Date.now() - availabilityCache.checkedAt < 60_000) return availabilityCache
  const fpcalc = spawnSync(process.env.ARCHIVIST_FPCALC_PATH ?? 'fpcalc', ['-version'], { encoding: 'utf8' })
  const ffmpeg = spawnSync(process.env.ARCHIVIST_FFMPEG_PATH ?? probeFfmpegPath, ['-version'], { stdio: 'ignore' })
  const versionOutput = `${fpcalc.stdout ?? ''}\n${fpcalc.stderr ?? ''}`.trim().split(/\r?\n/)[0] || null
  availabilityCache = {
    checkedAt: Date.now(), fpcalc: !fpcalc.error && fpcalc.status === 0,
    fpcalcVersion: versionOutput, ffmpeg: !ffmpeg.error && ffmpeg.status === 0,
  }
  return availabilityCache
}
