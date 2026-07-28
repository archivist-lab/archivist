import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileRole } from '../src/services/media-imports.js'

// Regression: a single-episode scene release ships proof shots named
// "<Release>.Screen0001.png" — no word break before the digits, so the old
// /\b(screens)\b/ test missed them. They were then classed "unmatched", which
// makes a series import fail with "Import needs review" and the episode never
// reaches the library.

test('scene proof screenshots are treated as extras, not unmatched media', () => {
  const role = fileRole('/downloads/World.War.II.with.Tom.Hanks.S01E02.1080p.x265-ELiTE/Screens/World.War.II.with.Tom.Hanks.S01E02.1080p.x265-ELiTE.Screen0001.png')
  assert.equal(role.ignored, true)
  assert.equal(role.reason, 'artwork/screenshot')
})

test('all common image types are ignored regardless of naming', () => {
  for (const name of ['cover.jpg', 'fanart.jpeg', 'proof.png', 'poster.webp', 'scan.tiff', 'thumb.gif', 'art.bmp']) {
    assert.equal(fileRole(`/x/${name}`).ignored, true, `${name} should be ignored`)
  }
})

test('release metadata files are ignored', () => {
  for (const name of ['release.nfo', 'info.txt', 'checksums.sfv', 'hashes.md5', 'site.url', 'file_id.diz']) {
    assert.equal(fileRole(`/x/${name}`).ignored, true, `${name} should be ignored`)
  }
})

test('samples are ignored', () => {
  assert.equal(fileRole('/x/Show.S01E01.sample.mkv').ignored, true)
})

test('media and subtitles are never ignored', () => {
  // Subtitles ship alongside the episode and must survive the filter.
  for (const name of ['Show.S01E01.mkv', 'Show.S01E01.mp4', 'Show.S01E01.srt', 'Show.S01E01.ass', 'Show.S01E01.sub', 'Show.S01E01.idx',
                      'Album - 01 Track.flac', 'Book.epub', 'Volume.cbz', 'Volume.pdf']) {
    assert.equal(fileRole(`/x/${name}`).ignored, false, `${name} must not be ignored`)
  }
})

test('in-progress .part files are kept', () => {
  assert.equal(fileRole('/x/Show.S01E01.mkv.part').reason, 'partial file')
  assert.equal(fileRole('/x/Show.S01E01.part.mkv').reason, 'partial file')
})

test('episode titles containing Part are not mistaken for partial files', () => {
  for (const name of [
    'X-Men.97.S02E03.Rise.of.Apocalypse.Part.1.1080p.WEBRip.x265.mkv',
    'X-Men.97.S02E04.Rise.of.Apocalypse.Part.II.1080p.WEBRip.x265.mkv',
  ]) {
    assert.equal(fileRole(`/x/${name}`).reason, null)
  }
})
