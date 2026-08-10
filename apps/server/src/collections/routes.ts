import { raw, Router } from 'express'
import {
  COLLECTION_ENTITY_TYPES, addCollectionItem, createCollection, deleteCollection, getCollection,
  listCollections, removeCollectionItem, reorderCollectionItems, searchCollectionCandidates, updateCollection,
  type CollectionEntityType,
} from './service.js'
import {
  COLLECTION_ARTWORK_TYPES, removeCollectionArtworkDirectory, removeManagedCollectionArtwork,
  saveCollectionArtwork, type CollectionArtworkType,
} from './artwork.js'

function id(value: string): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function fail(res: any, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  res.status(/UNIQUE constraint failed: collections\.name/i.test(message) ? 409 : 400).json({ error: /UNIQUE/.test(message) ? 'A collection with this name already exists' : message })
}

export function createCollectionsRouter(mediaRoot = process.env.ARCHIVIST_MEDIA_BASE ?? './media'): Router {
  const router = Router()
  router.get('/', (_req, res) => res.json({ collections: listCollections() }))
  router.get('/candidates', (req, res) => res.json({ results: searchCollectionCandidates(String(req.query.q ?? ''), typeof req.query.mediaType === 'string' ? req.query.mediaType : undefined) }))
  router.post('/', (req, res) => { try { res.status(201).json({ collection: createCollection(req.body ?? {}) }) } catch (error) { fail(res, error) } })
  router.get('/:id', (req, res) => {
    const collectionId = id(req.params.id); const collection = collectionId ? getCollection(collectionId) : null
    if (!collection) return res.status(404).json({ error: 'Collection not found' }); res.json({ collection })
  })
  router.patch('/:id', async (req, res) => { try {
    const collectionId = id(req.params.id)
    if (!collectionId) return res.status(404).json({ error: 'Collection not found' })
    const existing = getCollection(collectionId)
    const collection = updateCollection(collectionId, req.body ?? {})
    if (!collection || !existing) return res.status(404).json({ error: 'Collection not found' })
    for (const field of ['posterUrl', 'backdropUrl', 'logoUrl'] as const) {
      if (Object.prototype.hasOwnProperty.call(req.body ?? {}, field) && collection[field] !== existing[field]) {
        await removeManagedCollectionArtwork(mediaRoot, collectionId, existing[field]).catch(() => undefined)
      }
    }
    return res.json({ collection })
  } catch (error) { return fail(res, error) } })
  router.post('/:id/artwork/:type', raw({ type: () => true, limit: '15mb' }), async (req, res) => {
    const collectionId = id(req.params.id)
    const artworkType = req.params.type as CollectionArtworkType
    const existing = collectionId ? getCollection(collectionId) : null
    if (!collectionId || !existing) return res.status(404).json({ error: 'Collection not found' })
    if (!COLLECTION_ARTWORK_TYPES.includes(artworkType)) return res.status(400).json({ error: 'Artwork type must be poster, backdrop or logo' })
    const mimeType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'An image file is required' })
    const field = `${artworkType}Url` as 'posterUrl' | 'backdropUrl' | 'logoUrl'
    let url: string | null = null
    try {
      url = await saveCollectionArtwork(mediaRoot, collectionId, artworkType, mimeType, req.body)
      const collection = updateCollection(collectionId, { [field]: url })!
      await removeManagedCollectionArtwork(mediaRoot, collectionId, existing[field]).catch(() => undefined)
      return res.json({ collection })
    } catch (error) {
      if (url) await removeManagedCollectionArtwork(mediaRoot, collectionId, url).catch(() => undefined)
      return fail(res, error)
    }
  })
  router.delete('/:id', async (req, res) => {
    const collectionId = id(req.params.id)
    if (!collectionId || !deleteCollection(collectionId)) return res.status(404).json({ error: 'Collection not found' })
    await removeCollectionArtworkDirectory(mediaRoot, collectionId).catch(() => undefined)
    return res.status(204).end()
  })
  router.post('/:id/items', (req, res) => { try {
    const collectionId = id(req.params.id); const itemId = id(String(req.body?.itemId)); const libraryId = id(String(req.body?.libraryId)); const entityType = req.body?.entityType as CollectionEntityType
    if (!collectionId || !itemId || !libraryId || !COLLECTION_ENTITY_TYPES.includes(entityType)) return res.status(400).json({ error: 'entityType, itemId and libraryId are required' })
    const collection = addCollectionItem(collectionId, entityType, itemId, libraryId)
    if (!collection) return res.status(404).json({ error: 'Collection not found' }); res.json({ collection })
  } catch (error) { fail(res, error) } })
  router.delete('/:id/items/:membershipId', (req, res) => {
    const collectionId = id(req.params.id); const membershipId = id(req.params.membershipId)
    const collection = collectionId && membershipId ? removeCollectionItem(collectionId, membershipId) : null
    if (!collection) return res.status(404).json({ error: 'Collection item not found' }); res.json({ collection })
  })
  router.put('/:id/items/order', (req, res) => { try {
    const collectionId = id(req.params.id); const ids = Array.isArray(req.body?.membershipIds) ? req.body.membershipIds.map(Number) : []
    if (!collectionId || ids.some((value: number) => !Number.isSafeInteger(value) || value <= 0)) return res.status(400).json({ error: 'A valid membershipIds array is required' })
    res.json({ collection: reorderCollectionItems(collectionId, ids) })
  } catch (error) { fail(res, error) } })
  return router
}
