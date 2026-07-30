import { Router } from 'express'
import {
  ListAddQuality, ListBulkActionRequest, ListCreateRequest, ListItemsQuery, ListPatchRequest, ListPreviewRequest,
  type ListItemsQuery as ListItemsQueryType,
} from '@archivist/contracts'
import { requireLibrary } from '../middleware/library-context.js'
import { validateBody, validateQuery, validatedQuery } from '../middleware/validate.js'
import { cancelSubjectJobs } from '../system/event-store.js'
import { activeListCompiler } from './compilers/index.js'
import { queueListRefresh } from './engine.js'
import {
  addListItem, createList, deleteList, dismissListItem, getListDetail, listListItems, listLists,
  listRuns, pendingListCount, previewList, updateList,
} from './service.js'
import { UnsupportedListFilterError } from './types.js'
import { lookupListEntities } from './lookup.js'

function positiveId(raw: string): number | null {
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function errorResponse(res: any, error: unknown): void {
  if (error instanceof UnsupportedListFilterError) {
    res.status(422).json({ error: error.message, unsupported: error.unsupported })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  const conflict = /UNIQUE constraint failed: lists\.library_id, lists\.name/i.test(message)
  const unavailable = /Auto-add is not enabled/i.test(message)
  res.status(conflict ? 409 : unavailable ? 409 : 400).json({ error: conflict ? 'A List with this name already exists in the library' : message })
}

export function createListsRouter(): Router {
  const router = Router()

  // The dashboard badge intentionally spans libraries.
  router.get('/pending-count', (_req, res) => res.json({ count: pendingListCount() }))
  router.get('/capabilities', (_req, res) => {
    const compiler = activeListCompiler()
    const operations = ['and', 'or', 'not', 'genre', 'year', 'rating', 'runtime', 'language', 'certification', 'keyword', 'title', 'person', 'company', 'watchProvider'] as const
    res.json({ compiler: compiler.id, operations: Object.fromEntries(operations.map(op => [op, compiler.supports(op)])), ratingSources: ['provider'], autoAddEnabled: false })
  })

  router.get('/lookup', async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : ''
    const mediaType = typeof req.query.mediaType === 'string' ? req.query.mediaType : ''
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (!['person', 'company', 'title'].includes(kind) || !['film', 'series'].includes(mediaType) || !query) {
      return res.status(400).json({ error: 'kind, mediaType and q are required' })
    }
    try {
      res.json({ results: await lookupListEntities(kind as 'person' | 'company' | 'title', mediaType as 'film' | 'series', query) })
    } catch (error) {
      errorResponse(res, error)
    }
  })

  router.use(requireLibrary)

  router.get('/', (req, res) => res.json({ lists: listLists(req.library!.id) }))

  router.post('/preview', validateBody(ListPreviewRequest), async (req, res) => {
    try {
      const result = await previewList(req.body.filter, req.body.mediaType, req.body.memberCap)
      res.json({
        matchCount: result.total,
        sample: result.members.slice(0, 20),
        capped: result.capped,
        ceilingHit: result.ceilingHit,
        warning: result.warning ?? null,
      })
    } catch (error) {
      errorResponse(res, error)
    }
  })

  router.post('/', validateBody(ListCreateRequest), (req, res) => {
    try {
      res.status(201).json({ list: createList(req.library!.id, req.body) })
    } catch (error) {
      errorResponse(res, error)
    }
  })

  router.get('/:id', (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    const list = getListDetail(id, req.library!.id)
    if (!list) return res.status(404).json({ error: 'List not found' })
    res.json({ list })
  })

  router.patch('/:id', validateBody(ListPatchRequest), (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    try {
      const list = updateList(id, req.library!.id, req.body)
      if (!list) return res.status(404).json({ error: 'List not found' })
      res.json({ list })
    } catch (error) {
      errorResponse(res, error)
    }
  })

  router.delete('/:id', (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    cancelSubjectJobs(['list.refresh'], 'list', id)
    if (!deleteList(id, req.library!.id)) return res.status(404).json({ error: 'List not found' })
    res.status(204).send()
  })

  router.post('/:id/refresh', (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    if (!getListDetail(id, req.library!.id)) return res.status(404).json({ error: 'List not found' })
    const jobId = queueListRefresh(id)
    res.status(jobId == null ? 200 : 202).json({ queued: jobId != null, jobId })
  })

  router.get('/:id/items', validateQuery(ListItemsQuery), (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    const result = listListItems(id, req.library!.id, validatedQuery<ListItemsQueryType>(res))
    if (!result) return res.status(404).json({ error: 'List not found' })
    res.json(result)
  })

  router.get('/:id/runs', (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    const runs = listRuns(id, req.library!.id)
    if (!runs) return res.status(404).json({ error: 'List not found' })
    res.json({ runs })
  })

  router.post('/:id/items/:itemId/add', async (req, res) => {
    const id = positiveId(req.params.id)
    const itemId = positiveId(req.params.itemId)
    if (!id || !itemId) return res.status(400).json({ error: 'Invalid List or item id' })
    try {
      const quality = ListAddQuality.parse(req.body ?? {})
      const item = await addListItem(id, itemId, req.library!.id, quality)
      if (!item) return res.status(404).json({ error: 'List item not found' })
      res.json({ item })
    } catch (error) {
      errorResponse(res, error)
    }
  })

  router.post('/:id/items/:itemId/dismiss', (req, res) => {
    const id = positiveId(req.params.id)
    const itemId = positiveId(req.params.itemId)
    if (!id || !itemId) return res.status(400).json({ error: 'Invalid List or item id' })
    const item = dismissListItem(id, itemId, req.library!.id)
    if (!item) return res.status(404).json({ error: 'List item not found' })
    res.json({ item })
  })

  router.post('/:id/items/bulk', validateBody(ListBulkActionRequest), async (req, res) => {
    const id = positiveId(req.params.id)
    if (!id) return res.status(400).json({ error: 'Invalid List id' })
    if (!getListDetail(id, req.library!.id)) return res.status(404).json({ error: 'List not found' })
    const updated = []
    try {
      for (const itemId of req.body.itemIds) {
        const item = req.body.action === 'add'
          ? await addListItem(id, itemId, req.library!.id, req.body.quality)
          : dismissListItem(id, itemId, req.library!.id)
        if (item) updated.push(item)
      }
      res.json({ updated })
    } catch (error) {
      errorResponse(res, error)
    }
  })

  return router
}
