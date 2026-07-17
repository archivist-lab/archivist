import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { resolveLibraryRoot } from '../../shared/library-paths.js'
import {
  ensureEpisodeThumbnail,
  ensureSeasonFolder,
  ensureSeriesFolder,
  generateEpisodeNfo,
} from '../../shared/media-organizer.js'
import { enqueueUniqueJob } from '../../system/event-store.js'
import { registerJobHandler } from '../../system/job-runner.js'
import {
  getSeries,
  getSeriesEpisodes,
  getSeriesEpisodesTmdb,
  getNormalizedEpisodeAirtimes,
  getSeriesSeasons,
  getSeriesSeasonsTmdb,
  getSeriesSchedule,
  getSeriesTmdb,
} from './tvdb.js'
import { configuredReleaseTimezone, deriveEpisodeAirtime } from './airtime.js'

const logger = createLogger('SeriesMetadata')
const JOB_TYPE = 'series-metadata-refresh'
const SCHEDULER_INTERVAL_MS = 5 * 60_000
const STARTUP_DELAY_MS = 20_000
const MAX_DUE_PER_TICK = 10

let scheduler: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null

export async function refreshSeriesMetadata(seriesId: number): Promise<void> {
  const db = getDb()
  const series = db.prepare(`
    SELECT id, library_id, tvdb_id, tmdb_id, title
    FROM series WHERE id = ?
  `).get(seriesId) as {
    id: number
    library_id: number
    tvdb_id: number | null
    tmdb_id: number | null
    title: string
  } | undefined
  if (!series) return

  // When both identities are known, TMDB is the primary metadata provider.
  const useTvdb = Boolean(series.tvdb_id && !series.tmdb_id)
  if (!series.tvdb_id && !series.tmdb_id) throw new Error(`Series #${seriesId} has no TVDB or TMDB identifier`)

  const seriesData = useTvdb ? await getSeries(series.tvdb_id!) : await getSeriesTmdb(series.tmdb_id!)
  if (!seriesData) throw new Error(`Metadata provider returned no data for "${series.title}"`)
  const resolvedTvdbId = series.tvdb_id ?? seriesData.tvdbId ?? null
  if ((!seriesData.airTime || !seriesData.airTimezone) && resolvedTvdbId) {
    try {
      const schedule = await getSeriesSchedule(resolvedTvdbId)
      seriesData.airTime = schedule.airTime ?? seriesData.airTime
      seriesData.airDay = schedule.airDay ?? seriesData.airDay
      seriesData.airTimezone = schedule.airTimezone ?? seriesData.airTimezone
    } catch { /* date-only fallback */ }
  }
  const releaseTimezone = seriesData.airTimezone ?? configuredReleaseTimezone()
  const normalizedAirtimes = resolvedTvdbId
    ? await getNormalizedEpisodeAirtimes(resolvedTvdbId).catch(err => {
      logger.warn(`Skyhook airtime lookup failed for TVDB #${resolvedTvdbId}:`, err instanceof Error ? err.message : String(err))
      return new Map()
    })
    : new Map()

  const libraryRoot = resolveLibraryRoot(db, series.library_id)
  const { posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo } =
    await ensureSeriesFolder(seriesData, libraryRoot)
  const seasons = useTvdb
    ? await getSeriesSeasons(series.tvdb_id!)
    : await getSeriesSeasonsTmdb(series.tmdb_id!)

  for (const season of seasons) {
    try {
      const { targetDir: seasonDir, posterPath: localSeasonPoster } = await ensureSeasonFolder(seriesData, season, libraryRoot)
      db.prepare(`
        INSERT OR IGNORE INTO seasons
          (series_id, season_number, title, overview, poster_path, episode_count, monitored)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        series.id,
        season.seasonNumber,
        season.title ?? null,
        season.overview ?? null,
        localSeasonPoster ?? season.posterPath ?? null,
        season.episodeCount,
      )
      db.prepare(`
        UPDATE seasons SET poster_path = COALESCE(?, poster_path), episode_count = ?
        WHERE series_id = ? AND season_number = ?
      `).run(localSeasonPoster ?? null, season.episodeCount, series.id, season.seasonNumber)

      const seasonRow = db.prepare(`
        SELECT id, monitored FROM seasons WHERE series_id = ? AND season_number = ?
      `).get(series.id, season.seasonNumber) as { id: number; monitored: number }

      const episodes = useTvdb
        ? await getSeriesEpisodes(series.tvdb_id!, season.seasonNumber)
        : await getSeriesEpisodesTmdb(series.tmdb_id!, season.seasonNumber)

      for (const episode of episodes) {
        try {
          const normalized = normalizedAirtimes.get(`${episode.seasonNumber}:${episode.episodeNumber}`)
          const airtime = deriveEpisodeAirtime(normalized?.airDateUtc ?? episode.airDate, seriesData.airTime, releaseTimezone)
          if (normalized?.airDate) airtime.airDate = normalized.airDate
          const nfoName = `${seriesData.title} S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} - ${episode.title}.nfo`
            .replace(/[/\:*?"<>|]/g, '')
          try { generateEpisodeNfo(seriesData, episode, join(seasonDir, nfoName)) } catch { /* best effort */ }

          const localStill = await ensureEpisodeThumbnail(seriesData, season, episode, libraryRoot)
          db.prepare(`
            INSERT INTO episodes
              (series_id, season_id, season_number, episode_number, tvdb_episode_id,
               title, overview, air_date, air_time, air_timezone, air_at, air_time_source,
               runtime, still_path, monitored, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')
            ON CONFLICT(series_id, season_number, episode_number) DO UPDATE SET
              season_id = excluded.season_id,
              tvdb_episode_id = COALESCE(excluded.tvdb_episode_id, episodes.tvdb_episode_id),
              title = COALESCE(excluded.title, episodes.title),
              overview = COALESCE(excluded.overview, episodes.overview),
              air_date = excluded.air_date,
              air_time = excluded.air_time,
              air_timezone = excluded.air_timezone,
              air_at = excluded.air_at,
              air_time_source = excluded.air_time_source,
              runtime = COALESCE(excluded.runtime, episodes.runtime),
              still_path = COALESCE(excluded.still_path, episodes.still_path),
              updated_at = datetime('now')
          `).run(
            series.id,
            seasonRow.id,
            season.seasonNumber,
            episode.episodeNumber,
            normalized?.tvdbEpisodeId ?? episode.tvdbEpisodeId ?? null,
            episode.title,
            episode.overview,
            airtime.airDate,
            airtime.airTime,
            airtime.airTimezone,
            airtime.airAt,
            airtime.airTimeSource,
            episode.runtime,
            localStill ?? episode.stillPath,
            seasonRow.monitored,
          )
          if (localStill) {
            db.prepare(`
              UPDATE episodes SET still_path = ?
              WHERE series_id = ? AND season_number = ? AND episode_number = ?
            `).run(localStill, series.id, episode.seasonNumber, episode.episodeNumber)
          }
        } catch (err) {
          logger.warn(
            `Failed episode S${season.seasonNumber}E${episode.episodeNumber} for "${series.title}":`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    } catch (err) {
      logger.warn(
        `Failed season S${season.seasonNumber} for "${series.title}":`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  db.prepare(`
    UPDATE series SET
      tvdb_id = COALESCE(tvdb_id, ?),
      air_time = ?,
      air_day = ?,
      status = ?,
      poster_path = COALESCE(?, poster_path),
      backdrop_path = COALESCE(?, backdrop_path),
      logo_path = COALESCE(?, logo_path),
      banner_path = COALESCE(?, banner_path),
      cast = ?,
      crew = ?,
      country = ?,
      certification = ?,
      last_metadata_refresh_at = datetime('now'),
      next_metadata_refresh_at = datetime(
        'now',
        '+' || COALESCE(
          refresh_interval_hours,
          CASE WHEN ? IN ('continuing', 'upcoming') THEN 6 ELSE 168 END
        ) || ' hours'
      ),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    resolvedTvdbId,
    seriesData.airTime ?? null,
    seriesData.airDay ?? null,
    seriesData.status,
    localPoster ?? null,
    localBackdrop ?? null,
    localLogo ?? null,
    seriesData.bannerPath ?? null,
    JSON.stringify(seriesData.cast ?? []),
    JSON.stringify(seriesData.crew ?? []),
    seriesData.country ?? null,
    seriesData.certification ?? null,
    seriesData.status,
    series.id,
  )
}

export function enqueueSeriesMetadataRefresh(seriesId: number, scheduled = false): number | null {
  return enqueueUniqueJob({
    type: JOB_TYPE,
    subjectType: 'series',
    subjectId: String(seriesId),
    payload: { scheduled },
    maxAttempts: 3,
  })
}

export function registerSeriesMetadataJobs(): void {
  registerJobHandler(JOB_TYPE, async job => {
    const seriesId = Number(job.subjectId)
    if (!Number.isInteger(seriesId) || seriesId <= 0) throw new Error('Invalid series refresh job subject')
    await refreshSeriesMetadata(seriesId)
  })
}

export function enqueueDueSeriesMetadataRefreshes(now = new Date()): number {
  try {
    const rows = getDb().prepare(`
      SELECT s.id FROM series s
      WHERE (
        s.monitored = 1
        AND (s.next_metadata_refresh_at IS NULL OR datetime(s.next_metadata_refresh_at) <= datetime(?))
      ) OR EXISTS (
        SELECT 1 FROM episodes e
        WHERE e.series_id = s.id
          AND e.air_at IS NOT NULL
          AND datetime(e.air_at, '+1 hour') <= datetime(?)
          AND (
            s.last_metadata_refresh_at IS NULL
            OR datetime(s.last_metadata_refresh_at) < datetime(e.air_at, '+1 hour')
          )
      )
      ORDER BY COALESCE(next_metadata_refresh_at, added_at) ASC
      LIMIT ?
    `).all(now.toISOString(), now.toISOString(), MAX_DUE_PER_TICK) as Array<{ id: number }>
    let enqueued = 0
    for (const row of rows) {
      if (enqueueSeriesMetadataRefresh(row.id, true) !== null) enqueued++
    }
    return enqueued
  } catch (err) {
    logger.warn('Metadata scheduler tick failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

function enqueueMissingAirtimeSeries(): void {
  try {
    const rows = getDb().prepare(`
      SELECT s.id FROM series s
      WHERE s.monitored = 1
        AND (s.tvdb_id IS NOT NULL OR s.tmdb_id IS NOT NULL)
        AND (
          s.air_time IS NULL
          OR EXISTS (
            SELECT 1 FROM episodes e
            WHERE e.series_id = s.id
              AND e.air_date IS NOT NULL
              AND COALESCE(e.air_time_source, '') <> 'provider_timestamp'
          )
        )
      ORDER BY s.added_at ASC
    `).all() as Array<{ id: number }>
    for (const row of rows) enqueueSeriesMetadataRefresh(row.id, true)
  } catch (err) {
    logger.warn('Airtime backfill enqueue failed:', err instanceof Error ? err.message : String(err))
  }
}

export function startSeriesMetadataScheduler(): void {
  if (scheduler) return
  startupTimer = setTimeout(() => {
    enqueueMissingAirtimeSeries()
    enqueueDueSeriesMetadataRefreshes()
  }, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  scheduler = setInterval(enqueueDueSeriesMetadataRefreshes, SCHEDULER_INTERVAL_MS)
  scheduler.unref?.()
}

export function stopSeriesMetadataScheduler(): void {
  if (scheduler) clearInterval(scheduler)
  if (startupTimer) clearTimeout(startupTimer)
  scheduler = null
  startupTimer = null
}
