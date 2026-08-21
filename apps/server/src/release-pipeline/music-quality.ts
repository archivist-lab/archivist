import {
  HIFI_LOSSY_MIN_KBPS, LOSSLESS_CODECS, MUSIC_QUALITY_LADDER, musicQualityRank,
  type MusicCodec, type MusicQuality, type ParsedMusicQuality,
} from '@archivist/contracts'

/**
 * Reads quality out of a music release title.
 *
 * Music releases advertise quality in the title far more consistently than
 * video does — "Mp3 320kbps", "FLAC 24bit 96kHz", "[V0]" — so a title parse is
 * enough to grade and rank without opening a single file.
 */

const CODEC_PATTERNS: Array<{ codec: MusicCodec; match: RegExp }> = [
  { codec: 'FLAC', match: /\bflac\b/i },
  { codec: 'ALAC', match: /\balac\b/i },
  { codec: 'WAV', match: /\b(wav|aiff?)\b/i },
  { codec: 'APE', match: /\b(ape|monkey'?s audio)\b/i },
  { codec: 'WV', match: /\b(wavpack|wv)\b/i },
  { codec: 'OPUS', match: /\bopus\b/i },
  { codec: 'OGG', match: /\b(ogg|vorbis)\b/i },
  { codec: 'M4A', match: /\bm4a\b/i },
  { codec: 'AAC', match: /\baac\b/i },
  { codec: 'WMA', match: /\bwma\b/i },
  { codec: 'MP3', match: /\b(mp3|mpeg-?3)\b/i },
]

/** Trailing "[GROUP]" or "-GROUP", the way music scene releases sign off. */
const GROUP_PATTERNS = [
  /\[([A-Za-z0-9_.]{2,20})\]\s*[^\]]*$/,
  /-\s*([A-Za-z0-9_.]{2,20})\s*$/,
]

function readReleaseGroup(title: string): string | null {
  for (const pattern of GROUP_PATTERNS) {
    const found = pattern.exec(title.trim())
    if (found) return found[1].toUpperCase()
  }
  return null
}

/** VBR presets, mapped to the constant bitrate they sit closest to. */
const VBR_PRESETS: Array<{ match: RegExp; kbps: number }> = [
  { match: /\bv0\b/i, kbps: 320 },
  { match: /\bv1\b/i, kbps: 256 },
  { match: /\bv2\b/i, kbps: 224 },
  { match: /\baps\b/i, kbps: 256 },
  { match: /\bape?x\b/i, kbps: 192 },
]

function firstMatch<T>(candidates: Array<{ match: RegExp } & T>, title: string): T | null {
  for (const candidate of candidates) if (candidate.match.test(title)) return candidate
  return null
}

/** "24bit", "24-bit", "24 bit", or "16/44" style pairs. */
function readBitDepth(title: string): number | null {
  const explicit = /\b(16|24|32)[\s-]?bits?\b/i.exec(title)
  if (explicit) return Number(explicit[1])
  const pair = /\b(16|24|32)\s*[/\\|]\s*(44|48|88|96|176|192)/i.exec(title)
  return pair ? Number(pair[1]) : null
}

/** "96kHz", "44.1", "24/96". */
function readSampleRate(title: string): number | null {
  const explicit = /\b(44\.1|44|48|88\.2|88|96|176\.4|176|192)\s*k?hz\b/i.exec(title)
  if (explicit) return Math.round(Number(explicit[1]))
  const pair = /\b(?:16|24|32)\s*[/\\|]\s*(44|48|88|96|176|192)/i.exec(title)
  return pair ? Number(pair[1]) : null
}

/** "320kbps", "320 kb/s", "[320]". */
function readBitrate(title: string): number | null {
  const explicit = /\b(\d{2,4})\s*k(?:bps|b\/s|bit)\b/i.exec(title)
  if (explicit) {
    const value = Number(explicit[1])
    if (value >= 32 && value <= 2000) return value
  }
  const bare = /\b(96|112|128|160|192|224|256|320)\b/.exec(title)
  return bare ? Number(bare[1]) : null
}

/**
 * Places a release on the ladder. Lossless grades on depth and sample rate,
 * lossy on bitrate; a lossless release with no stated rate is treated as CD,
 * which is the overwhelmingly common case.
 */
function gradeQuality(input: { lossless: boolean; bitrateKbps: number | null }): MusicQuality | null {
  if (input.lossless) return 'lossless'
  if (input.bitrateKbps === null) return null
  return input.bitrateKbps >= HIFI_LOSSY_MIN_KBPS ? 'hifi-lossy' : 'lofi-lossy'
}

export function parseMusicQuality(releaseTitle: string): ParsedMusicQuality {
  const title = releaseTitle ?? ''
  const codec = firstMatch(CODEC_PATTERNS, title)?.codec ?? null
  const lossless = codec !== null && LOSSLESS_CODECS.includes(codec)

  const bitDepth = lossless ? readBitDepth(title) : null
  const sampleRateKhz = lossless ? readSampleRate(title) : null
  const bitrateKbps = lossless
    ? null
    : (firstMatch(VBR_PRESETS, title)?.kbps ?? readBitrate(title))

  const quality = gradeQuality({ lossless, bitrateKbps })

  return {
    quality,
    codec,
    lossless,
    bitrateKbps,
    bitDepth,
    sampleRateKhz,
    releaseGroup: readReleaseGroup(title),
    unknown: quality === null && codec === null,
  }
}

export interface MusicQualityPolicy {
  /** Ladder rung to reach, from the profile's target_resolution column. */
  targetQuality?: string | null
  /** Container the profile insists on, from target_codec. */
  targetCodec?: string | null
  /** Never accept anything below the target rather than merely preferring it. */
  requireTarget?: boolean
}

export interface MusicReleaseScore {
  /** Higher is better. Releases failing a hard requirement score below zero. */
  score: number
  rejected: boolean
  reason: string | null
  parsed: ParsedMusicQuality
}

/**
 * Grades one candidate release against a policy.
 *
 * Quality dominates seeders: a well-seeded 128kbps rip should never beat a
 * quieter FLAC when the profile asked for lossless. Seeders only separate
 * releases that already sit on the same rung.
 */
export function scoreMusicRelease(
  releaseTitle: string,
  seeders: number,
  policy: MusicQualityPolicy = {},
): MusicReleaseScore {
  const parsed = parseMusicQuality(releaseTitle)
  const targetRank = musicQualityRank(policy.targetQuality)
  const rank = musicQualityRank(parsed.quality)

  if (policy.targetCodec && parsed.codec && parsed.codec !== policy.targetCodec) {
    return { score: -1, rejected: true, reason: `${parsed.codec} is not ${policy.targetCodec}`, parsed }
  }
  if (policy.requireTarget && targetRank > 0 && rank < targetRank) {
    const wanted = MUSIC_QUALITY_LADDER.find(rung => rung.id === policy.targetQuality)
    return { score: -1, rejected: true, reason: `below ${wanted?.label ?? policy.targetQuality}`, parsed }
  }

  // Rank is worth far more than seed count, but seeders still break ties and
  // still pull a dead release down.
  const seedScore = Math.min(Math.log10(Math.max(seeders, 0) + 1) * 3, 9)
  return { score: rank * 10 + seedScore, rejected: false, reason: null, parsed }
}

/** Best-first ordering for a candidate list. */
export function rankMusicReleases<T extends { title: string; seeders?: number | null }>(
  releases: T[],
  policy: MusicQualityPolicy = {},
): Array<T & { musicScore: MusicReleaseScore }> {
  return releases
    .map(release => ({ ...release, musicScore: scoreMusicRelease(release.title, release.seeders ?? 0, policy) }))
    .filter(entry => !entry.musicScore.rejected)
    .sort((a, b) => b.musicScore.score - a.musicScore.score)
}
