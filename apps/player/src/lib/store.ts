// Local state: connection, customization (home rails, library views), and
// watch progress. localStorage-backed with a tiny subscribe layer so React
// reads via useSyncExternalStore — no state library needed.

import { useSyncExternalStore } from 'react'
import type { Connection } from './sdk.js'
import type { PlaybackProgress, PlayerBootstrap, PlayerMediaCard, PlayerPreferencesEnvelope, PlayerPreferencesV1 } from '@archivist/contracts'

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
  /** Automatic segment behavior is deliberately opt-in per player profile. */
  autoSkipIntro: boolean
  autoSkipCredits: boolean
}

const DEFAULTS: Settings = {
  connection: null,
  rails: DEFAULT_RAILS,
  libraryView: 'poster',
  hideUnavailable: false,
  normalizeVolume: true,
  loudnessTarget: -16,
  autoSkipIntro: false,
  autoSkipCredits: false,
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

// ── Living-room UI v2 state ─────────────────────────────────────────────────

export interface PlayerV2State {
  bootstrap: PlayerBootstrap | null
  preferences: PlayerPreferencesEnvelope | null
  draft: PlayerPreferencesV1 | null
  mediaContext: PlayerMediaCard | null
  modalStack: string[]
  focusMemory: Record<string, string>
  pendingNavigation: string | null
  progress: PlaybackProgress[]
  error: string | null
}

export type PlayerAction =
  | { type: 'BOOTSTRAP_SUCCEEDED'; bootstrap: PlayerBootstrap }
  | { type: 'BOOTSTRAP_FAILED'; message: string }
  | { type: 'MEDIA_CONTEXT_CHANGED'; item: PlayerMediaCard | null }
  | { type: 'PREFERENCES_DRAFTED'; preferences: PlayerPreferencesV1 }
  | { type: 'PREFERENCES_SAVED'; envelope: PlayerPreferencesEnvelope }
  | { type: 'MODAL_OPENED'; id: string }
  | { type: 'MODAL_CLOSED'; id?: string }
  | { type: 'FOCUS_REMEMBERED'; route: string; id: string }
  | { type: 'NAVIGATION_REQUESTED'; target: string }
  | { type: 'NAVIGATION_CLEARED' }

const initialV2State: PlayerV2State = {
  bootstrap: null,
  preferences: null,
  draft: null,
  mediaContext: null,
  modalStack: [],
  focusMemory: {},
  pendingNavigation: null,
  progress: [],
  error: null,
}

class PlayerStore {
  private state = initialV2State
  private subscriptions = new Set<() => void>()

  getState = (): PlayerV2State => this.state
  subscribe = (listener: () => void) => { this.subscriptions.add(listener); return () => { this.subscriptions.delete(listener) } }

  dispatch(action: PlayerAction): void {
    switch (action.type) {
      case 'BOOTSTRAP_SUCCEEDED':
        this.state = { ...this.state, bootstrap: action.bootstrap, preferences: action.bootstrap.preferences, draft: structuredClone(action.bootstrap.preferences.preferences), pendingNavigation: null, progress: action.bootstrap.progress, error: null }
        break
      case 'BOOTSTRAP_FAILED': this.state = { ...this.state, error: action.message }; break
      case 'MEDIA_CONTEXT_CHANGED': this.state = { ...this.state, mediaContext: action.item }; break
      case 'PREFERENCES_DRAFTED': this.state = { ...this.state, draft: structuredClone(action.preferences) }; break
      case 'PREFERENCES_SAVED': this.state = { ...this.state, preferences: action.envelope, draft: structuredClone(action.envelope.preferences) }; break
      case 'MODAL_OPENED': this.state = { ...this.state, modalStack: [...this.state.modalStack, action.id] }; break
      case 'MODAL_CLOSED': this.state = { ...this.state, modalStack: action.id ? this.state.modalStack.filter(id => id !== action.id) : this.state.modalStack.slice(0, -1) }; break
      case 'FOCUS_REMEMBERED': this.state = { ...this.state, focusMemory: { ...this.state.focusMemory, [action.route]: action.id } }; break
      case 'NAVIGATION_REQUESTED': this.state = { ...this.state, pendingNavigation: action.target }; break
      case 'NAVIGATION_CLEARED': this.state = { ...this.state, pendingNavigation: null }; break
    }
    this.subscriptions.forEach(listener => listener())
  }
}

export const playerStore = new PlayerStore()

export function usePlayerSelector<T>(selector: (state: PlayerV2State) => T): T {
  return useSyncExternalStore(playerStore.subscribe, () => selector(playerStore.getState()))
}
