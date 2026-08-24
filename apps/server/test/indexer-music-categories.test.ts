import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapCategories, normaliseTorznabCategoryName } from '../../../packages/indexer-engine/src/cardigann/executor.js'

test('Music category aliases normalise to the Torznab Audio tree', () => {
  assert.equal(normaliseTorznabCategoryName('Music'), 'audio')
  assert.equal(normaliseTorznabCategoryName(' Music / FLAC '), 'audio/lossless')
  assert.equal(normaliseTorznabCategoryName('Audio\\Lossless'), 'audio/lossless')
})

test('Music parent searches map to indexer-specific Music and Audio categories', () => {
  const mapped = mapCategories([3000], [
    { id: 'music-all', cat: 'Music' },
    { id: 'flac', cat: 'Music/FLAC' },
    { id: 'mp3', cat: 'Audio/MP3' },
    { id: 'films', cat: 'Movies' },
  ])
  assert.deepEqual(mapped, ['music-all', 'flac', 'mp3'])
})
