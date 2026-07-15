import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createLogger, MONITOR_INTERVAL_MS } from '@archivist/core'
import type { Torrent as SessionTorrent } from '@torrentstack/types'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { mapRemotePath } from './media-organizer.js'
import { queueMediaImport } from '../services/media-imports.js'
import { getExternalTorrentController, loadExternalTorrents } from '../services/external-downloads.js'
import { blockRelease } from '../services/acquisition-decisions.js'

const logger = createLogger('Monitor')

// ── Types ────────────────────────────────────────────────────────────────────

interface MovieRow {
  id: number
  title: string
  status: string
  tmdb_id: number
  file_path: string | null
  acquired_at: string | null
  updated_at: string | null
  info_hash: string | null
  expected_version: string | null
}

interface EpisodeRow {
  id: number
  series_id: number
  season_number: number
  episode_number: number
  title: string
  status: string
  file_path: string | null
  updated_at: string
  info_hash: string | null
}

interface GameRow {
  id: number
  title: string
  igdb_id: number
  status: string
  file_path: string | null
  updated_at: string
  info_hash: string | null
}

interface LibraryRow {
  id: number
  name: string
  media_type: string
  db_path: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when the torrent is fully downloaded and seeding (or stopped after completion). */
function isComplete(t: SessionTorrent): boolean {
  if (t.status === 'seeding') return true
  if (t.files && t.files.length > 0) {
    const wantedFiles = t.files.filter(f => f.wanted)
    if (wantedFiles.length === 0) return false
    return wantedFiles.every(f => f.progress >= 0.999 || f.downloadedBytes >= f.sizeBytes)
  }
  return false
}

/** Calculates progress based only on wanted files. */
function getWantedProgress(t: SessionTorrent): number {
  if (t.status === 'seeding') return 1
  if (!t.files || t.files.length === 0) return t.progress
  const wantedFiles = t.files.filter(f => f.wanted)
  if (wantedFiles.length === 0) return t.progress
  let totalWantedBytes = 0
  let totalDownloadedBytes = 0
  for (const f of wantedFiles) {
    totalWantedBytes += f.sizeBytes
    totalDownloadedBytes += f.downloadedBytes
  }
  return totalWantedBytes > 0 ? Math.min(1, totalDownloadedBytes / totalWantedBytes) : 0
}

function normalize(s: string | null | undefined): string {
  if (!s) return ''
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matchTitle(target: string | null | undefined, candidate: string | null | undefined): boolean {
  const t = normalize(target)
  const c = normalize(candidate)
  if (t.length < 3 || c.length === 0) return false
  return c.includes(t)
}

// A grabbed item whose info_hash is no longer in the download client is
// "orphaned" — the torrent was removed, failed, or lost (e.g. stalled with no
// seeders and cleaned up). The monitor refreshes updated_at every tick a torrent
// is present, so a frozen updated_at is a reliable signal the torrent is gone.
// We wait this long before resetting so a brief client hiccup, or a just-grabbed
// torrent that hasn't registered yet, is never wrongly reset.
const ORPHAN_RESET_GRACE_MS = 30 * 60 * 1000

/** True when a SQLite `datetime('now')` timestamp is older than graceMs. */
export function isStale(updatedAt: string | null | undefined, graceMs: number): boolean {
  if (!updatedAt) return false
  // SQLite stores UTC as 'YYYY-MM-DD HH:MM:SS' (no zone) — normalise to ISO UTC.
  const iso = updatedAt.includes('T') ? updatedAt : updatedAt.replace(' ', 'T') + 'Z'
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) && Date.now() - parsed > graceMs
}

/**
 * Retire an orphaned acquisition: blocklist the dead info_hash (so the next
 * search doesn't immediately re-grab the same gone/seederless release) and log
 * it. The caller resets the item's own row(s). blockRelease dedupes by hash, so
 * a season pack's shared hash is only blocked once.
 */
function blocklistOrphan(db: Database, library: LibraryRow, infoHash: string, title: string, subjectType: string, subjectId: number): void {
  try {
    blockRelease({
      infoHash,
      releaseTitle: title,
      reason: 'torrent left the download client before completing',
      tabId: library.id,
      mediaType: library.media_type,
      subjectType,
      subjectId,
    }, db)
  } catch { /* blocklisting is best-effort — never block the reset on it */ }
  logger.warn(`Library "${library.name}" ${subjectType} "${title}" reset to missing — torrent ${infoHash} is no longer in the download client`)
}

function torrentSourcePath(torrent: any): string {
  return torrent.sourcePath ?? join(torrent.downloadDir, torrent.name)
}

function torrentFilePath(torrent: any, fileName: string): string {
  if (!torrent.sourcePath) return join(torrent.downloadDir, torrent.name, fileName)
  const normalized = fileName.replace(/\\/g, '/')
  const rootName = basename(torrent.sourcePath)
  const relativeName = normalized.startsWith(`${rootName}/`) ? normalized.slice(rootName.length + 1) : normalized
  return join(torrent.sourcePath, relativeName)
}

// ─────────────────────────────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null

export function startDownloadMonitor(): void {
  if (monitorTimer) return
  logger.info('Starting unified library monitor...')

  let isRunning = false

  monitorTimer = setInterval(async () => {
    if (isRunning) return
    isRunning = true
    try {
      await monitorSession()
    } catch (err) {
      logger.error('Monitor error:', err instanceof Error ? err.message : String(err))
    } finally {
      isRunning = false
    }
  }, MONITOR_INTERVAL_MS)
  monitorTimer.unref?.()
}

export function stopDownloadMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer)
  monitorTimer = null
}

async function monitorSession(): Promise<void> {
  let embedded: ReturnType<typeof getTorrentSession> | null = null
  try { embedded = getTorrentSession() } catch { /* external-only mode */ }

  const external = await loadExternalTorrents()
  const torrents = [...(embedded?.getAllTorrents() ?? []), ...external] as any[]
  if (torrents.length === 0 && !embedded) return
  const session = {
    removeTorrent: async (id: string, deleteData: boolean) => {
      const externalController = getExternalTorrentController(id)
      if (externalController) return externalController.removeTorrent(id, deleteData)
      if (embedded) return embedded.removeTorrent(id, deleteData)
    },
    addTorrent: (input: any) => {
      if (!embedded) return Promise.reject(new Error('Embedded torrent engine is disabled'))
      return embedded.addTorrent(input)
    },
  }
  const db = getDb()
  const libraries = db.prepare('SELECT * FROM libraries').all() as LibraryRow[]

  for (const library of libraries) {
    try {
      await monitorLibrary(library, db, torrents, session)
    } catch (err) {
      logger.error(`Failed to monitor library "${library.name}":`, err instanceof Error ? err.message : String(err))
    }
  }
}

async function monitorLibrary(library: LibraryRow, db: Database, torrents: any[], session: any): Promise<void> {
  const mediaType = library.media_type

  // 1. Cleanup already collected torrents for this library
  for (const t of torrents) {
    const hash = t.infoHash.toLowerCase()
    let collected = false
    if (mediaType === 'films') collected = !!db.prepare("SELECT id FROM films WHERE library_id = ? AND LOWER(info_hash) = ? AND status = 'collected'").get(library.id, hash)
    else if (mediaType === 'series') collected = !!db.prepare("SELECT e.id FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ? AND LOWER(e.info_hash) = ? AND e.status = 'collected'").get(library.id, hash)
    else if (mediaType === 'music') collected = !!db.prepare("SELECT al.id FROM albums al JOIN artists ar ON al.artist_id = ar.id WHERE ar.library_id = ? AND LOWER(al.info_hash) = ? AND al.status = 'collected'").get(library.id, hash)
    else if (mediaType === 'books') collected = !!db.prepare("SELECT b.id FROM books b JOIN authors a ON a.id = b.author_id WHERE a.library_id = ? AND LOWER(b.info_hash) = ? AND b.status IN ('collected', 'downloaded')").get(library.id, hash)
    else if (mediaType === 'games') collected = !!db.prepare("SELECT id FROM games WHERE library_id = ? AND LOWER(info_hash) = ? AND status = 'collected'").get(library.id, hash)
    else if (mediaType === 'comics') collected = !!db.prepare("SELECT i.id FROM comic_issues i JOIN comic_series s ON i.series_id = s.id WHERE s.library_id = ? AND LOWER(i.info_hash) = ? AND i.status = 'collected'").get(library.id, hash)

    if (collected) {
      logger.info(`Library "${library.name}" cleanup: removing already-collected torrent ${hash} (${t.name})`)
      try { await session.removeTorrent(t.id, false) } catch {}
    }
  }

  // 2. Monitor specific media type
  if (mediaType === 'films') await monitorFilms(library, db, torrents, session)
  else if (mediaType === 'series') await monitorSeries(library, db, torrents, session)
  else if (mediaType === 'music') await monitorMusic(library, db, torrents, session)
  else if (mediaType === 'books') await monitorBooks(library, db, torrents, session)
  else if (mediaType === 'games') await monitorGames(library, db, torrents, session)
  else if (mediaType === 'comics') await monitorComics(library, db, torrents, session)

  // 3. Integrity checks
  await checkLibraryIntegrity(library, db)
}

async function monitorFilms(library: LibraryRow, db: Database, torrents: any[], session: any): Promise<void> {
  const acquiringFilms = db.prepare(
    "SELECT id, title, status, tmdb_id, file_path, acquired_at, updated_at, info_hash, expected_version FROM films WHERE library_id = ? AND status IN ('acquiring', 'missing', 'wanted')",
  ).all(library.id) as MovieRow[]

  for (const film of acquiringFilms) {
    let matching = torrents.find(t =>
      !!film.info_hash && t.infoHash.toLowerCase() === film.info_hash.toLowerCase(),
    )

    if (!matching) {
      matching = torrents.find(t => matchTitle(film.title, t.name))
      if (matching && (film.status === 'wanted' || film.status === 'missing' || !film.info_hash)) {
        logger.info(`Library "${library.name}" film auto-link: matched "${film.title}" to torrent "${matching.name}"`)
        db.prepare("UPDATE films SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?")
          .run(matching.infoHash, film.id)
      }
    }

    if (matching) {
      const progress = getWantedProgress(matching)
      db.prepare("UPDATE films SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?")
        .run(progress, film.id)

      if (isComplete(matching)) {
        const sourcePath = torrentSourcePath(matching)
        const jobId = queueMediaImport({
          tabId: library.id,
          tabName: library.name,
          dbPath: library.db_path,
          mediaType: 'films',
          itemId: film.id,
          torrentId: matching.id,
          infoHash: matching.infoHash,
          sourcePath,
          expectedVersion: film.expected_version,
          releaseTitle: matching.name,
        })
        if (jobId) logger.info(`Library "${library.name}" film "${film.title}" import queued as job #${jobId}`)
      }
    } else if (film.status === 'acquiring' && film.info_hash && isStale(film.updated_at, ORPHAN_RESET_GRACE_MS)) {
      blocklistOrphan(db, library, film.info_hash, film.title, 'film', film.id)
      db.prepare("UPDATE films SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(film.id)
    }
  }
}

async function monitorSeries(library: LibraryRow, db: Database, torrents: any[], session: any): Promise<void> {
  const acquiringEpisodes = db.prepare(`
    SELECT e.id, e.series_id, e.season_number, e.episode_number, e.title, e.status, e.file_path, e.updated_at, e.info_hash
    FROM episodes e JOIN series s ON e.series_id = s.id
    WHERE s.library_id = ? AND e.status IN ('acquiring', 'downloading', 'missing', 'wanted')
  `).all(library.id) as EpisodeRow[]

  for (const ep of acquiringEpisodes) {
    const series = db.prepare('SELECT title, year, tmdb_id, language FROM series WHERE id = ?').get(ep.series_id) as any
    if (!series) continue
    const sxxexx = `s${String(ep.season_number).padStart(2, '0')}e${String(ep.episode_number).padStart(2, '0')}`

    let matching = torrents.find(t => !!ep.info_hash && t.infoHash.toLowerCase() === ep.info_hash.toLowerCase())
    if (!matching) {
      matching = torrents.find(t => t.name && matchTitle(series.title, t.name) && t.name.toLowerCase().includes(sxxexx))
      if (matching && (ep.status === 'wanted' || ep.status === 'missing' || !ep.info_hash)) {
        db.prepare("UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(matching.infoHash, ep.id)
      }
    }

    if (matching) {
      const files = matching.files ?? []
      const isPack = files.length > 1
      const epFileEntry = isPack ? files.find((f: any) => f.name.toLowerCase().includes(sxxexx)) : undefined
      const progress = (epFileEntry && epFileEntry.sizeBytes > 0) ? epFileEntry.downloadedBytes / epFileEntry.sizeBytes : getWantedProgress(matching)
      db.prepare("UPDATE episodes SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, ep.id)

      if (isComplete(matching) || (epFileEntry && epFileEntry.downloadedBytes >= epFileEntry.sizeBytes)) {
        const sourcePath = (isPack && epFileEntry) ? torrentFilePath(matching, epFileEntry.name) : torrentSourcePath(matching)
        const jobId = queueMediaImport({
          tabId: library.id,
          tabName: library.name,
          dbPath: library.db_path,
          mediaType: 'series',
          itemId: ep.id,
          torrentId: matching.id,
          infoHash: matching.infoHash,
          sourcePath,
          copy: !!isPack,
          releaseTitle: matching.name,
        })
        if (jobId) logger.info(`Library "${library.name}" episode ${series.title} ${sxxexx} import queued as job #${jobId}`)
      }
    } else if ((ep.status === 'acquiring' || ep.status === 'downloading') && ep.info_hash && isStale(ep.updated_at, ORPHAN_RESET_GRACE_MS)) {
      // Orphaned: grabbed but the torrent has left the client and never
      // completed. Blocklist the dead hash and reset to missing so the normal
      // search re-acquires it (without re-grabbing the same gone release).
      blocklistOrphan(db, library, ep.info_hash, `${series.title} ${sxxexx}`, 'episode', ep.id)
      db.prepare("UPDATE episodes SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(ep.id)
    }
  }

  // Season pack progress
  const acquiringSeasons = db.prepare(`
    SELECT se.id, se.series_id, se.season_number, se.updated_at, se.info_hash, se.download_progress
    FROM seasons se JOIN series s ON se.series_id = s.id
    WHERE s.library_id = ? AND (se.download_progress > 0 OR se.info_hash IS NOT NULL)
  `).all(library.id) as any[]
  for (const s of acquiringSeasons) {
    // A fully-collected season's pack is finished — clear the lingering hash so
    // it stops being tracked and shown as "acquiring". (Per-episode imports
    // don't clear the season row the way the season-pack import path does.)
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE series_id = ? AND season_number = ? AND status NOT IN ('collected', 'downloaded')").get(s.series_id, s.season_number) as { n: number }
    if (remaining.n === 0) {
      if (s.info_hash) db.prepare("UPDATE seasons SET info_hash = NULL, updated_at = datetime('now') WHERE id = ?").run(s.id)
      continue
    }
    const matching = torrents.find(t => !!s.info_hash && t.infoHash.toLowerCase() === s.info_hash.toLowerCase())
    if (matching) {
      db.prepare("UPDATE seasons SET download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(getWantedProgress(matching), s.id)
    } else if (s.info_hash && s.download_progress < 0.999 && isStale(s.updated_at, ORPHAN_RESET_GRACE_MS)) {
      // Orphaned season pack — clear the dead hash so it stops showing as
      // acquiring and can be re-acquired (its episodes reset above). A completed
      // season (progress ~1) keeps its lingering hash — it's collected, not stuck.
      blocklistOrphan(db, library, s.info_hash, `series #${s.series_id} S${String(s.season_number).padStart(2, '0')} pack`, 'season', s.id)
      db.prepare("UPDATE seasons SET info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(s.id)
    }
  }
}

async function monitorMusic(library: LibraryRow, db: Database, torrents: any[], _session: any): Promise<void> {
  const acquiringAlbums = db.prepare(`
    SELECT al.id, al.artist_id, al.title, al.status, al.updated_at, al.info_hash
    FROM albums al JOIN artists ar ON al.artist_id = ar.id
    WHERE ar.library_id = ? AND al.status IN ('acquiring', 'missing', 'wanted')
  `).all(library.id) as any[]
  for (const album of acquiringAlbums) {
    const artist = db.prepare('SELECT name FROM artists WHERE id = ?').get(album.artist_id) as { name: string }
    if (!artist) continue
    const matching = torrents.find(t => !!album.info_hash && t.infoHash.toLowerCase() === album.info_hash.toLowerCase())
    if (matching) {
      const progress = getWantedProgress(matching)
      db.prepare("UPDATE albums SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, album.id)
      if (isComplete(matching)) {
        const sourcePath = torrentSourcePath(matching)
        const jobId = queueMediaImport({
          tabId: library.id,
          tabName: library.name,
          dbPath: library.db_path,
          mediaType: 'music',
          itemId: album.id,
          torrentId: matching.id,
          infoHash: matching.infoHash,
          sourcePath,
          releaseTitle: matching.name,
        })
        if (jobId) logger.info(`Library "${library.name}" album "${artist.name} - ${album.title}" import queued as job #${jobId}`)
      }
    } else if (album.status === 'acquiring' && album.info_hash && isStale(album.updated_at, ORPHAN_RESET_GRACE_MS)) {
      blocklistOrphan(db, library, album.info_hash, `${artist.name} - ${album.title}`, 'album', album.id)
      db.prepare("UPDATE albums SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(album.id)
      db.prepare("UPDATE tracks SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE album_id = ? AND status IN ('acquiring', 'downloading')").run(album.id)
    }
  }
}

async function monitorGames(library: LibraryRow, db: Database, torrents: any[], _session: any): Promise<void> {
  const acquiringGames = db.prepare("SELECT id, title, igdb_id, status, updated_at, file_path, info_hash FROM games WHERE library_id = ? AND status IN ('acquiring', 'missing', 'wanted')").all(library.id) as GameRow[]
  for (const game of acquiringGames) {
    const matching = torrents.find(t => !!game.info_hash && t.infoHash.toLowerCase() === game.info_hash.toLowerCase())
    if (matching) {
      db.prepare("UPDATE games SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(getWantedProgress(matching), game.id)
      if (isComplete(matching)) {
        const sourcePath = torrentSourcePath(matching)
        const jobId = queueMediaImport({
          tabId: library.id,
          tabName: library.name,
          dbPath: library.db_path,
          mediaType: 'games',
          itemId: game.id,
          torrentId: matching.id,
          infoHash: matching.infoHash,
          sourcePath,
          releaseTitle: matching.name,
        })
        if (jobId) logger.info(`Library "${library.name}" game "${game.title}" import queued as job #${jobId}`)
      }
    } else if (game.status === 'acquiring' && game.info_hash && isStale(game.updated_at, ORPHAN_RESET_GRACE_MS)) {
      blocklistOrphan(db, library, game.info_hash, game.title, 'game', game.id)
      db.prepare("UPDATE games SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(game.id)
    }
  }
}

async function monitorBooks(library: LibraryRow, db: Database, torrents: any[], _session: any): Promise<void> {
  const books = db.prepare(`
    SELECT b.id, b.title, b.status, b.info_hash, b.updated_at, a.name AS author_name
    FROM books b JOIN authors a ON a.id = b.author_id
    WHERE a.library_id = ? AND b.status IN ('acquiring', 'downloading', 'missing', 'wanted')
  `).all(library.id) as any[]

  for (const book of books) {
    let matching = torrents.find(t => !!book.info_hash && t.infoHash.toLowerCase() === book.info_hash.toLowerCase())
    if (!matching) {
      matching = torrents.find(t =>
        matchTitle(book.title, t.name) && (!book.author_name || matchTitle(book.author_name, t.name)),
      )
      if (matching && (book.status === 'wanted' || book.status === 'missing' || !book.info_hash)) {
        db.prepare("UPDATE books SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?")
          .run(matching.infoHash, book.id)
      }
    }
    if (!matching) {
      if ((book.status === 'acquiring' || book.status === 'downloading') && book.info_hash && isStale(book.updated_at, ORPHAN_RESET_GRACE_MS)) {
        blocklistOrphan(db, library, book.info_hash, `${book.author_name} - ${book.title}`, 'book', book.id)
        db.prepare("UPDATE books SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(book.id)
      }
      continue
    }

    db.prepare("UPDATE books SET status = 'downloading', download_progress = ?, updated_at = datetime('now') WHERE id = ?")
      .run(getWantedProgress(matching), book.id)
    if (isComplete(matching)) {
      const sourcePath = torrentSourcePath(matching)
      const jobId = queueMediaImport({
        tabId: library.id,
        tabName: library.name,
        dbPath: library.db_path,
        mediaType: 'books',
        itemId: book.id,
        torrentId: matching.id,
        infoHash: matching.infoHash,
        sourcePath,
        releaseTitle: matching.name,
      })
      if (jobId) logger.info(`Library "${library.name}" book "${book.author_name} - ${book.title}" import queued as job #${jobId}`)
    }
  }
}

async function monitorComics(library: LibraryRow, db: Database, torrents: any[], _session: any): Promise<void> {
  const acquiringIssues = db.prepare(`
    SELECT i.*, s.title as series_title, s.comicvine_id as series_cv_id, s.start_year
    FROM comic_issues i JOIN comic_series s ON i.series_id = s.id
    WHERE s.library_id = ? AND i.status IN ('acquiring', 'downloading', 'missing', 'wanted')
  `).all(library.id) as any[]

  for (const issue of acquiringIssues) {
    const matching = torrents.find(t => !!issue.info_hash && t.infoHash.toLowerCase() === issue.info_hash.toLowerCase())
    if (matching) {
      db.prepare("UPDATE comic_issues SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(getWantedProgress(matching), issue.id)
      if (isComplete(matching)) {
        const sourcePath = torrentSourcePath(matching)
        const jobId = queueMediaImport({
          tabId: library.id,
          tabName: library.name,
          dbPath: library.db_path,
          mediaType: 'comics',
          itemId: issue.id,
          torrentId: matching.id,
          infoHash: matching.infoHash,
          sourcePath,
          releaseTitle: matching.name,
        })
        if (jobId) logger.info(`Library "${library.name}" comic "${issue.series_title} #${issue.issue_number}" import queued as job #${jobId}`)
      }
    } else if ((issue.status === 'acquiring' || issue.status === 'downloading') && issue.info_hash && isStale(issue.updated_at, ORPHAN_RESET_GRACE_MS)) {
      blocklistOrphan(db, library, issue.info_hash, `${issue.series_title} #${issue.issue_number}`, 'issue', issue.id)
      db.prepare("UPDATE comic_issues SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(issue.id)
    }
  }
}

async function checkLibraryIntegrity(library: LibraryRow, db: Database): Promise<void> {
  const queries: Record<string, { select: string; update: string }> = {
    films: {
      select: "SELECT id, title, file_path, default_edition_id FROM films WHERE library_id = ? AND status = 'collected'",
      update: "UPDATE films SET status = 'missing', file_path = NULL, updated_at = datetime('now') WHERE id = ?",
    },
    series: {
      select: "SELECT e.id, e.title, e.file_path FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ? AND e.status = 'collected'",
      update: "UPDATE episodes SET status = 'missing', file_path = NULL, updated_at = datetime('now') WHERE id = ?",
    },
    music: {
      select: "SELECT tr.id, tr.title, tr.file_path FROM tracks tr JOIN artists ar ON tr.artist_id = ar.id WHERE ar.library_id = ? AND tr.status = 'collected'",
      update: "UPDATE tracks SET status = 'missing', file_path = NULL, updated_at = datetime('now') WHERE id = ?",
    },
    books: {
      select: "SELECT be.id, b.id AS book_id, b.title, be.file_path FROM book_editions be JOIN books b ON b.id = be.book_id JOIN authors a ON a.id = b.author_id WHERE a.library_id = ? AND be.status = 'downloaded'",
      update: "UPDATE book_editions SET status = 'missing', file_path = NULL, file_size = NULL WHERE id = ?",
    },
    games: {
      select: "SELECT id, title, file_path FROM games WHERE library_id = ? AND status = 'collected'",
      update: "UPDATE games SET status = 'missing', file_path = NULL, updated_at = datetime('now') WHERE id = ?",
    },
    comics: {
      select: "SELECT i.id, i.title, i.file_path FROM comic_issues i JOIN comic_series s ON i.series_id = s.id WHERE s.library_id = ? AND i.status = 'collected'",
      update: "UPDATE comic_issues SET status = 'missing', file_path = NULL, updated_at = datetime('now') WHERE id = ?",
    },
  }
  const q = queries[library.media_type]
  if (!q) return

  const collected = db.prepare(q.select).all(library.id) as any[]
  for (const item of collected) {
    if (!item.file_path || !existsSync(mapRemotePath(item.file_path))) {
      // Films carry alternate editions: only reset when no edition still has a
      // file on disk. If a default/other edition is present, re-roll it up
      // instead of flipping the film to 'missing'.
      if (library.media_type === 'films') {
        const editions = db.prepare('SELECT * FROM film_editions WHERE film_id = ?').all(item.id) as any[]
        const live = editions.filter(e => e.file_path && existsSync(mapRemotePath(e.file_path)))
        if (live.length) {
          const def = live.find(e => e.id === item.default_edition_id) ?? live[0]
          db.prepare(`
            UPDATE films SET
              status = 'collected', file_path = ?, file_size = ?, quality = ?, download_progress = 1,
              default_edition_id = COALESCE(default_edition_id, ?),
              current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
              current_release_group = ?, current_edition = ?, current_size_bytes = ?, current_release_title = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(
            def.file_path, def.file_size, def.quality, def.id,
            def.current_tier, def.current_resolution, def.current_source, def.current_codec,
            def.current_release_group, def.current_edition, def.current_size_bytes, def.current_release_title,
            item.id,
          )
          continue
        }
      }
      db.prepare(q.update).run(item.id)
      if (library.media_type === 'books') {
        const liveEdition = db.prepare(`
          SELECT id FROM book_editions
          WHERE book_id = ? AND status = 'downloaded' AND file_path IS NOT NULL
          LIMIT 1
        `).get(item.book_id)
        if (!liveEdition) {
          db.prepare("UPDATE books SET status = 'missing', download_progress = 0, updated_at = datetime('now') WHERE id = ?")
            .run(item.book_id)
        }
      }
    }
  }
}
