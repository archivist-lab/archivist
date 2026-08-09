import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import os from 'node:os'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import type { PlayerMediaTiming } from './media.js'
import { ffmpegPath, ffprobePath } from '../shared/ffmpeg.js'
import { readFileMetadata, runFfmpeg } from '../services/media-processor.js'
import { cancelJob as cancelSystemJob, claimJob, completeJob, enqueueUniqueJob, failJob, getJob, heartbeatJob, rejectQueuedJob } from '../system/event-store.js'
import { registerJobHandler } from '../system/job-runner.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

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
export function measureLoudness(
  filePath: string,
  callbacks: { onProgress?: (progress: number) => void; onSpawn?: (process: ChildProcess) => void } = {},
): Promise<Loudness | null> {
  return new Promise(resolve => {
    const durationResult = spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath], { encoding: 'utf8' })
    const duration = Number.parseFloat(durationResult.stdout ?? '')
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-nostats', '-progress', 'pipe:1', '-vn',
      '-i', filePath,
      '-map', '0:a:0?',
      '-af', `loudnorm=I=${DEFAULT_TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
      '-f', 'null', '-',
    ])
    callbacks.onSpawn?.(proc)
    let stderr = ''
    proc.stdout.on('data', data => {
      if (!Number.isFinite(duration) || duration <= 0) return
      const match = String(data).match(/out_time_ms=(\d+)/)
      if (match) callbacks.onProgress?.(Math.max(0, Math.min(1, Number(match[1]) / 1_000_000 / duration)))
    })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('error', () => resolve(null))
    proc.on('close', () => resolve(parseLoudnormJson(stderr)))
  })
}

// ── Bounded measurement queue ────────────────────────────────────────────────
// A dedicated CPU-media queue, separate from the durable I/O-oriented job lanes.
// Bounded concurrency avoids spawning one ffmpeg per file when a whole season
// imports at once. Measurement is single-threaded and CPU-heavy, so the default
// stays low to leave headroom for live playback transcodes.

const MAX_CONCURRENCY = (() => {
  const env = Number(process.env.ARCHIVIST_LOUDNESS_CONCURRENCY)
  if (Number.isFinite(env) && env >= 1) return Math.floor(env)
  return Math.max(1, Math.min(2, os.cpus().length - 1))
})()

interface MeasureJob { systemJobId: number; mediaType: 'film' | 'episode'; mediaId: number; filePath: string; title: string; progress: number; startedAt: number | null }
const queue: MeasureJob[] = []
const active = new Map<string, MeasureJob>()
const pending = new Set<string>() // keys queued or active (dedup)
const processes = new Map<string, ChildProcess>()
const suspended = new Set<string>()
let paused = false
let recoveryTimer: ReturnType<typeof setInterval> | null = null
let controlTimer: ReturnType<typeof setInterval> | null = null
let queueStarted = false

const keyOf = (t: string, id: number) => `${t}:${id}`

function pump(): void {
  try { paused = getAppSetting('loudnessQueuePaused', paused, 0) } catch {}
  if (!queueStarted) return
  while (!paused && active.size < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift()!
    const key = keyOf(job.mediaType, job.mediaId)
    if (!claimJob(job.systemJobId)) {
      pending.delete(key)
      continue
    }
    job.startedAt = Date.now()
    active.set(key, job)
    measureLoudness(job.filePath, {
      onProgress: progress => { job.progress = progress },
      onSpawn: process => { processes.set(key, process) },
    })
      .then(l => {
        if (getJob(job.systemJobId)?.status === 'cancelled') return
        if (l) {
          storeLoudness(job.mediaType, job.mediaId, job.filePath, l)
          completeJob(job.systemJobId)
          logger.info(`Measured ${key}: ${l.integratedLufs.toFixed(1)} LUFS (${active.size - 1 + queue.length} left)`)
        } else {
          failJob(job.systemJobId, 'ffmpeg did not return a valid loudness measurement')
        }
      })
      .catch(err => {
        failJob(job.systemJobId, err instanceof Error ? err.message : String(err))
        logger.debug(`measure ${key} failed: ${err}`)
      })
      .finally(() => { active.delete(key); processes.delete(key); suspended.delete(key); pending.delete(key); pump() })
  }
}

function titleFor(mediaType: 'film' | 'episode', mediaId: number): string {
  if (mediaType === 'film') {
    const row = getDb().prepare('SELECT title FROM films WHERE id = ?').get(mediaId) as { title?: string } | undefined
    return row?.title ?? `Film ${mediaId}`
  }
  const row = getDb().prepare(`
    SELECT e.title, e.season_number, e.episode_number, s.title AS series_title
    FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?
  `).get(mediaId) as { title?: string; season_number: number; episode_number: number; series_title: string } | undefined
  return row
    ? `${row.series_title} · S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')} · ${row.title ?? 'Episode'}`
    : `Episode ${mediaId}`
}

function addLocalJob(systemJobId: number, mediaType: 'film' | 'episode', mediaId: number, filePath: string, priority: 'high' | 'normal' = 'normal'): void {
  const key = keyOf(mediaType, mediaId)
  if (pending.has(key)) return
  pending.add(key)
  const job: MeasureJob = { systemJobId, mediaType, mediaId, filePath, title: titleFor(mediaType, mediaId), progress: 0, startedAt: null }
  if (priority === 'high') queue.unshift(job)
  else queue.push(job)
}

function loadDurableLoudnessJobs(): void {
  const rows = getDb().prepare(`
    SELECT id, subject_type, subject_id, payload
    FROM system_jobs
    WHERE type = 'media-loudness' AND status = 'queued' AND available_at <= ?
    ORDER BY priority DESC, available_at, id
    LIMIT 500
  `).all(new Date().toISOString()) as Array<{ id: number; subject_type: string; subject_id: string; payload: string }>
  for (const row of rows) {
    if (row.subject_type !== 'film' && row.subject_type !== 'episode') {
      rejectQueuedJob(row.id, 'Invalid media type in durable loudness job')
      continue
    }
    try {
      const payload = JSON.parse(row.payload) as { filePath?: string }
      const mediaId = Number(row.subject_id)
      if (payload.filePath && Number.isSafeInteger(mediaId) && mediaId > 0) {
        addLocalJob(row.id, row.subject_type, mediaId, payload.filePath)
      } else {
        rejectQueuedJob(row.id, 'Invalid payload in durable loudness job')
      }
    } catch {
      rejectQueuedJob(row.id, 'Malformed JSON payload in durable loudness job')
    }
  }
  pump()
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
  const priority = opts.priority ?? 'normal'
  let systemJobId = enqueueUniqueJob({
    type: 'media-loudness', subjectType: mediaType, subjectId: String(mediaId),
    payload: { filePath }, priority: priority === 'high' ? 100 : 30, maxAttempts: 3,
  })
  if (systemJobId == null) {
    const existing = getDb().prepare(`
      SELECT id FROM system_jobs
      WHERE type = 'media-loudness' AND subject_type = ? AND subject_id = ?
        AND status IN ('queued','running') ORDER BY id DESC LIMIT 1
    `).get(mediaType, String(mediaId)) as { id: number } | undefined
    systemJobId = existing?.id ?? null
  }
  if (systemJobId == null) return
  if (queueStarted) {
    addLocalJob(systemJobId, mediaType, mediaId, filePath, priority)
    pump()
  }
}

export function loudnessQueueStatus() {
  if (!queueStarted) {
    const rows = getDb().prepare(`
      SELECT subject_type,subject_id,status,started_at FROM system_jobs
      WHERE type='media-loudness' AND status IN ('queued','running')
      ORDER BY priority DESC,available_at,id
    `).all() as Array<{ subject_type: 'film' | 'episode'; subject_id: string; status: 'queued' | 'running'; started_at: string | null }>
    const items = rows.flatMap(row => {
      const mediaId = Number(row.subject_id)
      if ((row.subject_type !== 'film' && row.subject_type !== 'episode') || !Number.isSafeInteger(mediaId)) return []
      return [{
        id: keyOf(row.subject_type, mediaId), title: titleFor(row.subject_type, mediaId), status: row.status,
        progress: 0, detail: row.status === 'running' ? 'Measuring integrated loudness' : 'Waiting for loudness analysis',
        startedAt: row.started_at ? Date.parse(row.started_at) : null,
      }]
    })
    return {
      active: items.filter(item => item.status === 'running').length,
      queued: items.filter(item => item.status === 'queued').length,
      concurrency: MAX_CONCURRENCY,
      paused,
      activeItems: items.filter(item => item.status === 'running'),
      queuedItems: items.filter(item => item.status === 'queued'),
    }
  }
  return {
    active: active.size,
    queued: queue.length,
    concurrency: MAX_CONCURRENCY,
    paused,
    activeItems: [...active.entries()].map(([id, job]) => ({
      id, title: job.title, status: suspended.has(id) ? 'paused' as const : 'running' as const,
      progress: job.progress, detail: 'Measuring integrated loudness', startedAt: job.startedAt,
    })),
    queuedItems: queue.map(job => ({ id: keyOf(job.mediaType, job.mediaId), title: job.title, status: 'queued' as const, progress: 0, detail: 'Waiting for loudness analysis' })),
  }
}

export function setLoudnessQueuePaused(value: boolean): boolean {
  paused = value
  try { setAppSetting('loudnessQueuePaused', value, 0) } catch {}
  if (!paused) pump()
  return paused
}

export function pauseLoudnessJob(id: string): boolean {
  const process = processes.get(id)
  if (!process || suspended.has(id)) return false
  try {
    if (!process.kill('SIGSTOP')) return false
    suspended.add(id)
    return true
  } catch { return false }
}

export function resumeLoudnessJob(id: string): boolean {
  const process = processes.get(id)
  if (!process || !suspended.has(id)) return false
  try {
    if (!process.kill('SIGCONT')) return false
    suspended.delete(id)
    return true
  } catch { return false }
}

export function cancelLoudnessJob(id: string): boolean {
  const queuedIndex = queue.findIndex(job => keyOf(job.mediaType, job.mediaId) === id)
  if (queuedIndex >= 0) {
    const [job] = queue.splice(queuedIndex, 1)
    cancelSystemJob(job.systemJobId)
    pending.delete(keyOf(job.mediaType, job.mediaId))
    return true
  }
  const process = processes.get(id)
  if (!process) return false
  const job = active.get(id)
  if (job) cancelSystemJob(job.systemJobId)
  try { return process.kill('SIGKILL') } catch { return false }
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
    ORDER BY f.id LIMIT 500
  `).all() as Array<{ id: number; file_path: string }>
  const eps = db.prepare(`
    SELECT e.id, e.file_path FROM episodes e
    LEFT JOIN media_loudness m ON m.media_type = 'episode' AND m.media_id = e.id AND m.file_path = e.file_path
    WHERE e.file_path IS NOT NULL AND m.media_id IS NULL
    ORDER BY e.id LIMIT ?
  `).all(Math.max(0, 500 - films.length)) as Array<{ id: number; file_path: string }>
  for (const f of films) enqueueLoudness('film', f.id, f.file_path)
  for (const e of eps) enqueueLoudness('episode', e.id, e.file_path)
  const total = films.length + eps.length
  if (total) logger.info(`Loudness backfill: queued ${total} unmeasured items (${MAX_CONCURRENCY} at a time)`)
  return total
}

/** Starts restart recovery and bounded backfill polling for the durable queue. */
export function startLoudnessQueue(): void {
  if (recoveryTimer) return
  queueStarted = true
  try { paused = getAppSetting('loudnessQueuePaused', false, 0) } catch {}
  loadDurableLoudnessJobs()
  recoveryTimer = setInterval(() => {
    loadDurableLoudnessJobs()
    if (queue.length < 250) sweepUnmeasured()
  }, 30_000)
  recoveryTimer.unref?.()
  controlTimer = setInterval(() => {
    for (const [key, job] of active) {
      const current = getJob(job.systemJobId)
      if (current?.status === 'cancelled') {
        try { processes.get(key)?.kill('SIGKILL') } catch {}
      } else if (current?.status === 'running') {
        heartbeatJob(job.systemJobId)
      }
    }
  }, 2_000)
  controlTimer.unref?.()
}

export function stopLoudnessQueue(): void {
  queueStarted = false
  if (recoveryTimer) clearInterval(recoveryTimer)
  if (controlTimer) clearInterval(controlTimer)
  recoveryTimer = null
  controlTimer = null
  for (const [key, process] of processes) {
    const job = active.get(key)
    if (job) failJob(job.systemJobId, 'Interrupted by application shutdown')
    try { process.kill('SIGKILL') } catch { /* process already exited */ }
  }
  for (const job of queue.splice(0)) pending.delete(keyOf(job.mediaType, job.mediaId))
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

export interface EpisodeLoudnessEditorData {
  targetLufs: number
  measured: Loudness
  estimatedGainDb: number
  originalWaveform: string
  normalizedWaveform: string
  track: { typeIndex: number; title?: string; language?: string; codec?: string; channels?: number }
}

function checkedTarget(value: number): number {
  if (!Number.isFinite(value) || value < -30 || value > -5) throw new Error('Target loudness must be between -30 and -5 LUFS')
  return Math.round(value * 2) / 2
}

function renderWaveform(filePath: string, audioIndex: number, filter: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const chain = `[0:a:${audioIndex}]${filter ? `${filter},` : ''}aformat=channel_layouts=mono,showwavespic=s=1200x180:colors=0x9B59B6[wave]`
    const proc = spawn(ffmpegPath, [
      '-v', 'error', '-i', filePath, '-filter_complex', chain, '-map', '[wave]',
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
    ])
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    proc.stdout.on('data', chunk => {
      size += chunk.length
      if (size <= 8 * 1024 * 1024) chunks.push(chunk)
      else proc.kill('SIGKILL')
    })
    proc.stderr.on('data', chunk => { stderr += String(chunk); if (stderr.length > 4096) stderr = stderr.slice(-4096) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0 || chunks.length === 0) return reject(new Error(`Could not render waveform${stderr ? `: ${stderr.trim().slice(-300)}` : ''}`))
      resolve(`data:image/png;base64,${Buffer.concat(chunks).toString('base64')}`)
    })
  })
}

export async function getEpisodeLoudnessEditor(episodeId: number, requestedTarget = DEFAULT_TARGET_LUFS): Promise<EpisodeLoudnessEditorData> {
  const targetLufs = checkedTarget(requestedTarget)
  const row = getDb().prepare('SELECT file_path, runtime FROM episodes WHERE id = ?').get(episodeId) as { file_path: string | null; runtime: number | null } | undefined
  if (!row) throw new Error('Episode not found')
  if (!row.file_path || !existsSync(row.file_path)) throw new Error('Episode media file was not found')
  const metadata = await readFileMetadata(row.file_path)
  const track = metadata.audioTracks[0]
  if (!track) throw new Error('Episode has no audio track')
  let measured = getLoudness('episode', episodeId, row.file_path)
  if (!measured) {
    measured = await measureLoudness(row.file_path)
    if (!measured) throw new Error('The audio track could not be measured')
    storeLoudness('episode', episodeId, row.file_path, measured)
  }
  const [originalWaveform, normalizedWaveform] = await Promise.all([
    renderWaveform(row.file_path, track.typeIndex, null),
    renderWaveform(row.file_path, track.typeIndex, loudnormFilter(targetLufs, measured)),
  ])
  return {
    targetLufs,
    measured,
    estimatedGainDb: targetLufs - measured.integratedLufs,
    originalWaveform,
    normalizedWaveform,
    track,
  }
}

function audioEncoder(codec: string | undefined, container: string): { encoder: string; bitrate?: string } {
  if (codec === 'aac') return { encoder: 'aac', bitrate: '256k' }
  if (codec === 'ac3') return { encoder: 'ac3', bitrate: '640k' }
  if (codec === 'eac3') return { encoder: 'eac3', bitrate: '640k' }
  if (codec === 'mp3') return { encoder: 'libmp3lame', bitrate: '256k' }
  if (codec === 'opus') return { encoder: 'libopus', bitrate: '192k' }
  if (codec === 'flac' && container === '.mkv') return { encoder: 'flac' }
  return container === '.mkv' ? { encoder: 'flac' } : { encoder: 'aac', bitrate: '256k' }
}

async function rewriteEpisodeLoudness(episodeId: number, targetLufs: number, signal?: AbortSignal): Promise<void> {
  const row = getDb().prepare(`
    SELECT e.file_path, e.runtime, e.season_number, e.series_id, e.title, s.title AS series_title
    FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?
  `).get(episodeId) as { file_path: string | null; runtime: number | null; season_number: number; series_id: number; title: string | null; series_title: string } | undefined
  if (!row?.file_path || !existsSync(row.file_path)) throw new Error('Episode media file was not found')
  const metadata = await readFileMetadata(row.file_path)
  const track = metadata.audioTracks[0]
  if (!track) throw new Error('Episode has no audio track')
  const measured = getLoudness('episode', episodeId, row.file_path) ?? await measureLoudness(row.file_path)
  if (!measured) throw new Error('The audio track could not be measured')
  const extension = extname(row.file_path).toLowerCase()
  if (!['.mkv', '.mp4', '.m4v'].includes(extension)) throw new Error(`Unsupported media container: ${extension}`)
  const tempPath = join(dirname(row.file_path), `${basename(row.file_path, extension)}.renormalising${extension}`)
  const encoder = audioEncoder(track.codec, extension)
  const args = [
    '-i', row.file_path, '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c', 'copy',
    '-filter:a:0', loudnormFilter(targetLufs, measured), '-c:a:0', encoder.encoder,
  ]
  if (encoder.bitrate) args.push('-b:a:0', encoder.bitrate)
  args.push('-y', tempPath)
  try {
    await runFfmpeg(args, {
      title: `${row.series_title} · ${row.title || `Episode ${episodeId}`}`,
      filePath: row.file_path,
      detail: `Normalising volume to ${targetLufs} LUFS`,
      durationSec: metadata.durationSeconds ?? (row.runtime ? row.runtime * 60 : null),
      signal,
    })
    if (!existsSync(tempPath) || statSync(tempPath).size < Math.max(1024 * 1024, statSync(row.file_path).size * 0.15)) throw new Error('Normalised output failed safety validation')
    const outputMeasurement = await measureLoudness(tempPath)
    if (!outputMeasurement) throw new Error('Normalised output could not be verified')
    renameSync(tempPath, row.file_path)
    storeLoudness('episode', episodeId, row.file_path, outputMeasurement)
    // The audio changed, so prior fingerprints no longer describe this file.
    const { enqueueSeason } = await import('../segments/queue.js')
    enqueueSeason(row.series_id, row.season_number, { priority: 'high', force: true })
    logger.info(`Rewrote episode:${episodeId} default audio at ${targetLufs} LUFS`)
  } finally {
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch {}
  }
}

export function enqueueEpisodeLoudnessRewrite(episodeId: number, requestedTarget: number): boolean {
  const target = checkedTarget(requestedTarget)
  return enqueueUniqueJob({
    type: 'episode-loudness-rewrite', subjectType: 'episode', subjectId: String(episodeId),
    payload: { episodeId, targetLufs: target }, priority: 100, maxAttempts: 3,
  }) != null
}

export function registerLoudnessJobs(): void {
  registerJobHandler('episode-loudness-rewrite', async (job, signal) => {
    const payload = JSON.parse(job.payload) as { episodeId?: number; targetLufs?: number }
    const episodeId = Number(payload.episodeId ?? job.subjectId)
    if (!Number.isSafeInteger(episodeId) || episodeId <= 0) throw new Error('Invalid episode id in loudness rewrite job')
    await rewriteEpisodeLoudness(episodeId, checkedTarget(Number(payload.targetLufs)), signal)
  })
}
