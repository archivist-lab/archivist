import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmdbFloorFor } from '../src/lists/archivist-rating-filter.js'
import {
  DEFAULT_ARCHIVIST_RATING_SETTINGS,
  RATING_PROVIDERS,
  type ArchivistRatingSettings,
  type ProviderWeights,
} from '../src/services/archivist-rating-settings.js'

/**
 * The TMDB floor implied by an Archivist Rating threshold.
 *
 * The bound has to be conservative in one direction only: it may leave work on
 * the table, but it must never refuse a title that could have qualified. The
 * sweep below is the test that matters — everything else is a worked example.
 */

const MEAN = 60

const withWeights = (films: Partial<ProviderWeights>): ArchivistRatingSettings => ({
  ...DEFAULT_ARCHIVIST_RATING_SETTINGS,
  films: { ...DEFAULT_ARCHIVIST_RATING_SETTINGS.films, ...films },
})

/** The best a candidate could score, given its TMDB value and perfect others. */
function bestPossible(tmdbOutOfTen: number, weights: ProviderWeights): number {
  const others = RATING_PROVIDERS.reduce((sum, provider) => provider === 'tmdb' ? sum : sum + weights[provider], 0)
  const total = weights.tmdb + others
  if (total === 0) return 0
  return (weights.tmdb * (tmdbOutOfTen * 10) + others * 100) / total / 10
}

test('below the floor, no combination of the other providers reaches the threshold', () => {
  // The soundness property, swept across weightings and thresholds rather than
  // asserted on one example: a floor that is even slightly too high silently
  // drops titles that would have qualified.
  for (const tmdb of [5, 10, 20, 30, 50, 70, 90]) {
    for (const imdb of [0, 10, 45, 80]) {
      for (const metacritic of [0, 25, 60]) {
        const settings = withWeights({ tmdb, imdb, metacritic, rotten_tomatoes: 20, tvdb: 0 })
        for (const threshold of [6, 7, 8, 8.5, 9, 9.4, 9.8, 10]) {
          const floor = tmdbFloorFor(threshold, 'film', settings, MEAN)
          if (floor == null) continue

          // Just below the floor must be genuinely unreachable...
          const justBelow = Math.max(0, floor - 0.01)
          assert.ok(
            bestPossible(justBelow, settings.films) < threshold,
            `tmdb=${tmdb} imdb=${imdb} mc=${metacritic} t=${threshold}: ${justBelow} could still reach ${threshold}`,
          )
          // ...and the floor must sit above the mean, or a thinly-voted score
          // could be adjusted up over it.
          assert.ok(floor * 10 > MEAN, `floor ${floor} must sit above the library mean`)
        }
      }
    }
  }
})

test('the floor is not needlessly tight — at the floor itself the threshold is reachable', () => {
  for (const tmdb of [20, 50, 90]) {
    const settings = withWeights({ tmdb, imdb: 45, metacritic: 25, rotten_tomatoes: 20, tvdb: 0 })
    for (const threshold of [8.5, 9, 9.5]) {
      const floor = tmdbFloorFor(threshold, 'film', settings, MEAN)
      if (floor == null) continue
      // Rounding is downward, so allow the sliver it can give away.
      assert.ok(
        bestPossible(floor + 0.01, settings.films) >= threshold,
        `tmdb=${tmdb} t=${threshold}: floor ${floor} is tighter than it needs to be`,
      )
    }
  }
})

test('the default film weighting yields no floor at nine, and says so by returning null', () => {
  // TMDB carries 10 of 100, so a perfect IMDb, Metacritic and Rotten Tomatoes
  // reach exactly 9.0 with TMDB at zero. Nothing can be refused on TMDB alone.
  assert.equal(tmdbFloorFor(9, 'film', DEFAULT_ARCHIVIST_RATING_SETTINGS, MEAN), null)
  assert.equal(tmdbFloorFor(9.5, 'film', DEFAULT_ARCHIVIST_RATING_SETTINGS, MEAN), null)

  // It only bites near the very top of the scale.
  assert.equal(tmdbFloorFor(9.9, 'film', DEFAULT_ARCHIVIST_RATING_SETTINGS, MEAN), 9)
})

test('a heavier TMDB weighting makes the floor bite sooner', () => {
  const even = withWeights({ tmdb: 50, imdb: 50, metacritic: 0, rotten_tomatoes: 0, tvdb: 0 })
  assert.equal(tmdbFloorFor(8.5, 'film', even, MEAN), 7)
  // At 8.0 the floor lands exactly on the mean, which is not safe to use.
  assert.equal(tmdbFloorFor(8, 'film', even, MEAN), null)
})

test('a floor at or below the library mean is refused, because shrinkage can lift a title over it', () => {
  const settings = withWeights({ tmdb: 50, imdb: 50, metacritic: 0, rotten_tomatoes: 0, tvdb: 0 })
  // A library that rates everything highly moves the mean, and with it the
  // point at which the floor becomes trustworthy.
  assert.equal(tmdbFloorFor(8.5, 'film', settings, 60), 7)
  assert.equal(tmdbFloorFor(8.5, 'film', settings, 75), null)
})

test('TMDB carrying no weight constrains nothing', () => {
  const settings = withWeights({ tmdb: 0, imdb: 60, metacritic: 25, rotten_tomatoes: 15, tvdb: 0 })
  assert.equal(tmdbFloorFor(9.9, 'film', settings, MEAN), null)
})

test('no threshold means no floor', () => {
  assert.equal(tmdbFloorFor(undefined, 'film', DEFAULT_ARCHIVIST_RATING_SETTINGS, MEAN), null)
})

test('series use their own weighting', () => {
  // Series weight TMDB at zero by default, so no threshold produces a floor.
  assert.equal(tmdbFloorFor(9.9, 'series', DEFAULT_ARCHIVIST_RATING_SETTINGS, MEAN), null)
})
