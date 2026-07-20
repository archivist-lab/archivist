// SPDX-FileCopyrightText: 2022-2026 Intro Skipper contributors
// SPDX-License-Identifier: GPL-3.0-only
// Chromaprint alignment baseline derived from https://github.com/intro-skipper/intro-skipper

export interface FingerprintWindow {
  frames: Int32Array
  secondsPerFrame: number
  processedStart: number
  processedDuration: number
}

export interface FingerprintMatch {
  startA: number
  endA: number
  startB: number
  endB: number
  confidence: number
  duration: number
}

const popcount32 = (value: number): number => {
  let v = value >>> 0
  v -= (v >>> 1) & 0x55555555
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

/** Intro Skipper-compatible Chromaprint alignment defaults. */
export const CHROMAPRINT_MAX_POINT_DIFFERENCES = 6
export const CHROMAPRINT_MAX_TIME_SKIP_SECONDS = 3.5
export const CHROMAPRINT_INVERTED_INDEX_SHIFT = 2

/**
 * Find a shared Chromaprint region using Intro Skipper's proven baseline:
 * derive every plausible diagonal from exact/near-exact fingerprint values,
 * then accept points with at most six differing bits and bridge gaps up to
 * 3.5 seconds. Unlike the former top-32 byte-anchor heuristic, this cannot
 * discard the real title-sequence alignment before verifying it.
 */
export function matchFingerprintWindows(
  a: FingerprintWindow,
  b: FingerprintWindow,
  options: { minimumSeconds?: number; confidenceThreshold?: number } = {},
): FingerprintMatch | null {
  if (!a.frames.length || !b.frames.length) return null
  const secondsPerFrame = Math.max(a.secondsPerFrame, b.secondsPerFrame)
  const minimumFrames = Math.max(4, Math.ceil((options.minimumSeconds ?? 12) / secondsPerFrame))
  const threshold = options.confidenceThreshold ?? 0.72
  const index = (frames: Int32Array) => {
    const result = new Map<number, number>()
    for (let position = 0; position < frames.length; position++) result.set(frames[position] >>> 0, position)
    return result
  }
  const aIndex = index(a.frames)
  const bIndex = index(b.frames)
  const offsets = new Set<number>()
  for (const [point, aPosition] of aIndex) {
    for (let delta = -CHROMAPRINT_INVERTED_INDEX_SHIFT; delta <= CHROMAPRINT_INVERTED_INDEX_SHIFT; delta++) {
      const bPosition = bIndex.get((point + delta) >>> 0)
      if (bPosition !== undefined) offsets.add(bPosition - aPosition)
    }
  }

  let best: { aStart: number; aEnd: number; bStart: number; bEnd: number; confidence: number; duration: number } | null = null
  const maximumGapFrames = Math.max(1, Math.floor(CHROMAPRINT_MAX_TIME_SKIP_SECONDS / secondsPerFrame))
  for (const offset of offsets) {
    const a0 = Math.max(0, -offset)
    const b0 = Math.max(0, offset)
    const length = Math.min(a.frames.length - a0, b.frames.length - b0)
    let runStart = -1
    let previousMatch = -1
    let similaritySum = 0
    let matches = 0
    for (let k = 0; k < length; k++) {
      const differences = popcount32((a.frames[a0 + k] ^ b.frames[b0 + k]) >>> 0)
      if (differences > CHROMAPRINT_MAX_POINT_DIFFERENCES) continue
      if (runStart < 0 || (previousMatch >= 0 && k - previousMatch > maximumGapFrames)) {
        runStart = k
        matches = 0
        similaritySum = 0
      }
      previousMatch = k
      matches++
      similaritySum += 1 - differences / 32
      const spanFrames = k - runStart
      const duration = spanFrames * secondsPerFrame
      const confidence = similaritySum / matches
      if (spanFrames >= minimumFrames && confidence >= threshold && (!best || duration > best.duration || (duration === best.duration && confidence > best.confidence))) {
        best = { aStart: a0 + runStart, aEnd: a0 + k, bStart: b0 + runStart, bEnd: b0 + k, confidence, duration }
      }
    }
  }

  if (!best) return null
  return {
    startA: a.processedStart + best.aStart * a.secondsPerFrame,
    endA: a.processedStart + best.aEnd * a.secondsPerFrame,
    startB: b.processedStart + best.bStart * b.secondsPerFrame,
    endB: b.processedStart + best.bEnd * b.secondsPerFrame,
    confidence: best.confidence,
    duration: best.duration,
  }
}
