import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStale } from '../src/shared/monitor.js'

// SQLite stores datetime('now') as UTC 'YYYY-MM-DD HH:MM:SS' with no zone.
const sqliteNow = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
const sqliteAgo = (ms: number) => new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

test('a fresh timestamp is not stale', () => {
  assert.equal(isStale(sqliteNow(), 30 * 60 * 1000), false)
})

test('a timestamp older than the grace window is stale', () => {
  assert.equal(isStale(sqliteAgo(45 * 60 * 1000), 30 * 60 * 1000), true)
})

test('a timestamp inside the grace window is not stale (no timezone drift)', () => {
  // 20 min old with a 30 min grace — must be false even though SQLite strings
  // carry no zone; a naive local-time parse could be off by hours and flip this.
  assert.equal(isStale(sqliteAgo(20 * 60 * 1000), 30 * 60 * 1000), false)
})

test('null/empty timestamps are never treated as stale', () => {
  assert.equal(isStale(null, 30 * 60 * 1000), false)
  assert.equal(isStale(undefined, 30 * 60 * 1000), false)
  assert.equal(isStale('', 30 * 60 * 1000), false)
})
