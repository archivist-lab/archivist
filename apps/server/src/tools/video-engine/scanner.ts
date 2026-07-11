/**
 * Library Scanner — walks every film/episode that has a file on disk, runs the
 * Analysis + Recommendation engines, and aggregates the result into the numbers
 * the Processing dashboard shows (library size, optimisable storage, estimated
 * saving, counts by recommendation). Read-only: it never touches files.
 *
 * Results live in memory for now (analysis is cached by path+size+mtime so
 * repeat scans are cheap); persistence + async probing are Phase-2 concerns.
 */

import { existsSync, statSync } from 'node:fs'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { analyzeMedia, type MediaAnalysis } from './analyzer.js'
import { recommend, type Recommendation, type RecommendationAction } from './recommender.js'
import { getActivePolicy } from './policy.js'

const logger = createLogger('ProcessingScan')

export interface ScanItem {
  kind: 'film' | 'episode'
  id: number
  title: string
  path: string
  sizeBytes: number
  codec: string | null
  resolution: string | null
  hdr: string | null
  recommendation: Recommendation
}

export interface ScanAggregate {
  libraryBytes: number
  optimisableBytes: number
  estimatedSavingBytes: number
  counts: Record<RecommendationAction, number>
  filesAnalysed: number
  filesFailed: number
}

export interface ScanState {
  status: 'idle' | 'scanning' | 'complete' | 'error'
  scanned: number
  total: number
  startedAt: number | null
  finishedAt: number | null
  aggregate: ScanAggregate
  items: ScanItem[]
  error?: string
}

function emptyAggregate(): ScanAggregate {
  return {
    libraryBytes: 0,
    optimisableBytes: 0,
    estimatedSavingBytes: 0,
    counts: { convert: 0, remux: 0, keep: 0, skip: 0 },
    filesAnalysed: 0,
    filesFailed: 0,
  }
}

let state: ScanState = { status: 'idle', scanned: 0, total: 0, startedAt: null, finishedAt: null, aggregate: emptyAggregate(), items: [] }
let running = false
const analysisCache = new Map<string, { mtimeMs: number; size: number; analysis: MediaAnalysis }>()

function analyzeCached(path: string): MediaAnalysis | null {
  let meta
  try { meta = statSync(path) } catch { return null }
  const hit = analysisCache.get(path)
  if (hit && hit.mtimeMs === meta.mtimeMs && hit.size === meta.size) return hit.analysis
  const analysis = analyzeMedia(path)
  if (analysis) analysisCache.set(path, { mtimeMs: meta.mtimeMs, size: meta.size, analysis })
  return analysis
}

interface Target { kind: 'film' | 'episode'; id: number; title: string; path: string }

function collectTargets(): Target[] {
  const db = getDb()
  const targets: Target[] = []
  const films = db.prepare("SELECT id, title, year, file_path FROM films WHERE file_path IS NOT NULL AND file_path != ''").all() as any[]
  for (const f of films) targets.push({ kind: 'film', id: f.id, title: `${f.title}${f.year ? ` (${f.year})` : ''}`, path: f.file_path })

  const eps = db.prepare(`
    SELECT e.id, e.season_number AS sn, e.episode_number AS en, e.file_path, s.title AS series
    FROM episodes e JOIN series s ON s.id = e.series_id
    WHERE e.file_path IS NOT NULL AND e.file_path != ''
  `).all() as any[]
  for (const e of eps) {
    const code = `S${String(e.sn).padStart(2, '0')}E${String(e.en).padStart(2, '0')}`
    targets.push({ kind: 'episode', id: e.id, title: `${e.series} ${code}`, path: e.file_path })
  }
  return targets
}

export function getScanState(): ScanState {
  return state
}

/** Run a full library scan in the background. No-op if one is already running. */
export async function runScan(): Promise<void> {
  if (running) return
  running = true
  const policy = getActivePolicy().policy
  const targets = collectTargets()
  const aggregate = emptyAggregate()
  state = { status: 'scanning', scanned: 0, total: targets.length, startedAt: Date.now(), finishedAt: null, aggregate, items: [] }
  logger.info(`Scanning ${targets.length} library file(s) for optimisation`)

  try {
    for (const t of targets) {
      state.scanned++
      if (!existsSync(t.path)) { aggregate.filesFailed++; continue }
      const analysis = analyzeCached(t.path)
      if (!analysis) { aggregate.filesFailed++; continue }

      const rec = recommend(analysis, policy)
      aggregate.libraryBytes += analysis.sizeBytes
      aggregate.filesAnalysed++
      aggregate.counts[rec.action]++
      if (rec.action === 'convert' || rec.action === 'remux') {
        aggregate.optimisableBytes += analysis.sizeBytes
        aggregate.estimatedSavingBytes += rec.estimatedSavingBytes ?? 0
      }
      state.items.push({
        kind: t.kind,
        id: t.id,
        title: t.title,
        path: t.path,
        sizeBytes: analysis.sizeBytes,
        codec: analysis.video?.codec ?? null,
        resolution: analysis.video?.resolutionLabel ?? null,
        hdr: analysis.video && analysis.video.hdrFormat !== 'SDR' ? analysis.video.hdrFormat : null,
        recommendation: rec,
      })

      // Yield periodically so a large library doesn't monopolise the event loop.
      if (state.scanned % 5 === 0) await new Promise(r => setImmediate(r))
    }
    state.status = 'complete'
    state.finishedAt = Date.now()
    logger.info(`Scan complete: ${aggregate.filesAnalysed} analysed, ~${(aggregate.estimatedSavingBytes / 1024 ** 3).toFixed(1)} GB estimated saving`)
  } catch (err) {
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    logger.error(`Scan failed: ${state.error}`)
  } finally {
    running = false
  }
}
