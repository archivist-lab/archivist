import { Router } from 'express'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { defaultDbPath } from '@archivist/db'
import { getDb } from '../db.js'
import { forceRefreshAll } from '../release-pipeline/orchestrator.js'
import { enqueueJob } from './event-store.js'
import { listAcquisitionDecisions, listReleaseBlocklist, unblockRelease } from '../services/acquisition-decisions.js'
import { baseImportMediaType, isIgnoredStagedDownload, listMediaImports, queueMediaImport, type MatchMediaType } from '../services/media-imports.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { getLastMaintenanceResult, getMaintenanceConfig, runSystemMaintenance, setMaintenanceConfig } from './maintenance.js'
import { createSystemBackup, getBackupConfig, getLastBackupManifest, listBackups, setBackupConfig } from './backups.js'
import {
  bulkRepairIntegrityProblems,
  getIntegrityConfig,
  getLastIntegrityReport,
  repairIntegrityProblem,
  runIntegrityScan,
  scanDataIntegrity,
  setIntegrityConfig,
} from './data-integrity.js'
import { cancelSegmentAnalysis, enqueueSeason, segmentQueueStatus, sweepUnanalysedSeasons } from '../segments/queue.js'
import { getSegmentSettings, updateSegmentSettings } from '../segments/settings.js'

interface LibraryRow { id: number; name: string; media_type: string; db_path: string }

function countRows(db: ReturnType<typeof getDb>, table: string, groupColumn: string) {
  try {
    return db.prepare(`
      SELECT ${groupColumn} as key, COUNT(*) as count
      FROM ${table}
      GROUP BY ${groupColumn}
    `).all() as Array<{ key: string | number; count: number }>
  } catch {
    return []
  }
}

function countsByKey(rows: Array<{ key: string | number; count: number }>) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.key)] = Number(row.count)
    return acc
  }, {})
}

function normalise(value: string | null | undefined) {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function tokens(value: string | null | undefined) {
  return (value ?? '').toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
}

function scoreManualMatch(sourceName: string, title: string, extra = '') {
  const source = normalise(sourceName)
  const cleanTitle = normalise(title)
  const cleanExtra = normalise(extra)
  if (!source || !cleanTitle) return 0

  const titleExact = source.includes(cleanTitle)
  const extraExact = cleanExtra ? source.includes(cleanExtra) : true
  if (titleExact && extraExact) return 100
  if (titleExact) return cleanExtra ? 92 : 96

  const titleWords = tokens(title).filter(w => w.length >= 3)
  if (titleWords.length === 0) return 0
  const hits = titleWords.filter(w => source.includes(w)).length
  const tokenScore = Math.round((hits / titleWords.length) * 78)
  const extraBonus = cleanExtra && source.includes(cleanExtra) ? 18 : 0
  return Math.min(95, tokenScore + extraBonus)
}

function getManualImportSearchResultsForLibrary(
  library: LibraryRow,
  sourceName: string,
  mediaType: string,
  query: string,
) {
  if (library.media_type !== mediaType) return []
  const db = getDb()
  const q = `%${query.trim().toLowerCase()}%`
  let rows: any[] = []

  if (mediaType === 'films') {
    rows = db.prepare('SELECT id, title, year, status FROM films WHERE library_id = ? AND lower(title) LIKE ? ORDER BY title ASC LIMIT 80').all(library.id, q)
      .map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.year ? String(row.year) : row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.year ? String(row.year) : '') }))
  } else if (mediaType === 'series') {
    const showRows = db.prepare(`
      SELECT id, title, year, status
      FROM series
      WHERE library_id = ? AND lower(title) LIKE ?
      ORDER BY title ASC
      LIMIT 80
    `).all(library.id, q).map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.year ? String(row.year) : row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.year ? String(row.year) : ''), mediaType: 'series' }))
    const seasonRows = db.prepare(`
      SELECT se.id, se.season_number, se.title, se.info_hash, s.title as series_title
      FROM seasons se
      JOIN series s ON s.id = se.series_id
      WHERE s.library_id = ? AND (lower(s.title) LIKE ? OR lower(se.title) LIKE ?)
      ORDER BY s.title ASC, se.season_number ASC
      LIMIT 100
    `).all(library.id, q, q).map((row: any) => {
      const code = `S${String(row.season_number).padStart(2, '0')}`
      return { itemId: row.id, title: `${row.series_title} ${code}`, subtitle: row.title ?? 'season pack', status: row.info_hash ? 'acquiring' : null, score: scoreManualMatch(sourceName, row.series_title, code), mediaType: 'series-season' }
    })
    rows = db.prepare(`
      SELECT e.id, e.title, e.season_number, e.episode_number, e.status, s.title as series_title
      FROM episodes e
      JOIN series s ON s.id = e.series_id
      WHERE s.library_id = ? AND (lower(s.title) LIKE ? OR lower(e.title) LIKE ?)
      ORDER BY s.title ASC, e.season_number ASC, e.episode_number ASC
      LIMIT 120
    `).all(library.id, q, q).map((row: any) => {
      const code = `S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}`
      return { itemId: row.id, title: `${row.series_title} ${code}`, subtitle: row.title ?? row.status, status: row.status, score: scoreManualMatch(sourceName, row.series_title, code), mediaType: 'series-episode' }
    })
    rows = [...showRows, ...seasonRows, ...rows]
  } else if (mediaType === 'music') {
    const artistRows = db.prepare(`
      SELECT id, name, monitored
      FROM artists
      WHERE library_id = ? AND lower(name) LIKE ?
      ORDER BY name ASC
      LIMIT 80
    `).all(library.id, q).map((row: any) => ({ itemId: row.id, title: `${row.name} Discography`, subtitle: 'artist discography', status: row.monitored ? 'monitored' : 'unmonitored', score: scoreManualMatch(sourceName, row.name), mediaType: 'music-discography' }))
    rows = db.prepare(`
      SELECT al.id, al.title, al.status, ar.name as artist_name
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      WHERE ar.library_id = ? AND (lower(al.title) LIKE ? OR lower(ar.name) LIKE ?)
      ORDER BY ar.name ASC, al.title ASC
      LIMIT 100
    `).all(library.id, q, q).map((row: any) => ({ itemId: row.id, title: `${row.artist_name} - ${row.title}`, subtitle: row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.artist_name), mediaType: 'music-album' }))
    rows = [...artistRows, ...rows]
  } else if (mediaType === 'games') {
    rows = db.prepare('SELECT id, title, year, status FROM games WHERE library_id = ? AND lower(title) LIKE ? ORDER BY title ASC LIMIT 80').all(library.id, q)
      .map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.year ? String(row.year) : row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.year ? String(row.year) : '') }))
  } else if (mediaType === 'comics') {
    const volumeRows = db.prepare(`
      SELECT id, title, start_year, status, issue_count
      FROM comic_series
      WHERE library_id = ? AND lower(title) LIKE ?
      ORDER BY title ASC
      LIMIT 80
    `).all(library.id, q).map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.start_year ? `${row.start_year} · ${row.issue_count ?? 0} issues` : 'volume', status: row.status, score: scoreManualMatch(sourceName, row.title, row.start_year ? String(row.start_year) : ''), mediaType: 'comics-volume' }))
    rows = db.prepare(`
      SELECT i.id, i.issue_number, i.title as issue_title, i.status, s.title as series_title
      FROM comic_issues i
      JOIN comic_series s ON s.id = i.series_id
      WHERE s.library_id = ? AND (lower(s.title) LIKE ? OR lower(i.title) LIKE ?)
      ORDER BY s.title ASC, i.issue_number ASC
      LIMIT 100
    `).all(library.id, q, q).map((row: any) => ({ itemId: row.id, title: `${row.series_title} #${row.issue_number}`, subtitle: row.issue_title ?? row.status, status: row.status, score: scoreManualMatch(sourceName, row.series_title, row.issue_number), mediaType: 'comics-issue' }))
    rows = [...volumeRows, ...rows]
  }

  return rows.map(row => ({ ...row, tabId: library.id, tabName: library.name, mediaType: row.mediaType ?? mediaType }))
}

function getManualImportCandidatesForLibrary(library: LibraryRow, sourceName: string) {
  const db = getDb()
  const mediaType = library.media_type
  let rows: any[] = []

  if (mediaType === 'films') {
    rows = db.prepare('SELECT id, title, year, status FROM films WHERE library_id = ? ORDER BY updated_at DESC LIMIT 1000').all(library.id)
      .map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.year ? String(row.year) : row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.year ? String(row.year) : '') }))
  } else if (mediaType === 'series') {
    const showRows = db.prepare(`
      SELECT id, title, year, status
      FROM series
      WHERE library_id = ?
      ORDER BY updated_at DESC
      LIMIT 1000
    `).all(library.id).map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.year ? String(row.year) : row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.year ? String(row.year) : ''), mediaType: 'series' }))
    const seasonRows = db.prepare(`
      SELECT se.id, se.series_id, se.season_number, se.title, se.download_progress, se.info_hash, s.title as series_title
      FROM seasons se
      JOIN series s ON s.id = se.series_id
      WHERE s.library_id = ?
      ORDER BY se.updated_at DESC
      LIMIT 1500
    `).all(library.id).map((row: any) => {
      const code = `S${String(row.season_number).padStart(2, '0')}`
      return { itemId: row.id, title: `${row.series_title} ${code}`, subtitle: row.title ?? 'season pack', status: row.info_hash ? 'acquiring' : null, score: scoreManualMatch(sourceName, row.series_title, code), mediaType: 'series-season' }
    })
    rows = db.prepare(`
      SELECT e.id, e.title, e.season_number, e.episode_number, e.status, s.title as series_title
      FROM episodes e
      JOIN series s ON s.id = e.series_id
      WHERE s.library_id = ?
      ORDER BY e.updated_at DESC
      LIMIT 3000
    `).all(library.id).map((row: any) => {
      const code = `S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}`
      return { itemId: row.id, title: `${row.series_title} ${code}`, subtitle: row.title ?? row.status, status: row.status, score: scoreManualMatch(sourceName, row.series_title, code), mediaType: 'series-episode' }
    })
    rows = [...showRows, ...seasonRows, ...rows]
  } else if (mediaType === 'music') {
    const artistRows = db.prepare(`
      SELECT id, name, monitored
      FROM artists
      WHERE library_id = ?
      ORDER BY updated_at DESC
      LIMIT 1000
    `).all(library.id).map((row: any) => ({ itemId: row.id, title: `${row.name} Discography`, subtitle: 'artist discography', status: row.monitored ? 'monitored' : 'unmonitored', score: scoreManualMatch(sourceName, row.name), mediaType: 'music-discography' }))
    rows = db.prepare(`
      SELECT al.id, al.title, al.status, ar.name as artist_name
      FROM albums al
      JOIN artists ar ON ar.id = al.artist_id
      WHERE ar.library_id = ?
      ORDER BY al.updated_at DESC
      LIMIT 1500
    `).all(library.id).map((row: any) => ({ itemId: row.id, title: `${row.artist_name} - ${row.title}`, subtitle: row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.artist_name), mediaType: 'music-album' }))
    rows = [...artistRows, ...rows]
  } else if (mediaType === 'games') {
    rows = db.prepare('SELECT id, title, year, status FROM games WHERE library_id = ? ORDER BY updated_at DESC LIMIT 1000').all(library.id)
      .map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.year ? String(row.year) : row.status, status: row.status, score: scoreManualMatch(sourceName, row.title, row.year ? String(row.year) : '') }))
  } else if (mediaType === 'comics') {
    const volumeRows = db.prepare(`
      SELECT id, title, start_year, status, issue_count
      FROM comic_series
      WHERE library_id = ?
      ORDER BY updated_at DESC
      LIMIT 1000
    `).all(library.id).map((row: any) => ({ itemId: row.id, title: row.title, subtitle: row.start_year ? `${row.start_year} · ${row.issue_count ?? 0} issues` : 'volume', status: row.status, score: scoreManualMatch(sourceName, row.title, row.start_year ? String(row.start_year) : ''), mediaType: 'comics-volume' }))
    rows = db.prepare(`
      SELECT i.id, i.issue_number, i.title as issue_title, i.status, s.title as series_title
      FROM comic_issues i
      JOIN comic_series s ON s.id = i.series_id
      WHERE s.library_id = ?
      ORDER BY i.updated_at DESC
      LIMIT 2000
    `).all(library.id).map((row: any) => ({ itemId: row.id, title: `${row.series_title} #${row.issue_number}`, subtitle: row.issue_title ?? row.status, status: row.status, score: scoreManualMatch(sourceName, row.series_title, row.issue_number), mediaType: 'comics-issue' }))
    rows = [...volumeRows, ...rows]
  }

  return rows
    .filter(row => row.score >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(row => ({ ...row, tabId: library.id, tabName: library.name, mediaType: row.mediaType ?? mediaType }))
}

export function createSystemAdminRouter(): Router {
  const router = Router()

  router.get('/segments/status', (_req, res) => {
    res.json({ settings: getSegmentSettings(), queue: segmentQueueStatus() })
  })

  router.get('/segments/settings', (_req, res) => {
    res.json({ settings: getSegmentSettings() })
  })

  router.put('/segments/settings', (req, res) => {
    res.json({ settings: updateSegmentSettings(req.body ?? {}) })
  })

  router.post('/segments/analyse', (req, res) => {
    const seriesId = Number(req.body?.seriesId)
    const seasonNumber = Number(req.body?.seasonNumber)
    if (Number.isFinite(seriesId) && Number.isFinite(seasonNumber)) {
      const enqueued = enqueueSeason(seriesId, seasonNumber, { priority: 'high', force: true })
      return res.status(enqueued ? 202 : 200).json({ enqueued: enqueued ? 1 : 0, key: `${seriesId}:${seasonNumber}` })
    }
    const enqueued = sweepUnanalysedSeasons({ force: true })
    res.status(202).json({ enqueued })
  })

  router.post('/segments/cancel', (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key : undefined
    res.json({ cancelled: cancelSegmentAnalysis(key) })
  })

  router.post('/rss/run', async (_req, res, next) => {
    try {
      const results = await forceRefreshAll()
      res.json({ success: true, results })
    } catch (err) {
      next(err)
    }
  })

  router.post('/jobs', (req, res) => {
    const { type, subjectType, subjectId, payload, maxAttempts } = req.body ?? {}
    if (typeof type !== 'string' || type.length === 0) return res.status(400).json({ error: 'type is required' })
    const id = enqueueJob({ type, subjectType, subjectId, payload, maxAttempts })
    res.status(201).json({ id })
  })

  router.get('/acquisition-decisions', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 200
    res.json({ decisions: listAcquisitionDecisions(Number.isFinite(limit) ? limit : 200) })
  })

  router.get('/release-blocklist', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 200
    res.json({ blocks: listReleaseBlocklist(Number.isFinite(limit) ? limit : 200) })
  })

  router.delete('/release-blocklist/:id', (req, res) => {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid block id' })
    if (!unblockRelease(id)) return res.status(404).json({ error: 'block not found' })
    res.json({ success: true })
  })

  router.get('/media-imports', (req, res) => {
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 200
    res.json({ imports: listMediaImports(Number.isFinite(limit) ? limit : 200) })
  })

  router.get('/integrity', (_req, res) => {
    const db = getDb()
    res.json({
      config: getIntegrityConfig(db),
      lastReport: getLastIntegrityReport(db),
      current: scanDataIntegrity(db),
    })
  })

  router.put('/integrity', (req, res) => {
    res.json({ config: setIntegrityConfig(req.body ?? {}) })
  })

  router.post('/integrity/run', (_req, res) => {
    res.json({ report: runIntegrityScan() })
  })

  router.post('/integrity/repair', async (req, res, next) => {
    try {
      const { problem, backupBeforeRepair } = req.body ?? {}
      if (!problem || typeof problem !== 'object') return res.status(400).json({ error: 'problem is required' })
      const db = getDb()
      const config = getIntegrityConfig(db)
      const shouldBackup = typeof backupBeforeRepair === 'boolean' ? backupBeforeRepair : config.backupBeforeRepair
      const backup = shouldBackup ? await createSystemBackup(db) : null
      const result = repairIntegrityProblem(problem, db, { backupId: backup?.id })
      res.json({ result, backup, integrity: scanDataIntegrity(db) })
    } catch (err) {
      next(err)
    }
  })

  router.post('/integrity/repair-bulk', async (req, res, next) => {
    try {
      const { problems, backupBeforeRepair } = req.body ?? {}
      if (!Array.isArray(problems)) return res.status(400).json({ error: 'problems must be an array' })
      const db = getDb()
      const config = getIntegrityConfig(db)
      const shouldBackup = typeof backupBeforeRepair === 'boolean' ? backupBeforeRepair : config.backupBeforeRepair
      const repairable = problems.filter(problem => problem?.category === 'stale-acquisition' || problem?.category === 'missing-import-source' || problem?.category === 'orphaned-download')
      const backup = shouldBackup && repairable.length > 0 ? await createSystemBackup(db) : null
      const result = bulkRepairIntegrityProblems(problems, db, { backupId: backup?.id })
      res.json({ result, backup, integrity: scanDataIntegrity(db) })
    } catch (err) {
      next(err)
    }
  })

  router.get('/manual-imports/candidates', (_req, res) => {
    const db = getDb()
    const downloadDir = process.env.ARCHIVIST_DOWNLOAD_DIR ?? process.env.TORRENT_DOWNLOAD_DIR ?? './downloads/complete'
    if (!existsSync(downloadDir)) return res.json({ downloadDir, items: [] })

    const libraries = db.prepare('SELECT id, name, media_type, db_path FROM libraries ORDER BY id ASC').all() as LibraryRow[]
    let activeTorrentPaths = new Set<string>()
    try {
      activeTorrentPaths = new Set(
        getTorrentSession().getAllTorrents()
          .filter((t: any) => t.status !== 'orphaned' && !t.orphaned)
          .flatMap((t: any) => [
            resolve(join(t.downloadDir, t.name)),
            join(t.downloadDir, t.name),
            t.name,
          ]),
      )
    } catch {}
    const entries = readdirSync(downloadDir)
      .map(name => {
        const sourcePath = join(downloadDir, name)
        if (isIgnoredStagedDownload(sourcePath)) return null
        if (activeTorrentPaths.has(name) || activeTorrentPaths.has(sourcePath) || activeTorrentPaths.has(resolve(sourcePath))) return null
        const stat = statSync(sourcePath)
        if (!stat.isDirectory() && !stat.isFile()) return null
        const candidates = libraries.flatMap(library => {
          try { return getManualImportCandidatesForLibrary(library, name) } catch { return [] }
        }).sort((a, b) => b.score - a.score).slice(0, 8)
        return { sourcePath, name, size: stat.isFile() ? stat.size : null, modifiedAt: stat.mtime.toISOString(), candidates }
      })
      .filter(Boolean)

    res.json({ downloadDir, items: entries })
  })

  router.get('/manual-imports/search', (req, res) => {
    const mediaType = typeof req.query.mediaType === 'string' ? req.query.mediaType : ''
    const query = typeof req.query.query === 'string' ? req.query.query : ''
    const sourceName = typeof req.query.sourceName === 'string' ? req.query.sourceName : query
    if (!['films', 'series', 'series-season', 'series-episode', 'music', 'music-album', 'music-discography', 'games', 'comics', 'comics-issue', 'comics-volume'].includes(mediaType)) return res.status(400).json({ error: 'unsupported mediaType' })
    if (query.trim().length < 2) return res.json({ results: [] })

    const db = getDb()
    const baseMediaType =
      mediaType.startsWith('series') ? 'series'
      : mediaType.startsWith('music') ? 'music'
      : mediaType.startsWith('comics') ? 'comics'
      : mediaType
    const libraries = db.prepare('SELECT id, name, media_type, db_path FROM libraries WHERE media_type = ? ORDER BY id ASC').all(baseMediaType) as LibraryRow[]
    const results = libraries.flatMap(library => {
      try { return getManualImportSearchResultsForLibrary(library, sourceName, baseMediaType, query) } catch { return [] }
    }).filter((row: any) => {
      if (mediaType === 'series-season') return row.mediaType === 'series-season'
      if (mediaType === 'series-episode') return row.mediaType === 'series-episode'
      if (mediaType === 'music-album') return row.mediaType === 'music-album'
      if (mediaType === 'music-discography') return row.mediaType === 'music-discography'
      if (mediaType === 'comics-issue') return row.mediaType === 'comics-issue'
      if (mediaType === 'comics-volume') return row.mediaType === 'comics-volume'
      return row.mediaType === mediaType || row.mediaType.startsWith(`${mediaType}-`)
    }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 50)

    res.json({ results })
  })

  router.post('/manual-imports/queue', (req, res) => {
    const { tabId, mediaType, itemId, sourcePath, copy, releaseTitle } = req.body ?? {}
    if (!tabId || !mediaType || !itemId || !sourcePath) return res.status(400).json({ error: 'tabId, mediaType, itemId, and sourcePath are required' })
    if (!['films', 'series', 'series-season', 'series-episode', 'music', 'music-album', 'music-discography', 'games', 'comics', 'comics-issue', 'comics-volume'].includes(mediaType)) return res.status(400).json({ error: 'unsupported mediaType' })
    if (!existsSync(sourcePath)) return res.status(400).json({ error: 'sourcePath does not exist' })

    const db = getDb()
    const library = db.prepare('SELECT id, name, media_type, db_path FROM libraries WHERE id = ?').get(tabId) as LibraryRow | undefined
    if (!library) return res.status(404).json({ error: 'tab not found' })
    const targetMediaType = mediaType as MatchMediaType
    if (library.media_type !== baseImportMediaType(targetMediaType)) return res.status(400).json({ error: `tab media type is ${library.media_type}, not ${mediaType}` })

    const hash = createHash('sha1').update(`${sourcePath}:${Date.now()}`).digest('hex')
    const jobId = queueMediaImport({
      tabId: library.id,
      tabName: library.name,
      dbPath: library.db_path,
      mediaType: targetMediaType,
      itemId: Number(itemId),
      torrentId: `manual:${hash}`,
      infoHash: hash,
      sourcePath,
      copy: Boolean(copy),
      releaseTitle: releaseTitle ?? basename(sourcePath),
    })
    res.status(201).json({ success: true, jobId })
  })

  router.get('/overview', (_req, res) => {
    const db = getDb()
    const unifiedPath = process.env.ARCHIVIST_DB ?? defaultDbPath()
    const libraries = db.prepare('SELECT id, name, media_type, db_path FROM libraries ORDER BY id ASC').all() as LibraryRow[]

    let torrentSummary = {
      available: false,
      total: 0,
      downloading: 0,
      seeding: 0,
      queued: 0,
      stalled: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
    }
    try {
      const torrents = getTorrentSession().getAllTorrents()
      torrentSummary = {
        available: true,
        total: torrents.length,
        downloading: torrents.filter(t => t.status === 'downloading').length,
        seeding: torrents.filter(t => t.status === 'seeding').length,
        queued: torrents.filter(t => String(t.status) === 'queued').length,
        stalled: torrents.filter(t => !!t.stalledReason || (t.status === 'downloading' && t.downloadSpeed === 0)).length,
        downloadSpeed: torrents.reduce((sum, t) => sum + (t.downloadSpeed ?? 0), 0),
        uploadSpeed: torrents.reduce((sum, t) => sum + (t.uploadSpeed ?? 0), 0),
      }
    } catch {}

    const dbStatus = unifiedDbStatus(unifiedPath, db)
    const dbStatuses = [
      { scope: 'shared', name: 'Unified', mediaType: 'system', dbPath: unifiedPath, status: dbStatus },
      ...libraries.map(library => ({
        scope: 'tab',
        id: library.id,
        name: library.name,
        mediaType: library.media_type,
        dbPath: library.db_path,
        // Every library lives in the unified database in Archivist.
        status: dbStatus,
      })),
    ]

    const failedJobs = db.prepare(`
      SELECT id, type, subject_type as subjectType, subject_id as subjectId, attempts, max_attempts as maxAttempts,
             last_error as lastError, updated_at as updatedAt
      FROM system_jobs
      WHERE status = 'failed'
      ORDER BY id DESC
      LIMIT 10
    `).all()

    const recentErrors = db.prepare(`
      SELECT id, ts, category, action, severity, subject_type as subjectType, subject_id as subjectId, message
      FROM system_events
      WHERE severity IN ('warn', 'error')
      ORDER BY id DESC
      LIMIT 10
    `).all()

    const integrity = scanDataIntegrity(db)

    res.json({
      generatedAt: new Date().toISOString(),
      jobs: {
        byStatus: countsByKey(countRows(db, 'system_jobs', 'status')),
        byType: countsByKey(countRows(db, 'system_jobs', 'type')),
        failed: failedJobs,
      },
      events: {
        bySeverity: countsByKey(countRows(db, 'system_events', 'severity')),
        recentProblems: recentErrors,
      },
      imports: {
        byStatus: countsByKey(countRows(db, 'media_imports', 'status')),
        byMediaType: countsByKey(countRows(db, 'media_imports', 'media_type')),
      },
      acquisitions: {
        byAccepted: countsByKey(countRows(db, 'acquisition_decisions', 'accepted')),
        grabbed: countsByKey(countRows(db, 'acquisition_decisions', 'grabbed')),
      },
      torrents: torrentSummary,
      integrity: {
        total: integrity.summary.total,
        bySeverity: integrity.summary.bySeverity,
        byCategory: integrity.summary.byCategory,
      },
      databases: dbStatuses,
      openConnections: [unifiedPath],
      maintenance: {
        config: getMaintenanceConfig(db),
        lastResult: getLastMaintenanceResult(db),
      },
      integrityStatus: {
        config: getIntegrityConfig(db),
        lastReport: getLastIntegrityReport(db),
      },
      backups: {
        config: getBackupConfig(db),
        lastBackup: getLastBackupManifest(db),
        backups: listBackups().slice(0, 10),
      },
    })
  })

  router.get('/maintenance', (_req, res) => {
    const db = getDb()
    res.json({
      config: getMaintenanceConfig(db),
      lastResult: getLastMaintenanceResult(db),
    })
  })

  router.put('/maintenance', (req, res) => {
    res.json({ config: setMaintenanceConfig(req.body ?? {}) })
  })

  router.post('/maintenance/run', async (_req, res, next) => {
    try {
      const result = await runSystemMaintenance()
      res.json({ result })
    } catch (err) {
      next(err)
    }
  })

  router.get('/backups', (_req, res) => {
    const db = getDb()
    res.json({
      config: getBackupConfig(db),
      lastBackup: getLastBackupManifest(db),
      backups: listBackups(),
    })
  })

  router.put('/backups', (req, res) => {
    res.json({ config: setBackupConfig(req.body ?? {}) })
  })

  router.post('/backups/run', async (_req, res, next) => {
    try {
      const manifest = await createSystemBackup()
      res.json({ backup: manifest })
    } catch (err) {
      next(err)
    }
  })

  router.get('/db', (_req, res) => {
    const db = getDb()
    const unifiedPath = process.env.ARCHIVIST_DB ?? defaultDbPath()
    const libraries = db.prepare('SELECT id, name, media_type, db_path FROM libraries ORDER BY id ASC').all() as LibraryRow[]
    const status = unifiedDbStatus(unifiedPath, db)

    res.json({
      shared: status,
      tabs: libraries.map(library => ({
        id: library.id,
        name: library.name,
        mediaType: library.media_type,
        dbPath: library.db_path,
        status,
      })),
      openConnections: [unifiedPath],
    })
  })

  router.post('/db/checkpoint', (_req, res) => {
    const db = getDb()
    const unifiedPath = process.env.ARCHIVIST_DB ?? defaultDbPath()
    try {
      db.pragma('wal_checkpoint(PASSIVE)')
      res.json({ results: [{ path: unifiedPath, ok: true, status: unifiedDbStatus(unifiedPath, db) }] })
    } catch (err) {
      res.json({ results: [{ path: unifiedPath, ok: false, error: err instanceof Error ? err.message : String(err) }] })
    }
  })

  return router
}

function unifiedDbStatus(path: string, db: ReturnType<typeof getDb>) {
  const resolved = resolve(path)
  const status: Record<string, unknown> = {
    path: resolved,
    open: true,
    exists: existsSync(resolved),
    wal: existsSync(`${resolved}-wal`),
    shm: existsSync(`${resolved}-shm`),
    databaseBytes: fileSize(resolved),
    walBytes: fileSize(`${resolved}-wal`),
    shmBytes: fileSize(`${resolved}-shm`),
  }
  try {
    status.pageCount = db.pragma('page_count', { simple: true }) as number
    status.pageSize = db.pragma('page_size', { simple: true }) as number
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }
  return status
}

function fileSize(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).size : undefined
  } catch {
    return undefined
  }
}
