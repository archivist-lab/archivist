import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rssEnabled } from '../src/release-pipeline/orchestrator.js'

function indexer(rss?: unknown) {
  return {
    config: {
      settings: rss === undefined ? undefined : { rss },
    },
  }
}

test('RSS participation defaults to enabled', () => {
  assert.equal(rssEnabled(indexer()), true)
  assert.equal(rssEnabled(indexer(null)), true)
})

test('RSS participation accepts only enabled values', () => {
  assert.equal(rssEnabled(indexer(true)), true)
  assert.equal(rssEnabled(indexer('true')), true)
  assert.equal(rssEnabled(indexer(false)), false)
  assert.equal(rssEnabled(indexer('false')), false)
})
