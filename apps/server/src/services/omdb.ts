import { withProviderRetry } from '../shared/provider-limiter.js'

/**
 * OMDb — one call by IMDb id returns IMDb, Rotten Tomatoes and Metacritic.
 *
 * The Rotten Tomatoes figure OMDb carries is the Tomatometer, the share of
 * critics who were positive. It is not an average score, and the audience score
 * is not exposed at all.
 */

export interface OmdbRatings {
  imdb: { score: number; votes: number | null } | null
  /** Tomatometer, 0-100. */
  rottenTomatoes: number | null
  /** Metascore, 0-100. */
  metacritic: number | null
}

export const EMPTY_OMDB_RATINGS: OmdbRatings = { imdb: null, rottenTomatoes: null, metacritic: null }

export function omdbApiKey(): string {
  return process.env.OMDB_API_KEY?.trim() ?? ''
}

export function omdbConfigured(): boolean {
  return omdbApiKey().length > 0
}

function omdbBase(): string {
  return (process.env.OMDB_BASE_URL ?? 'https://www.omdbapi.com').replace(/\/$/, '')
}

/** OMDb writes every absent field as the string "N/A" rather than omitting it. */
function present(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
  return text && text !== 'N/A' ? text : null
}

function numeric(value: unknown): number | null {
  const text = present(value)
  if (text === null) return null
  const parsed = Number(text.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Pull the three scores out of an OMDb payload.
 *
 * Exported separately from the fetch so payloads already stored by the
 * catalogue can be mined without going back to the network.
 */
export function ratingsFromOmdbPayload(payload: Record<string, unknown>): OmdbRatings {
  const ratings = Array.isArray(payload.Ratings) ? payload.Ratings as Array<Record<string, unknown>> : []
  const bySource = (name: string) => present(ratings.find(entry => entry.Source === name)?.Value)

  const imdbScore = numeric(payload.imdbRating)
  const tomatometer = bySource('Rotten Tomatoes')
  // Metacritic appears both as a bare `Metascore` and as "74/100" in Ratings[].
  const metascore = numeric(payload.Metascore) ?? numeric(bySource('Metacritic')?.split('/')[0])

  return {
    imdb: imdbScore === null ? null : { score: imdbScore, votes: numeric(payload.imdbVotes) },
    rottenTomatoes: tomatometer === null ? null : numeric(tomatometer.replace('%', '')),
    metacritic: metascore,
  }
}

/** Fetch the scores OMDb holds for an IMDb id. Returns null when it knows none. */
export async function fetchOmdbRatings(imdbId: string, signal?: AbortSignal): Promise<OmdbRatings | null> {
  const key = omdbApiKey()
  if (!key) throw new Error('OMDB_API_KEY is not configured')

  const params = new URLSearchParams({ apikey: key, i: imdbId, r: 'json' })
  // withProviderRetry already applies the concurrency gate and circuit breaker.
  const payload = await withProviderRetry('omdb', async () => {
    const response = await fetch(`${omdbBase()}/?${params}`, { signal })
    if (!response.ok) throw new Error(`OMDb HTTP ${response.status}`)
    return await response.json() as Record<string, unknown>
  }, signal)

  if (payload.Response === 'False') {
    const error = present(payload.Error) ?? 'no result'
    // A title OMDb has never heard of is an answer, not a failure — retrying it
    // every cycle would burn the daily quota on titles that will never resolve.
    if (/not found/i.test(error)) return null
    throw new Error(`OMDb: ${error}`)
  }

  return ratingsFromOmdbPayload(payload)
}

/**
 * Whether an error is OMDb refusing on quota rather than failing.
 *
 * Worth telling apart: a quota refusal means every further call today will be
 * refused too, so the right response is to stop asking, not to retry.
 */
export function isOmdbQuotaError(error: unknown): boolean {
  return /request limit reached|limit reached/i.test(error instanceof Error ? error.message : String(error))
}


