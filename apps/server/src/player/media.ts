import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { Response, Request } from 'express'
import { createLogger } from '@archivist/core'
import { ffmpegPath, ffprobePath } from '../shared/ffmpeg.js'
import { detectHwCapabilities, ffmpegBinary, resolveEncoder, type Accelerator, type ResolvedEncoder } from '../tools/video-engine/hwaccel.js'

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


const logger = createLogger('PlayerMedia')
const MAX_PROBE_CACHE = 500
const probeCache = new Map<string, { mtimeMs: number; size: number; value: MediaTracks | null }>()
const configuredTranscodes = Number(process.env.ARCHIVIST_TRANSCODE_CONCURRENCY ?? 2)
const MAX_TRANSCODES = Number.isInteger(configuredTranscodes) && configuredTranscodes > 0 ? configuredTranscodes : 2
let activeTranscodes = 0

/** Constant-quality target for the compatibility stream, in libx264 CRF terms. */
const TRANSCODE_CRF = 21
const ACCELERATORS = new Set(['auto', 'off', 'nvenc', 'qsv', 'vaapi', 'amf', 'videotoolbox', 'software'])

/**
 * Playback transcodes are the one place a GPU matters most: they run while
 * someone is waiting, and software H.264 is roughly a whole core per stream.
 * `auto` picks the best accelerator the box actually has (see hwaccel.ts, which
 * requires both a compiled encoder and a matching GPU); `off` forces software.
 */
function accelPreference(): 'auto' | 'off' | Accelerator {
  const raw = process.env.ARCHIVIST_PLAYER_HWACCEL?.trim().toLowerCase()
  return raw && ACCELERATORS.has(raw) ? raw as 'auto' | 'off' | Accelerator : 'auto'
}

// One hardware failure means a broken driver or a missing device, not bad luck:
// every later stream would fail the same way and pay a wasted spawn to learn it.
let hardwareDisabled = false

/** Warms the (synchronous, cached) capability probe so no request pays for it. */
export function warmTranscodeCapabilities(): void {
  if (accelPreference() !== 'off') detectHwCapabilities()
}

/** The hardware encoder to use for playback, or null for software. */
function playerEncoder(): ResolvedEncoder | null {
  const preference = accelPreference()
  if (preference === 'off' || hardwareDisabled) return null
  const resolved = resolveEncoder('h264', preference)
  return resolved.accelerator === 'software' ? null : resolved
}

/**
 * Rate-control flags per encoder. Deliberately not shared with the video
 * engine's equivalent: that one encodes offline and can afford slow presets,
 * this one has to keep ahead of a viewer.
 */
function videoQualityArgs(accel: Accelerator): string[] {
  switch (accel) {
    case 'nvenc': return ['-rc', 'vbr', '-cq', String(TRANSCODE_CRF), '-preset', 'p4']
    case 'qsv': return ['-global_quality', String(TRANSCODE_CRF), '-preset', 'veryfast']
    case 'vaapi': return ['-rc_mode', 'CQP', '-qp', String(TRANSCODE_CRF)]
    case 'amf': return ['-rc', 'cqp', '-qp_i', String(TRANSCODE_CRF), '-qp_p', String(TRANSCODE_CRF)]
    case 'videotoolbox': return ['-q:v', String(Math.max(1, Math.min(100, 100 - TRANSCODE_CRF * 2)))]
    default: return ['-preset', 'veryfast', '-crf', String(TRANSCODE_CRF), '-pix_fmt', 'yuv420p']
  }
}

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
  languageCode: string | null
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
  languageCode: string | null
  language: string | null
  title: string | null
  default: boolean
  forced: boolean
  textBased: boolean
}
export interface MediaTracks {
  container: string | null
  durationSec: number | null
  video: { codec: string | null; profile: string | null; pixFmt: string | null; width: number | null; height: number | null; browserFriendly: boolean } | null
  audio: AudioTrack[]
  subtitles: SubtitleTrack[]
  /** True when the browser can likely direct-play video AND the default audio. */
  directPlayable: boolean
  chapters: Array<{ index: number; start: number; end: number | null; title: string }>
}

const SIDECAR_SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt'])

export interface SidecarSubtitle extends SubtitleTrack { filePath: string }

/** Subtitle files next to the media file, using the common Title.lang.srt convention. */
export function listSidecarSubtitles(filePath: string): SidecarSubtitle[] {
  const directory = dirname(filePath)
  const mediaBase = basename(filePath, extname(filePath))
  let names: string[]
  try { names = readdirSync(directory) } catch { return [] }
  return names
    .filter(name => {
      const extension = extname(name).toLowerCase()
      return SIDECAR_SUBTITLE_EXTENSIONS.has(extension)
        && (basename(name, extension) === mediaBase || basename(name, extension).startsWith(`${mediaBase}.`))
    })
    .sort((a, b) => a.localeCompare(b))
    .map((name, position) => {
      const extension = extname(name).toLowerCase()
      const stem = basename(name, extension)
      const suffix = stem === mediaBase ? '' : stem.slice(mediaBase.length + 1)
      const languageCode = suffix.split('.')[0] || null
      return {
        index: -(position + 1),
        codec: extension.slice(1),
        languageCode,
        language: langName(languageCode),
        title: suffix ? `External · ${suffix}` : 'External subtitle',
        default: false,
        forced: suffix.toLowerCase().split('.').includes('forced'),
        textBased: true,
        filePath: join(directory, name),
      }
    })
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
  const res = spawnSync(ffprobePath, [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,channels,channel_layout,disposition:stream_tags=language,title:chapter=id,start_time,end_time:chapter_tags=title',
    '-show_chapters',
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
    width: Number(videoStream.width) || null,
    height: Number(videoStream.height) || null,
    browserFriendly: BROWSER_VIDEO.has(videoStream.codec_name ?? ''),
  } : null

  const audio: AudioTrack[] = streams.filter(s => s.codec_type === 'audio').map(s => ({
    index: s.index,
    codec: s.codec_name ?? 'unknown',
    languageCode: s.tags?.language ?? null,
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
    languageCode: s.tags?.language ?? null,
    language: langName(s.tags?.language ?? null),
    title: s.tags?.title ?? null,
    default: !!s.disposition?.default,
    forced: !!s.disposition?.forced,
    textBased: TEXT_SUBTITLE.has(s.codec_name ?? ''),
  }))

  const defaultAudio = audio.find(a => a.default) ?? audio[0]
  const directPlayable = !!video?.browserFriendly && (!defaultAudio || defaultAudio.browserFriendly)

  const duration = parseFloat(json.format?.duration ?? '')
  const chapters = (json.chapters ?? []).map((chapter: any, index: number) => {
    const start = Number(chapter.start_time)
    const end = Number(chapter.end_time)
    return {
      index: Number.isSafeInteger(chapter.id) ? chapter.id : index,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : null,
      title: String(chapter.tags?.title || `Chapter ${index + 1}`).slice(0, 120),
    }
  }).filter((chapter: { start: number }) => chapter.start >= 0)

  return {
    container: json.format?.format_name ?? null,
    durationSec: Number.isFinite(duration) ? duration : null,
    video, audio, subtitles, directPlayable, chapters,
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

/** Converts an external subtitle sidecar to WebVTT. */
export function streamSidecarSubtitleVtt(filePath: string, res: Response, req: Request, timing?: PlayerMediaTiming): void {
  const startedAt = performance.now()
  let timed = false
  const finish = (outcome: 'ok' | 'error') => { if (!timed) { timed = true; emitTiming(timing, 'subtitle', startedAt, outcome) } }
  const proc = spawn(ffmpegPath, ['-loglevel', 'error', '-i', filePath, '-f', 'webvtt', 'pipe:1'])
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  proc.stdout.pipe(res)
  proc.stderr.on('data', d => logger.debug(`sidecar subtitle ffmpeg: ${d}`))
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
export function streamTranscode(filePath: string, opts: TranscodeOptions, res: Response, _req: Request, timing?: PlayerMediaTiming): void {
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

  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Cache-Control', 'no-store')

  // Video is only encoded when it isn't already browser-ready H.264, or when a
  // subtitle has to be burned in. The copy path needs no encoder at all, so it
  // never touches the GPU.
  const needsVideoEncode = !(opts.videoCodec === 'h264' && opts.subtitleIndex == null)
  const hardware = needsVideoEncode ? playerEncoder() : null

  let active: ReturnType<typeof spawn> | null = null
  let producedOutput = false
  let aborted = false
  let stderrTail = ''

  const start = (encode: ResolvedEncoder | null): void => {
    const args = buildTranscodeArgs(filePath, opts, encode)
    // hwaccel.ts may have picked a different ffmpeg build to get the hardware
    // encoders; the software path keeps the binary it has always used.
    const binary = encode ? ffmpegBinary() : ffmpegPath
    const proc = spawn(binary, args)
    active = proc
    proc.stdout.on('data', () => { producedOutput = true })
    // `end: false` because a failed hardware attempt has to be able to hand the
    // same response over to the software retry.
    proc.stdout.pipe(res, { end: false })
    proc.stderr.on('data', d => {
      stderrTail = String(d).slice(-400)
      logger.debug(`transcode ffmpeg: ${d}`)
    })
    // A hardware attempt that never produced a byte can still be retried in
    // software, so a spawn failure (a missing hardware-enabled ffmpeg, say)
    // must not end the response here — 'close' follows and runs the fallback.
    const recoverable = () => encode !== null && !producedOutput && !aborted
    proc.on('error', err => {
      if (proc !== active) return
      if (recoverable()) { stderrTail = String(err); return }
      finish('error')
      release()
      logger.error(`transcode failed: ${err}`)
      if (!res.headersSent) res.status(500).end()
      else if (!res.writableEnded) res.end()
    })
    proc.on('close', code => {
      if (proc !== active) return
      // A hardware encoder that dies before emitting a byte is a broken driver
      // or a missing device, not a bad file — fall back rather than showing the
      // viewer an error, and stop trying hardware for the rest of the process.
      if (code !== 0 && encode && recoverable()) {
        hardwareDisabled = true
        logger.warn(`${encode.accelerator} transcode failed, falling back to software: ${stderrTail.trim() || `exit ${code}`}`)
        proc.stdout.unpipe(res)
        start(null)
        return
      }
      finish(code === 0 ? 'ok' : 'error')
      release()
      if (!res.writableEnded) res.end()
    })
  }

  res.on('close', () => {
    aborted = true
    release()
    try { active?.kill('SIGKILL') } catch {}
  })

  if (hardware) logger.info(`Transcoding with ${hardware.encoder} (${hardware.accelerator})`)
  start(hardware)
}

/**
 * Builds the ffmpeg argument list. Pure, so the hardware and software attempts
 * differ only in what is passed here — and so it can be asserted on in tests
 * without a GPU.
 */
export function buildTranscodeArgs(filePath: string, opts: TranscodeOptions, encode: ResolvedEncoder | null): string[] {
  const args: string[] = ['-loglevel', 'error']
  const burnSubs = opts.subtitleIndex != null
  const copyVideo = opts.videoCodec === 'h264' && !burnSubs

  // Hardware device initialisation has to precede -i.
  if (!copyVideo && encode?.device) {
    if (encode.accelerator === 'vaapi') args.push('-vaapi_device', encode.device)
    else if (encode.accelerator === 'qsv') args.push('-init_hw_device', `vaapi=va:${encode.device}`, '-init_hw_device', 'qsv=hw@va', '-filter_hw_device', 'hw')
  }
  if (opts.startSec && opts.startSec > 0) args.push('-ss', String(opts.startSec))
  args.push('-i', filePath)

  // Video: copy H.264 when we don't need to burn subtitles; otherwise encode.
  if (copyVideo) {
    args.push('-map', '0:v:0', '-c:v', 'copy')
  } else {
    const accel: Accelerator = encode?.accelerator ?? 'software'
    args.push('-map', '0:v:0', '-c:v', encode?.encoder ?? 'libx264')
    const filters: string[] = []
    if (burnSubs) {
      // Burn the chosen subtitle stream into the video.
      const esc = filePath.replace(/([':\\])/g, '\\$1')
      filters.push(`subtitles='${esc}':si=${subtitleRelativeIndex(filePath, opts.subtitleIndex!)}`)
    }
    // VAAPI and QSV encode from GPU surfaces, so frames are uploaded after any
    // software filter. Decoding stays on the CPU on purpose: a full hardware
    // decode would have to hwdownload before the subtitle filter and hwupload
    // after it, and that round-trip costs more than the decode saves.
    if (accel === 'vaapi') filters.push('format=nv12', 'hwupload')
    else if (accel === 'qsv') filters.push('hwupload=extra_hw_frames=64', 'format=qsv')
    if (filters.length) args.push('-vf', filters.join(','))
    args.push(...videoQualityArgs(accel))
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
  return args
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
