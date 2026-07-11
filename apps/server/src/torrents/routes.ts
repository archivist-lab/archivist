import { Router } from 'express'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { blockRelease } from '../services/acquisition-decisions.js'
import {
  baseImportMediaType,
  createImportPlan,
  getTorrentMatchOverride,
  ignoreStagedDownload,
  isIgnoredStagedDownload,
  purgeMediaImportReferences,
  setTorrentMatchOverride,
  type MatchMediaType,
  type MediaImportPayload,
} from '../services/media-imports.js'

const logger = createLogger('Torrents')

function downloadDir() {
  return resolve(process.env.TORRENT_DOWNLOAD_DIR ?? './downloads/complete')
}

function orphanId(sourcePath: string) {
  return `orphan:${Buffer.from(resolve(sourcePath)).toString('base64url')}`
}

function sourcePathFromOrphanId(id: string) {
  if (!id.startsWith('orphan:')) return null
  try { return Buffer.from(id.slice('orphan:'.length), 'base64url').toString('utf8') } catch { return null }
}

function pathSize(sourcePath: string): number {
  const stat = statSync(sourcePath)
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0

  let total = 0
  for (const entry of readdirSync(sourcePath)) {
    try {
      total += pathSize(join(sourcePath, entry))
    } catch {
      // Files can disappear while the download/import UI is being refreshed.
    }
  }
  return total
}

function orphanTorrent(sourcePath: string) {
  const stat = statSync(sourcePath)
  const sizeBytes = pathSize(sourcePath)
  return {
    id: orphanId(sourcePath),
    infoHash: '',
    name: basename(sourcePath),
    status: 'orphaned',
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    downloadedBytes: sizeBytes,
    uploadedBytes: 0,
    sizeBytes,
    eta: -1,
    uploadRatio: 0,
    peersConnected: 0,
    peersSeen: 0,
    downloadDir: sourcePath,
    addedAt: stat.mtimeMs,
    completedAt: null,
    isPrivate: false,
    error: null,
    labels: ['leftover-files'],
    queuePosition: Number.MAX_SAFE_INTEGER,
    bandwidthPriority: 'normal',
    stalledReason: 'leftover files are not attached to an active torrent',
    sourcePath,
    orphaned: true,
  }
}

/** Reset acquiring items that referenced a deleted torrent — one pass over the unified DB. */
function clearDeletedAcquisition(infoHash: string | null | undefined) {
  if (!infoHash) return
  const hash = infoHash.toLowerCase()
  const db = getDb()
  try {
    db.prepare(`
      UPDATE films
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'wanted', 'missing')
    `).run(hash)
    db.prepare(`
      UPDATE episodes
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')
    `).run(hash)
    db.prepare(`
      UPDATE albums
      SET status = 'missing', info_hash = NULL, updated_at = datetime('now')
      WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'wanted', 'missing')
    `).run(hash)
    db.prepare(`
      UPDATE games
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')
    `).run(hash)
    db.prepare(`
      UPDATE comic_issues
      SET status = 'missing', info_hash = NULL, updated_at = datetime('now')
      WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')
    `).run(hash)
  } catch (err) {
    logger.warn(`Could not clear deleted acquisition: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const MATCH_MEDIA_TYPES = new Set<MatchMediaType>([
  'films',
  'series',
  'series-season',
  'series-episode',
  'music',
  'music-album',
  'music-discography',
  'games',
  'comics',
  'comics-issue',
  'comics-volume',
])

function activeTorrentSource(torrent: any) {
  return resolve(join(torrent.downloadDir, torrent.name))
}

function resolveTorrentForMatch(id: string) {
  const sourcePath = sourcePathFromOrphanId(id)
  if (sourcePath) {
    if (!existsSync(sourcePath) || isIgnoredStagedDownload(sourcePath)) return null
    const orphan = orphanTorrent(sourcePath)
    return { torrent: orphan, sourcePath, infoHash: '', name: orphan.name }
  }
  const torrent = getTorrentSession().getTorrent(id) as any
  if (!torrent) return null
  return { torrent, sourcePath: activeTorrentSource(torrent), infoHash: torrent.infoHash ?? '', name: torrent.name ?? id }
}

function applyMatchToLibrary(mediaType: MatchMediaType, itemId: number, infoHash: string) {
  if (!infoHash) return
  const hash = infoHash.toLowerCase()
  const db = getDb()

  if (mediaType === 'films') {
    db.prepare("UPDATE films SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, itemId)
  } else if (mediaType === 'series-episode') {
    db.prepare("UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, itemId)
  } else if (mediaType === 'series-season') {
    const season = db.prepare('SELECT series_id, season_number FROM seasons WHERE id = ?').get(itemId) as any
    if (!season) throw new Error(`Season ${itemId} not found`)
    db.prepare("UPDATE seasons SET info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, itemId)
    db.prepare(`
      UPDATE episodes
      SET status = 'acquiring', info_hash = ?, updated_at = datetime('now')
      WHERE series_id = ? AND season_number = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(hash, season.series_id, season.season_number)
  } else if (mediaType === 'series') {
    db.prepare("UPDATE seasons SET info_hash = ?, updated_at = datetime('now') WHERE series_id = ?").run(hash, itemId)
    db.prepare(`
      UPDATE episodes
      SET status = 'acquiring', info_hash = ?, updated_at = datetime('now')
      WHERE series_id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(hash, itemId)
  } else if (mediaType === 'music' || mediaType === 'music-album') {
    db.prepare("UPDATE albums SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, itemId)
    db.prepare("UPDATE tracks SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE album_id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')").run(hash, itemId)
  } else if (mediaType === 'music-discography') {
    db.prepare("UPDATE albums SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE artist_id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')").run(hash, itemId)
    db.prepare(`
      UPDATE tracks
      SET status = 'acquiring', info_hash = ?, updated_at = datetime('now')
      WHERE album_id IN (SELECT id FROM albums WHERE artist_id = ?)
        AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(hash, itemId)
  } else if (mediaType === 'games') {
    db.prepare("UPDATE games SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, itemId)
  } else if (mediaType === 'comics' || mediaType === 'comics-issue') {
    db.prepare("UPDATE comic_issues SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, itemId)
  } else if (mediaType === 'comics-volume') {
    db.prepare("UPDATE comic_issues SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE series_id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')").run(hash, itemId)
  }
}

export function createTorrentsRouter(): Router {
  const router = Router()

  router.get('/torrents', (_req, res) => {
    try {
      const torrents = getTorrentSession().getAllTorrents()
      const livePaths = new Set(torrents.map((t: any) => resolve(join(t.downloadDir, t.name))))
      const dir = downloadDir()
      const orphans = existsSync(dir)
        ? readdirSync(dir)
            .map(name => resolve(join(dir, name)))
            .filter(path => !livePaths.has(path) && !isIgnoredStagedDownload(path))
            .map(path => {
              try { return orphanTorrent(path) } catch { return null }
            })
            .filter(Boolean)
        : []
      res.json([...torrents, ...orphans])
    } catch (err) {
      logger.error(`list failed: ${err instanceof Error ? err.message : String(err)}`)
      res.json([])
    }
  })

  router.get('/torrents/network', (_req, res) => {
    try {
      const session = getTorrentSession() as any
      const network = session.getNetworkDiagnostics ? session.getNetworkDiagnostics() : null
      if (!network) return res.json(null)
      res.json({
        web: {
          host: process.env.ARCHIVIST_HOST || process.env.HOST || '0.0.0.0',
          port: parseInt(process.env.ARCHIVIST_PORT || process.env.PORT || '2424', 10),
        },
        ...network,
      })
    } catch {
      res.json(null)
    }
  })

  router.post('/torrents/reorder', async (req, res) => {
    try {
      const { orderedIds } = req.body ?? {}
      if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, error: 'orderedIds must be an array' })
      await getTorrentSession().reorderTorrents(orderedIds.filter((id): id is string => typeof id === 'string'))
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.get('/torrents/:id', (req, res) => {
    const sourcePath = sourcePathFromOrphanId(req.params.id)
    if (sourcePath) {
      if (!existsSync(sourcePath) || isIgnoredStagedDownload(sourcePath)) return res.status(404).json({ error: 'Not found' })
      return res.json(orphanTorrent(sourcePath))
    }
    const t = getTorrentSession().getTorrent(req.params.id)
    if (!t) return res.status(404).json({ error: 'Not found' })
    res.json(t)
  })

  router.get('/torrents/:id/acquisition-match', (req, res) => {
    try {
      const resolved = resolveTorrentForMatch(req.params.id)
      if (!resolved) return res.status(404).json({ error: 'Not found' })
      const match = getTorrentMatchOverride({
        torrentId: req.params.id,
        infoHash: resolved.infoHash,
        sourcePath: resolved.sourcePath,
      })
      res.json({ match })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.get('/torrents/:id/import-plan', (req, res) => {
    try {
      const resolved = resolveTorrentForMatch(req.params.id)
      if (!resolved) return res.status(404).json({ error: 'Not found' })
      const match = getTorrentMatchOverride({
        torrentId: req.params.id,
        infoHash: resolved.infoHash,
        sourcePath: resolved.sourcePath,
      })
      if (!match) return res.json({ plan: null })
      const payload: MediaImportPayload = {
        tabId: match.tabId,
        tabName: match.tabName,
        dbPath: match.dbPath,
        mediaType: match.mediaType,
        itemId: match.itemId,
        torrentId: req.params.id,
        infoHash: resolved.infoHash,
        sourcePath: resolved.sourcePath,
        releaseTitle: resolved.name,
      }
      res.json({ plan: createImportPlan(payload, getDb(), resolved.sourcePath, resolved.torrent.files) })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/torrents/:id/acquisition-match', (req, res) => {
    try {
      const resolved = resolveTorrentForMatch(req.params.id)
      if (!resolved) return res.status(404).json({ error: 'Not found' })
      const body = req.body ?? {}
      const mediaType = body.mediaType as MatchMediaType
      if (!MATCH_MEDIA_TYPES.has(mediaType)) return res.status(400).json({ error: 'Unsupported mediaType' })
      const itemId = Number(body.itemId)
      const tabId = Number(body.tabId)
      if (!Number.isFinite(itemId) || !Number.isFinite(tabId)) return res.status(400).json({ error: 'Invalid tabId or itemId' })

      const library = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(tabId) as any
      if (!library) return res.status(400).json({ error: 'Tab not found' })
      if (library.media_type !== baseImportMediaType(mediaType)) {
        return res.status(400).json({ error: `Match type ${mediaType} does not belong to ${library.media_type}` })
      }

      applyMatchToLibrary(mediaType, itemId, resolved.infoHash)

      const match = setTorrentMatchOverride({
        torrentId: req.params.id,
        infoHash: resolved.infoHash,
        sourcePath: resolved.sourcePath,
        name: resolved.name,
        tabId: library.id,
        tabName: library.name,
        dbPath: library.db_path,
        mediaType,
        itemId,
        title: String(body.title ?? resolved.name),
        subtitle: body.subtitle == null ? null : String(body.subtitle),
        status: body.status == null ? null : String(body.status),
        score: Number(body.score ?? 100),
      })

      res.json({ match })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.get('/torrents/:id/diagnostics', (req, res) => {
    const t = getTorrentSession().getTorrent(req.params.id)
    if (!t) return res.status(404).json({ error: 'Not found' })
    res.json({
      id: t.id,
      name: t.name,
      status: t.status,
      stalledReason: t.stalledReason ?? null,
      speeds: { download: t.downloadSpeed, upload: t.uploadSpeed },
      peers: {
        connected: t.peersConnected,
        seen: t.peersSeen,
        seedsConnected: t.seedsConnected,
        sendingToUs: t.peersSendingToUs,
        gettingFromUs: t.peersGettingFromUs,
      },
      peerDetails: t.peers ?? [],
      swarmDiagnostics: (t as any).diagnostics ?? null,
      trackers: t.trackers ?? [],
      progress: {
        progress: t.progress,
        downloadedBytes: t.downloadedBytes,
        leftBytes: t.leftBytes,
        corruptBytes: t.corruptBytes,
      },
      queue: {
        position: t.queuePosition,
        priority: t.bandwidthPriority,
      },
    })
  })

  router.post('/torrents', async (req, res) => {
    try {
      const { magnetLink, torrentUrl, labels } = req.body ?? {}
      if (typeof magnetLink !== 'string' && typeof torrentUrl !== 'string') {
        return res.status(400).json({ success: false, error: 'Provide magnetLink or torrentUrl' })
      }
      const id = await getTorrentSession().addTorrent({
        magnetLink: typeof magnetLink === 'string' ? magnetLink : undefined,
        torrentUrl: typeof torrentUrl === 'string' ? torrentUrl : undefined,
        labels: Array.isArray(labels) ? labels : undefined,
      })
      res.status(201).json({ success: true, id })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/torrents/bulk-action', async (req, res) => {
    try {
      const { ids, action, deleteData } = req.body ?? {}
      if (!Array.isArray(ids)) return res.status(400).json({ success: false, error: 'ids must be an array' })

      const results = []
      for (const id of ids) {
        try {
          if (action === 'remove') {
            const sourcePath = sourcePathFromOrphanId(id)
            if (sourcePath) {
              purgeMediaImportReferences({ sourcePath })
              if (deleteData) rmSync(sourcePath, { recursive: true, force: true })
              else ignoreStagedDownload(sourcePath, 'removed')
            } else {
              const torrent = getTorrentSession().getTorrent(id) as any
              const stagedPath = torrent ? resolve(join(torrent.downloadDir, torrent.name)) : null
              await getTorrentSession().removeTorrent(id, !!deleteData)
              purgeMediaImportReferences({ torrentId: id, infoHash: torrent?.infoHash ?? null, sourcePath: stagedPath })
              if (torrent?.infoHash) {
                blockRelease({
                  infoHash: torrent.infoHash,
                  releaseTitle: torrent.name ?? torrent.infoHash,
                  reason: deleteData ? 'user-deleted-download' : 'user-removed-download',
                })
                clearDeletedAcquisition(torrent.infoHash)
              }
              if (stagedPath && !deleteData) ignoreStagedDownload(stagedPath, 'removed')
            }
            results.push({ id, success: true })
          } else if (action === 'start') {
            await getTorrentSession().startTorrent(id, [], false)
            results.push({ id, success: true })
          } else if (action === 'stop') {
            await getTorrentSession().stopTorrent(id)
            results.push({ id, success: true })
          }
        } catch (err) {
          results.push({ id, success: false, error: err instanceof Error ? err.message : String(err) })
        }
      }
      res.json({ success: true, results })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.delete('/torrents/:id', async (req, res) => {
    try {
      const deleteData = req.query.deleteData === 'true'
      const sourcePath = sourcePathFromOrphanId(req.params.id)
      if (sourcePath) {
        purgeMediaImportReferences({ sourcePath })
        if (deleteData) rmSync(sourcePath, { recursive: true, force: true })
        else ignoreStagedDownload(sourcePath, 'removed')
        return res.json({ success: true })
      }

      const torrent = getTorrentSession().getTorrent(req.params.id) as any
      const stagedPath = torrent ? resolve(join(torrent.downloadDir, torrent.name)) : null
      await getTorrentSession().removeTorrent(req.params.id, deleteData)
      purgeMediaImportReferences({ torrentId: req.params.id, infoHash: torrent?.infoHash ?? null, sourcePath: stagedPath })
      if (torrent?.infoHash) {
        blockRelease({
          infoHash: torrent.infoHash,
          releaseTitle: torrent.name ?? torrent.infoHash,
          reason: deleteData ? 'user-deleted-download' : 'user-removed-download',
        })
        clearDeletedAcquisition(torrent.infoHash)
      }
      if (stagedPath && !deleteData) ignoreStagedDownload(stagedPath, 'removed')
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/torrents/:id/start', async (req, res) => {
    try {
      await getTorrentSession().startTorrent(req.params.id, [], req.query.now === 'true')
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/torrents/:id/stop', async (req, res) => {
    try {
      await getTorrentSession().stopTorrent(req.params.id)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/torrents/:id/recheck', async (req, res) => {
    try {
      await getTorrentSession().verifyTorrent(req.params.id)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/torrents/:id/reannounce', async (req, res) => {
    try {
      await getTorrentSession().reannounceTorrent(req.params.id)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.patch('/torrents/:id/priority', async (req, res) => {
    try {
      const priority = req.body?.bandwidthPriority
      if (!['low', 'normal', 'high'].includes(priority)) {
        return res.status(400).json({ success: false, error: 'bandwidthPriority must be low, normal, or high' })
      }
      await getTorrentSession().setTorrentPriority(req.params.id, priority)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.patch('/torrents/:id/files', async (req, res) => {
    try {
      const updates = req.body?.updates
      if (!Array.isArray(updates)) return res.status(400).json({ success: false, error: 'updates must be an array' })
      await getTorrentSession().setFilePriorities(req.params.id, updates)
      res.json({ success: true })
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  return router
}
