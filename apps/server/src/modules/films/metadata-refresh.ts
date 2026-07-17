import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { ensureFilmFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot } from '../../shared/library-paths.js'
import { enqueueUniqueJob } from '../../system/event-store.js'
import { registerJobHandler } from '../../system/job-runner.js'
import { getMovie } from './tmdb.js'

const logger = createLogger('FilmMetadata')
const JOB_TYPE = 'film-metadata-refresh'
const SCHEDULER_INTERVAL_MS = 15 * 60_000
const STARTUP_DELAY_MS = 25_000
const MAX_DUE_PER_TICK = 20

let scheduler: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null

export async function refreshFilmMetadata(filmId: number): Promise<void> {
  const db = getDb()
  const stored = db.prepare(`
    SELECT id, library_id, tmdb_id, title
    FROM films
    WHERE id = ?
  `).get(filmId) as {
    id: number
    library_id: number
    tmdb_id: number | null
    title: string
  } | undefined
  if (!stored) return
  if (!stored.tmdb_id) throw new Error(`Film #${filmId} has no TMDB identifier`)

  const film = await getMovie(stored.tmdb_id)
  const { posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo } =
    await ensureFilmFolder(film, resolveLibraryRoot(db, stored.library_id))

  db.prepare(`
    UPDATE films SET
      imdb_id = COALESCE(?, imdb_id),
      title = ?,
      original_title = ?,
      sort_title = ?,
      year = ?,
      overview = ?,
      runtime = ?,
      genres = ?,
      release_date = ?,
      digital_release_date = ?,
      physical_release_date = ?,
      poster_path = COALESCE(?, poster_path),
      backdrop_path = COALESCE(?, backdrop_path),
      logo_path = COALESCE(?, logo_path),
      banner_path = COALESCE(?, banner_path),
      cast = ?,
      crew = ?,
      country = ?,
      rating = ?,
      certification = ?,
      studio = ?,
      available_versions = ?,
      last_metadata_refresh_at = datetime('now'),
      post_release_metadata_refreshed_at = CASE
        WHEN date(COALESCE(?, ?, ?)) < date('now') THEN datetime('now')
        ELSE NULL
      END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    film.imdbId ?? null,
    film.title,
    film.originalTitle,
    film.title.replace(/^(The|A|An)\s+/i, '').toLowerCase(),
    film.year ?? null,
    film.overview ?? null,
    film.runtime ?? null,
    JSON.stringify(film.genres ?? []),
    film.releaseDate ?? null,
    film.digitalReleaseDate ?? null,
    film.physicalReleaseDate ?? null,
    localPoster ?? null,
    localBackdrop ?? null,
    localLogo ?? null,
    film.bannerPath ?? null,
    JSON.stringify(film.cast ?? []),
    JSON.stringify(film.crew ?? []),
    film.country ?? null,
    film.rating ?? null,
    film.certification ?? null,
    film.studio ?? null,
    JSON.stringify(film.availableVersions ?? []),
    film.releaseDate ?? null,
    film.digitalReleaseDate ?? null,
    film.physicalReleaseDate ?? null,
    stored.id,
  )
}

export function enqueueFilmMetadataRefresh(filmId: number, scheduled = false): number | null {
  return enqueueUniqueJob({
    type: JOB_TYPE,
    subjectType: 'film',
    subjectId: String(filmId),
    payload: { scheduled },
    maxAttempts: 3,
  })
}

export function enqueueDueFilmMetadataRefreshes(now = new Date()): number {
  try {
    const rows = getDb().prepare(`
      SELECT id FROM films
      WHERE tmdb_id IS NOT NULL
        AND post_release_metadata_refreshed_at IS NULL
        AND COALESCE(release_date, digital_release_date, physical_release_date) IS NOT NULL
        AND date(COALESCE(release_date, digital_release_date, physical_release_date)) < date(?)
      ORDER BY COALESCE(release_date, digital_release_date, physical_release_date) ASC
      LIMIT ?
    `).all(now.toISOString(), MAX_DUE_PER_TICK) as Array<{ id: number }>
    let enqueued = 0
    for (const row of rows) {
      if (enqueueFilmMetadataRefresh(row.id, true) !== null) enqueued++
    }
    return enqueued
  } catch (err) {
    logger.warn('Post-release metadata scheduler tick failed:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

export function registerFilmMetadataJobs(): void {
  registerJobHandler(JOB_TYPE, async job => {
    const filmId = Number(job.subjectId)
    if (!Number.isInteger(filmId) || filmId <= 0) throw new Error('Invalid film refresh job subject')
    await refreshFilmMetadata(filmId)
  })
}

export function startFilmMetadataScheduler(): void {
  if (scheduler) return
  startupTimer = setTimeout(enqueueDueFilmMetadataRefreshes, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  scheduler = setInterval(enqueueDueFilmMetadataRefreshes, SCHEDULER_INTERVAL_MS)
  scheduler.unref?.()
}

export function stopFilmMetadataScheduler(): void {
  if (scheduler) clearInterval(scheduler)
  if (startupTimer) clearTimeout(startupTimer)
  scheduler = null
  startupTimer = null
}
