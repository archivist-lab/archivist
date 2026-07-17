import { Router } from 'express'
import { existsSync, writeFileSync as writeFs, mkdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import axios from 'axios'
import {
  scoreRelease, makeReleaseScorer, createLogger, sanitizeConfigValue,
  SCORE_TITLE_MATCH, SCORE_YEAR_EXACT, SCORE_YEAR_ADJACENT, SCORE_NO_YEAR,
  type ScoredRelease,
} from '@archivist/core'
import { domains } from '@archivist/contracts'
import { seedEditionRules } from '@archivist/db'
import { getDb } from '../../db.js'
import { validateBody } from '../../middleware/validate.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { blockRelease, listSubjectAcquisitionHistory } from '../../services/acquisition-decisions.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { getTierTermsForMedia } from '../../shared/settings.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { getFilmFileInfo, ensureFilmFolder, mapRemotePath } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { recordEvent } from '../../system/event-store.js'
import { searchMovies, getMovie, tmdbImageUrl } from './tmdb.js'
import { deserialiseFilm } from './serialize.js'
import { enqueueFilmMetadataRefresh } from './metadata-refresh.js'
import {
  parseQualityFromTitle, meetsQualityFloor, hasQualityFloor, isQualityUpgrade,
  type CandidateQuality, type QualityFloor,
} from '../../services/quality.js'

const logger = createLogger('Films')

export function createFilmsRouter(): Router {
  const router = Router()
  router.use('/films', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))

  // ── Scan mode ──────────────────────────────────────────────────────────────
  // A collected film below its target quality turns Scan into Upgrade; once at
  // target it's satisfied (button disabled). Not collected → acquire.
  type ScanMode = 'acquire' | 'upgrade' | 'satisfied'
  const filmFloor = (f: any): QualityFloor => ({ tier: f.target_tier, resolution: f.target_resolution, source: f.target_source })
  const filmQuality = (f: any): CandidateQuality => ({
    tier: f.current_tier ?? 0, resolution: f.current_resolution ?? null, source: f.current_source ?? null,
    codec: f.current_codec ?? null, releaseGroup: f.current_release_group ?? null, edition: f.current_edition ?? null,
  })
  const filmScanMode = (f: any): { mode: ScanMode; baseline: CandidateQuality | null } => {
    if (f.status !== 'collected') return { mode: 'acquire', baseline: null }
    const floor = filmFloor(f)
    if (!hasQualityFloor(floor) || meetsQualityFloor(filmQuality(f), floor)) return { mode: 'satisfied', baseline: null }
    return { mode: 'upgrade', baseline: filmQuality(f) }
  }

  function robustRootFolderPath(film: any): string | null {
    if (!film.root_folder_path) return null
    if (existsSync(film.root_folder_path)) return film.root_folder_path

    const folderName = basename(film.root_folder_path)
    const fallbackPath = join(process.cwd(), 'media', 'films', folderName)
    if (existsSync(fallbackPath)) return fallbackPath

    return film.root_folder_path
  }

  // ── Library ───────────────────────────────────────────────────────────────

  router.get('/films', (req, res) => {
    try {
      const films = (db.prepare(`
        SELECT f.*, (ml.media_id IS NOT NULL) AS loudness_measured
        FROM films f
        LEFT JOIN media_loudness ml ON ml.media_type = 'film' AND ml.media_id = f.id AND ml.file_path = f.file_path
        WHERE f.library_id = ? ORDER BY f.sort_title ASC
      `).all(libId(req)) as Record<string, unknown>[]).map(row => {
        const film = deserialiseFilm(row) as any
        film.posterPath = tmdbImageUrl(film.posterPath)
        film.backdropPath = tmdbImageUrl(film.backdropPath, 'w1280')
        film.poster_path = film.posterPath
        film.backdrop_path = film.backdropPath
        return film
      })
      res.json(films)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/films/lookup', async (req, res) => {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })
    try {
      const results = await searchMovies(String(q))
      const films = results.map(f => ({
        ...f,
        alreadyAdded: !!db.prepare('SELECT id FROM films WHERE library_id = ? AND tmdb_id = ?').get(libId(req), f.tmdbId),
      }))
      res.json(films)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' })
    }
  })

  router.get('/films/:id', (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })
      const film = deserialiseFilm(row) as any
      film.scanMode = filmScanMode(row).mode
      film.posterPath = tmdbImageUrl(film.posterPath)
      film.backdropPath = tmdbImageUrl(film.backdropPath, 'w1280')
      film.logoPath = tmdbImageUrl(film.logoPath, 'original')
      film.bannerPath = tmdbImageUrl(film.bannerPath, 'w1280')
      film.poster_path = film.posterPath
      film.backdrop_path = film.backdropPath

      const editions = db.prepare('SELECT * FROM film_editions WHERE film_id = ? ORDER BY id ASC').all(film.id) as any[]

      film.editions = editions.map(ed => {
        const editionObj = {
          ...ed,
          posterPath: tmdbImageUrl(ed.poster_path || film.poster_path),
          backdropPath: tmdbImageUrl(ed.backdrop_path || film.backdrop_path, 'w1280'),
          fileInfo: null as any,
        }
        if (ed.file_path && existsSync(ed.file_path)) {
          editionObj.fileInfo = getFilmFileInfo(ed.file_path)
        }
        return editionObj
      })

      let defaultEdition = film.editions.find((e: any) => e.id === film.default_edition_id)
      if (!defaultEdition && film.editions.length > 0) {
        defaultEdition = film.editions.find((e: any) => e.edition_name === 'Theatrical') ||
                         film.editions.find((e: any) => e.edition_name === "Director's Cut") ||
                         film.editions.find((e: any) => e.edition_name === 'Extended') ||
                         film.editions[0]
      }
      if (defaultEdition && defaultEdition.fileInfo) {
        film.fileInfo = defaultEdition.fileInfo
      }

      if (film.root_folder_path) {
        const trailerFile = join(film.root_folder_path, 'trailer.mkv')
        if (existsSync(trailerFile)) {
          const relative = film.root_folder_path.split('media').pop()?.replace(/\\/g, '/')
          film.trailerPath = `/media${relative}/trailer.mkv`
        }
      }

      res.json(film)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/films/tmdb/:tmdbId', async (req, res) => {
    try {
      const tmdbId = parseInt(req.params.tmdbId, 10)
      const local = db.prepare('SELECT * FROM films WHERE library_id = ? AND tmdb_id = ?').get(libId(req), tmdbId) as Record<string, unknown> | undefined

      if (local) {
        const filmData = deserialiseFilm(local) as any
        filmData.posterPath = tmdbImageUrl(filmData.posterPath)
        filmData.backdropPath = tmdbImageUrl(filmData.backdropPath, 'w1280')
        filmData.logoPath = tmdbImageUrl(filmData.logoPath, 'original')
        filmData.bannerPath = tmdbImageUrl(filmData.bannerPath, 'w1280')
        filmData.poster_path = filmData.posterPath
        filmData.backdrop_path = filmData.backdropPath

        const fileInfo = filmData.file_path ? getFilmFileInfo(mapRemotePath(filmData.file_path as string)) : null

        let trailerPath = undefined
        if (filmData.root_folder_path) {
          const trailerFile = join(filmData.root_folder_path, 'trailer.mkv')
          if (existsSync(trailerFile)) {
            const relative = filmData.root_folder_path.split('media').pop()?.replace(/\\/g, '/')
            trailerPath = `/media${relative}/trailer.mkv`
          }
        }

        return res.json({
          ...filmData,
          localId: filmData.id,
          status: filmData.status,
          fileInfo,
          trailerPath,
        })
      }

      const filmData = await getMovie(tmdbId)
      res.json({
        ...filmData,
        localId: undefined,
        status: 'uncollected',
        fileInfo: null,
      })
    } catch (err) {
      logger.error('Failed to fetch film data:', err)
      res.status(500).json({ error: 'Could not fetch film data. If you are offline, ensure the film is in your library.' })
    }
  })

  router.post('/films', validateBody(domains.AddFilm), async (req, res) => {
    try {
      const { tmdbId, qualityProfileId, rootFolderPath, monitored = true, target_tier, target_resolution, target_source, target_codec } = req.body

      const existing = db.prepare('SELECT id FROM films WHERE library_id = ? AND tmdb_id = ?').get(libId(req), tmdbId)
      if (existing) return res.status(409).json({ error: 'Film already in library' })
      const film = await getMovie(parseInt(tmdbId, 10))

      const { targetDir, posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo } = await ensureFilmFolder(film, resolveLibraryRoot(db, libId(req)))

      const sortTitle = film.title.replace(/^(The|A|An)\s+/i, '').toLowerCase()
      const primaryReleaseDate = film.releaseDate ?? film.digitalReleaseDate ?? film.physicalReleaseDate
      const postReleaseMetadataRefreshedAt = primaryReleaseDate
        && primaryReleaseDate.slice(0, 10) < new Date().toISOString().slice(0, 10)
        ? new Date().toISOString()
        : null
      const result = db.prepare(`
        INSERT INTO films (library_id, tmdb_id, imdb_id, title, original_title, sort_title, year, overview,
          runtime, genres, poster_path, backdrop_path, logo_path, banner_path, cast, crew, country, rating, certification, studio,
          monitored, quality_profile_id, root_folder_path, release_date, digital_release_date, physical_release_date,
          post_release_metadata_refreshed_at, status,
          target_tier, target_resolution, target_source, target_codec, available_versions)
        VALUES (@libraryId, @tmdbId, @imdbId, @title, @originalTitle, @sortTitle, @year, @overview,
          @runtime, @genres, @posterPath, @backdropPath, @logoPath, @bannerPath, @cast, @crew, @country, @rating, @certification, @studio,
          @monitored, @qualityProfileId, @rootFolderPath, @releaseDate, @digitalReleaseDate, @physicalReleaseDate,
          @postReleaseMetadataRefreshedAt, 'missing',
          @target_tier, @target_resolution, @target_source, @target_codec, @availableVersions)
      `).run({
        libraryId: libId(req),
        tmdbId: film.tmdbId, imdbId: film.imdbId ?? null, title: film.title,
        originalTitle: film.originalTitle, sortTitle, year: film.year ?? null,
        overview: film.overview ?? null, runtime: film.runtime ?? null,
        genres: JSON.stringify(film.genres),
        posterPath: localPoster ?? film.posterPath ?? null,
        backdropPath: localBackdrop ?? film.backdropPath ?? null,
        logoPath: localLogo ?? film.logoPath ?? null,
        bannerPath: film.bannerPath ?? null,
        cast: JSON.stringify(film.cast ?? []),
        crew: JSON.stringify(film.crew ?? []),
        country: film.country ?? null,
        rating: film.rating ?? null,
        certification: film.certification ?? null, studio: film.studio ?? null,
        monitored: monitored ? 1 : 0, qualityProfileId: qualityProfileId ?? null,
        rootFolderPath: targetDir, releaseDate: film.releaseDate ?? null,
        digitalReleaseDate: film.digitalReleaseDate ?? null,
        physicalReleaseDate: film.physicalReleaseDate ?? null,
        postReleaseMetadataRefreshedAt,
        target_tier: target_tier ?? null,
        target_resolution: target_resolution ?? null,
        target_source: target_source ?? null,
        target_codec: target_codec ?? null,
        availableVersions: JSON.stringify(film.availableVersions ?? []),
      })

      const inserted = db.prepare('SELECT * FROM films WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
      const filmRes = deserialiseFilm(inserted) as any
      filmRes.posterPath = tmdbImageUrl(filmRes.posterPath)
      filmRes.backdropPath = tmdbImageUrl(filmRes.backdropPath, 'w1280')
      filmRes.logoPath = tmdbImageUrl(filmRes.logoPath, 'original')
      filmRes.bannerPath = tmdbImageUrl(filmRes.bannerPath, 'w1280')

      res.status(201).json(filmRes)
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/films/editions/:id', (req, res) => {
    try {
      const { edition_name } = req.body
      if (!edition_name) return res.status(400).json({ error: 'edition_name required' })

      db.prepare(`
        UPDATE film_editions
        SET edition_name = ?, updated_at = datetime('now')
        WHERE id = ? AND film_id IN (SELECT id FROM films WHERE library_id = ?)
      `).run(edition_name, req.params.id, libId(req))

      res.json({ success: true })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/films/:id', validateBody(domains.UpdateFilm), (req, res) => {
    try {
      const { monitored, status, qualityProfileId, rootFolderPath, upgrade_allowed, target_tier, target_resolution, target_source, target_codec, default_edition_id } = req.body
      db.prepare(`
        UPDATE films SET
          monitored = COALESCE(@monitored, monitored),
          status = COALESCE(@status, status),
          quality_profile_id = COALESCE(@qualityProfileId, quality_profile_id),
          root_folder_path = COALESCE(@rootFolderPath, root_folder_path),
          upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed),
          target_tier = COALESCE(@target_tier, target_tier),
          target_resolution = COALESCE(@target_resolution, target_resolution),
          target_source = COALESCE(@target_source, target_source),
          target_codec = COALESCE(@target_codec, target_codec),
          default_edition_id = COALESCE(@default_edition_id, default_edition_id),
          updated_at = datetime('now')
        WHERE id = @id AND library_id = @libraryId
      `).run({
        id: req.params.id,
        libraryId: libId(req),
        monitored: monitored !== undefined ? (monitored ? 1 : 0) : null,
        upgradeAllowed: upgrade_allowed !== undefined ? (upgrade_allowed ? 1 : 0) : null,
        status: status ?? null, qualityProfileId: qualityProfileId ?? null,
        rootFolderPath: rootFolderPath ?? null,
        target_tier: target_tier ?? null,
        target_resolution: target_resolution ?? null,
        target_source: target_source ?? null,
        target_codec: target_codec ?? null,
        default_edition_id: default_edition_id ?? null,
      })
      const updated = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!updated) return res.status(404).json({ error: 'Not found' })
      res.json(deserialiseFilm(updated))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/films/:id/acquisition-history', (req, res) => {
    try {
      const film = db.prepare('SELECT id FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req))
      if (!film) return res.status(404).json({ error: 'Film not found' })
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100
      res.json(listSubjectAcquisitionHistory({
        mediaType: 'films',
        subjectType: 'film',
        subjectId: req.params.id,
      }, Number.isFinite(limit) ? limit : 100))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/films/:id/reject-current-release', (req, res) => {
    try {
      const film = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!film) return res.status(404).json({ error: 'Film not found' })
      if (!film.info_hash && !film.current_release_title) return res.status(400).json({ error: 'Film has no current release to reject' })
      blockRelease({
        infoHash: film.info_hash,
        releaseTitle: film.current_release_title ?? film.title,
        reason: req.body?.reason ?? 'user-rejected-release',
        tabId: libId(req),
        mediaType: 'films',
        subjectType: 'film',
        subjectId: film.id,
      })
      db.prepare(`
        UPDATE films
        SET status = CASE WHEN file_path IS NULL THEN 'missing' ELSE status END,
            info_hash = NULL,
            download_progress = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(film.id)
      recordEvent({ category: 'acquisition', action: 'release-rejected', subjectType: 'film', subjectId: String(film.id), message: `Rejected current release for "${film.title}"` })
      res.json({ success: true })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/films/:id/repair', (req, res) => {
    try {
      const film = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!film) return res.status(404).json({ error: 'Film not found' })

      const deleteFile = req.body?.deleteFile === true
      const rejectCurrent = req.body?.rejectCurrent !== false
      if (rejectCurrent && (film.info_hash || film.current_release_title)) {
        blockRelease({
          infoHash: film.info_hash,
          releaseTitle: film.current_release_title ?? film.title,
          reason: 'repair-rejected-current-release',
          tabId: libId(req),
          mediaType: 'films',
          subjectType: 'film',
          subjectId: film.id,
        })
      }

      if (deleteFile && film.file_path && existsSync(film.file_path)) {
        rmSync(film.file_path, { force: true })
      }

      db.prepare(`
        UPDATE films
        SET status = 'missing',
            file_path = NULL,
            file_size = NULL,
            quality = NULL,
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
        WHERE id = ?
      `).run(film.id)

      recordEvent({ category: 'library', action: 'repair', subjectType: 'film', subjectId: String(film.id), message: `Repair reset "${film.title}" to missing` })
      const updated = db.prepare('SELECT * FROM films WHERE id = ?').get(req.params.id) as Record<string, unknown>
      res.json(deserialiseFilm(updated))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.delete('/films/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const row = db.prepare('SELECT root_folder_path, file_path FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (row && deleteFiles && !safeDeleteMediaPath(row.root_folder_path)) safeDeleteMediaPath(row.file_path)
      const result = db.prepare('DELETE FROM films WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      if (result.changes > 0) {
        recordEvent({ category: 'library', action: deleteFiles ? 'film-deleted' : 'film-removed', subjectType: 'film', subjectId: String(req.params.id), message: `Film ${req.params.id} ${deleteFiles ? 'deleted with files' : 'removed'} from library ${libId(req)}` })
      }
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/films/refresh', async (req, res) => {
    try {
      const films = db.prepare('SELECT id, tmdb_id FROM films WHERE library_id = ?').all(libId(req)) as Array<{ id: number; tmdb_id: number }>
      let queued = 0
      for (const film of films) {
        if (film.tmdb_id && enqueueFilmMetadataRefresh(film.id) !== null) queued++
      }
      logger.info(`Queued metadata refresh for ${queued} of ${films.length} films`)
      res.json({ success: true, message: `Refresh started for ${films.length} films; ${queued} queued.` })
    } catch (err) {
      logger.error('Failed to start film refresh:', err)
      res.status(500).json({ error: 'Failed to start refresh' })
    }
  })

  // ── Release scoring & validation ──────────────────────────────────────────

  function validateFilmRelease(releaseTitle: string, filmTitle: string, filmYear?: number, scorer: (t: string) => ScoredRelease = scoreRelease): { valid: boolean; score: number } {
    const title = releaseTitle.toLowerCase().replace(/[:!?,]/g, ' ')
    const target = filmTitle.toLowerCase().replace(/[:!?,]/g, ' ')
    const targetClean = target.replace(/^(the|a|an)\s+/i, '').trim().replace(/\s+/g, ' ')

    if (/\b(S\d+E\d+|S\d+|Season \d+|Complete|E\d+)\b/i.test(title)) return { valid: false, score: 0 }

    const sequels = ['reloaded', 'revolutions', 'resurrections', 'prophecy', 'origins', 'rising', 'rises', 'legacy', 'returns']
    for (const seq of sequels) {
      if (title.includes(seq) && !target.includes(seq)) return { valid: false, score: 0 }
    }

    const partMatch = title.match(/\bpart\s*(\d+|one|two|three|four|five|i+v?|v)\b/i)
    if (partMatch) {
      const targetPartMatch = target.match(/\bpart\s*(\d+|one|two|three|four|five|i+v?|v)\b/i)
      if (!targetPartMatch || partMatch[1].toLowerCase() !== targetPartMatch[1].toLowerCase()) {
        return { valid: false, score: 0 }
      }
    }

    let score = scorer(releaseTitle).score

    const normalize = (s: string) => s.replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
    const words = normalize(title).split(/[\s.]+/).filter(Boolean)
    const targetWords = normalize(targetClean).split(/\s+/).filter(Boolean)

    const startMatches = targetWords.every(word => words.includes(word))
    if (!startMatches) {
      return { valid: false, score: 0 }
    }

    score += SCORE_TITLE_MATCH

    if (filmYear) {
      if (title.includes(String(filmYear))) score += SCORE_YEAR_EXACT
      else if (title.includes(String(filmYear + 1)) || title.includes(String(filmYear - 1))) score += SCORE_YEAR_ADJACENT
      else score += SCORE_NO_YEAR
    }

    return { valid: true, score }
  }

  // ── Tiered search ─────────────────────────────────────────────────────────

  async function performTieredSearch(
    scope: number,
    query: string,
    year: number | undefined,
    enabledIndexers: any[],
    limit = 10,
    resolution?: string,
    tierName?: string,
    source?: string,
    checkCancelled: () => void = () => {},
    onResults?: (batch: any[]) => void,
    codec?: string,
    keepRelease?: (title: string) => boolean,
  ): Promise<any[]> {
    const releases: any[] = []
    const filmTiers = getTierTermsForMedia('films', scope)
    const filmScorer = makeReleaseScorer(filmTiers)
    const allTiers = [
      { name: 'Tier 1', terms: filmTiers.tier1 },
      { name: 'Tier 2', terms: filmTiers.tier2 },
      { name: 'Tier 3', terms: filmTiers.tier3 },
      { name: 'Broad', terms: [] as string[] },
    ]

    const tiers = tierName && tierName !== 'Any'
      ? allTiers.filter(t => t.name.toLowerCase() === tierName.toLowerCase() || t.name.toLowerCase().includes(tierName.toLowerCase()))
      : allTiers

    for (const tier of tiers) {
      if (releases.length >= limit) break
      checkCancelled()
      logger.info(`Starting ${tier.name} search for "${query}"${resolution ? ` (${resolution})` : ''}${source ? ` (${source})` : ''} (Found: ${releases.length}/${limit})...`)

      const baseQueries = tier.terms.length > 0
        ? tier.terms.map((term: string) => `${query} ${term}`)
        : [query]

      let searchQueries = resolution && resolution !== 'Any'
        ? baseQueries.map(bq => `${bq} ${resolution}`)
        : baseQueries

      if (source && source !== 'Any') {
        searchQueries = searchQueries.map(sq => `${sq} ${source}`)
      }

      const codecSearchTerms: Record<string, string[]> = {
        'Remux': ['remux'],
        'AV1': ['AV1'],
        'x265': ['x265', 'HEVC'],
        'x264': ['x264'],
      }
      if (codec && codec !== 'Any' && codec !== 'Legacy' && codecSearchTerms[codec]) {
        const terms = codecSearchTerms[codec]!
        searchQueries = searchQueries.flatMap(sq => terms.map(t => `${sq} ${t}`))
      }

      const legacyExclude = /remux|av1|x\.?265|h\.?265|hevc|x\.?264|h\.?264/i

      for (const sq of searchQueries) {
        if (releases.length >= limit) break
        checkCancelled()

        const prevLen = releases.length
        try {
          const results = await searchViaIndexers(enabledIndexers, sq, { categories: [2000], type: 'movie', module: 'films' })
          for (const r of results) {
            if (releases.length >= limit) break
            const val = validateFilmRelease(r.title, query, year, filmScorer)
            if (!val.valid) continue
            if (codec === 'Legacy' && legacyExclude.test(r.title)) continue
            if (keepRelease && !keepRelease(r.title)) continue // upgrade mode: only releases beating the current file
            releases.push({
              ...r,
              customTier: filmScorer(r.title).tier,
              customScore: val.score,
            })
          }
          if (results.length > 0) logger.info(`Found ${releases.length - prevLen} valid results for "${sq}"`)
        } catch (err) {
          logger.debug('Index search failed:', err instanceof Error ? err.message : String(err))
        }

        const batch = releases.slice(prevLen)
        if (batch.length > 0) onResults?.(sortReleases([...batch]))
      }
    }

    if (releases.length === 0 && resolution) {
      logger.info(`No results found with resolution "${resolution}". Trying broad search without it...`)
      const broadResults = await performTieredSearch(scope, query, year, enabledIndexers, limit, undefined, 'Broad', source, checkCancelled, onResults, codec, keepRelease)
      releases.push(...broadResults)
    }

    return releases
  }

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

      const prioA = a.indexerPriority ?? 25
      const prioB = b.indexerPriority ?? 25
      return prioA - prioB
    })
  }

  // ── Release search (SSE) ──────────────────────────────────────────────────

  router.get('/films/releases/search', async (req, res) => {
    try {
      const { q } = req.query
      const year = req.query.year ? parseInt(String(req.query.year)) : undefined
      if (!q) return res.status(400).json({ error: 'q required' })

      const query = String(q)
      const enabledIndexers = getEnabledIndexerInstances()
      const resolution = req.query.resolution ? String(req.query.resolution) : undefined
      const tier = req.query.tier ? String(req.query.tier) : undefined
      const source = req.query.source ? String(req.query.source) : undefined
      const codec = req.query.codec ? String(req.query.codec) : undefined

      // Upgrade mode: a collected film below target only streams releases that
      // beat the current file. Film context comes from the client (filmId).
      let keepRelease: ((title: string) => boolean) | undefined
      const filmId = req.query.filmId ? Number(req.query.filmId) : undefined
      if (filmId) {
        const film = db.prepare('SELECT status, target_tier, target_resolution, target_source, current_tier, current_resolution, current_source, current_codec, current_release_group, current_edition FROM films WHERE id = ? AND library_id = ?').get(filmId, libId(req)) as any
        const scan = film ? filmScanMode(film) : { mode: 'acquire', baseline: null }
        if (scan.mode === 'upgrade' && scan.baseline) {
          const scorer = makeReleaseScorer(getTierTermsForMedia('films', libId(req)))
          const baseline = scan.baseline
          keepRelease = (title: string) => isQualityUpgrade(baseline, parseQualityFromTitle(title, scorer))
        }
      }

      let isCancelled = false
      req.on('close', () => { isCancelled = true })

      const checkCancelled = () => {
        if (isCancelled) throw new Error('Search cancelled by client')
      }

      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()
      ;(res.socket as any)?.setNoDelay?.(true)

      const tierId = tier === 'Tier 1' ? 1 : tier === 'Tier 2' ? 2 : tier === 'Tier 3' ? 3 : undefined
      const sendBatch = (batch: any[]) => {
        const mapped = batch.map(r => ({ ...r, tier: tierId }))
        res.write(`data: ${JSON.stringify(mapped)}\n\n`)
        ;(res as any).flush?.()
      }

      try {
        await performTieredSearch(libId(req), query, year, enabledIndexers, 40, resolution, tier, source, checkCancelled, sendBatch, codec, keepRelease)
        res.write(`event: done\ndata: {}\n\n`)
      } catch (err: any) {
        if (err.message === 'Search cancelled by client') {
          logger.info(`Search for "${query}" was cancelled by client`)
        } else {
          logger.error(`Search for "${query}" failed:`, err)
          res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`)
        }
      }
      res.end()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Download & auto-grab ──────────────────────────────────────────────────

  router.post('/films/download', validateBody(domains.DownloadFilm), async (req, res) => {
    try {
      const { downloadUrl, filmId, tier } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      logger.info(`Sending download to ${client.name}: ${downloadUrl.slice(0, 100)}...`)
      try {
        const result = await sendToDownloadClient(client, downloadUrl, 'archivist-films')

        if (result.success && filmId) {
          db.prepare(`UPDATE films SET status = 'acquiring', info_hash = ?, download_tier = ?, acquired_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND library_id = ?`)
            .run((result as any).infoHash ?? null, tier || null, filmId, libId(req))
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

  router.post('/films/:id/auto-grab', async (req, res) => {
    try {
      const film = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!film) return res.status(404).json({ error: 'Film not found' })

      logger.info(`Starting auto-grab for: "${film.title}" (${film.year})`)
      const enabledIndexers = getEnabledIndexerInstances()

      // Upgrade-aware: a collected film below target only accepts a release that
      // beats what's on disk; one already at target is skipped.
      const scan = filmScanMode(film)
      if (scan.mode === 'satisfied') return res.status(409).json({ error: 'Already at target quality' })
      let keepRelease: ((title: string) => boolean) | undefined
      if (scan.mode === 'upgrade' && scan.baseline) {
        const scorer = makeReleaseScorer(getTierTermsForMedia('films', libId(req)))
        const baseline = scan.baseline
        keepRelease = (title: string) => isQualityUpgrade(baseline, parseQualityFromTitle(title, scorer))
      }

      const candidates = await performTieredSearch(libId(req), film.title as string, film.year as number | undefined, enabledIndexers, 3, undefined, undefined, undefined, () => {}, undefined, undefined, keepRelease)

      const sorted = sortReleases(candidates)
      const best = sorted[0]
      if (!best) {
        const msg = keepRelease ? 'No upgrade over the current file found' : 'No matching releases found'
        logger.warn(`Auto-grab: ${msg} for "${film.title}"`)
        return res.status(404).json({ error: msg })
      }

      logger.info(`Auto-grab selected: "${best.title}" from ${best.indexerName} (Seeders: ${best.seeders}, Tier: ${best.customTier})`)

      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No download clients configured' })
      const client = clients.sort((a, b) => a.priority - b.priority)[0]

      const result = await sendToDownloadClient(client, best.downloadUrl, 'archivist-films')

      if (result.success) {
        db.prepare(`UPDATE films SET status = 'acquiring', info_hash = ?, acquired_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND library_id = ?`)
          .run((result as any).infoHash ?? null, req.params.id, libId(req))
      } else {
        logger.error(`Auto-grab: failed to send to client: ${result.message}`)
      }

      res.json(result)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Metadata editor ───────────────────────────────────────────────────────

  router.put('/films/:id/metadata', async (req, res) => {
    try {
      const { title, original_title, year, overview, genres, certification, studio, runtime, country, rating } = req.body
      const row = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      const sortTitle = (title ?? row.title as string).replace(/^(The|A|An)\s+/i, '').toLowerCase()
      db.prepare(`
        UPDATE films SET
          title = COALESCE(@title, title),
          original_title = COALESCE(@original_title, original_title),
          sort_title = @sortTitle,
          year = COALESCE(@year, year),
          overview = COALESCE(@overview, overview),
          genres = COALESCE(@genres, genres),
          certification = COALESCE(@certification, certification),
          studio = COALESCE(@studio, studio),
          runtime = COALESCE(@runtime, runtime),
          country = COALESCE(@country, country),
          rating = COALESCE(@rating, rating),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: row.id,
        title: title ?? null,
        original_title: original_title ?? null,
        sortTitle,
        year: year ?? null,
        overview: overview ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
        certification: certification ?? null,
        studio: studio ?? null,
        runtime: runtime ?? null,
        country: country ?? null,
        rating: rating ?? null,
      })

      const updated = db.prepare('SELECT * FROM films WHERE id = ?').get(row.id) as Record<string, unknown>
      const film = deserialiseFilm(updated) as any
      const rootPath = robustRootFolderPath(film)
      if (rootPath) {
        if (!existsSync(rootPath)) {
          try { mkdirSync(rootPath, { recursive: true }) } catch {}
        }
        if (existsSync(rootPath)) {
          try {
            const nfoFilename = `${film.title} (${film.year}).nfo`.replace(/[/\\:*?"<>|]/g, '')
            const nfoPath = join(rootPath, nfoFilename)
            const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<movie>\n  <title>${film.title}</title>\n  <originaltitle>${film.original_title || ''}</originaltitle>\n  <year>${film.year || ''}</year>\n  <plot>${film.overview || ''}</plot>\n  <runtime>${film.runtime || ''}</runtime>\n  <mpaa>${film.certification || ''}</mpaa>\n  <uniqueid type="tmdb" default="true">${film.tmdb_id || ''}</uniqueid>\n  <uniqueid type="imdb">${film.imdb_id || ''}</uniqueid>\n  <genre>${(film.genres || []).join(' / ')}</genre>\n  <studio>${film.studio || ''}</studio>\n  <country>${film.country || ''}</country>\n  <rating>${film.rating || ''}</rating>\n</movie>`
            writeFs(nfoPath, nfo)
          } catch (nfoErr) {
            logger.warn(`Failed to write NFO: ${nfoErr instanceof Error ? nfoErr.message : String(nfoErr)}`)
          }
        }
      }

      recordEvent({ category: 'metadata', action: 'film-edited', subjectType: 'film', subjectId: String(film.id), message: `Metadata edited for "${film.title}"` })

      film.posterPath = tmdbImageUrl(film.posterPath)
      film.backdropPath = tmdbImageUrl(film.backdropPath, 'w1280')
      film.logoPath = tmdbImageUrl(film.logoPath, 'original')
      film.poster_path = film.posterPath
      film.backdrop_path = film.backdropPath
      res.json(film)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Image search ──────────────────────────────────────────────────────────

  router.get('/films/:id/images', async (req, res) => {
    try {
      const { type, language } = req.query as { type?: string; language?: string }
      const row = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })
      const film = deserialiseFilm(row) as any
      const tmdbId = film.tmdb_id
      const lang = language || 'en'

      const results: Array<{ url: string; source: string; type: string; language: string; width?: number; height?: number }> = []

      try {
        const tmdbKey = sanitizeConfigValue(process.env.TMDB_API_KEY)
        const tmdbBase = process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3'
        const tmdbRes = await axios.get(`${tmdbBase}/movie/${tmdbId}/images`, {
          params: { api_key: tmdbKey, include_image_language: `${lang},null` },
          timeout: 10000,
        })
        const tmdbImages = tmdbRes.data
        const typeMap: Record<string, string> = {
          poster: 'posters',
          backdrop: 'backdrops',
          logo: 'logos',
          thumb: 'backdrops',
        }
        const tmdbType = typeMap[type || 'poster']

        if (tmdbType) {
          const images = tmdbImages[tmdbType] ?? []
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
        }
      } catch (err) {
        logger.warn(`TMDB image search failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      try {
        const fanartKey = process.env.FANART_API_KEY || '52246d363a13fca319113973cfaf19aa'
        const fanartRes = await axios.get(`https://webservice.fanart.tv/v3/movies/${tmdbId}`, {
          params: { api_key: fanartKey },
          timeout: 10000,
        })
        const fanart = fanartRes.data
        const fanartTypeMap: Record<string, string[]> = {
          poster: ['movieposter'],
          backdrop: ['moviebackground'],
          logo: ['hdmovielogo', 'movielogo'],
          banner: ['moviebanner'],
          clearart: ['hdmovieclearart', 'movieart'],
          thumb: ['moviethumb'],
          disc: ['moviedisc'],
        }
        const fanartTypes = fanartTypeMap[type || 'poster'] || ['movieposter']
        for (const ft of fanartTypes) {
          const items = fanart[ft] ?? []
          for (const img of items.filter((i: any) => !lang || i.lang === lang || i.lang === '').slice(0, 15)) {
            results.push({
              url: img.url,
              source: 'Fanart.tv',
              type: type || 'poster',
              language: img.lang || 'null',
            })
          }
        }
      } catch {
        // Fanart.tv may not have data for this film
      }

      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Save image ────────────────────────────────────────────────────────────

  router.put('/films/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })

      const row = db.prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })
      const film = deserialiseFilm(row) as any

      const rootPath = robustRootFolderPath(film)
      if (!rootPath) {
        return res.status(400).json({ error: 'Film has no media folder defined' })
      }

      if (!existsSync(rootPath)) {
        try {
          mkdirSync(rootPath, { recursive: true })
        } catch (err) {
          return res.status(500).json({ error: `Failed to create media folder: ${String(err)}` })
        }
      }

      const fileMap: Record<string, string> = {
        poster: 'poster.jpg',
        backdrop: 'backdrop.jpg',
        logo: 'logo.png',
        banner: 'banner.jpg',
        clearart: 'clearart.png',
        thumb: 'thumb.jpg',
        disc: 'disc.png',
      }
      const filename = fileMap[type]
      if (!filename) return res.status(400).json({ error: `Unknown image type: ${type}` })

      const targetPath = join(rootPath, filename)
      const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Archivist/2.0' } })
      writeFs(targetPath, imgRes.data)

      const relativeDir = rootPath.split('media').pop()?.replace(/\\/g, '/')
      const localPath = `/media${relativeDir}/${filename}`.replace(/\\/g, '/')

      const dbCol: Record<string, string> = { poster: 'poster_path', backdrop: 'backdrop_path', logo: 'logo_path', banner: 'banner_path' }
      if (dbCol[type]) {
        db.prepare(`UPDATE films SET ${dbCol[type]} = ?, updated_at = datetime('now') WHERE id = ?`).run(localPath, row.id)
      }

      recordEvent({ category: 'metadata', action: 'image-saved', subjectType: 'film', subjectId: String(row.id), message: `Saved ${type} image for "${film.title}"` })
      res.json({ success: true, path: localPath })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  // ── Edition rules ─────────────────────────────────────────────────────────

  router.get('/films/edition-rules/all', (req, res) => {
    try {
      seedEditionRules(db, libId(req))
      const rules = db.prepare('SELECT * FROM edition_rules WHERE library_id = ? ORDER BY priority DESC, id ASC').all(libId(req))
      res.json(rules)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/films/edition-rules', (req, res) => {
    try {
      const { rule_name, regex_pattern, output_label, priority, active } = req.body
      const result = db.prepare(`
        INSERT INTO edition_rules (library_id, rule_name, regex_pattern, output_label, priority, active)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(libId(req), rule_name, regex_pattern, output_label, priority ?? 0, active ?? 1)
      const newRule = db.prepare('SELECT * FROM edition_rules WHERE id = ?').get(result.lastInsertRowid)
      res.json(newRule)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/films/edition-rules/:id', (req, res) => {
    try {
      const { rule_name, regex_pattern, output_label, priority, active } = req.body
      db.prepare(`
        UPDATE edition_rules SET
          rule_name = COALESCE(?, rule_name),
          regex_pattern = COALESCE(?, regex_pattern),
          output_label = COALESCE(?, output_label),
          priority = COALESCE(?, priority),
          active = COALESCE(?, active)
        WHERE id = ? AND library_id = ?
      `).run(rule_name, regex_pattern, output_label, priority, active, req.params.id, libId(req))
      const updated = db.prepare('SELECT * FROM edition_rules WHERE id = ?').get(req.params.id)
      res.json(updated)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.delete('/films/edition-rules/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM edition_rules WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      res.json({ success: true })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  return router
}
