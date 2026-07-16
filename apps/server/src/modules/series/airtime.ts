import { getSearchMissingSettings } from '../../release-pipeline/search-missing-settings.js'

export interface EpisodeAirtime {
  airDate: string | null
  airTime: string | null
  airTimezone: string | null
  airAt: string | null
  airTimeSource: 'provider_timestamp' | 'series_schedule' | null
}

export function configuredReleaseTimezone(): string {
  const configured = getSearchMissingSettings().timezone
  if (configured && configured !== 'system') {
    try { new Intl.DateTimeFormat('en', { timeZone: configured }).format(); return configured } catch { /* fall through */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function normaliseAirTime(value: string | null | undefined): string | null {
  if (!value) return null
  const raw = value.trim()
  const twelve = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(raw)
  if (twelve) {
    let hour = Number(twelve[1]) % 12
    if (twelve[3].toUpperCase() === 'PM') hour += 12
    return `${String(hour).padStart(2, '0')}:${twelve[2]}`
  }
  const twentyFour = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw)
  if (!twentyFour) return null
  const hour = Number(twentyFour[1]); const minute = Number(twentyFour[2])
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : null
}

function zonedWallTimeToUtc(date: string, time: string, timezone: string): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time)
  if (!dateMatch || !timeMatch) return null
  const target = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), Number(timeMatch[1]), Number(timeMatch[2]))
  let candidate = target
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    for (let i = 0; i < 3; i++) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(part => [part.type, part.value]))
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
      candidate += target - represented
    }
    return new Date(candidate).toISOString()
  } catch { return null }
}

export function deriveEpisodeAirtime(
  rawAirDate: string | null | undefined,
  seriesAirTime: string | null | undefined,
  timezone = configuredReleaseTimezone(),
): EpisodeAirtime {
  const raw = rawAirDate?.trim() || ''
  if (!raw) return { airDate: null, airTime: null, airTimezone: null, airAt: null, airTimeSource: null }
  const date = raw.slice(0, 10)
  const explicitZone = raw.includes('T') && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  if (explicitZone) {
    const parsed = new Date(raw)
    if (Number.isFinite(parsed.getTime())) {
      const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed)
      return { airDate: date, airTime: localTime, airTimezone: timezone, airAt: parsed.toISOString(), airTimeSource: 'provider_timestamp' }
    }
  }
  const embeddedTime = raw.includes('T') ? normaliseAirTime(raw.split('T')[1].slice(0, 8)) : null
  const time = embeddedTime ?? normaliseAirTime(seriesAirTime)
  if (!time) return { airDate: date, airTime: null, airTimezone: null, airAt: null, airTimeSource: null }
  return {
    airDate: date,
    airTime: time,
    airTimezone: timezone,
    airAt: zonedWallTimeToUtc(date, time, timezone),
    airTimeSource: embeddedTime ? 'provider_timestamp' : 'series_schedule',
  }
}
