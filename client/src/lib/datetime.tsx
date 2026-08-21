import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { sharedApi } from './shared.api.js'

/** Stored value meaning "use whatever zone this browser reports". */
export const AUTO_TIME_ZONE = 'auto'

/**
 * The zone this browser is in. Falls back to UTC on the rare engine that does
 * not report one — a bare `toLocaleString()` would do the same thing silently.
 */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Every IANA zone the browser knows, for the settings picker. */
export function supportedTimeZones(): string[] {
  const withValues = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  try {
    const zones = withValues.supportedValuesOf?.('timeZone')
    if (zones?.length) return zones
  } catch {
    // Older engines have no supportedValuesOf; fall through.
  }
  const detected = detectTimeZone()
  return Array.from(new Set(['UTC', detected])).sort()
}

function isUsableZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The resolved zone, mirrored outside React so module-level helpers — of which
 * there are several — can format without being rewritten into components.
 * `TimeZoneProvider` keeps it in step and remounts its subtree when it changes,
 * so nothing can render a stale zone.
 */
let currentZone: string = detectTimeZone()

/** The zone formatting currently uses. */
export function activeTimeZone(): string {
  return currentZone
}

type DateLike = Date | string | number | null | undefined

function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function format(value: DateLike, options: Intl.DateTimeFormatOptions, fallback: string): string {
  const date = toDate(value)
  if (!date) return fallback
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone: currentZone }).format(date)
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date)
  }
}

/** Date and time in the configured zone. Use instead of `toLocaleString()`. */
export function formatDateTime(value: DateLike, fallback = '—', options: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }): string {
  return format(value, options, fallback)
}

/** Date only, in the configured zone. Use instead of `toLocaleDateString()`. */
export function formatDate(value: DateLike, fallback = '—', options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return format(value, options, fallback)
}

/** Time only, in the configured zone. Use instead of `toLocaleTimeString()`. */
export function formatTime(value: DateLike, fallback = '—', options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }): string {
  return format(value, options, fallback)
}

interface TimeZoneValue {
  /** What is stored — either 'auto' or an IANA name. */
  setting: string
  /** The zone actually used for formatting, with 'auto' already resolved. */
  zone: string
  detected: string
  loaded: boolean
  save: (timeZone: string) => Promise<void>
}

const TimeZoneContext = createContext<TimeZoneValue | null>(null)

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const [setting, setSetting] = useState<string>(AUTO_TIME_ZONE)
  const [loaded, setLoaded] = useState(false)
  const detected = useMemo(detectTimeZone, [])

  useEffect(() => {
    let cancelled = false
    sharedApi.settings.getDisplay()
      .then(config => { if (!cancelled) setSetting(config.timeZone || AUTO_TIME_ZONE) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const save = useCallback(async (timeZone: string) => {
    const config = await sharedApi.settings.setDisplay({ timeZone })
    setSetting(config.timeZone || AUTO_TIME_ZONE)
  }, [])

  // A zone the server holds but this browser cannot resolve would make every
  // date throw, so an unusable value degrades to the detected one.
  const zone = useMemo(() => {
    if (setting === AUTO_TIME_ZONE) return detected
    return isUsableZone(setting) ? setting : detected
  }, [setting, detected])

  // Assigned during render so the first paint after a change already formats in
  // the new zone; the key below then remounts the tree so every cached string
  // is rebuilt rather than left stale.
  currentZone = zone

  const value = useMemo<TimeZoneValue>(
    () => ({ setting, zone, detected, loaded, save }),
    [setting, zone, detected, loaded, save],
  )
  return (
    <TimeZoneContext.Provider value={value}>
      <Fragment key={zone}>{children}</Fragment>
    </TimeZoneContext.Provider>
  )
}

export function useTimeZone(): TimeZoneValue {
  const value = useContext(TimeZoneContext)
  // Formatting must never depend on the provider being mounted — tests and
  // isolated renders fall back to the browser zone.
  if (!value) {
    const detected = detectTimeZone()
    return { setting: AUTO_TIME_ZONE, zone: detected, detected, loaded: true, save: async () => {} }
  }
  return value
}

/** Formatters bound to the configured zone, for use inside components. */
export function useDateFormat() {
  const { zone } = useTimeZone()
  return useMemo(() => ({ zone, dateTime: formatDateTime, date: formatDate, time: formatTime }), [zone])
}
