import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeTierMatcher, makeReleaseScorer } from '@archivist/core'
import { parseQualityFromTitle, guardrailDistance, absoluteQuality, makeRejectMatcher, meetsQualityFloor, hasQualityFloor, isQualityUpgrade, isWithinQualityEnvelope, isNonRegressiveQualityUpgrade } from '../src/services/quality.js'
import { evaluateRelease } from '../src/services/acquisition-decisions.js'

const matcher = makeTierMatcher({
  tier1: ['QxR', 'Prof', 'SARTRE'],
  tier2: ['UTR', '"[SEV]"'],
  tier3: ['YIFY'],
})
const scopedScorer = makeReleaseScorer({ tier1: ['QxR', 'Prof', 'SARTRE'], tier2: ['UTR', '"[SEV]"'], tier3: ['YIFY'] })

test('anchored group matching does not false-positive on substrings', () => {
  // 'Prof' is a Tier 1 group, but the word "Professional" must NOT match it.
  assert.equal(matcher.tierOf('The.Professional.2024.1080p.BluRay.x264-YIFY'), 3)
  assert.equal(matcher.tierOf('Neutral.2023.1080p.WEB.h264-RANDOM'), 0) // 'UTR' inside "Neutral"
})

test('anchored matching honours a real group token', () => {
  assert.equal(matcher.tierOf('Some.Movie.2024.1080p.BluRay.x264-Prof'), 1)
  assert.equal(matcher.tierOf('Some.Show.S01E01.1080p.WEB.h264-QxR'), 1)
})

test('a term stored with phrase-search quotes/brackets still matches the group', () => {
  // '"[SEV]"' is stored quoted for indexer phrase search; it must still match
  // a release whose group renders as -SEV or [SEV].
  assert.equal(matcher.tierOf('Show.S01E01.1080p.WEB.h264-SEV'), 2)
  assert.equal(matcher.tierOf('Show.S01E01.1080p.WEB.[SEV]'), 2)
})

test('unrecognised group ranks tier 0, never dropped', () => {
  assert.equal(matcher.tierOf('Show.S01E01.1080p.WEB.h264-NOBODY'), 0)
})

test('built-in fallback recognises groups not in the configured tiers', () => {
  // 'Tigole' / 'Ghost' aren't in this small config but are known groups — they
  // must still tier via the built-in fallback rather than ranking as tier 0.
  assert.equal(matcher.tierOf('Movie.2024.1080p.BluRay.x264-Tigole'), 0) // config-only matcher
  const scoped = makeReleaseScorer({ tier1: ['QxR', 'Prof'], tier2: ['UTR'], tier3: ['YIFY'] })
  assert.equal(scoped('Movie.2024.1080p.BluRay.x264-Tigole').tier, 1) // fallback → tier 1
  assert.equal(scoped('Movie.2024.1080p.WEB.x264-NOBODY').tier, 0)     // truly unknown stays 0
})

test('configured tier wins over the built-in fallback on a conflict', () => {
  // Built-in has 'Prof' at tier 2; a config that puts it at tier 1 must win.
  const scoped = makeReleaseScorer({ tier1: ['Prof'], tier2: [], tier3: [] })
  assert.equal(scoped('Movie.2024.1080p.BluRay.x264-Prof').tier, 1)
})

test('guardrail distance is 0 for an exact match and grows with distance', () => {
  const target = { resolution: '1080p', source: 'BluRay', codec: 'x265' }
  const exact = parseQualityFromTitle('Movie.2024.1080p.BluRay.x265-QxR')
  const near = parseQualityFromTitle('Movie.2024.1080p.WEB.x265-QxR')     // source off by one
  const far = parseQualityFromTitle('Movie.2024.720p.HDTV.x264-QxR')      // every axis off

  assert.equal(guardrailDistance(exact, target), 0)
  assert.ok(guardrailDistance(near, target) > 0)
  assert.ok(guardrailDistance(far, target) > guardrailDistance(near, target))
})

test('an unset (Any) guardrail imposes no preference', () => {
  const target = { resolution: 'Any', source: null, codec: undefined }
  const a = parseQualityFromTitle('Movie.2024.2160p.REMUX.x265-QxR')
  const b = parseQualityFromTitle('Movie.2024.480p.DVD.x264-YIFY')
  assert.equal(guardrailDistance(a, target), 0)
  assert.equal(guardrailDistance(b, target), 0)
})

test('among equally-distant releases, absolute quality breaks the tie upward', () => {
  const target = { resolution: '1080p' }
  const up = parseQualityFromTitle('Movie.2024.2160p.BluRay.x265-QxR')   // distance 1 (above)
  const down = parseQualityFromTitle('Movie.2024.720p.BluRay.x265-QxR')  // distance 1 (below)
  assert.equal(guardrailDistance(up, target), guardrailDistance(down, target))
  assert.ok(absoluteQuality(up) > absoluteQuality(down))
})

test('reject matcher drops CAM/screener junk but keeps clean releases', () => {
  const reject = makeRejectMatcher({ terms: ['CAM', 'TS', 'TELESYNC'], minResolution: null })
  const cam = parseQualityFromTitle('Movie.2024.720p.CAM.x264-NOBODY')
  const clean = parseQualityFromTitle('Movie.2024.1080p.BluRay.x264-QxR')
  assert.ok(reject('Movie.2024.720p.CAM.x264-NOBODY', cam))          // rejected
  assert.equal(reject('Movie.2024.1080p.BluRay.x264-QxR', clean), null) // kept
})

test('reject matcher enforces a resolution floor without dropping unknowns', () => {
  const reject = makeRejectMatcher({ terms: [], minResolution: '720p' })
  const low = parseQualityFromTitle('Movie.2024.480p.WEB.x264-NOBODY')
  const ok = parseQualityFromTitle('Movie.2024.1080p.WEB.x264-QxR')
  const unknownRes = parseQualityFromTitle('Movie.2024.WEB.x264-QxR') // no resolution parsed
  assert.ok(reject('Movie.2024.480p.WEB.x264-NOBODY', low))          // below floor → rejected
  assert.equal(reject('Movie.2024.1080p.WEB.x264-QxR', ok), null)     // above floor → kept
  assert.equal(reject('Movie.2024.WEB.x264-QxR', unknownRes), null)   // unparseable res → kept, not dropped
})

test('meetsQualityFloor normalises loose target values (Web vs WEB, 4k)', () => {
  const q = (res: string | null, src: string | null, tier = 0) => ({ tier, resolution: res, source: src, codec: null, releaseGroup: null, edition: null })
  // target source stored as "Web" must still compare against parsed "WEB"
  assert.equal(meetsQualityFloor(q('1080p', 'WEB'), { source: 'Web', resolution: '1080p' }), true)
  assert.equal(meetsQualityFloor(q('720p', 'WEB'), { resolution: '1080p' }), false) // below res floor
  assert.equal(meetsQualityFloor(q('2160p', 'BluRay'), { resolution: '4k' }), true)  // 4k == 2160p
  // tier floor: current tier 2 does not meet a Tier-1 floor
  assert.equal(meetsQualityFloor(q('1080p', 'BluRay', 2), { tier: '1' }), false)
  assert.equal(meetsQualityFloor(q('1080p', 'BluRay', 1), { tier: 'Tier 1' }), true)
})

test('quality floor enforces the configured codec as well as resolution', () => {
  const low = parseQualityFromTitle('The.Hawk.S01E10.720p.WEB-DL.H.264-playWEB')
  const wanted = parseQualityFromTitle('The.Hawk.S01E10.1080p.WEB-DL.HEVC-GROUP')
  const floor = { resolution: '1080p', codec: 'x265' }
  assert.equal(meetsQualityFloor(low, floor), false)
  assert.equal(meetsQualityFloor(wanted, floor), true)
  assert.equal(hasQualityFloor({ tier: 'Any', resolution: 'Any', source: null, codec: 'x265' }), true)
})

test('an enforced series target rejects a 720p release before RSS selection', () => {
  const context = {
    source: 'rss' as const,
    mediaType: 'series',
    subjectType: 'episode',
    subjectTitle: 'The Hawk',
    targetTier: 'Any',
    targetResolution: '1080p',
    targetSource: 'Web',
    targetCodec: 'x265',
    enforceTargetFloor: true,
  }
  const low = evaluateRelease(context, {
    title: 'The.Hawk.S01E10.720p.NF.WEB-DL.H.264-playWEB',
    downloadUrl: 'magnet:?xt=urn:btih:low',
  })
  const wanted = evaluateRelease(context, {
    title: 'The.Hawk.S01E10.1080p.NF.WEB-DL.x265-GROUP',
    downloadUrl: 'magnet:?xt=urn:btih:wanted',
  })
  assert.equal(low.accepted, false)
  assert.ok(low.rejectionReasons.includes('release is outside the configured quality envelope'))
  assert.equal(wanted.accepted, true)
})

test('an all-Any floor constrains nothing', () => {
  assert.equal(hasQualityFloor({ tier: 'Any', resolution: 'Any', source: null }), false)
  assert.equal(hasQualityFloor({ resolution: '1080p' }), true)
})

test('isQualityUpgrade counts tier/resolution/source/codec improvements', () => {
  const q = (res: string | null, src: string | null, tier = 0, codec: string | null = 'x264') => ({ tier, resolution: res, source: src, codec, releaseGroup: null, edition: null })
  assert.equal(isQualityUpgrade(q('1080p', 'WEB'), q('2160p', 'WEB')), true)   // higher res
  assert.equal(isQualityUpgrade(q('1080p', 'WEB'), q('1080p', 'BluRay')), true) // better source
  assert.equal(isQualityUpgrade(q('1080p', 'BluRay', 2), q('1080p', 'BluRay', 1)), true) // better tier
  assert.equal(isQualityUpgrade(q('1080p', 'BluRay'), q('1080p', 'BluRay')), false) // same
  assert.equal(isQualityUpgrade(q('1080p', 'BluRay'), q('720p', 'WEB')), false)  // worse
  assert.equal(isQualityUpgrade(q('1080p', 'BluRay', 1, 'x264'), q('1080p', 'BluRay', 1, 'x265')), true)
})

test('an exact Tier 1 1080p x265 envelope rejects quality above and below it', () => {
  const envelope = {
    floor: { tier: 'Tier 1', resolution: '1080p', codec: 'x265' },
    ceiling: { tier: 'Tier 1', resolution: '1080p', codec: 'x265' },
  }
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.1080p.WEB.x265-QxR', scopedScorer), envelope), true)
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.2160p.WEB.x265-QxR', scopedScorer), envelope), false)
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.1080p.WEB.x264-QxR', scopedScorer), envelope), false)
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.1080p.WEB.AV1-QxR', scopedScorer), envelope), false)
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.1080p.WEB.x265-UTR', scopedScorer), envelope), false)
})

test('a ranged envelope accepts only values between its floor and ceiling', () => {
  const envelope = {
    floor: { tier: 'Tier 3', resolution: '720p', codec: 'x264' },
    ceiling: { tier: 'Tier 1', resolution: '1080p', codec: 'x265' },
  }
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.720p.WEB.x264-YIFY', scopedScorer), envelope), true)
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.1080p.WEB.x265-QxR', scopedScorer), envelope), true)
  assert.equal(isWithinQualityEnvelope(parseQualityFromTitle('Film.2026.2160p.WEB.x265-QxR', scopedScorer), envelope), false)
})

test('upgrade comparison refuses cross-axis regressions', () => {
  const current = parseQualityFromTitle('Film.2026.1080p.BluRay.x265-UTR', scopedScorer)
  assert.equal(isNonRegressiveQualityUpgrade(current, parseQualityFromTitle('Film.2026.1080p.BluRay.x265-QxR', scopedScorer)), true)
  assert.equal(isNonRegressiveQualityUpgrade(current, parseQualityFromTitle('Film.2026.2160p.WEB.x265-QxR', scopedScorer)), false)
  assert.equal(isNonRegressiveQualityUpgrade(current, parseQualityFromTitle('Film.2026.1080p.BluRay.x264-QxR', scopedScorer)), false)
})
