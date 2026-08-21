import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MUSIC_QUALITY_LADDER, codecsForQuality, musicQualityRank } from '@archivist/contracts'
import { parseMusicQuality, rankMusicReleases, scoreMusicRelease } from '../src/release-pipeline/music-quality.js'

test('reads quality out of real release titles', () => {
  // The release that prompted this: MP3 320 from a scene group.
  const pmedia = parseMusicQuality('Morgan Wallen - I’m The Problem (2025) Mp3 320kbps [PMEDIA] ⭐️')
  assert.equal(pmedia.codec, 'MP3')
  assert.equal(pmedia.lossless, false)
  assert.equal(pmedia.bitrateKbps, 320)
  assert.equal(pmedia.quality, 'hifi-lossy')
  assert.equal(pmedia.releaseGroup, 'PMEDIA')

  const hires = parseMusicQuality('Artist - Album (2024) [FLAC 24bit 96kHz] WEB')
  assert.equal(hires.codec, 'FLAC')
  assert.equal(hires.lossless, true)
  assert.equal(hires.bitDepth, 24)
  assert.equal(hires.sampleRateKhz, 96)
  assert.equal(hires.quality, 'lossless')

  // A bare FLAC with no stated rate is CD quality, the common case.
  const cd = parseMusicQuality('Artist - Album [FLAC]')
  assert.equal(cd.quality, 'lossless')
  assert.equal(cd.lossless, true)

  const slashPair = parseMusicQuality('Artist - Album FLAC 24/192')
  assert.equal(slashPair.bitDepth, 24)
  assert.equal(slashPair.sampleRateKhz, 192)
  assert.equal(slashPair.quality, 'lossless', 'hi-res is still simply lossless')

  const vbr = parseMusicQuality('Artist - Album (2019) [MP3 V0]')
  assert.equal(vbr.bitrateKbps, 320, 'V0 is treated as 320')
  assert.equal(vbr.quality, 'hifi-lossy')

  const low = parseMusicQuality('Artist - Album 128kbps')
  assert.equal(low.quality, 'lofi-lossy')

  const boundary = parseMusicQuality('Artist - Album MP3 192kbps')
  assert.equal(boundary.quality, 'lofi-lossy', '192 sits below the Hi-Fi floor')

  const alac = parseMusicQuality('Artist - Album [ALAC M4A]')
  assert.equal(alac.lossless, true)
  assert.equal(alac.quality, 'lossless')

  const bare = parseMusicQuality('Artist - Album (2020)')
  assert.equal(bare.unknown, true)
  assert.equal(bare.quality, null)
})

test('the ladder is strictly ordered and lossless always outranks lossy', () => {
  const ranks = MUSIC_QUALITY_LADDER.map(rung => rung.rank)
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a), 'ladder is declared best-first')
  assert.equal(new Set(ranks).size, ranks.length, 'no two rungs share a rank')

  const worstLossless = Math.min(...MUSIC_QUALITY_LADDER.filter(r => r.lossless).map(r => r.rank))
  const bestLossy = Math.max(...MUSIC_QUALITY_LADDER.filter(r => !r.lossless).map(r => r.rank))
  assert.ok(worstLossless > bestLossy, 'lossless beats the best lossy class')
})

test('quality beats seeders, which only break ties', () => {
  // A heavily seeded 128k rip must not win over a quiet FLAC.
  const flac = scoreMusicRelease('Album [FLAC]', 2)
  const mp3 = scoreMusicRelease('Album 128kbps', 5000)
  assert.ok(flac.score > mp3.score, `${flac.score} should beat ${mp3.score}`)

  const seeded = scoreMusicRelease('Album Mp3 320kbps', 900)
  const quiet = scoreMusicRelease('Album Mp3 320kbps', 3)
  assert.ok(seeded.score > quiet.score, 'same rung falls back to seeders')
})

test('a target the profile requires rejects everything beneath it', () => {
  const policy = { targetQuality: 'lossless', requireTarget: true }
  assert.equal(scoreMusicRelease('Album Mp3 320kbps', 500, policy).rejected, true)
  assert.equal(scoreMusicRelease('Album [FLAC]', 1, policy).rejected, false)
  assert.equal(scoreMusicRelease('Album [ALAC]', 1, policy).rejected, false,
    'any lossless container satisfies a lossless target')
})

test('a target the profile merely prefers still ranks, and never rejects', () => {
  const policy = { targetQuality: 'lossless' }
  const ranked = rankMusicReleases([
    { title: 'Album Mp3 192kbps', seeders: 900 },
    { title: 'Album [FLAC]', seeders: 4 },
    { title: 'Album Mp3 320kbps', seeders: 400 },
  ], policy)
  assert.equal(ranked.length, 3, 'nothing is dropped when the target is a preference')
  assert.equal(ranked[0].title, 'Album [FLAC]')
  assert.equal(ranked[1].title, 'Album Mp3 320kbps')
})

test('codec and source requirements reject a mismatch', () => {
  assert.equal(scoreMusicRelease('Album Mp3 320kbps', 10, { targetCodec: 'FLAC' }).rejected, true)
  assert.equal(scoreMusicRelease('Album [FLAC]', 10, { targetCodec: 'FLAC' }).rejected, false)
  // A release that never states its codec is not rejected for it.
  assert.equal(scoreMusicRelease('Album (2020) 320kbps', 10, { targetCodec: 'MP3' }).rejected, false)
})

test('unknown quality sorts below every graded rung', () => {
  assert.equal(musicQualityRank(null), 0)
  assert.equal(musicQualityRank('nonsense'), 0)
  const ranked = rankMusicReleases([
    { title: 'Album (2020)', seeders: 5000 },
    { title: 'Album 192kbps', seeders: 1 },
  ])
  assert.equal(ranked[0].title, 'Album 192kbps', 'a graded release beats an ungraded one')
})

test('codec choices are scoped to the quality class', () => {
  // "FLAC at 192kbps" must not be expressible.
  assert.ok(codecsForQuality('lossless').includes('FLAC'))
  assert.equal(codecsForQuality('lossless').includes('MP3'), false)
  assert.ok(codecsForQuality('hifi-lossy').includes('MP3'))
  assert.equal(codecsForQuality('hifi-lossy').includes('FLAC'), false)
  // With no class chosen every container is on offer.
  assert.ok(codecsForQuality(null).includes('FLAC'))
  assert.ok(codecsForQuality(null).includes('MP3'))
})
