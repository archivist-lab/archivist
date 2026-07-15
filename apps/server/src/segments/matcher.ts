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

const similarity = (a: number, b: number) => 1 - popcount32((a ^ b) >>> 0) / 32

/**
 * Indexed diagonal search. Four byte-sized anchors generate likely offsets;
 * only the best diagonals are verified frame-by-frame. This avoids the O(n²)
 * full comparison that made earlier detector designs unsafe on long seasons.
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

  const buckets = new Map<number, number[]>()
  for (let j = 0; j < b.frames.length; j++) {
    const value = b.frames[j] >>> 0
    for (let byte = 0; byte < 4; byte++) {
      const key = byte * 256 + ((value >>> (byte * 8)) & 0xff)
      const list = buckets.get(key)
      if (list) {
        if (list.length < 96) list.push(j)
      } else buckets.set(key, [j])
    }
  }

  const offsets = new Map<number, number>()
  for (let i = 0; i < a.frames.length; i += 3) {
    const value = a.frames[i] >>> 0
    for (let byte = 0; byte < 4; byte++) {
      const key = byte * 256 + ((value >>> (byte * 8)) & 0xff)
      for (const j of buckets.get(key) ?? []) {
        const offset = j - i
        offsets.set(offset, (offsets.get(offset) ?? 0) + 1)
      }
    }
  }

  const candidates = [...offsets.entries()].sort((x, y) => y[1] - x[1]).slice(0, 32)
  let best: { aStart: number; bStart: number; length: number; confidence: number } | null = null

  for (const [offset] of candidates) {
    const a0 = Math.max(0, -offset)
    const b0 = Math.max(0, offset)
    const length = Math.min(a.frames.length - a0, b.frames.length - b0)
    let runStart = 0
    let score = 0
    let similaritySum = 0
    for (let k = 0; k < length; k++) {
      const frameSimilarity = similarity(a.frames[a0 + k], b.frames[b0 + k])
      const frameScore = frameSimilarity - Math.max(0.52, threshold - 0.12)
      if (score + frameScore <= 0) {
        score = 0
        similaritySum = 0
        runStart = k + 1
        continue
      }
      score += frameScore
      similaritySum += frameSimilarity
      const runLength = k - runStart + 1
      const confidence = similaritySum / runLength
      if (runLength >= minimumFrames && confidence >= threshold && (!best || runLength * confidence > best.length * best.confidence)) {
        best = { aStart: a0 + runStart, bStart: b0 + runStart, length: runLength, confidence }
      }
    }
  }

  if (!best) return null
  const duration = best.length * secondsPerFrame
  return {
    startA: a.processedStart + best.aStart * a.secondsPerFrame,
    endA: a.processedStart + best.aStart * a.secondsPerFrame + duration,
    startB: b.processedStart + best.bStart * b.secondsPerFrame,
    endB: b.processedStart + best.bStart * b.secondsPerFrame + duration,
    confidence: best.confidence,
    duration,
  }
}
