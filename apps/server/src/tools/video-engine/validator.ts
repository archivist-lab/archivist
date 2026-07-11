/**
 * Validation Engine — every encoded output must pass before it may replace the
 * original. Compares the output's analysis against the input's: duration, stream
 * counts, HDR/Dolby Vision retention, chapter count. If anything fails the output
 * is discarded and the original is kept untouched.
 */

import { analyzeMedia, type MediaAnalysis } from './analyzer.js'
import type { ExecAction } from './executor.js'

export interface ValidationCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ValidationResult {
  ok: boolean
  checks: ValidationCheck[]
}

const DURATION_TOLERANCE_SEC = 2

export function validateOutput(input: MediaAnalysis, action: ExecAction, targetCodec: string | undefined, outputPath: string): ValidationResult {
  const output = analyzeMedia(outputPath)
  const checks: ValidationCheck[] = []
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

  if (!output) {
    return { ok: false, checks: [{ name: 'probe', ok: false, detail: 'ffprobe could not read the output file' }] }
  }

  // Duration within tolerance.
  const di = input.durationSec ?? 0
  const doo = output.durationSec ?? 0
  add('duration', Math.abs(di - doo) <= DURATION_TOLERANCE_SEC, `${di.toFixed(1)}s → ${doo.toFixed(1)}s`)

  // A playable video stream exists.
  add('video-stream', !!output.video, output.video ? `codec ${output.video.codec}` : 'no video stream')

  // Codec expectation: remux keeps the codec; convert must be the target codec.
  if (action === 'convert' && targetCodec) {
    add('target-codec', output.video?.codec === targetCodec, `expected ${targetCodec}, got ${output.video?.codec ?? 'none'}`)
  } else if (action === 'remux') {
    add('codec-preserved', output.video?.codec === input.video?.codec, `${input.video?.codec} → ${output.video?.codec}`)
  }

  // Stream counts preserved (remux) or at least not lost.
  add('audio-tracks', output.audio.length >= input.audio.length, `${input.audio.length} → ${output.audio.length}`)
  add('subtitle-tracks', output.subtitles.length >= input.subtitles.length, `${input.subtitles.length} → ${output.subtitles.length}`)

  // Chapters preserved (only assert when the source had any).
  if (input.chapters.count > 0) {
    add('chapters', output.chapters.count >= input.chapters.count, `${input.chapters.count} → ${output.chapters.count}`)
  }

  // HDR / Dolby Vision retention (only assert when the source had it).
  if (input.video && input.video.hdrFormat !== 'SDR') {
    add('hdr', output.video?.hdrFormat === input.video.hdrFormat, `${input.video.hdrFormat} → ${output.video?.hdrFormat ?? 'SDR'}`)
  }
  if (input.video?.dolbyVision) {
    add('dolby-vision', !!output.video?.dolbyVision, output.video?.dolbyVision ? 'retained' : 'lost')
  }

  return { ok: checks.every(c => c.ok), checks }
}
