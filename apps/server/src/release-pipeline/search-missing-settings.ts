/**
 * Search Missing settings + schedule model.
 *
 * Search Missing is the *backlog* mechanism: it recovers older, already-released
 * content that RSS/recent-release monitoring won't catch. It is intentionally
 * low-frequency (default: one item per day at 03:00) and excludes anything
 * released inside the recent-release window (owned by RSS). Stored in
 * app_settings under `searchMissing` (global scope).
 */

import { getAppSetting, setAppSetting } from '../shared/settings.js'

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
export type SelectionStrategy = 'oldest_search_first' | 'oldest_release_first' | 'highest_priority' | 'random' | 'balanced_by_media_type'

export interface SearchMissingWindow {
  id: string
  enabled: boolean
  /** Local time HH:mm. */
  time: string
  /** Overrides defaultItemsPerRun for this window (null = inherit). */
  itemsPerRun: number | null
}

export interface SearchMissingDaySchedule {
  dayOfWeek: DayOfWeek
  enabled: boolean
  windows: SearchMissingWindow[]
}

export interface SearchMissingSettings {
  enabled: boolean
  recentReleaseExclusionHours: number
  defaultItemsPerRun: number
  maximumItemsPerRun: number
  /** 'system' or an IANA zone e.g. 'Asia/Dubai'. */
  timezone: string
  selectionStrategy: SelectionStrategy
  itemCooldownHours: number
  allowManualRun: boolean
  manualRunBypassesCooldown: boolean
  /** How long after a missed scheduled time a run may still fire. */
  scheduleGraceMinutes: number
  schedule: SearchMissingDaySchedule[]
}

const DAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

function defaultSchedule(): SearchMissingDaySchedule[] {
  return DAYS.map(day => ({
    dayOfWeek: day,
    enabled: true,
    windows: [{ id: `${day}-1`, enabled: true, time: '03:00', itemsPerRun: null }],
  }))
}

export const DEFAULT_SEARCH_MISSING: SearchMissingSettings = {
  enabled: true,
  recentReleaseExclusionHours: 72,
  defaultItemsPerRun: 1,
  maximumItemsPerRun: 100,
  timezone: 'system',
  selectionStrategy: 'oldest_search_first',
  itemCooldownHours: 168, // 7 days
  allowManualRun: true,
  manualRunBypassesCooldown: true,
  scheduleGraceMinutes: 120,
  schedule: defaultSchedule(),
}

const KEY = 'searchMissing'

export function getSearchMissingSettings(): SearchMissingSettings {
  const stored = getAppSetting<Partial<SearchMissingSettings> | null>(KEY, null, 0)
  if (!stored || !Array.isArray(stored.schedule)) return DEFAULT_SEARCH_MISSING
  // Merge over defaults so new fields/days are always present.
  return {
    ...DEFAULT_SEARCH_MISSING,
    ...stored,
    schedule: stored.schedule.length ? (stored.schedule as SearchMissingDaySchedule[]) : DEFAULT_SEARCH_MISSING.schedule,
  }
}

export function setSearchMissingSettings(patch: Partial<SearchMissingSettings>): SearchMissingSettings {
  const merged = { ...getSearchMissingSettings(), ...patch }
  setAppSetting(KEY, merged, 0)
  return getSearchMissingSettings()
}

// ── Timezone-aware local time ────────────────────────────────────────────────

export interface LocalParts { day: DayOfWeek; hour: number; minute: number; dateStr: string }

/** Local wall-clock parts (day/hour/minute/YYYY-MM-DD) in the configured zone. */
export function localParts(now: Date, timezone: string): LocalParts {
  const tz = timezone && timezone !== 'system' ? timezone : undefined
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit',
      year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
    const weekday = String(parts.weekday ?? '').toLowerCase() as DayOfWeek
    return {
      day: (DAYS.includes(weekday) ? weekday : 'monday'),
      hour: parseInt(parts.hour ?? '0', 10) % 24,
      minute: parseInt(parts.minute ?? '0', 10),
      dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    }
  } catch {
    // Bad IANA zone → fall back to server local time.
    return localParts(now, 'system')
  }
}

export interface DueWindow {
  windowId: string
  time: string
  itemsPerRun: number
  scheduledDate: string
  minutesLate: number
}

/**
 * Windows whose scheduled minute has passed today (in the configured zone) and
 * are still within the grace period — the caller dedupes against run history.
 */
export function dueWindows(settings: SearchMissingSettings, now: Date): DueWindow[] {
  if (!settings.enabled) return []
  const lp = localParts(now, settings.timezone)
  const nowMinutes = lp.hour * 60 + lp.minute
  const daySchedule = settings.schedule.find(d => d.dayOfWeek === lp.day)
  if (!daySchedule?.enabled) return []

  const due: DueWindow[] = []
  for (const w of daySchedule.windows) {
    if (!w.enabled) continue
    const [h, m] = w.time.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue
    const winMinutes = h * 60 + m
    const late = nowMinutes - winMinutes
    if (late >= 0 && late <= settings.scheduleGraceMinutes) {
      due.push({
        windowId: w.id,
        time: w.time,
        itemsPerRun: Math.min(w.itemsPerRun ?? settings.defaultItemsPerRun, settings.maximumItemsPerRun),
        scheduledDate: lp.dateStr,
        minutesLate: late,
      })
    }
  }
  return due
}

/** The next scheduled run (local wall-clock string), for the UI preview. */
export function nextRunDescription(settings: SearchMissingSettings, now: Date): string | null {
  if (!settings.enabled) return null
  // Scan the next 8 days of windows; return the first strictly in the future.
  for (let offset = 0; offset < 8; offset++) {
    const probe = new Date(now.getTime() + offset * 24 * 60 * 60_000)
    const lp = localParts(probe, settings.timezone)
    const daySchedule = settings.schedule.find(d => d.dayOfWeek === lp.day)
    if (!daySchedule?.enabled) continue
    const times = daySchedule.windows.filter(w => w.enabled).map(w => w.time).sort()
    for (const time of times) {
      const [h, m] = time.split(':').map(Number)
      const isFuture = offset > 0 || h * 60 + m > lp.hour * 60 + lp.minute
      if (isFuture) return `${lp.day} ${lp.dateStr} at ${time} (${settings.timezone})`
    }
  }
  return null
}
