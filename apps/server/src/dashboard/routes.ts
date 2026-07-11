import { Router } from 'express'
import { createLogger, TransmissionClient } from '@archivist/core'
import si from 'systeminformation'
import axios from 'axios'
import { getDb } from '../db.js'
import { sendToDownloadClient } from '../services/download-manager.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../services/indexer-bridge.js'
import { evaluateRelease, markDecisionGrabbed, recordReleaseDecision } from '../services/acquisition-decisions.js'
import { ScopedDownloadClientStore } from '../shared/download-clients.js'
import { scopeId } from '../middleware/library-context.js'
import { tmdbImageUrl as filmThumb } from '../modules/films/tmdb.js'
import { tmdbImageUrl as seriesThumb } from '../modules/series/tvdb.js'

const logger = createLogger('Dashboard')

// ── Multi-client support ──────────────────────────────────────────────────────

async function getQbitSession(config: any) {
  const urlBase = (config.urlBase ?? '').replace(/\/$/, '')
  const base = `http${config.useSsl ? 's' : ''}://${config.host}:${config.port}${urlBase}`

  const res = await axios.post(`${base}/api/v2/auth/login`,
    new URLSearchParams({ username: config.username ?? '', password: config.password ?? '' }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 },
  )

  const cookie = res.headers['set-cookie']?.[0]?.split(';')[0]
  return { base, cookie }
}

async function getQbittorrentTorrents(config: any) {
  try {
    const { base, cookie } = await getQbitSession(config)
    const res = await axios.get(`${base}/api/v2/torrents/info`, {
      headers: { Cookie: cookie },
      timeout: 5000,
    })

    const qbitToArStatus = (q: string): any => {
      if (q === 'downloading' || q === 'stalledDL') return 'downloading'
      if (q === 'uploading' || q === 'stalledUP' || q === 'forcedUP') return 'seeding'
      if (q === 'pausedDL' || q === 'pausedUP') return 'stopped'
      if (q === 'checkingDL' || q === 'checkingUP' || q === 'checkingResumeData') return 'checking'
      if (q === 'queuedDL' || q === 'queuedUP') return 'queued-download'
      if (q === 'error' || q === 'missingFiles') return 'error'
      return 'downloading'
    }

    return (res.data || []).map((t: any) => ({
      id: `qbit:${t.hash}`,
      name: t.name,
      status: qbitToArStatus(t.state),
      progress: t.progress,
      downloadSpeed: t.dlspeed,
      uploadSpeed: t.upspeed,
      sizeBytes: t.size,
      eta: t.eta,
      peersConnected: t.num_leechs,
      seedsConnected: t.num_seeds,
      error: null,
    }))
  } catch (err) {
    logger.warn(`Failed to fetch from qBittorrent: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function getTransmissionTorrents(config: any) {
  try {
    const client = new TransmissionClient(config)
    const list = await client.getAllTorrents()

    const transToArStatus = (s: number): any => {
      if (s === 4) return 'downloading'
      if (s === 6) return 'seeding'
      if (s === 0) return 'stopped'
      if (s === 2) return 'checking'
      return 'downloading'
    }

    return list.map(t => ({
      id: `trans:${t.id}`,
      name: t.name,
      status: transToArStatus(t.status),
      progress: t.percentDone,
      downloadSpeed: t.rateDownload,
      uploadSpeed: t.rateUpload,
      sizeBytes: t.sizeWhenDone,
      eta: t.eta,
      peersConnected: (t as any).peersGettingFromUs ?? 0,
      seedsConnected: (t as any).peersSendingToUs ?? 0,
      error: t.errorString || null,
    }))
  } catch (err) {
    logger.warn(`Failed to fetch from Transmission: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export function createDashboardRouter(): Router {
  const router = Router()
  const db = getDb()

  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, scopeId(req))

  function getMediaCounts(libraryId: number, mediaType: string) {
    const counts = { total: 0, missing: 0, acquiring: 0 }

    const safeCount = (sql: string, ...params: unknown[]) => {
      try { return (db.prepare(sql).get(...params) as any).count as number } catch { return 0 }
    }

    if (mediaType === 'music') {
      try {
        const stats = db.prepare(`
          WITH ArtistStats AS (
            SELECT a.id,
              COUNT(DISTINCT al.id) as album_count,
              SUM(CASE WHEN al.status='downloaded' THEN 1 ELSE 0 END) as downloaded_albums
            FROM artists a
            LEFT JOIN albums al ON al.artist_id = a.id
            WHERE a.library_id = ?
            GROUP BY a.id
          )
          SELECT
            COUNT(id) as total,
            SUM(CASE WHEN album_count > 0 AND (downloaded_albums IS NULL OR downloaded_albums = 0) THEN 1 ELSE 0 END) as missing,
            SUM(CASE WHEN album_count > 0 AND downloaded_albums > 0 AND downloaded_albums < album_count THEN 1 ELSE 0 END) as acquiring
          FROM ArtistStats
        `).get(libraryId) as any

        counts.total = stats?.total || 0
        counts.missing = stats?.missing || 0
        counts.acquiring = stats?.acquiring || 0
      } catch (e) {
        logger.warn(`Failed to get music stats: ${e}`)
      }
      return counts
    }

    if (mediaType === 'films') {
      counts.total = safeCount('SELECT COUNT(*) as count FROM films WHERE library_id = ?', libraryId)
      counts.missing = safeCount("SELECT COUNT(*) as count FROM films WHERE library_id = ? AND status IN ('missing', 'wanted')", libraryId)
      counts.acquiring = safeCount("SELECT COUNT(*) as count FROM films WHERE library_id = ? AND status IN ('downloading', 'acquiring')", libraryId)
    } else if (mediaType === 'series') {
      counts.total = safeCount('SELECT COUNT(*) as count FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ?', libraryId)
      counts.missing = safeCount("SELECT COUNT(*) as count FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ? AND e.status IN ('missing', 'wanted') AND e.air_date <= date('now')", libraryId)
      counts.acquiring = safeCount("SELECT COUNT(*) as count FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ? AND e.status IN ('downloading', 'acquiring')", libraryId)
    } else if (mediaType === 'books') {
      counts.total = safeCount('SELECT COUNT(*) as count FROM books b JOIN authors a ON b.author_id = a.id WHERE a.library_id = ?', libraryId)
      counts.missing = safeCount("SELECT COUNT(*) as count FROM books b JOIN authors a ON b.author_id = a.id WHERE a.library_id = ? AND b.status IN ('missing', 'wanted')", libraryId)
      counts.acquiring = safeCount("SELECT COUNT(*) as count FROM books b JOIN authors a ON b.author_id = a.id WHERE a.library_id = ? AND b.status IN ('downloading', 'acquiring')", libraryId)
    } else if (mediaType === 'comics') {
      counts.total = safeCount('SELECT COUNT(*) as count FROM comic_issues i JOIN comic_series s ON i.series_id = s.id WHERE s.library_id = ?', libraryId)
      counts.missing = safeCount("SELECT COUNT(*) as count FROM comic_issues i JOIN comic_series s ON i.series_id = s.id WHERE s.library_id = ? AND i.status IN ('missing', 'wanted')", libraryId)
      counts.acquiring = safeCount("SELECT COUNT(*) as count FROM comic_issues i JOIN comic_series s ON i.series_id = s.id WHERE s.library_id = ? AND i.status IN ('downloading', 'acquiring')", libraryId)
    } else if (mediaType === 'games') {
      counts.total = safeCount('SELECT COUNT(*) as count FROM games WHERE library_id = ?', libraryId)
      counts.missing = safeCount("SELECT COUNT(*) as count FROM games WHERE library_id = ? AND status IN ('missing', 'wanted')", libraryId)
      counts.acquiring = safeCount("SELECT COUNT(*) as count FROM games WHERE library_id = ? AND status IN ('downloading', 'acquiring')", libraryId)
    }
    return counts
  }

  router.get('/dashboard/stats', async (req, res) => {
    try {
      if (req.library) {
        const mediaType = req.library.mediaType || 'films'
        return res.json({ counts: { [mediaType]: getMediaCounts(req.library.id, mediaType) } })
      }

      const libraries = db.prepare('SELECT * FROM libraries').all() as any[]
      const allCounts: Record<string, { total: number; missing: number; acquiring: number }> = {}

      for (const library of libraries) {
        try {
          const counts = getMediaCounts(library.id, library.media_type)
          if (!allCounts[library.media_type]) {
            allCounts[library.media_type] = { total: 0, missing: 0, acquiring: 0 }
          }
          allCounts[library.media_type].total += counts.total
          allCounts[library.media_type].missing += counts.missing
          allCounts[library.media_type].acquiring += counts.acquiring
        } catch (err) {
          logger.warn(`Failed to get stats for library "${library.name}": ${err}`)
        }
      }

      res.json({ counts: allCounts })
    } catch (err) {
      logger.error('Failed to fetch dashboard stats:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.get('/dashboard/calendar', async (req, res) => {
    try {
      const { start, end } = req.query
      if (!start || !end) return res.status(400).json({ error: 'start and end dates required' })

      const events: any[] = []
      const libraries = db.prepare('SELECT * FROM libraries').all() as any[]

      for (const library of libraries) {
        try {
          const mediaType = library.media_type

          if (mediaType === 'films') {
            const films = db.prepare(`
              SELECT id, tmdb_id as tmdbId, title, poster_path, overview,
                     release_date as theatrical,
                     digital_release_date as digital,
                     physical_release_date as physical,
                     'film' as type
              FROM films
              WHERE library_id = @libraryId AND (
                    (SUBSTR(release_date, 1, 10) >= @start AND SUBSTR(release_date, 1, 10) <= @end)
                 OR (SUBSTR(digital_release_date, 1, 10) >= @start AND SUBSTR(digital_release_date, 1, 10) <= @end)
                 OR (SUBSTR(physical_release_date, 1, 10) >= @start AND SUBSTR(physical_release_date, 1, 10) <= @end))
            `).all({ libraryId: library.id, start, end }) as any[]

            for (const f of films) {
              const filmWithLocalPaths = { ...f, poster_path: filmThumb(f.poster_path, 'w185'), tabId: library.id, tabName: library.name, mediaType }
              if (f.theatrical) {
                const d = f.theatrical.split('T')[0]
                if (d >= (start as string) && d <= (end as string)) events.push({ ...filmWithLocalPaths, date: d, displaySub: 'Theatrical Release' })
              }
              if (f.digital) {
                const d = f.digital.split('T')[0]
                if (d >= (start as string) && d <= (end as string)) events.push({ ...filmWithLocalPaths, date: d, displaySub: 'Digital Release' })
              }
              if (f.physical) {
                const d = f.physical.split('T')[0]
                if (d >= (start as string) && d <= (end as string)) events.push({ ...filmWithLocalPaths, date: d, displaySub: 'Physical Release' })
              }
            }
          } else if (mediaType === 'series') {
            const episodes = db.prepare(`
              SELECT e.id, s.tmdb_id as tmdbId, s.title as seriesTitle, e.title, e.season_number, e.episode_number, e.air_date, s.air_time, s.poster_path, e.still_path, s.logo_path, s.logo_path as logoPath, e.overview, 'series' as type
              FROM episodes e
              JOIN series s ON e.series_id = s.id
              WHERE s.library_id = ? AND SUBSTR(e.air_date, 1, 10) >= ? AND SUBSTR(e.air_date, 1, 10) <= ?
            `).all(library.id, start, end) as any[]
            events.push(...episodes.map(e => {
              const airTime = e.air_time || '20:00'
              let fullDate = e.air_date
              if (!fullDate.includes('T')) fullDate = `${e.air_date}T${airTime}:00-05:00`
              return {
                ...e,
                poster_path: seriesThumb(e.poster_path, 'w185'),
                still_path: seriesThumb(e.still_path, 'w300'),
                logoPath: seriesThumb(e.logoPath, 'original'),
                logo_path: seriesThumb(e.logo_path, 'original'),
                displayTitle: e.seriesTitle,
                displaySub: `S${String(e.season_number).padStart(2, '0')}E${String(e.episode_number).padStart(2, '0')} · ${e.title}`,
                date: fullDate,
                tabId: library.id,
                tabName: library.name,
                mediaType,
              }
            }))
          }
        } catch (e) {
          logger.warn(`Failed to fetch calendar events from library ${library.name}: ${e}`)
        }
      }

      res.json(events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()))
    } catch (err) {
      logger.error('Failed to fetch calendar:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  router.get('/dashboard/system', async (_req, res) => {
    try {
      const [cpu, mem, fs] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
      ])

      res.json({
        cpu: {
          load: cpu.currentLoad,
          cores: cpu.cpus.length,
        },
        memory: {
          total: mem.total,
          used: mem.active,
          free: mem.available,
        },
        storage: fs.map(f => ({
          fs: f.fs,
          mount: f.mount,
          size: f.size,
          used: f.use,
        })),
      })
    } catch (err) {
      logger.error('Failed to fetch system info:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  // ── Download monitor ────────────────────────────────────────────────────────

  router.get('/dashboard/downloads', async (req, res) => {
    try {
      const allTorrents: any[] = []

      try {
        const session = getTorrentSession()
        allTorrents.push(...session.getAllTorrents())
      } catch (e) {}

      const enabled = clientsFor(req).getEnabled().filter(c => c.type !== 'built-in')
      for (const client of enabled) {
        try {
          if (client.type === 'qbittorrent') {
            allTorrents.push(...(await getQbittorrentTorrents(client)))
          } else if (client.type === 'transmission') {
            allTorrents.push(...(await getTransmissionTorrents(client)))
          }
        } catch (err) {
          logger.warn(`Failed to fetch downloads from ${client.type} client "${client.name}":`, err instanceof Error ? err.message : String(err))
        }
      }

      res.json({ torrents: allTorrents })
    } catch (err) {
      logger.error('Failed to fetch downloads:', err)
      res.json({ torrents: [] })
    }
  })

  router.post('/dashboard/downloads/:id/action', async (req, res) => {
    try {
      const { id } = req.params
      const { action, deleteData } = req.body

      if (id.startsWith('qbit:') || id.startsWith('trans:')) {
        const [type, realId] = id.split(':')
        const enabled = clientsFor(req).getEnabled()
        const client = enabled.find(c => c.type === (type === 'qbit' ? 'qbittorrent' : 'transmission'))
        if (!client) throw new Error('Client not found')

        if (type === 'qbit') {
          const { base, cookie } = await getQbitSession(client)
          const headers = { Cookie: cookie }
          if (action === 'pause') await axios.get(`${base}/api/v2/torrents/pause?hashes=${realId}`, { headers })
          if (action === 'resume') await axios.get(`${base}/api/v2/torrents/resume?hashes=${realId}`, { headers })
          if (action === 'remove') await axios.get(`${base}/api/v2/torrents/delete?hashes=${realId}&deleteFiles=${deleteData}`, { headers })
        } else {
          const trans = new TransmissionClient(client)
          if (action === 'pause') await trans.pauseTorrent(parseInt(realId))
          if (action === 'resume') await trans.resumeTorrent(parseInt(realId))
          if (action === 'remove') await trans.removeTorrent(parseInt(realId), !!deleteData)
        }
      } else {
        const session = getTorrentSession()
        switch (action) {
          case 'pause': await session.stopTorrent(id); break
          case 'resume': await session.startTorrent(id); break
          case 'remove': await session.removeTorrent(id, !!deleteData); break
          case 'recheck': await session.verifyTorrent(id); break
          case 'reannounce': await session.reannounceTorrent(id); break
          default: return res.status(400).json({ error: 'Invalid action' })
        }
      }

      res.json({ success: true })
    } catch (err) {
      logger.error('Failed to perform download action:', err)
      res.status(500).json({ error: 'Action failed' })
    }
  })

  // ── Manual search ───────────────────────────────────────────────────────────

  router.get('/dashboard/search', async (req, res) => {
    try {
      const { q, category, type, module } = req.query
      if (!q) return res.status(400).json({ error: 'Query required' })

      const enabledIndexers = getEnabledIndexerInstances()
      if (enabledIndexers.length === 0) {
        return res.status(400).json({ error: 'No indexers configured' })
      }

      const categories = category
        ? String(category).split(',').map(c => parseInt(c, 10)).filter(c => !isNaN(c))
        : undefined

      const results = await searchViaIndexers(enabledIndexers, String(q), {
        categories,
        type: type as any,
        module: module as any,
      })
      res.json(results.map(r => {
        const decision = evaluateRelease({
          source: 'manual',
          tabId: req.library?.id,
          tabName: req.library?.name,
          mediaType: String(module ?? 'all'),
          subjectType: 'manual-search',
          subjectTitle: String(q),
        }, r)
        return {
          ...r,
          customTier: decision.customTier,
          customScore: decision.score,
          accepted: decision.accepted,
          reasons: decision.reasons,
          rejectionReasons: decision.rejectionReasons,
        }
      }))
    } catch (err) {
      logger.error('Manual search failed:', err)
      res.status(500).json({ error: 'Search failed' })
    }
  })

  router.post('/dashboard/search/grab', async (req, res) => {
    try {
      const { downloadUrl, title, mediaType } = req.body
      const clients = clientsFor(req).getEnabled()
      if (clients.length === 0) return res.status(400).json({ error: 'No download clients enabled' })

      const release = { title: title || downloadUrl, downloadUrl }
      const ctx = {
        source: 'manual' as const,
        tabId: req.library?.id,
        tabName: req.library?.name,
        mediaType: mediaType || req.library?.mediaType || 'manual',
        subjectType: 'manual-grab',
        subjectTitle: title || downloadUrl,
      }
      const decision = evaluateRelease(ctx, release)
      const decisionId = recordReleaseDecision(ctx, { ...decision, accepted: true, rejectionReasons: [] })
      const result = await sendToDownloadClient(clients[0], downloadUrl)
      markDecisionGrabbed(decisionId, result)
      res.json(result)
    } catch (err) {
      logger.error('Manual grab failed:', err)
      res.status(500).json({ error: 'Grab failed' })
    }
  })

  return router
}
