/**
 * Release-monitoring settings — the RSS-side knobs. The main one is *rapid
 * polling*: when a monitored episode is airing soon, the feed workers poll every
 * ~60s (instead of the normal 5-minute interval) so a new episode is grabbed
 * within a minute or two of appearing. Stored in app_settings `releaseMonitoring`.
 */

import { getAppSetting, setAppSetting } from '../shared/settings.js'
import { getDb } from '../db.js'

export interface ReleaseMonitoringSettings {
  /** Normal RSS feed poll interval, in minutes (rapid mode overrides it when an episode is airing). */
  pollIntervalMinutes: number
  rapidPollingEnabled: boolean
  rapidPollIntervalSeconds: number
  /** Rapid window starts this long BEFORE an episode's air time. */
  rapidWindowBeforeAirMinutes: number
  /** …and continues this long AFTER air time. */
  rapidWindowAfterAirHours: number
  /** Refresh series metadata when an episode airs within this many minutes. */
  imminentRefreshWithinMinutes: number
}

export const DEFAULT_RELEASE_MONITORING: ReleaseMonitoringSettings = {
  pollIntervalMinutes: 15,
  rapidPollingEnabled: true,
  rapidPollIntervalSeconds: 60,
  rapidWindowBeforeAirMinutes: 30,
  rapidWindowAfterAirHours: 6,
  imminentRefreshWithinMinutes: 90,
}

const KEY = 'releaseMonitoring'

export function getReleaseMonitoringSettings(): ReleaseMonitoringSettings {
  return { ...DEFAULT_RELEASE_MONITORING, ...getAppSetting<Partial<ReleaseMonitoringSettings>>(KEY, {}, 0) }
}

export function setReleaseMonitoringSettings(patch: Partial<ReleaseMonitoringSettings>): ReleaseMonitoringSettings {
  const merged = { ...getReleaseMonitoringSettings(), ...patch }
  // Clamp the poll interval to a sane 1–1440 minute range.
  merged.pollIntervalMinutes = Math.min(1440, Math.max(1, Math.round(Number(merged.pollIntervalMinutes) || DEFAULT_RELEASE_MONITORING.pollIntervalMinutes)))
  setAppSetting(KEY, merged, 0)
  return getReleaseMonitoringSettings()
}

// ── Rapid window detection ────────────────────────────────────────────────────

let cache: { until: number; active: boolean } | null = null

/**
 * True when any monitored, still-missing episode is inside its rapid window
 * (air − beforeMinutes … air + afterHours). Cached for a few seconds so the
 * per-tick check is cheap. `now` is in [air−before, air+after] ⟺ the episode's
 * air_date is in [now−after, now+before].
 */
export function isRapidWindowActive(now = Date.now()): boolean {
  if (cache && now < cache.until) return cache.active
  const s = getReleaseMonitoringSettings()
  let active = false
  if (s.rapidPollingEnabled) {
    try {
      const row = getDb().prepare(`
        SELECT 1 FROM episodes
        WHERE monitored = 1 AND status IN ('wanted', 'missing') AND air_date IS NOT NULL
          AND datetime(air_date) BETWEEN datetime('now', ?) AND datetime('now', ?)
        LIMIT 1
      `).get(`-${s.rapidWindowAfterAirHours} hours`, `+${s.rapidWindowBeforeAirMinutes} minutes`)
      active = !!row
    } catch { active = false }
  }
  cache = { until: now + 5_000, active }
  return active
}

/** Series with a monitored episode airing within the imminent-refresh window. */
export function getImminentSeriesIds(now = Date.now()): number[] {
  const s = getReleaseMonitoringSettings()
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT e.series_id AS id FROM episodes e
      JOIN series sr ON sr.id = e.series_id
      WHERE sr.monitored = 1 AND e.monitored = 1 AND e.air_date IS NOT NULL
        AND datetime(e.air_date) BETWEEN datetime('now') AND datetime('now', ?)
    `).all(`+${s.imminentRefreshWithinMinutes} minutes`) as Array<{ id: number }>
    return rows.map(r => r.id)
  } catch { return [] }
}
