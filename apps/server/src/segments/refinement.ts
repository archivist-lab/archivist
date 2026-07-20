import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let bundledFfmpeg = 'ffmpeg'
try { bundledFfmpeg = require('ffmpeg-static') as string } catch {}
const ffmpegPath = process.env.ARCHIVIST_FFMPEG_PATH ?? bundledFfmpeg

export interface RefinableMarker { start: number; end: number; method: string; confidence: number }
export interface RefinementEvidence { silenceTransitions: number[]; blackTransitions: number[]; snappedStart: boolean; snappedEnd: boolean }

function run(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let output = ''
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    const abort = () => { try { child.kill('SIGKILL') } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', code => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('Segment refinement cancelled'))
      else if (code === 0) resolve(output)
      else reject(new Error(`ffmpeg refinement failed (${code}): ${output.slice(-300)}`))
    })
  })
}

const unique = (values: number[]) => [...new Set(values.filter(Number.isFinite).map(value => Math.round(value * 1000) / 1000))].sort((a, b) => a - b)

export async function refineMarkerBoundaries(
  filePath: string,
  marker: RefinableMarker,
  audioStreamIndex: number,
  options: { silence: boolean; blackFrames: boolean },
  signal?: AbortSignal,
): Promise<{ marker: RefinableMarker; evidence: RefinementEvidence }> {
  const padding = 24
  const windowStart = Math.max(0, marker.start - padding)
  const windowEnd = marker.end + padding
  const duration = Math.max(1, windowEnd - windowStart)
  const silenceTransitions: number[] = []
  const blackTransitions: number[] = []

  if (options.silence) {
    try {
      const output = await run(['-hide_banner', '-loglevel', 'info', '-ss', String(windowStart), '-t', String(duration), '-i', filePath, '-map', `0:${audioStreamIndex}`, '-af', 'silencedetect=noise=-38dB:d=0.25', '-f', 'null', '-'], signal)
      for (const match of output.matchAll(/silence_(?:start|end):\s*([0-9.]+)/g)) silenceTransitions.push(windowStart + Number(match[1]))
    } catch { /* refinement is optional */ }
  }
  if (options.blackFrames) {
    try {
      const output = await run(['-hide_banner', '-loglevel', 'info', '-ss', String(windowStart), '-t', String(duration), '-i', filePath, '-an', '-vf', 'blackdetect=d=0.08:pix_th=0.10', '-f', 'null', '-'], signal)
      for (const match of output.matchAll(/black_(?:start|end):([0-9.]+)/g)) blackTransitions.push(windowStart + Number(match[1]))
    } catch { /* refinement is optional */ }
  }

  const silence = unique(silenceTransitions)
  const black = unique(blackTransitions)
  const candidates = unique([...silence, ...black])
  const nearest = (target: number) => candidates.reduce<number | null>((best, value) => {
    if (Math.abs(value - target) > 10) return best
    return best == null || Math.abs(value - target) < Math.abs(best - target) ? value : best
  }, null)
  const start = nearest(marker.start)
  const end = nearest(marker.end)
  const refined = {
    ...marker,
    start: start ?? marker.start,
    end: end ?? marker.end,
    method: start != null || end != null ? `${marker.method}+refined` : marker.method,
    confidence: Math.min(0.995, marker.confidence + (start != null ? 0.015 : 0) + (end != null ? 0.015 : 0)),
  }
  if (refined.end - refined.start < 4) return { marker, evidence: { silenceTransitions: silence, blackTransitions: black, snappedStart: false, snappedEnd: false } }
  return { marker: refined, evidence: { silenceTransitions: silence, blackTransitions: black, snappedStart: start != null, snappedEnd: end != null } }
}
