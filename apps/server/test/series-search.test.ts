import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seriesSearchQueryVariants, validateSeriesRelease } from '../src/modules/series/routes.js'

test('series search removes apostrophes for the preferred indexer query', () => {
  assert.deepEqual(seriesSearchQueryVariants("X-Men '97 S02E05"), [
    'X-Men 97 S02E05',
    "X-Men '97 S02E05",
  ])
})

test('series validation treats apostrophe-free release titles as the same show', () => {
  assert.equal(validateSeriesRelease(
    'X-Men 97 S02E05 1080p x265-ELiTE',
    "X-Men '97",
    "X-Men '97 S02E05",
  ), true)
  assert.equal(validateSeriesRelease(
    'X-Men 97 S02E04 1080p x265-ELiTE',
    "X-Men '97",
    "X-Men '97 S02E05",
  ), false)
})

test('series validation preserves season-range pack matching', () => {
  assert.equal(validateSeriesRelease(
    'X-Men.97.S01-S02.Complete.1080p.WEB-DL.x265-GROUP',
    "X-Men '97",
    "X-Men '97 S02E05",
  ), true)
})
