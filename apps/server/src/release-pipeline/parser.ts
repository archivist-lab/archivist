/**
 * Release-title parser, modelled on Sonarr/Radarr's NParser.
 *
 * Given a scene/p2p release title, extract structured info:
 *   - kind (series / movie / music / unknown)
 *   - parsed title (with year stripped)
 *   - season + episodes (single, multi, season pack, daily, anime absolute)
 *   - quality / source / codec / hdr / remux
 *   - audio codec + channels
 *   - release group, edition, language, proper/repack version
 *
 * The parser strips structural tokens left-to-right; whatever sits before the
 * first structural anchor (S01E02, year, daily date, etc.) is the title.
 */

import { parseQualityFromTitle } from '../services/quality.js'

export type ReleaseKind = 'series' | 'movie' | 'unknown'

export interface ParsedRelease {
  kind: ReleaseKind
  title: string
  titleNormalized: string
  year: number | null

  season: number | null
  /** Every season the release covers — [n] for single-season, [a..b] for range packs like S01-S06. */
  seasons: number[]
  episodes: number[]
  absoluteEpisode: number | null
  airDate: string | null
  isSeasonPack: boolean
  isMultiEpisode: boolean
  isSpecial: boolean

  resolution: '2160p' | '1080p' | '720p' | '480p' | 'SD' | null
  source: 'REMUX' | 'BluRay' | 'WEB' | 'HDTV' | 'DVD' | null
  codec: 'AV1' | 'x265' | 'x264' | null
  hdr: boolean
  remux: boolean
  threeD: boolean

  audioCodec: 'TrueHD' | 'DTS-HD' | 'DTS' | 'EAC3' | 'AC3' | 'AAC' | 'OPUS' | 'FLAC' | 'MP3' | null
  audioChannels: '7.1' | '5.1' | '2.0' | null

  releaseGroup: string | null
  edition: string | null
  language: string[]
  proper: number   // 0 = v1, 1 = PROPER, 2 = REPACK, 3 = REPACK2 ...
}

const RX = {
  container: /\.(mkv|mp4|avi|wmv|m4v|ts|webm|mov|flac|mp3|m4a)$/i,
  releaseGroup: /-([A-Za-z0-9][A-Za-z0-9._]{1,24})$/,
  // Strict S01E02 / S1E1 / S01.E02 / S01_E02 / S01xE02 — primary anchor only
  episodeStrict: /\bS(\d{1,3})[. _x-]?E(\d{1,3})/i,
  // Looking RIGHT AFTER an episodeStrict match: range end ("-E03" or "-03")
  episodeRangeAfter: /^-E?(\d{1,3})\b/i,
  // Looking right after: extra E-tagged episodes ("E02E03")
  episodeMultiAfter: /^[. _]?E(\d{1,3})(?:[. _]?E(\d{1,3}))?(?:[. _]?E(\d{1,3}))?/i,
  // Loose 1x02, 01x02
  episodeLoose: /\b(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?\b/i,
  // Multi-season range pack: S01-S06 / S01.S06 / S1-S6 (both sides S-prefixed so
  // "S01-06" — ambiguous with episode ranges — deliberately does NOT match)
  seasonRange: /\bS(\d{1,3})\s*[-–. ]\s*S(\d{1,3})\b(?!\s*E\d)/i,
  // Wordy form: "Seasons 1-6", "Season 1 to 6"
  seasonRangeWordy: /\bseasons?\s+(\d{1,3})\s*(?:[-–]|to)\s*(\d{1,3})\b/i,
  // S01 alone (season pack), but NOT inside a token like S01E02 — we run after episodeStrict
  seasonOnly: /\bS(\d{1,3})(?!\s*E\d|\d)\b/i,
  seasonPackComplete: /\b(?:Complete|COMPLETE|complete)\b/,
  // Daily air date: 2024.05.04 / 2024-05-04 / 2024_05_04
  dailyDate: /\b(19\d{2}|20\d{2})[. _-](\d{2})[. _-](\d{2})\b/,
  // Anime absolute: " - 01 ", " - 01v2 ", " 01 " between separators (avoid resolution numbers)
  animeAbsolute: /(?:\s|^)-\s+(\d{1,4})(?:v\d)?\s+(?=[\[(]|\d{3,4}p|$)/,
  animeAbsoluteBracket: /\[(\d{1,4})(?:v\d)?\]/,
  // 4-digit year, in parens or standalone — anchor to surroundings to avoid 2160p collisions
  yearInParens: /\((19\d{2}|20\d{2})\)/,
  yearStandalone: /\b(19\d{2}|20\d{2})\b/,
  // Specials / OVA
  special: /\b(OVA|ONA|Special|Specials|NCED|NCOP)\b/i,
  // Quality flags not covered by parseQualityFromTitle
  hdr: /\b(HDR(?:10\+?)?|DV|Dolby[. ]Vision|HLG)\b/i,
  remux: /\bremux\b/i,
  threeD: /\b3D\b/,
  // Audio
  audioCodec: /\b(TrueHD|DTS-?HD(?:\.MA)?|DTS|EAC3|DDP|DD\+|AC3|DD|AAC|OPUS|FLAC|MP3)\b/i,
  audioChannels: /\b([257])[. ]?[01]\b/,
  // Release version
  proper: /\bPROPER\b/i,
  repack: /\bREPACK(\d?)\b/i,
  // Language tokens
  language: /\b(MULTi|FRENCH|VOSTFR|GERMAN|SPANISH|ITALIAN|DUTCH|JAPANESE|KOREAN|RUSSIAN|HINDI|CHINESE|PORTUGUESE|POLISH|HEBREW|HUNGARIAN|TURKISH|SWEDISH|NORWEGIAN|DANISH|FINNISH|GREEK|UKRAINIAN|CZECH|THAI|VIETNAMESE|ARABIC|ROMANIAN|BULGARIAN|CROATIAN|SERBIAN|SLOVENIAN|SLOVAK)\b/i,
  edition: /\b(Extended|Director'?s\.?Cut|Theatrical|Criterion|Remastered|IMAX|Ultimate\.?Cut|Special\.?Edition|Unrated|Uncut)\b/i,
}

const LANGUAGE_MAP: Record<string, string> = {
  multi: 'multi', french: 'fr', vostfr: 'fr', german: 'de', spanish: 'es', italian: 'it',
  dutch: 'nl', japanese: 'ja', korean: 'ko', russian: 'ru', hindi: 'hi', chinese: 'zh',
  portuguese: 'pt', polish: 'pl', hebrew: 'he', hungarian: 'hu', turkish: 'tr',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
  ukrainian: 'uk', czech: 'cs', thai: 'th', vietnamese: 'vi', arabic: 'ar',
  romanian: 'ro', bulgarian: 'bg', croatian: 'hr', serbian: 'sr', slovenian: 'sl',
  slovak: 'sk',
}

export function normalizeTitle(s: string): string {
  return s.toLowerCase()
    .replace(/[‐-―−]/g, '-') // unicode hyphens → ascii
    .replace(/[''`´]/g, '')                  // strip apostrophes
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

// Tokens that look like "-GROUP" but are actually quality suffixes
const NOT_A_GROUP = /^(DL|RIP|REMUX|BluRay|BDRip|BRRip|HDTV|WEB|UHD|HDR|HD|SD|HEVC|AVC|AAC|MP3|FLAC|DD|DDP|DTS|TrueHD|EAC3|AC3|Atmos|x264|x265|H264|H265)$/i

function cleanTitle(raw: string): string {
  return raw
    .replace(/^\[[^\]]+\]\s*/, '')                 // strip leading [Group] for anime
    .replace(/[._]+/g, ' ')
    .replace(/\s*\(?\b(19\d{2}|20\d{2})\b\)?\s*$/, '')  // strip trailing year
    .replace(/\s+-\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function expandEpisodeRange(start: number, end: number): number[] {
  if (end < start || end - start > 30) return [start]
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

function audioChannelsToken(s: string | undefined): ParsedRelease['audioChannels'] {
  if (!s) return null
  if (s.startsWith('7')) return '7.1'
  if (s.startsWith('5')) return '5.1'
  if (s.startsWith('2')) return '2.0'
  return null
}

function audioCodecToken(s: string | undefined): ParsedRelease['audioCodec'] {
  if (!s) return null
  const u = s.toUpperCase().replace(/[.\s-]/g, '')
  if (u.startsWith('TRUEHD')) return 'TrueHD'
  if (u.startsWith('DTSHD')) return 'DTS-HD'
  if (u === 'DTS') return 'DTS'
  if (u === 'EAC3' || u === 'DDP' || u === 'DD+') return 'EAC3'
  if (u === 'AC3' || u === 'DD') return 'AC3'
  if (u === 'AAC') return 'AAC'
  if (u === 'OPUS') return 'OPUS'
  if (u === 'FLAC') return 'FLAC'
  if (u === 'MP3') return 'MP3'
  return null
}

export function parseRelease(rawTitle: string): ParsedRelease {
  const original = rawTitle.trim()
  // Working buffer — we mutate as we extract structural tokens
  let buf = original

  // 1. Strip container suffix
  buf = buf.replace(RX.container, '')

  // 2. Release group (suffix, before further mangling). Skip when the captured
  //    suffix is actually a quality token like the "DL" in "WEB-DL", or a season
  //    token — "Show.S01-S02.720p" must keep its range intact.
  const groupMatch = RX.releaseGroup.exec(buf)
  const releaseGroup = groupMatch && !NOT_A_GROUP.test(groupMatch[1]) && !/^S\d{1,3}\b/i.test(groupMatch[1])
    ? groupMatch[1]
    : null
  if (releaseGroup && groupMatch) buf = buf.slice(0, groupMatch.index)

  // 3. Quality/source/codec via existing helper (operates on the original)
  const q = parseQualityFromTitle(original)
  const hdr = RX.hdr.test(original)
  const remux = RX.remux.test(original)
  const threeD = RX.threeD.test(original)

  // 4. Audio
  const audioCodecMatch = RX.audioCodec.exec(original)
  const audioChannelsMatch = RX.audioChannels.exec(original)
  const audioCodec = audioCodecToken(audioCodecMatch?.[1])
  const audioChannels = audioChannelsToken(audioChannelsMatch?.[1])

  // 5. Proper/repack version
  let proper = 0
  if (RX.proper.test(original)) proper = 1
  const repackMatch = RX.repack.exec(original)
  if (repackMatch) proper = repackMatch[1] ? parseInt(repackMatch[1], 10) + 1 : 2

  // 6. Languages
  const language: string[] = []
  let langMatch: RegExpExecArray | null
  const langRx = new RegExp(RX.language.source, 'gi')
  while ((langMatch = langRx.exec(original)) != null) {
    const code = LANGUAGE_MAP[langMatch[1].toLowerCase().replace(/'/g, '')]
    if (code && !language.includes(code)) language.push(code)
  }

  // 7. Edition
  const editionMatch = RX.edition.exec(original)
  const edition = editionMatch?.[1].replace(/\./g, ' ') ?? null

  // 8. Structural parse — try patterns in priority order. Whichever matches
  //    first defines `kind` and the cut-point for the title.
  let kind: ReleaseKind = 'unknown'
  let season: number | null = null
  let seasons: number[] = []
  let episodes: number[] = []
  let absoluteEpisode: number | null = null
  let airDate: string | null = null
  let isSeasonPack = false
  let titleCut = buf

  // 8a. Strict S01E02 family — match the primary anchor, then look right after
  //     for range (-E03) or multi-episode (E03E04) extensions. This avoids the
  //     greedy-extension trap where ".720p" or ".DDP5.1" would get parsed as
  //     additional episode numbers.
  const epStrict = RX.episodeStrict.exec(buf)
  if (epStrict) {
    kind = 'series'
    season = parseInt(epStrict[1], 10)
    const firstEp = parseInt(epStrict[2], 10)
    const after = buf.slice(epStrict.index + epStrict[0].length)
    const rangeMatch = RX.episodeRangeAfter.exec(after)
    const multiMatch = RX.episodeMultiAfter.exec(after)
    if (rangeMatch && rangeMatch[1]) {
      episodes = expandEpisodeRange(firstEp, parseInt(rangeMatch[1], 10))
    } else if (multiMatch && multiMatch[1]) {
      episodes = [firstEp, ...[multiMatch[1], multiMatch[2], multiMatch[3]].filter(Boolean).map(n => parseInt(n!, 10))]
    } else {
      episodes = [firstEp]
    }
    seasons = [season]
    titleCut = buf.slice(0, epStrict.index)
  } else {
    // 8b. Daily date (must come before season-only to win for "Show 2024.05.04")
    const daily = RX.dailyDate.exec(buf)
    if (daily) {
      const y = parseInt(daily[1], 10)
      const m = parseInt(daily[2], 10)
      const d = parseInt(daily[3], 10)
      if (y >= 1950 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        kind = 'series'
        airDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        titleCut = buf.slice(0, daily.index)
      }
    }
    if (kind === 'unknown') {
      // 8c. Loose 1x02
      const epLoose = RX.episodeLoose.exec(buf)
      if (epLoose) {
        kind = 'series'
        season = parseInt(epLoose[1], 10)
        episodes = epLoose[3]
          ? expandEpisodeRange(parseInt(epLoose[2], 10), parseInt(epLoose[3], 10))
          : [parseInt(epLoose[2], 10)]
        seasons = [season]
        titleCut = buf.slice(0, epLoose.index)
      }
    }
    if (kind === 'unknown') {
      // 8d. Multi-season range pack (S01-S06 / "Seasons 1-6") — must run before
      //     the single-season check, which would otherwise swallow the first Sxx
      const range = RX.seasonRange.exec(buf) ?? RX.seasonRangeWordy.exec(buf)
      if (range) {
        const from = parseInt(range[1], 10)
        const to = parseInt(range[2], 10)
        if (to > from && to - from <= 50) {
          kind = 'series'
          season = from
          seasons = Array.from({ length: to - from + 1 }, (_, i) => from + i)
          episodes = []
          isSeasonPack = true
          titleCut = buf.slice(0, range.index)
        }
      }
    }
    if (kind === 'unknown') {
      // 8e. Season pack (S01 alone)
      const seasonOnly = RX.seasonOnly.exec(buf)
      if (seasonOnly) {
        kind = 'series'
        season = parseInt(seasonOnly[1], 10)
        seasons = [season]
        episodes = []
        isSeasonPack = true
        titleCut = buf.slice(0, seasonOnly.index)
      }
    }
    if (kind === 'unknown') {
      // 8f. Anime absolute episode " - 01 " or "[01]"
      const animeDash = RX.animeAbsolute.exec(buf)
      const animeBracket = RX.animeAbsoluteBracket.exec(buf)
      if (animeDash) {
        kind = 'series'
        absoluteEpisode = parseInt(animeDash[1], 10)
        titleCut = buf.slice(0, animeDash.index)
      } else if (animeBracket) {
        // brackets often appear AFTER the title in `[Group] Title - 01 [hash].mkv`
        // We use it only if no dash form found and the bracket is after a likely title boundary
        const beforeBracket = buf.slice(0, animeBracket.index)
        if (/\s-\s/.test(beforeBracket) || /\.\s/.test(beforeBracket)) {
          kind = 'series'
          absoluteEpisode = parseInt(animeBracket[1], 10)
          titleCut = beforeBracket
        }
      }
    }
    if (kind === 'unknown') {
      // 8f. Movie: year in parens or standalone year >= reasonable
      const yearParens = RX.yearInParens.exec(buf)
      if (yearParens) {
        kind = 'movie'
        titleCut = buf.slice(0, yearParens.index)
      } else {
        const yearStd = RX.yearStandalone.exec(buf)
        if (yearStd) {
          kind = 'movie'
          titleCut = buf.slice(0, yearStd.index)
        }
      }
    }
  }

  // 9. Year extraction (after kind decided so we don't grab a TV show's year mid-title)
  let year: number | null = null
  const yp = RX.yearInParens.exec(original)
  if (yp) year = parseInt(yp[1], 10)
  else {
    const ys = RX.yearStandalone.exec(buf)
    if (ys) year = parseInt(ys[1], 10)
  }

  // 10. Build clean title from titleCut (or fallback to whole buffer if nothing matched)
  const title = cleanTitle(titleCut || buf)

  // 11. Specials / OVA flag
  const isSpecial = RX.special.test(original)

  // 12. Movie/series ambiguity: if we got "movie" from a bare year but the title
  //     contains a season-y token like "Season 1", reclassify
  if (kind === 'movie' && /\bSeason\s*\d|\bComplete\s*Season/i.test(original)) {
    kind = 'series'
  }

  return {
    kind,
    title,
    titleNormalized: normalizeTitle(title),
    year,
    season,
    episodes,
    absoluteEpisode,
    airDate,
    seasons,
    isSeasonPack,
    isMultiEpisode: episodes.length > 1,
    isSpecial,
    resolution: q.resolution as ParsedRelease['resolution'],
    source: q.source as ParsedRelease['source'],
    codec: q.codec as ParsedRelease['codec'],
    hdr,
    remux,
    threeD,
    audioCodec,
    audioChannels,
    releaseGroup,
    edition: edition ?? q.edition,
    language,
    proper,
  }
}
