/**
 * Execution Queue + Atomic Replacement + Quarantine.
 *
 * Safety workflow (from the spec) — the original is never overwritten in place:
 *   Original → Encode (temp) → Validate → move Original to Quarantine →
 *   move Output into place → update DB → Retention Timer → delete Original.
 * If validation fails the temp is deleted and the original is left untouched.
 * Everything is reversible until quarantine retention expires.
 */

import { existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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
import { computeVmaf, isVmafAvailable } from './vmaf.js'
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
}

function quarantineDir(): string {
  return resolve(process.env.ARCHIVIST_QUARANTINE_DIR ?? './data/quarantine')
}

// ── State ─────────────────────────────────────────────────────────────────────

const jobs = new Map<string, OptimiseJob>()
const running = new Set<string>()
const handles = new Map<string, EncodeHandle>()
const cancelRequested = new Set<string>()
let quarantine: QuarantineEntry[] = []
let sweepTimer: ReturnType<typeof setInterval> | null = null
let pumpTimer: ReturnType<typeof setInterval> | null = null

function manifestPath(): string { return join(quarantineDir(), 'manifest.json') }

function loadQuarantine(): void {
  try {
    if (existsSync(manifestPath())) quarantine = JSON.parse(readFileSync(manifestPath(), 'utf8'))
  } catch { quarantine = [] }
}

function saveQuarantine(): void {
  try {
    mkdirSync(quarantineDir(), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify(quarantine, null, 2))
  } catch (err) { logger.warn(`quarantine manifest write failed: ${err}`) }
}

/** Move a file, falling back to copy+unlink across filesystems (EXDEV). */
function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (err: any) {
    if (err?.code === 'EXDEV') { copyFileSync(from, to); unlinkSync(from) }
    else throw err
  }
}

// ── Job lifecycle ───────────────────────────────────────────────────────────

export function listJobs(): OptimiseJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function listQuarantine(): QuarantineEntry[] {
  return [...quarantine].sort((a, b) => b.quarantinedAt - a.quarantinedAt)
}

/** Live queue counts + total encode throughput (× realtime) for the dashboard. */
export function queueStats(): { encoding: number; queued: number; aggregateSpeed: number } {
  let encoding = 0, queued = 0, aggregateSpeed = 0
  for (const j of jobs.values()) {
    if (j.status === 'queued') queued++
    else if (j.status === 'encoding') { encoding++; aggregateSpeed += j.speed ?? 0 }
  }
  return { encoding, queued, aggregateSpeed: Math.round(aggregateSpeed * 100) / 100 }
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

export function enqueue(req: EnqueueRequest): OptimiseJob | { error: string } {
  const inputPath = resolve(req.inputPath)
  if (!existsSync(inputPath)) return { error: 'input file does not exist' }
  // Guard against double-queueing the same file.
  for (const j of jobs.values()) {
    if (j.inputPath === inputPath && (j.status === 'queued' || running.has(j.id))) return { error: 'a job for this file is already in progress' }
  }
  // Safety: never silently strip Dolby Vision. Without a DV RPU toolchain, an
  // automatic transcode loses DV — refuse when the policy says to preserve it.
  if (req.action === 'convert' && getActivePolicy().policy.video.preserve.dolbyVision) {
    const a = analyzeMedia(inputPath)
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
  jobs.set(job.id, job)
  pump()
  return job
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = Date.now(); return true }
  if (running.has(id)) { cancelRequested.add(id); handles.get(id)?.cancel(); return true }
  return false
}

export function pauseJob(id: string): boolean {
  const job = jobs.get(id)
  const handle = handles.get(id)
  if (!job || !handle || job.status !== 'encoding' || job.suspended) return false
  if (!handle.pause()) return false
  job.suspended = true
  job.speed = null
  return true
}

export function resumeJob(id: string): boolean {
  const job = jobs.get(id)
  const handle = handles.get(id)
  if (!job || !handle || job.status !== 'encoding' || !job.suspended) return false
  if (!handle.resume()) return false
  job.suspended = false
  return true
}

function markCancelled(job: OptimiseJob, tempPath: string): void {
  cancelRequested.delete(job.id)
  job.status = 'cancelled'
  job.suspended = false
  job.finishedAt = Date.now()
  safeUnlink(tempPath)
}

function pump(): void {
  // Respect global pause and the scheduled encode window — queued jobs simply
  // wait; the re-pump timer (startExecutionEngine) picks them up when allowed.
  if (!encodingAllowed()) return
  const { workerConcurrency } = getExecutionConfig()
  if (running.size >= workerConcurrency) return
  // Highest priority first, then FIFO by creation time.
  const next = [...jobs.values()].filter(j => j.status === 'queued').sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)[0]
  if (!next) return
  running.add(next.id)
  void processJob(next).finally(() => {
    running.delete(next.id)
    handles.delete(next.id)
    pump()
  })
  // Fill remaining worker slots.
  if (running.size < workerConcurrency) pump()
}

async function processJob(job: OptimiseJob): Promise<void> {
  const tempPath = join(dirname(job.inputPath), `.archivist-opt-${job.id}.mkv`)
  job.status = 'encoding'
  job.startedAt = Date.now()

  const inputAnalysis = analyzeMedia(job.inputPath)
  if (!inputAnalysis) return fail(job, 'could not analyse input')

  try {
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
      ? resolveEncoder(job.targetCodec ?? getActivePolicy().policy.video.targetCodec, getExecutionConfig().hwAccel)
      : { encoder: undefined, accelerator: undefined, device: null }
    job.encoder = resolved.encoder ?? null
    job.accelerator = resolved.accelerator ?? (job.action === 'remux' ? 'copy' : 'software')

    // 1. Encode to a temp file on the same filesystem as the original.
    const handle = runEncode(
      { action: job.action, inputPath: job.inputPath, outputPath: tempPath, targetCodec: job.targetCodec, crf: getActivePolicy().policy.video.crf, durationSec: inputAnalysis.durationSec, hdr, encoder: resolved.encoder, accelerator: resolved.accelerator, device: resolved.device, audio: { policy: audioPolicy, streams: inputAnalysis.audio } },
      (p, s) => { if (p != null) job.progress = p; if (s != null) job.speed = s },
    )
    handles.set(job.id, handle)
    await handle.promise

    if (cancelRequested.has(job.id)) return markCancelled(job, tempPath)

    // 2. Validate before touching the original.
    job.status = 'validating'
    const validation = validateOutput(inputAnalysis, job.action, job.targetCodec, tempPath)
    job.validation = validation
    if (!validation.ok) { safeUnlink(tempPath); return fail(job, `validation failed: ${validation.checks.filter(c => !c.ok).map(c => c.name).join(', ')}`) }

    // 2b. Optional VMAF quality gate for transcodes.
    const vmafCfg = getExecutionConfig().vmaf
    if (job.action === 'convert' && vmafCfg.enabled && isVmafAvailable()) {
      const score = await computeVmaf(job.inputPath, tempPath)
      job.vmaf = score
      validation.checks.push({ name: 'vmaf', ok: score == null || score >= vmafCfg.minScore, detail: score == null ? 'unavailable' : `${score} (min ${vmafCfg.minScore})` })
      if (score != null && score < vmafCfg.minScore) { safeUnlink(tempPath); return fail(job, `VMAF ${score} below minimum ${vmafCfg.minScore}`) }
    }

    job.sizeAfter = statSync(tempPath).size

    // 3. Atomic replacement: quarantine original, move output into place.
    job.status = 'replacing'
    const qPath = join(quarantineDir(), `${job.id}-${basename(job.inputPath)}`)
    moveFile(job.inputPath, qPath)
    try {
      moveFile(tempPath, job.outputPath)
    } catch (err) {
      // Rollback: put the original back so we never lose the file.
      moveFile(qPath, job.inputPath)
      throw err
    }

    // 4. Repoint the library at the new file (extension may have changed).
    if (job.outputPath !== job.inputPath) updateDbPath(job)

    // 5. Record quarantine entry with a retention timer.
    const retentionMs = getExecutionConfig().quarantineRetentionDays * 24 * 60 * 60 * 1000
    quarantine.push({
      id: randomUUID(), jobId: job.id, title: job.title,
      originalPath: job.inputPath, quarantinePath: qPath,
      sizeBytes: job.sizeBefore ?? 0, quarantinedAt: Date.now(), deleteAfter: Date.now() + retentionMs,
    })
    saveQuarantine()

    job.status = 'complete'
    job.progress = 1
    job.suspended = false
    job.finishedAt = Date.now()
    logger.info(`Optimised "${job.title}": ${fmt(job.sizeBefore)} → ${fmt(job.sizeAfter)} (${job.action})`)
  } catch (err) {
    if (cancelRequested.has(job.id)) return markCancelled(job, tempPath)
    safeUnlink(tempPath)
    fail(job, err instanceof Error ? err.message : String(err))
  }
}

function updateDbPath(job: OptimiseJob): void {
  if (job.kind === 'path' || job.itemId == null) return
  const table = job.kind === 'film' ? 'films' : 'episodes'
  try {
    getDb().prepare(`UPDATE ${table} SET file_path = ?, updated_at = datetime('now') WHERE id = ?`).run(job.outputPath, job.itemId)
  } catch (err) { logger.warn(`db path update failed for ${job.kind} ${job.itemId}: ${err}`) }
}

function fail(job: OptimiseJob, msg: string): void {
  job.status = 'failed'
  job.suspended = false
  job.error = msg
  job.finishedAt = Date.now()
  logger.error(`Job "${job.title}" failed: ${msg}`)
}

function safeUnlink(p: string): void { try { if (existsSync(p)) unlinkSync(p) } catch {} }
function fmt(n: number | null): string { return n ? `${(n / 1024 ** 2).toFixed(1)} MB` : '?' }

// ── Quarantine restore + retention sweep ──────────────────────────────────────

export function restoreQuarantine(id: string): boolean {
  const idx = quarantine.findIndex(q => q.id === id)
  if (idx < 0) return false
  const entry = quarantine[idx]
  if (!existsSync(entry.quarantinePath)) { quarantine.splice(idx, 1); saveQuarantine(); return false }
  // Remove the optimised replacement (if present) and restore the original.
  const job = [...jobs.values()].find(j => j.id === entry.jobId)
  if (job && existsSync(job.outputPath) && job.outputPath !== entry.originalPath) safeUnlink(job.outputPath)
  moveFile(entry.quarantinePath, entry.originalPath)
  if (job && job.kind !== 'path' && job.itemId != null) {
    const table = job.kind === 'film' ? 'films' : 'episodes'
    try { getDb().prepare(`UPDATE ${table} SET file_path = ? WHERE id = ?`).run(entry.originalPath, job.itemId) } catch {}
  }
  quarantine.splice(idx, 1)
  saveQuarantine()
  logger.info(`Restored "${entry.title}" from quarantine`)
  return true
}

function sweepQuarantine(): void {
  const now = Date.now()
  const expired = quarantine.filter(q => q.deleteAfter <= now)
  for (const q of expired) {
    try { if (existsSync(q.quarantinePath)) rmSync(q.quarantinePath, { force: true }) } catch {}
  }
  if (expired.length) {
    quarantine = quarantine.filter(q => q.deleteAfter > now)
    saveQuarantine()
    logger.info(`Quarantine sweep removed ${expired.length} expired original(s)`)
  }
}

/** Re-check the queue so jobs held by the encode window / pause start when allowed. */
export function resumePump(): void { pump() }

export function startExecutionEngine(): void {
  loadQuarantine()
  sweepQuarantine()
  sweepTimer = setInterval(sweepQuarantine, 60 * 60 * 1000)
  sweepTimer.unref?.()
  // Periodically re-pump so scheduled-window jobs start on time without an event.
  pumpTimer = setInterval(pump, 60 * 1000)
  pumpTimer.unref?.()
  startStatsSampler()
}

export function stopExecutionEngine(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  if (pumpTimer) clearInterval(pumpTimer)
  sweepTimer = null
  pumpTimer = null
  stopStatsSampler()
}

/** Re-exported so callers can decide whether a remux is even needed. */
export { needsRemux }
