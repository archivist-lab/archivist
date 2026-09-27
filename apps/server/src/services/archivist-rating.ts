import type { Database } from 'better-sqlite3'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { syncSubject } from './tags.js'
import {
  RATING_PROVIDERS,
  SCORING_PROFILE,
  getArchivistRatingSettings,
  weightsFor,
  weightsHash,
  type ArchivistRatingSettings,
  type RatingProvider,
  type ScoredMediaType,
} from './archivist-rating-settings.js'

/**
 * Builds the Archivist Rating — the single score the app displays — from the
 * provider scores stored in `external_ratings`.
 *
 * The composite is mirrored into `films.rating` / `series.rating` on the 0-10
 * scale those columns have always carried. Every sort, filter, shelf row and
 * Player surface already reads them, so publishing there is what makes this the
 * one score rather than a second one shown alongside the old.
 */

const logger = createLogger('ArchivistRating')

export { SCORING_PROFILE }

export type RatingSubjectType = 'film' | 'series'

const SUBJECT_TABLE: Record<RatingSubjectType, string> = { film: 'films', series: 'series' }
const MEDIA_TYPE: Record<RatingSubjectType, ScoredMediaType> = { film: 'films', series: 'series' }

/** Providers that report how many people voted, and can therefore be shrunk. */
const VOTE_BEARING: ReadonlySet<RatingProvider> = new Set(['imdb', 'tmdb'])

export interface ProviderScore {
  provider: RatingProvider
  scoreRaw: string
  scoreNorm: number
  votes: number | null
}

export interface ArchivistRating {
  score: number
  confidence: number
  providers: RatingProvider[]
  wellSupported: boolean
}

// ── Normalisation ─────────────────────────────────────────────────────────────

const clamp100 = (value: number) => Math.min(100, Math.max(0, value))

/** Put a provider's own scale onto the shared 0-100 one. */
export function normaliseProviderScore(provider: RatingProvider, score: number): number | null {
  if (!Number.isFinite(score)) return null
  switch (provider) {
    // 0-10 averages.
    case 'imdb':
    case 'tmdb':
      return score < 0 || score > 10 ? null : clamp100(score * 10)
    // Already 0-100.
    case 'metacritic':
    case 'rotten_tomatoes':
      return score < 0 || score > 100 ? null : clamp100(score)
    // TVDB's score is a popularity aggregate running into six figures, not a
    // rating. It is stored so it can be seen, and carries zero weight by
    // default; the log keeps it on a comparable axis if it is ever weighted up.
    case 'tvdb':
      return score <= 0 ? 0 : clamp100((Math.log10(score) / 6) * 100)
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

export function recordProviderScore(
  subjectType: RatingSubjectType,
  subjectId: number,
  provider: RatingProvider,
  score: number,
  votes: number | null = null,
  db: Database = getDb(),
): boolean {
  const normalised = normaliseProviderScore(provider, score)
  if (normalised === null) return false
  db.prepare(`
    INSERT INTO external_ratings (subject_type, subject_id, provider, score_raw, score_norm, votes, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(subject_type, subject_id, provider) DO UPDATE SET
      score_raw = excluded.score_raw, score_norm = excluded.score_norm,
      votes = COALESCE(excluded.votes, external_ratings.votes), fetched_at = excluded.fetched_at
  `).run(subjectType, subjectId, provider, String(score), normalised, votes)
  return true
}

export function providerScores(
  subjectType: RatingSubjectType,
  subjectId: number,
  db: Database = getDb(),
): ProviderScore[] {
  return db.prepare(`
    SELECT provider, score_raw AS scoreRaw, score_norm AS scoreNorm, votes
    FROM external_ratings WHERE subject_type = ? AND subject_id = ?
  `).all(subjectType, subjectId) as ProviderScore[]
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * The mean the vote-count shrinkage pulls toward.
 *
 * Taken from the library's own scored titles rather than a fixed constant, so a
 * collection of well-regarded films is not judged against an internet average
 * it never resembles. Falls back to the midpoint of the scale when there is not
 * yet enough of a library to average.
 */
export function libraryMean(db: Database = getDb()): number {
  const row = db.prepare(`
    SELECT AVG(score_norm) AS mean, COUNT(*) AS n FROM external_ratings WHERE provider IN ('imdb', 'tmdb')
  `).get() as { mean: number | null; n: number }
  return row.n >= 20 && row.mean !== null ? row.mean : 60
}

/**
 * Weighted mean of whichever providers replied.
 *
 * Weights are renormalised over those providers, so a title only IMDb knows
 * about scores as IMDb rated it rather than being dragged toward zero by the
 * sources that had nothing to say about it. `confidence` is what that cost:
 * the share of the configured weighting that was actually backed by data.
 */
export function scoreFrom(
  scores: ProviderScore[],
  mediaType: ScoredMediaType,
  settings: ArchivistRatingSettings,
  mean: number,
): ArchivistRating | null {
  const weights = weightsFor(settings, mediaType)
  const totalWeight = RATING_PROVIDERS.reduce((sum, provider) => sum + weights[provider], 0)
  if (totalWeight <= 0) return null

  let weighted = 0
  let presentWeight = 0
  const used: RatingProvider[] = []

  for (const entry of scores) {
    const weight = weights[entry.provider] ?? 0
    if (weight <= 0) continue

    let value = entry.scoreNorm
    // Few votes means the average has not settled, so pull it toward the mean
    // in proportion to how far short of the confidence floor it falls.
    if (VOTE_BEARING.has(entry.provider) && entry.votes !== null) {
      const floor = entry.provider === 'imdb' ? settings.voteFloor.imdb : settings.voteFloor.tmdb
      if (floor > 0) {
        const v = Math.max(0, entry.votes)
        value = (v / (v + floor)) * value + (floor / (v + floor)) * mean
      }
    }

    weighted += weight * value
    presentWeight += weight
    used.push(entry.provider)
  }

  if (presentWeight <= 0) return null

  const confidence = presentWeight / totalWeight
  return {
    score: clamp100(weighted / presentWeight),
    confidence,
    providers: used,
    wellSupported: confidence >= settings.minimumConfidence,
  }
}

/**
 * The viewer's own score for a title, on its 0-5 scale, or null if unrated.
 *
 * Only a rating set on the title itself counts. A film inherits nothing, and a
 * series must not be scored by one season somebody happened to rate.
 */
export function personalScore(
  subjectType: RatingSubjectType,
  subjectId: number,
  db: Database = getDb(),
): number | null {
  const row = db.prepare(`
    SELECT value FROM media_ratings WHERE profile_id = ? AND subject_type = ? AND subject_id = ?
  `).get(SCORING_PROFILE, subjectType, subjectId) as { value: number } | undefined
  return row ? Number(row.value) : null
}

/**
 * Publish the score a title should display, on the /10 scale the app reads.
 *
 * An Archivist Score set by hand wins outright — if you have said what a film
 * is worth, that is the answer, and no amount of critical opinion overrules it.
 * Everything unrated falls back to the weighted rating. Returns null when
 * neither exists, and nothing is written in that case: a title whose providers
 * have not been fetched keeps whatever it had rather than blanking out.
 */
function publishRating(
  subjectType: RatingSubjectType,
  subjectId: number,
  weighted: ArchivistRating | null,
  db: Database,
): number | null {
  const own = personalScore(subjectType, subjectId, db)
  const published = own !== null
    ? Number((own * 2).toFixed(2))
    : weighted ? Number((weighted.score / 10).toFixed(2)) : null
  if (published === null) return null

  const previous = db.prepare(`SELECT rating FROM ${SUBJECT_TABLE[subjectType]} WHERE id = ?`)
    .get(subjectId) as { rating: number | null } | undefined
  db.prepare(`UPDATE ${SUBJECT_TABLE[subjectType]} SET rating = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(published, subjectId)

  // A title that crossed a threshold gains or loses its tags now rather than at
  // the next sweep. Only when the number actually moved: a recompute that lands
  // on the same score has no bearing on any rule.
  if (previous?.rating !== published) syncSubject(subjectType, subjectId, db)
  return published
}

/**
 * Recompute one subject and publish it.
 *
 * The weighted rating is always stored, even when an Archivist Score is
 * overriding it, so clearing the override restores the weighted score rather
 * than leaving the title unscored.
 */
export function recomputeSubject(
  subjectType: RatingSubjectType,
  subjectId: number,
  // Resolved from `db` rather than defaulted eagerly, so a caller working
  // against its own connection is not silently reading another one's settings.
  settings: ArchivistRatingSettings | undefined = undefined,
  db: Database = getDb(),
  mean = libraryMean(db),
): ArchivistRating | null {
  const resolved = settings ?? getArchivistRatingSettings(db)
  if (!resolved.enabled) return null

  const rating = scoreFrom(providerScores(subjectType, subjectId, db), MEDIA_TYPE[subjectType], resolved, mean)
  if (rating) {
    db.prepare(`
      INSERT INTO composite_scores (subject_type, subject_id, score, confidence, providers, weights_hash, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(subject_type, subject_id) DO UPDATE SET
        score = excluded.score, confidence = excluded.confidence, providers = excluded.providers,
        weights_hash = excluded.weights_hash, computed_at = excluded.computed_at
    `).run(subjectType, subjectId, rating.score, rating.confidence, JSON.stringify(rating.providers), weightsHash(resolved))
  }

  publishRating(subjectType, subjectId, rating, db)
  return rating
}

/**
 * Republish after the viewer's own score was set or cleared.
 *
 * Nothing is recomputed — the provider scores have not moved — so this only
 * decides which of the two already-known numbers the app should show.
 */
export function republishForPersonalScore(
  subjectType: RatingSubjectType,
  subjectId: number,
  db: Database = getDb(),
): void {
  const stored = db.prepare('SELECT score, confidence FROM composite_scores WHERE subject_type = ? AND subject_id = ?')
    .get(subjectType, subjectId) as { score: number; confidence: number } | undefined
  publishRating(
    subjectType,
    subjectId,
    stored ? { score: stored.score, confidence: stored.confidence, providers: [], wellSupported: false } : null,
    db,
  )
}

/**
 * Recompute every subject whose stored composite predates the current weights.
 *
 * Retuning weights is a recompute, never a refetch — the provider scores under
 * it do not change.
 */
export function recomputeStale(limit = 5000, db: Database = getDb()): { recomputed: number; remaining: number } {
  const settings = getArchivistRatingSettings(db)
  if (!settings.enabled) return { recomputed: 0, remaining: 0 }

  const hash = weightsHash(settings)
  const mean = libraryMean(db)
  const rows = db.prepare(`
    SELECT DISTINCT e.subject_type AS subjectType, e.subject_id AS subjectId
    FROM external_ratings e
    LEFT JOIN composite_scores c
      ON c.subject_type = e.subject_type AND c.subject_id = e.subject_id AND c.weights_hash = ?
    WHERE c.subject_id IS NULL
    LIMIT ?
  `).all(hash, limit) as Array<{ subjectType: RatingSubjectType; subjectId: number }>

  let recomputed = 0
  const run = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      if (recomputeSubject(row.subjectType, row.subjectId, settings, db, mean)) recomputed++
    }
  })
  run(rows)

  const remaining = (db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT e.subject_type, e.subject_id FROM external_ratings e
      LEFT JOIN composite_scores c
        ON c.subject_type = e.subject_type AND c.subject_id = e.subject_id AND c.weights_hash = ?
      WHERE c.subject_id IS NULL
    )
  `).get(hash) as { n: number }).n

  if (recomputed > 0) logger.info(`Recomputed ${recomputed} Archivist Rating(s); ${remaining} still stale`)
  return { recomputed, remaining }
}

/** What the Library and the Player need to explain one title's score. */
export function ratingBreakdown(subjectType: RatingSubjectType, subjectId: number, db: Database = getDb()) {
  const settings = getArchivistRatingSettings(db)
  const scores = providerScores(subjectType, subjectId, db)
  const rating = scoreFrom(scores, MEDIA_TYPE[subjectType], settings, libraryMean(db))
  const weights = weightsFor(settings, MEDIA_TYPE[subjectType])
  const own = personalScore(subjectType, subjectId, db)
  return {
    /** What is on display: the Archivist Score where one is set, else the weighted rating. */
    score: own !== null ? Number((own * 2).toFixed(2)) : rating ? Number((rating.score / 10).toFixed(2)) : null,
    /** The viewer's own score on its 0-5 scale, or null when they have set none. */
    archivistScore: own,
    overridden: own !== null,
    weightedScore: rating ? Number((rating.score / 10).toFixed(2)) : null,
    scoreOutOf100: rating ? Number(rating.score.toFixed(1)) : null,
    confidence: rating ? Number(rating.confidence.toFixed(3)) : 0,
    wellSupported: rating?.wellSupported ?? false,
    providers: scores
      .filter(entry => (weights[entry.provider] ?? 0) > 0)
      .map(entry => ({ ...entry, weight: weights[entry.provider] })),
  }
}

export function ratingCoverage(db: Database = getDb()) {
  const rows = db.prepare(`
    SELECT subject_type AS subjectType, provider, COUNT(*) AS items
    FROM external_ratings GROUP BY subject_type, provider
  `).all() as Array<{ subjectType: RatingSubjectType; provider: RatingProvider; items: number }>
  const totals = db.prepare(`
    SELECT (SELECT COUNT(*) FROM films) AS films, (SELECT COUNT(*) FROM series) AS series
  `).get() as { films: number; series: number }
  const scored = db.prepare(`
    SELECT subject_type AS subjectType, COUNT(*) AS items, AVG(confidence) AS confidence
    FROM composite_scores GROUP BY subject_type
  `).all() as Array<{ subjectType: RatingSubjectType; items: number; confidence: number }>
  return { totals, byProvider: rows, scored }
}
