import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFingerprint, decodeFingerprint, selectFingerprintAudioTrack } from '../src/segments/fingerprint.js'
import { matchFingerprintWindows, type FingerprintWindow } from '../src/segments/matcher.js'
import { contentSignature } from '../src/segments/signature.js'
import { visualCreditsInternals } from '../src/segments/visual-credits.js'

function pseudoRandom(length: number, seed: number): Int32Array {
  const out = new Int32Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = state | 0
  }
  return out
}

function fixture(prefix: number, recurring: Int32Array, suffix: number, seed: number, noise = false): FingerprintWindow {
  const frames = new Int32Array(prefix + recurring.length + suffix)
  frames.set(pseudoRandom(prefix, seed), 0)
  frames.set(recurring, prefix)
  frames.set(pseudoRandom(suffix, seed + 1), prefix + recurring.length)
  if (noise) {
    for (let i = prefix; i < prefix + recurring.length; i += 7) frames[i] ^= 1 << (i % 31)
  }
  return { frames, secondsPerFrame: 0.5, processedStart: 0, processedDuration: frames.length * 0.5 }
}

test('sampled content signatures are stable and change with sampled content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archivist-segments-'))
  try {
    const first = join(dir, 'one.bin')
    const second = join(dir, 'two.bin')
    writeFileSync(first, Buffer.alloc(1024 * 1024, 0x2a))
    writeFileSync(second, Buffer.alloc(1024 * 1024, 0x2b))
    const a = await contentSignature(first)
    const again = await contentSignature(first)
    const b = await contentSignature(second)
    assert.equal(a.signature, again.signature)
    assert.notEqual(a.signature, b.signature)
    assert.equal(a.fileSize, 1024 * 1024)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fingerprint cache encoding is lossless', () => {
  const frames = pseudoRandom(2048, 42)
  assert.deepEqual([...decodeFingerprint(encodeFingerprint(frames))], [...frames])
})

test('indexed matcher locates a recurring segment at different offsets with light noise', () => {
  const recurring = pseudoRandom(100, 99)
  const a = fixture(40, recurring, 180, 1)
  const b = fixture(86, recurring, 120, 2, true)
  const match = matchFingerprintWindows(a, b, { minimumSeconds: 20, confidenceThreshold: 0.9 })
  assert.ok(match)
  assert.ok(Math.abs(match.startA - 20) <= 1)
  assert.ok(Math.abs(match.startB - 43) <= 1)
  assert.ok(match.duration >= 45)
  assert.ok(match.confidence >= 0.9)
})

test('indexed matcher rejects unrelated fingerprints', () => {
  const a = fixture(40, pseudoRandom(80, 10), 100, 11)
  const b = fixture(40, pseudoRandom(80, 20), 100, 21)
  assert.equal(matchFingerprintWindows(a, b, { minimumSeconds: 20, confidenceThreshold: 0.9 }), null)
})

test('fingerprinting selects the programme audio and avoids commentary', () => {
  const selected = selectFingerprintAudioTrack([
    { index: 1, codec: 'aac', languageCode: 'eng', title: 'Director Commentary', channels: 2, default: true },
    { index: 2, codec: 'eac3', languageCode: 'eng', title: 'English', channels: 6, default: false },
    { index: 3, codec: 'aac', languageCode: 'spa', title: 'Spanish', channels: 2, default: false },
  ], 'eng', 'eng')
  assert.equal(selected?.index, 2)
})

test('baseline matcher bridges short noisy gaps like Intro Skipper', () => {
  const recurring = pseudoRandom(180, 500)
  const a = fixture(30, recurring, 40, 501)
  const b = fixture(70, recurring, 20, 502)
  for (let index = 75; index < 79; index++) b.frames[70 + index] = pseudoRandom(1, 900 + index)[0]
  const match = matchFingerprintWindows(a, b, { minimumSeconds: 15, confidenceThreshold: 0.72 })
  assert.ok(match)
  assert.ok(match.duration > 80)
})

test('visual credits baseline accepts sustained adaptive black-frame evidence', () => {
  const frames = Array.from({ length: 50 }, (_, index) => ({ time: index * 2, pblack: index >= 25 ? 96 : 12 }))
  const result = visualCreditsInternals.blackFrameCandidate(frames, 15)
  assert.ok(result)
  assert.equal(result.start, 50)
  assert.ok(result.density >= 0.5)
})

test('visual credits entropy fallback rejects busy content and selects the latest neutral card run', () => {
  const visuals = [
    ...Array.from({ length: 10 }, (_, index) => ({ time: index * 2, entropy: 0.8, saturation: 40 })),
    ...Array.from({ length: 12 }, (_, index) => ({ time: 30 + index * 2, entropy: 0.1, saturation: 20 })),
  ]
  const result = visualCreditsInternals.entropyCandidate(visuals, 15)
  assert.deepEqual(result, { start: 30, end: 52, density: 1 })
})
