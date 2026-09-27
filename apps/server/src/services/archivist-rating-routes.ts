import { Router } from 'express'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import {
  getArchivistRatingSettings,
  normaliseArchivistRatingSettings,
  saveArchivistRatingSettings,
  weightsFor,
  type ScoredMediaType,
} from './archivist-rating-settings.js'
import {
  libraryMean,
  providerScores,
  ratingBreakdown,
  ratingCoverage,
  recomputeStale,
  scoreFrom,
  type RatingSubjectType,
} from './archivist-rating.js'
import {
  backfillFromCataloguePayloads,
  diagnoseRatingRefresh,
  enqueueDueRatingRefreshes,
  enqueueMissingImdbIdRefreshes,
  enqueueRatingRefresh,
} from './archivist-rating-refresh.js'
import { omdbConfigured } from './omdb.js'

const logger = createLogger('ArchivistRatingRoutes')

function subjectFromParams(params: Record<string, string>): { type: RatingSubjectType; id: number } | null {
  const type = params.type === 'series' ? 'series' : params.type === 'film' ? 'film' : null
  const id = Number(params.id)
  return type && Number.isInteger(id) && id > 0 ? { type, id } : null
}

/**
 * Shows what a candidate weighting would do to titles the operator recognises,
 * before it is saved. Retuning weights republishes every score in the library,
 * so seeing the effect first is worth a round trip.
 */
function previewWith(settings: ReturnType<typeof normaliseArchivistRatingSettings>, limit: number) {
  const db = getDb()
  const mean = libraryMean(db)
  const rows = db.prepare(`
    SELECT subject_type AS subjectType, subject_id AS subjectId, title FROM (
      SELECT 'film' AS subject_type, f.id AS subject_id, f.title, c.confidence
      FROM composite_scores c JOIN films f ON f.id = c.subject_id
      WHERE c.subject_type = 'film'
      UNION ALL
      SELECT 'series', s.id, s.title, c.confidence
      FROM composite_scores c JOIN series s ON s.id = c.subject_id
      WHERE c.subject_type = 'series'
    )
    ORDER BY confidence DESC, title ASC
    LIMIT ?
  `).all(limit) as Array<{ subjectType: RatingSubjectType; subjectId: number; title: string }>

  return rows.map(row => {
    const mediaType: ScoredMediaType = row.subjectType === 'film' ? 'films' : 'series'
    const scores = providerScores(row.subjectType, row.subjectId, db)
    const current = db.prepare('SELECT score FROM composite_scores WHERE subject_type = ? AND subject_id = ?')
      .get(row.subjectType, row.subjectId) as { score: number } | undefined
    const next = scoreFrom(scores, mediaType, settings, mean)
    const weights = weightsFor(settings, mediaType)
    return {
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      title: row.title,
      current: current ? Number((current.score / 10).toFixed(2)) : null,
      proposed: next ? Number((next.score / 10).toFixed(2)) : null,
      confidence: next ? Number(next.confidence.toFixed(2)) : 0,
      providers: scores
        .filter(entry => (weights[entry.provider] ?? 0) > 0)
        .map(entry => ({ provider: entry.provider, scoreRaw: entry.scoreRaw, weight: weights[entry.provider] })),
    }
  })
}

export function createArchivistRatingRouter(): Router {
  const router = Router()

  router.get('/scoring/settings', (_req, res) => {
    res.json({
      settings: getArchivistRatingSettings(),
      omdbConfigured: omdbConfigured(),
      coverage: ratingCoverage(),
      diagnosis: diagnoseRatingRefresh(),
    })
  })

  router.put('/scoring/settings', (req, res) => {
    try {
      const settings = saveArchivistRatingSettings(req.body)
      // Changing a weight invalidates every stored composite but none of the
      // provider scores under it, so this is a recompute and never a refetch.
      const { recomputed, remaining } = recomputeStale()
      res.json({ settings, recomputed, remaining })
    } catch (err) {
      logger.warn(`Could not save scoring settings: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/scoring/preview', (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 12))
      res.json({ items: previewWith(normaliseArchivistRatingSettings(req.body?.settings), limit) })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/scoring/recompute', (_req, res) => {
    try { res.json(recomputeStale()) }
    catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }) }
  })

  router.post('/scoring/refresh', (_req, res) => {
    try {
      const backfilled = backfillFromCataloguePayloads().matched
      const enqueued = enqueueDueRatingRefreshes()
      // The diagnosis is read after the work, so the counts describe what is
      // left rather than what was there a moment ago.
      res.json({ backfilled, enqueued, diagnosis: diagnoseRatingRefresh() })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/scoring/backfill-ids', (_req, res) => {
    try { res.json(enqueueMissingImdbIdRefreshes()) }
    catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }) }
  })

  router.get('/scoring/:type/:id', (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject) return res.status(400).json({ error: 'Invalid rating subject' })
    try { res.json(ratingBreakdown(subject.type, subject.id)) }
    catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }) }
  })

  router.post('/scoring/:type/:id/refresh', (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject) return res.status(400).json({ error: 'Invalid rating subject' })
    res.json({ jobId: enqueueRatingRefresh(subject.type, subject.id) })
  })

  return router
}
