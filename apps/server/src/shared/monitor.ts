import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger, MONITOR_INTERVAL_MS } from '@archivist/core'
import type { Torrent as SessionTorrent } from '@torrentstack/types'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { mapRemotePath } from './media-organizer.js'
import { queueMediaImport } from '../services/media-imports.js'

const logger = createLogger('Monitor')

// ── Types ────────────────────────────────────────────────────────────────────

interface MovieRow {
  id: number
  title: string
  status: string
  tmdb_id: number
  file_path: string | null
  acquired_at: string | null
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
  let session: ReturnType<typeof getTorrentSession>
  try {
    session = getTorrentSession()
  } catch {
    return
  }

  const torrents = session.getAllTorrents()
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

async function monitorLibrary(library: LibraryRow, db: Database, torrents: SessionTorrent[], session: any): Promise<void> {
  const mediaType = library.media_type

  // 1. Cleanup already collected torrents for this library
  for (const t of torrents) {
    const hash = t.infoHash.toLowerCase()
    let collected = false
    if (mediaType === 'films') collected = !!db.prepare("SELECT id FROM films WHERE library_id = ? AND LOWER(info_hash) = ? AND status = 'collected'").get(library.id, hash)
    else if (mediaType === 'series') collected = !!db.prepare("SELECT e.id FROM episodes e JOIN series s ON e.series_id = s.id WHERE s.library_id = ? AND LOWER(e.info_hash) = ? AND e.status = 'collected'").get(library.id, hash)
    else if (mediaType === 'music') collected = !!db.prepare("SELECT al.id FROM albums al JOIN artists ar ON al.artist_id = ar.id WHERE ar.library_id = ? AND LOWER(al.info_hash) = ? AND al.status = 'collected'").get(library.id, hash)
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
  else if (mediaType === 'games') await monitorGames(library, db, torrents, session)
  else if (mediaType === 'comics') await monitorComics(library, db, torrents, session)

  // 3. Integrity checks
  await checkLibraryIntegrity(library, db)
}

async function monitorFilms(library: LibraryRow, db: Database, torrents: SessionTorrent[], session: any): Promise<void> {
  const acquiringFilms = db.prepare(
    "SELECT id, title, status, tmdb_id, file_path, acquired_at, info_hash, expected_version FROM films WHERE library_id = ? AND status IN ('acquiring', 'missing', 'wanted')",
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

    if (!matching && film.status === 'acquiring' && film.info_hash) {
      logger.info(`Library "${library.name}" film monitor: "${film.title}" is missing from session, re-adding via magnet...`)
      session.addTorrent({
        magnetLink: `magnet:?xt=urn:btih:${film.info_hash}`,
        labels: ['archivist-films'],
      }).catch((err: any) => {
        logger.error(`Failed to re-add missing film ${film.title}:`, err.message)
      })
    }

    if (matching) {
      const progress = getWantedProgress(matching)
      db.prepare("UPDATE films SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?")
        .run(progress, film.id)

      if (isComplete(matching)) {
        const sourcePath = join(matching.downloadDir, matching.name)
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
    }
  }
}

async function monitorSeries(library: LibraryRow, db: Database, torrents: SessionTorrent[], session: any): Promise<void> {
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
      const epFileEntry = isPack ? files.find(f => f.name.toLowerCase().includes(sxxexx)) : undefined
      const progress = (epFileEntry && epFileEntry.sizeBytes > 0) ? epFileEntry.downloadedBytes / epFileEntry.sizeBytes : getWantedProgress(matching)
      db.prepare("UPDATE episodes SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, ep.id)

      if (isComplete(matching) || (epFileEntry && epFileEntry.downloadedBytes >= epFileEntry.sizeBytes)) {
        const sourcePath = (isPack && epFileEntry) ? join(matching.downloadDir, matching.name, epFileEntry.name) : join(matching.downloadDir, matching.name)
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
    }
  }

  // Season pack progress
  const acquiringSeasons = db.prepare(`
    SELECT se.id, se.series_id, se.season_number, se.updated_at, se.info_hash
    FROM seasons se JOIN series s ON se.series_id = s.id
    WHERE s.library_id = ? AND (se.download_progress > 0 OR se.info_hash IS NOT NULL)
  `).all(library.id) as any[]
  for (const s of acquiringSeasons) {
    const matching = torrents.find(t => !!s.info_hash && t.infoHash.toLowerCase() === s.info_hash.toLowerCase())
    if (matching) {
      db.prepare("UPDATE seasons SET download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(getWantedProgress(matching), s.id)
    }
  }
}

async function monitorMusic(library: LibraryRow, db: Database, torrents: SessionTorrent[], _session: any): Promise<void> {
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
        const sourcePath = join(matching.downloadDir, matching.name)
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
    }
  }
}

async function monitorGames(library: LibraryRow, db: Database, torrents: SessionTorrent[], _session: any): Promise<void> {
  const acquiringGames = db.prepare("SELECT id, title, igdb_id, status, updated_at, file_path, info_hash FROM games WHERE library_id = ? AND status IN ('acquiring', 'missing', 'wanted')").all(library.id) as GameRow[]
  for (const game of acquiringGames) {
    const matching = torrents.find(t => !!game.info_hash && t.infoHash.toLowerCase() === game.info_hash.toLowerCase())
    if (matching) {
      db.prepare("UPDATE games SET status = 'acquiring', download_progress = ?, updated_at = datetime('now') WHERE id = ?").run(getWantedProgress(matching), game.id)
      if (isComplete(matching)) {
        const sourcePath = join(matching.downloadDir, matching.name)
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
    }
  }
}

async function monitorComics(library: LibraryRow, db: Database, torrents: SessionTorrent[], _session: any): Promise<void> {
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
        const sourcePath = join(matching.downloadDir, matching.name)
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
    }
  }
}

async function checkLibraryIntegrity(library: LibraryRow, db: Database): Promise<void> {
  const queries: Record<string, { select: string; update: string }> = {
    films: {
      select: "SELECT id, title, file_path FROM films WHERE library_id = ? AND status = 'collected'",
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
      db.prepare(q.update).run(item.id)
    }
  }
}
