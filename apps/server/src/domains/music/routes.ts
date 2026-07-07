import { Router } from 'express'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureArtistFolder, ensureAlbumFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { listAcquisitionHistoryForSubjectIds } from '../../services/acquisition-decisions.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { deleteExistingPath, registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { searchArtists, getArtist, getArtistAlbums, getAlbumTracks } from './musicbrainz.js'
import { getFanartMusic } from './fanart.js'
import { saveEntityImage } from '../../shared/image-save.js'
import { d } from './serialize.js'

const logger = createLogger('Music')

export function createMusicRouter(): Router {
  const router = Router()
  router.use('/music', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))

  registerAcquisitionControls(router, {
    basePath: '/music/albums',
    idParam: 'id',
    mediaType: 'music',
    subjectType: 'album',
    table: 'albums',
    selectSql: `
      SELECT al.*, art.name as artist_name
      FROM albums al JOIN artists art ON al.artist_id = art.id
      WHERE al.id = ? AND art.library_id = ?`,
    title: row => `${row.artist_name} - ${row.title}`,
    deserialise: d,
    repairChildren: (db, row, deleteFiles) => {
      const tracks = db.prepare('SELECT id, file_path FROM tracks WHERE album_id = ?').all(row.id) as Array<{ id: number; file_path?: string | null }>
      if (deleteFiles) tracks.forEach(track => deleteExistingPath(track.file_path))
      db.prepare(`
        UPDATE tracks
        SET status = 'missing',
            file_path = NULL,
            file_size = NULL,
            quality = NULL,
            info_hash = NULL,
            download_progress = 0,
            updated_at = datetime('now')
        WHERE album_id = ?
      `).run(row.id)
    },
  })

  // ── Library ───────────────────────────────────────────────────────────────

  router.get('/music/artists', (req, res) => {
    try {
      const artists = db.prepare(`
        SELECT a.*, COUNT(DISTINCT al.id) as album_count,
          SUM(CASE WHEN al.status='downloaded' THEN 1 ELSE 0 END) as downloaded_albums
        FROM artists a LEFT JOIN albums al ON al.artist_id = a.id
        WHERE a.library_id = ?
        GROUP BY a.id ORDER BY a.sort_name ASC`).all(libId(req))
      res.json((artists as Record<string, unknown>[]).map(d))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/music/artists/:id', (req, res) => {
    try {
      const artist = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!artist) return res.status(404).json({ error: 'Not found' })
      const albums = db.prepare(`
        SELECT al.*, COUNT(t.id) as track_count,
          SUM(CASE WHEN t.status='downloaded' THEN 1 ELSE 0 END) as downloaded_tracks
        FROM albums al LEFT JOIN tracks t ON t.album_id = al.id
        WHERE al.artist_id = ? GROUP BY al.id ORDER BY al.year DESC, al.title ASC`).all(req.params.id)
      res.json({ ...d(artist), albums: (albums as Record<string, unknown>[]).map(d) })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/music/artists', validateBody(domains.AddArtist), async (req, res) => {
    try {
      const { mbid, monitored = true, rootFolderPath, albumTypes = [] } = req.body
      void rootFolderPath
      if (db.prepare('SELECT id FROM artists WHERE library_id = ? AND musicbrainz_id = ?').get(libId(req), mbid)) {
        return res.status(409).json({ error: 'Artist already in library' })
      }
      const artist = await getArtist(mbid)

      const { targetDir: artistDir, imageUrl: localImage, backdropUrl: localBackdrop, logoUrl: localLogo } = await ensureArtistFolder(artist, resolveLibraryRoot(db, libId(req)))

      const result = db.prepare(`INSERT INTO artists (library_id, musicbrainz_id, name, sort_name, overview, disambiguation, genres, album_types, image_url, backdrop_url, logo_url, monitored, root_folder_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        libId(req), artist.id, artist.name, artist.sortName, artist.overview ?? null,
        artist.disambiguation ?? null, JSON.stringify(artist.genres), JSON.stringify(albumTypes),
        localImage ?? artist.imageUrl ?? null, localBackdrop ?? artist.backdropUrl ?? null, localLogo ?? artist.logoUrl ?? null, monitored ? 1 : 0, artistDir)

      const artistId = result.lastInsertRowid as number
      let albums = await getArtistAlbums(mbid)

      if (albumTypes.length > 0) {
        albums = albums.filter(al => albumTypes.includes(al.albumType))
      }

      for (const album of albums) {
        const { coverUrl: localCover, cdartUrl: localCdArt } = await ensureAlbumFolder(artist, album)

        // Unified DB drops the global mbid unique index (same album can exist
        // in two libraries), so upsert per artist explicitly.
        const existing = db.prepare('SELECT id FROM albums WHERE artist_id = ? AND musicbrainz_id = ?').get(artistId, album.id) as { id: number } | undefined
        if (existing) {
          db.prepare(`UPDATE albums SET
            cover_url = COALESCE(?, cover_url),
            cdart_url = COALESCE(?, cdart_url),
            year = COALESCE(?, year)
            WHERE id = ?`).run(localCover ?? null, localCdArt ?? null, album.year ?? null, existing.id)
        } else {
          db.prepare(`INSERT INTO albums (artist_id, musicbrainz_id, title, release_date, year, album_type, genres, cover_url, cdart_url, label, monitored, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`).run(
            artistId, album.id, album.title, album.releaseDate ?? null, album.year ?? null,
            album.albumType, JSON.stringify(album.genres), localCover ?? album.coverUrl ?? null, localCdArt ?? album.cdartUrl ?? null, album.label ?? null)
        }
      }
      const inserted = db.prepare('SELECT * FROM artists WHERE id = ?').get(artistId)
      const insertedAlbums = db.prepare('SELECT * FROM albums WHERE artist_id = ? ORDER BY year DESC').all(artistId)
      res.status(201).json({ ...d(inserted as Record<string, unknown>), albums: (insertedAlbums as Record<string, unknown>[]).map(d) })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/music/artists/:id/metadata', (req, res) => {
    try {
      const { name, overview, disambiguation, genres } = req.body
      const row = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      db.prepare(`
        UPDATE artists SET
          name = COALESCE(@name, name),
          sort_name = COALESCE(@sortName, sort_name),
          overview = COALESCE(@overview, overview),
          disambiguation = COALESCE(@disambiguation, disambiguation),
          genres = COALESCE(@genres, genres),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: row.id,
        name: name ?? null,
        sortName: name ?? null,
        overview: overview ?? null,
        disambiguation: disambiguation ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
      })

      const updated = d(db.prepare('SELECT * FROM artists WHERE id = ?').get(row.id) as Record<string, unknown>) as any

      if (updated.root_folder_path && existsSync(updated.root_folder_path)) {
        try {
          const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<artist>\n  <name>${updated.name}</name>\n  <sortname>${updated.sort_name || ''}</sortname>\n  <disambiguation>${updated.disambiguation || ''}</disambiguation>\n  <biography>${updated.overview || ''}</biography>\n  <genre>${(updated.genres || []).join(' / ')}</genre>\n  <musicbrainzartistid>${updated.musicbrainz_id || ''}</musicbrainzartistid>\n</artist>`
          writeFileSync(join(updated.root_folder_path, 'artist.nfo'), nfo)
        } catch (nfoErr) {
          logger.warn(`Failed to write artist.nfo: ${nfoErr instanceof Error ? nfoErr.message : String(nfoErr)}`)
        }
      }

      res.json(updated)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/music/artists/:id/images', async (req, res) => {
    try {
      const { type } = req.query as { type?: string }
      const row = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      const results: Array<{ url: string; source: string; type: string; language: string }> = []

      if (row.musicbrainz_id) {
        const fanart = await getFanartMusic(row.musicbrainz_id)
        if (fanart) {
          const fanartTypeMap: Record<string, Array<Array<{ url: string }> | undefined>> = {
            poster: [fanart.artistthumb],
            backdrop: [fanart.artistbackground],
            logo: [fanart.hdmusiclogo, fanart.musiclogo],
            banner: [fanart.musicbanner],
          }
          for (const items of fanartTypeMap[type || 'poster'] ?? []) {
            for (const img of (items ?? []).slice(0, 15)) {
              results.push({ url: img.url, source: 'Fanart.tv', type: type || 'poster', language: 'null' })
            }
          }
        }
      }

      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/music/artists/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const row = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })

      const fileMap: Record<string, string> = { poster: 'folder.jpg', backdrop: 'backdrop.jpg', logo: 'logo.png', banner: 'banner.jpg' }
      const dbCol: Record<string, string> = { poster: 'image_url', backdrop: 'backdrop_url', logo: 'logo_url' }
      if (!fileMap[type]) return res.status(400).json({ error: `Unknown image type: ${type}` })

      const saved = await saveEntityImage(row.root_folder_path, fileMap[type], url)
      if (dbCol[type]) {
        db.prepare(`UPDATE artists SET ${dbCol[type]} = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, row.id)
      }
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/music/artists/:id/acquisition-history', (req, res) => {
    try {
      const container = db.prepare('SELECT id FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req))
      if (!container) return res.status(404).json({ error: 'Not found' })
      const childIds = (db.prepare('SELECT id FROM albums WHERE artist_id = ?').all(req.params.id) as Array<{ id: number }>).map(r => r.id)
      res.json(listAcquisitionHistoryForSubjectIds({ mediaType: 'music', subjectType: 'album', subjectIds: childIds }))
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.delete('/music/artists/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const row = db.prepare('SELECT root_folder_path FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (row && deleteFiles) safeDeleteMediaPath(row.root_folder_path)
      db.prepare('DELETE FROM artists WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/music/refresh', (req, res) => {
    try {
      const artists = db.prepare('SELECT id, musicbrainz_id, album_types FROM artists WHERE library_id = ?').all(libId(req)) as any[]
      logger.info(`Starting music refresh for ${artists.length} artists...`)

      res.json({ success: true, message: `Refresh started for ${artists.length} artists in background.` })

      ;(async () => {
        for (const a of artists) {
          try {
            const artistData = await getArtist(a.musicbrainz_id)
            const { imageUrl: localImage, backdropUrl: localBackdrop, logoUrl: localLogo } = await ensureArtistFolder(artistData, resolveLibraryRoot(db, libId(req)))

            db.prepare('UPDATE artists SET image_url = COALESCE(?, image_url), backdrop_url = COALESCE(?, backdrop_url), logo_url = COALESCE(?, logo_url), updated_at = datetime(\'now\') WHERE id = ?')
              .run(localImage ?? null, localBackdrop ?? null, localLogo ?? null, a.id)

            let mbAlbums = await getArtistAlbums(a.musicbrainz_id)
            const types = JSON.parse(a.album_types || '[]')
            if (types.length > 0) {
              mbAlbums = mbAlbums.filter(al => types.includes(al.albumType))
            }

            for (const album of mbAlbums) {
              const { coverUrl: localCover, cdartUrl: localCdArt } = await ensureAlbumFolder(artistData, album)

              const existing = db.prepare('SELECT id FROM albums WHERE artist_id = ? AND musicbrainz_id = ?').get(a.id, album.id) as { id: number } | undefined
              if (existing) {
                db.prepare(`UPDATE albums SET
                  cover_url = COALESCE(?, cover_url),
                  cdart_url = COALESCE(?, cdart_url),
                  year = COALESCE(?, year),
                  release_date = COALESCE(?, release_date)
                  WHERE id = ?`).run(localCover ?? null, localCdArt ?? null, album.year ?? null, album.releaseDate ?? null, existing.id)
              } else {
                db.prepare(`INSERT INTO albums (artist_id, musicbrainz_id, title, release_date, year, album_type, genres, cover_url, cdart_url, label, monitored, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`).run(
                  a.id, album.id, album.title, album.releaseDate ?? null, album.year ?? null,
                  album.albumType, JSON.stringify(album.genres), localCover ?? album.coverUrl ?? null, localCdArt ?? album.cdartUrl ?? null, album.label ?? null)
              }
            }
          } catch (err) {
            logger.warn(`Failed to refresh artist id=${a.id}:`, err)
          }
        }
        logger.info('Music refresh complete.')
      })().catch(err => logger.error('Background music refresh error:', err))
    } catch (err) {
      res.status(500).json({ error: 'Failed to start music refresh' })
    }
  })

  router.get('/music/albums/:id', async (req, res) => {
    try {
      const album = db.prepare(`
        SELECT al.* FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`).get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!album) return res.status(404).json({ error: 'Not found' })
      let tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number').all(album.id)

      if (!tracks.length && album.musicbrainz_id) {
        try {
          const mbTracks = await getAlbumTracks(album.musicbrainz_id as string)
          for (const t of mbTracks) {
            db.prepare(`INSERT OR IGNORE INTO tracks (album_id, artist_id, musicbrainz_id, title, track_number, disc_number, duration, monitored, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'missing')`).run(
              album.id, album.artist_id, t.id, t.title, t.trackNumber, t.discNumber, t.duration ?? null)
          }
          tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number').all(album.id)
        } catch (err) {
          logger.warn(`Failed to fetch tracks for album id=${req.params.id}:`, err instanceof Error ? err.message : String(err))
        }
      }
      res.json({ ...d(album), tracks })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/music/albums/:id', validateBody(domains.UpdateAlbum), (req, res) => {
    try {
      const { monitored, status, upgrade_allowed, target_tier } = req.body
      const album = db.prepare(`
        SELECT al.id FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`).get(req.params.id, libId(req)) as { id: number } | undefined
      if (!album) return res.status(404).json({ error: 'Not found' })
      db.prepare(`UPDATE albums SET monitored = COALESCE(@monitored, monitored), status = COALESCE(@status, status), upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed), target_tier = COALESCE(@targetTier, target_tier), updated_at = datetime('now') WHERE id = @id`)
        .run({ id: album.id, monitored: monitored !== undefined ? (monitored ? 1 : 0) : null, status: status ?? null, upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null, targetTier: target_tier ?? null })
      res.json(d(db.prepare('SELECT * FROM albums WHERE id = ?').get(album.id) as Record<string, unknown>))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/music/lookup', async (req, res) => {
    try {
      const { q } = req.query
      if (!q) return res.status(400).json({ error: 'q required' })

      const results = await searchArtists(String(q))
      const artists = results.map(a => ({
        ...a,
        alreadyAdded: !!db.prepare('SELECT id FROM artists WHERE library_id = ? AND musicbrainz_id = ?').get(libId(req), a.mbid),
      }))
      res.json(artists)
    } catch (err) {
      logger.warn('MusicBrainz lookup failed:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: err instanceof Error ? err.message : 'MusicBrainz lookup failed' })
    }
  })

  router.get('/music/lookup/:mbid', async (req, res) => {
    try {
      res.json(await getArtist(req.params.mbid))
    } catch (err) {
      res.status(500).json({ error: 'MusicBrainz artist lookup failed' })
    }
  })

  router.post('/music/albums/:id/auto-grab', async (req, res) => {
    try {
      const album = db.prepare(`
        SELECT al.*, art.name as artistName
        FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`).get(req.params.id, libId(req)) as any
      if (!album) return res.status(404).json({ error: 'Album not found' })

      const query = `${album.artistName} ${album.title}`
      logger.info(`Auto-grabbing album: ${query}`)

      const enabledIndexers = getEnabledIndexerInstances()
      const results = await searchViaIndexers(enabledIndexers, query, { categories: [3000], type: 'music', module: 'music' })

      if (results.length === 0) {
        return res.json({ success: false, message: 'No releases found' })
      }

      const sorted = results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      const best = sorted[0]

      const client = clientsFor(req).getEnabled()[0]
      if (!client) return res.status(400).json({ error: 'No download client enabled' })

      const result = await sendToDownloadClient(client, best.downloadUrl, 'archivist-music')
      if (result.success) {
        const infoHash = (result as any).infoHash ?? null
        db.prepare("UPDATE albums SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(infoHash, album.id)
        db.prepare("UPDATE tracks SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE album_id = ? AND status = 'missing'").run(infoHash, album.id)
      }

      res.json({ success: true, message: `Started downloading: ${best.title}` })
    } catch (err) {
      logger.error('Music auto-grab failed:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/music/download', validateBody(domains.DownloadMusic.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, albumId } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      try {
        const result = await sendToDownloadClient(client, downloadUrl, 'archivist-music')

        if (result.success && albumId) {
          const infoHash = (result as any).infoHash ?? null
          db.prepare("UPDATE albums SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(infoHash, albumId)
          db.prepare("UPDATE tracks SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE album_id = ? AND status = 'missing'").run(infoHash, albumId)
        }
        res.json(result)
      } catch (err) {
        res.status(500).json({ success: false, message: String(err) })
      }
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  return router
}
