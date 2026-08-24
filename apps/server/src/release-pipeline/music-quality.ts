import {
  HIFI_LOSSY_MIN_KBPS,
  LOSSLESS_CODECS,
  MUSIC_QUALITY_LADDER,
  musicQualityRank,
  type MusicCodec,
  type MusicQuality,
  type ParsedMusicQuality,
} from '@archivist/contracts'

/** Automatic grabs need more than a lone, potentially self-announced peer. */
export const AUTOMATIC_MUSIC_MIN_SEEDERS = 2

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
const GROUP_PATTERNS = [/\[([A-Za-z0-9_.]{2,20})\]\s*[^\]]*$/, /-\s*([A-Za-z0-9_.]{2,20})\s*$/]

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
  const bitrateKbps = lossless ? null : (firstMatch(VBR_PRESETS, title)?.kbps ?? readBitrate(title))

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
  /** Reject sparse swarms for automation while leaving manual choice available. */
  minimumSeeders?: number
}

export interface MusicReleaseScore {
  /** Higher is better. Releases failing a hard requirement score below zero. */
  score: number
  rejected: boolean
  reason: string | null
  parsed: ParsedMusicQuality
}

export interface AlbumReleaseIdentity {
  artist: string
  title: string
  albumType?: string | null
  trackCount?: number | null
  /** Concrete MusicBrainz release constraints; absent for legacy albums that
   * have not selected an edition. */
  releaseYear?: number | null
  edition?: string | null
  format?: string | null
}

export interface AlbumReleaseScopeAssessment {
  accepted: boolean
  reason: string | null
  /**
   * How many of the selected release's edition traits the candidate matches
   * (year, edition marker, physical format). Ranking preference only — these
   * describe a physical pressing, and uploaders rarely name rips after one, so
   * treating them as eligibility rejects the entire result set. Higher wins.
   */
  preference: number
  /** Edition traits the candidate did not match, for explainability. */
  unmet: string[]
}

function musicIdentityKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Establish identity and full-release scope before automatic quality ranking. */
const rejectScope = (reason: string): AlbumReleaseScopeAssessment =>
  ({ accepted: false, reason, preference: 0, unmet: [] })

export function assessAlbumReleaseScope(releaseTitle: string, album: AlbumReleaseIdentity): AlbumReleaseScopeAssessment {
  const releaseKey = musicIdentityKey(releaseTitle)
  const artistKey = musicIdentityKey(album.artist)
  const albumKey = musicIdentityKey(album.title)

  if (!artistKey || !albumKey) return rejectScope('album identity is incomplete')
  if (!releaseKey.includes(artistKey)) return rejectScope('release does not name the requested artist')
  if (!releaseKey.includes(albumKey)) return rejectScope('release does not name the requested album')

  // Remove the requested identity before checking scope words. This avoids
  // rejecting an album whose actual title contains a word such as "Sampler".
  const scopeKey = releaseKey.split(artistKey).join(' ').split(albumKey).join(' ').replace(/\s+/g, ' ').trim()
  const expectedType = musicIdentityKey(album.albumType ?? 'album')

  if (/\b(sampler|preview|partial|selected tracks?|album excerpts?)\b/.test(scopeKey)) {
    return rejectScope('release is marked as a sampler or partial album')
  }
  if (expectedType !== 'single' && /\bsingle\b/.test(scopeKey)) {
    return rejectScope('release is marked as a single')
  }
  if (expectedType !== 'ep' && /\bep\b/.test(scopeKey)) {
    return rejectScope('release is marked as an EP')
  }

  const declaredTracks = /\b(\d{1,3})\s*(?:tracks?|songs?)\b/.exec(scopeKey)
  if (declaredTracks && album.trackCount && album.trackCount > 1 && Number(declaredTracks[1]) < album.trackCount) {
    return rejectScope(`release declares ${Number(declaredTracks[1])} of ${album.trackCount} expected tracks`)
  }

  // Everything below describes the *selected pressing*, not whether the
  // candidate is the right album. A 1963 mono 12" vinyl selection would
  // otherwise reject every ordinary rip of the record.
  let preference = 0
  const unmet: string[] = []

  const releaseYears = [...releaseTitle.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match => Number(match[0]))
  if (album.releaseYear && releaseYears.length > 0) {
    if (releaseYears.includes(album.releaseYear)) preference += 1
    else unmet.push(`${album.releaseYear} edition`)
  }

  const editionKey = musicIdentityKey(album.edition ?? '')
  const editionMarker = ['super deluxe', 'deluxe', 'expanded', 'remaster', 'anniversary', 'mono', 'stereo'].find(marker => editionKey.includes(marker))
  if (editionMarker) {
    if (releaseKey.includes(editionMarker)) preference += 1
    else unmet.push(editionMarker)
  }

  const formatKey = musicIdentityKey(album.format ?? '')
  const requiredFormat = ['vinyl', 'sacd', 'cassette'].find(format => formatKey.includes(format))
  if (requiredFormat) {
    if (releaseKey.includes(requiredFormat)) preference += 1
    else unmet.push(requiredFormat)
  }

  return { accepted: true, reason: null, preference, unmet }
}

/**
 * Grades one candidate release against a policy.
 *
 * Quality dominates seeders: a well-seeded 128kbps rip should never beat a
 * quieter FLAC when the profile asked for lossless. Seeders only separate
 * releases that already sit on the same rung.
 */
export function scoreMusicRelease(releaseTitle: string, seeders: number, policy: MusicQualityPolicy = {}): MusicReleaseScore {
  const parsed = parseMusicQuality(releaseTitle)
  const targetRank = musicQualityRank(policy.targetQuality)
  const rank = musicQualityRank(parsed.quality)

  if (policy.minimumSeeders !== undefined && seeders < policy.minimumSeeders) {
    return { score: -1, rejected: true, reason: `${seeders} seeders is below the automatic minimum of ${policy.minimumSeeders}`, parsed }
  }

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
export function rankMusicReleases<T extends { title: string; seeders?: number | null; swarmScore?: number }>(
  releases: T[],
  policy: MusicQualityPolicy = {},
): Array<T & { musicScore: MusicReleaseScore }> {
  return releases
    .map(release => {
      const musicScore = scoreMusicRelease(release.title, release.seeders ?? 0, policy)
      return {
        ...release,
        musicScore: { ...musicScore, score: musicScore.score + (release.swarmScore ?? 0) },
      }
    })
    .filter(entry => !entry.musicScore.rejected)
    .sort((a, b) => b.musicScore.score - a.musicScore.score)
}

/** Automatic album ranking: identity/scope first, audio quality second. */
export function rankAlbumReleases<T extends { title: string; seeders?: number | null; swarmScore?: number }>(
  releases: T[],
  album: AlbumReleaseIdentity,
  policy: MusicQualityPolicy = {},
) {
  const inScope = releases.map(release => ({ ...release, scope: assessAlbumReleaseScope(release.title, album) })).filter(release => release.scope.accepted)
  // Quality ordering first, then lift the candidates that match the selected
  // pressing. A matching edition outranks a better-sounding mismatch; among
  // equal matches the audio score still decides.
  return rankMusicReleases(inScope, policy)
    .sort((a, b) => (b.scope.preference - a.scope.preference) || (b.musicScore.score - a.musicScore.score))
}
