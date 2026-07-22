import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { scoreRelease, buildTierMatchers, type ScoredRelease } from '@archivist/core'
import type { RejectRules } from '../shared/settings.js'

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

export function parseQualityFromTitle(title: string, scorer: (title: string) => ScoredRelease = scoreRelease): CandidateQuality {
  const tier = scorer(title).tier
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

// ── Guardrail-distance ranking ────────────────────────────────────────────────
//
// Guardrails (a target resolution/source/codec) are SOFT preferences, not
// filters: every candidate is kept and ranked by how far it sits from the
// target on the ordered ladders above. Distance 0 = exact match on every
// specified axis. Weighted so resolution dominates source dominates codec, so
// "closest to 1080p" never loses to a codec quibble.

export interface QualityTarget {
  resolution?: string | null
  source?: string | null
  codec?: string | null
}

const GUARDRAIL_AXES: Array<{ key: 'resolution' | 'source' | 'codec'; scores: Record<string, number>; weight: number }> = [
  { key: 'resolution', scores: RESOLUTION_SCORE, weight: 100 },
  { key: 'source', scores: SOURCE_SCORE, weight: 10 },
  { key: 'codec', scores: CODEC_SCORE, weight: 1 },
]

/** True when a guardrail value is set and not the "Any" sentinel. */
function isConstrained(value: string | null | undefined): value is string {
  return !!value && value !== 'Any'
}

/**
 * Distance from a candidate to the guardrail target — lower is closer, 0 is
 * exact. Only axes the target constrains (set and not "Any") contribute, so an
 * unset guardrail imposes no preference at all.
 */
export function guardrailDistance(candidate: CandidateQuality, target: QualityTarget): number {
  let distance = 0
  for (const axis of GUARDRAIL_AXES) {
    const want = target[axis.key]
    if (!isConstrained(want)) continue
    const wantScore = axis.scores[want] ?? 0
    const gotValue = candidate[axis.key]
    const gotScore = gotValue ? (axis.scores[gotValue] ?? 0) : 0
    distance += Math.abs(wantScore - gotScore) * axis.weight
  }
  return distance
}

/**
 * Absolute quality of a candidate on the same weighted ladders, ignoring any
 * target. Used to break ties: among releases equally close to the guardrail,
 * prefer the higher-quality one (so a 2160p ties-breaks above a 720p when the
 * target is 1080p).
 */
export function absoluteQuality(candidate: CandidateQuality): number {
  return (candidate.resolution ? RESOLUTION_SCORE[candidate.resolution] ?? 0 : 0) * 100
    + (candidate.source ? SOURCE_SCORE[candidate.source] ?? 0 : 0) * 10
    + (candidate.codec ? CODEC_SCORE[candidate.codec] ?? 0 : 0)
}

// ── Target floor + upgrade comparison ─────────────────────────────────────────
//
// A "floor" is the tier/source/resolution an item is configured to reach
// (target_*). `meetsQualityFloor` decides whether a downloaded file has reached
// it; `isQualityUpgrade` decides whether a candidate beats what's on disk. Both
// normalise loosely-typed inputs (e.g. target source "Web" vs ladder key "WEB")
// so a config/parse mismatch can't silently misjudge.

export interface QualityFloor {
  tier?: string | number | null
  resolution?: string | null
  source?: string | null
  codec?: string | null
}

export interface QualityEnvelope {
  floor?: QualityFloor
  ceiling?: QualityFloor
}

/** Tier target as a positive number (1 = best), or null for "Any"/unset. */
function parseTierFloor(v: string | number | null | undefined): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  const s = v.trim()
  if (!s || s.toLowerCase() === 'any') return null
  const m = s.match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

/** Map a loosely-typed resolution to a RESOLUTION_SCORE key. */
function normResolution(v: string): string {
  const s = v.trim().toLowerCase()
  if (s === '2160p' || s === '4k' || s === 'uhd') return '2160p'
  if (s === '1080p') return '1080p'
  if (s === '720p') return '720p'
  if (s === '480p' || s === '576p' || s === 'sd' || s === 'sdtv') return 'SD'
  return v
}

/** Map a loosely-typed source to a SOURCE_SCORE key. */
function normSource(v: string): string {
  const s = v.trim().toUpperCase()
  if (s === 'REMUX') return 'REMUX'
  if (s === 'BLURAY' || s === 'BLU-RAY' || s === 'BDRIP' || s === 'BRRIP') return 'BluRay'
  if (s === 'WEB' || s === 'WEBDL' || s === 'WEB-DL' || s === 'WEBRIP') return 'WEB'
  if (s === 'HDTV') return 'HDTV'
  if (s === 'DVD' || s === 'DVDRIP') return 'DVD'
  return v
}

/** Map a loosely-typed codec to a CODEC_SCORE key. */
function normCodec(v: string): string {
  const s = v.trim().toUpperCase().replace(/[.\s-]/g, '')
  if (s === 'AV1') return 'AV1'
  if (s === 'X265' || s === 'H265' || s === 'HEVC') return 'x265'
  if (s === 'X264' || s === 'H264' || s === 'AVC') return 'x264'
  return v
}

/** Does this floor constrain any axis (i.e. is it more than all-"Any")? */
export function hasQualityFloor(floor: QualityFloor): boolean {
  return parseTierFloor(floor.tier) != null
    || isConstrained(floor.resolution ?? undefined)
    || isConstrained(floor.source ?? undefined)
    || isConstrained(floor.codec ?? undefined)
}

/** True when a downloaded file meets/exceeds the floor on every constrained axis. */
export function meetsQualityFloor(current: CandidateQuality, floor: QualityFloor): boolean {
  const wantTier = parseTierFloor(floor.tier)
  if (wantTier != null) {
    if (!current.tier || current.tier > wantTier) return false // 0 = unknown; higher number = worse
  }
  if (isConstrained(floor.resolution)) {
    const want = RESOLUTION_SCORE[normResolution(floor.resolution)] ?? 0
    if (want > 0 && (current.resolution ? RESOLUTION_SCORE[current.resolution] ?? 0 : 0) < want) return false
  }
  if (isConstrained(floor.source)) {
    const want = SOURCE_SCORE[normSource(floor.source)] ?? 0
    if (want > 0 && (current.source ? SOURCE_SCORE[current.source] ?? 0 : 0) < want) return false
  }
  if (isConstrained(floor.codec)) {
    const want = CODEC_SCORE[normCodec(floor.codec)] ?? 0
    if (want > 0 && (current.codec ? CODEC_SCORE[current.codec] ?? 0 : 0) < want) return false
  }
  return true
}

/** True when a candidate does not exceed any configured maximum. */
export function meetsQualityCeiling(current: CandidateQuality, ceiling: QualityFloor): boolean {
  const wantTier = parseTierFloor(ceiling.tier)
  if (wantTier != null && (!current.tier || current.tier < wantTier)) return false
  if (isConstrained(ceiling.resolution)) {
    const want = RESOLUTION_SCORE[normResolution(ceiling.resolution)] ?? 0
    const got = current.resolution ? RESOLUTION_SCORE[current.resolution] ?? 0 : 0
    if (want > 0 && (!got || got > want)) return false
  }
  if (isConstrained(ceiling.source)) {
    const want = SOURCE_SCORE[normSource(ceiling.source)] ?? 0
    const got = current.source ? SOURCE_SCORE[current.source] ?? 0 : 0
    if (want > 0 && (!got || got > want)) return false
  }
  if (isConstrained(ceiling.codec)) {
    const want = CODEC_SCORE[normCodec(ceiling.codec)] ?? 0
    const got = current.codec ? CODEC_SCORE[current.codec] ?? 0 : 0
    if (want > 0 && (!got || got > want)) return false
  }
  return true
}

export function isWithinQualityEnvelope(candidate: CandidateQuality, envelope: QualityEnvelope): boolean {
  return meetsQualityFloor(candidate, envelope.floor ?? {})
    && meetsQualityCeiling(candidate, envelope.ceiling ?? {})
}

/** An upgrade must improve at least one axis and may not regress another. */
export function isNonRegressiveQualityUpgrade(current: CandidateQuality, candidate: CandidateQuality): boolean {
  const cur = [current.resolution ? RESOLUTION_SCORE[current.resolution] ?? 0 : 0,
    current.source ? SOURCE_SCORE[current.source] ?? 0 : 0,
    current.codec ? CODEC_SCORE[current.codec] ?? 0 : 0]
  const next = [candidate.resolution ? RESOLUTION_SCORE[candidate.resolution] ?? 0 : 0,
    candidate.source ? SOURCE_SCORE[candidate.source] ?? 0 : 0,
    candidate.codec ? CODEC_SCORE[candidate.codec] ?? 0 : 0]
  let improved = false
  const currentTier = current.tier || 0
  const candidateTier = candidate.tier || 0
  if (currentTier && (!candidateTier || candidateTier > currentTier)) return false
  if (candidateTier && (!currentTier || candidateTier < currentTier)) improved = true
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] && (!next[i] || next[i] < cur[i])) return false
    if (next[i] > cur[i]) improved = true
  }
  return improved
}

/** True when `candidate` beats `current` on any configured quality ladder. */
export function isQualityUpgrade(current: CandidateQuality, candidate: CandidateQuality): boolean {
  const curTier = current.tier || 99
  const candTier = candidate.tier || 99
  if (candTier < curTier) return true
  if ((candidate.resolution ? RESOLUTION_SCORE[candidate.resolution] ?? 0 : 0) > (current.resolution ? RESOLUTION_SCORE[current.resolution] ?? 0 : 0)) return true
  if ((candidate.source ? SOURCE_SCORE[candidate.source] ?? 0 : 0) > (current.source ? SOURCE_SCORE[current.source] ?? 0 : 0)) return true
  if ((candidate.codec ? CODEC_SCORE[candidate.codec] ?? 0 : 0) > (current.codec ? CODEC_SCORE[current.codec] ?? 0 : 0)) return true
  return false
}

// ── Reject rules (the explicit hard floor) ────────────────────────────────────
//
// The one place a release is dropped for its attributes rather than ranked
// down: a title matching a reject term (CAM/screener junk, a banned group) or
// falling below a resolution floor is refused outright, even in soft-guardrail
// auto mode. Everything else is kept and ranked.

export type RejectMatcher = (title: string, candidate: CandidateQuality) => string | null

/**
 * Compile a reject matcher once and reuse across a batch. Returns a function
 * that yields a rejection reason string, or null if the release passes.
 */
export function makeRejectMatcher(rules: RejectRules): RejectMatcher {
  const termMatchers = rules.terms
    .map(term => ({ term, rx: buildTierMatchers([term])[0] }))
    .filter((m): m is { term: string; rx: RegExp } => !!m.rx)
  const floor = rules.minResolution && rules.minResolution !== 'Any'
    ? RESOLUTION_SCORE[rules.minResolution] ?? 0
    : 0

  return (title, candidate) => {
    for (const m of termMatchers) {
      if (m.rx.test(title)) return `matches reject term "${m.term}"`
    }
    if (floor > 0 && candidate.resolution) {
      const res = RESOLUTION_SCORE[candidate.resolution] ?? 0
      // Only reject a known resolution below the floor — never drop an
      // unparseable one (that would silently discard wanted releases).
      if (res > 0 && res < floor) return `resolution ${candidate.resolution} below floor ${rules.minResolution}`
    }
    return null
  }
}
