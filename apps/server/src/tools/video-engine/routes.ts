/**
 * Processing API — the read-only Video Optimisation surface (Phase 1):
 * inspect/edit the active policy, list presets, and analyse a file to get its
 * analysis + recommendation. No transcoding happens here yet.
 */

import { Router } from 'express'
import { resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { createLogger } from '@archivist/core'
import { analyzeMedia } from './analyzer.js'
import { recommend } from './recommender.js'
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, getActivePolicy, setActivePolicy, type OptimisationPolicy } from './policy.js'
import { getScanState, runScan } from './scanner.js'
import { enqueue, listJobs, cancelJob, listQuarantine, restoreQuarantine, resumePump, type EnqueueRequest } from './queue.js'
import { getExecutionConfig, setExecutionConfig, type ExecutionConfig } from './execution-config.js'
import { detectHwCapabilities } from './hwaccel.js'
import { getDb } from '../../db.js'

const logger = createLogger('Processing')

function mediaBaseDir(): string {
  return resolve(process.env.ARCHIVIST_MEDIA_BASE ?? './media')
}

/** Only allow analysing files inside the media library (no arbitrary host paths). */
function safeMediaPath(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null
  const base = mediaBaseDir()
  const abs = resolve(base, input) // relative inputs resolve under the media dir
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return existsSync(abs) ? abs : null
}

export function createProcessingRouter(): Router {
  const router = Router()

  // Built-in presets (id → preset).
  router.get('/processing/presets', (_req, res) => {
    res.json({
      defaultPresetId: DEFAULT_PRESET_ID,
      presets: Object.entries(BUILTIN_PRESETS).map(([id, preset]) => ({ id, ...preset })),
    })
  })

  // Active policy.
  router.get('/processing/policy', (_req, res) => {
    res.json(getActivePolicy())
  })

  router.put('/processing/policy', (req, res) => {
    const body = req.body as { presetId?: string; policy?: OptimisationPolicy }
    if (!body?.policy?.video || !body.policy.audio) {
      return res.status(400).json({ error: 'policy with video and audio required' })
    }
    setActivePolicy({ presetId: body.presetId ?? 'custom', policy: body.policy })
    res.json(getActivePolicy())
  })

  // Library-wide optimisation scan (background) + current state.
  router.post('/processing/scan', (_req, res) => {
    const already = getScanState().status === 'scanning'
    if (!already) void runScan()
    res.json({ started: !already, status: getScanState().status })
  })

  router.get('/processing/scan', (_req, res) => {
    res.json(getScanState())
  })

  // Analyse a file (path relative to the media library) → analysis + recommendation.
  router.post('/processing/analyze', (req, res) => {
    const path = safeMediaPath(req.body?.path)
    if (!path) return res.status(400).json({ error: 'path must be an existing file inside the media library' })
    try {
      const analysis = analyzeMedia(path)
      if (!analysis) return res.status(422).json({ error: 'ffprobe could not analyse this file' })
      const recommendation = recommend(analysis, getActivePolicy().policy)
      res.json({ analysis, recommendation })
    } catch (err) {
      logger.error(`analyze failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: 'analysis failed' })
    }
  })

  // ── Execution (Phase 2): jobs + quarantine ──────────────────────────────────

  function resolveItemPath(kind: string, itemId: number): { path: string; title: string } | null {
    const db = getDb()
    if (kind === 'film') {
      const row = db.prepare('SELECT title, year, file_path FROM films WHERE id = ?').get(itemId) as any
      return row?.file_path ? { path: row.file_path, title: `${row.title}${row.year ? ` (${row.year})` : ''}` } : null
    }
    if (kind === 'episode') {
      const row = db.prepare('SELECT e.season_number sn, e.episode_number en, e.file_path, s.title series FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?').get(itemId) as any
      if (!row?.file_path) return null
      return { path: row.file_path, title: `${row.series} S${String(row.sn).padStart(2, '0')}E${String(row.en).padStart(2, '0')}` }
    }
    return null
  }

  // Enqueue an optimisation job for a library item (or a media-relative path).
  router.post('/processing/jobs', (req, res) => {
    const { kind, itemId, path, action, targetCodec, priority } = req.body ?? {}
    if (action !== 'remux' && action !== 'convert') return res.status(400).json({ error: 'action must be remux or convert' })

    let inputPath: string | null = null
    let title: string | undefined
    if ((kind === 'film' || kind === 'episode') && Number.isFinite(Number(itemId))) {
      const resolved = resolveItemPath(kind, Number(itemId))
      if (!resolved) return res.status(404).json({ error: 'item has no file on disk' })
      inputPath = resolved.path
      title = resolved.title
    } else {
      inputPath = safeMediaPath(path)
      if (!inputPath) return res.status(400).json({ error: 'path must be an existing file inside the media library' })
    }

    const request: EnqueueRequest = { kind: kind === 'film' || kind === 'episode' ? kind : 'path', itemId: Number(itemId) || undefined, inputPath, title, action, targetCodec, priority: Number(priority) || 0 }
    const result = enqueue(request)
    if ('error' in result) return res.status(409).json({ error: result.error })
    res.status(201).json(result)
  })

  router.get('/processing/jobs', (_req, res) => {
    res.json({ jobs: listJobs(), quarantine: listQuarantine() })
  })

  router.post('/processing/jobs/:id/cancel', (req, res) => {
    res.json({ cancelled: cancelJob(req.params.id) })
  })

  router.post('/processing/quarantine/:id/restore', (req, res) => {
    res.json({ restored: restoreQuarantine(req.params.id) })
  })

  // ── Execution settings: hardware, concurrency, encode window, pause ──────────

  router.get('/processing/execution', (_req, res) => {
    res.json({ config: getExecutionConfig(), hardware: detectHwCapabilities() })
  })

  router.put('/processing/execution', (req, res) => {
    const patch = (req.body ?? {}) as Partial<ExecutionConfig>
    const updated = setExecutionConfig(patch)
    resumePump() // apply un-pause / widened window immediately
    res.json({ config: updated, hardware: detectHwCapabilities() })
  })

  return router
}
