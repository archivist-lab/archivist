import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { scoreRelease } from '@archivist/core'

export interface QualitySnapshot {
  current_tier: number
  current_resolution: string | null
  current_source: string | null
  current_codec: string | null
  current_release_group: string | null
  current_edition: string | null
  current_size_bytes: number | null
  current_release_title: string | null
}

export interface CandidateQuality {
  tier: number
  resolution: string | null
  source: string | null
  codec: string | null
  releaseGroup: string | null
  edition: string | null
}

const RESOLUTION_SCORE: Record<string, number> = { '2160p': 4, '1080p': 3, '720p': 2, SD: 1 }
const SOURCE_SCORE: Record<string, number> = { REMUX: 5, BluRay: 4, WEB: 3, HDTV: 2, DVD: 1 }
const CODEC_SCORE: Record<string, number> = { AV1: 4, x265: 3, HEVC: 3, x264: 2, AVC: 2 }

export function parseQualityFromTitle(title: string): CandidateQuality {
  const tier = scoreRelease(title).tier
  const resolution = /\b(2160p|4k|uhd)\b/i.test(title) ? '2160p'
    : /\b1080p\b/i.test(title) ? '1080p'
    : /\b720p\b/i.test(title) ? '720p'
    : /\b(480p|576p|dvdrip|sdtv)\b/i.test(title) ? 'SD'
    : null
  const source = /\bremux\b/i.test(title) ? 'REMUX'
    : /\bblu-?ray|bdrip|brrip\b/i.test(title) ? 'BluRay'
    : /\bweb-?dl|webrip|web\b/i.test(title) ? 'WEB'
    : /\bhdtv\b/i.test(title) ? 'HDTV'
    : /\bdvd|dvdrip\b/i.test(title) ? 'DVD'
    : null
  const codec = /\bav1\b/i.test(title) ? 'AV1'
    : /\b(x265|h\.?265|hevc)\b/i.test(title) ? 'x265'
    : /\b(x264|h\.?264|avc)\b/i.test(title) ? 'x264'
    : null
  const edition = /\b(extended|director'?s cut|theatrical|criterion|remastered|imax|ultimate cut|special edition)\b/i.exec(title)?.[1] ?? null
  const releaseGroup = /-([A-Za-z0-9][A-Za-z0-9._-]{1,24})$/.exec(title)?.[1] ?? null

  return { tier, resolution, source, codec, releaseGroup, edition }
}

export function buildQualitySnapshot(releaseTitle: string | null | undefined, filePath?: string | null): QualitySnapshot {
  const title = releaseTitle || (filePath ? basename(filePath) : '')
  const parsed = parseQualityFromTitle(title)
  let size: number | null = null
  if (filePath) {
    try {
      const stat = statSync(filePath)
      size = stat.isFile() ? stat.size : null
    } catch {}
  }
  return {
    current_tier: parsed.tier,
    current_resolution: parsed.resolution,
    current_source: parsed.source,
    current_codec: parsed.codec,
    current_release_group: parsed.releaseGroup,
    current_edition: parsed.edition,
    current_size_bytes: size,
    current_release_title: title || null,
  }
}

export function compareQuality(current: Partial<QualitySnapshot> | null | undefined, candidate: CandidateQuality): { isUpgrade: boolean; reasons: string[] } {
  const reasons: string[] = []
  const currentTier = Number(current?.current_tier ?? 0)
  if (candidate.tier > 0 && (currentTier === 0 || candidate.tier < currentTier)) {
    reasons.push(`candidate tier ${candidate.tier} beats current tier ${currentTier || 'none'}`)
  }

  const currentResolution = current?.current_resolution ?? null
  if (candidate.resolution && RESOLUTION_SCORE[candidate.resolution] > (currentResolution ? RESOLUTION_SCORE[currentResolution] ?? 0 : 0)) {
    reasons.push(`${candidate.resolution} beats ${currentResolution ?? 'unknown resolution'}`)
  }

  const currentSource = current?.current_source ?? null
  if (candidate.source && SOURCE_SCORE[candidate.source] > (currentSource ? SOURCE_SCORE[currentSource] ?? 0 : 0)) {
    reasons.push(`${candidate.source} beats ${currentSource ?? 'unknown source'}`)
  }

  const currentCodec = current?.current_codec ?? null
  if (candidate.codec && CODEC_SCORE[candidate.codec] > (currentCodec ? CODEC_SCORE[currentCodec] ?? 0 : 0)) {
    reasons.push(`${candidate.codec} beats ${currentCodec ?? 'unknown codec'}`)
  }

  return { isUpgrade: reasons.length > 0, reasons }
}
