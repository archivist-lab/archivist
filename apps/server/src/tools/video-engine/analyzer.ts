/**
 * Media Analysis Engine — the read-only first stage of the Video Optimisation
 * Engine. Runs ffprobe once per file and captures a rich, codec-agnostic picture
 * of the video/audio/subtitle/chapter/container so the policy + recommendation
 * stages can reason about it. Analysis is deliberately separate from execution.
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createLogger } from '@archivist/core'

const require = createRequire(import.meta.url)
const ffprobe = (require('ffprobe-static') as { path: string }).path

const logger = createLogger('MediaAnalysis')

export type HdrFormat = 'SDR' | 'HDR10' | 'HDR10+' | 'HLG' | 'Dolby Vision'

export interface VideoAnalysis {
  codec: string | null
  codecLong: string | null
  profile: string | null
  width: number | null
  height: number | null
  /** 2160p / 1080p / 720p / 576p / 480p / SD */
  resolutionLabel: string | null
  frameRate: number | null
  /** Video stream bitrate in bits/sec (best-effort; may be derived). */
  bitrateBps: number | null
  bitDepth: number | null
  pixFmt: string | null
  /** 4:2:0 / 4:2:2 / 4:4:4 */
  chroma: string | null
  colorSpace: string | null
  colorTransfer: string | null
  colorPrimaries: string | null
  hdrFormat: HdrFormat
  dolbyVision: boolean
  /** HDR10 mastering-display metadata, pre-formatted for x265 `master-display`. */
  masterDisplayX265: string | null
  /** HDR10 content light level, formatted for x265 `max-cll` ("maxCLL,maxFALL"). */
  maxCll: string | null
}

export interface AudioAnalysis {
  index: number
  codec: string
  language: string | null
  channels: number | null
  channelLayout: string | null
  bitrateBps: number | null
  default: boolean
  forced: boolean
  commentary: boolean
}

export interface SubtitleAnalysis {
  index: number
  codec: string
  language: string | null
  forced: boolean
  sdh: boolean
  textBased: boolean
}

export interface ChapterAnalysis {
  count: number
  hasNames: boolean
}

export interface MediaAnalysis {
  path: string
  sizeBytes: number
  container: string | null
  durationSec: number | null
  /** Whole-file average bitrate in bits/sec. */
  overallBitrateBps: number | null
  video: VideoAnalysis | null
  audio: AudioAnalysis[]
  subtitles: SubtitleAnalysis[]
  chapters: ChapterAnalysis
}

const TEXT_SUBTITLE = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

function resolutionLabel(height: number | null): string | null {
  if (!height) return null
  if (height >= 2000) return '2160p'
  if (height >= 1300) return '1440p'
  if (height >= 1000) return '1080p'
  if (height >= 700) return '720p'
  if (height >= 550) return '576p'
  if (height >= 420) return '480p'
  return 'SD'
}

function evalFrameRate(raw: string | undefined): number | null {
  if (!raw) return null
  const [n, d] = raw.split('/').map(Number)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null
  return Math.round((n / d) * 1000) / 1000
}

function chromaFromPixFmt(pixFmt: string | null): string | null {
  if (!pixFmt) return null
  if (pixFmt.includes('444')) return '4:4:4'
  if (pixFmt.includes('422')) return '4:2:2'
  if (pixFmt.includes('420')) return '4:2:0'
  return null
}

function bitDepthFromPixFmt(pixFmt: string | null, bitsPerRaw: string | undefined): number | null {
  const raw = Number(bitsPerRaw)
  if (Number.isFinite(raw) && raw > 0) return raw
  if (!pixFmt) return null
  if (pixFmt.includes('12le') || pixFmt.includes('12be') || pixFmt.includes('p12')) return 12
  if (pixFmt.includes('10le') || pixFmt.includes('10be') || pixFmt.includes('p10')) return 10
  return 8
}

function evalFrac(v: unknown): number {
  const s = String(v ?? '')
  const [n, d] = s.split('/').map(Number)
  if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n / d
  return Number.isFinite(Number(s)) ? Number(s) : 0
}

/**
 * HDR10 mastering-display/max-cll live in per-FRAME side data (SEI), which
 * `-show_streams` does not surface — probe the first frame to recover them.
 */
function probeFrameHdr(filePath: string): { masterDisplayX265: string | null; maxCll: string | null } {
  const res = spawnSync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', '%+#1', '-show_frames', '-print_format', 'json',
    filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout) return { masterDisplayX265: null, maxCll: null }
  try {
    const frames = JSON.parse(res.stdout).frames ?? []
    return extractHdrMetadata(frames[0]?.side_data_list ?? [])
  } catch { return { masterDisplayX265: null, maxCll: null } }
}

/** Extract HDR10 mastering-display + max-cll from ffprobe side_data, formatted for x265. */
function extractHdrMetadata(sideData: any[]): { masterDisplayX265: string | null; maxCll: string | null } {
  const md = sideData.find(sd => /mastering display/i.test(String(sd?.side_data_type ?? '')))
  const cll = sideData.find(sd => /content light/i.test(String(sd?.side_data_type ?? '')))

  let masterDisplayX265: string | null = null
  if (md && md.red_x != null) {
    // Chromaticity coords in x265 units of 0.00002 (fraction × 50000); luminance in 0.0001 nits (× 10000).
    const c = (v: unknown) => Math.round(evalFrac(v) * 50000)
    const l = (v: unknown) => Math.round(evalFrac(v) * 10000)
    masterDisplayX265 =
      `G(${c(md.green_x)},${c(md.green_y)})B(${c(md.blue_x)},${c(md.blue_y)})R(${c(md.red_x)},${c(md.red_y)})` +
      `WP(${c(md.white_point_x)},${c(md.white_point_y)})L(${l(md.max_luminance)},${l(md.min_luminance)})`
  }
  const maxCll = cll ? `${cll.max_content ?? 0},${cll.max_average ?? 0}` : null
  return { masterDisplayX265, maxCll }
}

function detectHdr(stream: any): { hdrFormat: HdrFormat; dolbyVision: boolean } {
  const sideData: any[] = stream.side_data_list ?? []
  const codecTag = String(stream.codec_tag_string ?? '').toLowerCase()
  const dolbyVision = codecTag === 'dvhe' || codecTag === 'dvh1' || codecTag === 'dav1'
    || sideData.some(sd => typeof sd?.dv_profile !== 'undefined' || /dolby vision/i.test(String(sd?.side_data_type ?? '')))

  const transfer = String(stream.color_transfer ?? '').toLowerCase()
  const hasHdr10Plus = sideData.some(sd => /hdr dynamic metadata|dynamic hdr/i.test(String(sd?.side_data_type ?? '')))

  let hdrFormat: HdrFormat = 'SDR'
  if (dolbyVision) hdrFormat = 'Dolby Vision'
  else if (transfer === 'arib-std-b67') hdrFormat = 'HLG'
  else if (transfer === 'smpte2084') hdrFormat = hasHdr10Plus ? 'HDR10+' : 'HDR10'

  return { hdrFormat, dolbyVision }
}

/** Probe a file with ffprobe and return a full optimisation-oriented analysis. */
export function analyzeMedia(filePath: string): MediaAnalysis | null {
  let sizeBytes = 0
  try { sizeBytes = statSync(filePath).size } catch { return null }

  const res = spawnSync(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    filePath,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })

  if (res.status !== 0 || !res.stdout) {
    logger.debug(`ffprobe failed for ${filePath}: ${res.stderr?.slice(0, 200)}`)
    return null
  }

  let json: any
  try { json = JSON.parse(res.stdout) } catch { return null }

  const streams: any[] = json.streams ?? []
  const format = json.format ?? {}
  const durationSec = Number.isFinite(parseFloat(format.duration)) ? parseFloat(format.duration) : null
  const overallBitrateBps = Number(format.bit_rate) || (durationSec ? Math.round((sizeBytes * 8) / durationSec) : null)

  const vs = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  let video: VideoAnalysis | null = null
  if (vs) {
    const { hdrFormat, dolbyVision } = detectHdr(vs)
    const { masterDisplayX265, maxCll } = extractHdrMetadata(vs.side_data_list ?? [])
    const pixFmt = vs.pix_fmt ?? null
    const streamBitrate = Number(vs.bit_rate) || Number(vs.tags?.BPS) || null
    video = {
      codec: vs.codec_name ?? null,
      codecLong: vs.codec_long_name ?? null,
      profile: vs.profile ?? null,
      width: vs.width ?? null,
      height: vs.height ?? null,
      resolutionLabel: resolutionLabel(vs.height ?? null),
      frameRate: evalFrameRate(vs.avg_frame_rate) ?? evalFrameRate(vs.r_frame_rate),
      bitrateBps: streamBitrate,
      bitDepth: bitDepthFromPixFmt(pixFmt, vs.bits_per_raw_sample),
      pixFmt,
      chroma: chromaFromPixFmt(pixFmt),
      colorSpace: vs.color_space ?? null,
      colorTransfer: vs.color_transfer ?? null,
      colorPrimaries: vs.color_primaries ?? null,
      hdrFormat,
      dolbyVision,
      masterDisplayX265,
      maxCll,
    }
    // HDR10 static metadata is per-frame — recover it with a first-frame probe.
    if ((video.hdrFormat === 'HDR10' || video.hdrFormat === 'HDR10+') && !video.masterDisplayX265) {
      const fromFrame = probeFrameHdr(filePath)
      video.masterDisplayX265 = fromFrame.masterDisplayX265
      video.maxCll = fromFrame.maxCll
    }
  }

  const audio: AudioAnalysis[] = streams.filter(s => s.codec_type === 'audio').map(s => {
    const title = String(s.tags?.title ?? '')
    return {
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: s.tags?.language ?? null,
      channels: s.channels ?? null,
      channelLayout: s.channel_layout ?? null,
      bitrateBps: Number(s.bit_rate) || Number(s.tags?.BPS) || null,
      default: !!s.disposition?.default,
      forced: !!s.disposition?.forced,
      commentary: !!s.disposition?.comment || /commentary/i.test(title),
    }
  })

  const subtitles: SubtitleAnalysis[] = streams.filter(s => s.codec_type === 'subtitle').map(s => {
    const title = String(s.tags?.title ?? '')
    return {
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      language: s.tags?.language ?? null,
      forced: !!s.disposition?.forced || /forced/i.test(title),
      sdh: !!s.disposition?.hearing_impaired || /\bsdh\b|hearing/i.test(title),
      textBased: TEXT_SUBTITLE.has(s.codec_name ?? ''),
    }
  })

  const chapters: any[] = json.chapters ?? []
  const chapterAnalysis: ChapterAnalysis = {
    count: chapters.length,
    hasNames: chapters.length > 0 && chapters.every(c => !!c.tags?.title),
  }

  return {
    path: filePath,
    sizeBytes,
    container: format.format_name ?? null,
    durationSec,
    overallBitrateBps,
    video,
    audio,
    subtitles,
    chapters: chapterAnalysis,
  }
}
