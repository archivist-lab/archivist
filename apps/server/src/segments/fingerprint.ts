import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { deflateSync, inflateSync } from 'node:zlib'
import type { FingerprintWindow } from './matcher.js'

const require = createRequire(import.meta.url)
let bundledFfmpeg = 'ffmpeg'
try { bundledFfmpeg = require('ffmpeg-static') as string } catch {}

const ffmpegPath = process.env.ARCHIVIST_FFMPEG_PATH ?? bundledFfmpeg
const fpcalcPath = process.env.ARCHIVIST_FPCALC_PATH ?? 'fpcalc'
export const FINGERPRINT_ALGORITHM = 'chromaprint-fpcalc-raw-v1'
export const FINGERPRINT_ENCODING = 'zlib-int32le-v1'

export interface FingerprintAudioTrack {
  index: number
  codec: string
  languageCode: string | null
  title: string | null
  channels: number | null
  default: boolean
}

const normalizeLanguage = (value: string | null | undefined) => {
  const language = String(value ?? '').toLowerCase()
  const aliases: Record<string, string> = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', ja: 'jpn', ko: 'kor', zh: 'zho', pt: 'por' }
  return aliases[language] ?? language
}

export function selectFingerprintAudioTrack(
  tracks: FingerprintAudioTrack[],
  preferredLanguage = 'eng',
  originalLanguage?: string | null,
): FingerprintAudioTrack | null {
  const preferred = normalizeLanguage(preferredLanguage)
  const original = normalizeLanguage(originalLanguage)
  const unwanted = /commentary|description|descriptive|audio description|music.?only|isolated score/i
  return [...tracks].sort((a, b) => {
    const score = (track: FingerprintAudioTrack) => {
      const language = normalizeLanguage(track.languageCode)
      return (unwanted.test(track.title ?? '') ? -1000 : 0)
        + (track.default ? 100 : 0)
        + (original && language === original ? 60 : 0)
        + (preferred && language === preferred ? 40 : 0)
        + Math.min(track.channels ?? 0, 8)
    }
    return score(b) - score(a) || a.index - b.index
  })[0] ?? null
}

interface FpcalcJson { fingerprint?: number[] | string; duration?: number }

function parseFingerprint(stdout: string, processedStart: number, requestedDuration: number): FingerprintWindow {
  const parsed = JSON.parse(stdout.trim()) as FpcalcJson
  const values = Array.isArray(parsed.fingerprint)
    ? parsed.fingerprint
    : String(parsed.fingerprint ?? '').split(',').map(Number).filter(Number.isFinite)
  if (values.length === 0) throw new Error('fpcalc returned an empty fingerprint')
  const processedDuration = Number.isFinite(parsed.duration) && Number(parsed.duration) > 0
    ? Number(parsed.duration)
    : requestedDuration
  return {
    frames: Int32Array.from(values),
    secondsPerFrame: processedDuration / values.length,
    processedStart,
    processedDuration,
  }
}

function attachAbort(signal: AbortSignal | undefined, processes: ChildProcess[]): () => void {
  if (!signal) return () => {}
  const abort = () => {
    for (const process of processes) {
      try { process.kill('SIGKILL') } catch {}
    }
  }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

export function fingerprintAudioWindow(
  filePath: string,
  processedStart: number,
  processedDuration: number,
  audioStreamIndex: number,
  signal?: AbortSignal,
): Promise<FingerprintWindow> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', String(processedStart), '-t', String(processedDuration),
      '-i', filePath, '-map', `0:${audioStreamIndex}`, '-vn', '-ac', '2', '-ar', '11025', '-f', 'wav', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const fpcalc = spawn(fpcalcPath, ['-raw', '-json', '-length', String(Math.ceil(processedDuration)), '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    ffmpeg.stdout.pipe(fpcalc.stdin)
    let stdout = ''
    let stderr = ''
    fpcalc.stdout.on('data', chunk => { stdout += chunk.toString() })
    fpcalc.stderr.on('data', chunk => { stderr += chunk.toString() })
    ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString() })
    const detach = attachAbort(signal, [ffmpeg, fpcalc])
    const configuredTimeout = Number(process.env.ARCHIVIST_SEGMENT_CHILD_TIMEOUT_MS)
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.min(300_000, Math.max(10_000, Math.floor(configuredTimeout)))
      : 90_000
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      detach()
      try { ffmpeg.kill('SIGKILL') } catch {}
      try { fpcalc.kill('SIGKILL') } catch {}
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    timer = setTimeout(() => fail(new Error(`Fingerprint extraction timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    ffmpeg.on('error', fail)
    fpcalc.on('error', fail)
    fpcalc.on('close', code => {
      if (settled) return
      if (signal?.aborted) return fail(new Error('Segment analysis cancelled'))
      try {
        const fingerprint = parseFingerprint(stdout, processedStart, processedDuration)
        settled = true
        if (timer) clearTimeout(timer)
        detach()
        resolve(fingerprint)
      } catch (error) {
        const detail = stderr.slice(-500)
        fail(code === 0 ? error : new Error(`fpcalc failed (${code}): ${detail}`))
      }
    })
  })
}

export function encodeFingerprint(frames: Int32Array): Buffer {
  const raw = Buffer.alloc(frames.length * 4)
  for (let i = 0; i < frames.length; i++) raw.writeInt32LE(frames[i], i * 4)
  return deflateSync(raw)
}

export function decodeFingerprint(blob: Buffer): Int32Array {
  const raw = inflateSync(blob)
  if (raw.length % 4 !== 0) throw new Error('Invalid cached fingerprint length')
  const frames = new Int32Array(raw.length / 4)
  for (let i = 0; i < frames.length; i++) frames[i] = raw.readInt32LE(i * 4)
  return frames
}
