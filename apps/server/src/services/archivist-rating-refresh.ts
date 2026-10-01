import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { catalogueRuntimeEnabled, getCatalogueDb } from '../catalogue-database.js'
import { enqueueUniqueJob } from '../system/event-store.js'
import { registerJobHandler } from '../system/job-runner.js'
import { EMPTY_OMDB_RATINGS, fetchOmdbRatings, isOmdbQuotaError, omdbConfigured, ratingsFromOmdbPayload, type OmdbRatings } from './omdb.js'
import { recomputeStale, recomputeSubject, recordProviderScore, type RatingSubjectType } from './archivist-rating.js'
import { getArchivistRatingSettings } from './archivist-rating-settings.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'
import { enqueueFilmMetadataRefresh } from '../modules/films/metadata-refresh.js'
import { enqueueSeriesMetadataRefresh } from '../modules/series/metadata-refresh.js'

/**
 * Keeps `external_ratings` fed, so the Archivist Rating has something to weigh.
 *
 * OMDb answers by IMDb id and returns IMDb, Rotten Tomatoes and Metacritic in
 * one call, which is the whole reason it is the provider here. Titles without an
 * IMDb id are skipped rather than searched by title — a wrong match would poison
 * a score silently, and the id arrives on the next metadata refresh anyway.
 */

const logger = createLogger('ArchivistRatingRefresh')
const JOB_TYPE = 'archivist-rating-refresh'
const SCHEDULER_INTERVAL_MS = 30 * 60_000
const STARTUP_DELAY_MS = 40_000
const MAX_DUE_PER_TICK = 40
/** OMDb scores move slowly; a fortnight keeps a large library inside the free tier. */
const REFRESH_AFTER_DAYS = 14
/** Calls OMDb may be given in any rolling day — an operator setting. */
const dailyBudget = () => getArchivistRatingSettings().dailyOmdbBudget

let scheduler: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null

interface Subject { id: number; imdbId: string | null }

function loadSubject(subjectType: RatingSubjectType, id: number): Subject | null {
  const table = subjectType === 'film' ? 'films' : 'series'
  const row = getDb().prepare(`SELECT id, imdb_id AS imdbId FROM ${table} WHERE id = ?`).get(id) as Subject | undefined
  return row ?? null
}

/** Write whatever OMDb returned into the provider table. */
function recordOmdb(subjectType: RatingSubjectType, subjectId: number, ratings: OmdbRatings): number {
  let recorded = 0
  if (ratings.imdb) {
    if (recordProviderScore(subjectType, subjectId, 'imdb', ratings.imdb.score, ratings.imdb.votes)) recorded++
  }
  if (ratings.rottenTomatoes !== null) {
    if (recordProviderScore(subjectType, subjectId, 'rotten_tomatoes', ratings.rottenTomatoes)) recorded++
  }
  if (ratings.metacritic !== null) {
    if (recordProviderScore(subjectType, subjectId, 'metacritic', ratings.metacritic)) recorded++
  }
  return recorded
}

/**
 * Mine the OMDb payloads the catalogue has already stored.
 *
 * `catalogue-runner` saves every enrichment response whole, so for any library
 * title whose IMDb id the catalogue has seen, all three scores are on disk and
 * cost nothing to read. Run before the network path so a first setup is not
 * spent re-fetching what is already there.
 */
export function backfillFromCataloguePayloads(limit = 2000): { matched: number } {
  if (!catalogueRuntimeEnabled()) return { matched: 0 }
  let payloads: Array<{ sourceId: string; payloadJson: string }>
  try {
    payloads = getCatalogueDb().prepare(`
      SELECT source_id AS sourceId, payload_json AS payloadJson
      FROM catalog_source_payloads WHERE source = 'omdb' LIMIT ?
    `).all(limit) as Array<{ sourceId: string; payloadJson: string }>
  } catch (err) {
    logger.warn(`Catalogue payloads unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return { matched: 0 }
  }
  if (payloads.length === 0) return { matched: 0 }

  const db = getDb()
  const findFilm = db.prepare('SELECT id FROM films WHERE imdb_id = ?')
  const findSeries = db.prepare('SELECT id FROM series WHERE imdb_id = ?')
  let matched = 0

  const apply = db.transaction(() => {
    for (const row of payloads) {
      const subjects: Array<[RatingSubjectType, { id: number } | undefined]> = [
        ['film', findFilm.get(row.sourceId) as { id: number } | undefined],
        ['series', findSeries.get(row.sourceId) as { id: number } | undefined],
      ]
      if (!subjects.some(([, subject]) => subject)) continue

      let ratings: OmdbRatings
      try { ratings = ratingsFromOmdbPayload(JSON.parse(row.payloadJson) as Record<string, unknown>) }
      catch { continue }

      for (const [subjectType, subject] of subjects) {
        if (!subject) continue
        if (recordOmdb(subjectType, subject.id, ratings) > 0) {
          recordFetchAttempt(subjectType, subject.id, 'catalogue-payload')
          recomputeSubject(subjectType, subject.id, undefined, db)
          matched++
        }
      }
    }
  })
  apply()

  if (matched > 0) logger.info(`Backfilled ${matched} title(s) from stored catalogue OMDb payloads`)
  return { matched }
}

/**
 * OMDb calls made in the last rolling day.
 *
 * The fetch log holds one row per title with its last attempt, and a title is
 * attempted at most once per refresh window, so rows stamped within the day are
 * the calls made within it. Payload-sourced rows are excluded — those cost
 * nothing, because the answer was already on disk.
 */
export function spentToday(): number {
  const db = getDb()
  const library = (db.prepare(`
    SELECT COUNT(*) AS n FROM rating_fetch_log
    WHERE outcome != 'catalogue-payload' AND attempted_at > datetime('now', '-1 day')
  `).get() as { n: number }).n
  // List candidate lookups draw on the same key, so they draw on the same
  // budget. Counting only one of the two would let them overrun it together.
  const candidates = (db.prepare(`
    SELECT COUNT(*) AS n FROM list_candidate_ratings
    WHERE outcome != 'catalogue-payload' AND fetched_at > datetime('now', '-1 day')
  `).get() as { n: number }).n
  return library + candidates
}

const QUOTA_EXHAUSTED_KEY = 'omdbQuotaExhaustedAt'

/** Whether OMDb has already refused on quota within the last day. */
function quotaExhausted(): boolean {
  const stamp = getAppSetting<string | null>(QUOTA_EXHAUSTED_KEY, null, 0, getDb())
  if (!stamp) return false
  return Date.now() - Date.parse(stamp) < 24 * 60 * 60 * 1000
}

/**
 * Stand fetching down after OMDb says no.
 *
 * A quota refusal applies to the key, not to the title that happened to hit it,
 * so it is recorded once rather than inferred from the per-title log.
 */
function markQuotaExhausted(): void {
  setAppSetting(QUOTA_EXHAUSTED_KEY, new Date().toISOString(), 0, getDb())
  logger.warn('OMDb refused on quota; pausing score fetches until tomorrow')
}

export function budgetRemaining(): number {
  if (quotaExhausted()) return 0
  return Math.max(0, dailyBudget() - spentToday())
}

function recordFetchAttempt(subjectType: RatingSubjectType, subjectId: number, outcome: string): void {
  getDb().prepare(`
    INSERT INTO rating_fetch_log (subject_type, subject_id, attempted_at, outcome)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(subject_type, subject_id) DO UPDATE SET attempted_at = excluded.attempted_at, outcome = excluded.outcome
  `).run(subjectType, subjectId, outcome)
}

/** Fetch and store one subject's provider scores, then republish its rating. */
export async function refreshSubjectRatings(
  subjectType: RatingSubjectType,
  subjectId: number,
  signal?: AbortSignal,
): Promise<{ recorded: number; skipped: string | null }> {
  const subject = loadSubject(subjectType, subjectId)
  if (!subject) return { recorded: 0, skipped: 'no such subject' }
  if (!subject.imdbId) return { recorded: 0, skipped: 'no IMDb id yet' }
  if (!omdbConfigured()) return { recorded: 0, skipped: 'OMDB_API_KEY is not configured' }

  let found: Awaited<ReturnType<typeof fetchOmdbRatings>>
  try {
    found = await fetchOmdbRatings(subject.imdbId, signal)
  } catch (err) {
    // A quota refusal is not this title's fault and will not pass on retry.
    // Record the day as spent so the scheduler stops asking, and report it as a
    // skip rather than failing the job three times over.
    if (isOmdbQuotaError(err)) {
      markQuotaExhausted()
      return { recorded: 0, skipped: 'OMDb daily request limit reached' }
    }
    throw err
  }
  const recorded = recordOmdb(subjectType, subjectId, found ?? EMPTY_OMDB_RATINGS)

  // Stamp the attempt even when OMDb knew nothing, so a title it will never
  // recognise is not retried on every scheduler tick. This lives apart from the
  // scores: recording "asked, got nothing" as a provider row would weigh a zero
  // into the average.
  recordFetchAttempt(subjectType, subjectId, found === null ? 'unknown-to-omdb' : recorded > 0 ? 'scored' : 'no-scores')

  recomputeSubject(subjectType, subjectId)
  return { recorded, skipped: null }
}

/**
 * Enqueue titles whose scores are missing or stale.
 *
 * Never-fetched titles come first: a library adding its first scores benefits
 * more from breadth than from refreshing what it already knows.
 */
export function enqueueDueRatingRefreshes(): number {
  const settings = getArchivistRatingSettings()
  if (!settings.enabled || !omdbConfigured()) return 0

  const budget = budgetRemaining()
  if (budget === 0) {
    logger.info(`Daily OMDb budget of ${dailyBudget()} is spent; the rest resumes tomorrow`)
    return 0
  }

  try {
    const rows = getDb().prepare(`
      SELECT subject_type AS subjectType, id AS subjectId FROM (
        SELECT 'film' AS subject_type, f.id, l.attempted_at
        FROM films f
        LEFT JOIN rating_fetch_log l ON l.subject_type = 'film' AND l.subject_id = f.id
        WHERE f.imdb_id IS NOT NULL
        UNION ALL
        SELECT 'series' AS subject_type, s.id, l.attempted_at
        FROM series s
        LEFT JOIN rating_fetch_log l ON l.subject_type = 'series' AND l.subject_id = s.id
        WHERE s.imdb_id IS NOT NULL
      )
      WHERE attempted_at IS NULL OR julianday('now') - julianday(attempted_at) > ?
      ORDER BY attempted_at IS NOT NULL, attempted_at ASC
      LIMIT ?
    `).all(REFRESH_AFTER_DAYS, Math.min(MAX_DUE_PER_TICK, budget)) as Array<{ subjectType: RatingSubjectType; subjectId: number }>

    let enqueued = 0
    for (const row of rows) {
      if (enqueueRatingRefresh(row.subjectType, row.subjectId, true) !== null) enqueued++
    }
    return enqueued
  } catch (err) {
    logger.warn(`Ratings scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}

export interface RatingRefreshDiagnosis {
  enabled: boolean
  omdbConfigured: boolean
  /** Calls OMDb may still be given today, and the ceiling they count against. */
  budgetRemaining: number
  dailyBudget: number
  /** OMDb responses the catalogue has already stored and can be mined for free. */
  cataloguePayloads: number
  films: SubjectDiagnosis
  series: SubjectDiagnosis
}

export interface SubjectDiagnosis {
  total: number
  /** Scores are fetched by IMDb id, so a title without one cannot be looked up. */
  withImdbId: number
  /** Asked about at least once, whatever the answer was. */
  attempted: number
  /** Due now: never attempted, or last attempted longer ago than the refresh window. */
  due: number
}

/**
 * Why a refresh did or did not do anything.
 *
 * "Queued 0" is ambiguous on its own — no key, no IMDb ids and nothing left to
 * do all look identical from the outside — so the numbers behind the decision
 * are reported rather than left to be guessed at.
 */
export function diagnoseRatingRefresh(): RatingRefreshDiagnosis {
  const db = getDb()
  const subject = (table: 'films' | 'series', subjectType: RatingSubjectType): SubjectDiagnosis => db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN t.imdb_id IS NOT NULL AND t.imdb_id != '' THEN 1 ELSE 0 END) AS withImdbId,
      SUM(CASE WHEN l.subject_id IS NOT NULL THEN 1 ELSE 0 END) AS attempted,
      SUM(CASE
        WHEN t.imdb_id IS NULL OR t.imdb_id = '' THEN 0
        WHEN l.attempted_at IS NULL THEN 1
        WHEN julianday('now') - julianday(l.attempted_at) > ? THEN 1
        ELSE 0 END) AS due
    FROM ${table} t
    LEFT JOIN rating_fetch_log l ON l.subject_type = ? AND l.subject_id = t.id
  `).get(REFRESH_AFTER_DAYS, subjectType) as SubjectDiagnosis

  let cataloguePayloads = 0
  try {
    cataloguePayloads = (getCatalogueDb()
      .prepare("SELECT COUNT(*) AS n FROM catalog_source_payloads WHERE source = 'omdb'")
      .get() as { n: number }).n
  } catch {
    // The catalogue database is optional; an absent one simply offers nothing.
  }

  return {
    enabled: getArchivistRatingSettings().enabled,
    omdbConfigured: omdbConfigured(),
    budgetRemaining: budgetRemaining(),
    dailyBudget: dailyBudget(),
    cataloguePayloads,
    films: subject('films', 'film'),
    series: subject('series', 'series'),
  }
}

/**
 * Queue a metadata refresh for every title with no IMDb id.
 *
 * The id normally arrives with the title from TMDB or TVDB, but a library that
 * predates that — or one whose titles were added another way — has nothing to
 * look scores up by. Refreshing metadata is what fills it in.
 */
export function enqueueMissingImdbIdRefreshes(limit = 200): { films: number; series: number } {
  const db = getDb()
  const films = db.prepare(`
    SELECT id FROM films WHERE (imdb_id IS NULL OR imdb_id = '') AND tmdb_id IS NOT NULL LIMIT ?
  `).all(limit) as Array<{ id: number }>
  const series = db.prepare(`
    SELECT id FROM series WHERE (imdb_id IS NULL OR imdb_id = '') AND (tvdb_id IS NOT NULL OR tmdb_id IS NOT NULL) LIMIT ?
  `).all(limit) as Array<{ id: number }>

  let filmsQueued = 0
  for (const row of films) if (enqueueFilmMetadataRefresh(row.id) !== null) filmsQueued++
  let seriesQueued = 0
  for (const row of series) if (enqueueSeriesMetadataRefresh(row.id) !== null) seriesQueued++

  if (filmsQueued + seriesQueued > 0) {
    logger.info(`Queued metadata refresh for ${filmsQueued} film(s) and ${seriesQueued} series missing IMDb ids`)
  }
  return { films: filmsQueued, series: seriesQueued }
}

export function enqueueRatingRefresh(subjectType: RatingSubjectType, subjectId: number, scheduled = false): number | null {
  return enqueueUniqueJob({
    type: JOB_TYPE,
    subjectType,
    subjectId: String(subjectId),
    payload: { scheduled },
    maxAttempts: 3,
    priority: scheduled ? 15 : 90,
  })
}

export function registerArchivistRatingJobs(): void {
  registerJobHandler(JOB_TYPE, async (job, signal) => {
    const subjectType = job.subjectType === 'series' ? 'series' : 'film'
    const subjectId = Number(job.subjectId)
    if (!Number.isInteger(subjectId) || subjectId <= 0) throw new Error('Invalid ratings refresh job subject')
    const result = await refreshSubjectRatings(subjectType, subjectId, signal)
    if (result.skipped) logger.info(`${subjectType} #${subjectId} skipped: ${result.skipped}`)
  }, { lane: 'metadata' })
}

export function startArchivistRatingScheduler(): void {
  if (scheduler) return
  startupTimer = setTimeout(() => {
    // Free scores first, paid ones after.
    backfillFromCataloguePayloads()
    recomputeStale()
    enqueueDueRatingRefreshes()
  }, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  scheduler = setInterval(() => {
    recomputeStale()
    enqueueDueRatingRefreshes()
  }, SCHEDULER_INTERVAL_MS)
  scheduler.unref?.()
}

export function stopArchivistRatingScheduler(): void {
  if (scheduler) clearInterval(scheduler)
  if (startupTimer) clearTimeout(startupTimer)
  scheduler = null
  startupTimer = null
}
