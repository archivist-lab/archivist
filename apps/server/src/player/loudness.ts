import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import type { PlayerMediaTiming } from './media.js'

/**
 * Loudness normalization (EBU R128 / LUFS) so volume is consistent across every
 * title — no reaching for the remote between a quiet film and a loud one.
 *
 * We measure each file's integrated loudness once (ffmpeg `loudnorm` analysis),
 * cache it, and use it two ways at playback:
 *  - Transcode path (most library files, which are HEVC/E-AC3): apply a
 *    two-pass linear `loudnorm` targeting a fixed LUFS — accurate, no pumping.
 *  - Direct-play path: the Player applies a matching Web Audio gain client-side.
 *
 * Measurement decodes only the audio stream (fast, ~tens of x realtime) and
 * runs lazily in the background the first time a title's tracks are requested.
 */

const require = createRequire(import.meta.url)
let ffmpegPath: string
try { ffmpegPath = require('ffmpeg-static') as string } catch { ffmpegPath = 'ffmpeg' }

const logger = createLogger('Loudness')

/** Default normalization target (LUFS). ~-16 is a good "consistent, not too
 *  quiet" home level (Apple/YouTube-ish); broadcast reference is -23. */
export const DEFAULT_TARGET_LUFS = -16
export const TARGET_TP = -1.5
export const TARGET_LRA = 11

export interface Loudness {
  integratedLufs: number
  truePeak: number
  lra: number
  threshold: number
}

export function getLoudness(mediaType: 'film' | 'episode', mediaId: number, filePath: string, timing?: PlayerMediaTiming): Loudness | null {
  const startedAt = performance.now()
  let outcome: 'ok' | 'error' = 'ok'
  try {
    const row = getDb().prepare(
      'SELECT file_path, integrated_lufs, true_peak, lra, threshold FROM media_loudness WHERE media_type = ? AND media_id = ?',
    ).get(mediaType, mediaId) as any
    if (!row || row.file_path !== filePath || row.integrated_lufs == null) return null
    return { integratedLufs: row.integrated_lufs, truePeak: row.true_peak, lra: row.lra, threshold: row.threshold }
  } catch (error) {
    outcome = 'error'
    throw error
  } finally {
    try { timing?.('loudness', Math.max(0, performance.now() - startedAt), outcome) } catch { /* timing cannot affect lookup */ }
  }
}

function storeLoudness(mediaType: string, mediaId: number, filePath: string, l: Loudness): void {
  getDb().prepare(`
    INSERT INTO media_loudness (media_type, media_id, file_path, integrated_lufs, true_peak, lra, threshold, measured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_type, media_id) DO UPDATE SET
      file_path = excluded.file_path, integrated_lufs = excluded.integrated_lufs,
      true_peak = excluded.true_peak, lra = excluded.lra, threshold = excluded.threshold,
      measured_at = excluded.measured_at
  `).run(mediaType, mediaId, filePath, l.integratedLufs, l.truePeak, l.lra, l.threshold)
}

/** Parses the trailing JSON block ffmpeg's loudnorm prints to stderr. */
function parseLoudnormJson(stderr: string): Loudness | null {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const j = JSON.parse(stderr.slice(start, end + 1))
    const n = (v: string) => { const x = parseFloat(v); return Number.isFinite(x) ? x : NaN }
    const out = { integratedLufs: n(j.input_i), truePeak: n(j.input_tp), lra: n(j.input_lra), threshold: n(j.input_thresh) }
    return Number.isFinite(out.integratedLufs) ? out : null
  } catch { return null }
}

/** Runs the analysis pass. Resolves null on failure (e.g. silent/no audio). */
export function measureLoudness(filePath: string): Promise<Loudness | null> {
  return new Promise(resolve => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-nostats', '-vn',
      '-i', filePath,
      '-map', '0:a:0?',
      '-af', `loudnorm=I=${DEFAULT_TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
      '-f', 'null', '-',
    ])
    let stderr = ''
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', () => resolve(null))
    proc.on('close', () => resolve(parseLoudnormJson(stderr)))
  })
}

// ── Bounded measurement queue ────────────────────────────────────────────────
// A dedicated queue (separate from the global job runner, which is single-slot
// and would otherwise block imports behind a 30-min film measurement). Bounded
// concurrency avoids spawning one ffmpeg per file when a whole season imports at
// once. Measurement is single-threaded and CPU-heavy, so the default stays low
// to leave headroom for live playback transcodes.

const MAX_CONCURRENCY = (() => {
  const env = Number(process.env.ARCHIVIST_LOUDNESS_CONCURRENCY)
  if (Number.isFinite(env) && env >= 1) return Math.floor(env)
  return Math.max(1, Math.min(2, os.cpus().length - 1))
})()

interface MeasureJob { mediaType: 'film' | 'episode'; mediaId: number; filePath: string }
const queue: MeasureJob[] = []
const active = new Set<string>()  // keys currently measuring
const pending = new Set<string>() // keys queued or active (dedup)

const keyOf = (t: string, id: number) => `${t}:${id}`

function pump(): void {
  while (active.size < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift()!
    const key = keyOf(job.mediaType, job.mediaId)
    active.add(key)
    measureLoudness(job.filePath)
      .then(l => {
        if (l) { storeLoudness(job.mediaType, job.mediaId, job.filePath, l); logger.info(`Measured ${key}: ${l.integratedLufs.toFixed(1)} LUFS (${active.size - 1 + queue.length} left)`) }
      })
      .catch(err => logger.debug(`measure ${key} failed: ${err}`))
      .finally(() => { active.delete(key); pending.delete(key); pump() })
  }
}

/**
 * Enqueues a background measurement unless the file is already measured or in
 * the queue. `priority: 'high'` (a title you just opened) jumps ahead of bulk
 * import/backfill work. Non-blocking.
 */
export function enqueueLoudness(
  mediaType: 'film' | 'episode', mediaId: number, filePath: string | null | undefined,
  opts: { priority?: 'high' | 'normal' } = {},
): void {
  if (!filePath) return
  if (getLoudness(mediaType, mediaId, filePath)) return
  const key = keyOf(mediaType, mediaId)
  if (pending.has(key)) return
  pending.add(key)
  const job: MeasureJob = { mediaType, mediaId, filePath }
  if (opts.priority === 'high') queue.unshift(job)
  else queue.push(job)
  pump()
}

export function loudnessQueueStatus(): { active: number; queued: number; concurrency: number } {
  return { active: active.size, queued: queue.length, concurrency: MAX_CONCURRENCY }
}

/**
 * Enqueues every collected film/episode that lacks a current measurement — the
 * backfill for an existing library and a restart-safety net. Cheap: already
 * measured files are skipped by the JOIN and the enqueue dedup.
 */
export function sweepUnmeasured(): number {
  const db = getDb()
  const films = db.prepare(`
    SELECT f.id, f.file_path FROM films f
    LEFT JOIN media_loudness m ON m.media_type = 'film' AND m.media_id = f.id AND m.file_path = f.file_path
    WHERE f.file_path IS NOT NULL AND m.media_id IS NULL
  `).all() as Array<{ id: number; file_path: string }>
  const eps = db.prepare(`
    SELECT e.id, e.file_path FROM episodes e
    LEFT JOIN media_loudness m ON m.media_type = 'episode' AND m.media_id = e.id AND m.file_path = e.file_path
    WHERE e.file_path IS NOT NULL AND m.media_id IS NULL
  `).all() as Array<{ id: number; file_path: string }>
  for (const f of films) enqueueLoudness('film', f.id, f.file_path)
  for (const e of eps) enqueueLoudness('episode', e.id, e.file_path)
  const total = films.length + eps.length
  if (total) logger.info(`Loudness backfill: queued ${total} unmeasured items (${MAX_CONCURRENCY} at a time)`)
  return total
}

/**
 * Builds the ffmpeg `loudnorm` audio filter string for the transcode.
 *  - With a prior measurement: two-pass linear (static gain, no pumping).
 *  - Without: single-pass dynamic (works immediately; measured next time).
 * Followed by aresample to undo loudnorm's internal 192kHz upsampling.
 */
export function loudnormFilter(target: number, measured: Loudness | null): string {
  const base = `loudnorm=I=${target}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`
  const full = measured
    ? `${base}:measured_I=${measured.integratedLufs}:measured_TP=${measured.truePeak}:measured_LRA=${measured.lra}:measured_thresh=${measured.threshold}:linear=true`
    : base
  return `${full},aresample=48000`
}
