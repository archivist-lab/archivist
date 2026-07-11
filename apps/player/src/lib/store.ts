// Local state: connection, customization (home rails, library views), and
// watch progress. localStorage-backed with a tiny subscribe layer so React
// reads via useSyncExternalStore — no state library needed.

import { useSyncExternalStore } from 'react'
import type { Connection } from './sdk.js'

// ── Customization model (Arctic Fuse-inspired: rails are source × style) ─────

export type RailSource =
  | 'continue'          // local watch progress
  | 'recent-films'
  | 'recent-episodes'
  | 'downloading'
  | 'unwatched-films'
  | 'films-az'
  | 'series-az'

export type RailStyle = 'hero' | 'poster' | 'landscape'

export interface RailConfig {
  id: string
  source: RailSource
  style: RailStyle
  title: string
  limit: number
  enabled: boolean
}

export const RAIL_SOURCES: Record<RailSource, string> = {
  'continue': 'Continue Watching',
  'recent-films': 'Recently Added Films',
  'recent-episodes': 'New Episodes',
  'downloading': 'Downloading',
  'unwatched-films': 'Unwatched Films',
  'films-az': 'Films A–Z',
  'series-az': 'Series A–Z',
}

export const RAIL_STYLES: Record<RailStyle, string> = {
  hero: 'Spotlight',
  poster: 'Posters',
  landscape: 'Landscape',
}

export const DEFAULT_RAILS: RailConfig[] = [
  { id: 'r-hero', source: 'recent-films', style: 'hero', title: 'Spotlight', limit: 6, enabled: true },
  { id: 'r-continue', source: 'continue', style: 'landscape', title: 'Continue Watching', limit: 12, enabled: true },
  { id: 'r-films', source: 'recent-films', style: 'poster', title: 'Recently Added Films', limit: 12, enabled: true },
  { id: 'r-eps', source: 'recent-episodes', style: 'landscape', title: 'New Episodes', limit: 12, enabled: true },
  { id: 'r-dl', source: 'downloading', style: 'poster', title: 'Downloading', limit: 6, enabled: true },
]

export type LibraryView = 'poster' | 'wall' | 'list'

export interface Settings {
  connection: Connection | null
  rails: RailConfig[]
  libraryView: LibraryView
  hideUnavailable: boolean
  /** Normalize playback volume across titles (EBU R128 / loudnorm). */
  normalizeVolume: boolean
  /** Target loudness in LUFS (−16 standard, −18 quieter, −14 louder, −23 reference). */
  loudnessTarget: number
}

const DEFAULTS: Settings = {
  connection: null,
  rails: DEFAULT_RAILS,
  libraryView: 'poster',
  hideUnavailable: false,
  normalizeVolume: true,
  loudnessTarget: -16,
}

// ── Progress model ────────────────────────────────────────────────────────────

export interface ProgressEntry {
  key: string                       // 'film:12' | 'episode:34'
  type: 'film' | 'episode'
  id: number
  title: string
  posterUrl: string | null
  backdropUrl: string | null
  streamUrl: string
  seriesId?: number
  seriesTitle?: string
  positionSeconds: number
  durationSeconds: number
  completed: boolean
  updatedAt: number
}

// ── Store plumbing ────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'archivist-player-settings'
const PROGRESS_KEY = 'archivist-player-progress'

let settings: Settings = load(SETTINGS_KEY, DEFAULTS)
let progress: Record<string, ProgressEntry> = load(PROGRESS_KEY, {})
const listeners = new Set<() => void>()

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch { return fallback }
}

function emit() { listeners.forEach(l => l()) }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }

export function getSettings(): Settings { return settings }
export function updateSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  emit()
}
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings)
}

export function getProgress(): Record<string, ProgressEntry> { return progress }
export function hydrateProgress(entries: ProgressEntry[]) {
  const remote = Object.fromEntries(entries.map(entry => [entry.key, entry]))
  progress = { ...progress, ...remote }
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress))
  emit()
}
export function saveProgress(entry: Omit<ProgressEntry, 'updatedAt'>) {
  progress = { ...progress, [entry.key]: { ...entry, updatedAt: Date.now() } }
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress))
  emit()
}
export function removeProgress(key: string) {
  const { [key]: _gone, ...rest } = progress
  progress = rest
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress))
  emit()
}
export function useProgress(): Record<string, ProgressEntry> {
  return useSyncExternalStore(subscribe, getProgress)
}

/** In-progress items, most recent first — the Continue Watching rail. */
export function continueWatching(): ProgressEntry[] {
  return Object.values(progress)
    .filter(p => !p.completed && p.positionSeconds > 30 && p.positionSeconds / Math.max(p.durationSeconds, 1) < 0.95)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
