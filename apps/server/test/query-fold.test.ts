import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldQuery } from '@torrentstack/indexer-engine'
import { normalizeTitle, punctuationSafeQueryVariants } from '../src/release-pipeline/parser.js'

test('searches go out in the plain letters release names are written in', () => {
  const cases: Array<[string, string]> = [
    ['JAŸ-Z', 'JAY-Z'],
    ['Beyoncé', 'Beyonce'],
    ['Mötley Crüe', 'Motley Crue'],
    ['Røyksopp', 'Royksopp'],
    ['Straße', 'Strasse'],
    ['Æon Flux', 'Aeon Flux'],
    ['Łódź', 'Lodz'],
    ['Alien³', 'Alien3'],
    ['Ｆｕｌｌ Metal', 'Full Metal'],
    ['Don’t Look Up', "Don't Look Up"],
    ['Spider‐Man: No Way Home', 'Spider-Man: No Way Home'],
    ['Ÿ', 'Y'],
  ]
  for (const [catalogue, sent] of cases) assert.equal(foldQuery(catalogue), sent, catalogue)
})

test('other scripts go out exactly as written: their marks are part of the letter', () => {
  for (const title of ['千と千尋の神隠し', 'ガンダム', 'हिन्दी', 'Ёлки', 'Simon & Garfunkel']) {
    assert.equal(foldQuery(title), title === 'Ёлки' ? 'Ёлки' : title)
  }
})

test('an accented catalogue title matches the plain release name', () => {
  assert.equal(normalizeTitle('Amélie'), normalizeTitle('Amelie'))
  assert.equal(normalizeTitle('JAŸ-Z'), 'jay z')
  assert.equal(normalizeTitle('Røyksopp'), 'royksopp')
})

test('a spelling that differs only in accents is not searched twice', () => {
  assert.deepEqual(punctuationSafeQueryVariants('JAŸ-Z discography'), ['JAY-Z discography'])
  // Punctuation the tracker-safe spelling drops still keeps the canonical fallback.
  assert.deepEqual(punctuationSafeQueryVariants("A Bug's Life"), ['A Bugs Life', "A Bug's Life"])
  assert.deepEqual(punctuationSafeQueryVariants('Alien'), ['Alien'])
})
