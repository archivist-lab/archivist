/**
 * Savings Estimator + Recommendation Engine — the "why" layer. Given a file's
 * analysis and the active policy, produce exactly one recommendation with an
 * estimated saving and a human reason. This stage never transcodes; it only
 * advises. Users approve recommendations before anything runs.
 */

import type { MediaAnalysis } from './analyzer.js'
import type { OptimisationPolicy, VideoCodec } from './policy.js'

export type RecommendationAction = 'convert' | 'remux' | 'keep' | 'skip'

export interface Recommendation {
  action: RecommendationAction
  targetCodec: VideoCodec | null
  currentSizeBytes: number
  predictedSizeBytes: number | null
  estimatedSavingBytes: number | null
  estimatedSavingPercent: number | null
  /** Expected perceptual quality outcome, e.g. "No visible difference (CRF 20)". */
  quality: string
  reason: string
  notes: string[]
}

/**
 * Relative bitrate needed for equivalent perceptual quality, normalised to H264
 * = 1.0 (lower = more efficient). Used only to *estimate* savings; the real
 * encode uses the policy's CRF. Add a codec here to teach the estimator about it.
 */
const CODEC_EFFICIENCY: Record<string, number> = {
  mpeg2video: 2.2,
  vc1: 1.15,
  h264: 1.0,
  vp9: 0.65,
  hevc: 0.55,
  av1: 0.40,
  h266: 0.30,
}

// Containers that benefit from a lossless remux into MKV even when the video is
// already an efficient codec.
const LEGACY_CONTAINERS = /avi|mpegts|mpeg-?ts|\bts\b|m2ts|vob|asf|wmv|flv|3gp/i

function estimatedAudioBitrate(a: MediaAnalysis): number {
  return a.audio.reduce((sum, t) => sum + (t.bitrateBps ?? (t.channels ?? 2) * 64_000), 0)
}

function currentVideoBitrate(a: MediaAnalysis): number | null {
  if (a.video?.bitrateBps) return a.video.bitrateBps
  if (a.overallBitrateBps) return Math.max(0, a.overallBitrateBps - estimatedAudioBitrate(a))
  return null
}

const GB = 1024 ** 3

export function recommend(a: MediaAnalysis, policy: OptimisationPolicy): Recommendation {
  const base: Recommendation = {
    action: 'keep',
    targetCodec: null,
    currentSizeBytes: a.sizeBytes,
    predictedSizeBytes: null,
    estimatedSavingBytes: null,
    estimatedSavingPercent: null,
    quality: 'Unchanged',
    reason: '',
    notes: [],
  }

  if (!a.video) {
    return { ...base, reason: 'No video stream to optimise.' }
  }

  const src = a.video.codec ?? 'unknown'
  const target = policy.video.targetCodec
  const remuxable = a.container ? LEGACY_CONTAINERS.test(a.container) : false

  // Already-optimal / skip cases → keep (or lossless remux for legacy containers).
  const alreadyOptimal = src === target || policy.video.skipCodecs.includes(src as VideoCodec)
  const notEligible = !policy.video.convertCodecs.includes(src as VideoCodec)

  if (alreadyOptimal || notEligible) {
    const reason = src === target
      ? `Already ${target.toUpperCase()}.`
      : policy.video.skipCodecs.includes(src as VideoCodec)
        ? `${src.toUpperCase()} is treated as already efficient by this policy.`
        : `${src.toUpperCase()} is not in this policy's conversion list.`
    if (remuxable) {
      return { ...base, action: 'remux', quality: 'Lossless', reason: `${reason} Container ${a.container} would benefit from a lossless remux to MKV.` }
    }
    return { ...base, reason }
  }

  // Dolby Vision safety: an automatic transcode can't preserve DV without a RPU
  // toolchain, so when the policy preserves DV we never recommend converting it.
  if (a.video.dolbyVision && policy.video.preserve.dolbyVision) {
    if (remuxable) return { ...base, action: 'remux', quality: 'Lossless', reason: `Dolby Vision present — preserving it (transcode would strip DV). Container ${a.container} can still be losslessly remuxed to MKV.` }
    return { ...base, reason: 'Dolby Vision present — preserving it; an automatic transcode would strip the DV metadata.' }
  }

  // Eligible for conversion → estimate the saving.
  const notes: string[] = []
  if (a.video.hdrFormat !== 'SDR' && policy.video.preserve.hdr) {
    notes.push(`${a.video.hdrFormat} — HDR metadata will be carried through the transcode.`)
  }

  const vBitrate = currentVideoBitrate(a)
  const srcEff = CODEC_EFFICIENCY[src] ?? 1.0
  const tgtEff = CODEC_EFFICIENCY[target] ?? 0.55

  if (!vBitrate || !a.durationSec) {
    return {
      ...base,
      action: 'convert',
      targetCodec: target,
      quality: policy.video.qualityMode === 'constant_quality' ? `No visible difference (CRF ${policy.video.crf})` : 'Policy-defined',
      reason: `Current codec is ${src.toUpperCase()}; convert to ${target.toUpperCase()}. Saving unknown (bitrate/duration unavailable).`,
      notes,
    }
  }

  const audioBps = estimatedAudioBitrate(a)
  const predictedVideoBps = vBitrate * (tgtEff / srcEff)
  const predictedSize = Math.round(((predictedVideoBps + audioBps) * a.durationSec) / 8)
  const savingBytes = Math.max(0, a.sizeBytes - predictedSize)
  const savingPercent = a.sizeBytes > 0 ? Math.round((savingBytes / a.sizeBytes) * 100) : 0

  const meetsThreshold = savingPercent >= policy.video.minimumSavingPercent && savingBytes >= policy.video.minimumSavingGb * GB

  const common = {
    targetCodec: target,
    predictedSizeBytes: predictedSize,
    estimatedSavingBytes: savingBytes,
    estimatedSavingPercent: savingPercent,
    quality: policy.video.qualityMode === 'constant_quality' ? `No visible difference (CRF ${policy.video.crf})` : 'Policy-defined',
    notes,
  }

  if (meetsThreshold) {
    return {
      ...base,
      ...common,
      action: 'convert',
      reason: `Current codec is ${src.toUpperCase()} at ${(vBitrate / 1_000_000).toFixed(1)} Mbps; ${target.toUpperCase()} is expected to reduce size by ~${savingPercent}%.`,
    }
  }

  return {
    ...base,
    ...common,
    action: 'skip',
    reason: `Estimated saving (${savingPercent}%, ${(savingBytes / GB).toFixed(1)} GB) is below the policy threshold (${policy.video.minimumSavingPercent}%, ${policy.video.minimumSavingGb} GB).`,
  }
}
