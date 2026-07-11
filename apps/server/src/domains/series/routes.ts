import { Router } from 'express'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import { createLogger, scoreRelease, sanitizeConfigValue } from '@archivist/core'
import { saveEntityImage, getFanartTv, type ImageCandidate } from '../../shared/image-save.js'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { getTierTermsForMedia } from '../../shared/settings.js'
import { buildSeriesTargets } from '../../release-pipeline/series-cascade.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureSeriesFolder, ensureSeasonFolder, generateEpisodeNfo, ensureEpisodeThumbnail } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { listAcquisitionHistoryForSubjectIds } from '../../services/acquisition-decisions.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { deleteExistingPath, registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { searchSeries, getSeries, getSeriesSeasons, getSeriesEpisodes, getSeriesTmdb, getSeriesSeasonsTmdb, getSeriesEpisodesTmdb, getSeriesPreview, tmdbImageUrl } from './tvdb.js'
import { d } from './serialize.js'
import { enqueueSeriesMetadataRefresh } from './metadata-refresh.js'

const logger = createLogger('Series')

export function createSeriesRouter(): Router {
  const router = Router()
  router.use('/series', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))

  registerAcquisitionControls(router, {
    basePath: '/series/episodes',
    idParam: 'episodeId',
    mediaType: 'series',
    subjectType: 'episode',
    table: 'episodes',
    selectSql: `
      SELECT e.*, s.title as series_title
      FROM episodes e JOIN series s ON e.series_id = s.id
      WHERE e.id = ? AND s.library_id = ?`,
    title: row => `${row.series_title} S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}${row.title ? ` - ${row.title}` : ''}`,
  })

  registerAcquisitionControls(router, {
    basePath: '/series/seasons',
    idParam: 'seasonId',
    mediaType: 'series',
    subjectType: 'season',
    table: 'seasons',
    selectSql: `
      SELECT seasons.*, series.title as series_title
      FROM seasons JOIN series ON seasons.series_id = series.id
      WHERE seasons.id = ? AND series.library_id = ?`,
    title: row => `${row.series_title} S${String(row.season_number).padStart(2, '0')}`,
    subjectId: row => `${row.series_id}:S${row.season_number}`,
    repairChildren: (db, row, deleteFiles) => {
      const episodes = db.prepare('SELECT id, file_path FROM episodes WHERE series_id = ? AND season_number = ?').all(row.series_id, row.season_number) as Array<{ id: number; file_path?: string | null }>
      if (deleteFiles) episodes.forEach(ep => deleteExistingPath(ep.file_path))
      db.prepare(`
        UPDATE episodes
        SET status = 'missing',
            file_path = NULL,
            file_size = NULL,
            quality = NULL,
            episode_file_id = NULL,
            info_hash = NULL,
            download_progress = 0,
            current_tier = 0,
            current_resolution = NULL,
            current_source = NULL,
            current_codec = NULL,
            current_release_group = NULL,
            current_edition = NULL,
            current_size_bytes = NULL,
            current_release_title = NULL,
            updated_at = datetime('now')
        WHERE series_id = ? AND season_number = ?
      `).run(row.series_id, row.season_number)
    },
  })

  // ── Series library ────────────────────────────────────────────────────────

  router.get('/series', (req, res) => {
    try {
      const series = db.prepare('SELECT * FROM series WHERE library_id = ? ORDER BY sort_title ASC').all(libId(req)) as Record<string, unknown>[]
      const result = series.map(s => {
        const stats = db.prepare(`
          SELECT
            COUNT(id) as total,
            SUM(CASE WHEN status IN ('collected', 'downloaded') THEN 1 ELSE 0 END) as downloaded,
            SUM(CASE WHEN status IN ('acquiring', 'downloading') THEN 1 ELSE 0 END) as acquiring,
            SUM(CASE WHEN air_date <= date('now') AND (status = 'missing' OR status = 'wanted') THEN 1 ELSE 0 END) as missing,
            SUM(CASE WHEN air_date <= date('now') THEN 1 ELSE 0 END) as aired_count,
            SUM(CASE WHEN file_path IS NOT NULL AND EXISTS (
              SELECT 1 FROM media_loudness ml
              WHERE ml.media_type = 'episode' AND ml.media_id = episodes.id AND ml.file_path = episodes.file_path
            ) THEN 1 ELSE 0 END) as measured
          FROM episodes WHERE series_id = ?
        `).get(s.id) as any

        const data = d(s) as any
        data.posterPath = tmdbImageUrl(data.posterPath)
        data.backdropPath = tmdbImageUrl(data.backdropPath, 'w1280')

        if (data.status === 'continuing' && (stats.aired_count || 0) === 0) {
          data.status = 'upcoming'
        }

        data.poster_path = data.posterPath
        data.backdrop_path = data.backdropPath

        return {
          ...data,
          aired_count: stats.aired_count || 0,
          // Loudness handled when every downloaded episode has been measured.
          loudnessMeasured: (stats.downloaded || 0) > 0 && (stats.measured || 0) >= (stats.downloaded || 0),
          stats: {
            total: stats.total || 0,
            downloaded: stats.downloaded || 0,
            acquiring: stats.acquiring || 0,
            missing: stats.missing || 0,
          },
        }
      })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Lookup ────────────────────────────────────────────────────────────────

  router.get('/series/lookup', async (req, res) => {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })
    try {
      const results = await searchSeries(String(q))
      const series = results.map(s => ({
        ...s,
        alreadyAdded: !!db.prepare('SELECT id FROM series WHERE library_id = ? AND (tmdb_id = ? OR tvdb_id = ?)').get(libId(req), s.tmdbId ?? 0, s.tvdbId ?? 0),
      }))
      res.json(series)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' })
    }
  })

  // Registered before '/series/:id' so "preview" is not treated as an id.
  router.get('/series/preview', async (req, res) => {
    const tvdbId = req.query.tvdbId ? parseInt(String(req.query.tvdbId), 10) : undefined
    const tmdbId = req.query.tmdbId ? parseInt(String(req.query.tmdbId), 10) : undefined
    if (!tvdbId && !tmdbId) return res.status(400).json({ error: 'tvdbId or tmdbId required' })
    try {
      res.json(await getSeriesPreview({ tvdbId, tmdbId }))
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Preview failed' })
    }
  })

  router.get('/series/calendar', (req, res) => {
    try {
      const days = parseInt(String(req.query.days || '7'), 10)
      res.json(db.prepare(`
        SELECT e.*, s.title as series_title, s.poster_path as series_poster
        FROM episodes e
        JOIN series s ON e.series_id = s.id
        WHERE s.library_id = ?
          AND e.air_date >= date('now') AND e.air_date <= date('now', '+' || ? || ' days')
          AND s.monitored = 1 AND e.monitored = 1
        ORDER BY e.air_date ASC LIMIT 50`).all(libId(req), days))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/series/:id', (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      const airedCount = (db.prepare("SELECT COUNT(id) as n FROM episodes WHERE series_id = ? AND air_date <= date('now')").get(req.params.id) as any).n

      const seriesData = d(row) as any
      seriesData.posterPath = tmdbImageUrl(seriesData.posterPath)
      seriesData.backdropPath = tmdbImageUrl(seriesData.backdropPath, 'w1280')
      seriesData.logoPath = tmdbImageUrl(seriesData.logoPath, 'original')
      seriesData.bannerPath = tmdbImageUrl(seriesData.bannerPath, 'w1280')

      if (seriesData.status === 'continuing' && airedCount === 0) {
        seriesData.status = 'upcoming'
      }

      seriesData.poster_path = seriesData.posterPath
      seriesData.backdrop_path = seriesData.backdropPath

      res.json(seriesData)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/series/tmdb/:tmdbId', async (req, res) => {
    try {
      const tmdbId = parseInt(req.params.tmdbId, 10)
      const local = db.prepare('SELECT * FROM series WHERE library_id = ? AND tmdb_id = ?').get(libId(req), tmdbId) as Record<string, unknown> | undefined

      if (local) {
        const airedCount = (db.prepare("SELECT COUNT(id) as n FROM episodes WHERE series_id = ? AND air_date <= date('now')").get(local.id) as any).n
        const seriesData = d(local) as any
        seriesData.posterPath = tmdbImageUrl(seriesData.posterPath)
        seriesData.backdropPath = tmdbImageUrl(seriesData.backdropPath, 'w1280')
        seriesData.logoPath = tmdbImageUrl(seriesData.logoPath, 'original')
        seriesData.bannerPath = tmdbImageUrl(seriesData.bannerPath, 'w1280')

        if (seriesData.status === 'continuing' && airedCount === 0) {
          seriesData.status = 'upcoming'
        }

        seriesData.poster_path = seriesData.posterPath
        seriesData.backdrop_path = seriesData.backdropPath

        return res.json({
          ...seriesData,
          localId: seriesData.id,
          localStatus: seriesData.status,
        })
      }

      const data = await getSeriesTmdb(tmdbId)
      res.json({ ...data, localId: undefined, localStatus: undefined })
    } catch (err) {
      logger.error('Failed to fetch series data:', err)
      res.status(500).json({ error: 'Could not fetch series data. If you are offline, ensure the series is in your library.' })
    }
  })

  router.post('/series', validateBody(domains.AddSeries), async (req, res) => {
    try {
      const { tvdbId, tmdbId, monitored = true, qualityProfileId, rootFolderPath, monitoredSeasons = 'all', upgrade_allowed, target_tier, target_resolution, target_source, target_codec } = req.body
      void rootFolderPath
      const useTvdb = Boolean(tvdbId)
      const seriesData = useTvdb ? await getSeries(tvdbId) : await getSeriesTmdb(tmdbId)
      const seasons = useTvdb ? await getSeriesSeasons(tvdbId) : await getSeriesSeasonsTmdb(tmdbId)

      const existing = db.prepare('SELECT id FROM series WHERE library_id = ? AND (tmdb_id = ? OR tvdb_id = ?)')
        .get(libId(req), seriesData.tmdbId ?? tmdbId ?? 0, seriesData.tvdbId ?? tvdbId ?? 0)
      if (existing) return res.status(409).json({ error: 'Series already in library' })

      const { targetDir: seriesDir, posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo } = await ensureSeriesFolder(seriesData, resolveLibraryRoot(db, libId(req)))

      const sortTitle = seriesData.title.replace(/^(The|A|An)\s+/i, '').toLowerCase()
      const result = db.prepare(`
        INSERT INTO series (library_id, tvdb_id, tmdb_id, imdb_id, title, sort_title, year, overview,
          network, status, series_type, runtime, genres, cast, crew, country, certification, poster_path, backdrop_path, logo_path,
          rating, language, monitored, quality_profile_id, root_folder_path, air_time, air_day,
          upgrade_allowed, target_tier, target_resolution, target_source, target_codec)
        VALUES (@libraryId, @tvdbId, @tmdbId, @imdbId, @title, @sortTitle, @year, @overview,
          @network, @status, @seriesType, @runtime, @genres, @cast, @crew, @country, @certification, @posterPath, @backdropPath, @logoPath,
          @rating, @language, @monitored, @qualityProfileId, @rootFolderPath, @airTime, @airDay,
          @upgradeAllowed, @target_tier, @target_resolution, @target_source, @target_codec)
      `).run({
        libraryId: libId(req),
        tvdbId: seriesData.tvdbId ?? null, tmdbId: seriesData.tmdbId ?? tmdbId ?? null,
        imdbId: seriesData.imdbId ?? null, title: seriesData.title, sortTitle,
        year: seriesData.year ?? null, overview: seriesData.overview ?? null,
        network: seriesData.network ?? null, status: seriesData.status,
        seriesType: seriesData.seriesType, runtime: seriesData.runtime ?? null,
        genres: JSON.stringify(seriesData.genres),
        cast: JSON.stringify(seriesData.cast ?? []),
        crew: JSON.stringify(seriesData.crew ?? []),
        country: seriesData.country ?? null,
        certification: seriesData.certification ?? null,
        posterPath: localPoster ?? seriesData.posterPath ?? null,
        backdropPath: localBackdrop ?? seriesData.backdropPath ?? null,
        logoPath: localLogo ?? seriesData.logoPath ?? null,
        rating: seriesData.rating ?? null,
        language: seriesData.language, monitored: monitored ? 1 : 0,
        qualityProfileId: qualityProfileId ?? null, rootFolderPath: seriesDir,
        airTime: seriesData.airTime ?? null, airDay: seriesData.airDay ?? null,
        upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : 1,
        target_tier: target_tier ?? null,
        target_resolution: target_resolution ?? null,
        target_source: target_source ?? null,
        target_codec: target_codec ?? null,
      })

      const seriesId = result.lastInsertRowid as number
      const maxSeason = Math.max(...seasons.map(s => s.seasonNumber), 0)

      // Populate seasons/episodes in the background so the add responds
      // immediately; the detail page polls and fills in as rows land.
      ;(async () => {
        for (const season of seasons) {
          const shouldMonitor = monitoredSeasons === 'all' ||
            (monitoredSeasons === 'latest' && season.seasonNumber === maxSeason)

          try {
            const { targetDir: seasonDir, posterPath: localSeasonPoster } = await ensureSeasonFolder(seriesData, season, resolveLibraryRoot(db, libId(req)))

            db.prepare(`INSERT OR IGNORE INTO seasons (series_id, season_number, title, overview, poster_path, episode_count, monitored)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
              seriesId, season.seasonNumber, season.title ?? null, season.overview ?? null,
              localSeasonPoster ?? season.posterPath ?? null, season.episodeCount, shouldMonitor ? 1 : 0)

            const seasonRow = db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_number = ?').get(seriesId, season.seasonNumber) as { id: number }

            const episodes = useTvdb
              ? await getSeriesEpisodes(tvdbId, season.seasonNumber)
              : await getSeriesEpisodesTmdb(tmdbId, season.seasonNumber)

            for (const ep of episodes) {
              // One broken episode (bad title, failed asset, odd fs error) must
              // never abort the rest of the season — insert what we can.
              try {
                const nfoFileName = `${seriesData.title} S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')} - ${ep.title}.nfo`.replace(/[/\\:*?"<>|]/g, '')
                try { generateEpisodeNfo(seriesData, ep, join(seasonDir, nfoFileName)) } catch { /* nfo is best-effort */ }

                const localStill = await ensureEpisodeThumbnail(seriesData, season, ep, resolveLibraryRoot(db, libId(req)))

                db.prepare(`INSERT OR IGNORE INTO episodes
                  (series_id, season_id, season_number, episode_number, tvdb_episode_id, title, overview, air_date, runtime, still_path, monitored, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                  seriesId, seasonRow.id, season.seasonNumber, ep.episodeNumber, ep.tvdbEpisodeId ?? null,
                  ep.title, ep.overview, ep.airDate, ep.runtime, localStill ?? ep.stillPath, shouldMonitor ? 1 : 0, 'missing')
              } catch (err) {
                logger.warn(`Failed episode S${season.seasonNumber}E${ep.episodeNumber}:`, err instanceof Error ? err.message : String(err))
              }
            }
          } catch (err) {
            logger.warn(`Failed to fetch episodes S${season.seasonNumber}:`, err instanceof Error ? err.message : String(err))
          }
        }
        logger.info(`Finished populating "${seriesData.title}" (${seasons.length} seasons)`)
      })().catch(err => logger.error('Background series population failed:', err instanceof Error ? err.message : String(err)))

      const inserted = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId)
      const seriesRes = d(inserted) as any
      seriesRes.posterPath = tmdbImageUrl(seriesRes.posterPath)
      seriesRes.backdropPath = tmdbImageUrl(seriesRes.backdropPath, 'w1280')
      seriesRes.logoPath = tmdbImageUrl(seriesRes.logoPath, 'original')
      seriesRes.bannerPath = tmdbImageUrl(seriesRes.bannerPath, 'w1280')

      res.status(201).json(seriesRes)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/series/:id', validateBody(domains.UpdateSeries), (req, res) => {
    try {
      const { monitored, qualityProfileId, rootFolderPath, upgrade_allowed, target_tier, target_resolution, target_source, target_codec } = req.body
      db.prepare(`UPDATE series SET
        monitored = COALESCE(@monitored, monitored),
        quality_profile_id = COALESCE(@qualityProfileId, quality_profile_id),
        root_folder_path = COALESCE(@rootFolderPath, root_folder_path),
        upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed),
        target_tier = COALESCE(@target_tier, target_tier),
        target_resolution = COALESCE(@target_resolution, target_resolution),
        target_source = COALESCE(@target_source, target_source),
        target_codec = COALESCE(@target_codec, target_codec),
        updated_at = datetime('now') WHERE id = @id AND library_id = @libraryId`).run({
        id: req.params.id,
        libraryId: libId(req),
        monitored: monitored !== undefined ? (monitored ? 1 : 0) : null,
        qualityProfileId: qualityProfileId ?? null,
        rootFolderPath: rootFolderPath ?? null,
        upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null,
        target_tier: target_tier ?? null,
        target_resolution: target_resolution ?? null,
        target_source: target_source ?? null,
        target_codec: target_codec ?? null,
      })
      const updated = db.prepare('SELECT * FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!updated) return res.status(404).json({ error: 'Not found' })
      res.json(d(updated))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/series/:id/metadata', (req, res) => {
    try {
      const { title, year, overview, network, genres, certification, country, runtime, rating } = req.body
      const row = db.prepare('SELECT * FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      const sortTitle = (title ?? row.title as string).replace(/^(The|A|An)\s+/i, '').toLowerCase()
      db.prepare(`
        UPDATE series SET
          title = COALESCE(@title, title),
          sort_title = @sortTitle,
          year = COALESCE(@year, year),
          overview = COALESCE(@overview, overview),
          network = COALESCE(@network, network),
          genres = COALESCE(@genres, genres),
          certification = COALESCE(@certification, certification),
          country = COALESCE(@country, country),
          runtime = COALESCE(@runtime, runtime),
          rating = COALESCE(@rating, rating),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: row.id,
        title: title ?? null,
        sortTitle,
        year: year ?? null,
        overview: overview ?? null,
        network: network ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
        certification: certification ?? null,
        country: country ?? null,
        runtime: runtime ?? null,
        rating: rating ?? null,
      })

      const updated = db.prepare('SELECT * FROM series WHERE id = ?').get(row.id) as Record<string, unknown>
      const seriesData = d(updated) as any

      // Rewrite tvshow.nfo alongside the media when the series has a folder
      if (seriesData.root_folder_path && existsSync(seriesData.root_folder_path)) {
        try {
          const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<tvshow>\n  <title>${seriesData.title}</title>\n  <year>${seriesData.year || ''}</year>\n  <plot>${seriesData.overview || ''}</plot>\n  <status>${seriesData.status || ''}</status>\n  <network>${seriesData.network || ''}</network>\n  <mpaa>${seriesData.certification || ''}</mpaa>\n  <genre>${(seriesData.genres || []).join(' / ')}</genre>\n  <uniqueid type="tmdb" default="true">${seriesData.tmdb_id || ''}</uniqueid>\n  <uniqueid type="tvdb">${seriesData.tvdb_id || ''}</uniqueid>\n  <uniqueid type="imdb">${seriesData.imdb_id || ''}</uniqueid>\n</tvshow>`
          writeFileSync(join(seriesData.root_folder_path, 'tvshow.nfo'), nfo)
        } catch (nfoErr) {
          logger.warn(`Failed to write tvshow.nfo: ${nfoErr instanceof Error ? nfoErr.message : String(nfoErr)}`)
        }
      }

      seriesData.posterPath = tmdbImageUrl(seriesData.posterPath)
      seriesData.backdropPath = tmdbImageUrl(seriesData.backdropPath, 'w1280')
      seriesData.poster_path = seriesData.posterPath
      seriesData.backdrop_path = seriesData.backdropPath
      res.json(seriesData)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/series/:id/images', async (req, res) => {
    try {
      const { type, language } = req.query as { type?: string; language?: string }
      const row = db.prepare('SELECT * FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      const lang = language || 'en'
      const results: ImageCandidate[] = []

      if (row.tmdb_id) {
        try {
          const tmdbKey = sanitizeConfigValue(process.env.TMDB_API_KEY)
          const tmdbBase = process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
          const tmdbRes = await axios.get(`${tmdbBase}/tv/${row.tmdb_id}/images`, {
            params: { api_key: tmdbKey, include_image_language: `${lang},null` },
            timeout: 10000,
          })
          const typeMap: Record<string, string> = { poster: 'posters', backdrop: 'backdrops', logo: 'logos', banner: 'backdrops' }
          const tmdbType = typeMap[type || 'poster']
          const images = tmdbRes.data?.[tmdbType] ?? []
          for (const img of images.slice(0, 20)) {
            const size = tmdbType === 'logos' ? 'original' : tmdbType === 'posters' ? 'w342' : 'w1280'
            results.push({
              url: `https://image.tmdb.org/t/p/${size}${img.file_path}`,
              source: 'TMDB',
              type: type || 'poster',
              language: img.iso_639_1 || 'null',
              width: img.width,
              height: img.height,
            })
          }
        } catch (err) {
          logger.warn(`TMDB TV image search failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (row.tvdb_id) {
        const fanart = await getFanartTv(row.tvdb_id)
        if (fanart) {
          const fanartTypeMap: Record<string, string[]> = {
            poster: ['tvposter'],
            backdrop: ['showbackground'],
            logo: ['hdtvlogo', 'clearlogo'],
            banner: ['tvbanner'],
          }
          for (const ft of fanartTypeMap[type || 'poster'] ?? []) {
            const items = (fanart[ft] ?? []) as Array<{ url: string; lang?: string }>
            for (const img of items.filter(i => !lang || i.lang === lang || !i.lang || i.lang === '').slice(0, 15)) {
              results.push({ url: img.url, source: 'Fanart.tv', type: type || 'poster', language: img.lang || 'null' })
            }
          }
        }
      }

      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/series/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const row = db.prepare('SELECT * FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })

      const fileMap: Record<string, string> = { poster: 'poster.png', backdrop: 'backdrop.png', logo: 'logo.png', banner: 'banner.jpg' }
      const dbCol: Record<string, string> = { poster: 'poster_path', backdrop: 'backdrop_path', logo: 'logo_path', banner: 'banner_path' }
      if (!fileMap[type]) return res.status(400).json({ error: `Unknown image type: ${type}` })

      const saved = await saveEntityImage(row.root_folder_path, fileMap[type], url)
      db.prepare(`UPDATE series SET ${dbCol[type]} = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, row.id)
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/series/:id/acquisition-history', (req, res) => {
    try {
      const container = db.prepare('SELECT id FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req))
      if (!container) return res.status(404).json({ error: 'Not found' })
      const childIds = (db.prepare('SELECT id FROM episodes WHERE series_id = ?').all(req.params.id) as Array<{ id: number }>).map(r => r.id)
      res.json(listAcquisitionHistoryForSubjectIds({ mediaType: 'series', subjectType: 'episode', subjectIds: childIds }))
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.delete('/series/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const row = db.prepare('SELECT root_folder_path FROM series WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (row && deleteFiles) safeDeleteMediaPath(row.root_folder_path)
      db.prepare('DELETE FROM series WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/series/refresh', (req, res) => {
    try {
      const series = db.prepare('SELECT id FROM series WHERE library_id = ?').all(libId(req)) as Array<{ id: number }>
      let queued = 0
      for (const row of series) {
        if (enqueueSeriesMetadataRefresh(row.id) !== null) queued++
      }
      res.json({ success: true, message: `Queued ${queued} series metadata refresh jobs.`, queued })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/series/:id/refresh', (req, res) => {
    try {
      const series = db.prepare('SELECT id, title FROM series WHERE id = ? AND library_id = ?')
        .get(req.params.id, libId(req)) as { id: number; title: string } | undefined
      if (!series) return res.status(404).json({ error: 'Not found' })
      const jobId = enqueueSeriesMetadataRefresh(series.id)
      res.status(jobId === null ? 200 : 202).json({
        success: true,
        message: jobId === null ? `"${series.title}" is already queued for refresh.` : `Queued refresh for "${series.title}".`,
        jobId,
      })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Seasons ───────────────────────────────────────────────────────────────

  router.get('/series/:id/seasons', (req, res) => {
    try {
      const seasons = db.prepare(`
        SELECT s.*,
          COUNT(e.id) as total_episodes,
          SUM(CASE WHEN e.status = 'downloaded' THEN 1 ELSE 0 END) as downloaded_episodes,
          SUM(CASE WHEN e.status = 'downloading' THEN 1 ELSE 0 END) as downloading_episodes
        FROM seasons s
        LEFT JOIN episodes e ON e.season_id = s.id
        WHERE s.series_id = ? AND s.series_id IN (SELECT id FROM series WHERE library_id = ?)
        GROUP BY s.id
        ORDER BY s.season_number ASC
      `).all(req.params.id, libId(req)) as any[]

      const mapped = seasons.map(s => ({
        ...s,
        downloadProgress: s.download_progress || 0,
      }))
      res.json(mapped)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/series/seasons/:seasonId', validateBody(domains.UpdateSeason), (req, res) => {
    try {
      const { monitored, upgrade_allowed } = req.body
      db.prepare(`
        UPDATE seasons SET
          monitored = COALESCE(@monitored, monitored),
          upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: req.params.seasonId,
        monitored: monitored !== undefined ? (monitored ? 1 : 0) : null,
        upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null,
      })
      res.json(db.prepare('SELECT * FROM seasons WHERE id = ?').get(req.params.seasonId))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Episodes ──────────────────────────────────────────────────────────────

  router.get('/series/:id/episodes', (req, res) => {
    try {
      const episodes = db.prepare(`
        SELECT *,
          CASE WHEN air_date <= date('now') THEN 1 ELSE 0 END as aired
        FROM episodes
        WHERE series_id = ? AND series_id IN (SELECT id FROM series WHERE library_id = ?)
        ORDER BY season_number ASC, episode_number ASC
      `).all(req.params.id, libId(req)) as any[]

      const mapped = episodes.map(ep => ({
        ...ep,
        still_path: tmdbImageUrl(ep.still_path, 'w300'),
        downloadProgress: ep.download_progress || 0,
      }))
      res.json(mapped)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/series/episodes/:episodeId', validateBody(domains.UpdateEpisode), (req, res) => {
    try {
      const { monitored, upgrade_allowed } = req.body
      db.prepare(`
        UPDATE episodes SET
          monitored = COALESCE(@monitored, monitored),
          upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: req.params.episodeId,
        monitored: monitored !== undefined ? (monitored ? 1 : 0) : null,
        upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null,
      })
      res.json(db.prepare('SELECT * FROM episodes WHERE id = ?').get(req.params.episodeId))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Release scoring ───────────────────────────────────────────────────────

  function sortReleases(releases: any[]): any[] {
    const normTier = (t: number) => (t === 0 ? 4 : t)
    return releases.sort((a, b) => {
      const tierA = normTier(a.customTier ?? 0)
      const tierB = normTier(b.customTier ?? 0)
      if (tierA !== tierB) return tierA - tierB

      const scoreA = a.customScore ?? 0
      const scoreB = b.customScore ?? 0
      if (scoreA !== scoreB) return scoreB - scoreA

      const seedA = a.seeders ?? 0
      const seedB = b.seeders ?? 0
      if (seedA !== seedB) return seedB - seedA

      return 0
    })
  }

  function validateSeriesRelease(releaseTitle: string, seriesTitle: string, episodeQuery: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/[-:!?,]/g, ' ').replace(/\s+/g, ' ').trim()
    const title = normalize(releaseTitle)
    const words = title.split(/[\s.]+/).filter(Boolean)

    const seriesWords = normalize(seriesTitle).split(/\s+/).filter(Boolean)
    if (!seriesWords.every(w => words.includes(w))) return false

    const epMatch = episodeQuery.match(/[Ss](\d{1,2})[Ee](\d{1,2})/)
    if (epMatch) {
      const sxx = `s${epMatch[1].padStart(2, '0')}`
      const exx = `e${epMatch[2].padStart(2, '0')}`
      const hasEpisode = title.includes(`${sxx}${exx}`) || title.includes(`${sxx} ${exx}`)
      const isPack = /\b(complete|season|series|s\d{1,2}\s*-\s*s\d{1,2})\b/i.test(title)
      if (!hasEpisode && !isPack) return false
    }

    return true
  }

  async function performSeriesSearch(
    scope: number,
    bases: string[],
    validationQuery: string,
    seriesTitle: string,
    enabledIndexers: any[],
    limit = 10,
    onResults: (batch: any[]) => void,
    checkCancelled: () => void = () => {},
  ): Promise<void> {
    const releases: any[] = []
    const seen = new Set<string>()
    const seriesTiers = getTierTermsForMedia('series', scope)
    const tiers = [
      { name: 'Tier 1', terms: seriesTiers.tier1 },
      { name: 'Tier 2', terms: seriesTiers.tier2 },
      { name: 'Tier 3', terms: seriesTiers.tier3 },
      { name: 'Broad', terms: [] as string[] },
    ]

    // Broad → narrow: for a series-level search `bases` is the range-pack cascade
    // (S01-S06 … S01-S02) ending in the bare title; season/episode searches pass
    // a single scoped base. Tiers cycle within each base.
    for (const base of bases) {
      if (releases.length >= limit) break
      for (const tier of tiers) {
        if (releases.length >= limit) break
        checkCancelled()

        const searchQueries = tier.terms.length > 0
          ? tier.terms.map(term => `${base} ${term}`)
          : [base]

        for (const sq of searchQueries) {
          if (releases.length >= limit) break
          checkCancelled()
          logger.info(`Series ${tier.name} search: "${sq}" (found ${releases.length}/${limit})`)

          const prevLen = releases.length

          try {
            const results = await searchViaIndexers(enabledIndexers, sq, { categories: [5000], type: 'tvsearch', module: 'series' })
            for (const r of results) {
              if (releases.length >= limit) break
              if (seen.has(r.guid)) continue
              if (!validateSeriesRelease(r.title, seriesTitle, validationQuery)) continue
              seen.add(r.guid)
              releases.push({ ...r, customTier: scoreRelease(r.title).tier, customScore: scoreRelease(r.title).score })
            }
          } catch (err) {
            logger.debug(`Series search failed for "${sq}":`, err instanceof Error ? err.message : String(err))
          }

          const batch = releases.slice(prevLen)
          if (batch.length > 0) onResults(sortReleases([...batch]))
        }
      }
    }
  }

  // ── Releases ──────────────────────────────────────────────────────────────

  router.get('/series/releases/search', async (req, res) => {
    try {
      const { q } = req.query
      if (!q) return res.status(400).json({ error: 'q required' })
      const query = String(q)

      const seriesTitle = query.replace(/\s+[Ss]\d{1,2}([Ee]\d{1,2})?.*$/, '').trim()

      // Series-level search (bare title) expands into the broad → narrow range-pack
      // cascade so complete/multi-season packs surface first. Season/episode
      // searches carry a S##/S##E## token — stripping it changes the title, so
      // `query === seriesTitle` reliably means "no token = series level".
      let bases: string[] = [query]
      if (query.trim() === seriesTitle) {
        const seriesRow = db.prepare('SELECT id FROM series WHERE library_id = ? AND title = ? COLLATE NOCASE')
          .get(libId(req), seriesTitle) as { id: number } | undefined
        if (seriesRow) {
          const seasons = (db.prepare('SELECT DISTINCT season_number AS s FROM seasons WHERE series_id = ? AND season_number > 0')
            .all(seriesRow.id) as Array<{ s: number }>).map(r => r.s)
          const rangeBases = buildSeriesTargets(seriesTitle, { seasons, levels: { range: true, season: false, episode: false } })
            .map(t => t.base)
          if (rangeBases.length > 0) bases = [...rangeBases, seriesTitle]
        }
      }

      const enabledIndexers = getEnabledIndexerInstances()

      let isCancelled = false
      req.on('close', () => { isCancelled = true })
      const checkCancelled = () => { if (isCancelled) throw new Error('cancelled') }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()
      ;(res.socket as any)?.setNoDelay?.(true)

      const sendBatch = (batch: any[]) => {
        if (batch.length === 0) return
        res.write(`data: ${JSON.stringify(batch)}\n\n`)
        ;(res as any).flush?.()
      }

      await performSeriesSearch(libId(req), bases, query, seriesTitle, enabledIndexers, 40, sendBatch, checkCancelled)
      res.write(`event: done\ndata: {}\n\n`)
      res.end()
    } catch (err: any) {
      if (err.message !== 'cancelled') {
        logger.error('Series search failed:', err.message)
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
        res.end()
      }
    }
  })

  router.post('/series/download', validateBody(domains.DownloadSeries.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, seriesId, seasonNumber, episodeId } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      logger.info(`Sending series download to ${client.name}: ${downloadUrl.slice(0, 100)}...`)
      try {
        const result = await sendToDownloadClient(client, downloadUrl, 'archivist-series')

        if (result.success) {
          const infoHash = (result as any).infoHash ?? null
          if (episodeId) {
            db.prepare(`UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(infoHash, episodeId)
          } else if (seriesId && seasonNumber !== undefined) {
            db.prepare(`UPDATE seasons SET info_hash = ?, updated_at = datetime('now') WHERE series_id = ? AND season_number = ?`).run(infoHash, seriesId, seasonNumber)
            db.prepare(`
              UPDATE episodes
              SET status = 'acquiring', info_hash = ?, updated_at = datetime('now')
              WHERE series_id = ? AND season_number = ? AND status NOT IN ('collected', 'downloaded')
            `).run(infoHash, seriesId, seasonNumber)
          } else if (seriesId) {
            // Complete-series pack: every season and uncollected episode acquires
            db.prepare(`UPDATE seasons SET info_hash = ?, updated_at = datetime('now') WHERE series_id = ?`).run(infoHash, seriesId)
            db.prepare(`
              UPDATE episodes
              SET status = 'acquiring', info_hash = ?, updated_at = datetime('now')
              WHERE series_id = ? AND status NOT IN ('collected', 'downloaded')
            `).run(infoHash, seriesId)
          }
        }
        res.json(result)
      } catch (err) {
        logger.error(`Failed to send to download client: ${err instanceof Error ? err.message : String(err)}`)
        res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) })
      }
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  return router
}
