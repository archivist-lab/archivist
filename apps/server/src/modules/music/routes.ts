import { Router } from 'express'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from '@archivist/core'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendMusicReleaseToDownloadClient, sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureArtistFolder, ensureAlbumFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import {
  evaluateRelease,
  extractInfoHash,
  listAcquisitionHistoryForSubjectIds,
  markDecisionGrabbed,
  recordReleaseDecision,
} from '../../services/acquisition-decisions.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { rankAlbumReleases, rankMusicReleases } from '../../release-pipeline/music-quality.js'
import { musicQualityRung } from '@archivist/contracts'
import { deleteExistingPath, registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { searchArtists, getArtist, getArtistAlbums } from './musicbrainz.js'
import { getAlbumCovers, getFanartMusic } from './fanart.js'
import { saveEntityImage } from '../../shared/image-save.js'
import { d } from './serialize.js'
import { recordEvent } from '../../system/event-store.js'
import { decideAlbum } from '../../release-pipeline/subject-decisions.js'
import { parseRelease } from '../../release-pipeline/parser.js'
import {
  albumReleases,
  albumReleaseScope,
  ensureAlbumTrackMetadata,
  selectAlbumRelease,
  selectedAlbumRelease,
  selectedAlbumReleasesForArtist,
} from '../../services/music-metadata.js'
import { getTorrentSession } from '../../services/torrent-session.js'
import { withMusicSwarmEvidence } from '../../services/music-swarm.js'

const logger = createLogger('Music')

/**
 * Albums Archivist never removes on its own: files are on disk, or a download
 * is in flight. Deselecting a release type has always respected this; an album
 * selection has to respect it too, or unticking a box would orphan files.
 */
const PROTECTED_ALBUM_STATUSES = new Set(['collected', 'downloaded', 'acquiring', 'downloading'])

export function createMusicRouter(): Router {
  const router = Router()
  router.use('/music', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))
  const releaseSummary = <T extends { tracks?: unknown[] }>(release: T | null | undefined) => {
    if (!release) return null
    const { tracks: _tracks, ...summary } = release
    return summary
  }

  const torrentStatusByHash = (): Map<string, string> => {
    try {
      return new Map(
        getTorrentSession()
          .getAllTorrents()
          .filter((torrent: any) => torrent.infoHash)
          .map((torrent: any) => [String(torrent.infoHash).toLowerCase(), String(torrent.status)]),
      )
    } catch {
      return new Map()
    }
  }

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
      const artists = db
        .prepare(`
        SELECT a.*, COUNT(DISTINCT al.id) as album_count,
          SUM(CASE WHEN al.status IN ('collected','downloaded') THEN 1 ELSE 0 END) as downloaded_albums,
          SUM(CASE WHEN al.status IN ('acquiring','downloading') THEN 1 ELSE 0 END) as acquiring_albums
        FROM artists a LEFT JOIN albums al ON al.artist_id = a.id
        WHERE a.library_id = ?
        GROUP BY a.id ORDER BY a.sort_name ASC`)
        .all(libId(req))
      res.json((artists as Record<string, unknown>[]).map(d))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/music/artists/:id', (req, res) => {
    try {
      const artist = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!artist) return res.status(404).json({ error: 'Not found' })
      const albums = db
        .prepare(`
        SELECT al.*, COUNT(t.id) as track_count,
          SUM(CASE WHEN t.status IN ('collected','downloaded') THEN 1 ELSE 0 END) as downloaded_tracks
        FROM albums al LEFT JOIN tracks t ON t.album_id = al.id
        WHERE al.artist_id = ? GROUP BY al.id ORDER BY al.year DESC, al.title ASC`)
        .all(req.params.id)
      const torrentStatuses = torrentStatusByHash()
      const selectedReleases = selectedAlbumReleasesForArtist(db, Number(artist.id))
      const serialisedArtist = d(artist)
      const discographyHash = typeof artist.discography_info_hash === 'string' ? artist.discography_info_hash.toLowerCase() : null
      res.json({
        ...serialisedArtist,
        discography_torrent_status: discographyHash ? (torrentStatuses.get(discographyHash) ?? null) : null,
        albums: (albums as Record<string, unknown>[]).map(row => {
          const serialised = d(row)
          const hash =
            typeof row.info_hash === 'string'
              ? row.info_hash.toLowerCase()
              : typeof row.discography_info_hash === 'string'
                ? row.discography_info_hash.toLowerCase()
                : null
          return {
            ...serialised,
            selected_release: releaseSummary(selectedReleases.get(Number(row.id))),
            torrent_status: hash ? (torrentStatuses.get(hash) ?? null) : null,
          }
        }),
      })
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

      const {
        targetDir: artistDir,
        imageUrl: localImage,
        backdropUrl: localBackdrop,
        logoUrl: localLogo,
      } = await ensureArtistFolder(artist, resolveLibraryRoot(db, libId(req)))

      const result = db
        .prepare(`INSERT INTO artists (library_id, musicbrainz_id, name, sort_name, overview, disambiguation, genres, album_types, members, image_url, backdrop_url, logo_url, monitored, root_folder_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          libId(req),
          artist.id,
          artist.name,
          artist.sortName,
          artist.overview ?? null,
          artist.disambiguation ?? null,
          JSON.stringify(artist.genres),
          JSON.stringify(albumTypes),
          JSON.stringify(artist.members ?? []),
          localImage ?? artist.imageUrl ?? null,
          localBackdrop ?? artist.backdropUrl ?? null,
          localLogo ?? artist.logoUrl ?? null,
          monitored ? 1 : 0,
          artistDir,
        )

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
            artistId,
            album.id,
            album.title,
            album.releaseDate ?? null,
            album.year ?? null,
            album.albumType,
            JSON.stringify(album.genres),
            localCover ?? album.coverUrl ?? null,
            localCdArt ?? album.cdartUrl ?? null,
            album.label ?? null,
          )
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
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // Artist-level monitoring, the counterpart of the series toggle. Cascades to
  // albums so switching an artist off does not leave its albums armed.
  router.put('/music/artists/:id', validateBody(domains.UpdateArtist), (req, res) => {
    try {
      const artist = db.prepare('SELECT id, monitored FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as
        | { id: number; monitored: number }
        | undefined
      if (!artist) return res.status(404).json({ error: 'Not found' })

      const body = req.body as Record<string, unknown>
      const { monitored, albumTypes } = body as { monitored?: boolean; albumTypes?: string[] }
      if (monitored !== undefined) {
        db.prepare("UPDATE artists SET monitored = ?, updated_at = datetime('now') WHERE id = ?").run(monitored ? 1 : 0, artist.id)
        db.prepare("UPDATE albums SET monitored = ?, updated_at = datetime('now') WHERE artist_id = ?").run(monitored ? 1 : 0, artist.id)
      }
      if (albumTypes !== undefined) {
        db.prepare("UPDATE artists SET album_types = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(albumTypes), artist.id)
      }

      // The quality profile is artist-wide. It is stored on the artist as the
      // source of truth and mirrored onto every album, so the grabber — which
      // reads the album row — needs no special case.
      const POLICY: Record<string, string> = {
        upgrade_allowed: 'upgrade_allowed',
        target_tier: 'target_tier',
        target_resolution: 'target_resolution',
        target_codec: 'target_codec',
        minimum_tier: 'minimum_tier',
        minimum_resolution: 'minimum_resolution',
        minimum_codec: 'minimum_codec',
      }
      const sets: string[] = []
      const values: unknown[] = []
      for (const [key, column] of Object.entries(POLICY)) {
        if (!(key in body)) continue
        const value = typeof body[key] === 'boolean' ? (body[key] ? 1 : 0) : (body[key] ?? null)
        sets.push(`${column} = ?`)
        values.push(value)
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE artists SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, artist.id)
        db.prepare(`UPDATE albums SET ${sets.join(', ')}, updated_at = datetime('now') WHERE artist_id = ?`).run(...values, artist.id)
      }
      res.json(db.prepare('SELECT * FROM artists WHERE id = ?').get(artist.id))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
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

  /**
   * Re-syncs one artist's releases from MusicBrainz, optionally changing which
   * types are tracked. Deselecting a type removes its albums — but never one
   * that has been collected, because that would orphan files already on disk.
   */
  /**
   * The albums MusicBrainz lists for an artist under the given types, each
   * annotated with what the library already knows. Feeds the second step of
   * the Releases dialog, where the operator picks albums rather than accepting
   * everything a type brings with it.
   */
  router.get('/music/artists/:id/release-candidates', async (req, res) => {
    try {
      const artist = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!artist) return res.status(404).json({ error: 'Not found' })

      const types = String(req.query.types ?? '')
        .split(',')
        .map(type => type.trim())
        .filter(Boolean)

      let mbAlbums = await getArtistAlbums(artist.musicbrainz_id)
      if (types.length > 0) mbAlbums = mbAlbums.filter(album => types.includes(album.albumType))

      const existing = new Map(
        (db.prepare('SELECT musicbrainz_id, status FROM albums WHERE artist_id = ?').all(artist.id) as Array<{
          musicbrainz_id: string
          status: string | null
        }>).map(row => [row.musicbrainz_id, row.status ?? '']),
      )
      const removed = new Set(
        (db.prepare('SELECT musicbrainz_id FROM album_removals WHERE artist_id = ?').all(artist.id) as Array<{ musicbrainz_id: string }>)
          .map(row => row.musicbrainz_id),
      )

      res.json({
        candidates: mbAlbums.map(album => ({
          musicbrainzId: album.id,
          title: album.title,
          year: album.year ?? null,
          albumType: album.albumType,
          inLibrary: existing.has(album.id),
          removed: removed.has(album.id),
          // Files on disk or a download in flight: offered as already present,
          // but never taken away by a selection.
          locked: PROTECTED_ALBUM_STATUSES.has(existing.get(album.id) ?? ''),
        })),
      })
    } catch (err) {
      logger.error('Release candidates failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/music/artists/:id/refresh', validateBody(domains.RefreshArtist), async (req, res) => {
    try {
      const artist = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!artist) return res.status(404).json({ error: 'Not found' })

      const { albumTypes, restoreRemoved, selectedAlbumIds } = req.body as {
        albumTypes?: string[]
        restoreRemoved?: boolean
        selectedAlbumIds?: string[]
      }
      // Present means the operator chose album by album; absent means "whatever
      // the types bring", which is the behaviour that predates the picker.
      const selection = Array.isArray(selectedAlbumIds) ? new Set(selectedAlbumIds) : null
      // Captured before the update: a type the artist was not tracking a moment
      // ago is one the operator has just asked for, so it populates even when
      // removed albums are being kept out.
      const previousTypes: string[] = JSON.parse(artist.album_types || '[]')
      if (albumTypes !== undefined) {
        db.prepare("UPDATE artists SET album_types = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(albumTypes), artist.id)
        artist.album_types = JSON.stringify(albumTypes)
      }

      const types: string[] = JSON.parse(artist.album_types || '[]')
      const newlyEnabled = new Set(types.filter(type => !previousTypes.includes(type)))

      // Restoring means forgetting the removals, so later refreshes keep the
      // albums rather than dropping them again on the next pass.
      if (restoreRemoved === true) db.prepare('DELETE FROM album_removals WHERE artist_id = ?').run(artist.id)
      const removedIds = new Set(
        (db.prepare('SELECT musicbrainz_id FROM album_removals WHERE artist_id = ?').all(artist.id) as Array<{ musicbrainz_id: string }>)
          .map(row => row.musicbrainz_id),
      )
      const artistData = await getArtist(artist.musicbrainz_id)
      db.prepare("UPDATE artists SET members = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(artistData.members ?? []), artist.id)
      let mbAlbums = await getArtistAlbums(artist.musicbrainz_id)
      if (types.length > 0) mbAlbums = mbAlbums.filter(al => types.includes(al.albumType))

      let added = 0
      let skipped = 0
      let deselected = 0
      for (const album of mbAlbums) {
        const { coverUrl: localCover, cdartUrl: localCdArt } = await ensureAlbumFolder(artistData, album)
        const existing = db.prepare('SELECT id, status FROM albums WHERE artist_id = ? AND musicbrainz_id = ?').get(artist.id, album.id) as
          | { id: number; status: string | null }
          | undefined

        if (existing && selection && !selection.has(album.id) && !PROTECTED_ALBUM_STATUSES.has(existing.status ?? '')) {
          // Present but unticked: the selection is authoritative, so it goes —
          // tombstoned like any other removal so a later refresh respects it.
          db.prepare('DELETE FROM albums WHERE id = ?').run(existing.id)
          db.prepare(`
            INSERT INTO album_removals (artist_id, musicbrainz_id, album_title, album_type, removed_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(artist_id, musicbrainz_id) DO UPDATE SET removed_at = excluded.removed_at
          `).run(artist.id, album.id, album.title, album.albumType, Date.now())
          deselected += 1
          continue
        }

        if (existing) {
          db.prepare(`UPDATE albums SET
            cover_url = COALESCE(?, cover_url), cdart_url = COALESCE(?, cdart_url),
            year = COALESCE(?, year), release_date = COALESCE(?, release_date)
            WHERE id = ?`).run(localCover ?? null, localCdArt ?? null, album.year ?? null, album.releaseDate ?? null, existing.id)
        } else if (
          selection
            ? selection.has(album.id)
            : restoreRemoved === true || newlyEnabled.has(album.albumType) || !removedIds.has(album.id)
        ) {
          db.prepare(`INSERT INTO albums (artist_id, musicbrainz_id, title, release_date, year, album_type, genres, cover_url, cdart_url, label, monitored, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`).run(
            artist.id,
            album.id,
            album.title,
            album.releaseDate ?? null,
            album.year ?? null,
            album.albumType,
            JSON.stringify(album.genres),
            localCover ?? album.coverUrl ?? null,
            localCdArt ?? album.cdartUrl ?? null,
            album.label ?? null,
          )
          // Adding it back settles the tombstone, so a re-removal starts clean.
          db.prepare('DELETE FROM album_removals WHERE artist_id = ? AND musicbrainz_id = ?').run(artist.id, album.id)
          added += 1
        } else {
          // Absent and tombstoned: the operator removed it. Leaving it out is
          // what makes that removal stick, while genuinely new releases above
          // are still added.
          skipped += 1
        }
      }

      let removed = 0
      if (types.length > 0) {
        const placeholders = types.map(() => '?').join(',')
        removed = db
          .prepare(`
          DELETE FROM albums
          WHERE artist_id = ?
            AND album_type NOT IN (${placeholders})
            AND status NOT IN ('collected', 'downloaded', 'acquiring', 'downloading')
        `)
          .run(artist.id, ...types).changes
      }

      res.json({ success: true, added, removed, skipped, deselected, types })
    } catch (err) {
      logger.error('Artist refresh failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * Searches for a discography release — one torrent carrying an artist's whole
   * catalogue. The import pipeline already knows how to split one across albums
   * (mediaType 'music-discography'); this is the front door to it.
   */
  router.post('/music/artists/:id/search-discography', async (req, res) => {
    try {
      const artist = db.prepare('SELECT * FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!artist) return res.status(404).json({ error: 'Not found' })

      // Several phrasings, because trackers label these inconsistently.
      const queries = [`${artist.name} discography`, `${artist.name} complete discography`, `${artist.name} anthology`]
      const seen = new Set<string>()
      const found: any[] = []
      for (const query of queries) {
        // Deliberately unrestricted by category. The aggregator filters strictly
        // on category, and discography packs are routinely posted outside the
        // music tree — under Other, or a lossless-specific category that maps
        // nowhere near 3000 — so asking for music only loses most of them. The
        // title filter below is what keeps the list relevant.
        const results = await searchViaIndexers(getEnabledIndexerInstances(), query, {
          type: 'search',
          module: 'music',
        })
        for (const r of results) {
          const key = r.downloadUrl ?? r.guid
          if (!key || seen.has(key)) continue
          seen.add(key)
          found.push(r)
        }
      }

      // A discography is a multi-album pack, so keep releases that actually look
      // like one rather than a single album that mentions the word.
      // Either it says so, or it spans a range of years — the two ways a pack
      // announces itself. A title carrying neither is almost always one album.
      const PACK_WORDS = /\b(discograph|anthology|collection|complete|box\s?set|all\s+albums|studio\s+albums)\b/i
      const YEAR_RANGE = /\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b/
      const artistKey = artist.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const looksLikePack = (title: string) => PACK_WORDS.test(title) || YEAR_RANGE.test(title)
      const namesArtist = (title: string) =>
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '')
          .includes(artistKey)
      const candidates = found.filter(r => {
        const title = r.title ?? ''
        // Without a category filter the net is wide, so the artist has to be
        // named in the title for a result to be theirs.
        return namesArtist(title) && looksLikePack(title)
      })

      const ranked = rankMusicReleases(
        candidates.map(r => withMusicSwarmEvidence({ ...r, title: r.title ?? '', seeders: r.seeders ?? 0 })),
        {
          targetQuality: artist.target_resolution ?? null,
          targetCodec: artist.target_codec ?? null,
        },
      )

      res.json({
        query: queries[0],
        releases: ranked.map(r => ({
          guid: r.guid ?? r.downloadUrl,
          indexerName: r.indexerName ?? 'Indexer',
          title: r.title,
          downloadUrl: r.downloadUrl,
          torrentUrl: r.torrentUrl,
          magnetUrl: r.magnetUrl,
          size: r.size ?? undefined,
          seeders: r.seeders ?? undefined,
          leechers: r.leechers ?? undefined,
          quality: musicQualityRung(r.musicScore.parsed.quality)?.label ?? undefined,
        })),
      })
    } catch (err) {
      logger.error('Discography search failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /** Sends a discography release to the client and tracks it against the artist. */
  router.post('/music/artists/:id/grab-discography', validateBody(domains.GrabDiscography), async (req, res) => {
    try {
      const artist = db.prepare('SELECT id, name FROM artists WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as
        | { id: number; name: string }
        | undefined
      if (!artist) return res.status(404).json({ error: 'Not found' })

      const client = clientsFor(req)
        .getEnabled()
        .sort((a, b) => a.priority - b.priority)[0]
      if (!client) return res.status(400).json({ error: 'No download client enabled' })

      const { downloadUrl, title, release } = req.body as {
        downloadUrl: string
        title?: string
        release?: {
          guid?: string
          title?: string
          downloadUrl?: string
          torrentUrl?: string
          magnetUrl?: string
          indexerName?: string
          size?: number
          seeders?: number
          leechers?: number
        }
      }
      const releaseTitle = release?.title ?? title ?? 'discography'
      const candidate = {
        guid: release?.guid ?? downloadUrl,
        title: releaseTitle,
        downloadUrl: release?.downloadUrl ?? downloadUrl,
        torrentUrl: release?.torrentUrl,
        magnetUrl: release?.magnetUrl,
        indexerName: release?.indexerName ?? 'Indexer',
        size: release?.size,
        seeders: release?.seeders,
        leechers: release?.leechers,
      }
      const context = {
        source: 'manual' as const,
        tabId: libId(req),
        tabName: req.library!.name,
        mediaType: 'music',
        subjectType: 'artist',
        subjectId: artist.id,
        subjectTitle: artist.name,
      }
      const decision = evaluateRelease(context, candidate)
      const artistKey = artist.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const titleKey = releaseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '')
      const looksLikePack =
        /\b(discograph|anthology|collection|complete|box\s?set|all\s+albums|studio\s+albums)\b/i.test(releaseTitle) ||
        /\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b/.test(releaseTitle)
      if (!artistKey || !titleKey.includes(artistKey) || !looksLikePack) {
        decision.accepted = false
        decision.rejectionReasons.push('release is not an artist discography pack')
      }
      const decisionId = recordReleaseDecision(context, decision)
      if (!decision.accepted) return res.json({ success: false, message: decision.rejectionReasons.join('; ') })

      const result = await sendMusicReleaseToDownloadClient(client, candidate)
      if (!result.success) {
        return res.json({ success: false, message: (result as any).message ?? 'The download client refused this release' })
      }

      markDecisionGrabbed(decisionId, result)
      const infoHash = (result as any).infoHash ?? extractInfoHash((result as any).resolvedDownloadUrl) ?? extractInfoHash(downloadUrl) ?? null
      db.prepare(`
        UPDATE artists SET discography_info_hash = ?, discography_status = 'acquiring',
          discography_progress = 0, discography_title = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(infoHash, releaseTitle, artist.id)

      recordEvent({
        category: 'acquisition',
        action: 'discography-grabbed',
        subjectType: 'artist',
        subjectId: String(artist.id),
        message: `Grabbed a discography for ${artist.name}`,
        data: { infoHash, title: releaseTitle },
      })

      res.json({ success: true, message: `Submitted to torrent engine: ${releaseTitle}` })
    } catch (err) {
      logger.error('Discography grab failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * Manual release search for one album, the music counterpart of the series
   * Quick/Deep scans. Quick keeps only releases that meet the album's policy;
   * Deep returns everything found and lets the user judge.
   */
  router.post('/music/albums/:id/search', validateBody(domains.SearchAlbum), async (req, res) => {
    try {
      const album = db
        .prepare(`
        SELECT al.*, art.name AS artistName FROM albums al
        JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as any
      if (!album) return res.status(404).json({ error: 'Album not found' })

      const mode = (req.body as { mode?: 'quick' | 'deep' }).mode ?? 'quick'
      const selectedRelease = selectedAlbumRelease(db, album.id)
      const releaseScope = albumReleaseScope(selectedRelease)
      // Artist and title only; see the note in services/item-searches.ts.
      const query = [album.artistName, album.title].join(' ')
      const results = await searchViaIndexers(getEnabledIndexerInstances(), query, {
        categories: [3000],
        type: 'music',
        module: 'music',
      })

      const candidates = results.map(r => withMusicSwarmEvidence({ ...r, title: r.title ?? '', seeders: r.seeders ?? 0 }))
      const policy = {
        targetQuality: album.target_resolution ?? null,
        targetCodec: album.target_codec ?? null,
        // Deep shows everything; Quick honours the album's floor.
        requireTarget: mode === 'quick' && (album.upgrade_allowed === 0 || album.upgrade_allowed === false),
      }
      const ranked =
        mode === 'deep'
          ? rankMusicReleases(candidates, policy)
          : rankAlbumReleases(
              candidates,
              {
                artist: album.artistName,
                title: album.title,
                albumType: album.album_type,
                trackCount: album.track_count,
                ...releaseScope,
              },
              policy,
            )

      res.json({
        mode,
        query,
        releases: ranked.map(r => ({
          guid: r.guid ?? r.downloadUrl,
          indexerName: r.indexerName ?? 'Indexer',
          title: r.title,
          downloadUrl: r.downloadUrl,
          torrentUrl: r.torrentUrl,
          magnetUrl: r.magnetUrl,
          size: r.size ?? undefined,
          seeders: r.seeders ?? undefined,
          leechers: r.leechers ?? undefined,
          quality: musicQualityRung(r.musicScore.parsed.quality)?.label ?? undefined,
        })),
      })
    } catch (err) {
      logger.error('Album search failed:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
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
            const {
              imageUrl: localImage,
              backdropUrl: localBackdrop,
              logoUrl: localLogo,
            } = await ensureArtistFolder(artistData, resolveLibraryRoot(db, libId(req)))

            db.prepare(
              "UPDATE artists SET image_url = COALESCE(?, image_url), backdrop_url = COALESCE(?, backdrop_url), logo_url = COALESCE(?, logo_url), members = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(localImage ?? null, localBackdrop ?? null, localLogo ?? null, JSON.stringify(artistData.members ?? []), a.id)

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
                  a.id,
                  album.id,
                  album.title,
                  album.releaseDate ?? null,
                  album.year ?? null,
                  album.albumType,
                  JSON.stringify(album.genres),
                  localCover ?? album.coverUrl ?? null,
                  localCdArt ?? album.cdartUrl ?? null,
                  album.label ?? null,
                )
              }
            }
          } catch (err) {
            logger.warn(`Failed to refresh artist id=${a.id}:`, err)
          }
        }
        logger.info('Music refresh complete.')
      })().catch(err => logger.error('Background music refresh error:', err))
    } catch (_err) {
      res.status(500).json({ error: 'Failed to start music refresh' })
    }
  })

  router.get('/music/albums/:id', async (req, res) => {
    try {
      const album = db
        .prepare(`
        SELECT al.* FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!album) return res.status(404).json({ error: 'Not found' })
      await ensureAlbumTrackMetadata(db, Number(album.id))
      const refreshedAlbum = db.prepare('SELECT * FROM albums WHERE id = ?').get(album.id) as Record<string, unknown>
      const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number').all(album.id)
      res.json({ ...d(refreshedAlbum), selected_release: releaseSummary(selectedAlbumRelease(db, Number(album.id))), tracks })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  /**
   * Removes one album from the library.
   *
   * The artist keeps its release-type selection, so the album returns the next
   * time that selection is applied from the artist's Releases dialog — this is
   * a removal, not an exclusion.
   *
   * Tracks and cached MusicBrainz releases go with it through ON DELETE
   * CASCADE. Files stay on disk unless deleteFiles is set, matching how
   * deleting an artist behaves.
   */
  router.delete('/music/albums/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const album = db
        .prepare(`
        SELECT al.id, al.title, al.artist_id, al.musicbrainz_id, al.album_type
        FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as
        | { id: number; title: string; artist_id: number; musicbrainz_id: string | null; album_type: string | null }
        | undefined
      if (!album) return res.status(404).json({ error: 'Not found' })

      let filesDeleted = 0
      if (deleteFiles) {
        const tracks = db
          .prepare("SELECT file_path FROM tracks WHERE album_id = ? AND file_path IS NOT NULL AND file_path <> ''")
          .all(album.id) as Array<{ file_path: string }>
        const parents = new Set<string>()
        for (const track of tracks) {
          if (safeDeleteMediaPath(track.file_path)) {
            filesDeleted += 1
            parents.add(dirname(track.file_path))
          }
        }
        // Only reclaim a folder that the removal itself emptied. Anything left
        // behind is someone else's — never delete a directory still holding files.
        for (const parent of parents) {
          try {
            if (readdirSync(parent).length === 0) safeDeleteMediaPath(parent)
          } catch { /* already gone, or not readable — leave it alone */ }
        }
      }

      db.prepare('DELETE FROM albums WHERE id = ?').run(album.id)

      // Remember the removal. Without it a later refresh cannot tell this album
      // from one MusicBrainz has just published, and would add it straight back.
      if (album.musicbrainz_id) {
        db.prepare(`
          INSERT INTO album_removals (artist_id, musicbrainz_id, album_title, album_type, removed_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(artist_id, musicbrainz_id) DO UPDATE SET
            album_title = excluded.album_title,
            album_type = excluded.album_type,
            removed_at = excluded.removed_at
        `).run(album.artist_id, album.musicbrainz_id, album.title, album.album_type, Date.now())
      }

      recordEvent({
        category: 'library',
        action: 'album-removed',
        subjectType: 'album',
        subjectId: String(album.id),
        message: `Removed "${album.title}"${deleteFiles ? ` and ${filesDeleted} file(s)` : ''} from the library`,
      })
      res.json({ success: true, filesDeleted })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/music/albums/:id/releases', async (req, res) => {
    try {
      const album = db
        .prepare(`SELECT al.id FROM albums al JOIN artists art ON art.id = al.artist_id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as { id: number } | undefined
      if (!album) return res.status(404).json({ error: 'Album not found' })
      const releases = await albumReleases(db, album.id, req.query.refresh === 'true')
      res.json({ releases: releases.map(releaseSummary) })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/music/albums/:id/release', async (req, res) => {
    try {
      const album = db
        .prepare(`SELECT al.id FROM albums al JOIN artists art ON art.id = al.artist_id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as { id: number } | undefined
      if (!album) return res.status(404).json({ error: 'Album not found' })
      const releaseId = typeof req.body?.releaseId === 'string' ? req.body.releaseId.trim() : ''
      if (!releaseId) return res.status(400).json({ error: 'releaseId is required' })
      const release = await selectAlbumRelease(db, album.id, releaseId)
      const updated = db.prepare('SELECT * FROM albums WHERE id = ?').get(album.id) as Record<string, unknown>
      const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number').all(album.id)
      recordEvent({
        category: 'metadata',
        action: 'music-release-selected',
        subjectType: 'album',
        subjectId: String(album.id),
        message: `Selected MusicBrainz release ${release.id}`,
        data: { release: releaseSummary(release) },
      })
      res.json({ album: { ...d(updated), selected_release: releaseSummary(release), tracks }, release: releaseSummary(release) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(message.startsWith('Cannot change release') ? 409 : 400).json({ error: message })
    }
  })

  router.put('/music/albums/:id', validateBody(domains.UpdateAlbum), (req, res) => {
    try {
      const body = req.body as Record<string, unknown>
      // The public contract speaks downloading/downloaded; storage speaks
      // acquiring/collected. Normalise here so only one vocabulary reaches the
      // database and the monitor can always see what it owns.
      const STATUS_ALIASES: Record<string, string> = { downloading: 'acquiring', downloaded: 'collected' }
      const album = db
        .prepare(`
        SELECT al.id FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as { id: number } | undefined
      if (!album) return res.status(404).json({ error: 'Not found' })

      // Built from the keys actually sent, so an explicit null clears a field
      // while an absent key leaves it alone. COALESCE cannot express that
      // difference, which made every "Any" choice a no-op.
      const COLUMNS: Record<string, string> = {
        monitored: 'monitored',
        status: 'status',
        upgrade_allowed: 'upgrade_allowed',
        target_tier: 'target_tier',
        target_resolution: 'target_resolution',
        target_codec: 'target_codec',
        minimum_tier: 'minimum_tier',
        minimum_resolution: 'minimum_resolution',
        minimum_codec: 'minimum_codec',
      }
      const sets: string[] = []
      const values: unknown[] = []
      for (const [key, column] of Object.entries(COLUMNS)) {
        if (!(key in body)) continue
        let value = body[key]
        if (key === 'status' && typeof value === 'string') value = STATUS_ALIASES[value] ?? value
        if (typeof value === 'boolean') value = value ? 1 : 0
        sets.push(`${column} = ?`)
        values.push(value ?? null)
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE albums SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, album.id)
      }
      res.json(d(db.prepare('SELECT * FROM albums WHERE id = ?').get(album.id) as Record<string, unknown>))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // Album metadata, the counterpart of the season editor.
  router.put('/music/albums/:id/metadata', (req, res) => {
    try {
      const { title, overview, label, album_type, year, genres } = req.body as Record<string, unknown>
      const album = db
        .prepare(`
        SELECT al.* FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!album) return res.status(404).json({ error: 'Not found' })

      db.prepare(`
        UPDATE albums SET
          title = COALESCE(@title, title),
          overview = COALESCE(@overview, overview),
          label = COALESCE(@label, label),
          album_type = COALESCE(@albumType, album_type),
          year = COALESCE(@year, year),
          genres = COALESCE(@genres, genres),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: album.id,
        title: title ?? null,
        overview: overview ?? null,
        label: label ?? null,
        albumType: album_type ?? null,
        year: year == null || year === '' ? null : Number(year),
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
      })
      res.json(d(db.prepare('SELECT * FROM albums WHERE id = ?').get(album.id) as Record<string, unknown>))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // Cover art for one album. Fanart.tv indexes covers by release-group MBID,
  // which is the id MusicBrainz gives an album, so the artist's id is no help
  // here — an album without one simply has nothing to offer.
  router.get('/music/albums/:id/images', async (req, res) => {
    try {
      const album = db
        .prepare(`
        SELECT al.*, art.musicbrainz_id AS artist_mbid FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as any
      if (!album) return res.status(404).json({ error: 'Not found' })
      const type = String((req.query as { type?: string }).type || 'poster')
      const results: Array<{ url: string; source: string; type: string; language: string }> = []

      if (album.musicbrainz_id) {
        const covers = await getAlbumCovers(album.musicbrainz_id as string, type === 'cdart' ? 'cdart' : 'cover', album.artist_mbid ?? undefined)
        for (const url of covers.slice(0, 15)) results.push({ url, source: 'Fanart.tv / Cover Art Archive', type, language: 'null' })
      }
      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/music/albums/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const album = db
        .prepare(`
        SELECT al.*, art.root_folder_path AS artist_root FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as any
      if (!album) return res.status(404).json({ error: 'Not found' })

      const fileMap: Record<string, string> = { poster: 'cover.jpg', cdart: 'cdart.png' }
      const dbCol: Record<string, string> = { poster: 'cover_url', cdart: 'cdart_url' }
      if (!fileMap[type]) return res.status(400).json({ error: `Unknown image type: ${type}` })

      const saved = await saveEntityImage(album.folder_path || album.artist_root, fileMap[type], url)
      db.prepare(`UPDATE albums SET ${dbCol[type]} = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, album.id)
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // A track's editable metadata is its lyrics. No provider is wired up yet, so
  // this is the hand-written store — a provider can later fill the same column
  // and stamp lyrics_source with its name.
  router.put('/music/tracks/:id/lyrics', (req, res) => {
    try {
      const track = db
        .prepare(`
        SELECT t.id FROM tracks t
        JOIN albums al ON al.id = t.album_id
        JOIN artists ar ON ar.id = al.artist_id
        WHERE t.id = ? AND ar.library_id = ?`)
        .get(req.params.id, libId(req)) as { id: number } | undefined
      if (!track) return res.status(404).json({ error: 'Not found' })

      const { lyrics } = req.body as { lyrics?: string | null }
      const text = typeof lyrics === 'string' && lyrics.trim().length > 0 ? lyrics : null
      db.prepare(`UPDATE tracks SET lyrics = ?, lyrics_source = ?, lyrics_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
        text,
        text == null ? null : 'manual',
        track.id,
      )
      res.json(db.prepare('SELECT * FROM tracks WHERE id = ?').get(track.id))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // Track-level monitoring, the counterpart of the episode toggle.
  router.put('/music/tracks/:id', validateBody(domains.UpdateTrack), (req, res) => {
    try {
      const track = db
        .prepare(`
        SELECT t.id FROM tracks t
        JOIN albums al ON al.id = t.album_id
        JOIN artists ar ON ar.id = al.artist_id
        WHERE t.id = ? AND ar.library_id = ?`)
        .get(req.params.id, libId(req)) as { id: number } | undefined
      if (!track) return res.status(404).json({ error: 'Not found' })

      const { monitored } = req.body as { monitored?: boolean }
      if (monitored !== undefined) {
        db.prepare("UPDATE tracks SET monitored = ?, updated_at = datetime('now') WHERE id = ?").run(monitored ? 1 : 0, track.id)
      }
      res.json(db.prepare('SELECT * FROM tracks WHERE id = ?').get(track.id))
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
    } catch (_err) {
      res.status(500).json({ error: 'MusicBrainz artist lookup failed' })
    }
  })

  router.post('/music/albums/:id/auto-grab', async (req, res) => {
    try {
      const album = db
        .prepare(`
        SELECT al.*, art.name as artistName
        FROM albums al JOIN artists art ON al.artist_id = art.id
        WHERE al.id = ? AND art.library_id = ?`)
        .get(req.params.id, libId(req)) as any
      if (!album) return res.status(404).json({ error: 'Album not found' })

      const query = `${album.artistName} ${album.title}`
      logger.info(`Auto-grabbing album: ${query}`)

      const enabledIndexers = getEnabledIndexerInstances()
      const results = await searchViaIndexers(enabledIndexers, query, {
        categories: [3000],
        type: 'music',
        module: 'music',
        timeoutMs: 8_000,
        deadlineAt: Date.now() + 15_000,
      })

      if (results.length === 0) {
        return res.json({ success: false, message: 'No releases found' })
      }

      const decision = await decideAlbum(
        {
          tabId: libId(req),
          tabName: req.library!.name,
          dbPath: req.library!.dbPath,
          mediaType: 'music',
          subjectType: 'album',
          subjectId: String(album.id),
          primaryTitle: `${album.artistName} - ${album.title}`,
          year: album.year ?? null,
        },
        results.map(release => ({ release, parsed: parseRelease(release.title) })),
        {
          source: 'auto-grab',
          interactive: true,
          targetResolution: album.target_resolution,
          targetCodec: album.target_codec,
        },
      )
      if (decision.error) return res.json({ success: false, message: decision.error })
      if (decision.grabbed === 0) {
        return res.json({ success: false, message: 'Releases were found, but none matched the complete album and its quality target' })
      }
      res.json({ success: true, message: 'Album release grabbed through the acquisition decision pipeline' })
    } catch (err) {
      logger.error('Music auto-grab failed:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/music/download', validateBody(domains.DownloadMusic.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, albumId, releaseTitle, releaseGuid, indexerName, size, seeders, leechers, publishDate } = req.body
      if (albumId) {
        if (!releaseTitle) return res.status(400).json({ error: 'releaseTitle is required when grabbing an album result' })
        const album = db
          .prepare(`
          SELECT al.id, al.title, al.year, ar.name AS artist_name
          FROM albums al JOIN artists ar ON ar.id = al.artist_id
          WHERE al.id = ? AND ar.library_id = ?
        `)
          .get(albumId, libId(req)) as { id: number; title: string; year: number | null; artist_name: string } | undefined
        if (!album) return res.status(404).json({ error: 'Album not found' })
        const decision = await decideAlbum(
          {
            tabId: libId(req),
            tabName: req.library!.name,
            dbPath: req.library!.dbPath,
            mediaType: 'music',
            subjectType: 'album',
            subjectId: String(album.id),
            primaryTitle: `${album.artist_name} - ${album.title}`,
            year: album.year,
          },
          [
            {
              release: { guid: releaseGuid, title: releaseTitle, downloadUrl, indexerName, size, seeders, leechers, publishDate },
              parsed: parseRelease(releaseTitle),
            },
          ],
          { source: 'manual', manualSelection: true },
        )
        if (decision.error) return res.json({ success: false, message: decision.error })
        if (decision.grabbed === 0) return res.json({ success: false, message: 'The selected release was rejected by album scope or blocklist rules' })
        return res.json({ success: true, message: `Started downloading ${releaseTitle}` })
      }

      // Compatibility path for callers that submit an unassociated Music URL.
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      try {
        const result = await sendToDownloadClient(client, downloadUrl, 'archivist-music')

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
