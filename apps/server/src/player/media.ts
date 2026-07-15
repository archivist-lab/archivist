import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import type { Response, Request } from 'express'
import { createLogger } from '@archivist/core'

/**
 * Player media helpers: probe a file's audio/subtitle tracks, extract text
 * subtitles to WebVTT, and produce a browser-compatible transcode on the fly.
 *
 * Direct play in a browser only works when the container and codecs are
 * supported (roughly: MP4/WebM with H.264/VP9/AV1 video and AAC/Opus/MP3
 * audio). Library files are frequently MKV with HEVC video and AC3/E-AC3/DTS
 * audio — which browsers cannot decode. These helpers let the Player show what
 * tracks exist, load text subtitles, and fall back to a transcoded stream when
 * direct play has no audio or won't play at all.
 */

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static') as { path: string }
let ffmpegPath: string
try { ffmpegPath = require('ffmpeg-static') as string } catch { ffmpegPath = 'ffmpeg' }

const logger = createLogger('PlayerMedia')
const MAX_PROBE_CACHE = 500
const probeCache = new Map<string, { mtimeMs: number; size: number; value: MediaTracks | null }>()
const configuredTranscodes = Number(process.env.ARCHIVIST_TRANSCODE_CONCURRENCY ?? 2)
const MAX_TRANSCODES = Number.isInteger(configuredTranscodes) && configuredTranscodes > 0 ? configuredTranscodes : 2
let activeTranscodes = 0

// Audio codecs a mainstream browser (<audio>/<video>) can decode directly.
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])
// Video codecs broadly playable in the browser. HEVC/VC1/MPEG2 are excluded —
// HEVC works only on some Safari/Edge setups, so we treat it as needing help.
const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
// Text subtitle codecs convertible to WebVTT. Bitmap subs (dvd_subtitle,
// hdmv_pgs_subtitle) cannot be — they'd require burn-in.
const TEXT_SUBTITLE = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'])

export interface AudioTrack {
  index: number
  codec: string
  language: string | null
  title: string | null
  channels: number | null
  channelLayout: string | null
  default: boolean
  browserFriendly: boolean
}
export interface SubtitleTrack {
  index: number
  codec: string
  language: string | null
  title: string | null
  default: boolean
  forced: boolean
  textBased: boolean
}
export interface MediaTracks {
  container: string | null
  durationSec: number | null
  video: { codec: string | null; profile: string | null; pixFmt: string | null; browserFriendly: boolean } | null
  audio: AudioTrack[]
  subtitles: SubtitleTrack[]
  /** True when the browser can likely direct-play video AND the default audio. */
  directPlayable: boolean
}

export type PlayerMediaTiming = (operation: string, durationMs: number, outcome: 'ok' | 'error') => void

function emitTiming(timing: PlayerMediaTiming | undefined, operation: string, startedAt: number, outcome: 'ok' | 'error'): void {
  if (!timing) return
  try { timing(operation, Math.max(0, performance.now() - startedAt), outcome) } catch { /* timing cannot affect playback */ }
}

const langName = (code: string | null): string | null => {
  if (!code || code === 'und') return null
  const map: Record<string, string> = {
    eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German',
    ita: 'Italian', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', rus: 'Russian',
    por: 'Portuguese', dut: 'Dutch', nld: 'Dutch', pol: 'Polish', swe: 'Swedish', dan: 'Danish',
    fin: 'Finnish', nor: 'Norwegian', cze: 'Czech', ces: 'Czech', gre: 'Greek', ell: 'Greek',
    hun: 'Hungarian', rum: 'Romanian', ron: 'Romanian', slo: 'Slovak', tha: 'Thai', ara: 'Arabic',
    heb: 'Hebrew', tur: 'Turkish', hin: 'Hindi', vie: 'Vietnamese', ind: 'Indonesian', ukr: 'Ukrainian',
  }
  return map[code] ?? code.toUpperCase()
}

/** Probes a media file with ffprobe. Returns null if the probe fails. */
function probeTracksUncached(filePath: string): MediaTracks | null {
  const res = spawnSync(ffprobeStatic.path, [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,pix_fmt,channels,channel_layout,disposition:stream_tags=language,title',
    filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout) return null

  let json: any
  try { json = JSON.parse(res.stdout) } catch { return null }
  const streams: any[] = json.streams ?? []

  const videoStream = streams.find(s => s.codec_type === 'video')
  const video = videoStream ? {
    codec: videoStream.codec_name ?? null,
    profile: videoStream.profile ?? null,
    pixFmt: videoStream.pix_fmt ?? null,
    browserFriendly: BROWSER_VIDEO.has(videoStream.codec_name ?? ''),
  } : null

  const audio: AudioTrack[] = streams.filter(s => s.codec_type === 'audio').map(s => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    language: langName(s.tags?.language ?? null),
    title: s.tags?.title ?? null,
    channels: s.channels ?? null,
    channelLayout: s.channel_layout ?? null,
    default: !!s.disposition?.default,
    browserFriendly: BROWSER_AUDIO.has(s.codec_name ?? ''),
  }))

  const subtitles: SubtitleTrack[] = streams.filter(s => s.codec_type === 'subtitle').map(s => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    language: langName(s.tags?.language ?? null),
    title: s.tags?.title ?? null,
    default: !!s.disposition?.default,
    forced: !!s.disposition?.forced,
    textBased: TEXT_SUBTITLE.has(s.codec_name ?? ''),
  }))

  const defaultAudio = audio.find(a => a.default) ?? audio[0]
  const directPlayable = !!video?.browserFriendly && (!defaultAudio || defaultAudio.browserFriendly)

  const duration = parseFloat(json.format?.duration ?? '')

  return {
    container: json.format?.format_name ?? null,
    durationSec: Number.isFinite(duration) ? duration : null,
    video, audio, subtitles, directPlayable,
  }
}

/** Cached by path + size + mtime so repeated Player navigation does not spawn ffprobe. */
export function probeTracks(filePath: string, timing?: PlayerMediaTiming): MediaTracks | null {
  const startedAt = performance.now()
  let outcome: 'ok' | 'error' = 'error'
  try {
    let metadata
    try { metadata = statSync(filePath) } catch { return null }
    const cached = probeCache.get(filePath)
    if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
      outcome = cached.value ? 'ok' : 'error'
      return cached.value
    }

    const value = probeTracksUncached(filePath)
    outcome = value ? 'ok' : 'error'
    probeCache.set(filePath, { mtimeMs: metadata.mtimeMs, size: metadata.size, value })
    if (probeCache.size > MAX_PROBE_CACHE) probeCache.delete(probeCache.keys().next().value!)
    return value
  } finally { emitTiming(timing, 'probe', startedAt, outcome) }
}

/**
 * Extracts a text subtitle stream to WebVTT and streams it to the response.
 * `streamIndex` is the absolute ffprobe stream index.
 */
export function streamSubtitleVtt(filePath: string, streamIndex: number, res: Response, req: Request, timing?: PlayerMediaTiming): void {
  const startedAt = performance.now()
  let timed = false
  const finish = (outcome: 'ok' | 'error') => { if (!timed) { timed = true; emitTiming(timing, 'subtitle', startedAt, outcome) } }
  const proc = spawn(ffmpegPath, [
    '-loglevel', 'error',
    '-i', filePath,
    '-map', `0:${streamIndex}`,
    '-f', 'webvtt',
    'pipe:1',
  ])
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  proc.stdout.pipe(res)
  proc.stderr.on('data', d => logger.debug(`subtitle ffmpeg: ${d}`))
  proc.on('error', () => { finish('error'); if (!res.headersSent) res.status(500).end() })
  const kill = () => { try { proc.kill('SIGKILL') } catch {} }
  req.on('close', kill)
  proc.on('close', code => { finish(code === 0 ? 'ok' : 'error'); if (!res.writableEnded) res.end() })
}

export interface TranscodeOptions {
  audioIndex?: number   // absolute stream index of the audio track to use
  subtitleIndex?: number // absolute stream index of a text/bitmap sub to burn in
  startSec?: number     // seek before transcoding (compatible-mode seeking)
  videoCodec: string | null
  audioFilter?: string  // e.g. loudnorm chain for volume normalization
}

/**
 * Transcodes to a fragmented MP4 (H.264 + stereo AAC) and streams it. Video is
 * copied when already H.264 and no burn-in is requested; audio is always
 * re-encoded to AAC so it plays in every browser. Seeking in the client is done
 * by reloading with a new `startSec`.
 */
export function streamTranscode(filePath: string, opts: TranscodeOptions, res: Response, req: Request, timing?: PlayerMediaTiming): void {
  const startedAt = performance.now()
  let timed = false
  const finish = (outcome: 'ok' | 'error') => { if (!timed) { timed = true; emitTiming(timing, 'transcode', startedAt, outcome) } }
  if (activeTranscodes >= MAX_TRANSCODES) {
    finish('error')
    res.setHeader('Retry-After', '5')
    res.status(503).json({ error: 'Transcode capacity reached' })
    return
  }
  activeTranscodes += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    activeTranscodes = Math.max(0, activeTranscodes - 1)
  }

  const args: string[] = ['-loglevel', 'error']
  if (opts.startSec && opts.startSec > 0) args.push('-ss', String(opts.startSec))
  args.push('-i', filePath)

  const burnSubs = opts.subtitleIndex != null
  // Video: copy H.264 when we don't need to burn subtitles; otherwise encode.
  if (opts.videoCodec === 'h264' && !burnSubs) {
    args.push('-map', '0:v:0', '-c:v', 'copy')
  } else {
    args.push('-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p')
    if (burnSubs) {
      // Burn the chosen subtitle stream into the video.
      const esc = filePath.replace(/([':\\])/g, '\\$1')
      args.push('-vf', `subtitles='${esc}':si=${subtitleRelativeIndex(filePath, opts.subtitleIndex!)}`)
    }
  }

  // Audio: selected track (or default), always AAC stereo for compatibility.
  // An optional filter chain (loudnorm) normalizes the level.
  args.push('-map', opts.audioIndex != null ? `0:${opts.audioIndex}` : '0:a:0?')
  if (opts.audioFilter) args.push('-af', opts.audioFilter)
  args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k')

  args.push(
    '-sn', '-dn', // no subtitle/data streams in the output container
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  )

  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Cache-Control', 'no-store')
  const proc = spawn(ffmpegPath, args)
  proc.stdout.pipe(res)
  proc.stderr.on('data', d => logger.debug(`transcode ffmpeg: ${d}`))
  proc.on('error', err => {
    finish('error')
    release()
    logger.error(`transcode failed: ${err}`)
    if (!res.headersSent) res.status(500).end()
  })
  const kill = () => {
    release()
    try { proc.kill('SIGKILL') } catch {}
  }
  res.on('close', kill)
  proc.on('close', code => {
    finish(code === 0 ? 'ok' : 'error')
    release()
    if (!res.writableEnded) res.end()
  })
}

/**
 * ffmpeg's subtitles filter `si=` counts subtitle streams, not absolute
 * indices. Map an absolute stream index to its position among subtitle streams.
 */
function subtitleRelativeIndex(filePath: string, absoluteIndex: number): number {
  const tracks = probeTracks(filePath)
  if (!tracks) return 0
  const i = tracks.subtitles.findIndex(s => s.index === absoluteIndex)
  return i < 0 ? 0 : i
}
