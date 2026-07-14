import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRelease } from '../src/release-pipeline/parser.js'
import { buildSeriesBrowseBases, isOpenEndedSeriesRange } from '../src/release-pipeline/series-cascade.js'
import { DEFAULT_TIERS } from '../src/shared/settings.js'

test('multi-season range S01-S06 expands to all covered seasons', () => {
  const p = parseRelease('The.Sopranos.S01-S06.COMPLETE.1080p.BluRay.x264-GROUP')
  assert.equal(p.kind, 'series')
  assert.equal(p.isSeasonPack, true)
  assert.equal(p.season, 1)
  assert.deepEqual(p.seasons, [1, 2, 3, 4, 5, 6])
  assert.deepEqual(p.episodes, [])
  assert.equal(p.titleNormalized, 'the sopranos')
})

test('arbitrary ranges work: S01-S02, S01-S08, S03-S05', () => {
  assert.deepEqual(parseRelease('Show.S01-S02.720p').seasons, [1, 2])
  assert.deepEqual(parseRelease('Show.S01-S08.1080p.WEB-DL').seasons, [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(parseRelease('Show.S03-S05.2160p').seasons, [3, 4, 5])
})

test('compact and spaced forms: S1-S8, S01 - S04', () => {
  assert.deepEqual(parseRelease('Game.of.Thrones.S1-S8.2160p.REMUX').seasons, [1, 2, 3, 4, 5, 6, 7, 8])
  const spaced = parseRelease('The Wire S01 - S05 1080p')
  assert.deepEqual(spaced.seasons, [1, 2, 3, 4, 5])
  assert.equal(spaced.titleNormalized, 'the wire')
})

test('wordy forms: "Seasons 1-5", "Season 2 to 4"', () => {
  const p1 = parseRelease('The Wire Seasons 1-5 DVDRip XviD')
  assert.deepEqual(p1.seasons, [1, 2, 3, 4, 5])
  assert.equal(p1.isSeasonPack, true)
  const p2 = parseRelease('Fargo Season 2 to 4 1080p')
  assert.deepEqual(p2.seasons, [2, 3, 4])
})

test('ambiguous "S01-06" (no second S) stays a single-season pack', () => {
  const p = parseRelease('The.Office.S01-06.720p.WEB')
  assert.equal(p.season, 1)
  assert.deepEqual(p.seasons, [1])
  assert.equal(p.isSeasonPack, true)
})

test('inverted range falls back to single-season parse', () => {
  const p = parseRelease('Show.S06-S01.1080p')
  assert.equal(p.isSeasonPack, true)
  assert.deepEqual(p.seasons, [6])
})

test('single episodes and single-season packs still populate seasons', () => {
  const ep = parseRelease('Breaking.Bad.S02E05.720p.HDTV.x264')
  assert.deepEqual(ep.seasons, [2])
  assert.deepEqual(ep.episodes, [5])
  assert.equal(ep.isSeasonPack, false)

  const pack = parseRelease('Breaking.Bad.S03.1080p.BluRay')
  assert.deepEqual(pack.seasons, [3])
  assert.equal(pack.isSeasonPack, true)

  const loose = parseRelease('Show.2x07.HDTV')
  assert.deepEqual(loose.seasons, [2])
})

test('range detection never hijacks S01E01-style episode tokens', () => {
  const p = parseRelease('Show.S01.S02E05.720p') // stray token before a real episode anchor
  assert.equal(p.episodes.length, 1)
  assert.equal(p.isSeasonPack, false)
})

test('daily and movie parses are unaffected', () => {
  const daily = parseRelease('The.Daily.Show.2024.05.04.1080p.WEB')
  assert.equal(daily.airDate, '2024-05-04')
  assert.deepEqual(daily.seasons, [])

  const movie = parseRelease('Inception.2010.1080p.BluRay.x264-GROUP')
  assert.equal(movie.kind, 'movie')
  assert.deepEqual(movie.seasons, [])
})

test('whole-series browse offers the open-ended range pack, then exact seasons, then bare title', () => {
  assert.deepEqual(buildSeriesBrowseBases('Example Show', [1, 2, 3]), [
    'Example Show S01-S',
    'Example Show S01',
    'Example Show S02',
    'Example Show S03',
    'Example Show',
  ])
  assert.equal(isOpenEndedSeriesRange('Example Show S01-S'), true)
  assert.equal(isOpenEndedSeriesRange('Example Show S01-S03'), false)
})

test('built-in quality tier keywords match the Settings UI defaults', () => {
  assert.deepEqual(DEFAULT_TIERS.tier1.map(term => term.term), [
    'SARTRE', 'QxR', 'SAMPA', 'Prof', 'TAoE', 'SM737', 'HeVK',
  ])
  assert.deepEqual(DEFAULT_TIERS.tier2.map(term => term.term), [
    'POIASD', 'UTR', '"[SEV]"',
  ])
  assert.deepEqual(DEFAULT_TIERS.tier3.map(term => term.term), [
    'YIFY', 'PSA', 'MeGusta', 'ELiTE', 'KONTRAST', 'NeoNoir',
  ])
  for (const term of [...DEFAULT_TIERS.tier1, ...DEFAULT_TIERS.tier2, ...DEFAULT_TIERS.tier3]) {
    assert.deepEqual(term.mediaTypes, ['films', 'series'])
  }
})
