import { Router } from 'express'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createLogger } from '@archivist/core'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureGameFolder } from '../../shared/media-organizer.js'
import { preserveArtworkVersion, resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { evaluateRelease, markDecisionGrabbed, recordReleaseDecision, type DecisionContext } from '../../services/acquisition-decisions.js'
import { searchGames, getGame, getGameImages } from './igdb.js'
import { launchBoxArtwork, launchBoxIdFor, libraryGameFor, searchLaunchBoxGames } from './launchbox-games.js'
import { registerPlatformRoutes } from './platforms.js'
import { consoleMediaDirFor } from '../../player/arcade.js'
import { cachedImageSweep, imageCandidatePage, saveEntityImage, type ImageCandidate } from '../../shared/image-save.js'
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
    const platform = platformId ? parseInt(String(platformId)) : undefined
    // LaunchBox first — it knows the older games IGDB does not — then IGDB,
    // when it is set up. Either failing leaves the other's results standing.
    const inLibraryByLaunchBox = db.prepare('SELECT id FROM games WHERE library_id = ? AND launchbox_id = ?')
    const inLibraryByIgdb = db.prepare('SELECT id FROM games WHERE library_id = ? AND igdb_id = ?')
    let launchBox: any[] = []
    try {
      launchBox = searchLaunchBoxGames(String(q), platform)
        .map(g => ({ ...g, alreadyAdded: !!inLibraryByLaunchBox.get(libId(req), g.launchboxId) }))
    } catch (err) {
      logger.warn('LaunchBox lookup failed:', err instanceof Error ? err.message : String(err))
    }
    let igdb: any[] = []
    let igdbError: string | null = null
    if (process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET) {
      try {
        igdb = (await searchGames(String(q), platform)).map(g => ({
          ...g, key: `igdb:${g.igdbId}`, source: 'IGDB',
          alreadyAdded: !!inLibraryByIgdb.get(libId(req), g.igdbId),
        }))
      } catch (err) {
        igdbError = err instanceof Error ? err.message : 'IGDB lookup failed'
        logger.warn('IGDB lookup failed:', igdbError)
      }
    }
    if (!launchBox.length && !igdb.length && igdbError) return res.status(500).json({ error: igdbError })
    res.json([...launchBox, ...igdb])
  })

  // Before /games/:id, which would otherwise take "platforms" for an id.
  registerPlatformRoutes(router, db, libId)

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
      const { igdbId, launchboxId, monitored = true, rootFolderPath, platforms: selectedPlatforms } = req.body
      void rootFolderPath

      const launchBoxId = launchboxId ? parseInt(launchboxId, 10) : null
      const game = launchBoxId ? libraryGameFor(launchBoxId) : await getGame(parseInt(igdbId, 10))
      if (!game) return res.status(404).json({ error: `LaunchBox has no game ${launchboxId}; its copy may still be downloading` })
      const finalPlatforms = (selectedPlatforms && selectedPlatforms.length > 0)
        ? selectedPlatforms
        : game.platforms

      const { targetDir: gameDir, posterPath: localPoster, backdropPath: localBackdrop } = await ensureGameFolder(game, resolveLibraryRoot(db, libId(req)))

      const sortTitle = game.title.replace(/^(The|A|An)\s+/i, '').toLowerCase()

      const existing = (launchBoxId
        ? db.prepare('SELECT id, platforms FROM games WHERE library_id = ? AND launchbox_id = ?').get(libId(req), launchBoxId)
        : db.prepare('SELECT id, platforms FROM games WHERE library_id = ? AND igdb_id = ?').get(libId(req), igdbId)) as any
      if (existing) {
        const currentPlatforms = JSON.parse(existing.platforms || '[]')
        const merged = Array.from(new Set([...currentPlatforms, ...finalPlatforms]))
        db.prepare('UPDATE games SET platforms = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(merged), existing.id)
        return res.json(d(db.prepare('SELECT * FROM games WHERE id = ?').get(existing.id) as Record<string, unknown>))
      }

      const result = db.prepare(`INSERT INTO games (library_id, igdb_id, launchbox_id, title, sort_title, year, release_date, overview, genres, platforms,
        cover_url, screenshot_url, rating, developer, publisher, monitored, root_folder_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        libId(req), launchBoxId ? null : game.igdbId, launchBoxId, game.title, sortTitle, game.year ?? null, game.releaseDate ?? null, game.overview ?? null,
        JSON.stringify(game.genres), JSON.stringify(finalPlatforms),
        localPoster ?? game.coverUrl ?? null, localBackdrop ?? game.screenshotUrl ?? null, game.rating ?? null,
        game.developer ?? null, game.publisher ?? null, monitored ? 1 : 0, gameDir)
      const logo = (game as { logoUrl?: string }).logoUrl
      if (logo) {
        // LaunchBox has a clear logo where IGDB has none; kept beside the cover.
        const saved = await saveEntityImage(gameDir, 'logo.png', logo).catch(() => ({ path: logo }))
        db.prepare('UPDATE games SET logo_url = ? WHERE id = ?').run(saved.path, result.lastInsertRowid)
      }
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
          -- Edited by hand: the ROM sync no longer overwrites it.
          metadata_locked = 1,
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
      const wanted = type || 'cover'

      const sweep = await cachedImageSweep<ImageCandidate>(`game:${row.id}:${wanted}`, async () => {
        const results: ImageCandidate[] = []
        const warnings: string[] = []
        try {
          const launchBoxId = launchBoxIdFor(row)
          if (launchBoxId) results.push(...launchBoxArtwork(launchBoxId, wanted))
          // IGDB has no clear logos: LaunchBox is the only source of one.
          if (wanted === 'logo') {
            if (!results.length) warnings.push('LaunchBox has no clear logo for this game — paste a URL instead')
            return { items: results, warnings }
          }
        } catch (err) {
          warnings.push(`LaunchBox artwork lookup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!row.igdb_id) {
          if (!results.length) warnings.push('Neither LaunchBox nor IGDB has artwork for this game')
          return { items: results, warnings }
        }
        try {
          const images = await getGameImages(row.igdb_id)
          if (wanted === 'cover' && images.cover) results.push({ url: images.cover, source: 'IGDB', type: wanted, language: 'null' })
          if (wanted !== 'cover') {
            for (const shot of images.screenshots) results.push({ url: shot, source: 'IGDB', type: wanted, language: 'null' })
          }
          for (const art of images.artworks) results.push({ url: art, source: 'IGDB', type: wanted, language: 'null' })
        } catch (err) {
          logger.warn(`IGDB image lookup failed: ${err instanceof Error ? err.message : String(err)}`)
          warnings.push(`IGDB image lookup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!results.length && !warnings.length) warnings.push(`IGDB has no ${wanted} art for this game`)
        return { items: results, warnings }
      })

      res.json(imageCandidatePage(sweep.items, req.query, sweep.warnings))
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

      const fileMap: Record<string, string> = { cover: 'cover.jpg', screenshot: 'screenshot.jpg', logo: 'logo.png' }
      const dbCol: Record<string, string> = { cover: 'cover_url', screenshot: 'screenshot_url', logo: 'logo_url' }
      if (!fileMap[type]) return res.status(400).json({ error: `Unknown image type: ${type}` })

      // A ROM shares its folder with the rest of its system's ROMs, so its
      // artwork is named after it, in the console's media/ beside the scraper's, not cover.jpg for all.
      const [folder, file] = row.source === 'rom' && row.file_path
        ? [join(consoleMediaDirFor(row.file_path), 'library'), `${basename(row.file_path).replace(/\.[^.]+$/, '')}.${fileMap[type]}`]
        : [row.root_folder_path, fileMap[type]]
      const saved = await saveEntityImage(folder, file, url)
      // A picked image is a choice the ROM sync then leaves alone, as it does edited details.
      db.prepare(`UPDATE games SET ${dbCol[type]} = ?, metadata_locked = 1, updated_at = datetime('now') WHERE id = ?`).run(saved.path, row.id)
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

      const sorted = results.sort((a, b) => ((a.indexerPriority ?? 25) - (b.indexerPriority ?? 25)) || ((b.seeders || 0) - (a.seeders || 0)))
      const best = sorted[0]

      const client = clientsFor(req).getEnabled()[0]
      if (!client) return res.status(400).json({ error: 'No download client enabled' })

      const ctx: DecisionContext = {
        source: 'manual',
        scanMode: 'auto',
        tabId: libId(req),
        tabName: req.library?.name,
        mediaType: 'games',
        subjectType: 'game',
        subjectId: game.id,
        subjectTitle: game.title,
      }
      const decision = evaluateRelease(ctx, best)
      const decisionId = recordReleaseDecision(ctx, { ...decision, accepted: true, rejectionReasons: [] })
      const result = await sendToDownloadClient(client, best.downloadUrl, 'archivist-games')
      markDecisionGrabbed(decisionId, result)
      db.prepare("UPDATE games SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, game.id)

      res.json({ success: true, message: `Started downloading: ${best.title}` })
    } catch (err) {
      logger.error('Game auto-grab failed:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/games/download', validateBody(domains.DownloadGames.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, gameId, scanMode, releaseTitle, releaseGuid, indexerName, size, seeders, leechers, publishDate } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      const game = gameId ? db.prepare('SELECT title FROM games WHERE id = ? AND library_id = ?').get(gameId, libId(req)) as { title: string } | undefined : undefined
      const ctx: DecisionContext = {
        source: 'manual',
        scanMode: scanMode ?? 'deep',
        tabId: libId(req),
        tabName: req.library?.name,
        mediaType: 'games',
        subjectType: 'game',
        subjectId: gameId,
        subjectTitle: game?.title ?? releaseTitle ?? downloadUrl,
      }
      const release = { title: releaseTitle ?? downloadUrl, downloadUrl, guid: releaseGuid, indexerName, size, seeders, leechers, publishDate }
      const decision = evaluateRelease(ctx, release)
      const decisionId = recordReleaseDecision(ctx, { ...decision, accepted: true, rejectionReasons: [] })

      try {
        const result = await sendToDownloadClient(client, downloadUrl, 'archivist-games')
        markDecisionGrabbed(decisionId, result)
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
      // ROMs are kept up to date by the ROM sync, and an edited game is left as edited.
      const gamesList = db.prepare(`SELECT id, igdb_id, launchbox_id, title, cover_url, screenshot_url FROM games
        WHERE library_id = ? AND COALESCE(source, '') <> 'rom' AND metadata_locked = 0 AND (igdb_id IS NOT NULL OR launchbox_id IS NOT NULL)`)
        .all(libId(req)) as Array<{ id: number; igdb_id: number | null; launchbox_id: number | null; title: string; cover_url: string | null; screenshot_url: string | null }>
      logger.info(`Starting refresh for ${gamesList.length} games...`)
      res.json({ success: true, message: `Refresh started for ${gamesList.length} games in background.` })

      ;(async () => {
        for (const gameEntry of gamesList) {
          try {
            const game = gameEntry.launchbox_id ? libraryGameFor(gameEntry.launchbox_id) : await getGame(gameEntry.igdb_id!)
            if (!game) continue
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
                preserveArtworkVersion(gameEntry.cover_url, localPoster) ?? game.coverUrl ?? null,
                preserveArtworkVersion(gameEntry.screenshot_url, localBackdrop) ?? game.screenshotUrl ?? null,
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
    } catch (_err) {
      res.status(500).json({ error: 'Failed to start refresh' })
    }
  })

  return router
}
