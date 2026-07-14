import { Router } from 'express'
import { existsSync, statfsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { createLogger, testDownloadClient } from '@archivist/core'
import { domains, CreateLibrary, UpdateLibrary, AddRootFolder, CreateQualityProfile, UpdateQualityProfile, CreateQualityDefinition, UpdateQualityDefinition, UpdateApiKeys } from '@archivist/contracts'
import { getDb } from '../db.js'
import { validateBody } from '../middleware/validate.js'
import { scopeId } from '../middleware/library-context.js'
import { getAppSetting, setAppSetting, DEFAULT_TIERS, DEFAULT_REJECTS, type TierConfig } from './settings.js'
import { ScopedDownloadClientStore } from './download-clients.js'
import { checkFfmpegAvailable, cleanTracks, readFileMetadata, writeFileMetadata } from '../services/media-processor.js'
import { searchSubtitles, downloadSubtitle } from '../services/subtitle-provider.js'
import { seedQualityProfiles, seedEditionRules } from '@archivist/db'
import { recordEvent } from '../system/event-store.js'
import { reconcileTypeAfterChange } from './library-migration.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from './library-paths.js'
import { getMediaRoot } from './media-organizer.js'
import { createSystemBackup } from '../system/backups.js'

const logger = createLogger('Shared')

interface RootFolderRow { id: number; path: string }

const DEFAULT_NAMING = {
  movieFolderFormat: '{Movie CleanTitle} ({Release Year})',
  movieFileFormat: '{Movie CleanTitle} ({Release Year}) {Quality Full}',
  renameMovies: true,
  colonReplacement: 'spaceDash',
}
const DEFAULT_MEDIA = {
  copyMode: 'hardlink',
  deleteEmptyFolders: true,
  importExtraFiles: true,
  extraFileExtensions: 'srt,sub,idx,nfo',
  recycleBin: '',
}
const DEFAULT_FLARE = { url: '', enabled: false }
const DEFAULT_ACQUISITION = { tier: 'Any', resolution: 'Any', source: 'Any', codec: 'Any', missingSearchBatchSize: 5 }
const DEFAULT_TRACK_CLEANER = {
  enabled: true,
  preferredLanguage: 'en',
  keepOriginalLanguage: true,
  keepPreferredAudio: true,
  keepPreferredSubs: true,
  keepCommentary: true,
  additionalLanguages: [] as string[],
}
const DEFAULT_SUBTITLE_CONFIG = {
  enabled: false,
  provider: 'opensubtitles',
  apiKey: '',
  defaultLanguage: 'en',
  autoAcquire: false,
  hearingImpaired: false,
  forcedOnly: false,
}

/** Validates an absolute path and resolves symlinks. Returns null if unsafe. */
function sanitizePath(inputPath: string): string | null {
  if (!inputPath || !isAbsolute(inputPath)) return null
  const resolved = resolve(inputPath)
  if (resolved.includes('\0')) return null
  const allowedRoots = (process.env.ARCHIVIST_ALLOWED_ROOTS ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => resolve(p))
  if (allowedRoots.length > 0 && !allowedRoots.some(root => resolved === root || resolved.startsWith(`${root}/`))) {
    return null
  }
  return resolved
}

function enrichFolder(f: RootFolderRow) {
  let freeSpace = 0, totalSpace = 0, accessible = false
  try {
    if (existsSync(f.path)) {
      const stats = statfsSync(f.path)
      freeSpace = stats.bfree * stats.bsize
      totalSpace = stats.blocks * stats.bsize
      accessible = true
    }
  } catch (err) {
    logger.debug(`Could not stat folder ${f.path}:`, err instanceof Error ? err.message : String(err))
  }
  return { id: f.id, path: f.path, freeSpace, totalSpace, accessible }
}

/** Ensures at least one library exists per media type, mirroring legacy default tabs. */
export function ensureDefaultLibraries(): void {
  const db = getDb()
  const defaults: Array<{ mediaType: string; name: string; dbPath: string }> = [
    { mediaType: 'films', name: 'Films', dbPath: './data/films.db' },
    { mediaType: 'series', name: 'Series', dbPath: './data/series.db' },
    { mediaType: 'music', name: 'Music', dbPath: './data/music.db' },
    { mediaType: 'games', name: 'Games', dbPath: './data/games.db' },
    { mediaType: 'books', name: 'Books', dbPath: './data/books.db' },
    { mediaType: 'comics', name: 'Comics', dbPath: './data/comics.db' },
  ]
  const existingTypes = new Set(
    (db.prepare('SELECT DISTINCT media_type FROM libraries').all() as any[]).map(r => r.media_type),
  )
  for (const d of defaults) {
    if (existingTypes.has(d.mediaType)) continue
    const result = db.prepare('INSERT INTO libraries (name, media_type, db_path) VALUES (?, ?, ?)').run(d.name, d.mediaType, d.dbPath)
    const libraryId = Number(result.lastInsertRowid)
    seedQualityProfiles(db, libraryId)
    if (d.mediaType === 'films') seedEditionRules(db, libraryId)
    logger.info(`Created default library: ${d.name} (#${libraryId})`)
  }
}

export function createSharedRouter(envPath?: string): Router {
  const router = Router()
  const db = getDb()

  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, scopeId(req))

  // Reconcile a media type's on-disk layout after a library is added/removed.
  // Best-effort: a failure is logged but never blocks the add/delete response.
  const migrateTypeLayout = (mediaType: string) => {
    try {
      for (const r of reconcileTypeAfterChange(db, mediaType)) {
        if (r.changed) {
          recordEvent({ category: 'library', action: 'folders-migrated', subjectType: 'library', message: `Migrated ${r.moved} folder(s): ${r.fromRoot} → ${r.toRoot}` })
        }
      }
    } catch (err) {
      logger.error(`Library folder migration failed for "${mediaType}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Tabs (libraries compatibility surface) ────────────────────────────────

  router.get('/tabs', (_req, res) => {
    res.json(db.prepare("SELECT * FROM libraries ORDER BY CASE WHEN name LIKE '%Main%' THEN 0 ELSE 1 END, name ASC").all())
  })

  router.get('/tabs/root-folders', (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT rf.path AS path, l.id AS tabId, l.name AS tabName
        FROM root_folders rf
        JOIN libraries l ON l.id = rf.library_id
        ORDER BY l.id ASC, rf.id ASC
      `).all() as Array<{ tabId: number; tabName: string; path: string }>
      res.json(rows.map(r => ({ tabId: r.tabId, tabName: r.tabName, path: r.path })))
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/tabs', validateBody(CreateLibrary), (req, res) => {
    const { name, mediaType, dbPath } = req.body

    if (dbPath.includes('..') || dbPath.includes('\0')) {
      return res.status(400).json({ error: 'Invalid database path' })
    }
    const existing = db.prepare('SELECT id FROM libraries WHERE db_path = ?').get(dbPath)
    if (existing) {
      return res.status(409).json({ error: 'A tab with this database path already exists' })
    }

    const result = db.prepare('INSERT INTO libraries (name, media_type, db_path) VALUES (?, ?, ?)').run(name, mediaType, dbPath)
    const libraryId = Number(result.lastInsertRowid)
    seedQualityProfiles(db, libraryId)
    if (mediaType === 'films') seedEditionRules(db, libraryId)
    recordEvent({ category: 'library', action: 'created', subjectType: 'library', subjectId: String(libraryId), message: `Library created: ${name}` })

    // Adding a second library of a type flips the layout from flat
    // media/<type> to per-library media/<type>/<name>; migrate the pre-existing
    // library's files + stored paths to match.
    migrateTypeLayout(mediaType)

    res.status(201).json(db.prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId))
  })

  router.put('/tabs/:id', validateBody(UpdateLibrary), (req, res) => {
    const { name } = req.body
    db.prepare('UPDATE libraries SET name = ? WHERE id = ?').run(name, req.params.id)
    res.json(db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id))
  })

  // Clear all items from a library while keeping the library itself.
  // `deleteFiles=true` also removes the library's media folder from disk.
  const ROOT_TABLE: Record<string, string> = {
    films: 'films', series: 'series', music: 'artists', books: 'authors', comics: 'comic_series', games: 'games',
  }
  router.post('/tabs/:id/clear', (req, res) => {
    const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id) as any
    if (!library) return res.status(404).json({ error: 'Tab not found' })
    const table = ROOT_TABLE[library.media_type]
    if (!table) return res.status(400).json({ error: `Unknown media type: ${library.media_type}` })

    const deleteFiles = req.query.deleteFiles === 'true'
    if (deleteFiles) safeDeleteMediaPath(resolveLibraryRoot(db, library.id))

    // Deleting the root rows cascades all child rows (editions/seasons/episodes/
    // albums/tracks/books/issues) via FK ON DELETE CASCADE.
    const result = db.prepare(`DELETE FROM ${table} WHERE library_id = ?`).run(library.id)
    recordEvent({ category: 'library', action: deleteFiles ? 'cleared-with-files' : 'cleared', subjectType: 'library', subjectId: String(library.id), message: `Library ${deleteFiles ? 'cleared with files' : 'cleared'}: ${library.name} (${result.changes} items)` })
    res.json({ cleared: result.changes, deletedFiles: deleteFiles })
  })

  router.delete('/tabs/:id', (req, res) => {
    const library = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id) as any
    if (!library) return res.status(404).json({ error: 'Tab not found' })

    // `deleteFiles=true` also removes the library's media folder from disk;
    // otherwise the rows are dropped but files are left in place. Resolve the
    // folder before deletion, while the library still counts toward its type.
    const deleteFiles = req.query.deleteFiles === 'true'
    const mediaRoot = deleteFiles ? resolveLibraryRoot(db, library.id) : null

    // Deleting the row cascades all media rows for this library (FK ON DELETE
    // CASCADE); the settings-style tables below are library-scoped by value.
    db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id)
    db.prepare('DELETE FROM app_settings WHERE library_id = ?').run(library.id)
    db.prepare('DELETE FROM root_folders WHERE library_id = ?').run(library.id)
    db.prepare('DELETE FROM quality_profiles WHERE library_id = ?').run(library.id)
    db.prepare('DELETE FROM download_clients WHERE library_id = ?').run(library.id)
    db.prepare('DELETE FROM edition_rules WHERE library_id = ?').run(library.id)

    // Remove the library's media folder when requested.
    if (deleteFiles && mediaRoot) safeDeleteMediaPath(mediaRoot)

    recordEvent({ category: 'library', action: deleteFiles ? 'deleted-with-files' : 'deleted', subjectType: 'library', subjectId: String(library.id), message: `Library ${deleteFiles ? 'deleted with files' : 'removed'}: ${library.name}` })

    // If this leaves a single library of the type, collapse it back to the flat
    // media/<type> layout.
    migrateTypeLayout(library.media_type)

    res.status(204).send()
  })

  // ── Download clients (scoped) ─────────────────────────────────────────────

  router.get('/download-clients', (req, res) => res.json(clientsFor(req).getAll()))

  router.post('/download-clients', validateBody(domains.CreateDownloadClient), (req, res) => {
    try { res.status(201).json(clientsFor(req).create(req.body)) }
    catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.put('/download-clients/:id', (req, res) => {
    try { res.json(clientsFor(req).update(parseInt(req.params.id, 10), req.body)) }
    catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.delete('/download-clients/:id', (req, res) => {
    clientsFor(req).delete(parseInt(req.params.id, 10))
    res.status(204).send()
  })

  router.post('/download-clients/test', async (req, res) => {
    try { res.json(await testDownloadClient(req.body)) }
    catch (err) { res.json({ success: false, message: String(err), duration: 0 }) }
  })

  router.post('/download-clients/:id/test', async (req, res) => {
    const client = clientsFor(req).getById(parseInt(req.params.id, 10))
    if (!client) return res.status(404).json({ error: 'Not found' })
    try { res.json(await testDownloadClient(client)) }
    catch (err) { res.json({ success: false, message: String(err), duration: 0 }) }
  })

  // ── Quality profiles (scoped) ─────────────────────────────────────────────

  router.get('/quality-profiles', (req, res) => {
    const scope = scopeId(req)
    if (scope !== 0) seedQualityProfiles(db, scope)
    const profiles = db.prepare('SELECT * FROM quality_profiles WHERE library_id = ? ORDER BY id ASC').all(scope) as Array<Record<string, unknown>>
    res.json(profiles.map(p => ({ ...p, items: JSON.parse(p.items as string), upgradeAllowed: Boolean(p.upgrade_allowed), minFormatScore: p.min_format_score })))
  })

  router.post('/quality-profiles', validateBody(CreateQualityProfile), (req, res) => {
    const { name, cutoff, items = [], upgradeAllowed = true, minFormatScore = 0 } = req.body
    const result = db.prepare('INSERT INTO quality_profiles (library_id, name, upgrade_allowed, cutoff, min_format_score, items) VALUES (?, ?, ?, ?, ?, ?)')
      .run(scopeId(req), name, upgradeAllowed ? 1 : 0, cutoff ?? 'WEB-DL-1080p', minFormatScore, JSON.stringify(items))
    const inserted = db.prepare('SELECT * FROM quality_profiles WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
    res.status(201).json({ ...inserted, items: JSON.parse(inserted.items as string), upgradeAllowed: Boolean(inserted.upgrade_allowed), minFormatScore: inserted.min_format_score })
  })

  router.put('/quality-profiles/:id', validateBody(UpdateQualityProfile), (req, res) => {
    const { name, cutoff, items, upgradeAllowed, minFormatScore } = req.body
    db.prepare(`UPDATE quality_profiles SET
      name = COALESCE(@name, name), cutoff = COALESCE(@cutoff, cutoff),
      items = COALESCE(@items, items), upgrade_allowed = COALESCE(@upgradeAllowed, upgrade_allowed),
      min_format_score = COALESCE(@minFormatScore, min_format_score)
      WHERE id = @id AND library_id = @scope`).run({
      id: req.params.id, scope: scopeId(req), name: name ?? null, cutoff: cutoff ?? null,
      items: items ? JSON.stringify(items) : null, upgradeAllowed: upgradeAllowed !== undefined ? (upgradeAllowed ? 1 : 0) : null,
      minFormatScore: minFormatScore ?? null,
    })
    const updated = db.prepare('SELECT * FROM quality_profiles WHERE id = ? AND library_id = ?').get(req.params.id, scopeId(req)) as Record<string, unknown> | undefined
    if (!updated) return res.status(404).json({ error: 'Quality profile not found' })
    res.json({ ...updated, items: JSON.parse(updated.items as string), upgradeAllowed: Boolean(updated.upgrade_allowed), minFormatScore: updated.min_format_score })
  })

  router.delete('/quality-profiles/:id', (req, res) => {
    db.prepare('DELETE FROM quality_profiles WHERE id = ? AND library_id = ?').run(req.params.id, scopeId(req))
    res.status(204).send()
  })

  const serializeQualityDefinition = (row: any) => ({
    ...row,
    minSize: row.min_size,
    maxSize: row.max_size,
  })

  router.get('/quality-definitions', (req, res) => {
    const rows = db.prepare('SELECT * FROM quality_definitions WHERE library_id = ? ORDER BY weight ASC, title ASC').all(scopeId(req))
    res.json((rows as any[]).map(serializeQualityDefinition))
  })

  router.post('/quality-definitions', validateBody(CreateQualityDefinition), (req, res) => {
    const { title, weight = 0, minSize = null, maxSize = null } = req.body
    try {
      const result = db.prepare('INSERT INTO quality_definitions (library_id, title, weight, min_size, max_size) VALUES (?, ?, ?, ?, ?)')
        .run(scopeId(req), title, weight, minSize, maxSize)
      const row = db.prepare('SELECT * FROM quality_definitions WHERE id = ?').get(result.lastInsertRowid)
      res.status(201).json(serializeQualityDefinition(row))
    } catch (err) {
      res.status(409).json({ error: String(err) })
    }
  })

  router.put('/quality-definitions/:id', validateBody(UpdateQualityDefinition), (req, res) => {
    const existing = db.prepare('SELECT * FROM quality_definitions WHERE id = ? AND library_id = ?').get(req.params.id, scopeId(req)) as any
    if (!existing) return res.status(404).json({ error: 'Quality definition not found' })
    const nextMin = req.body.minSize !== undefined ? req.body.minSize : existing.min_size
    const nextMax = req.body.maxSize !== undefined ? req.body.maxSize : existing.max_size
    if (nextMin != null && nextMax != null && nextMin > nextMax) {
      return res.status(400).json({ error: 'minSize must be less than or equal to maxSize' })
    }
    try {
      db.prepare(
        `UPDATE quality_definitions SET
          title = COALESCE(@title, title),
          weight = COALESCE(@weight, weight),
          min_size = @minSize,
          max_size = @maxSize
        WHERE id = @id AND library_id = @scope`,
      ).run({
        id: req.params.id,
        scope: scopeId(req),
        title: req.body.title ?? null,
        weight: req.body.weight ?? null,
        minSize: nextMin,
        maxSize: nextMax,
      })
      const row = db.prepare('SELECT * FROM quality_definitions WHERE id = ?').get(req.params.id)
      res.json(serializeQualityDefinition(row))
    } catch (err) {
      res.status(409).json({ error: String(err) })
    }
  })

  router.delete('/quality-definitions/:id', (req, res) => {
    db.prepare('DELETE FROM quality_definitions WHERE id = ? AND library_id = ?').run(req.params.id, scopeId(req))
    res.status(204).send()
  })

  // ── Root folders (scoped) ─────────────────────────────────────────────────

  router.get('/root-folders', (req, res) => {
    const folders = db.prepare('SELECT * FROM root_folders WHERE library_id = ? ORDER BY id ASC').all(scopeId(req)) as RootFolderRow[]
    res.json(folders.map(f => enrichFolder(f)))
  })

  router.post('/root-folders', validateBody(AddRootFolder), (req, res) => {
    const { path } = req.body
    const safePath = sanitizePath(path)
    if (!safePath) return res.status(400).json({ error: 'path must be an absolute filesystem path' })
    try {
      const result = db.prepare('INSERT INTO root_folders (library_id, path) VALUES (?, ?)').run(scopeId(req), safePath)
      const folder = db.prepare('SELECT * FROM root_folders WHERE id = ?').get(result.lastInsertRowid) as RootFolderRow
      res.status(201).json(enrichFolder(folder))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.delete('/root-folders/:id', (req, res) => {
    db.prepare('DELETE FROM root_folders WHERE id = ? AND library_id = ?').run(req.params.id, scopeId(req))
    res.status(204).send()
  })

  // ── Settings (scoped app settings) ────────────────────────────────────────

  const settingRoutes: Array<{ path: string; key: string; def: unknown; global?: boolean }> = [
    { path: '/settings/naming', key: 'naming', def: DEFAULT_NAMING },
    { path: '/settings/media-management', key: 'mediaManagement', def: DEFAULT_MEDIA },
    { path: '/settings/acquisition-defaults', key: 'acquisitionDefaults', def: DEFAULT_ACQUISITION },
    { path: '/settings/track-cleaner', key: 'trackCleaner', def: DEFAULT_TRACK_CLEANER },
    { path: '/settings/subtitles', key: 'subtitles', def: DEFAULT_SUBTITLE_CONFIG },
    { path: '/settings/flaresolverr', key: 'flaresolverr', def: DEFAULT_FLARE, global: true },
    { path: '/settings/quality-rejects', key: 'qualityRejects', def: DEFAULT_REJECTS },
  ]
  for (const s of settingRoutes) {
    router.get(s.path, (req, res) => {
      res.json(getAppSetting(s.key, s.def, s.global ? 0 : scopeId(req)))
    })
    router.put(s.path, (req, res) => {
      const scope = s.global ? 0 : scopeId(req)
      const updated = { ...(getAppSetting(s.key, s.def, scope) as Record<string, unknown>), ...req.body }
      setAppSetting(s.key, updated, scope)
      res.json(updated)
    })
  }

  router.get('/settings/media-base-dir', (_req, res) => {
    const configured = process.env.ARCHIVIST_MEDIA_BASE
    const base = configured && isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), 'media')
    res.json({ path: base })
  })

  router.get('/settings/quality-tiers', (req, res) => res.json(getAppSetting('qualityTiers', DEFAULT_TIERS, scopeId(req))))
  router.put('/settings/quality-tiers', (req, res) => {
    const config = req.body as TierConfig
    if (!config?.tier1 || !config?.tier2 || !config?.tier3) return res.status(400).json({ error: 'Invalid tier config' })
    setAppSetting('qualityTiers', config, scopeId(req))
    res.json(config)
  })

  // ── Track cleaner status + manual clean ───────────────────────────────────

  router.get('/settings/track-cleaner/status', async (_req, res) => {
    res.json(await checkFfmpegAvailable())
  })

  router.post('/media/file-metadata/read', async (req, res) => {
    const { filePath } = req.body as { filePath?: string }
    if (!filePath) return res.status(400).json({ error: 'filePath is required' })
    try {
      res.json(await readFileMetadata(filePath))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/media/file-metadata', async (req, res) => {
    const { filePath, chapters, audioTitles, subtitleTitles, removeAudio, removeSubtitles } = req.body as {
      filePath?: string
      chapters?: Array<{ title: string; startTime: number; endTime?: number }>
      audioTitles?: Record<number, string>
      subtitleTitles?: Record<number, string>
      removeAudio?: number[]
      removeSubtitles?: number[]
    }
    if (!filePath) return res.status(400).json({ error: 'filePath is required' })
    try {
      const result = await writeFileMetadata(filePath, {
        chapters, audioTitles, subtitleTitles,
        removeAudio: Array.isArray(removeAudio) ? removeAudio.filter(n => Number.isInteger(n)) : undefined,
        removeSubtitles: Array.isArray(removeSubtitles) ? removeSubtitles.filter(n => Number.isInteger(n)) : undefined,
      })
      if (result.success) {
        recordEvent({
          category: 'metadata',
          action: 'file-metadata-edited',
          subjectType: 'file',
          subjectId: filePath,
          message: `Rewrote embedded metadata for ${filePath}`,
          data: { chapters: result.chapters, audioTitles, subtitleTitles },
        })
      }
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/media/clean-tracks', async (req, res) => {
    const { filePath, originalLanguage, tmdbId } = req.body as { filePath?: string; originalLanguage?: string; tmdbId?: number }
    if (!filePath) return res.status(400).json({ error: 'filePath is required' })
    try {
      let lang = originalLanguage ?? null
      if (!lang && tmdbId) {
        try {
          const { getMovie } = await import('../modules/films/tmdb.js')
          const movie = await getMovie(tmdbId)
          lang = movie.originalLanguage ?? null
        } catch {}
      }
      res.json(await cleanTracks(filePath, lang))
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // ── Subtitles ─────────────────────────────────────────────────────────────

  router.post('/subtitles/search', async (req, res) => {
    const { imdbId, tmdbId, query, language, seasonNumber, episodeNumber } = req.body as {
      imdbId?: string; tmdbId?: number; query?: string; language?: string
      seasonNumber?: number; episodeNumber?: number
    }
    try {
      res.json(await searchSubtitles({ imdbId, tmdbId, query, language, seasonNumber, episodeNumber }))
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/subtitles/download', async (req, res) => {
    const { fileId, mediaFilePath, language } = req.body as { fileId: number; mediaFilePath: string; language?: string }
    if (!fileId || !mediaFilePath) {
      return res.status(400).json({ error: 'fileId and mediaFilePath are required' })
    }
    try {
      res.json(await downloadSubtitle(fileId, mediaFilePath, language))
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // ── API keys (masked reads, .env persistence) ─────────────────────────────

  router.get('/settings/api-keys', (_req, res) => {
    res.json({
      tmdbApiKey:        process.env.TMDB_API_KEY        ? '••••••••' : '',
      tvdbApiKey:        process.env.TVDB_API_KEY        ? '••••••••' : '',
      tvdbPin:           process.env.TVDB_PIN            ?? '',
      googleBooksApiKey: process.env.GOOGLE_BOOKS_API_KEY ? '••••••••' : '',
      comicvineApiKey:   process.env.COMICVINE_API_KEY   ? '••••••••' : '',
      igdbClientId:      process.env.IGDB_CLIENT_ID      ? '••••••••' : '',
      igdbClientSecret:  process.env.IGDB_CLIENT_SECRET  ? '••••••••' : '',
      fanartApiKey:      process.env.FANART_API_KEY      ? '••••••••' : '',
    })
  })

  router.put('/settings/api-keys', validateBody(UpdateApiKeys), (req, res) => {
    const keys = req.body

    const update = (envKey: string, val: string) => {
      if (val && !val.includes('•')) process.env[envKey] = val
    }
    update('TMDB_API_KEY', keys.tmdbApiKey)
    update('TVDB_API_KEY', keys.tvdbApiKey)
    update('TVDB_PIN', keys.tvdbPin)
    update('GOOGLE_BOOKS_API_KEY', keys.googleBooksApiKey)
    update('COMICVINE_API_KEY', keys.comicvineApiKey)
    update('IGDB_CLIENT_ID', keys.igdbClientId)
    update('IGDB_CLIENT_SECRET', keys.igdbClientSecret)
    update('FANART_API_KEY', keys.fanartApiKey)

    const resolvedEnvPath = envPath ?? join(process.cwd(), '.env')
    try {
      const content = existsSync(resolvedEnvPath) ? readFileSync(resolvedEnvPath, 'utf8') : ''
      const updates: Record<string, string> = {
        TMDB_API_KEY: keys.tmdbApiKey,
        TVDB_API_KEY: keys.tvdbApiKey,
        TVDB_PIN: keys.tvdbPin,
        GOOGLE_BOOKS_API_KEY: keys.googleBooksApiKey,
        COMICVINE_API_KEY: keys.comicvineApiKey,
        IGDB_CLIENT_ID: keys.igdbClientId,
        IGDB_CLIENT_SECRET: keys.igdbClientSecret,
        FANART_API_KEY: keys.fanartApiKey,
      }
      const lines = content.split('\n')
      for (const [key, value] of Object.entries(updates)) {
        if (!value || value.includes('•')) continue
        const index = lines.findIndex(line => line.startsWith(`${key}=`))
        if (index !== -1) lines[index] = `${key}=${value}`
        else lines.push(`${key}=${value}`)
      }
      writeFileSync(resolvedEnvPath, lines.join('\n'), 'utf8')
      res.json({ success: true })
    } catch (err) {
      logger.error(`Failed to write API keys to ${resolvedEnvPath}:`, err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: 'Failed to persist API keys to .env file' })
    }
  })

  // ── Onboarding / enabled media types ──────────────────────────────────────

  const ALL_MEDIA_TYPES = ['films', 'series', 'music', 'books', 'comics', 'games']

  const enabledMediaTypes = (): string[] => {
    const stored = getAppSetting<string[] | null>('enabled_media_types', null)
    return Array.isArray(stored) && stored.length ? stored.filter(t => ALL_MEDIA_TYPES.includes(t)) : ALL_MEDIA_TYPES
  }

  router.get('/settings/onboarding', (_req, res) => {
    const raw = getAppSetting<boolean | null>('onboarding_completed', null)
    let completed: boolean
    if (raw === true || raw === false) {
      completed = raw
    } else {
      // No explicit flag (install predates onboarding): infer completion from
      // whether any library already has items, so established users aren't
      // ambushed by the wizard — but a genuinely fresh install (even one whose
      // API keys were pre-seeded via .env) still gets it.
      const count = (t: string): number => { try { return (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c } catch { return 0 } }
      completed = ['films', 'series', 'artists', 'authors', 'comic_series', 'games'].some(t => count(t) > 0)
    }
    res.json({ completed, enabledMediaTypes: enabledMediaTypes() })
  })

  router.post('/settings/onboarding/complete', (_req, res) => {
    setAppSetting('onboarding_completed', true)
    res.json({ success: true })
  })

  router.put('/settings/enabled-media-types', (req, res) => {
    const requested = Array.isArray(req.body?.types) ? (req.body.types as unknown[]).filter((t): t is string => typeof t === 'string' && ALL_MEDIA_TYPES.includes(t)) : []
    const types = requested.length ? requested : ALL_MEDIA_TYPES
    setAppSetting('enabled_media_types', types)
    res.json({ enabledMediaTypes: types })
  })

  // ── Factory reset (Danger Zone) ───────────────────────────────────────────
  // Wipes ALL configurable state (incl. API keys), every library and item, and
  // all bookkeeping, then re-seeds the defaults. Optionally deletes media +
  // download files from disk. Snapshots the DB first, then restarts the process
  // so no in-memory state survives (Docker's restart policy brings it back).
  router.post('/settings/factory-reset', async (req, res) => {
    if (req.body?.confirm !== 'RESET') {
      return res.status(400).json({ error: 'Confirmation required' })
    }
    const deleteFiles = req.body?.deleteFiles === true
    logger.warn(`Factory reset requested (deleteFiles=${deleteFiles})`)
    try {
      // 1. Snapshot the database first so wiped config is recoverable.
      try {
        await createSystemBackup(db)
      } catch (err) {
        logger.warn(`Pre-reset backup failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 2. Capture media roots before the libraries that describe them are wiped.
      const mediaTypeDirs = ['films', 'series', 'music', 'books', 'comics', 'games']
        .map(t => join(getMediaRoot(), t))

      // 3. Wipe every user table (schema/tables stay; only rows go), then re-seed.
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_migrations')"
      ).all() as Array<{ name: string }>
      db.pragma('foreign_keys = OFF')
      db.transaction(() => {
        for (const { name } of tables) {
          db.prepare(`DELETE FROM "${name}"`).run()
          try { db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name) } catch { /* no autoincrement */ }
        }
      })()
      db.pragma('foreign_keys = ON')
      ensureDefaultLibraries()

      // 4. Wipe API keys from the runtime and from the persisted .env file.
      const API_KEYS = ['TMDB_API_KEY', 'TVDB_API_KEY', 'TVDB_PIN', 'GOOGLE_BOOKS_API_KEY', 'COMICVINE_API_KEY', 'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET', 'FANART_API_KEY']
      for (const k of API_KEYS) delete process.env[k]
      const resolvedEnvPath = envPath ?? join(process.cwd(), '.env')
      try {
        if (existsSync(resolvedEnvPath)) {
          const kept = readFileSync(resolvedEnvPath, 'utf8').split('\n').filter(line => !API_KEYS.some(k => line.startsWith(`${k}=`)))
          writeFileSync(resolvedEnvPath, kept.join('\n'), 'utf8')
        }
      } catch (err) {
        logger.warn(`Failed to clear API keys from .env: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 5. Mark onboarding incomplete so first-run setup shows on next launch.
      try { setAppSetting('onboarding_completed', false) } catch { /* ignore */ }

      // 6. Optionally delete media + transient download state from disk.
      if (deleteFiles) {
        for (const dir of mediaTypeDirs) safeDeleteMediaPath(dir)
        for (const sub of ['downloads', 'torrents', 'resume', 'incomplete']) {
          try {
            const p = join(process.cwd(), 'data', sub)
            rmSync(p, { recursive: true, force: true })
            mkdirSync(p, { recursive: true })
          } catch { /* best effort */ }
        }
      }

      recordEvent({
        category: 'system',
        action: deleteFiles ? 'factory-reset-with-files' : 'factory-reset',
        subjectType: 'system',
        subjectId: 'factory-reset',
        message: `Factory reset performed${deleteFiles ? ' (media files deleted)' : ''}`,
      })

      res.json({ success: true, restarting: true })

      // 7. Restart to clear all in-memory state; Docker restart policy revives it.
      setTimeout(() => process.exit(0), 750)
    } catch (err) {
      logger.error(`Factory reset failed: ${err instanceof Error ? err.message : String(err)}`)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  return router
}
