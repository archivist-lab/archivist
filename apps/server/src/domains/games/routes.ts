import { Router } from 'express'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureGameFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { searchGames, getGame, getGameImages } from './igdb.js'
import { saveEntityImage } from '../../shared/image-save.js'
import { d } from './serialize.js'

const logger = createLogger('Games')

export function createGamesRouter(): Router {
  const router = Router()
  router.use('/games', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))

  registerAcquisitionControls(router, {
    basePath: '/games',
    idParam: 'id',
    mediaType: 'games',
    subjectType: 'game',
    table: 'games',
    selectSql: 'SELECT * FROM games WHERE id = ? AND library_id = ?',
    title: row => row.title,
    deserialise: d,
  })

  // ── Library ───────────────────────────────────────────────────────────────

  router.get('/games', (req, res) => {
    try {
      res.json((db.prepare('SELECT * FROM games WHERE library_id = ? ORDER BY sort_title ASC').all(libId(req)) as Record<string, unknown>[]).map(d))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // Registered before /games/:id — the param route would swallow "lookup"
  // (latent legacy ordering bug; the lookup path is a documented UI contract).
  router.get('/games/lookup', async (req, res) => {
    const { q, platformId } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })
    try {
      const results = await searchGames(String(q), platformId ? parseInt(String(platformId)) : undefined)
      const games = results.map(g => ({
        ...g,
        alreadyAdded: !!db.prepare('SELECT id FROM games WHERE library_id = ? AND igdb_id = ?').get(libId(req), g.igdbId),
      }))
      res.json(games)
    } catch (err) {
      logger.warn('IGDB lookup failed:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: err instanceof Error ? err.message : 'IGDB lookup failed' })
    }
  })

  router.get('/games/:id', (req, res) => {
    try {
      const game = db.prepare('SELECT * FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!game) return res.status(404).json({ error: 'Not found' })
      res.json(d(game))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/games', validateBody(domains.AddGame), async (req, res) => {
    try {
      const { igdbId, monitored = true, rootFolderPath, platforms: selectedPlatforms } = req.body
      void rootFolderPath

      const game = await getGame(parseInt(igdbId, 10))
      const finalPlatforms = (selectedPlatforms && selectedPlatforms.length > 0)
        ? selectedPlatforms
        : game.platforms

      const { targetDir: gameDir, posterPath: localPoster, backdropPath: localBackdrop } = await ensureGameFolder(game, resolveLibraryRoot(db, libId(req)))

      const sortTitle = game.title.replace(/^(The|A|An)\s+/i, '').toLowerCase()

      const existing = db.prepare('SELECT id, platforms FROM games WHERE library_id = ? AND igdb_id = ?').get(libId(req), igdbId) as any
      if (existing) {
        const currentPlatforms = JSON.parse(existing.platforms || '[]')
        const merged = Array.from(new Set([...currentPlatforms, ...finalPlatforms]))
        db.prepare('UPDATE games SET platforms = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(merged), existing.id)
        return res.json(d(db.prepare('SELECT * FROM games WHERE id = ?').get(existing.id) as Record<string, unknown>))
      }

      const result = db.prepare(`INSERT INTO games (library_id, igdb_id, title, sort_title, year, release_date, overview, genres, platforms,
        cover_url, screenshot_url, rating, developer, publisher, monitored, root_folder_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        libId(req), game.igdbId, game.title, sortTitle, game.year ?? null, game.releaseDate ?? null, game.overview ?? null,
        JSON.stringify(game.genres), JSON.stringify(finalPlatforms),
        localPoster ?? game.coverUrl ?? null, localBackdrop ?? game.screenshotUrl ?? null, game.rating ?? null,
        game.developer ?? null, game.publisher ?? null, monitored ? 1 : 0, gameDir)
      res.status(201).json(d(db.prepare('SELECT * FROM games WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>))
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/games/:id', validateBody(domains.UpdateGame), (req, res) => {
    try {
      const { monitored, status, upgrade_allowed, target_tier } = req.body
      db.prepare(`UPDATE games SET monitored = COALESCE(@monitored, monitored), status = COALESCE(@status, status), upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed), target_tier = COALESCE(@targetTier, target_tier), updated_at = datetime('now') WHERE id = @id AND library_id = @libraryId`)
        .run({ id: req.params.id, libraryId: libId(req), monitored: monitored !== undefined ? (monitored ? 1 : 0) : null, status: status ?? null, upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null, targetTier: target_tier ?? null })
      const updated = db.prepare('SELECT * FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!updated) return res.status(404).json({ error: 'Not found' })
      res.json(d(updated))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/games/:id/metadata', (req, res) => {
    try {
      const { title, year, release_date, overview, developer, publisher, rating, genres, platforms } = req.body
      const row = db.prepare('SELECT * FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      const sortTitle = title ? title.replace(/^(The|A|An)\s+/i, '').toLowerCase() : null
      db.prepare(`
        UPDATE games SET
          title = COALESCE(@title, title),
          sort_title = COALESCE(@sortTitle, sort_title),
          year = COALESCE(@year, year),
          release_date = COALESCE(@release_date, release_date),
          overview = COALESCE(@overview, overview),
          developer = COALESCE(@developer, developer),
          publisher = COALESCE(@publisher, publisher),
          rating = COALESCE(@rating, rating),
          genres = COALESCE(@genres, genres),
          platforms = COALESCE(@platforms, platforms),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: row.id,
        title: title ?? null,
        sortTitle,
        year: year ?? null,
        release_date: release_date ?? null,
        overview: overview ?? null,
        developer: developer ?? null,
        publisher: publisher ?? null,
        rating: rating ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
        platforms: platforms ? (typeof platforms === 'string' ? platforms : JSON.stringify(platforms)) : null,
      })

      const updated = d(db.prepare('SELECT * FROM games WHERE id = ?').get(row.id) as Record<string, unknown>) as any

      if (updated.root_folder_path && existsSync(updated.root_folder_path)) {
        try {
          const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<game>\n  <title>${updated.title}</title>\n  <year>${updated.year || ''}</year>\n  <plot>${updated.overview || ''}</plot>\n  <genre>${(updated.genres || []).join(' / ')}</genre>\n  <platform>${(updated.platforms || []).join(' / ')}</platform>\n  <developer>${updated.developer || ''}</developer>\n  <publisher>${updated.publisher || ''}</publisher>\n  <rating>${updated.rating || ''}</rating>\n  <uniqueid type="igdb">${updated.igdb_id || ''}</uniqueid>\n</game>`
          writeFileSync(join(updated.root_folder_path, 'game.nfo'), nfo)
        } catch (nfoErr) {
          logger.warn(`Failed to write game.nfo: ${nfoErr instanceof Error ? nfoErr.message : String(nfoErr)}`)
        }
      }

      res.json(updated)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/games/:id/images', async (req, res) => {
    try {
      const { type } = req.query as { type?: string }
      const row = db.prepare('SELECT * FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      const results: Array<{ url: string; source: string; type: string; language: string }> = []

      if (row.igdb_id) {
        try {
          const images = await getGameImages(row.igdb_id)
          const wanted = type || 'cover'
          if (wanted === 'cover') {
            if (images.cover) results.push({ url: images.cover, source: 'IGDB', type: 'cover', language: 'null' })
            for (const a of images.artworks.slice(0, 10)) results.push({ url: a, source: 'IGDB', type: 'cover', language: 'null' })
          } else {
            for (const s of images.screenshots.slice(0, 15)) results.push({ url: s, source: 'IGDB', type: 'screenshot', language: 'null' })
            for (const a of images.artworks.slice(0, 10)) results.push({ url: a, source: 'IGDB', type: 'screenshot', language: 'null' })
          }
        } catch (err) {
          logger.warn(`IGDB image lookup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/games/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const row = db.prepare('SELECT * FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })

      const fileMap: Record<string, string> = { cover: 'cover.jpg', screenshot: 'screenshot.jpg' }
      const dbCol: Record<string, string> = { cover: 'cover_url', screenshot: 'screenshot_url' }
      if (!fileMap[type]) return res.status(400).json({ error: `Unknown image type: ${type}` })

      const saved = await saveEntityImage(row.root_folder_path, fileMap[type], url)
      db.prepare(`UPDATE games SET ${dbCol[type]} = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, row.id)
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.delete('/games/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const row = db.prepare('SELECT root_folder_path, file_path FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (row && deleteFiles && !safeDeleteMediaPath(row.root_folder_path)) safeDeleteMediaPath(row.file_path)
      db.prepare('DELETE FROM games WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Automation ────────────────────────────────────────────────────────────

  router.post('/games/:id/auto-grab', async (req, res) => {
    try {
      const game = db.prepare('SELECT * FROM games WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!game) return res.status(404).json({ error: 'Game not found' })

      const query = game.title
      logger.info(`Auto-grabbing game: ${query}`)

      const enabledIndexers = getEnabledIndexerInstances()
      const results = await searchViaIndexers(enabledIndexers, query, { categories: [1000], type: 'search', module: 'games' })

      if (results.length === 0) {
        return res.json({ success: false, message: 'No releases found' })
      }

      const sorted = results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      const best = sorted[0]

      const client = clientsFor(req).getEnabled()[0]
      if (!client) return res.status(400).json({ error: 'No download client enabled' })

      const result = await sendToDownloadClient(client, best.downloadUrl, 'archivist-games')
      db.prepare("UPDATE games SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, game.id)

      res.json({ success: true, message: `Started downloading: ${best.title}` })
    } catch (err) {
      logger.error('Game auto-grab failed:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/games/download', validateBody(domains.DownloadGames.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, gameId } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      try {
        const result = await sendToDownloadClient(client, downloadUrl, 'archivist-games')
        if (result.success && gameId) {
          db.prepare("UPDATE games SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, gameId)
        }
        res.json(result)
      } catch (err) {
        res.status(500).json({ success: false, message: String(err) })
      }
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/games/refresh', (req, res) => {
    try {
      const gamesList = db.prepare('SELECT id, igdb_id, title FROM games WHERE library_id = ?').all(libId(req)) as Array<{ id: number; igdb_id: number; title: string }>
      logger.info(`Starting refresh for ${gamesList.length} games...`)
      res.json({ success: true, message: `Refresh started for ${gamesList.length} games in background.` })

      ;(async () => {
        for (const gameEntry of gamesList) {
          try {
            const game = await getGame(gameEntry.igdb_id)
            const { posterPath: localPoster, backdropPath: localBackdrop } = await ensureGameFolder(game, resolveLibraryRoot(db, libId(req)))

            db.prepare(`UPDATE games SET
              release_date = ?,
              year = ?,
              overview = ?,
              genres = ?,
              platforms = ?,
              cover_url = COALESCE(?, cover_url),
              screenshot_url = COALESCE(?, screenshot_url),
              rating = ?,
              developer = ?,
              publisher = ?,
              updated_at = datetime('now')
              WHERE id = ?`)
              .run(
                game.releaseDate ?? null,
                game.year ?? null,
                game.overview ?? null,
                JSON.stringify(game.genres),
                JSON.stringify(game.platforms),
                localPoster ?? game.coverUrl ?? null,
                localBackdrop ?? game.screenshotUrl ?? null,
                game.rating ?? null,
                game.developer ?? null,
                game.publisher ?? null,
                gameEntry.id,
              )
          } catch (err) {
            logger.warn(`Failed to refresh game id=${gameEntry.id}:`, err)
          }
        }
        logger.info('Games refresh complete.')
      })().catch(err => logger.error('Background games refresh error:', err))
    } catch (err) {
      res.status(500).json({ error: 'Failed to start refresh' })
    }
  })

  return router
}
