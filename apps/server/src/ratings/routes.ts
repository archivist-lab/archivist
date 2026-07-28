import { Router, type Response } from 'express'
import { DismissRatingRequestSchema, RatingProfileQuerySchema, RatingSubjectSchema, SetRatingRequestSchema, UnratedQueueQuerySchema, type RatingProfileQuery, type UnratedQueueQuery } from '@archivist/contracts'
import { rateLimit } from '../middleware/rate-limit.js'
import { validateBody, validateQuery, validatedQuery } from '../middleware/validate.js'
import { clearRating, dismissUnrated, listUnratedQueue, resolveRating, resolveSeriesRatingTree, setRating } from '../services/ratings.js'
import { getSseBus } from '../system/sse.js'

function subjectFromParams(params: Record<string, string>) {
  return RatingSubjectSchema.safeParse({ type: params.type, id: Number(params.id) })
}

function sendError(res: Response, error: unknown): void {
  const status = Number((error as any)?.status) || (error instanceof RangeError ? 400 : 500)
  res.status(status).json({ error: status >= 500 ? 'Rating request failed' : error instanceof Error ? error.message : 'Rating request failed' })
}

export function createRatingsRouter(): Router {
  const router = Router()
  const writeLimit = rateLimit(30, 60_000)

  router.get('/unrated', validateQuery(UnratedQueueQuerySchema), (_req, res) => {
    const query = validatedQuery<UnratedQueueQuery>(res)
    try { res.json({ items: listUnratedQueue(query.profile, query.lookbackDays, query.limit) }) }
    catch (error) { sendError(res, error) }
  })

  router.post('/unrated/:type/:id/dismiss', writeLimit, validateBody(DismissRatingRequestSchema), (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject.success) return res.status(400).json({ error: 'Invalid rating subject' })
    try {
      dismissUnrated(req.body.profileId, subject.data.type, subject.data.id)
      getSseBus().emit('ratings:changed', { action: 'dismissed', profileId: req.body.profileId, subject: subject.data })
      res.status(204).send()
    } catch (error) { sendError(res, error) }
  })

  router.get('/series/:id/tree', validateQuery(RatingProfileQuerySchema), (req, res) => {
    const seriesId = Number(req.params.id)
    if (!Number.isInteger(seriesId) || seriesId < 1) return res.status(400).json({ error: 'Invalid series id' })
    try { res.json(resolveSeriesRatingTree(validatedQuery<RatingProfileQuery>(res).profile, seriesId)) }
    catch (error) { sendError(res, error) }
  })

  router.get('/:type/:id', validateQuery(RatingProfileQuerySchema), (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject.success) return res.status(400).json({ error: 'Invalid rating subject' })
    try { res.json(resolveRating(validatedQuery<RatingProfileQuery>(res).profile, subject.data.type, subject.data.id)) }
    catch (error) { sendError(res, error) }
  })

  router.put('/:type/:id', writeLimit, validateBody(SetRatingRequestSchema), (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject.success) return res.status(400).json({ error: 'Invalid rating subject' })
    try {
      const rating = setRating(req.body.profileId, subject.data.type, subject.data.id, req.body.value)
      getSseBus().emit('ratings:changed', { action: 'set', profileId: req.body.profileId, subject: subject.data, rating })
      res.json(rating)
    } catch (error) { sendError(res, error) }
  })

  router.delete('/:type/:id', writeLimit, validateQuery(RatingProfileQuerySchema), (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject.success) return res.status(400).json({ error: 'Invalid rating subject' })
    const profileId = validatedQuery<RatingProfileQuery>(res).profile
    try {
      const rating = clearRating(profileId, subject.data.type, subject.data.id)
      getSseBus().emit('ratings:changed', { action: 'cleared', profileId, subject: subject.data, rating })
      res.json(rating)
    } catch (error) { sendError(res, error) }
  })

  return router
}
