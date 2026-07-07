/**
 * Media Processor — strips unwanted audio and subtitle tracks from video files.
 *
 * Uses ffprobe to analyse streams and ffmpeg to remux (copy, no re-encode)
 * keeping only the desired language tracks.
 *
 * Default behaviour:
 *   Preferred-language originals: keep every preferred-language audio/subtitle track.
 *   Foreign-language originals: keep original-language audio/subtitles plus preferred
 *   audio/subtitles.
 */

import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync, statSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, basename, extname, join } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'

const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static')

let ffmpegPath: string
try {
  ffmpegPath = require('ffmpeg-static')
} catch {
  ffmpegPath = 'ffmpeg' // fallback to system ffmpeg
}

const logger = createLogger('MediaProcessor')

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrackCleanerConfig {
  enabled: boolean
  preferredLanguage: string       // user's primary language (ISO 639-1, e.g. 'en', 'es', 'fr')
  keepOriginalLanguage: boolean   // keep audio in the film's original language
  keepPreferredAudio: boolean     // keep audio in preferred language
  keepPreferredSubs: boolean      // keep subtitles in preferred language
  keepCommentary: boolean         // keep commentary audio tracks
  additionalLanguages: string[]   // extra language codes to keep (e.g. ['spa', 'fre'])
}

export const DEFAULT_TRACK_CLEANER: TrackCleanerConfig = {
  enabled: true,
  preferredLanguage: 'en',
  keepOriginalLanguage: true,
  keepPreferredAudio: true,
  keepPreferredSubs: true,
  keepCommentary: true,
  additionalLanguages: [],
}

interface StreamInfo {
  index: number
  codec_type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment'
  codec_name: string
  tags?: {
    language?: string
    title?: string
    handler_name?: string
  }
  channels?: number
  disposition?: {
    default?: number
    forced?: number
    comment?: number
    hearing_impaired?: number
  }
}

interface ProbeResult {
  streams: StreamInfo[]
}

export interface ChapterProbeResult {
  count: number
  chapters: Array<{ number: number; title: string; startTime: number; endTime: number }>
}

export interface CleanResult {
  success: boolean
  message: string
  removedAudio: number
  removedSubs: number
  originalSize: number
  newSize: number
}

// ── Settings helpers ─────────────────────────────────────────────────────────

export function getTrackCleanerConfig(): TrackCleanerConfig {
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM app_settings WHERE library_id = 0 AND key = 'trackCleaner'").get() as { value: string } | undefined
    const subtitleRow = db.prepare("SELECT value FROM app_settings WHERE library_id = 0 AND key = 'subtitles'").get() as { value: string } | undefined
    const subtitleDefault = subtitleRow ? (JSON.parse(subtitleRow.value).defaultLanguage as string | undefined) : undefined
    if (!row) return { ...DEFAULT_TRACK_CLEANER, preferredLanguage: subtitleDefault ?? DEFAULT_TRACK_CLEANER.preferredLanguage }

    const stored = JSON.parse(row.value)
    return {
      ...DEFAULT_TRACK_CLEANER,
      ...stored,
      preferredLanguage: stored.preferredLanguage ?? subtitleDefault ?? DEFAULT_TRACK_CLEANER.preferredLanguage,
    }
  } catch {
    return DEFAULT_TRACK_CLEANER
  }
}

// ── ISO 639 language matching ────────────────────────────────────────────────

// Maps common TMDB original_language (ISO 639-1) to ISO 639-2/B codes used by ffprobe
const LANG_MAP: Record<string, string[]> = {
  en: ['eng', 'en'],
  es: ['spa', 'es'],
  fr: ['fre', 'fra', 'fr'],
  de: ['ger', 'deu', 'de'],
  it: ['ita', 'it'],
  pt: ['por', 'pt'],
  ru: ['rus', 'ru'],
  ja: ['jpn', 'ja'],
  ko: ['kor', 'ko'],
  zh: ['chi', 'zho', 'zh', 'cmn', 'yue', 'cn'],
  cn: ['chi', 'zho', 'zh', 'cmn', 'yue', 'cn'],
  yue: ['chi', 'zho', 'zh', 'cmn', 'yue', 'cn'],
  hi: ['hin', 'hi'],
  ar: ['ara', 'ar'],
  nl: ['dut', 'nld', 'nl'],
  sv: ['swe', 'sv'],
  no: ['nor', 'no', 'nob', 'nno'],
  da: ['dan', 'da'],
  fi: ['fin', 'fi'],
  pl: ['pol', 'pl'],
  tr: ['tur', 'tr'],
  th: ['tha', 'th'],
  cs: ['cze', 'ces', 'cs'],
  hu: ['hun', 'hu'],
  ro: ['rum', 'ron', 'ro'],
  el: ['gre', 'ell', 'el'],
  he: ['heb', 'he'],
  uk: ['ukr', 'uk'],
  vi: ['vie', 'vi'],
  id: ['ind', 'id'],
  ms: ['may', 'msa', 'ms'],
  tl: ['tgl', 'fil', 'tl'],
}

function langMatches(streamLang: string | undefined, targetLang: string): boolean {
  if (!streamLang) return false
  const sl = streamLang.toLowerCase().split('-')[0]
  const tl = targetLang.toLowerCase().split('-')[0]
  if (sl === tl) return true

  // Check via LANG_MAP
  const variants = LANG_MAP[tl]
  if (variants && variants.includes(sl)) return true

  // Also check if targetLang is itself a 3-letter code
  for (const [, codes] of Object.entries(LANG_MAP)) {
    if (codes.includes(tl) && codes.includes(sl)) return true
  }
  return false
}

function isCommentary(stream: StreamInfo): boolean {
  const title = (stream.tags?.title ?? '').toLowerCase()
  return (
    title.includes('commentary') ||
    title.includes('director') ||
    title.includes('cast') ||
    (stream.disposition?.comment ?? 0) === 1
  )
}

function isMusicOnly(stream: StreamInfo): boolean {
  const title = `${stream.tags?.title ?? ''} ${stream.tags?.handler_name ?? ''}`.toLowerCase()
  return title.includes('music only') || title.includes('score only') || title.includes('isolated score')
}

function isUnknownLanguage(lang: string | undefined): boolean {
  return !lang || ['und', 'unk', 'unknown'].includes(lang.toLowerCase())
}

function streamMatchesAny(lang: string | undefined, langs: Set<string>): boolean {
  for (const wantLang of langs) {
    if (langMatches(lang, wantLang)) return true
  }
  return false
}

// ── Core processing ──────────────────────────────────────────────────────────

function probe(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(ffprobeStatic.path, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_entries', 'stream=index,codec_type,codec_name,channels,disposition:stream_tags=language,title,handler_name',
      filePath,
    ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(new Error('Failed to parse ffprobe output'))
      }
    })
  })
}

export function probeChapters(filePath: string): Promise<ChapterProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-i', filePath,
      '-f', 'ffmetadata',
      '-'
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      const chapters: Array<{ number: number; title: string; startTime: number; endTime: number }> = []
      let currentChapter: { number: number; title: string; startTime: number; endTime: number } | null = null
      let timebaseNum = 1, timebaseDen = 1
      
      const lines = (stdout || '').split(/\r?\n/)
      for (const line of lines) {
        if (line.trim() === '[CHAPTER]') {
          if (currentChapter) chapters.push(currentChapter)
          currentChapter = { number: chapters.length + 1, title: `Chapter ${chapters.length + 1}`, startTime: 0, endTime: 0 }
        } else if (currentChapter) {
          const match = line.match(/^([^=]+)=(.*)$/)
          if (match) {
            const key = match[1].toUpperCase()
            const value = match[2]
            if (key === 'TIMEBASE') {
              const tbMatch = value.match(/^(\d+)\/(\d+)$/)
              if (tbMatch) {
                timebaseNum = Number.parseInt(tbMatch[1], 10) || 1
                timebaseDen = Number.parseInt(tbMatch[2], 10) || 1
              }
            } else if (key === 'START') {
              currentChapter.startTime = (Number.parseInt(value, 10) * timebaseNum) / timebaseDen
            } else if (key === 'END') {
              currentChapter.endTime = (Number.parseInt(value, 10) * timebaseNum) / timebaseDen
            } else if (key === 'TITLE') {
              currentChapter.title = value
            }
          }
        }
      }
      if (currentChapter) chapters.push(currentChapter)

      if (err && chapters.length === 0) {
        return reject(new Error('Failed to parse ffmpeg chapter output'))
      }
      resolve({ count: chapters.length, chapters })
    })
  })
}

class AsyncQueue {
  private queue: (() => Promise<void>)[] = [];
  private activeCount = 0;

  constructor(private concurrency: number) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const res = await task();
          resolve(res);
        } catch (e) {
          reject(e);
        }
      });
      this.process();
    });
  }

  private process() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
    this.activeCount++;
    const task = this.queue.shift()!;
    task().finally(() => {
      this.activeCount--;
      this.process();
    });
  }
}

const ffmpegQueue = new AsyncQueue(Number.parseInt(process.env.MAX_CONCURRENT_ENCODES || '2', 10));

function runFfmpeg(args: string[]): Promise<void> {
  return ffmpegQueue.add(() => {
    return new Promise((resolve, reject) => {
      execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024, timeout: 0 }, (err: ExecFileException | null) => {
        if (err) return reject(err)
        resolve()
      })
    })
  })
}

/**
 * Process a single video file — strip unwanted audio/subtitle tracks.
 *
 * @param filePath    Absolute path to the video file
 * @param originalLang  ISO 639-1 code from TMDB (e.g. 'en', 'ko', 'ja')
 * @param config      Track cleaner settings
 * @returns           Result summary
 */
export async function cleanTracks(
  filePath: string,
  originalLang: string | null,
  config?: TrackCleanerConfig,
): Promise<CleanResult> {
  const cfg = config ?? getTrackCleanerConfig()

  if (!cfg.enabled) {
    return { success: true, message: 'Track cleaner disabled', removedAudio: 0, removedSubs: 0, originalSize: 0, newSize: 0 }
  }

  if (!existsSync(filePath)) {
    return { success: false, message: `File not found: ${filePath}`, removedAudio: 0, removedSubs: 0, originalSize: 0, newSize: 0 }
  }

  const ext = extname(filePath).toLowerCase()
  if (!['.mkv', '.mp4', '.m4v'].includes(ext)) {
    return { success: true, message: `Skipped non-remuxable format: ${ext}`, removedAudio: 0, removedSubs: 0, originalSize: 0, newSize: 0 }
  }

  // Build the set of languages we want to keep for audio
  const preferredLang = cfg.preferredLanguage || 'en'
  const originalMatchesPreferred = originalLang ? langMatches(originalLang, preferredLang) : false
  const keepAudioLangs = new Set<string>()
  if (cfg.keepPreferredAudio) keepAudioLangs.add(preferredLang)
  if (cfg.keepOriginalLanguage && originalLang) keepAudioLangs.add(originalLang)
  for (const lang of cfg.additionalLanguages) keepAudioLangs.add(lang)

  const keepSubLangs = new Set<string>()
  if (cfg.keepPreferredSubs) keepSubLangs.add(preferredLang)
  if (cfg.keepOriginalLanguage && originalLang) keepSubLangs.add(originalLang)
  for (const lang of cfg.additionalLanguages) keepSubLangs.add(lang)

  let probeResult: ProbeResult
  try {
    probeResult = await probe(filePath)
  } catch (err) {
    return { success: false, message: `ffprobe failed: ${err instanceof Error ? err.message : String(err)}`, removedAudio: 0, removedSubs: 0, originalSize: 0, newSize: 0 }
  }

  const streams = probeResult.streams
  const videoStreams = streams.filter(s => s.codec_type === 'video')
  const audioStreams = streams.filter(s => s.codec_type === 'audio')
  const subStreams = streams.filter(s => s.codec_type === 'subtitle')
  const otherStreams = streams.filter(s => s.codec_type !== 'video' && s.codec_type !== 'audio' && s.codec_type !== 'subtitle')

  // Decide which audio streams to keep
  const keepAudioIndices = new Set<number>()
  for (const s of audioStreams) {
    const lang = s.tags?.language
    const isComm = isCommentary(s)
    const keepByLanguage = streamMatchesAny(lang, keepAudioLangs)

    // If a stream is in a language we retain, keep all variants: main, commentary,
    // music-only/isolated score, descriptive tracks, etc.
    if (keepByLanguage) {
      keepAudioIndices.add(s.index)
      continue
    }

    // Keep explicitly requested commentary/music-only tracks even when their
    // language tag is absent. This avoids deleting English commentary from
    // files that tag extras as "und".
    if (cfg.keepCommentary && (isComm || isMusicOnly(s)) && (isUnknownLanguage(lang) || originalMatchesPreferred)) {
      keepAudioIndices.add(s.index)
      continue
    }

    // Unknown language: keep the first one as a safety net so bad tags cannot
    // produce a silent file.
    if (isUnknownLanguage(lang) && keepAudioIndices.size === 0) {
      keepAudioIndices.add(s.index)
    }
  }

  // Safety: always keep at least one audio stream
  if (keepAudioIndices.size === 0 && audioStreams.length > 0) {
    keepAudioIndices.add(audioStreams[0]!.index)
  }

  // Safety: never leave a movie with commentary/music-only as the only audio
  // when the source had a normal programme track available.
  const sourceHasProgrammeAudio = audioStreams.some(s => !isCommentary(s) && !isMusicOnly(s))
  const keptProgrammeAudio = audioStreams.some(s => keepAudioIndices.has(s.index) && !isCommentary(s) && !isMusicOnly(s))
  if (sourceHasProgrammeAudio && !keptProgrammeAudio) {
    const fallback = audioStreams.find(s => !isCommentary(s) && !isMusicOnly(s))
    if (fallback) keepAudioIndices.add(fallback.index)
  }

  // Decide which subtitle streams to keep
  const keepSubIndices = new Set<number>()
  let forcedSubIndex: number | null = null
  const isOriginalPreferred = originalMatchesPreferred

  for (const s of subStreams) {
    const lang = s.tags?.language
    // Keep every subtitle track in retained languages: full, forced, SDH,
    // commentary subtitles, signs/songs, etc.
    if (streamMatchesAny(lang, keepSubLangs)) {
      keepSubIndices.add(s.index)
      const isForced = (s.disposition?.forced ?? 0) === 1
      const title = (s.tags?.title ?? '').toLowerCase()
      if (langMatches(lang, preferredLang) && (isForced || title.includes('forced'))) {
        forcedSubIndex = s.index
      }
      continue
    }
  }

  const removedAudio = audioStreams.length - keepAudioIndices.size
  const removedSubs = subStreams.length - keepSubIndices.size

  // Determine if we need disposition changes
  const needsDispositionFix = !isOriginalPreferred || (isOriginalPreferred && forcedSubIndex !== null)

  // Nothing to remove and no disposition fix needed — skip processing
  if (removedAudio === 0 && removedSubs === 0 && !needsDispositionFix) {
    logger.info(`[MediaProcessor] No tracks to remove from ${basename(filePath)}`)
    return { success: true, message: 'No unwanted tracks found', removedAudio: 0, removedSubs: 0, originalSize: 0, newSize: 0 }
  }

  // Build ffmpeg map arguments
  const mapArgs: string[] = []

  // Map all video streams
  for (const s of videoStreams) {
    mapArgs.push('-map', `0:${s.index}`)
  }
  // Map kept audio streams and track output indices
  let outputAudioIdx = 0
  let originalLangAudioOutputIdx: number | null = null
  for (const s of audioStreams) {
    if (keepAudioIndices.has(s.index)) {
      mapArgs.push('-map', `0:${s.index}`)
      // Track the first original-language audio stream for disposition
      if (!isOriginalPreferred && originalLang && originalLangAudioOutputIdx === null && langMatches(s.tags?.language, originalLang)) {
        originalLangAudioOutputIdx = outputAudioIdx
      }
      outputAudioIdx++
    }
  }
  // Map kept subtitle streams and track output subtitle index for disposition
  let outputSubIdx = 0
  let forcedOutputSubIdx: number | null = null
  let firstPreferredSubOutputIdx: number | null = null
  for (const s of subStreams) {
    if (keepSubIndices.has(s.index)) {
      mapArgs.push('-map', `0:${s.index}`)
      if (s.index === forcedSubIndex) {
        forcedOutputSubIdx = outputSubIdx
      }
      if (firstPreferredSubOutputIdx === null && langMatches(s.tags?.language, preferredLang)) {
        firstPreferredSubOutputIdx = outputSubIdx
      }
      outputSubIdx++
    }
  }
  // Map attachments (fonts etc. for subtitles)
  for (const s of otherStreams) {
    if (s.codec_type === 'attachment') {
      mapArgs.push('-map', `0:${s.index}`)
    }
  }

  // Build disposition arguments
  const dispositionArgs: string[] = []
  if (isOriginalPreferred) {
    // Film is in user's preferred language: set forced sub as default subtitle
    if (forcedOutputSubIdx !== null) {
      dispositionArgs.push(`-disposition:s:${forcedOutputSubIdx}`, 'default+forced')
      for (let i = 0; i < outputSubIdx; i++) {
        if (i !== forcedOutputSubIdx) {
          dispositionArgs.push(`-disposition:s:${i}`, '0')
        }
      }
    }
  } else {
    // Film is NOT in user's preferred language: set original audio as default, preferred subs as default
    if (originalLangAudioOutputIdx !== null) {
      dispositionArgs.push(`-disposition:a:${originalLangAudioOutputIdx}`, 'default')
      for (let i = 0; i < outputAudioIdx; i++) {
        if (i !== originalLangAudioOutputIdx) {
          dispositionArgs.push(`-disposition:a:${i}`, '0')
        }
      }
    }
    if (firstPreferredSubOutputIdx !== null) {
      dispositionArgs.push(`-disposition:s:${firstPreferredSubOutputIdx}`, 'default')
      for (let i = 0; i < outputSubIdx; i++) {
        if (i !== firstPreferredSubOutputIdx) {
          dispositionArgs.push(`-disposition:s:${i}`, '0')
        }
      }
    }
  }

  const originalSize = statSync(filePath).size
  const dir = dirname(filePath)
  const base = basename(filePath, ext)
  const tmpPath = join(dir, `${base}.cleaning${ext}`)
  let originalChapters: ChapterProbeResult | null = null
  try {
    originalChapters = await probeChapters(filePath)
  } catch {
    originalChapters = null
  }

  logger.info(`[MediaProcessor] Cleaning ${basename(filePath)}: removing ${removedAudio} audio, ${removedSubs} subtitle tracks`)

  try {
    await runFfmpeg([
      '-i', filePath,
      ...mapArgs,
      '-map_metadata', '0',
      '-map_metadata:c', '0:c',
      '-map_chapters', '0', // Keep chapters
      '-c', 'copy',         // no re-encoding
      ...dispositionArgs,
      '-y',                 // overwrite tmp if exists
      tmpPath,
    ])

    // Verify the output file exists and is reasonable
    if (!existsSync(tmpPath)) {
      throw new Error('ffmpeg produced no output file')
    }
    const newSize = statSync(tmpPath).size
    if (newSize < originalSize * 0.1) {
      // Output suspiciously small — something went wrong
      unlinkSync(tmpPath)
      throw new Error(`Output file too small (${newSize} bytes vs ${originalSize} original)`)
    }

    if (originalChapters && originalChapters.count > 0) {
      const cleanedChapters = await probeChapters(tmpPath)
      if (cleanedChapters.count < originalChapters.count) {
        unlinkSync(tmpPath)
        throw new Error(`Refusing to replace file because chapter count dropped from ${originalChapters.count} to ${cleanedChapters.count}`)
      }
    }

    // Atomic replace: rename tmp over original
    renameSync(tmpPath, filePath)

    const saved = originalSize - newSize
    const savedMB = (saved / 1024 / 1024).toFixed(1)
    logger.info(`[MediaProcessor] Done: saved ${savedMB} MB (${removedAudio} audio, ${removedSubs} subs removed)`)

    return { success: true, message: `Removed ${removedAudio} audio, ${removedSubs} subtitle tracks. Saved ${savedMB} MB`, removedAudio, removedSubs, originalSize, newSize }
  } catch (err) {
    // Clean up temp file if it exists
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[MediaProcessor] Failed to process ${basename(filePath)}: ${msg}`)
    return { success: false, message: msg, removedAudio: 0, removedSubs: 0, originalSize, newSize: originalSize }
  }
}

/**
 * Check if ffmpeg is available and working.
 */
export async function checkFfmpegAvailable(): Promise<{ available: boolean; version: string }> {
  return new Promise(resolve => {
    execFile(ffmpegPath, ['-version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve({ available: false, version: '' })
        return
      }
      const match = stdout.match(/ffmpeg version (\S+)/)
      resolve({ available: true, version: match?.[1] ?? 'unknown' })
    })
  })
}

// ── Embedded file metadata editing (chapters + stream titles) ────────────────

export interface EditableChapter {
  title: string
  startTime: number
  endTime?: number
}

export interface EditableStream {
  /** 0-based index within its own type (audio 0..n / subtitle 0..n). */
  typeIndex: number
  language?: string
  title?: string
  codec?: string
  channels?: number
}

export interface FileMetadataSnapshot {
  path: string
  durationSeconds: number | null
  chapters: Array<{ number: number; title: string; startTime: number; endTime: number }>
  audioTracks: EditableStream[]
  subtitleTracks: EditableStream[]
}

function probeDuration(filePath: string): Promise<number | null> {
  return new Promise(resolve => {
    execFile(ffprobeStatic.path, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_entries', 'format=duration',
      filePath,
    ], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const duration = parseFloat(JSON.parse(stdout)?.format?.duration)
        resolve(Number.isFinite(duration) ? duration : null)
      } catch {
        resolve(null)
      }
    })
  })
}

/** Precise chapters + per-type stream listing for the file editor UI. */
export async function readFileMetadata(filePath: string): Promise<FileMetadataSnapshot> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
  const [probeResult, chapters, durationSeconds] = await Promise.all([
    probe(filePath),
    probeChapters(filePath).catch(() => ({ count: 0, chapters: [] as FileMetadataSnapshot['chapters'] })),
    probeDuration(filePath),
  ])

  const byType = (type: 'audio' | 'subtitle'): EditableStream[] =>
    probeResult.streams
      .filter(s => s.codec_type === type)
      .map((s, i) => ({
        typeIndex: i,
        language: s.tags?.language,
        title: s.tags?.title,
        codec: s.codec_name,
        channels: s.channels,
      }))

  return {
    path: filePath,
    durationSeconds,
    chapters: chapters.chapters,
    audioTracks: byType('audio'),
    subtitleTracks: byType('subtitle'),
  }
}

/** ffmetadata values escape backslash, '=', ';', '#' and newlines. */
function escapeFfMetadata(value: string): string {
  return value.replace(/([\\=;#\n])/g, '\\$1')
}

export interface FileMetadataEdits {
  chapters?: EditableChapter[]
  /** Map of audio typeIndex → new title ('' clears the title). */
  audioTitles?: Record<number, string>
  /** Map of subtitle typeIndex → new title ('' clears the title). */
  subtitleTitles?: Record<number, string>
}

/**
 * Rewrites embedded chapters and/or audio/subtitle stream titles in place via
 * a lossless remux (stream copy), then atomically replaces the original.
 * Mirrors the track cleaner's safety rails: tmp output, sanity checks, no
 * partial replacement.
 */
export async function writeFileMetadata(filePath: string, edits: FileMetadataEdits): Promise<{ success: boolean; message: string; chapters: number }> {
  if (!existsSync(filePath)) return { success: false, message: `File not found: ${filePath}`, chapters: 0 }

  const ext = extname(filePath).toLowerCase()
  if (!['.mkv', '.mp4', '.m4v'].includes(ext)) {
    return { success: false, message: `Unsupported format for metadata remux: ${ext}`, chapters: 0 }
  }

  const hasChapterEdit = Array.isArray(edits.chapters)
  const audioTitles = edits.audioTitles ?? {}
  const subtitleTitles = edits.subtitleTitles ?? {}
  if (!hasChapterEdit && Object.keys(audioTitles).length === 0 && Object.keys(subtitleTitles).length === 0) {
    return { success: false, message: 'No metadata edits supplied', chapters: 0 }
  }

  // Validate and complete the chapter list
  let chapters: Array<Required<EditableChapter>> = []
  if (hasChapterEdit) {
    const sorted = [...edits.chapters!]
    for (const ch of sorted) {
      if (typeof ch.startTime !== 'number' || !Number.isFinite(ch.startTime) || ch.startTime < 0) {
        return { success: false, message: `Invalid chapter start time for "${ch.title}"`, chapters: 0 }
      }
    }
    sorted.sort((a, b) => a.startTime - b.startTime)
    const duration = await probeDuration(filePath)
    chapters = sorted.map((ch, i) => {
      const nextStart = sorted[i + 1]?.startTime
      const fallbackEnd = nextStart ?? duration ?? ch.startTime + 1
      const endTime = ch.endTime !== undefined && Number.isFinite(ch.endTime) && ch.endTime > ch.startTime
        ? Math.min(ch.endTime, nextStart ?? ch.endTime)
        : fallbackEnd
      return { title: ch.title || `Chapter ${i + 1}`, startTime: ch.startTime, endTime: Math.max(endTime, ch.startTime + 0.001) }
    })
    if (duration !== null && chapters.some(ch => ch.startTime > duration + 1)) {
      return { success: false, message: 'A chapter starts beyond the end of the file', chapters: 0 }
    }
  }

  const dir = dirname(filePath)
  const base = basename(filePath, ext)
  const tmpPath = join(dir, `${base}.remetadata${ext}`)
  const metaPath = join(dir, `${base}.remetadata.ffmeta`)

  const args: string[] = ['-i', filePath]
  if (hasChapterEdit) {
    const lines = [';FFMETADATA1']
    for (const ch of chapters) {
      lines.push('[CHAPTER]')
      lines.push('TIMEBASE=1/1000')
      lines.push(`START=${Math.round(ch.startTime * 1000)}`)
      lines.push(`END=${Math.round(ch.endTime * 1000)}`)
      lines.push(`title=${escapeFfMetadata(ch.title)}`)
    }
    writeFileSync(metaPath, lines.join('\n') + '\n')
    args.push('-f', 'ffmetadata', '-i', metaPath, '-map_chapters', '1')
  } else {
    args.push('-map_chapters', '0')
  }
  args.push('-map', '0', '-map_metadata', '0', '-c', 'copy')
  for (const [idx, title] of Object.entries(audioTitles)) {
    args.push(`-metadata:s:a:${idx}`, `title=${title}`)
  }
  for (const [idx, title] of Object.entries(subtitleTitles)) {
    args.push(`-metadata:s:s:${idx}`, `title=${title}`)
  }
  args.push('-y', tmpPath)

  const originalSize = statSync(filePath).size

  try {
    await runFfmpeg(args)

    if (!existsSync(tmpPath)) throw new Error('ffmpeg produced no output file')
    const newSize = statSync(tmpPath).size
    if (newSize < originalSize * 0.9) {
      unlinkSync(tmpPath)
      throw new Error(`Output file suspiciously small (${newSize} bytes vs ${originalSize} original)`)
    }

    if (hasChapterEdit) {
      const written = await probeChapters(tmpPath)
      if (written.count !== chapters.length) {
        unlinkSync(tmpPath)
        throw new Error(`Chapter count mismatch after remux: expected ${chapters.length}, got ${written.count}`)
      }
    }

    renameSync(tmpPath, filePath)
    const chapterCount = hasChapterEdit ? chapters.length : (await probeChapters(filePath).catch(() => ({ count: 0, chapters: [] }))).count
    logger.info(`[MediaProcessor] Rewrote metadata for ${basename(filePath)} (${chapterCount} chapters)`)
    return { success: true, message: 'File metadata updated', chapters: chapterCount }
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[MediaProcessor] Metadata rewrite failed for ${basename(filePath)}: ${msg}`)
    return { success: false, message: msg, chapters: 0 }
  } finally {
    try { if (existsSync(metaPath)) unlinkSync(metaPath) } catch {}
  }
}
