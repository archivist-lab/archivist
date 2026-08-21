import { z } from 'zod'

/**
 * Music quality vocabulary.
 *
 * Video grades on resolution; music has no such axis, so the primary ladder is
 * a quality class. Three rungs is the whole useful range in practice — the
 * difference between 256k and 320k rarely decides a grab, whereas lossless
 * versus lossy always does.
 *
 * Codec is scoped to the class: a lossless class only offers lossless
 * containers, so "FLAC at 192kbps" is not expressible.
 *
 * Source is deliberately absent. Music releases state it inconsistently and it
 * almost never decides a grab, so it is not worth a field people must set.
 */

/** The ladder, best first. Stored in the `target_resolution` column. */
export const MusicQuality = z.enum(['lossless', 'hifi-lossy', 'lofi-lossy'])
export type MusicQuality = z.infer<typeof MusicQuality>

export interface MusicQualityRung {
  id: MusicQuality
  label: string
  /** Higher wins. Spaced so a rung can be inserted without renumbering. */
  rank: number
  lossless: boolean
  hint: string
  /** Containers valid for this class — drives the dependent codec picker. */
  codecs: string[]
}

export const MUSIC_QUALITY_LADDER: MusicQualityRung[] = [
  {
    id: 'lossless',
    label: 'Lossless',
    rank: 30,
    lossless: true,
    hint: 'FLAC, ALAC, WAV — bit-perfect',
    codecs: ['FLAC', 'ALAC', 'M4A', 'WAV', 'APE', 'WV'],
  },
  {
    id: 'hifi-lossy',
    label: 'Hi-Fi Lossy',
    rank: 20,
    lossless: false,
    hint: 'MP3 320 / V0, AAC 256 and above',
    codecs: ['MP3', 'AAC', 'M4A', 'OPUS', 'OGG'],
  },
  {
    id: 'lofi-lossy',
    label: 'Lo-Fi Lossy',
    rank: 10,
    lossless: false,
    hint: 'Below 256 kbps',
    codecs: ['MP3', 'AAC', 'M4A', 'OPUS', 'OGG', 'WMA'],
  },
]

/** The bitrate at or above which a lossy release counts as Hi-Fi. */
export const HIFI_LOSSY_MIN_KBPS = 256

const BY_ID = new Map(MUSIC_QUALITY_LADDER.map(rung => [rung.id, rung]))

export function musicQualityRung(id: string | null | undefined): MusicQualityRung | null {
  return id ? BY_ID.get(id as MusicQuality) ?? null : null
}

/** Rank for comparison. An unknown or absent quality sorts below every rung. */
export function musicQualityRank(id: string | null | undefined): number {
  return musicQualityRung(id)?.rank ?? 0
}

/** Containers offered for a chosen class; every known container when unset. */
export function codecsForQuality(quality: string | null | undefined): string[] {
  const rung = musicQualityRung(quality)
  if (rung) return rung.codecs
  return [...new Set(MUSIC_QUALITY_LADDER.flatMap(entry => entry.codecs))]
}

export const MusicCodec = z.enum(['FLAC', 'ALAC', 'M4A', 'WAV', 'APE', 'WV', 'MP3', 'AAC', 'OPUS', 'OGG', 'WMA'])
export type MusicCodec = z.infer<typeof MusicCodec>

export const LOSSLESS_CODECS: MusicCodec[] = ['FLAC', 'ALAC', 'WAV', 'APE', 'WV']

/** What a parser extracted from one release title. */
export interface ParsedMusicQuality {
  quality: MusicQuality | null
  codec: MusicCodec | null
  lossless: boolean
  /** Lossy only, in kbps. Null for lossless or when unstated. */
  bitrateKbps: number | null
  /** Lossless only. */
  bitDepth: number | null
  sampleRateKhz: number | null
  /** Release group, e.g. PMEDIA. */
  releaseGroup: string | null
  /** True when the title said nothing useful about quality. */
  unknown: boolean
}
