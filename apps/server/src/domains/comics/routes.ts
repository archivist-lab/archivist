import { Router } from 'express'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureComicSeriesFolder, ensureComicIssueFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { listAcquisitionHistoryForSubjectIds } from '../../services/acquisition-decisions.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { searchComicSeries, getComicSeries, getComicIssues } from './comicvine.js'
import { saveEntityImage } from '../../shared/image-save.js'
import { d } from './serialize.js'

const logger = createLogger('Comics')

export function createComicsRouter(): Router {
  const router = Router()
  router.use('/comics', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))

  registerAcquisitionControls(router, {
    basePath: '/comics/issues',
    idParam: 'id',
    mediaType: 'comics',
    subjectType: 'issue',
    table: 'comic_issues',
    selectSql: `
      SELECT i.*, s.title as series_title
      FROM comic_issues i JOIN comic_series s ON i.series_id = s.id
      WHERE i.id = ? AND s.library_id = ?`,
    title: row => `${row.series_title} #${row.issue_number}${row.title ? ` - ${row.title}` : ''}`,
    deserialise: d,
  })

  // ── Automation ────────────────────────────────────────────────────────────

  router.post('/comics/issues/:id/auto-grab', async (req, res) => {
    try {
      const issue = db.prepare(`
        SELECT i.*, s.title as seriesTitle
        FROM comic_issues i JOIN comic_series s ON i.series_id = s.id
        WHERE i.id = ? AND s.library_id = ?`).get(req.params.id, libId(req)) as any
      if (!issue) return res.status(404).json({ error: 'Issue not found' })

      const query = `${issue.seriesTitle} ${issue.issue_number}`
      logger.info(`Auto-grabbing comic issue: ${query}`)

      const enabledIndexers = getEnabledIndexerInstances()
      const results = await searchViaIndexers(enabledIndexers, query, { categories: [7030], type: 'book', module: 'comics' })

      if (results.length === 0) {
        return res.json({ success: false, message: 'No releases found' })
      }

      const sorted = results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      const best = sorted[0]

      const client = clientsFor(req).getEnabled()[0]
      if (!client) return res.status(400).json({ error: 'No download client enabled' })

      const result = await sendToDownloadClient(client, best.downloadUrl, 'archivist-comics')
      db.prepare("UPDATE comic_issues SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, issue.id)

      res.json({ success: true, message: `Started downloading: ${best.title}` })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Library ───────────────────────────────────────────────────────────────

  router.get('/comics/series', (req, res) => {
    try {
      const series = db.prepare(`
        SELECT s.*, COUNT(i.id) as issue_count,
          SUM(CASE WHEN i.status IN ('collected', 'downloaded') THEN 1 ELSE 0 END) as downloaded_issues
        FROM comic_series s LEFT JOIN comic_issues i ON i.series_id = s.id
        WHERE s.library_id = ?
        GROUP BY s.id ORDER BY s.title ASC`).all(libId(req))
      res.json((series as Record<string, unknown>[]).map(d))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/comics/series/:id', (req, res) => {
    try {
      const series = db.prepare('SELECT * FROM comic_series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!series) return res.status(404).json({ error: 'Not found' })
      const issues = db.prepare('SELECT * FROM comic_issues WHERE series_id = ? ORDER BY CAST(issue_number AS FLOAT) ASC').all(series.id)
      res.json({ ...d(series), issues: (issues as Record<string, unknown>[]).map(d) })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/comics/series', validateBody(domains.AddComicSeries), async (req, res) => {
    try {
      const { cvId } = req.body
      if (db.prepare('SELECT id FROM comic_series WHERE library_id = ? AND comicvine_id = ?').get(libId(req), cvId)) {
        return res.status(409).json({ error: 'Series already in library' })
      }

      const cvSeries = await getComicSeries(cvId)
      const { targetDir: seriesDir, posterPath: localSeriesPoster } = await ensureComicSeriesFolder(cvSeries, resolveLibraryRoot(db, libId(req)))

      const result = db.prepare(`INSERT INTO comic_series (library_id, comicvine_id, title, sort_title, start_year, publisher, overview, image_url, monitored, root_folder_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
        libId(req), cvSeries.id, cvSeries.name, cvSeries.name.replace(/^(The|A|An)\s+/i, ''),
        cvSeries.startYear ?? null, cvSeries.publisher ?? null, cvSeries.overview ?? null,
        localSeriesPoster ?? cvSeries.coverUrl ?? null, seriesDir)
      const seriesId = result.lastInsertRowid as number

      const issues = await getComicIssues(cvId)
      for (const issue of issues) {
        const { posterPath: localIssuePoster } = await ensureComicIssueFolder(cvSeries, issue)

        db.prepare(`INSERT OR IGNORE INTO comic_issues (series_id, comicvine_id, title, issue_number, cover_date, overview, image_url, monitored, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'missing')`).run(
          seriesId, issue.id, issue.title ?? null, issue.issueNumber, issue.coverDate ?? null,
          issue.overview ?? null, localIssuePoster ?? issue.coverUrl ?? null)
      }

      const series = db.prepare('SELECT * FROM comic_series WHERE id = ?').get(seriesId)
      const insertedIssues = db.prepare('SELECT * FROM comic_issues WHERE series_id = ?').all(seriesId)
      res.status(201).json({ ...d(series as Record<string, unknown>), issues: (insertedIssues as Record<string, unknown>[]).map(d) })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/comics/series/:id/metadata', (req, res) => {
    try {
      const { title, start_year, publisher, overview, genres } = req.body
      const row = db.prepare('SELECT * FROM comic_series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      const sortTitle = title ? title.replace(/^(The|A|An)\s+/i, '') : null
      db.prepare(`
        UPDATE comic_series SET
          title = COALESCE(@title, title),
          sort_title = COALESCE(@sortTitle, sort_title),
          start_year = COALESCE(@start_year, start_year),
          publisher = COALESCE(@publisher, publisher),
          overview = COALESCE(@overview, overview),
          genres = COALESCE(@genres, genres),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: row.id,
        title: title ?? null,
        sortTitle,
        start_year: start_year ?? null,
        publisher: publisher ?? null,
        overview: overview ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
      })

      const updated = d(db.prepare('SELECT * FROM comic_series WHERE id = ?').get(row.id) as Record<string, unknown>) as any

      if (updated.root_folder_path && existsSync(updated.root_folder_path)) {
        try {
          const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<comic-series>\n  <title>${updated.title}</title>\n  <year>${updated.start_year || ''}</year>\n  <publisher>${updated.publisher || ''}</publisher>\n  <plot>${updated.overview || ''}</plot>\n  <genre>${(updated.genres || []).join(' / ')}</genre>\n  <uniqueid type="comicvine">${updated.comicvine_id || ''}</uniqueid>\n</comic-series>`
          writeFileSync(join(updated.root_folder_path, 'series.nfo'), nfo)
        } catch (nfoErr) {
          logger.warn(`Failed to write series.nfo: ${nfoErr instanceof Error ? nfoErr.message : String(nfoErr)}`)
        }
      }

      res.json(updated)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/comics/series/:id/images', async (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM comic_series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      const results: Array<{ url: string; source: string; type: string; language: string }> = []

      if (row.comicvine_id) {
        try {
          const cvSeries = await getComicSeries(row.comicvine_id)
          if (cvSeries.coverUrl) results.push({ url: cvSeries.coverUrl, source: 'ComicVine', type: 'poster', language: 'null' })
        } catch {
          // ComicVine may be unconfigured — custom URLs still work.
        }
      }
      if (row.image_url && !results.some(r => r.url === row.image_url)) {
        results.push({ url: row.image_url, source: 'Current', type: 'poster', language: 'null' })
      }

      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/comics/series/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const row = db.prepare('SELECT * FROM comic_series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      if (type !== 'poster') return res.status(400).json({ error: `Unknown image type: ${type}` })

      const saved = await saveEntityImage(row.root_folder_path, 'poster.jpg', url)
      db.prepare(`UPDATE comic_series SET image_url = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, row.id)
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/comics/series/:id/acquisition-history', (req, res) => {
    try {
      const container = db.prepare('SELECT id FROM comic_series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req))
      if (!container) return res.status(404).json({ error: 'Not found' })
      const childIds = (db.prepare('SELECT id FROM comic_issues WHERE series_id = ?').all(req.params.id) as Array<{ id: number }>).map(r => r.id)
      res.json(listAcquisitionHistoryForSubjectIds({ mediaType: 'comics', subjectType: 'issue', subjectIds: childIds }))
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.delete('/comics/series/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const row = db.prepare('SELECT root_folder_path FROM comic_series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (row && deleteFiles) safeDeleteMediaPath(row.root_folder_path)
      db.prepare('DELETE FROM comic_series WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/comics/issues/:id', validateBody(domains.UpdateComicIssue), (req, res) => {
    try {
      const { monitored, status, upgrade_allowed } = req.body
      const issue = db.prepare(`
        SELECT i.id FROM comic_issues i JOIN comic_series s ON i.series_id = s.id
        WHERE i.id = ? AND s.library_id = ?`).get(req.params.id, libId(req)) as { id: number } | undefined
      if (!issue) return res.status(404).json({ error: 'Not found' })
      db.prepare(`UPDATE comic_issues SET monitored = COALESCE(@monitored, monitored), status = COALESCE(@status, status), upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed), updated_at = datetime('now') WHERE id = @id`)
        .run({ id: issue.id, monitored: monitored !== undefined ? (monitored ? 1 : 0) : null, status: status ?? null, upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null })
      res.json(d(db.prepare('SELECT * FROM comic_issues WHERE id = ?').get(issue.id) as Record<string, unknown>))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Lookup ────────────────────────────────────────────────────────────────

  router.get('/comics/lookup', async (req, res) => {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })
    try {
      const results = await searchComicSeries(String(q))
      const series = results.map(s => ({
        ...s,
        alreadyAdded: !!db.prepare('SELECT id FROM comic_series WHERE library_id = ? AND comicvine_id = ?').get(libId(req), s.id),
      }))
      res.json(series)
    } catch (err) {
      logger.warn('ComicVine lookup failed:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' })
    }
  })

  router.post('/comics/download', validateBody(domains.DownloadComics.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, issueId } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No enabled download clients' })
      const result = await sendToDownloadClient(clients[0], downloadUrl, 'archivist-comics')
      if (result.success && issueId) {
        db.prepare("UPDATE comic_issues SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, issueId)
      }
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/comics/refresh', (req, res) => {
    try {
      const seriesList = db.prepare('SELECT id, comicvine_id, title FROM comic_series WHERE library_id = ?').all(libId(req)) as Array<{ id: number; comicvine_id: number; title: string }>
      logger.info(`Starting refresh for ${seriesList.length} comic series...`)
      res.json({ success: true, message: `Refresh started for ${seriesList.length} series in background.` })

      ;(async () => {
        for (const series of seriesList) {
          try {
            const cvSeries = await getComicSeries(series.comicvine_id)
            await ensureComicSeriesFolder(cvSeries, resolveLibraryRoot(db, libId(req)))

            db.prepare(`UPDATE comic_series SET overview = ?, image_url = COALESCE(?, image_url), updated_at = datetime('now') WHERE id = ?`)
              .run(cvSeries.overview ?? null, cvSeries.coverUrl ?? null, series.id)

            const issues = await getComicIssues(series.comicvine_id)
            for (const issue of issues) {
              db.prepare(`UPDATE comic_issues SET
                title = COALESCE(?, title),
                cover_date = COALESCE(?, cover_date),
                overview = COALESCE(?, overview),
                image_url = COALESCE(?, image_url),
                updated_at = datetime('now')
                WHERE series_id = ? AND issue_number = ?`)
                .run(issue.title ?? null, issue.coverDate ?? null, issue.overview ?? null, issue.coverUrl ?? null, series.id, issue.issueNumber)
            }
          } catch (err) {
            logger.warn(`Failed to refresh comic series id=${series.id}:`, err)
          }
        }
        logger.info('Comics refresh complete.')
      })().catch(err => logger.error('Background comics refresh error:', err))
    } catch (err) {
      res.status(500).json({ error: 'Failed to start refresh' })
    }
  })

  return router
}
