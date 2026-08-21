import { Router } from 'express'
import { z } from 'zod'
import { requireLibrary } from '../middleware/library-context.js'
import { validateBody } from '../middleware/validate.js'
import {
  cancelItemSearch,
  enqueueItemSearch,
  getItemSearch,
  getLatestItemSearch,
  type ItemSearchMediaType,
  type ItemSearchSubjectType,
} from '../services/item-searches.js'

const enqueueSchema = z.object({
  mediaType: z.enum(['films', 'series']),
  subjectType: z.enum(['film', 'series', 'season', 'episode']),
  subjectId: z.coerce.number().int().positive(),
  mode: z.enum(['quick', 'deep', 'auto', 'auto-episodes']),
  options: z.object({
    tier: z.string().max(100).optional(),
    resolution: z.string().max(100).optional(),
    source: z.string().max(100).optional(),
    codec: z.string().max(100).optional(),
  }).optional(),
})

export function createItemSearchesRouter(): Router {
  const router = Router()
  router.use(requireLibrary)

  router.post('/', validateBody(enqueueSchema), (req, res) => {
    try {
      const search = enqueueItemSearch({ ...req.body, libraryId: req.library!.id })
      res.status(search.status === 'queued' ? 202 : 200).json({ search })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.get('/latest', (req, res) => {
    const mediaType = String(req.query.mediaType ?? '') as ItemSearchMediaType
    const subjectType = String(req.query.subjectType ?? '') as ItemSearchSubjectType
    const subjectId = Number(req.query.subjectId)
    if (!['films', 'series'].includes(mediaType) || !['film', 'series', 'season', 'episode'].includes(subjectType) || !Number.isInteger(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'mediaType, subjectType and subjectId are required' })
    }
    res.json({ search: getLatestItemSearch({ libraryId: req.library!.id, mediaType, subjectType, subjectId }) })
  })

  router.get('/:id', (req, res) => {
    const search = getItemSearch(Number(req.params.id), req.library!.id)
    if (!search) return res.status(404).json({ error: 'Search not found or expired' })
    res.json({ search })
  })

  router.delete('/:id', (req, res) => {
    const search = cancelItemSearch(Number(req.params.id), req.library!.id)
    if (!search) return res.status(404).json({ error: 'Search not found' })
    res.json({ search })
  })

  return router
}
