import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseProviderScore, scoreFrom, type ProviderScore } from '../src/services/archivist-rating.js'
import {
  DEFAULT_ARCHIVIST_RATING_SETTINGS,
  normaliseArchivistRatingSettings,
  weightsHash,
} from '../src/services/archivist-rating-settings.js'
import { isOmdbQuotaError, ratingsFromOmdbPayload } from '../src/services/omdb.js'

/**
 * The Archivist Rating's arithmetic. The properties worth pinning are the ones
 * that would be wrong quietly: renormalisation over absent providers, and the
 * shrinkage that stops a thinly-voted average outranking a well-voted one.
 */

const settings = DEFAULT_ARCHIVIST_RATING_SETTINGS
const MEAN = 60

const score = (provider: ProviderScore['provider'], norm: number, votes: number | null = null): ProviderScore =>
  ({ provider, scoreRaw: String(norm), scoreNorm: norm, votes })

test('provider scales are normalised onto 0-100', () => {
  assert.equal(normaliseProviderScore('imdb', 8.1), 81)
  assert.equal(normaliseProviderScore('tmdb', 7), 70)
  assert.equal(normaliseProviderScore('metacritic', 74), 74)
  assert.equal(normaliseProviderScore('rotten_tomatoes', 85), 85)

  // Out-of-scale values are refused rather than clamped into a plausible lie.
  assert.equal(normaliseProviderScore('imdb', 81), null)
  assert.equal(normaliseProviderScore('metacritic', 740), null)
  assert.equal(normaliseProviderScore('imdb', Number.NaN), null)
})

test('TVDB popularity is compressed rather than read as a rating', () => {
  // TVDB's score runs into six figures. Treating it linearly would make every
  // title either 0 or 100; the log keeps it on a comparable axis.
  const small = normaliseProviderScore('tvdb', 100)!
  const large = normaliseProviderScore('tvdb', 100_000)!
  assert.ok(small < large)
  assert.ok(large <= 100)
  assert.equal(normaliseProviderScore('tvdb', 0), 0)
})

test('weights are renormalised over the providers that replied', () => {
  // Only IMDb answered. The score is what IMDb said, not 45% of it.
  const lonely = scoreFrom([score('imdb', 81, 500_000)], 'films', settings, MEAN)!
  assert.ok(Math.abs(lonely.score - 81) < 0.2, `expected ~81, got ${lonely.score}`)
  assert.equal(lonely.providers.length, 1)

  // Confidence records what that cost: IMDb is 45 of the 100 weight configured.
  assert.ok(Math.abs(lonely.confidence - 0.45) < 0.001)
  assert.equal(lonely.wellSupported, false)
})

test('a full set of providers is a plain weighted mean', () => {
  const full = scoreFrom([
    score('imdb', 80, 500_000),
    score('metacritic', 70),
    score('rotten_tomatoes', 90),
    score('tmdb', 80, 5_000),
  ], 'films', settings, MEAN)!

  // (45×80 + 25×70 + 20×90 + 10×80) / 100, with the vote-bearing scores barely
  // shrunk at these vote counts.
  assert.ok(Math.abs(full.score - 79.9) < 0.5, `expected ~79.9, got ${full.score}`)
  assert.equal(full.confidence, 1)
  assert.equal(full.wellSupported, true)
})

test('a thinly-voted average is pulled toward the library mean', () => {
  const thin = scoreFrom([score('imdb', 89, 340)], 'films', settings, MEAN)!
  const solid = scoreFrom([score('imdb', 84, 340_000)], 'films', settings, MEAN)!

  // 8.9 from 340 voters must not outrank 8.4 from 340,000.
  assert.ok(thin.score < solid.score, `${thin.score} should be below ${solid.score}`)
  // It is pulled toward the mean, not down to it.
  assert.ok(thin.score > MEAN && thin.score < 89)
})

test('critic aggregates are never shrunk — they publish no vote counts', () => {
  const a = scoreFrom([score('metacritic', 74)], 'films', settings, MEAN)!
  assert.equal(a.score, 74)
})

test('providers weighted at zero contribute nothing', () => {
  // TVDB is weighted at zero by default, so a popularity score cannot move the
  // rating even though it is stored.
  const withTvdb = scoreFrom([score('imdb', 80, 500_000), score('tvdb', 99)], 'films', settings, MEAN)!
  const without = scoreFrom([score('imdb', 80, 500_000)], 'films', settings, MEAN)!
  assert.equal(withTvdb.score, without.score)
  assert.deepEqual(withTvdb.providers, ['imdb'])
})

test('a subject with no weighted provider has no score', () => {
  assert.equal(scoreFrom([], 'films', settings, MEAN), null)
  assert.equal(scoreFrom([score('tvdb', 99)], 'films', settings, MEAN), null)
})

test('series lean on IMDb where critic coverage is thin', () => {
  const asFilm = scoreFrom([score('imdb', 90, 500_000), score('metacritic', 60)], 'films', settings, MEAN)!
  const asSeries = scoreFrom([score('imdb', 90, 500_000), score('metacritic', 60)], 'series', settings, MEAN)!
  assert.ok(asSeries.score > asFilm.score, 'series weighting should favour IMDb more')
})

test('settings are clamped, and an all-zero weighting falls back', () => {
  const clamped = normaliseArchivistRatingSettings({
    films: { imdb: 500, metacritic: -3, rotten_tomatoes: 20, tmdb: 10, tvdb: 0 },
    minimumConfidence: 5,
    voteFloor: { imdb: -1, tmdb: 'x' },
  })
  assert.equal(clamped.films.imdb, 100)
  assert.equal(clamped.films.metacritic, 0)
  assert.equal(clamped.minimumConfidence, 1)
  assert.equal(clamped.voteFloor.imdb, 0)
  assert.equal(clamped.voteFloor.tmdb, DEFAULT_ARCHIVIST_RATING_SETTINGS.voteFloor.tmdb)

  // Every weight at zero would leave nothing scoreable, which is never meant.
  const zeroed = normaliseArchivistRatingSettings({
    films: { imdb: 0, metacritic: 0, rotten_tomatoes: 0, tmdb: 0, tvdb: 0 },
  })
  assert.deepEqual(zeroed.films, DEFAULT_ARCHIVIST_RATING_SETTINGS.films)
})

test('the weights hash changes with the weighting and not otherwise', () => {
  const base = weightsHash(DEFAULT_ARCHIVIST_RATING_SETTINGS)
  assert.equal(base, weightsHash(normaliseArchivistRatingSettings(DEFAULT_ARCHIVIST_RATING_SETTINGS)))
  assert.notEqual(base, weightsHash({
    ...DEFAULT_ARCHIVIST_RATING_SETTINGS,
    films: { ...DEFAULT_ARCHIVIST_RATING_SETTINGS.films, imdb: 44 },
  }))
})

test('OMDb payloads yield all three scores, and absent fields stay absent', () => {
  const ratings = ratingsFromOmdbPayload({
    imdbRating: '8.1', imdbVotes: '1,204,331', Metascore: '74',
    Ratings: [
      { Source: 'Internet Movie Database', Value: '8.1/10' },
      { Source: 'Rotten Tomatoes', Value: '85%' },
      { Source: 'Metacritic', Value: '74/100' },
    ],
  })
  assert.deepEqual(ratings.imdb, { score: 8.1, votes: 1204331 })
  assert.equal(ratings.rottenTomatoes, 85)
  assert.equal(ratings.metacritic, 74)

  // OMDb writes every missing field as the string "N/A".
  const sparse = ratingsFromOmdbPayload({ imdbRating: 'N/A', imdbVotes: 'N/A', Metascore: 'N/A', Ratings: [] })
  assert.deepEqual(sparse, { imdb: null, rottenTomatoes: null, metacritic: null })
})

test('Metacritic is read from Ratings[] when Metascore is absent', () => {
  const ratings = ratingsFromOmdbPayload({
    imdbRating: '7.0',
    Ratings: [{ Source: 'Metacritic', Value: '62/100' }],
  })
  assert.equal(ratings.metacritic, 62)
})

test('a quota refusal is told apart from an ordinary failure', () => {
  // OMDb answers an exhausted key with Response:"False" and this message. It
  // must not be retried: every further call that day is refused the same way.
  assert.equal(isOmdbQuotaError(new Error('OMDb: Request limit reached!')), true)
  assert.equal(isOmdbQuotaError(new Error('OMDb HTTP 503')), false)
  assert.equal(isOmdbQuotaError(new Error('OMDb: Incorrect IMDb ID.')), false)
})
