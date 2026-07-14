import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { createLogger } from '@archivist/core'
import type { PlaybackProgress, PlayerApiError, PlayerHubId, PlayerTelemetryBatch } from '@archivist/contracts'
import { getDb } from '../db.js'
import {
  completeSessionItem, createSession, endSession, getGuide, getNow, getSession,
  type SessionMode,
} from '../channels/service.js'
import { probeTracks, streamSubtitleVtt, streamTranscode } from './media.js'
import { DEFAULT_TARGET_LUFS, enqueueLoudness, getLoudness, loudnessQueueStatus, loudnormFilter } from './loudness.js'
import { getPlayerConfig } from './config.js'
import { decodePlayerCursor, encodePlayerCursor, getPlayerHub, PlayerCursorError, PlayerHubNotFoundError } from './hub-service.js'
import {
  getPlayerPreferences, PlayerPreferencesConflictError, PlayerPreferencesValidationError,
  resetPlayerPreferences, updatePlayerPreferences,
} from './preferences.js'
import {
  parseJson, serializeEpisodeSummary as episodeSummary, serializeFilmDetail as filmDetail,
  serializeFilmSummary as filmSummary, serializeSeriesSummary as seriesSummary,
} from './serializers.js'
import {
  getPlayerMetricSnapshot, PlayerTelemetryValidationError, recordPlayerTelemetry,
} from './telemetry.js'

const logger = createLogger('Player')

/**
 * Player API — the stable, read/play consumer contract for Archivist Player
 * (see archivist-player.md). Deliberately narrower than the admin/domain
 * routes: consumption shapes only, spans all libraries (no x-tab-context
 * required), never leaks server file paths, and exposes opaque stream URLs.
 *
 * Mounted at /api/v1/player (route paths here carry no /player prefix).
 */

const AVAILABLE_STATUSES = ['collected', 'downloaded']

// ── Streaming ────────────────────────────────────────────────────────────────

/**
 * Serves a media file with HTTP range support (Express sendFile handles Range
 * and HEAD). The client only ever sees the opaque stream URL — never the path.
 */
function streamFile(res: any, filePath: string | null | undefined) {
  if (!filePath) return res.status(404).json({ error: 'No playable file' })
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return res.status(410).json({ error: 'File no longer exists' })
  }
  res.sendFile(filePath, { acceptRanges: true, cacheControl: false }, (err: any) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Stream failed' })
  })
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createPlayerRouter(): Router {
  const router = Router()
  const db = getDb()
  const playerConfig = getPlayerConfig(process.env)
  const serverTelemetrySessionId = '00000000-0000-4000-8000-000000000000'

  router.use((req: any, res, next) => {
    const startedAt = performance.now()
    req.requestId = randomUUID()
    res.setHeader('X-Request-ID', req.requestId)
    res.once('finish', () => logger.info('Player request', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }))
    next()
  })

  const mediaTiming = (res: any) => (operation: string, durationMs: number, _outcome: 'ok' | 'error') => {
    if (!res.headersSent) res.append('Server-Timing', `${operation};dur=${durationMs.toFixed(1)}`)
    if (!playerConfig.telemetryEnabled) return
    const name = operation === 'probe' ? 'player_probe_ms' : operation === 'transcode' ? 'player_transcode_start_ms' : null
    if (name) recordPlayerTelemetry({ sessionId: serverTelemetrySessionId, samples: [{ name, valueMs: durationMs, at: Date.now() }] })
  }

  const sendUiError = (req: any, res: any, err: unknown) => {
    let status = 500
    let code = 'PLAYER_INTERNAL_ERROR'
    let message = 'The Player request could not be completed'
    let details: Record<string, string | number | boolean> | undefined
    if (err instanceof PlayerPreferencesValidationError || err instanceof PlayerTelemetryValidationError || err instanceof PlayerCursorError) {
      status = 400
      code = err instanceof PlayerCursorError ? 'PLAYER_CURSOR_INVALID' : 'PLAYER_INPUT_INVALID'
      message = err.message
      if (err instanceof PlayerPreferencesValidationError) details = { path: err.path }
    } else if (err instanceof PlayerPreferencesConflictError) {
      status = 409
      code = 'PLAYER_PREFERENCES_CONFLICT'
      message = err.message
      if (playerConfig.telemetryEnabled) recordPlayerTelemetry({ sessionId: serverTelemetrySessionId, samples: [{ name: 'player_preference_conflict_count', valueMs: 1, at: Date.now() }] })
    } else if (err instanceof PlayerHubNotFoundError) {
      status = 404
      code = 'PLAYER_NOT_FOUND'
      message = err.message
    }
    const body: PlayerApiError & { current?: unknown } = {
      error: { code, message, requestId: req.requestId ?? '', ...(details ? { details } : {}) },
    }
    if (err instanceof PlayerPreferencesConflictError) body.current = err.current
    if (status >= 500) logger.error('Player UI request failed', { requestId: req.requestId, error: err instanceof Error ? err.message : String(err) })
    res.status(status).json(body)
  }

  const listLibraries = () => {
    const libs = db.prepare("SELECT id, name, media_type FROM libraries WHERE media_type IN ('films','series') ORDER BY media_type, name").all() as any[]
    const filmCounts = db.prepare(`SELECT library_id, COUNT(*) AS total, SUM(CASE WHEN file_path IS NOT NULL THEN 1 ELSE 0 END) AS available FROM films GROUP BY library_id`).all() as any[]
    const seriesCounts = db.prepare(`
      SELECT s.library_id, COUNT(DISTINCT s.id) AS total,
             SUM(CASE WHEN e.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available
      FROM series s LEFT JOIN episodes e ON e.series_id = s.id
      GROUP BY s.library_id`).all() as any[]
    const counts = new Map<number, { total: number; available: number }>()
    for (const c of [...filmCounts, ...seriesCounts]) counts.set(c.library_id, { total: c.total ?? 0, available: c.available ?? 0 })
    return libs.map(l => ({
      id: l.id,
      name: l.name,
      mediaType: l.media_type,
      itemCount: counts.get(l.id)?.total ?? 0,
      availableCount: counts.get(l.id)?.available ?? 0,
    }))
  }

  const listProgress = (profileId = 'default') => {
    const rows = db.prepare('SELECT * FROM playback_progress WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId) as any[]
    return rows.flatMap<PlaybackProgress>(row => {
      if (row.media_type === 'film') {
        const media = db.prepare('SELECT * FROM films WHERE id = ?').get(row.media_id) as any
        if (!media) return []
        const summary = filmSummary(media)
        return [{
          key: `film:${media.id}`, type: 'film' as const, id: media.id, title: media.title,
          posterUrl: media.poster_path ?? null, backdropUrl: media.backdrop_path ?? null,
          streamUrl: summary.playback?.streamUrl ?? '', positionSeconds: row.position_seconds,
          durationSeconds: row.duration_seconds ?? summary.runtimeSeconds ?? 0, completed: !!row.completed,
          updatedAt: new Date(row.updated_at).getTime(),
        }]
      }
      const media = db.prepare(`SELECT e.*, s.title AS series_title, s.poster_path AS series_poster,
        s.backdrop_path AS series_backdrop FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?`).get(row.media_id) as any
      if (!media) return []
      const summary = episodeSummary(media)
      return [{
        key: `episode:${media.id}`, type: 'episode' as const, id: media.id,
        title: media.title ?? `Episode ${media.episode_number}`,
        posterUrl: media.still_path ?? media.series_poster ?? null, backdropUrl: media.series_backdrop ?? null,
        streamUrl: summary.playback?.streamUrl ?? '', seriesId: media.series_id, seriesTitle: media.series_title,
        positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds ?? summary.runtimeSeconds ?? 0,
        completed: !!row.completed, updatedAt: new Date(row.updated_at).getTime(),
      }]
    })
  }

  const capabilities = () => ({
    films: true,
    series: true,
    music: false,
    books: false,
    comics: false,
    games: false,
    directPlay: true,
    transcoding: true,
    events: true,
    channels: true,
    uiV2: playerConfig.uiV2Enabled,
    preferences: true,
    telemetry: playerConfig.telemetryEnabled,
  })

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', serverName: 'Archivist', version: '2.0.0', capabilities: capabilities() })
  })

  router.get('/ui/bootstrap', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const profileId = typeof req.query.profile === 'string' ? req.query.profile : 'default'
      const preferences = getPlayerPreferences(profileId)
      const server = { status: 'ok', serverName: 'Archivist', version: '2.0.0', capabilities: capabilities() }
      res.setHeader('ETag', `W/"player-bootstrap-${preferences.revision}"`)
      res.json({
        server,
        featureFlags: { uiV2Enabled: playerConfig.uiV2Enabled, telemetryEnabled: playerConfig.telemetryEnabled },
        configuration: playerConfig.public,
        preferences,
        libraries: listLibraries(),
        progress: listProgress(profileId),
        initialHub: getPlayerHub({ hubId: 'home', profileId }),
      })
    } catch (err) { sendUiError(req, res, err) }
  })

  router.put('/ui/preferences', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json(updatePlayerPreferences(req.body)) }
    catch (err) { sendUiError(req, res, err) }
  })

  router.post('/ui/preferences/reset', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try { res.json(resetPlayerPreferences(req.body)) }
    catch (err) { sendUiError(req, res, err) }
  })

  router.get('/hubs/:hubId', (req, res) => {
    try {
      const limitRaw = req.query.limit == null ? null : Number(req.query.limit)
      if (limitRaw !== null && (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 60)) throw new PlayerPreferencesValidationError('limit must be an integer from 1 to 60', '$.limit')
      const libraryId = req.query.libraryId == null ? null : Number(req.query.libraryId)
      if (libraryId !== null && (!Number.isSafeInteger(libraryId) || libraryId < 1)) throw new PlayerPreferencesValidationError('libraryId must be a positive integer', '$.libraryId')
      res.setHeader('Cache-Control', 'private, max-age=15')
      res.json(getPlayerHub({
        hubId: req.params.hubId as PlayerHubId,
        profileId: typeof req.query.profile === 'string' ? req.query.profile : 'default',
        libraryId,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
        limit: limitRaw,
      }))
    } catch (err) { sendUiError(req, res, err) }
  })

  router.post('/telemetry', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!playerConfig.telemetryEnabled) return sendUiError(req, res, new PlayerHubNotFoundError('telemetry'))
    try { recordPlayerTelemetry(req.body as PlayerTelemetryBatch); res.status(204).end() }
    catch (err) { sendUiError(req, res, err) }
  })

  router.get('/metrics', (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!playerConfig.telemetryEnabled) return sendUiError(req, res, new PlayerHubNotFoundError('metrics'))
    res.json(getPlayerMetricSnapshot())
  })

  router.get('/server-info', (_req, res) => {
    const libs = db.prepare('SELECT media_type, COUNT(*) AS n FROM libraries GROUP BY media_type').all() as Array<{ media_type: string; n: number }>
    res.json({
      serverName: 'Archivist',
      version: '2.0.0',
      capabilities: capabilities(),
      libraries: Object.fromEntries(libs.map(l => [l.media_type, l.n])),
    })
  })

  router.get('/libraries', (_req, res) => {
    try {
      res.json({ libraries: listLibraries() })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.get('/home', (_req, res) => {
    try {
      const recentFilms = (db.prepare(`
        SELECT f.* FROM films f WHERE f.file_path IS NOT NULL
        ORDER BY COALESCE(f.acquired_at, f.added_at) DESC LIMIT 12`).all() as any[]).map(filmSummary)
      const recentEpisodes = (db.prepare(`
        SELECT e.*, s.title AS series_title, s.poster_path AS series_poster
        FROM episodes e JOIN series s ON s.id = e.series_id
        WHERE e.file_path IS NOT NULL
        ORDER BY e.updated_at DESC LIMIT 12`).all() as any[]).map(r => ({
          ...episodeSummary(r), seriesTitle: r.series_title, seriesPosterUrl: r.series_poster ?? null,
        }))
      const downloading = [
        ...(db.prepare(`SELECT * FROM films WHERE status = 'acquiring' ORDER BY updated_at DESC LIMIT 6`).all() as any[]).map(filmSummary),
      ]
      res.json({ rails: { recentFilms, recentEpisodes, downloading } })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.get('/search', (req, res) => {
    try {
      const q = String(req.query.q ?? '').normalize('NFC').trim()
      if ([...q].length > 120 || /[\p{Cc}]/u.test(q)) return res.status(400).json({ error: 'Invalid search query' })
      if (!q) return res.json({ results: [], groups: { films: [], series: [], episodes: [] } })
      const limit = Math.max(1, Math.min(30, Number(req.query.limit) || 20))
      const requestedTypes = typeof req.query.types === 'string' ? new Set(req.query.types.split(',')) : new Set(['film', 'series', 'episode'])
      const like = `%${q}%`
      const films = requestedTypes.has('film')
        ? (db.prepare(`SELECT * FROM films WHERE title LIKE ? ORDER BY title LIMIT ?`).all(like, limit) as any[]).map(filmSummary)
        : []
      const series = requestedTypes.has('series') ? (db.prepare(`
        SELECT s.*, COUNT(e.id) AS episode_count,
               SUM(CASE WHEN e.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available_count
        FROM series s LEFT JOIN episodes e ON e.series_id = s.id
        WHERE s.title LIKE ? GROUP BY s.id ORDER BY s.title LIMIT ?`).all(like, limit) as any[]).map(seriesSummary) : []
      const episodes = requestedTypes.has('episode') ? (db.prepare(`
        SELECT e.*, s.title AS series_title, s.poster_path AS series_poster
        FROM episodes e JOIN series s ON s.id = e.series_id
        WHERE e.title LIKE ? OR s.title LIKE ?
        ORDER BY s.title, e.season_number, e.episode_number LIMIT ?`).all(like, like, limit) as any[]).map(episodeSummary) : []
      res.json({ results: [...films, ...series], groups: { films, series, episodes } })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  // ── Films ──────────────────────────────────────────────────────────────────

  router.get('/films', (req, res) => {
    try {
      const libraryId = req.query.library ? parseInt(String(req.query.library), 10) : null
      const paged = req.query.limit != null || req.query.cursor != null || req.query.sort != null || req.query.available != null
      if (!paged) {
        const rows = libraryId
          ? db.prepare('SELECT * FROM films WHERE library_id = ? ORDER BY sort_title, title').all(libraryId)
          : db.prepare('SELECT * FROM films ORDER BY sort_title, title').all()
        return res.json({ films: (rows as any[]).map(filmSummary) })
      }
      const sortName = ['title', 'added', 'year', 'rating'].includes(String(req.query.sort)) ? String(req.query.sort) : 'title'
      const field = { title: 'COALESCE(f.sort_title, f.title)', added: "COALESCE(f.acquired_at, f.added_at, '')", year: 'COALESCE(f.year, 0)', rating: 'COALESCE(f.rating, 0)' }[sortName]!
      const direction = String(req.query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 36))
      const cursor = typeof req.query.cursor === 'string' ? decodePlayerCursor(req.query.cursor) : null
      const where: string[] = []
      const params: unknown[] = []
      if (libraryId) { where.push('f.library_id = ?'); params.push(libraryId) }
      if (req.query.available === 'true') where.push('f.file_path IS NOT NULL')
      if (req.query.available === 'false') where.push('f.file_path IS NULL')
      const countWhere = [...where]
      const countParams = [...params]
      if (cursor) {
        const op = direction === 'ASC' ? '>' : '<'
        where.push(`(${field} ${op} ? OR (${field} = ? AND f.id ${op} ?))`)
        params.push(cursor.sortValue, cursor.sortValue, cursor.id)
      }
      const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT f.*, ${field} AS player_sort FROM films f ${sqlWhere} ORDER BY ${field} ${direction}, f.id ${direction} LIMIT ?`).all(...params, limit + 1) as any[]
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM films f ${countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : ''}`).get(...countParams) as any).n)
      res.json({ films: page.map(filmSummary), total, nextCursor: rows.length > limit && last ? encodePlayerCursor({ sortValue: last.player_sort, id: last.id }) : null })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.get('/films/:id', (req, res) => {
    const row = db.prepare(`SELECT f.*, pp.position_seconds AS progress_position,
      pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
      FROM films f LEFT JOIN playback_progress pp ON pp.profile_id = 'default' AND pp.media_type = 'film' AND pp.media_id = f.id
      WHERE f.id = ?`).get(req.params.id) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json(filmDetail(row))
  })

  // ── Series ─────────────────────────────────────────────────────────────────

  router.get('/series', (req, res) => {
    try {
      const libraryId = req.query.library ? parseInt(String(req.query.library), 10) : null
      const paged = req.query.limit != null || req.query.cursor != null || req.query.sort != null || req.query.available != null
      if (!paged) {
        const rows = db.prepare(`
        SELECT s.*, COUNT(e.id) AS episode_count,
               SUM(CASE WHEN e.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available_count
        FROM series s LEFT JOIN episodes e ON e.series_id = s.id
        ${libraryId ? 'WHERE s.library_id = ?' : ''}
        GROUP BY s.id ORDER BY s.sort_title, s.title`).all(...(libraryId ? [libraryId] : [])) as any[]
        return res.json({ series: rows.map(seriesSummary) })
      }
      const sortName = ['title', 'added', 'year', 'rating'].includes(String(req.query.sort)) ? String(req.query.sort) : 'title'
      const field = { title: 'COALESCE(sort_title, title)', added: "COALESCE(added_at, '')", year: 'COALESCE(year, 0)', rating: 'COALESCE(rating, 0)' }[sortName]!
      const direction = String(req.query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 36))
      const cursor = typeof req.query.cursor === 'string' ? decodePlayerCursor(req.query.cursor) : null
      const where: string[] = []
      const params: unknown[] = []
      if (libraryId) { where.push('library_id = ?'); params.push(libraryId) }
      if (req.query.available === 'true') where.push('available_count > 0')
      if (req.query.available === 'false') where.push('available_count = 0')
      const countWhere = [...where]
      const countParams = [...params]
      if (cursor) {
        const op = direction === 'ASC' ? '>' : '<'
        where.push(`(${field} ${op} ? OR (${field} = ? AND id ${op} ?))`)
        params.push(cursor.sortValue, cursor.sortValue, cursor.id)
      }
      const base = `SELECT s.*, COUNT(e.id) AS episode_count, SUM(CASE WHEN e.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available_count
        FROM series s LEFT JOIN episodes e ON e.series_id = s.id GROUP BY s.id`
      const rows = db.prepare(`WITH summaries AS (${base}) SELECT *, ${field} AS player_sort FROM summaries
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${field} ${direction}, id ${direction} LIMIT ?`).all(...params, limit + 1) as any[]
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      const total = Number((db.prepare(`WITH summaries AS (${base}) SELECT COUNT(*) AS n FROM summaries ${countWhere.length ? `WHERE ${countWhere.join(' AND ')}` : ''}`).get(...countParams) as any).n)
      res.json({ series: page.map(seriesSummary), total, nextCursor: rows.length > limit && last ? encodePlayerCursor({ sortValue: last.player_sort, id: last.id }) : null })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.get('/series/:id', (req, res) => {
    const row = db.prepare(`
      SELECT s.*, COUNT(e.id) AS episode_count,
             SUM(CASE WHEN e.file_path IS NOT NULL THEN 1 ELSE 0 END) AS available_count
      FROM series s LEFT JOIN episodes e ON e.series_id = s.id
      WHERE s.id = ? GROUP BY s.id`).get(req.params.id) as any
    if (!row || !row.id) return res.status(404).json({ error: 'Not found' })

    const episodes = (db.prepare(`SELECT e.*, pp.position_seconds AS progress_position,
      pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
      FROM episodes e LEFT JOIN playback_progress pp ON pp.profile_id = 'default' AND pp.media_type = 'episode' AND pp.media_id = e.id
      WHERE e.series_id = ? ORDER BY e.season_number, e.episode_number`).all(row.id) as any[]).map(episodeSummary)
    const seasons = (db.prepare('SELECT * FROM seasons WHERE series_id = ? ORDER BY season_number').all(row.id) as any[]).map(s => ({
      id: s.id,
      seasonNumber: s.season_number,
      title: s.title ?? `Season ${s.season_number}`,
      posterUrl: s.poster_path ?? null,
      episodes: episodes.filter(e => e.seasonNumber === s.season_number),
    }))
    // Next unwatched is a player-side concept (progress lives in the player);
    // nextAvailable is simply the first playable episode in order.
    const nextAvailable = episodes.find(e => e.hasFile && !e.progress?.completed) ?? episodes.find(e => e.hasFile) ?? null

    res.json({
      ...seriesSummary(row),
      overview: row.overview ?? null,
      cast: parseJson<any[]>(row.cast, []),
      crew: parseJson<any[]>(row.crew, []),
      seasons,
      nextAvailable,
    })
  })

  router.get('/episodes/:id', (req, res) => {
    const row = db.prepare(`
      SELECT e.*, s.title AS series_title, s.poster_path AS series_poster
      FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?`).get(req.params.id) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    res.json({ ...episodeSummary(row), seriesTitle: row.series_title, seriesPosterUrl: row.series_poster ?? null })
  })

  // ── Playback progress ───────────────────────────────────────────────────

  router.get('/progress', (req, res) => {
    const profileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim().slice(0, 64)
      : 'default'
    res.json({ progress: listProgress(profileId) })
  })

  router.post('/progress', (req, res) => {
    const mediaType = req.body?.type
    const mediaId = Number(req.body?.id)
    const positionSeconds = Number(req.body?.positionSeconds)
    const durationSeconds = req.body?.durationSeconds == null ? null : Number(req.body.durationSeconds)
    const completed = !!req.body?.completed
    const profileId = typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim().slice(0, 64)
      : 'default'

    if (!['film', 'episode'].includes(mediaType) || !Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'Valid type and id are required' })
    }
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0
      || (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 0))) {
      return res.status(400).json({ error: 'Invalid playback position' })
    }

    const table = mediaType === 'film' ? 'films' : 'episodes'
    if (!db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(mediaId)) {
      return res.status(404).json({ error: 'Media not found' })
    }

    db.prepare(`
      INSERT INTO playback_progress
        (profile_id, media_type, media_id, position_seconds, duration_seconds, completed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(profile_id, media_type, media_id) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        completed = excluded.completed,
        updated_at = datetime('now')
    `).run(profileId, mediaType, mediaId, positionSeconds, durationSeconds, completed ? 1 : 0)
    res.status(204).end()
  })

  router.delete('/progress/:type/:id', (req, res) => {
    const mediaType = req.params.type
    const mediaId = Number(req.params.id)
    const profileId = typeof req.query.profile === 'string' && req.query.profile.trim()
      ? req.query.profile.trim().slice(0, 64)
      : 'default'
    if (!['film', 'episode'].includes(mediaType) || !Number.isInteger(mediaId)) {
      return res.status(400).json({ error: 'Invalid progress key' })
    }
    db.prepare(
      'DELETE FROM playback_progress WHERE profile_id = ? AND media_type = ? AND media_id = ?',
    ).run(profileId, mediaType, mediaId)
    res.status(204).end()
  })

  // ── Channels (personal TV network; archivist-channels.md) ────────────────

  router.get('/channels', (_req, res) => {
    try {
      const now = Date.now()
      const rows = db.prepare('SELECT * FROM channels WHERE is_active = 1 ORDER BY number').all() as any[]
      res.json({
        channels: rows.map(c => {
          const { now: current, next } = getNow(c.id, now)
          return {
            id: c.id,
            number: c.number,
            name: c.name,
            description: c.description ?? null,
            brandColor: c.brand_color,
            logoUrl: c.logo_url ?? null,
            now: current,
            next,
          }
        }),
      })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.get('/channels/:id/guide', (req, res) => {
    try {
      const from = Number(req.query.from) || Date.now()
      const to = Number(req.query.to) || from + 24 * 3600 * 1000
      res.json({ slots: getGuide(parseInt(req.params.id, 10), from, to) })
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.get('/channels/:id/now', (req, res) => {
    try { res.json(getNow(parseInt(req.params.id, 10), Date.now())) }
    catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.post('/play-sessions', (req, res) => {
    try {
      const { channelId, startSlotId, mode } = req.body ?? {}
      const modes: SessionMode[] = ['WATCH_FROM_HERE', 'PLAY_THIS_ONLY', 'JOIN_LIVE']
      const m: SessionMode = modes.includes(mode) ? mode : 'WATCH_FROM_HERE'
      const session = createSession(Number(channelId), Number(startSlotId), m)
      logger.info(`Play session ${session.sessionId} (${m}) on channel ${channelId}: ${session.items.length} items`)
      res.status(201).json(session)
    } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }) }
  })

  router.get('/play-sessions/:id', (req, res) => {
    const session = getSession(parseInt(req.params.id, 10))
    if (!session) return res.status(404).json({ error: 'Not found' })
    res.json(session)
  })

  router.post('/play-sessions/:id/items/:position/complete', (req, res) => {
    const session = completeSessionItem(parseInt(req.params.id, 10), parseInt(req.params.position, 10))
    if (!session) return res.status(404).json({ error: 'Not found' })
    res.json(session)
  })

  router.post('/play-sessions/:id/stop', (req, res) => {
    endSession(parseInt(req.params.id, 10))
    res.status(204).end()
  })

  // ── Streams ────────────────────────────────────────────────────────────────

  /** Resolves the on-disk path for a films|episodes stream target. */
  const resolveMediaPath = (type: string, id: string): string | null => {
    const table = type === 'films' ? 'films' : type === 'episodes' ? 'episodes' : null
    if (!table) return null
    const row = db.prepare(`SELECT file_path FROM ${table} WHERE id = ?`).get(id) as any
    return row?.file_path ?? null
  }

  router.get('/stream/films/:id', (req, res) => {
    const row = db.prepare('SELECT file_path FROM films WHERE id = ?').get(req.params.id) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    logger.info(`Stream film ${req.params.id}`)
    streamFile(res, row.file_path)
  })

  router.get('/stream/episodes/:id', (req, res) => {
    const row = db.prepare('SELECT file_path FROM episodes WHERE id = ?').get(req.params.id) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    logger.info(`Stream episode ${req.params.id}`)
    streamFile(res, row.file_path)
  })

  // Audio/subtitle track listing for the player's track menu. Also reports any
  // cached loudness measurement (and kicks off a background measure if missing)
  // so the player can normalize levels.
  router.get('/stream/:type/:id/tracks', (req, res) => {
    const path = resolveMediaPath(req.params.type, req.params.id)
    if (!path) return res.status(404).json({ error: 'Not found' })
    if (!existsSync(path)) return res.status(410).json({ error: 'File no longer exists' })
    const tracks = probeTracks(path, mediaTiming(res))
    if (!tracks) return res.status(500).json({ error: 'Could not probe media' })
    const mediaType = req.params.type === 'films' ? 'film' : 'episode'
    const mediaId = parseInt(req.params.id, 10)
    const loudness = getLoudness(mediaType, mediaId, path, mediaTiming(res))
    if (!loudness) enqueueLoudness(mediaType, mediaId, path, { priority: 'high' })
    res.json({ ...tracks, loudness, targetLufs: DEFAULT_TARGET_LUFS })
  })

  // Loudness measurement queue status (how many titles are analysing / waiting).
  router.get('/loudness/status', (_req, res) => {
    const q = loudnessQueueStatus()
    const measured = (db.prepare('SELECT COUNT(*) AS n FROM media_loudness').get() as any).n
    res.json({ ...q, measured })
  })

  // Text subtitle track → WebVTT (loadable as a <track> in direct play).
  router.get('/stream/:type/:id/subtitle/:index.vtt', (req, res) => {
    const path = resolveMediaPath(req.params.type, req.params.id)
    if (!path || !existsSync(path)) return res.status(404).end()
    const index = parseInt(req.params.index, 10)
    if (!Number.isFinite(index)) return res.status(400).end()
    streamSubtitleVtt(path, index, res, req, mediaTiming(res))
  })

  // Compatibility transcode: H.264 + stereo AAC fragmented MP4. Query:
  //   audio=<absolute stream index>  subs=<absolute stream index to burn in>
  //   t=<start seconds> (client re-requests on seek in compatible mode)
  router.get('/stream/:type/:id/transcode', (req, res) => {
    const path = resolveMediaPath(req.params.type, req.params.id)
    if (!path) return res.status(404).json({ error: 'Not found' })
    if (!existsSync(path)) return res.status(410).json({ error: 'File no longer exists' })
    const tracks = probeTracks(path, mediaTiming(res))
    const audio = req.query.audio != null ? parseInt(String(req.query.audio), 10) : undefined
    const subs = req.query.subs != null ? parseInt(String(req.query.subs), 10) : undefined
    const t = req.query.t != null ? parseFloat(String(req.query.t)) : undefined
    // norm = target LUFS for volume normalization (loudnorm). Absent = off.
    const norm = req.query.norm != null ? parseFloat(String(req.query.norm)) : undefined
    let audioFilter: string | undefined
    if (Number.isFinite(norm)) {
      const mediaType = req.params.type === 'films' ? 'film' : 'episode'
      const mediaId = parseInt(req.params.id, 10)
      audioFilter = loudnormFilter(norm!, getLoudness(mediaType, mediaId, path, mediaTiming(res)))
      enqueueLoudness(mediaType, mediaId, path, { priority: 'high' })
    }
    logger.info(`Transcode ${req.params.type} ${req.params.id} (audio=${audio ?? 'default'} t=${t ?? 0}${audioFilter ? ' norm=' + norm : ''})`)
    streamTranscode(path, {
      audioIndex: Number.isFinite(audio) ? audio : undefined,
      subtitleIndex: Number.isFinite(subs) ? subs : undefined,
      startSec: Number.isFinite(t) ? t : undefined,
      videoCodec: tracks?.video?.codec ?? null,
      audioFilter,
    }, res, req, mediaTiming(res))
  })

  return router
}
