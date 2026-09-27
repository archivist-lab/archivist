import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rssEnabled } from '../src/release-pipeline/orchestrator.js'
import { filterNewReleases } from '../src/release-pipeline/poller.js'

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

function release(guid: string, publishDate: number) {
  return { guid, title: guid, downloadUrl: `magnet:?xt=${guid}`, publishDate: new Date(publishDate).toISOString() } as any
}

test('the feed watermark never advances past the present', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0)
  const future = now + 48 * 60 * 60_000
  const { newReleases, nextWatermark } = filterNewReleases(
    [release('skewed', future), release('real', now - 60_000)],
    [],
    0,
    now,
  )
  assert.deepEqual(newReleases.map(r => r.guid), ['skewed', 'real'])
  assert.equal(nextWatermark, now - 60_000)
})

test('a watermark already stored in the future is clamped on read, not obeyed', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0)
  const poisoned = now + 48 * 60 * 60_000
  const { newReleases, nextWatermark } = filterNewReleases(
    [release('fresh', now - 60_000)],
    [],
    poisoned,
    now,
  )
  assert.deepEqual(newReleases.map(r => r.guid), ['fresh'])
  assert.equal(nextWatermark, now - 60_000)
})

test('releases at or below a sane watermark are still skipped', () => {
  const now = Date.UTC(2026, 8, 21, 12, 0, 0)
  const watermark = now - 60 * 60_000
  const { newReleases } = filterNewReleases(
    [release('old', watermark - 1000), release('same', watermark), release('new', watermark + 1000)],
    [],
    watermark,
    now,
  )
  assert.deepEqual(newReleases.map(r => r.guid), ['new'])
})
