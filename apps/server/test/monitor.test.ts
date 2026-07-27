import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStale, torrentVideoFiles } from '../src/shared/monitor.js'

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

// ── Torrent file selection ───────────────────────────────────────────────────
// Regression: a single-episode scene release ships extras named after the
// release ("World.War.II...S01E05...Screen0001.png" inside Screens/). Selecting
// the import source by filename alone matched a screenshot, so episodes were
// grabbed but never organised into the series folder.

const ww2Release = {
  name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE',
  files: [
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/Screens/World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE.Screen0001.png', sizeBytes: 480_000 },
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/Screens/World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE.Screen0002.png', sizeBytes: 470_000 },
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE.mkv', sizeBytes: 2_400_000_000 },
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/release.nfo', sizeBytes: 3_000 },
  ],
}

test('extras are excluded so a single-episode release is not treated as a pack', () => {
  const videos = torrentVideoFiles(ww2Release)
  assert.equal(videos.length, 1, 'screenshots and nfo must not count as episodes')
  assert.match(videos[0].name, /\.mkv$/)
  // files.length > 1 was the old pack test — it would have been true here.
  assert.equal(ww2Release.files.length > 1, true)
})

test('video files are returned largest first and samples dropped', () => {
  const pack = {
    files: [
      { name: 'Show.S01E01.mkv', sizeBytes: 1_000_000_000 },
      { name: 'Sample/Show.S01E01.sample.mkv', sizeBytes: 20_000_000 },
      { name: 'Show.S01E02.mkv', sizeBytes: 3_000_000_000 },
      { name: 'Screens/Show.S01E02.Screen0001.png', sizeBytes: 500_000 },
    ],
  }
  const videos = torrentVideoFiles(pack)
  assert.deepEqual(videos.map(f => f.name), ['Show.S01E02.mkv', 'Show.S01E01.mkv'])

  // The season-pack path selects by SxxEyy within videos only — never a PNG.
  const chosen = videos.find(f => f.name.toLowerCase().includes('s01e02'))
  assert.equal(chosen?.name, 'Show.S01E02.mkv')
})

test('in-progress .part files still count as video', () => {
  const videos = torrentVideoFiles({ files: [{ name: 'Show.S01E01.mkv.part', sizeBytes: 500 }] })
  assert.equal(videos.length, 1)
})
