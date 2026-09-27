import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTierFilter } from '../src/shared/tier-filter.js'

/**
 * The `tier` query parameter. Shared by the film and series listings, so the
 * two cannot disagree about what a value means.
 */

test('a tier list parses to the tiers to keep', () => {
  assert.deepEqual(parseTierFilter('1'), [1])
  assert.deepEqual(parseTierFilter('1,2'), [1, 2])
  assert.deepEqual(parseTierFilter('0'), [0])
  assert.deepEqual(parseTierFilter(' 1 , 3 '), [1, 3])
})

test('absent, empty and unrecognised values mean no filter, never an error', () => {
  // A stale bookmark should show the library, not a failure.
  assert.deepEqual(parseTierFilter(undefined), [])
  assert.deepEqual(parseTierFilter(''), [])
  assert.deepEqual(parseTierFilter('   '), [])
  assert.deepEqual(parseTierFilter('nonsense'), [])
  assert.deepEqual(parseTierFilter('9'), [])
  assert.deepEqual(parseTierFilter(4), [])
  assert.deepEqual(parseTierFilter(['1']), [])
})

test('"all" means no filter even alongside other values', () => {
  // The UI always sends the parameter, and "all" plus a tier is still "all".
  assert.deepEqual(parseTierFilter('all'), [])
  assert.deepEqual(parseTierFilter('all,1'), [])
})

test('repeats collapse, so a value is bound once', () => {
  assert.deepEqual(parseTierFilter('1,1,2,2'), [1, 2])
})

test('a tier outside the scale is dropped without dropping its neighbours', () => {
  assert.deepEqual(parseTierFilter('1,7,3'), [1, 3])
})
