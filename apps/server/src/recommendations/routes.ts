import { Router } from 'express'
import type { RecommendationFeedback, RecommendationMediaType } from '@archivist/contracts'
import { requireLibrary, requireLibraryMediaType } from '../middleware/library-context.js'
import { ensureExternalRecommendationCandidates, generateRecommendationSnapshot, getRecommendationPage, getRecommendationSettings, recommendationHealth, refreshExternalRecommendationCandidates, setRecommendationFeedback, setRecommendationSettings } from './service.js'

const audience = (value: unknown): string => {
  const candidate = typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : 'household'
  return candidate === 'household' || /^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate) ? candidate : 'household'
}

export function createRecommendationsRouter(): Router {
  const router = Router()
  router.get('/recommendations/films', requireLibrary, requireLibraryMediaType('films'), async (req, res) => {
    try { await ensureExternalRecommendationCandidates('film') } catch { /* local/cached recommendations remain usable */ }
    res.json(getRecommendationPage('film', audience(req.query.audience), req.library!.id))
  })
  router.get('/recommendations/series', requireLibrary, requireLibraryMediaType('series'), async (req, res) => {
    try { await ensureExternalRecommendationCandidates('series') } catch { /* local/cached recommendations remain usable */ }
    res.json(getRecommendationPage('series', audience(req.query.audience), req.library!.id))
  })
  router.post('/recommendations/rebuild', requireLibrary, async (req, res) => {
    const mediaType: RecommendationMediaType = req.library!.mediaType === 'series' ? 'series' : 'film'
    try { await refreshExternalRecommendationCandidates() } catch { /* rebuild from the last durable cache */ }
    res.json(generateRecommendationSnapshot(mediaType, audience(req.body?.audience), req.library!.id))
  })
  router.post('/recommendations/refresh-sources', async (_req, res) => {
    try { res.json(await refreshExternalRecommendationCandidates()) }
    catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Recommendation source refresh failed' }) }
  })
  router.post('/recommendations/feedback', (req, res) => {
    const profileId = audience(req.body?.profileId)
    const mediaType = req.body?.mediaType
    const providerId = Number(req.body?.providerId)
    const feedback = req.body?.feedback as RecommendationFeedback
    if (profileId === 'household' || !['film', 'series'].includes(mediaType) || !Number.isSafeInteger(providerId) || providerId < 1 || !['more_like_this', 'less_like_this', 'not_interested', 'already_seen'].includes(feedback)) {
      return res.status(400).json({ error: 'Valid profileId, mediaType, providerId and feedback are required' })
    }
    setRecommendationFeedback(profileId, mediaType, providerId, feedback)
    res.status(204).end()
  })
  router.get('/system/recommendations/health', (_req, res) => res.json(recommendationHealth()))
  router.get('/system/recommendations/settings', (_req, res) => res.json(getRecommendationSettings()))
  router.put('/system/recommendations/settings', (req, res) => {
    if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
    if (req.body?.retentionDays !== undefined && (!Number.isInteger(req.body.retentionDays) || req.body.retentionDays < 7 || req.body.retentionDays > 365)) return res.status(400).json({ error: 'retentionDays must be an integer from 7 to 365' })
    res.json(setRecommendationSettings({ enabled: req.body?.enabled, retentionDays: req.body?.retentionDays }))
  })
  return router
}
