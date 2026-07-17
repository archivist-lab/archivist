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
  rapidStartDelayMinutes: number
  rapidPollIntervalMinutes: number
  /** …and continues this long AFTER air time. */
  rapidWindowAfterAirHours: number
  targetedSearchIntervalMinutes: number
  targetedSearchWindowHours: number
  /** Refresh series metadata when an episode airs within this many minutes. */
  imminentRefreshWithinMinutes: number
}

export const DEFAULT_RELEASE_MONITORING: ReleaseMonitoringSettings = {
  pollIntervalMinutes: 15,
  rapidPollingEnabled: true,
  rapidStartDelayMinutes: 5,
  rapidPollIntervalMinutes: 5,
  rapidWindowAfterAirHours: 2,
  targetedSearchIntervalMinutes: 60,
  targetedSearchWindowHours: 24,
  imminentRefreshWithinMinutes: 90,
}

const KEY = 'releaseMonitoring'

export function getReleaseMonitoringSettings(): ReleaseMonitoringSettings {
  const stored = getAppSetting<Partial<ReleaseMonitoringSettings>>(KEY, {}, 0)
  return {
    ...DEFAULT_RELEASE_MONITORING,
    ...stored,
    rapidStartDelayMinutes: Number.isFinite(stored.rapidStartDelayMinutes) ? Number(stored.rapidStartDelayMinutes) : DEFAULT_RELEASE_MONITORING.rapidStartDelayMinutes,
    rapidPollIntervalMinutes: Number.isFinite(stored.rapidPollIntervalMinutes) ? Number(stored.rapidPollIntervalMinutes) : DEFAULT_RELEASE_MONITORING.rapidPollIntervalMinutes,
    targetedSearchIntervalMinutes: Number.isFinite(stored.targetedSearchIntervalMinutes) ? Number(stored.targetedSearchIntervalMinutes) : DEFAULT_RELEASE_MONITORING.targetedSearchIntervalMinutes,
    targetedSearchWindowHours: Number.isFinite(stored.targetedSearchWindowHours) ? Number(stored.targetedSearchWindowHours) : DEFAULT_RELEASE_MONITORING.targetedSearchWindowHours,
  }
}

export function setReleaseMonitoringSettings(patch: Partial<ReleaseMonitoringSettings>): ReleaseMonitoringSettings {
  const merged = { ...getReleaseMonitoringSettings(), ...patch }
  // Clamp the poll interval to a sane 1–1440 minute range.
  merged.pollIntervalMinutes = Math.min(1440, Math.max(1, Math.round(Number(merged.pollIntervalMinutes) || DEFAULT_RELEASE_MONITORING.pollIntervalMinutes)))
  const startDelay = Number(merged.rapidStartDelayMinutes)
  merged.rapidStartDelayMinutes = Math.min(120, Math.max(0, Math.round(Number.isFinite(startDelay) ? startDelay : DEFAULT_RELEASE_MONITORING.rapidStartDelayMinutes)))
  merged.rapidPollIntervalMinutes = Math.min(60, Math.max(1, Math.round(Number(merged.rapidPollIntervalMinutes) || DEFAULT_RELEASE_MONITORING.rapidPollIntervalMinutes)))
  merged.rapidWindowAfterAirHours = Math.min(24, Math.max(1, Number(merged.rapidWindowAfterAirHours) || DEFAULT_RELEASE_MONITORING.rapidWindowAfterAirHours))
  merged.targetedSearchIntervalMinutes = Math.min(360, Math.max(15, Math.round(Number(merged.targetedSearchIntervalMinutes) || DEFAULT_RELEASE_MONITORING.targetedSearchIntervalMinutes)))
  merged.targetedSearchWindowHours = Math.min(168, Math.max(merged.rapidWindowAfterAirHours, Number(merged.targetedSearchWindowHours) || DEFAULT_RELEASE_MONITORING.targetedSearchWindowHours))
  setAppSetting(KEY, merged, 0)
  return getReleaseMonitoringSettings()
}

// ── Rapid window detection ────────────────────────────────────────────────────

let cache: { until: number; active: boolean } | null = null

/**
 * True when any monitored, still-missing episode is inside its rapid window
 * (air + startDelay … air + afterHours). Cached for a few seconds so the
 * per-tick check is cheap.
 */
export function isRapidWindowActive(now = Date.now()): boolean {
  if (cache && now < cache.until) return cache.active
  const s = getReleaseMonitoringSettings()
  let active = false
  if (s.rapidPollingEnabled) {
    try {
      const nowIso = new Date(now).toISOString()
      const row = getDb().prepare(`
        SELECT 1 FROM episodes e
        JOIN series sr ON sr.id = e.series_id
        JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
        WHERE sr.monitored = 1 AND se.monitored = 1 AND e.monitored = 1
          AND e.status IN ('wanted', 'missing') AND e.air_at IS NOT NULL
          AND datetime(e.air_at) BETWEEN datetime(?, ?) AND datetime(?, ?)
        LIMIT 1
      `).get(nowIso, `-${s.rapidWindowAfterAirHours} hours`, nowIso, `-${s.rapidStartDelayMinutes} minutes`)
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
    const nowIso = new Date(now).toISOString()
    const rows = getDb().prepare(`
      SELECT DISTINCT e.series_id AS id FROM episodes e
      JOIN series sr ON sr.id = e.series_id
      JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
      WHERE sr.monitored = 1 AND se.monitored = 1 AND e.monitored = 1 AND COALESCE(e.air_at, e.air_date) IS NOT NULL
        AND datetime(COALESCE(e.air_at, e.air_date)) BETWEEN datetime(?) AND datetime(?, ?)
    `).all(nowIso, nowIso, `+${s.imminentRefreshWithinMinutes} minutes`) as Array<{ id: number }>
    return rows.map(r => r.id)
  } catch { return [] }
}
