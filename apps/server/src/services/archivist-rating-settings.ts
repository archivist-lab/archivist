import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

/**
 * The Archivist Rating — one 0-100 score per film or series, built by weighting
 * the provider scores the library has collected.
 *
 * Two properties of the weighting matter more than the numbers themselves:
 *
 * - Weights are renormalised over the providers that actually replied. Scoring a
 *   film that only IMDb knows about as `0.45 × imdb` would push every obscure
 *   title to the bottom and read as "obscure films are bad" rather than
 *   "obscure films have thin data".
 * - Ratings carrying few votes are pulled toward the library mean, so an 8.9
 *   from 340 voters does not outrank an 8.4 from 340,000.
 */

export const RATING_PROVIDERS = ['imdb', 'metacritic', 'rotten_tomatoes', 'tmdb', 'tvdb'] as const

/**
 * The profile whose Archivist Score overrides the weighted rating.
 *
 * Declared here rather than beside the scoring logic so that tagging can read
 * it without the two modules importing each other.
 */
export const SCORING_PROFILE = 'default'
export type RatingProvider = typeof RATING_PROVIDERS[number]

export const SCORED_MEDIA_TYPES = ['films', 'series'] as const
export type ScoredMediaType = typeof SCORED_MEDIA_TYPES[number]

export type ProviderWeights = Record<RatingProvider, number>

export interface ArchivistRatingSettings {
  /** When false the composite is left alone and provider scores show through. */
  enabled: boolean
  films: ProviderWeights
  series: ProviderWeights
  /**
   * Vote count at which a provider's own average is trusted outright. Below it
   * the score is pulled toward the library mean in proportion to the shortfall.
   * Only IMDb and TMDB report vote counts; the critic aggregates do not.
   */
  voteFloor: { imdb: number; tmdb: number }
  /**
   * Share of the weighting that must have replied before a composite counts as
   * well-supported. Below it the score is still published but flagged, so a
   * title resting on one provider can be told apart from one resting on four.
   */
  minimumConfidence: number
  /**
   * Calls OMDb may be given in any rolling day, across library scoring and
   * List candidate lookups alike.
   *
   * The default suits a free key's metered allowance. A Patreon key's is far
   * higher, and raising this is what lets a large List resolve in one pass
   * instead of filling in over several days.
   */
  dailyOmdbBudget: number
}

export const DEFAULT_ARCHIVIST_RATING_SETTINGS: ArchivistRatingSettings = {
  enabled: true,
  // IMDb leads on depth of coverage. Metacritic is a true 0-100 critic mean and
  // the best-behaved input. The Tomatometer is the share of critics who were
  // positive rather than an average, so it clusters at the extremes and sits
  // below Metacritic. TMDB correlates heavily with IMDb, so it only breaks ties.
  films:  { imdb: 45, metacritic: 25, rotten_tomatoes: 20, tmdb: 10, tvdb: 0 },
  // OMDb's critic coverage for television is thin and episodic, so series lean
  // harder on IMDb. TVDB's score is popularity, not quality, and stays at zero.
  series: { imdb: 60, metacritic: 25, rotten_tomatoes: 15, tmdb: 0, tvdb: 0 },
  voteFloor: { imdb: 1000, tmdb: 50 },
  minimumConfidence: 0.5,
  // Conservative because a free OMDb key is metered daily; the environment can
  // seed a different default, and the setting overrides both.
  dailyOmdbBudget: Math.max(0, Number.parseInt(process.env.ARCHIVIST_OMDB_DAILY_BUDGET ?? '', 10) || 900),
}

export const MAX_WEIGHT = 100
const SETTINGS_KEY = 'archivistRating'

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function normaliseWeights(input: unknown, fallback: ProviderWeights): ProviderWeights {
  const raw = (input ?? {}) as Partial<ProviderWeights>
  const weights = {} as ProviderWeights
  for (const provider of RATING_PROVIDERS) {
    weights[provider] = Math.round(clamp(raw[provider], 0, MAX_WEIGHT, fallback[provider]))
  }
  // Every weight at zero would make the score undefined for everything, which
  // is never what an operator means by "I turned some of these down".
  if (RATING_PROVIDERS.every(provider => weights[provider] === 0)) return { ...fallback }
  return weights
}

export function normaliseArchivistRatingSettings(input: unknown): ArchivistRatingSettings {
  const raw = (input ?? {}) as Partial<ArchivistRatingSettings>
  const defaults = DEFAULT_ARCHIVIST_RATING_SETTINGS
  return {
    enabled: raw.enabled !== false,
    films: normaliseWeights(raw.films, defaults.films),
    series: normaliseWeights(raw.series, defaults.series),
    voteFloor: {
      imdb: Math.round(clamp(raw.voteFloor?.imdb, 0, 1_000_000, defaults.voteFloor.imdb)),
      tmdb: Math.round(clamp(raw.voteFloor?.tmdb, 0, 1_000_000, defaults.voteFloor.tmdb)),
    },
    minimumConfidence: clamp(raw.minimumConfidence, 0, 1, defaults.minimumConfidence),
    dailyOmdbBudget: Math.round(clamp(raw.dailyOmdbBudget, 0, 1_000_000, defaults.dailyOmdbBudget)),
  }
}

export function getArchivistRatingSettings(db: Database = getDb()): ArchivistRatingSettings {
  return normaliseArchivistRatingSettings(
    getAppSetting<Partial<ArchivistRatingSettings>>(SETTINGS_KEY, DEFAULT_ARCHIVIST_RATING_SETTINGS, 0, db),
  )
}

export function saveArchivistRatingSettings(input: unknown): ArchivistRatingSettings {
  const settings = normaliseArchivistRatingSettings(input)
  setAppSetting(SETTINGS_KEY, settings, 0, getDb())
  return settings
}

export function weightsFor(settings: ArchivistRatingSettings, mediaType: ScoredMediaType): ProviderWeights {
  return mediaType === 'films' ? settings.films : settings.series
}

/**
 * Identifies the settings a stored composite was computed under.
 *
 * Every row carries it, so changing a weight invalidates exactly the rows that
 * need recomputing without touching the provider scores underneath them.
 */
export function weightsHash(settings: ArchivistRatingSettings): string {
  const canonical = JSON.stringify([
    settings.enabled,
    RATING_PROVIDERS.map(provider => settings.films[provider]),
    RATING_PROVIDERS.map(provider => settings.series[provider]),
    settings.voteFloor.imdb,
    settings.voteFloor.tmdb,
    settings.minimumConfidence,
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
