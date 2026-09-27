import type { Database } from 'better-sqlite3'
import axios from 'axios'
import { createLogger } from '@archivist/core'
import type { ListMediaType } from '@archivist/contracts'
import { getDb } from '../db.js'
import { getCatalogueDb } from '../catalogue-database.js'
import { withProviderRetry } from '../shared/provider-limiter.js'
import { EMPTY_OMDB_RATINGS, fetchOmdbRatings, isOmdbQuotaError, omdbConfigured, ratingsFromOmdbPayload, type OmdbRatings } from '../services/omdb.js'
import { budgetRemaining } from '../services/archivist-rating-refresh.js'
import { normaliseProviderScore, scoreFrom, type ProviderScore } from '../services/archivist-rating.js'
import { getArchivistRatingSettings } from '../services/archivist-rating-settings.js'
import type { ListMember } from './types.js'

/**
 * The weighted Archivist Rating for a List candidate.
 *
 * The weighting is built from public provider scores — IMDb, Rotten Tomatoes,
 * Metacritic and TMDB — so it exists for any title those providers know, not
 * only the ones this library holds. That is what lets a List discover, say,
 * every film of the nineties that scores above nine rather than only ranking
 * the ones already owned.
 *
 * Resolution runs cheapest-first:
 *
 *   1. the library's own computed score, where the title is held;
 *   2. an OMDb payload the Catalogue already stored;
 *   3. a fresh lookup, within the day's OMDb budget, cached for next time.
 *
 * The personal Archivist Score deliberately does not apply here. A threshold on
 * a List asks what the world makes of a title, not what you have already
 * decided about it — and most candidates are titles you have never rated.
 */

const logger = createLogger('ListCandidateScores')

/** The scores a candidate can carry, as stored in the cache. */
interface CandidateRatings {
  imdb?: { score: number; votes: number | null }
  rottenTomatoes?: number
  metacritic?: number
  tmdb?: { score: number; votes: number | null }
}

function tmdbBase(): string {
  return (process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3').replace(/\/$/, '')
}

function toProviderScores(ratings: CandidateRatings): ProviderScore[] {
  const scores: ProviderScore[] = []
  const add = (provider: ProviderScore['provider'], raw: number, votes: number | null) => {
    const normalised = normaliseProviderScore(provider, raw)
    if (normalised !== null) scores.push({ provider, scoreRaw: String(raw), scoreNorm: normalised, votes })
  }
  if (ratings.imdb) add('imdb', ratings.imdb.score, ratings.imdb.votes)
  if (ratings.rottenTomatoes != null) add('rotten_tomatoes', ratings.rottenTomatoes, null)
  if (ratings.metacritic != null) add('metacritic', ratings.metacritic, null)
  if (ratings.tmdb) add('tmdb', ratings.tmdb.score, ratings.tmdb.votes)
  return scores
}

function fromOmdb(ratings: OmdbRatings): CandidateRatings {
  return {
    imdb: ratings.imdb ?? undefined,
    rottenTomatoes: ratings.rottenTomatoes ?? undefined,
    metacritic: ratings.metacritic ?? undefined,
  }
}

/** Weighted score on the 0-10 scale the app displays, or null when unscoreable. */
function weigh(ratings: CandidateRatings, mediaType: ListMediaType, db: Database): number | null {
  const settings = getArchivistRatingSettings(db)
  // The library mean the shrinkage pulls toward is the library's own, so a
  // candidate is judged on the same footing as everything already held.
  const mean = (db.prepare(`
    SELECT AVG(score_norm) AS mean, COUNT(*) AS n FROM external_ratings WHERE provider IN ('imdb', 'tmdb')
  `).get() as { mean: number | null; n: number })
  const scored = scoreFrom(
    toProviderScores(ratings),
    mediaType === 'film' ? 'films' : 'series',
    settings,
    mean.n >= 20 && mean.mean !== null ? mean.mean : 60,
  )
  return scored ? Number((scored.score / 10).toFixed(2)) : null
}

// ── The three sources ─────────────────────────────────────────────────────────

/** Scores already computed for titles the library holds, keyed by TMDB id. */
function fromLibrary(tmdbIds: number[], mediaType: ListMediaType, db: Database): Map<number, number> {
  const found = new Map<number, number>()
  const table = mediaType === 'film' ? 'films' : 'series'
  const subject = mediaType === 'film' ? 'film' : 'series'
  for (let index = 0; index < tmdbIds.length; index += 500) {
    const chunk = tmdbIds.slice(index, index + 500)
    const rows = db.prepare(`
      SELECT t.tmdb_id AS tmdbId, c.score AS score
      FROM ${table} t
      JOIN composite_scores c ON c.subject_type = ? AND c.subject_id = t.id
      WHERE t.tmdb_id IN (${chunk.map(() => '?').join(',')})
    `).all(subject, ...chunk) as Array<{ tmdbId: number; score: number }>
    for (const row of rows) {
      const score = Number((row.score / 10).toFixed(2))
      const existing = found.get(row.tmdbId)
      // The same title in two libraries is scored once per library; the better
      // score is the one that decides membership.
      if (existing == null || score > existing) found.set(row.tmdbId, score)
    }
  }
  return found
}

interface CachedCandidate { imdbId: string | null; ratings: CandidateRatings; outcome: string }

function fromCache(tmdbIds: number[], mediaType: ListMediaType, db: Database): Map<number, CachedCandidate> {
  const found = new Map<number, CachedCandidate>()
  for (let index = 0; index < tmdbIds.length; index += 500) {
    const chunk = tmdbIds.slice(index, index + 500)
    const rows = db.prepare(`
      SELECT tmdb_id AS tmdbId, imdb_id AS imdbId, ratings, outcome FROM list_candidate_ratings
      WHERE media_type = ? AND tmdb_id IN (${chunk.map(() => '?').join(',')})
    `).all(mediaType, ...chunk) as Array<{ tmdbId: number; imdbId: string | null; ratings: string; outcome: string }>
    for (const row of rows) {
      let ratings: CandidateRatings = {}
      try { ratings = JSON.parse(row.ratings) as CandidateRatings } catch { /* a corrupt row re-resolves */ }
      found.set(row.tmdbId, { imdbId: row.imdbId, ratings, outcome: row.outcome })
    }
  }
  return found
}

/**
 * OMDb payloads the Catalogue already stored, by TMDB id.
 *
 * The Catalogue keeps every enrichment response whole, so a title it has seen
 * costs nothing to score. Free scores before paid ones.
 */
function fromCatalogue(tmdbIds: number[]): Map<number, { imdbId: string; ratings: CandidateRatings }> {
  const found = new Map<number, { imdbId: string; ratings: CandidateRatings }>()
  if (tmdbIds.length === 0) return found
  let db: Database
  try { db = getCatalogueDb() } catch { return found }

  for (let index = 0; index < tmdbIds.length; index += 400) {
    const chunk = tmdbIds.slice(index, index + 400)
    let rows: Array<{ tmdbId: string; imdbId: string; payload: string }>
    try {
      rows = db.prepare(`
        SELECT tmdb.external_id AS tmdbId, imdb.external_id AS imdbId, payload.payload_json AS payload
        FROM catalog_item_external_ids tmdb
        JOIN catalog_item_external_ids imdb ON imdb.item_id = tmdb.item_id AND imdb.source = 'imdb'
        JOIN catalog_source_payloads payload ON payload.source = 'omdb' AND payload.source_id = imdb.external_id
        WHERE tmdb.source = 'tmdb' AND tmdb.external_id IN (${chunk.map(() => '?').join(',')})
      `).all(...chunk.map(String)) as Array<{ tmdbId: string; imdbId: string; payload: string }>
    } catch (err) {
      logger.warn(`Catalogue lookup unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return found
    }
    for (const row of rows) {
      try {
        found.set(Number(row.tmdbId), {
          imdbId: row.imdbId,
          ratings: fromOmdb(ratingsFromOmdbPayload(JSON.parse(row.payload) as Record<string, unknown>)),
        })
      } catch { /* an unreadable payload falls through to a fresh lookup */ }
    }
  }
  return found
}

/** A candidate's IMDb id, which TMDB's discover rows never carry. */
async function imdbIdFor(tmdbId: number, mediaType: ListMediaType, signal?: AbortSignal): Promise<string | null> {
  const path = mediaType === 'film' ? 'movie' : 'tv'
  const response = await withProviderRetry('tmdb', () => axios.get(`${tmdbBase()}/${path}/${tmdbId}/external_ids`, {
    params: { api_key: process.env.TMDB_API_KEY ?? '' }, timeout: 15_000, signal,
  }), signal)
  const imdbId = (response.data as { imdb_id?: string })?.imdb_id
  return typeof imdbId === 'string' && imdbId.startsWith('tt') ? imdbId : null
}

function remember(
  tmdbId: number,
  mediaType: ListMediaType,
  imdbId: string | null,
  ratings: CandidateRatings,
  outcome: string,
  db: Database,
): void {
  db.prepare(`
    INSERT INTO list_candidate_ratings (media_type, tmdb_id, imdb_id, ratings, outcome, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_type, tmdb_id) DO UPDATE SET
      imdb_id = excluded.imdb_id, ratings = excluded.ratings,
      outcome = excluded.outcome, fetched_at = excluded.fetched_at
  `).run(mediaType, tmdbId, imdbId, JSON.stringify(ratings), outcome)
}

export interface CandidateScoreResult {
  scores: Map<number, number>
  /** Candidates left unresolved because the day's OMDb budget ran out. */
  deferred: number
}

/**
 * Weighted scores for a set of List candidates, on the 0-10 scale.
 *
 * TMDB's own vote average rides along on the discover row, so it costs nothing
 * and is folded in wherever it is present.
 */
export async function resolveCandidateScores(
  members: ListMember[],
  mediaType: ListMediaType,
  db: Database = getDb(),
  signal?: AbortSignal,
): Promise<CandidateScoreResult> {
  const tmdbIds = [...new Set(members.map(member => member.tmdbId))]
  const providerRating = new Map(members.map(member => [member.tmdbId, member] as const))
  const scores = fromLibrary(tmdbIds, mediaType, db)

  const tmdbOf = (tmdbId: number): CandidateRatings['tmdb'] => {
    const member = providerRating.get(tmdbId)
    return member?.providerRating != null
      ? { score: member.providerRating, votes: member.providerVotes ?? null }
      : undefined
  }

  const unresolved = tmdbIds.filter(id => !scores.has(id))
  const cached = fromCache(unresolved, mediaType, db)
  const stillUnknown: number[] = []

  for (const tmdbId of unresolved) {
    const entry = cached.get(tmdbId)
    if (!entry) { stillUnknown.push(tmdbId); continue }
    // A previous lookup that found nothing is an answer, not a gap to retry.
    if (entry.outcome !== 'scored') continue
    const score = weigh({ ...entry.ratings, tmdb: tmdbOf(tmdbId) }, mediaType, db)
    if (score !== null) scores.set(tmdbId, score)
  }

  // Free scores next: anything the Catalogue already holds.
  const catalogued = fromCatalogue(stillUnknown)
  const needFetch: number[] = []
  for (const tmdbId of stillUnknown) {
    const entry = catalogued.get(tmdbId)
    if (!entry) { needFetch.push(tmdbId); continue }
    remember(tmdbId, mediaType, entry.imdbId, entry.ratings, 'catalogue-payload', db)
    const score = weigh({ ...entry.ratings, tmdb: tmdbOf(tmdbId) }, mediaType, db)
    if (score !== null) scores.set(tmdbId, score)
  }

  if (needFetch.length === 0 || !omdbConfigured()) {
    return { scores, deferred: omdbConfigured() ? 0 : needFetch.length }
  }

  // Paid scores last, and only as far as the day's budget reaches. What is not
  // resolved now is resolved on a later refresh rather than being lost.
  let budget = budgetRemaining()
  let deferred = 0
  for (const tmdbId of needFetch) {
    if (budget <= 0) { deferred += 1; continue }
    try {
      const imdbId = await imdbIdFor(tmdbId, mediaType, signal)
      if (!imdbId) { remember(tmdbId, mediaType, null, {}, 'no-imdb-id', db); continue }

      budget -= 1
      const found = await fetchOmdbRatings(imdbId, signal)
      const ratings = fromOmdb(found ?? EMPTY_OMDB_RATINGS)
      const hasAny = ratings.imdb != null || ratings.rottenTomatoes != null || ratings.metacritic != null
      remember(tmdbId, mediaType, imdbId, ratings, found === null ? 'unknown-to-omdb' : hasAny ? 'scored' : 'no-scores', db)
      if (!hasAny) continue

      const score = weigh({ ...ratings, tmdb: tmdbOf(tmdbId) }, mediaType, db)
      if (score !== null) scores.set(tmdbId, score)
    } catch (err) {
      if (isOmdbQuotaError(err)) {
        // The key is spent for the day; the rest waits for the next refresh.
        deferred += needFetch.length - needFetch.indexOf(tmdbId)
        break
      }
      logger.warn(`Could not score TMDB ${tmdbId}: ${err instanceof Error ? err.message : String(err)}`)
      deferred += 1
    }
  }

  return { scores, deferred }
}
