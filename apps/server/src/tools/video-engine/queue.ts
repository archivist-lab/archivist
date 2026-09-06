import { stat as statFile } from 'node:fs/promises'
import { managedMediaFile } from '../../shared/managed-media.js'
import { verifiedMove as moveFile } from '../../shared/verified-move.js'
/**
 * Execution Queue + Atomic Replacement + Quarantine.
 *
 * Safety workflow (from the spec) — the original is never overwritten in place:
 *   Original → Encode (temp) → Validate → move Original to Quarantine →
 *   move Output into place → update DB → Retention Timer → delete Original.
 * If validation fails the temp is deleted and the original is left untouched.
 * Everything is reversible until quarantine retention expires.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { analyzeMedia } from './analyzer.js'
import { getActivePolicy } from './policy.js'
import { runEncode, plannedOutputPath, needsRemux, type ExecAction, type EncodeHandle } from './executor.js'
import { validateOutput, type ValidationResult } from './validator.js'
import { getExecutionConfig, encodingAllowed } from './execution-config.js'
import { resolveEncoder } from './hwaccel.js'
import { computeVmaf, passesVmaf } from './vmaf.js'
import { startStatsSampler, stopStatsSampler } from './stats.js'

const logger = createLogger('VideoQueue')

export type JobStatus = 'queued' | 'encoding' | 'validating' | 'replacing' | 'complete' | 'failed' | 'cancelled'

export interface OptimiseJob {
  id: string
  kind: 'film' | 'episode' | 'path'
  itemId: number | null
  action: ExecAction
  targetCodec?: string
  title: string
  inputPath: string
  outputPath: string
  status: JobStatus
  progress: number
  suspended: boolean
  audioEncoding: boolean
  /** Encode speed (× realtime) while encoding. */
  speed: number | null
  /** Which encoder actually ran (e.g. libx265, hevc_vaapi). */
  encoder: string | null
  accelerator: string | null
  /** Higher runs first. */
  priority: number
  /** VMAF vs original (0–100) when quality validation is enabled. */
  vmaf: number | null
  sizeBefore: number | null
  sizeAfter: number | null
  error?: string
  validation?: ValidationResult
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  replacement?: { quarantinePath: string; phase: 'prepared' | 'quarantined' | 'installed' | 'committed' }
}

interface QuarantineEntry {
  id: string
  jobId: string
  title: string
  originalPath: string
  quarantinePath: string
  sizeBytes: number
  quarantinedAt: number
  deleteAfter: number
  restoring?: boolean
}

function quarantineDir(): string {
  return resolve(process.env.ARCHIVIST_QUARANTINE_DIR ?? './data/quarantine')
}

// ── State ─────────────────────────────────────────────────────────────────────

const jobs = new Map<string, OptimiseJob>()
const running = new Set<string>()
const handles = new Map<string, EncodeHandle>()
const cancelRequested = new Set<string>()
const shutdownRequested = new Set<string>()
const controllers = new Map<string, AbortController>()
const activeExecutions = new Map<string, Promise<void>>()
const lastProgressPersist = new Map<string, number>()
let quarantine: QuarantineEntry[] = []
let sweepTimer: ReturnType<typeof setInterval> | null = null
let pumpTimer: ReturnType<typeof setInterval> | null = null
let engineStopping = false
let engineStarted = false

function manifestPath(): string { return join(quarantineDir(), 'manifest.json') }

function loadQuarantine(): void {
  try {
    if (existsSync(manifestPath())) quarantine = JSON.parse(readFileSync(manifestPath(), 'utf8'))
  } catch { quarantine = [] }
}

function saveQuarantine(): void {
  try {
    mkdirSync(quarantineDir(), { recursive: true })
    writeFileSync(manifestPath() + '.tmp', JSON.stringify(quarantine, null, 2))
    renameSync(manifestPath() + '.tmp', manifestPath())
  } catch (err) { logger.warn(`quarantine manifest write failed: ${err}`); throw err }
}

function persistJob(job: OptimiseJob, force = true): void {
  const now = Date.now()
  if (!force && now - (lastProgressPersist.get(job.id) ?? 0) < 5_000) return
  lastProgressPersist.set(job.id, now)
  try {
    getDb().prepare(`
      INSERT INTO video_optimisation_jobs (id, status, priority, job_json, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        priority = excluded.priority,
        job_json = excluded.job_json,
        updated_at = excluded.updated_at
    `).run(job.id, job.status, job.priority, JSON.stringify(job))
  } catch (err) {
    logger.error(`Could not persist video job ${job.id}: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

async function loadPersistedJobs(): Promise<void> {
  jobs.clear()
  const db = getDb()
  const rows = db.prepare(`
    SELECT job_json
    FROM video_optimisation_jobs
    WHERE status IN ('queued','encoding','validating','replacing')
    UNION ALL
    SELECT job_json
    FROM (
      SELECT job_json
      FROM video_optimisation_jobs
      WHERE status IN ('complete','failed','cancelled')
      ORDER BY updated_at DESC
      LIMIT 1000
    )
  `).all() as Array<{ job_json: string }>

  for (const row of rows) {
    try {
      const job = JSON.parse(row.job_json) as OptimiseJob
      if (!job?.id || !job.inputPath || !job.status) continue
      jobs.set(job.id, job)

      if (job.status === 'encoding' || job.status === 'validating') {
        safeUnlink(join(dirname(job.inputPath), `.archivist-opt-${job.id}.mkv`))
        if (existsSync(job.inputPath)) {
          job.status = 'queued'
          job.progress = 0
          job.suspended = false
          job.speed = null
          job.error = 'Recovered after an interrupted encode; restarted from the original file'
          job.startedAt = null
          job.finishedAt = null
        } else {
          fail(job, 'Interrupted encode cannot be recovered because the original file is missing')
          continue
        }
        persistJob(job)
      } else if (job.status === 'replacing') {
        await recoverReplacement(job)
      } else if (job.status === 'queued' && !existsSync(job.inputPath)) {
        fail(job, 'Queued input file no longer exists')
      }
    } catch (err) {
      logger.warn(`Ignoring unreadable persisted video job: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function claimOptimiseJob(): OptimiseJob | null {
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare("SELECT id,job_json FROM video_optimisation_jobs WHERE status='queued' AND control_requested IS NULL ORDER BY priority DESC,updated_at,id LIMIT 1").get() as { id: string; job_json: string } | undefined
    if (!row) return null
    const job = JSON.parse(row.job_json) as OptimiseJob
    job.status = 'encoding'; job.startedAt = Date.now()
    const claimed = db.prepare("UPDATE video_optimisation_jobs SET status='encoding',job_json=?,updated_at=datetime('now') WHERE id=? AND status='queued' AND control_requested IS NULL").run(JSON.stringify(job), row.id)
    return claimed.changes === 1 ? job : null
  }).immediate()
}

/** Resume only an unambiguous journal; preserve originals on every failure. */
export async function recoverReplacement(job: OptimiseJob): Promise<void> {
  const journal = job.replacement
  try {
    if (!journal) throw new Error('Legacy replacement has no recovery journal')
    const expected = join(quarantineDir(), `${job.id}-${basename(job.inputPath)}`)
    if (journal.quarantinePath !== expected) throw new Error('Invalid quarantine recovery path')
    const temp = join(dirname(job.inputPath), `.archivist-opt-${job.id}.mkv`)
    if (!existsSync(expected)) {
      if (journal.phase === 'prepared' && existsSync(job.inputPath)) {
        await managedMediaFile(job.inputPath)
        job.status = 'queued'; job.replacement = undefined; job.startedAt = null; persistJob(job); return
      }
      throw new Error('Original quarantine file is unavailable')
    }
    // A crash between copy and source unlink leaves two originals; do not guess.
    if (existsSync(temp) && existsSync(job.inputPath)) throw new Error('Both original and quarantine exist; review required')
    if (existsSync(temp) && !existsSync(job.outputPath)) {
      await managedMediaFile(temp)
      await moveFile(temp, job.outputPath)
    }
    await managedMediaFile(job.outputPath)
    const original = await analyzeMedia(expected)
    if (!original) throw new Error('Quarantined original cannot be verified')
    const validation = await validateOutput(original, job.action, job.targetCodec, job.outputPath)
    if (!validation.ok) throw new Error('Recovered output failed validation')
    // Persisted passing score is required when a quality gate was requested.
    if (job.validation?.checks.some(check => check.name === 'vmaf' && !check.ok)) throw new Error('Quality gate did not pass')
    updateDbPath(job)
    if (!quarantine.some(entry => entry.jobId === job.id)) {
      quarantine.push({ id: randomUUID(), jobId: job.id, title: job.title, originalPath: job.inputPath, quarantinePath: expected,
        sizeBytes: job.sizeBefore ?? 0, quarantinedAt: Date.now(), deleteAfter: Date.now() + Math.max(0, getExecutionConfig().quarantineRetentionDays) * 86400_000 })
      saveQuarantine()
    }
    journal.phase = 'committed'; job.status = 'complete'; job.progress = 1; job.finishedAt = Date.now(); job.error = undefined
    persistJob(job)
  } catch (error) { job.error = `Replacement requires recovery: ${String(error)}`; persistJob(job) }
}

function requestPersistedControl(id: string, action: 'cancel' | 'pause' | 'resume'): boolean {
  const result = getDb().prepare(`
    UPDATE video_optimisation_jobs SET control_requested=?,updated_at=datetime('now')
    WHERE id=? AND status IN ('queued','encoding','validating')
  `).run(action, id)
  return result.changes === 1
}

function applyControlRequests(): void {
  const rows = getDb().prepare(`
    SELECT id,control_requested FROM video_optimisation_jobs
    WHERE control_requested IS NOT NULL AND control_requested != ''
  `).all() as Array<{ id: string; control_requested: 'cancel' | 'pause' | 'resume' }>
  for (const row of rows) {
    let job = jobs.get(row.id)
    if (!job) {
      const stored = getDb().prepare("SELECT job_json FROM video_optimisation_jobs WHERE id=? AND status='queued'").get(row.id) as { job_json: string } | undefined
      if (stored) job = JSON.parse(stored.job_json)
    }
    if (row.control_requested === 'cancel') {
      if (job?.status === 'queued') {
        job.status = 'cancelled'
        job.finishedAt = Date.now()
        persistJob(job)
      } else if (job && running.has(row.id)) {
        cancelRequested.add(row.id)
        handles.get(row.id)?.cancel()
        controllers.get(row.id)?.abort(new Error('Cancelled'))
      }
    } else if (row.control_requested === 'pause') {
      const handle = handles.get(row.id)
      if (job && handle && job.status === 'encoding' && !job.suspended && handle.pause()) {
        job.suspended = true
        job.speed = null
        persistJob(job)
      }
    } else if (row.control_requested === 'resume') {
      const handle = handles.get(row.id)
      if (job && handle && job.status === 'encoding' && job.suspended && handle.resume()) {
        job.suspended = false
        persistJob(job)
      }
    }
    getDb().prepare('UPDATE video_optimisation_jobs SET control_requested=NULL WHERE id=? AND control_requested=?').run(row.id, row.control_requested)
  }
}

// ── Job lifecycle ───────────────────────────────────────────────────────────

export function listJobs(limit = 200, offset = 0): OptimiseJob[] {
  try {
    return (getDb().prepare("SELECT job_json FROM video_optimisation_jobs ORDER BY CASE WHEN status IN ('queued','encoding','validating','replacing') THEN 0 ELSE 1 END,updated_at DESC,id DESC LIMIT ? OFFSET ?").all(Math.floor(Math.max(1, Math.min(2000, limit))), Math.floor(Math.max(0, offset))) as Array<{ job_json: string }>)
      .map(row => {
        try { return JSON.parse(row.job_json) as OptimiseJob } catch { return null }
      })
      .filter((job): job is OptimiseJob => job !== null)
  } catch {
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }
}

export function listQuarantine(): QuarantineEntry[] {
  loadQuarantine()
  return [...quarantine].sort((a, b) => b.quarantinedAt - a.quarantinedAt)
}

/** Live queue counts + total encode throughput (× realtime) for the dashboard. */
export function queueStats(): { encoding: number; queued: number; aggregateSpeed: number } {
  const rows = getDb().prepare("SELECT status,COUNT(*) AS count, SUM(COALESCE(json_extract(job_json,'$.speed'),0)) AS speed FROM video_optimisation_jobs WHERE status IN ('queued','encoding') GROUP BY status").all() as Array<{ status: string; count: number; speed: number }>
  return { queued: rows.find(row => row.status === 'queued')?.count ?? 0, encoding: rows.find(row => row.status === 'encoding')?.count ?? 0, aggregateSpeed: rows.find(row => row.status === 'encoding')?.speed ?? 0 }
}

export interface EnqueueRequest {
  kind: 'film' | 'episode' | 'path'
  itemId?: number
  inputPath: string
  title?: string
  action: ExecAction
  targetCodec?: string
  priority?: number
}

export async function enqueue(req: EnqueueRequest): Promise<OptimiseJob | { error: string }> {
  let inputPath: string
  try { inputPath = await managedMediaFile(req.inputPath) } catch (error) { return { error: String(error) } }
  if (!existsSync(inputPath)) return { error: 'input file does not exist' }
  // Safety: never silently strip Dolby Vision. Without a DV RPU toolchain, an
  // automatic transcode loses DV — refuse when the policy says to preserve it.
  if (req.action === 'convert' && getActivePolicy().policy.video.preserve.dolbyVision) {
    const a = await analyzeMedia(inputPath)
    if (a?.video?.dolbyVision) {
      return { error: 'Dolby Vision present and DV preservation is on — automatic transcode would strip it. Remux instead, or disable Dolby Vision preservation in the policy.' }
    }
  }
  const job: OptimiseJob = {
    id: randomUUID(),
    kind: req.kind,
    itemId: req.itemId ?? null,
    action: req.action,
    targetCodec: req.targetCodec,
    title: req.title ?? basename(inputPath),
    inputPath,
    outputPath: plannedOutputPath(inputPath),
    status: 'queued',
    progress: 0,
    suspended: false,
    audioEncoding: false,
    speed: null,
    encoder: null,
    accelerator: null,
    priority: Number.isFinite(req.priority) ? Number(req.priority) : 0,
    vmaf: null,
    sizeBefore: (() => { try { return statSync(inputPath).size } catch { return null } })(),
    sizeAfter: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
  }
  const inserted = getDb().transaction(() => {
    const existing = getDb().prepare("SELECT 1 FROM video_optimisation_jobs WHERE status IN ('queued','encoding','validating','replacing') AND json_extract(job_json,'$.inputPath')=? LIMIT 1").get(inputPath)
    if (existing) return false
    persistJob(job)
    return true
  }).immediate()
  if (!inserted) return { error: 'a job for this file is already in progress' }
  if (engineStarted) pump()
  return job
}

export function cancelJob(id: string): boolean { return requestPersistedControl(id, 'cancel') }
export function pauseJob(id: string): boolean { return requestPersistedControl(id, 'pause') }
export function resumeJob(id: string): boolean { return requestPersistedControl(id, 'resume') }

function markCancelled(job: OptimiseJob, tempPath: string): void {
  cancelRequested.delete(job.id)
  job.status = 'cancelled'
  job.suspended = false
  job.finishedAt = Date.now()
  safeUnlink(tempPath)
  persistJob(job)
}

function requeueAfterShutdown(job: OptimiseJob, tempPath: string): void {
  shutdownRequested.delete(job.id)
  safeUnlink(tempPath)
  job.status = 'queued'
  job.progress = 0
  job.suspended = false
  job.speed = null
  job.error = 'Interrupted by server shutdown; queued to restart from the original file'
  job.startedAt = null
  job.finishedAt = null
  persistJob(job)
}

function pump(): void {
  // Respect global pause and the scheduled encode window — queued jobs simply
  // wait; the re-pump timer (startExecutionEngine) picks them up when allowed.
  if (!engineStarted || engineStopping) return
  applyControlRequests()
  if (!encodingAllowed()) return
  const { workerConcurrency } = getExecutionConfig()
  if (running.size >= workerConcurrency) return
  // Highest priority first, then FIFO by creation time.
  const next = claimOptimiseJob()
  if (!next) return
  jobs.set(next.id, next)
  running.add(next.id)
  const execution = processJob(next).catch(error => { logger.error(`Job ${next.id} execution failed: ${String(error)}`) }).finally(() => {
    running.delete(next.id)
    handles.delete(next.id)
    activeExecutions.delete(next.id)
    jobs.delete(next.id)
    controllers.delete(next.id)
    lastProgressPersist.delete(next.id)
    pump()
  })
  activeExecutions.set(next.id, execution)
  void execution
  // Fill remaining worker slots.
  if (running.size < workerConcurrency) pump()
}

async function processJob(job: OptimiseJob): Promise<void> {
  const tempPath = join(dirname(job.inputPath), `.archivist-opt-${job.id}.mkv`)
  job.status = 'encoding'
  job.startedAt = Date.now()
  persistJob(job)

  const controller = new AbortController()
  controllers.set(job.id, controller)
  try {
    job.inputPath = await managedMediaFile(job.inputPath)
    const sourceIdentity = await statFile(job.inputPath)
    const inputAnalysis = await analyzeMedia(job.inputPath, controller.signal)
    if (!inputAnalysis) return fail(job, 'could not analyse input')
    controller.signal.throwIfAborted()
    // Carry HDR metadata through a transcode so HDR10 survives the re-encode.
    const v = inputAnalysis.video
    const audioPolicy = getActivePolicy().policy.audio
    const keepAudio = new Set(audioPolicy.keepCodecs.map(codec => codec.toLowerCase()))
    job.audioEncoding = job.action === 'convert' && audioPolicy.enabled && inputAnalysis.audio.some(stream => {
      const codec = stream.codec.toLowerCase()
      const lossless = ['truehd', 'dts', 'flac', 'alac', 'wavpack', 'mlp'].includes(codec) || codec.startsWith('pcm_')
      return !keepAudio.has(codec) && !(audioPolicy.preserveLossless && lossless)
    })
    const hdr = job.action === 'convert' && v && v.hdrFormat !== 'SDR'
      ? { format: v.hdrFormat, colorPrimaries: v.colorPrimaries, colorTransfer: v.colorTransfer, colorSpace: v.colorSpace, masterDisplayX265: v.masterDisplayX265, maxCll: v.maxCll }
      : undefined

    // Pick the encoder: hardware when available + preferred, else software.
    const resolved = job.action === 'convert'
      ? await resolveEncoder(job.targetCodec ?? getActivePolicy().policy.video.targetCodec, getExecutionConfig().hwAccel)
      : { encoder: undefined, accelerator: undefined, device: null }
    job.encoder = resolved.encoder ?? null
    job.accelerator = resolved.accelerator ?? (job.action === 'remux' ? 'copy' : 'software')

    // 1. Encode to a temp file on the same filesystem as the original.
    const handle = runEncode(
      { action: job.action, inputPath: job.inputPath, outputPath: tempPath, targetCodec: job.targetCodec, crf: getActivePolicy().policy.video.crf, durationSec: inputAnalysis.durationSec, hdr, encoder: resolved.encoder, accelerator: resolved.accelerator, device: resolved.device, audio: { policy: audioPolicy, streams: inputAnalysis.audio } },
      (p, s) => {
        if (p != null) job.progress = p
        if (s != null) job.speed = s
        persistJob(job, false)
      },
    )
    handles.set(job.id, handle)
    await handle.promise

    if (shutdownRequested.has(job.id)) return requeueAfterShutdown(job, tempPath)
    if (cancelRequested.has(job.id)) return markCancelled(job, tempPath)

    // 2. Validate before touching the original.
    job.status = 'validating'
    persistJob(job)
    const validation = await validateOutput(inputAnalysis, job.action, job.targetCodec, tempPath)
    job.validation = validation
    if (!validation.ok) { safeUnlink(tempPath); return fail(job, `validation failed: ${validation.checks.filter(c => !c.ok).map(c => c.name).join(', ')}`) }
    if (shutdownRequested.has(job.id)) return requeueAfterShutdown(job, tempPath)
    if (cancelRequested.has(job.id)) return markCancelled(job, tempPath)

    // 2b. Optional VMAF quality gate for transcodes.
    const vmafCfg = getExecutionConfig().vmaf
    if (job.action === 'convert' && vmafCfg.enabled) {
      const result = await computeVmaf(job.inputPath, tempPath, controller.signal)
      job.vmaf = result.score
      const passed = passesVmaf(result, vmafCfg.minScore)
      validation.checks.push({ name: 'vmaf', ok: passed, detail: `${result.status}: ${result.score ?? 'no score'} (min ${vmafCfg.minScore})` })
      validation.ok = validation.ok && passed
      controller.signal.throwIfAborted()
      if (!passed) { safeUnlink(tempPath); return fail(job, `VMAF ${result.status}: ${result.score ?? 'no score'}; minimum ${vmafCfg.minScore}`) }
    }
    if (shutdownRequested.has(job.id)) return requeueAfterShutdown(job, tempPath)
    if (cancelRequested.has(job.id)) return markCancelled(job, tempPath)

    job.sizeAfter = statSync(tempPath).size

    // The journal is persisted before any move. Incomplete replacements never
    // enter retention or report success, and can be resumed after a restart.
    applyControlRequests()
    controller.signal.throwIfAborted()
    await managedMediaFile(job.inputPath)
    const currentIdentity = await statFile(job.inputPath)
    if (currentIdentity.size !== sourceIdentity.size || currentIdentity.mtimeMs !== sourceIdentity.mtimeMs || currentIdentity.ino !== sourceIdentity.ino) throw new Error('Original changed while encoding')
    const qPath = join(quarantineDir(), `${job.id}-${basename(job.inputPath)}`)
    getDb().transaction(() => {
      // Serialize accepted controls with the irreversible-phase transition.
      applyControlRequests()
      controller.signal.throwIfAborted()
      job.status = 'replacing'
      job.replacement = { quarantinePath: qPath, phase: 'prepared' }
      persistJob(job)
    }).immediate()
    await moveFile(job.inputPath, qPath)
    job.replacement!.phase = 'quarantined'; persistJob(job)
    await moveFile(tempPath, job.outputPath)
    job.replacement!.phase = 'installed'; persistJob(job)
    updateDbPath(job)
    const retentionMs = Math.max(0, getExecutionConfig().quarantineRetentionDays) * 24 * 60 * 60 * 1000
    quarantine.push({ id: randomUUID(), jobId: job.id, title: job.title, originalPath: job.inputPath, quarantinePath: qPath,
      sizeBytes: job.sizeBefore ?? 0, quarantinedAt: Date.now(), deleteAfter: Date.now() + retentionMs })
    saveQuarantine()
    job.replacement!.phase = 'committed'

    job.status = 'complete'
    job.progress = 1
    job.suspended = false
    job.finishedAt = Date.now()
    persistJob(job)
    logger.info(`Optimised "${job.title}": ${fmt(job.sizeBefore)} → ${fmt(job.sizeAfter)} (${job.action})`)
  } catch (err) {
    if ((job.status as JobStatus) === 'replacing') { job.error = `Replacement requires recovery: ${String(err)}`; persistJob(job); return }
    if (shutdownRequested.has(job.id)) return requeueAfterShutdown(job, tempPath)
    if (cancelRequested.has(job.id)) return markCancelled(job, tempPath)
    safeUnlink(tempPath)
    fail(job, err instanceof Error ? err.message : String(err))
  }
}

function updateDbPath(job: OptimiseJob): void {
  if (job.kind === 'path' || job.itemId == null) return
  const table = job.kind === 'film' ? 'films' : 'episodes'
  const db = getDb()
  db.transaction(() => {
    const result = db.prepare(`UPDATE ${table} SET file_path = ?, updated_at = datetime('now') WHERE id = ? AND file_path IN (?,?)`).run(job.outputPath, job.itemId, job.inputPath, job.outputPath)
    if (result.changes !== 1) throw new Error('Library path changed or item was removed during optimisation')
    if (job.kind === 'film') db.prepare('UPDATE film_editions SET file_path=? WHERE film_id=? AND file_path=?').run(job.outputPath, job.itemId, job.inputPath)
  })()

}

function fail(job: OptimiseJob, msg: string): void {
  job.status = 'failed'
  job.suspended = false
  job.error = msg
  job.finishedAt = Date.now()
  persistJob(job)
  logger.error(`Job "${job.title}" failed: ${msg}`)
}

function safeUnlink(p: string): void { try { if (existsSync(p)) unlinkSync(p) } catch {} }
function fmt(n: number | null): string { return n ? `${(n / 1024 ** 2).toFixed(1)} MB` : '?' }

// ── Quarantine restore + retention sweep ──────────────────────────────────────

export async function retryReplacement(id: string): Promise<boolean> {
  if (running.has(id)) return false
  const row = getDb().prepare("SELECT job_json FROM video_optimisation_jobs WHERE id=? AND status='replacing'").get(id) as { job_json: string } | undefined
  if (!row) return false
  const job = JSON.parse(row.job_json) as OptimiseJob
  await recoverReplacement(job)
  return job.status === 'complete' || job.status === 'queued'
}

export async function restoreQuarantine(id: string): Promise<boolean> {
  const idx = quarantine.findIndex(q => q.id === id)
  if (idx < 0) return false
  const entry = quarantine[idx]
  const stored = getDb().prepare('SELECT job_json FROM video_optimisation_jobs WHERE id=?').get(entry.jobId) as { job_json: string } | undefined
  const job: OptimiseJob | undefined = stored ? JSON.parse(stored.job_json) : undefined
  if (!job) throw new Error('Cannot restore without the persisted replacement job')
  // Persist intent before any move. Retries can finish the pointer update after
  // a crash without deleting either the original or the retained replacement.
  if (!entry.restoring) {
    if (!existsSync(entry.quarantinePath)) throw new Error('Quarantined original is missing')
    entry.restoring = true
    saveQuarantine()
  }
  const retainedOutput = `${job.outputPath}.restored-${job.id}`
  if (existsSync(entry.quarantinePath)) {
    if (existsSync(job.outputPath)) {
      if (existsSync(retainedOutput)) throw new Error('Restore has ambiguous output files; originals retained')
      await moveFile(job.outputPath, retainedOutput)
    }
    await moveFile(entry.quarantinePath, entry.originalPath)
  }
  if (!existsSync(entry.originalPath)) throw new Error('Restored original is missing; recovery required')
  if (job.kind !== 'path' && job.itemId != null) {
    getDb().transaction(() => {
      const table = job.kind === 'film' ? 'films' : 'episodes'
      const updated = getDb().prepare(`UPDATE ${table} SET file_path=? WHERE id=? AND file_path IN (?,?)`)
        .run(entry.originalPath, job.itemId, job.outputPath, entry.originalPath)
      if (updated.changes !== 1) throw new Error('Restored file retained but library pointer could not be updated')
      if (job.kind === 'film') getDb().prepare('UPDATE film_editions SET file_path=? WHERE film_id=? AND file_path=?').run(entry.originalPath, job.itemId, job.outputPath)
    }).immediate()
  }
  quarantine.splice(idx, 1)
  saveQuarantine()
  logger.info(`Restored "${entry.title}" from quarantine`)
  return true
}

function sweepQuarantine(): void {
  const now = Date.now()
  const expired = quarantine.filter(q => !q.restoring && q.deleteAfter <= now && (getDb().prepare('SELECT status FROM video_optimisation_jobs WHERE id=?').get(q.jobId) as { status: string } | undefined)?.status === 'complete')
  for (const q of expired) {
    try { if (existsSync(q.quarantinePath)) rmSync(q.quarantinePath, { force: true }) } catch { q.deleteAfter = now + 3600_000 }
  }
  if (expired.length) {
    quarantine = quarantine.filter(q => !expired.includes(q) || existsSync(q.quarantinePath))
    saveQuarantine()
    logger.info(`Quarantine sweep removed ${expired.length} expired original(s)`)
  }
}

/** Re-check the queue so jobs held by the encode window / pause start when allowed. */
export function resumePump(): void { pump() }

export async function startExecutionEngine(): Promise<void> {
  if (sweepTimer || pumpTimer) return
  engineStopping = false
  engineStarted = true
  loadQuarantine()
  await loadPersistedJobs()
  jobs.clear()
  sweepQuarantine()
  sweepTimer = setInterval(sweepQuarantine, 60 * 60 * 1000)
  sweepTimer.unref?.()
  // Periodically re-pump so scheduled-window jobs start on time without an event.
  pumpTimer = setInterval(pump, 1_000)
  pumpTimer.unref?.()
  startStatsSampler()
  pump()
}

export async function stopExecutionEngine(graceMs = 15_000): Promise<void> {
  engineStopping = true
  engineStarted = false
  if (sweepTimer) clearInterval(sweepTimer)
  if (pumpTimer) clearInterval(pumpTimer)
  sweepTimer = null
  pumpTimer = null
  stopStatsSampler()
  for (const id of running) {
    const job = jobs.get(id)
    if (!job || (job.status !== 'encoding' && job.status !== 'validating')) continue
    shutdownRequested.add(id)
    handles.get(id)?.cancel()
    controllers.get(id)?.abort(new Error('Shutdown'))
  }
  const active = [...activeExecutions.values()]
  if (!active.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    Promise.allSettled(active).then(() => false),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), Math.max(0, graceMs)); timer.unref?.() }),
  ])
  if (timer) clearTimeout(timer)
  if (timedOut) logger.warn(`${activeExecutions.size} video optimisation job(s) did not stop within ${graceMs}ms; persisted recovery will run at next startup`)
}

/** Re-exported so callers can decide whether a remux is even needed. */
export { needsRemux }
