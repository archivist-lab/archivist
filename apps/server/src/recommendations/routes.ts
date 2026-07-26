import { Router } from 'express'
import type { RecommendationMediaType } from '@archivist/contracts'
import { RecommendationFeedbackRequest, RecommendationSettingsPatch } from '@archivist/contracts'
import { requireLibrary, requireLibraryMediaType } from '../middleware/library-context.js'
import { validateBody } from '../middleware/validate.js'
import { clearRecommendationFeedback, ensureExternalRecommendationCandidates, generateRecommendationSnapshot, getRecommendationPage, getRecommendationSettings, invalidateRecommendationSnapshots, recommendationHealth, refreshExternalRecommendationCandidates, setRecommendationFeedback, setRecommendationSettings } from './service.js'

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
  router.post('/recommendations/feedback', validateBody(RecommendationFeedbackRequest), (req, res) => {
    const { mediaType, providerId, feedback } = req.body as RecommendationFeedbackRequest
    // Feedback is per-profile; the shared household view has nobody to attribute it to.
    const profileId = audience(req.body.profileId)
    if (profileId === 'household') {
      return res.status(400).json({ error: 'Feedback requires a specific profileId' })
    }
    setRecommendationFeedback(profileId, mediaType, providerId, feedback)
    res.status(204).end()
  })
  router.get('/system/recommendations/health', (_req, res) => res.json(recommendationHealth()))
  router.get('/system/recommendations/settings', (_req, res) => res.json(getRecommendationSettings()))
  router.put('/system/recommendations/settings', validateBody(RecommendationSettingsPatch), (req, res) => {
    res.json(setRecommendationSettings(req.body as RecommendationSettingsPatch))
  })
  router.post('/system/recommendations/invalidate', (_req, res) => {
    invalidateRecommendationSnapshots()
    res.json({ ok: true })
  })
  router.delete('/system/recommendations/feedback', (req, res) => {
    const profile = typeof req.query.profileId === 'string' && req.query.profileId.trim() ? req.query.profileId.trim() : undefined
    res.json({ removed: clearRecommendationFeedback(profile) })
  })
  return router
}
