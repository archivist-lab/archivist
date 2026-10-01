import type { Router } from 'express'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { baseImportMediaType, createImportPlan, queueMediaImport, type MatchMediaType, type MediaImportPayload } from '../services/media-imports.js'
import { getMediaRoot } from '../shared/media-organizer.js'
import { readEpisodeNumbering } from '../shared/episode-code.js'

const logger = createLogger('FolderImports')

/**
 * Importing from any folder on the server — an old drive, a copy made by
 * hand — the way a finished download is imported: each entry in the folder is
 * matched to a library item (or to a title not yet in the library, which is
 * added first), its import is previewed, and the import job then copies or
 * moves the files into the library and renames them as the library names
 * everything else.
 *
 * The matching and the importing are the download's own (see the manual
 * import routes beside these); what is added here is choosing the folder,
 * titles from outside the library, and the preview for a path that is not a
 * torrent.
 */

interface LibraryRow { id: number; name: string; media_type: string; db_path: string }

const MATCH_TYPES = new Set(['films', 'series', 'series-show', 'series-season', 'series-episode', 'music', 'music-album', 'music-discography', 'games', 'comics', 'comics-issue', 'comics-volume'])

/** Where the folder browser starts, and the places it offers as shortcuts. */
function browseRoots(): Array<{ label: string; path: string }> {
  const downloads = process.env.ARCHIVIST_DOWNLOAD_DIR ?? process.env.TORRENT_DOWNLOAD_DIR ?? './downloads/complete'
  const extra = (process.env.ARCHIVIST_IMPORT_ROOTS ?? '').split(/[;,]/).map(entry => entry.trim()).filter(Boolean)
  const roots = [
    { label: 'Media', path: resolve(getMediaRoot()) },
    { label: 'Downloads', path: resolve(downloads) },
    ...extra.map(path => ({ label: basename(path) || path, path: resolve(path) })),
    { label: 'Server root', path: '/' },
  ]
  return roots.filter((root, index) => roots.findIndex(other => other.path === root.path) === index)
}

/** A new title's id, as the import route takes it: from TMDB/TVDB for films and series, LaunchBox for games. */
export interface ProviderTitle {
  provider: 'tmdb' | 'tvdb' | 'launchbox'
  tmdbId?: number
  tvdbId?: number
  launchboxId?: number
  mediaType: 'films' | 'series-show' | 'games'
  title: string
  year?: number | null
  subtitle?: string | null
  posterUrl?: string | null
}

/** Add a title from outside the library, returning its id there. */
async function addFromProvider(library: LibraryRow, title: ProviderTitle): Promise<number> {
  const db = getDb()
  if (title.mediaType === 'films') {
    if (!title.tmdbId) throw new Error('A film is added by its TMDB id')
    const { createFilmFromTmdb } = await import('../modules/films/create.js')
    return createFilmFromTmdb(db, library.id, title.tmdbId)
  }
  if (title.mediaType === 'series-show') {
    if (!title.tvdbId && !title.tmdbId) throw new Error('A series is added by its TVDB or TMDB id')
    const { createSeriesFromMetadata } = await import('../modules/series/create.js')
    return createSeriesFromMetadata(db, library.id, { tvdbId: title.tvdbId, tmdbId: title.tmdbId })
  }
  if (!title.launchboxId) throw new Error('A game is added by its LaunchBox id')
  const existing = db.prepare('SELECT id FROM games WHERE library_id = ? AND launchbox_id = ?').get(library.id, title.launchboxId) as { id: number } | undefined
  if (existing) return existing.id
  const { libraryGameFor } = await import('../modules/games/launchbox-games.js')
  const game = libraryGameFor(title.launchboxId)
  if (!game) throw new Error(`LaunchBox has no game ${title.launchboxId}`)
  const result = db.prepare(`
    INSERT INTO games (library_id, launchbox_id, title, sort_title, year, release_date, overview, genres, platforms, cover_url, screenshot_url, logo_url, rating, developer, publisher, monitored)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(library.id, title.launchboxId, game.title, game.title.replace(/^(The|A|An)\s+/i, '').toLowerCase(), game.year ?? null, game.releaseDate ?? null,
    game.overview ?? null, JSON.stringify(game.genres), JSON.stringify(game.platforms), game.coverUrl ?? null, game.screenshotUrl ?? null,
    game.logoUrl ?? null, game.rating ?? null, game.developer ?? null, game.publisher ?? null)
  return Number(result.lastInsertRowid)
}

function payloadFor(library: LibraryRow, mediaType: MatchMediaType, itemId: number, sourcePath: string, options: { copy?: boolean; force?: boolean; releaseTitle?: string; episodeNumbering?: unknown }): MediaImportPayload {
  const hash = createHash('sha1').update(`${sourcePath}:${Date.now()}`).digest('hex')
  return {
    tabId: library.id,
    tabName: library.name,
    dbPath: library.db_path,
    mediaType,
    itemId,
    torrentId: `folder:${hash}`,
    infoHash: hash,
    sourcePath,
    copy: Boolean(options.copy),
    force: Boolean(options.force),
    releaseTitle: options.releaseTitle ?? basename(sourcePath),
    episodeNumbering: mediaType.startsWith('series') ? readEpisodeNumbering(options.episodeNumbering) : null,
  }
}

export function registerFolderImportRoutes(router: Router): void {
  // The folder browser: the folders in one, and the shortcuts to start from.
  router.get('/manual-imports/browse', (req, res) => {
    const roots = browseRoots()
    const wanted = typeof req.query.path === 'string' && req.query.path.trim() ? resolve(req.query.path) : roots[0].path
    try {
      const entries = readdirSync(wanted, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'))
        .map(entry => {
          const path = join(wanted, entry.name)
          let isDir = entry.isDirectory()
          let size: number | null = null
          try {
            const stat = statSync(path)
            isDir = stat.isDirectory()
            size = stat.isFile() ? stat.size : null
          } catch { /* unreadable: listed, but without a size */ }
          return { name: entry.name, path, isDir, size }
        })
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      res.json({ path: wanted, parent: wanted === '/' ? null : dirname(wanted), roots, entries })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      res.status(code === 'ENOENT' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 400).json({
        error: code === 'ENOENT' ? `${wanted} does not exist`
          : code === 'EACCES' || code === 'EPERM' ? `The server's user may not open ${wanted}`
          : err instanceof Error ? err.message : String(err),
        path: wanted, parent: dirname(wanted), roots,
      })
    }
  })

  // Titles not in the library yet, from the provider each type is added from.
  router.get('/manual-imports/providers', async (req, res) => {
    const mediaType = String(req.query.mediaType ?? '')
    const query = String(req.query.query ?? '').trim()
    if (query.length < 2) return res.json({ results: [] })
    try {
      let results: ProviderTitle[] = []
      if (mediaType === 'films') {
        const { searchMovies } = await import('../modules/films/tmdb.js')
        results = (await searchMovies(query)).slice(0, 20).map(film => ({
          provider: 'tmdb', tmdbId: film.tmdbId, mediaType: 'films', title: film.title, year: film.year ?? null,
          subtitle: film.overview ? film.overview.slice(0, 120) : null, posterUrl: film.posterPath ?? null,
        }))
      } else if (mediaType === 'series-show' || mediaType === 'series') {
        const { searchSeries } = await import('../modules/series/tvdb.js')
        results = (await searchSeries(query)).slice(0, 20).map(show => ({
          provider: show.tvdbId ? 'tvdb' : 'tmdb', tvdbId: show.tvdbId, tmdbId: show.tmdbId, mediaType: 'series-show',
          title: show.title, year: show.year ?? null, subtitle: show.network ?? null, posterUrl: show.posterPath ?? null,
        }))
      } else if (mediaType === 'games') {
        const { searchLaunchBoxGames } = await import('../modules/games/launchbox-games.js')
        results = searchLaunchBoxGames(query).slice(0, 20).map(game => ({
          provider: 'launchbox', launchboxId: game.launchboxId, mediaType: 'games', title: game.title, year: game.year ?? null,
          subtitle: game.platforms[0] ?? null, posterUrl: game.coverUrl ?? null,
        }))
      }
      res.json({ results })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err), results: [] })
    }
  })

  // What an import would do: the files it takes, where each goes, what it leaves.
  router.post('/manual-imports/plan', (req, res) => {
    const { tabId, mediaType, itemId, sourcePath, force, episodeNumbering } = req.body ?? {}
    if (!sourcePath || !existsSync(sourcePath)) return res.status(400).json({ error: 'sourcePath does not exist' })
    if (!tabId || !itemId || !MATCH_TYPES.has(mediaType)) return res.status(400).json({ error: 'tabId, mediaType and itemId are required' })
    const library = getDb().prepare('SELECT id, name, media_type, db_path FROM libraries WHERE id = ?').get(tabId) as LibraryRow | undefined
    if (!library) return res.status(404).json({ error: 'library not found' })
    try {
      const payload = payloadFor(library, mediaType, Number(itemId), sourcePath, { force: Boolean(force), episodeNumbering })
      res.json({ plan: createImportPlan(payload, getDb(), sourcePath) })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  /**
   * Import one entry: into the library item it was matched to, or into a
   * title added from its provider first. Copying leaves the folder as it was;
   * moving empties it into the library.
   */
  router.post('/manual-imports/import', async (req, res) => {
    const { tabId, mediaType, itemId, provider, sourcePath, copy, force, releaseTitle, episodeNumbering } = req.body ?? {}
    if (!sourcePath || !existsSync(sourcePath)) return res.status(400).json({ error: 'sourcePath does not exist' })
    const library = getDb().prepare('SELECT id, name, media_type, db_path FROM libraries WHERE id = ?').get(tabId) as LibraryRow | undefined
    if (!library) return res.status(404).json({ error: 'library not found' })
    const type = (provider?.mediaType ?? mediaType) as MatchMediaType
    if (!MATCH_TYPES.has(type)) return res.status(400).json({ error: 'unsupported mediaType' })
    if (library.media_type !== baseImportMediaType(type)) return res.status(400).json({ error: `${library.name} holds ${library.media_type}, not ${type}` })
    try {
      const target = itemId ? Number(itemId) : provider ? await addFromProvider(library, provider as ProviderTitle) : null
      if (!target) return res.status(400).json({ error: 'itemId or provider is required' })
      const payload = payloadFor(library, type, target, sourcePath, { copy, force, releaseTitle, episodeNumbering })
      const plan = createImportPlan(payload, getDb(), sourcePath)
      if (plan.status === 'blocked') return res.status(409).json({ error: plan.errors.join('; ') || 'Nothing here can be imported', plan, itemId: target })
      const jobId = queueMediaImport(payload)
      logger.info(`Queued ${copy ? 'copy' : 'move'} of ${sourcePath} into ${library.name} (${type} ${target})`)
      res.status(201).json({ success: true, jobId, itemId: target, plan })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
