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
}

export const DEFAULT_SEGMENT_SETTINGS: SegmentSettings = {
  enabled: false,
  concurrency: 1,
  introWindowSeconds: 12 * 60,
  creditsWindowSeconds: 10 * 60,
  minimumMatchSeconds: 15,
  confidenceThreshold: 0.72,
  maxAttempts: 3,
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
  })
  return getSegmentSettings()
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
