import type { Database } from 'better-sqlite3'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'
import { isIgnoredStagedDownload } from '../services/media-imports.js'
import { getTorrentSession } from '../services/torrent-session.js'
import { enqueueUniqueJob, recordEvent } from './event-store.js'
import { registerJobHandler } from './job-runner.js'
import { getFilmFileInfo } from '../shared/media-organizer.js'
import { blockRelease } from '../services/acquisition-decisions.js'

export type IntegritySeverity = 'info' | 'warn' | 'error'

export interface IntegrityProblem {
  id: string
  severity: IntegritySeverity
  category: string
  scope: 'system' | 'tab' | 'download' | 'import'
  message: string
  tabId?: number
  tabName?: string
  mediaType?: string
  subjectType?: string
  subjectId?: string
  title?: string
  path?: string
  action?: string
}

export interface IntegrityReport {
  generatedAt: string
  summary: {
    total: number
    bySeverity: Record<IntegritySeverity, number>
    byCategory: Record<string, number>
  }
  problems: IntegrityProblem[]
}

export interface IntegrityRepairResult {
  success: boolean
  action: string
  message: string
  changes: number
  backupId?: string
}

export interface BulkIntegrityRepairResult {
  requested: number
  repaired: number
  skipped: number
  changes: number
  results: IntegrityRepairResult[]
}

export interface IntegrityConfig {
  enabled: boolean
  intervalHours: number
  recordCleanScans: boolean
  backupBeforeRepair: boolean
}

interface LibraryRow {
  id: number
  name: string
  media_type: string
  db_path: string
}

interface FileOwner {
  tabId: number
  tabName: string
  mediaType: string
  subjectType: string
  subjectId: string
  title: string
}

const DEFAULT_CONFIG: IntegrityConfig = {
  enabled: true,
  intervalHours: 12,
  recordCleanScans: false,
  backupBeforeRepair: true,
}

let scheduler: ReturnType<typeof setInterval> | null = null

function clampConfig(config: Partial<IntegrityConfig>): IntegrityConfig {
  return {
    enabled: config.enabled !== undefined ? !!config.enabled : DEFAULT_CONFIG.enabled,
    intervalHours: Math.max(1, Math.min(168, Number(config.intervalHours) || DEFAULT_CONFIG.intervalHours)),
    recordCleanScans: config.recordCleanScans !== undefined ? !!config.recordCleanScans : DEFAULT_CONFIG.recordCleanScans,
    backupBeforeRepair: config.backupBeforeRepair !== undefined ? !!config.backupBeforeRepair : DEFAULT_CONFIG.backupBeforeRepair,
  }
}

export function getIntegrityConfig(db: Database = getDb()): IntegrityConfig {
  return clampConfig(getAppSetting('systemIntegrity', DEFAULT_CONFIG, 0, db))
}

export function setIntegrityConfig(config: Partial<IntegrityConfig>, db: Database = getDb()): IntegrityConfig {
  const merged = clampConfig({ ...getIntegrityConfig(db), ...config })
  setAppSetting('systemIntegrity', merged, 0, db)
  recordEvent({ category: 'integrity', action: 'configured', message: 'Integrity scan settings updated', data: merged }, db)
  return merged
}

export function getLastIntegrityReport(db: Database = getDb()): IntegrityReport | null {
  return getAppSetting<IntegrityReport | null>('lastIntegrityReport', null, 0, db)
}

function mapRemotePath(inputPath: string | null | undefined): string {
  if (!inputPath) return ''
  const mapStr = process.env.REMOTE_PATH_MAP
  if (!mapStr) return inputPath
  for (const mapping of mapStr.split(',')) {
    const [remote, local] = mapping.split(':')
    if (remote && local && inputPath.startsWith(remote)) return inputPath.replace(remote, local)
  }
  return inputPath
}

function safeRows<T = any>(db: Database, sql: string, ...args: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...args) as T[]
  } catch {
    return []
  }
}

function addProblem(problems: IntegrityProblem[], problem: Omit<IntegrityProblem, 'id'>): void {
  problems.push({
    id: `${problem.category}:${problem.scope}:${problem.tabId ?? 'system'}:${problem.subjectType ?? 'item'}:${problem.subjectId ?? problems.length}`,
    ...problem,
  })
}

function addFileOwner(fileOwners: Map<string, FileOwner[]>, filePath: string | null | undefined, owner: FileOwner): void {
  if (!filePath) return
  const mapped = resolve(mapRemotePath(filePath))
  const owners = fileOwners.get(mapped) ?? []
  owners.push(owner)
  fileOwners.set(mapped, owners)
}

function checkCollectedFile(
  problems: IntegrityProblem[],
  fileOwners: Map<string, FileOwner[]>,
  library: LibraryRow,
  row: { id: number | string; title?: string | null; file_path?: string | null },
  subjectType: string,
): void {
  if (!row.file_path) {
    addProblem(problems, {
      severity: 'error',
      category: 'missing-file-path',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      message: `Collected ${subjectType} has no file path`,
      action: 'mark missing or rescan library',
    })
    return
  }

  const mapped = mapRemotePath(row.file_path)
  addFileOwner(fileOwners, mapped, {
    tabId: library.id,
    tabName: library.name,
    mediaType: library.media_type,
    subjectType,
    subjectId: String(row.id),
    title: row.title ?? `${subjectType} ${row.id}`,
  })

  if (!existsSync(mapped)) {
    addProblem(problems, {
      severity: 'error',
      category: 'missing-collected-file',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      path: row.file_path,
      message: `Collected ${subjectType} file is missing: ${row.file_path}`,
      action: 'restore file, update path, or mark missing',
    })
    return
  }

  if (subjectType === 'film' || subjectType === 'episode') {
    checkCollectedVideoHealth(problems, library, row, subjectType, mapped)
  }
}

function checkCollectedVideoHealth(
  problems: IntegrityProblem[],
  library: LibraryRow,
  row: { id: number | string; title?: string | null; file_path?: string | null },
  subjectType: string,
  mappedPath: string,
): void {
  const sourcePath = row.file_path ?? mappedPath
  const info = getFilmFileInfo(mappedPath)
  if (!info) {
    addProblem(problems, {
      severity: 'error',
      category: 'media-probe-failed',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      path: sourcePath,
      message: `Collected ${subjectType} could not be probed: ${sourcePath}`,
      action: 'replace the file or inspect it manually',
    })
    return
  }

  const tracks = info.tracks ?? []
  const primaryVideo = tracks.filter(track => track.type === 'video' && (track.codec ?? '').toLowerCase() !== 'mjpeg')
  const audio = tracks.filter(track => track.type === 'audio')
  if (primaryVideo.length === 0) {
    addProblem(problems, {
      severity: 'error',
      category: 'invalid-media-file',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      path: sourcePath,
      message: `Collected ${subjectType} has no primary video stream: ${sourcePath}`,
      action: 'replace the file or re-import a valid release',
    })
  }
  if (audio.length === 0) {
    addProblem(problems, {
      severity: 'error',
      category: 'invalid-media-file',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      path: sourcePath,
      message: `Collected ${subjectType} has no audio stream: ${sourcePath}`,
      action: 'replace the file or re-import a valid release',
    })
  }

  const chapterCount = info.chapters?.length ?? 0
  if (chapterCount === 0) {
    addProblem(problems, {
      severity: 'warn',
      category: 'missing-chapters',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      path: sourcePath,
      message: `Collected ${subjectType} has no embedded chapters`,
      action: 'accept the release, source chapters, or replace with a better release',
    })
  } else if (chapterCount === 1) {
    addProblem(problems, {
      severity: 'warn',
      category: 'sparse-chapters',
      scope: 'tab',
      tabId: library.id,
      tabName: library.name,
      mediaType: library.media_type,
      subjectType,
      subjectId: String(row.id),
      title: row.title ?? `${subjectType} ${row.id}`,
      path: sourcePath,
      message: `Collected ${subjectType} exposes only one embedded chapter`,
      action: 'accept the release, source chapters, or replace with a better release',
    })
  }
}

function checkAcquiringHash(
  problems: IntegrityProblem[],
  activeHashes: Set<string>,
  library: LibraryRow,
  row: { id: number | string; title?: string | null; info_hash?: string | null; status?: string | null },
  subjectType: string,
): void {
  const hash = row.info_hash?.toLowerCase()
  if (!hash || activeHashes.has(hash)) return
  addProblem(problems, {
    severity: 'warn',
    category: 'stale-acquisition',
    scope: 'tab',
    tabId: library.id,
    tabName: library.name,
    mediaType: library.media_type,
    subjectType,
    subjectId: String(row.id),
    title: row.title ?? `${subjectType} ${row.id}`,
    message: `${row.status ?? 'acquiring'} ${subjectType} references ${hash}, but no active torrent has that info hash`,
    action: 'relink to a torrent, re-search, or clear the stale acquisition',
  })
}

function scanLibrary(library: LibraryRow, activeHashes: Set<string>, problems: IntegrityProblem[], fileOwners: Map<string, FileOwner[]>): void {
  const db = getDb()

  if (library.media_type === 'films') {
    for (const row of safeRows<any>(db, "SELECT id, title, status, file_path, info_hash FROM films WHERE library_id = ? AND status = 'collected'", library.id)) {
      checkCollectedFile(problems, fileOwners, library, row, 'film')
    }
    for (const row of safeRows<any>(db, "SELECT id, title, status, info_hash FROM films WHERE library_id = ? AND status IN ('acquiring', 'downloading') AND info_hash IS NOT NULL", library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'film')
    }
  } else if (library.media_type === 'series') {
    for (const row of safeRows<any>(db, `
      SELECT e.id, s.title || ' S' || printf('%02d', e.season_number) || 'E' || printf('%02d', e.episode_number) as title,
             e.status, e.file_path, e.info_hash
      FROM episodes e JOIN series s ON s.id = e.series_id
      WHERE s.library_id = ? AND e.status = 'collected'
    `, library.id)) {
      checkCollectedFile(problems, fileOwners, library, row, 'episode')
    }
    for (const row of safeRows<any>(db, `
      SELECT e.id, s.title || ' S' || printf('%02d', e.season_number) || 'E' || printf('%02d', e.episode_number) as title,
             e.status, e.info_hash
      FROM episodes e JOIN series s ON s.id = e.series_id
      WHERE s.library_id = ? AND e.status IN ('acquiring', 'downloading') AND e.info_hash IS NOT NULL
    `, library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'episode')
    }
    for (const row of safeRows<any>(db, `
      SELECT se.id, s.title || ' S' || printf('%02d', se.season_number) as title, se.info_hash, 'acquiring' as status
      FROM seasons se JOIN series s ON s.id = se.series_id
      WHERE s.library_id = ? AND se.info_hash IS NOT NULL
    `, library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'season')
    }
  } else if (library.media_type === 'music') {
    for (const row of safeRows<any>(db, `
      SELECT tr.id, ar.name || ' - ' || tr.title as title, tr.status, tr.file_path, tr.info_hash
      FROM tracks tr JOIN artists ar ON ar.id = tr.artist_id
      WHERE ar.library_id = ? AND tr.status = 'collected'
    `, library.id)) {
      checkCollectedFile(problems, fileOwners, library, row, 'track')
    }
    for (const row of safeRows<any>(db, `
      SELECT al.id, ar.name || ' - ' || al.title as title, al.status, al.info_hash
      FROM albums al JOIN artists ar ON ar.id = al.artist_id
      WHERE ar.library_id = ? AND al.status IN ('acquiring', 'downloading') AND al.info_hash IS NOT NULL
    `, library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'album')
    }
  } else if (library.media_type === 'books') {
    for (const row of safeRows<any>(db, `
      SELECT ed.id, b.title || ' - ' || ed.format as title, ed.status, ed.file_path, b.info_hash
      FROM book_editions ed JOIN books b ON b.id = ed.book_id JOIN authors a ON a.id = b.author_id
      WHERE a.library_id = ? AND ed.status = 'collected'
    `, library.id)) {
      checkCollectedFile(problems, fileOwners, library, row, 'book-edition')
    }
    for (const row of safeRows<any>(db, `
      SELECT b.id, b.title, b.status, b.info_hash
      FROM books b JOIN authors a ON a.id = b.author_id
      WHERE a.library_id = ? AND b.status IN ('acquiring', 'downloading') AND b.info_hash IS NOT NULL
    `, library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'book')
    }
  } else if (library.media_type === 'games') {
    for (const row of safeRows<any>(db, "SELECT id, title, status, file_path, info_hash FROM games WHERE library_id = ? AND status = 'collected'", library.id)) {
      checkCollectedFile(problems, fileOwners, library, row, 'game')
    }
    for (const row of safeRows<any>(db, "SELECT id, title, status, info_hash FROM games WHERE library_id = ? AND status IN ('acquiring', 'downloading') AND info_hash IS NOT NULL", library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'game')
    }
  } else if (library.media_type === 'comics') {
    for (const row of safeRows<any>(db, `
      SELECT i.id, s.title || ' #' || i.issue_number as title, i.status, i.file_path, i.info_hash
      FROM comic_issues i JOIN comic_series s ON s.id = i.series_id
      WHERE s.library_id = ? AND i.status = 'collected'
    `, library.id)) {
      checkCollectedFile(problems, fileOwners, library, row, 'comic-issue')
    }
    for (const row of safeRows<any>(db, `
      SELECT i.id, s.title || ' #' || i.issue_number as title, i.status, i.info_hash
      FROM comic_issues i JOIN comic_series s ON s.id = i.series_id
      WHERE s.library_id = ? AND i.status IN ('acquiring', 'downloading') AND i.info_hash IS NOT NULL
    `, library.id)) {
      checkAcquiringHash(problems, activeHashes, library, row, 'comic-issue')
    }
  }
}

function scanImports(db: Database, problems: IntegrityProblem[]): void {
  for (const row of safeRows<any>(db, `
    SELECT id, tab_id, tab_name, media_type, item_id, status, source_path, error
    FROM media_imports
    WHERE status IN ('queued', 'running', 'failed')
    ORDER BY id DESC
    LIMIT 1000
  `)) {
    if (row.source_path && !existsSync(mapRemotePath(row.source_path))) {
      addProblem(problems, {
        severity: row.status === 'failed' ? 'warn' : 'error',
        category: 'missing-import-source',
        scope: 'import',
        tabId: row.tab_id ?? undefined,
        tabName: row.tab_name ?? undefined,
        mediaType: row.media_type,
        subjectType: 'media-import',
        subjectId: String(row.id),
        path: row.source_path,
        message: `Import #${row.id} source path is missing: ${row.source_path}`,
        action: 'remove/retry the import after restoring the source',
      })
    }
  }
}

function scanDownloads(activePaths: Set<string>, problems: IntegrityProblem[]): void {
  const downloadDir = resolve(process.env.TORRENT_DOWNLOAD_DIR ?? './downloads/complete')
  if (!existsSync(downloadDir)) return
  for (const name of readdirSync(downloadDir)) {
    const path = resolve(join(downloadDir, name))
    if (activePaths.has(path) || isIgnoredStagedDownload(path)) continue
    try {
      const stat = statSync(path)
      if (!stat.isFile() && !stat.isDirectory()) continue
      addProblem(problems, {
        severity: 'warn',
        category: 'orphaned-download',
        scope: 'download',
        path,
        title: name,
        message: `Download directory entry is not attached to an active torrent: ${name}`,
        action: 'manual import it, attach it to a torrent, or remove it',
      })
    } catch {
      // Ignore racing filesystem entries.
    }
  }
}

// Blocklist the dead info_hash before we clear it, so a re-search doesn't
// immediately re-grab the same gone/seederless release — matching the download
// monitor's orphan-recovery behaviour.
const STALE_SUBJECT_TABLE: Record<string, string> = {
  film: 'films', episode: 'episodes', season: 'seasons', album: 'albums',
  track: 'tracks', book: 'books', game: 'games', issue: 'comic_issues',
}
function blocklistStaleHash(problem: IntegrityProblem, db: Database, id: number): void {
  const table = problem.subjectType ? STALE_SUBJECT_TABLE[problem.subjectType] : undefined
  if (!table) return
  try {
    const row = db.prepare(`SELECT info_hash FROM ${table} WHERE id = ?`).get(id) as { info_hash?: string | null } | undefined
    if (!row?.info_hash) return
    blockRelease({
      infoHash: row.info_hash,
      releaseTitle: problem.title ?? `${problem.subjectType} ${id}`,
      reason: 'stale acquisition cleared: torrent left the download client',
      tabId: problem.tabId ?? null,
      mediaType: problem.mediaType ?? null,
      subjectType: problem.subjectType,
      subjectId: id,
    }, db)
  } catch { /* best-effort — never block the reset on blocklisting */ }
}

function clearStaleAcquisition(problem: IntegrityProblem, db: Database, opts: { backupId?: string } = {}): IntegrityRepairResult {
  const id = Number(problem.subjectId)
  if (!Number.isFinite(id)) throw new Error('problem subject id is invalid')
  let changes = 0

  blocklistStaleHash(problem, db, id)

  if (problem.subjectType === 'film') {
    changes += db.prepare(`
      UPDATE films
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
  } else if (problem.subjectType === 'episode') {
    changes += db.prepare(`
      UPDATE episodes
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
  } else if (problem.subjectType === 'season') {
    const season = db.prepare('SELECT series_id, season_number FROM seasons WHERE id = ?').get(id) as { series_id: number; season_number: number } | undefined
    if (!season) throw new Error(`season ${id} not found`)
    changes += db.prepare('UPDATE seasons SET info_hash = NULL, download_progress = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id).changes
    changes += db.prepare(`
      UPDATE episodes
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE series_id = ? AND season_number = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(season.series_id, season.season_number).changes
  } else if (problem.subjectType === 'album') {
    changes += db.prepare(`
      UPDATE albums
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
    changes += db.prepare(`
      UPDATE tracks
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE album_id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
  } else if (problem.subjectType === 'book') {
    changes += db.prepare(`
      UPDATE books
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
  } else if (problem.subjectType === 'game') {
    changes += db.prepare(`
      UPDATE games
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
  } else if (problem.subjectType === 'comic-issue') {
    changes += db.prepare(`
      UPDATE comic_issues
      SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now')
      WHERE id = ? AND status IN ('wanted', 'missing', 'acquiring', 'downloading')
    `).run(id).changes
  } else {
    throw new Error(`unsupported stale acquisition subject: ${problem.subjectType}`)
  }

  recordEvent({
    category: 'integrity',
    action: 'repaired-stale-acquisition',
    subjectType: problem.subjectType,
    subjectId: problem.subjectId,
    message: `Cleared stale acquisition for ${problem.title ?? problem.subjectType}`,
    data: { problem, changes, backupId: opts.backupId },
  }, db)

  return {
    success: true,
    action: 'clear-stale-acquisition',
    message: changes > 0 ? `Cleared stale acquisition state (${changes} row${changes === 1 ? '' : 's'} updated)` : 'No matching stale acquisition state was changed',
    changes,
    backupId: opts.backupId,
  }
}

function pruneMissingImport(problem: IntegrityProblem, db: Database, opts: { backupId?: string } = {}): IntegrityRepairResult {
  const id = Number(problem.subjectId)
  if (!Number.isFinite(id)) throw new Error('problem subject id is invalid')
  const row = db.prepare('SELECT id, source_path FROM media_imports WHERE id = ?').get(id) as { id: number; source_path: string } | undefined
  if (!row) {
    return { success: true, action: 'prune-missing-import', message: 'Import record was already removed', changes: 0, backupId: opts.backupId }
  }

  const sourcePath = problem.path ?? row.source_path
  const deletedImports = db.prepare('DELETE FROM media_imports WHERE id = ?').run(id).changes
  let deletedJobs = 0
  const jobs = db.prepare("SELECT id, payload FROM system_jobs WHERE type = 'media-import'").all() as Array<{ id: number; payload: string }>
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload || '{}') as { sourcePath?: string }
      if (payload.sourcePath && resolve(payload.sourcePath) === resolve(sourcePath)) {
        deletedJobs += db.prepare('DELETE FROM system_jobs WHERE id = ?').run(job.id).changes
      }
    } catch {
      // Ignore malformed historical payloads.
    }
  }

  const changes = deletedImports + deletedJobs
  recordEvent({
    category: 'integrity',
    action: 'pruned-missing-import',
    subjectType: 'media-import',
    subjectId: String(id),
    message: `Pruned missing import source ${sourcePath}`,
    data: { problem, deletedImports, deletedJobs, backupId: opts.backupId },
  }, db)

  return {
    success: true,
    action: 'prune-missing-import',
    message: `Removed ${deletedImports} import record${deletedImports === 1 ? '' : 's'} and ${deletedJobs} queued job${deletedJobs === 1 ? '' : 's'}`,
    changes,
    backupId: opts.backupId,
  }
}

function removeOrphanedDownload(problem: IntegrityProblem, db: Database, opts: { backupId?: string } = {}): IntegrityRepairResult {
  if (!problem.path) throw new Error('orphaned download problem has no path')
  const downloadDir = resolve(process.env.TORRENT_DOWNLOAD_DIR ?? './downloads/complete')
  const targetPath = resolve(problem.path)
  if (targetPath !== downloadDir && !targetPath.startsWith(`${downloadDir}/`)) {
    throw new Error(`refusing to remove path outside download directory: ${targetPath}`)
  }
  if (!existsSync(targetPath)) {
    return {
      success: true,
      action: 'remove-orphaned-download',
      message: 'Orphaned download was already removed',
      changes: 0,
      backupId: opts.backupId,
    }
  }

  const stat = statSync(targetPath)
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`refusing to remove unsupported filesystem entry: ${targetPath}`)
  }

  const bytes = stat.isFile() ? stat.size : directorySize(targetPath)
  rmSync(targetPath, { recursive: stat.isDirectory(), force: true })
  recordEvent({
    category: 'integrity',
    action: 'removed-orphaned-download',
    subjectType: 'download',
    subjectId: problem.title ?? targetPath,
    message: `Removed orphaned download ${problem.title ?? targetPath}`,
    data: { problem, path: targetPath, bytes, backupId: opts.backupId },
  }, db)

  return {
    success: true,
    action: 'remove-orphaned-download',
    message: `Removed orphaned download ${problem.title ?? targetPath}`,
    changes: 1,
    backupId: opts.backupId,
  }
}

function directorySize(path: string): number {
  let total = 0
  for (const name of readdirSync(path)) {
    const child = resolve(path, name)
    try {
      const stat = statSync(child)
      if (stat.isDirectory()) total += directorySize(child)
      else if (stat.isFile()) total += stat.size
    } catch {
      // Ignore racing filesystem entries during best-effort accounting.
    }
  }
  return total
}

export function repairIntegrityProblem(problem: IntegrityProblem, db: Database = getDb(), opts: { backupId?: string } = {}): IntegrityRepairResult {
  if (problem.category === 'stale-acquisition') return clearStaleAcquisition(problem, db, opts)
  if (problem.category === 'missing-import-source') return pruneMissingImport(problem, db, opts)
  if (problem.category === 'orphaned-download') return removeOrphanedDownload(problem, db, opts)
  throw new Error(`No repair action is available for ${problem.category}`)
}

export function bulkRepairIntegrityProblems(problems: IntegrityProblem[], db: Database = getDb(), opts: { backupId?: string } = {}): BulkIntegrityRepairResult {
  const results: IntegrityRepairResult[] = []
  let skipped = 0
  for (const problem of problems) {
    try {
      if (problem.category !== 'stale-acquisition' && problem.category !== 'missing-import-source' && problem.category !== 'orphaned-download') {
        skipped += 1
        continue
      }
      results.push(repairIntegrityProblem(problem, db, opts))
    } catch (err) {
      results.push({
        success: false,
        action: 'repair-failed',
        message: err instanceof Error ? err.message : String(err),
        changes: 0,
        backupId: opts.backupId,
      })
    }
  }

  return {
    requested: problems.length,
    repaired: results.filter(r => r.success).length,
    skipped,
    changes: results.reduce((sum, result) => sum + result.changes, 0),
    results,
  }
}

export function scanDataIntegrity(db: Database = getDb()): IntegrityReport {
  const problems: IntegrityProblem[] = []
  const fileOwners = new Map<string, FileOwner[]>()
  const libraries = safeRows<LibraryRow>(db, 'SELECT id, name, media_type, db_path FROM libraries ORDER BY id ASC')

  let activeHashes = new Set<string>()
  let activePaths = new Set<string>()
  try {
    const torrents = getTorrentSession().getAllTorrents() as Array<{ infoHash?: string; downloadDir: string; name: string }>
    activeHashes = new Set(torrents.map(t => t.infoHash?.toLowerCase()).filter((h): h is string => !!h))
    activePaths = new Set(torrents.map(t => resolve(join(t.downloadDir, t.name))))
  } catch {
    addProblem(problems, {
      severity: 'warn',
      category: 'torrent-session-unavailable',
      scope: 'system',
      message: 'Torrent session is not available during integrity scan',
      action: 'restart the torrent engine or check startup logs',
    })
  }

  for (const library of libraries) {
    try {
      scanLibrary(library, activeHashes, problems, fileOwners)
    } catch (err) {
      addProblem(problems, {
        severity: 'error',
        category: 'tab-scan-failed',
        scope: 'tab',
        tabId: library.id,
        tabName: library.name,
        mediaType: library.media_type,
        message: `Integrity scan failed for ${library.name}: ${err instanceof Error ? err.message : String(err)}`,
        action: 'inspect this library database',
      })
    }
  }

  for (const [path, owners] of fileOwners) {
    if (owners.length <= 1) continue
    addProblem(problems, {
      severity: 'warn',
      category: 'duplicate-file-owner',
      scope: 'system',
      path,
      message: `File is claimed by ${owners.length} collected library items: ${basename(path)}`,
      action: 'review duplicate library records',
    })
  }

  scanImports(db, problems)
  scanDownloads(activePaths, problems)

  const bySeverity: Record<IntegritySeverity, number> = { info: 0, warn: 0, error: 0 }
  const byCategory: Record<string, number> = {}
  for (const problem of problems) {
    bySeverity[problem.severity] += 1
    byCategory[problem.category] = (byCategory[problem.category] ?? 0) + 1
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: problems.length,
      bySeverity,
      byCategory,
    },
    problems,
  }
}

export function runIntegrityScan(db: Database = getDb(), config = getIntegrityConfig(db)): IntegrityReport {
  const report = scanDataIntegrity(db)
  setAppSetting('lastIntegrityReport', report, 0, db)

  if (report.summary.total > 0 || config.recordCleanScans) {
    const severity = report.summary.bySeverity.error > 0 ? 'error' : report.summary.bySeverity.warn > 0 ? 'warn' : 'info'
    recordEvent({
      category: 'integrity',
      action: 'scan-completed',
      severity,
      message: `Integrity scan found ${report.summary.total} problem${report.summary.total === 1 ? '' : 's'}`,
      data: report.summary,
    }, db)
  }

  return report
}

export function registerIntegrityJobs(): void {
  registerJobHandler('integrity-scan', async () => {
    runIntegrityScan()
  })
}

export function startIntegrityScheduler(db: Database = getDb(), pollMs = 15 * 60_000): void {
  if (scheduler) return
  const tick = () => {
    try {
      const config = getIntegrityConfig(db)
      if (!config.enabled) return
      const last = getLastIntegrityReport(db)
      const lastAt = last?.generatedAt ? new Date(last.generatedAt).getTime() : 0
      if (Date.now() - lastAt < config.intervalHours * 60 * 60_000) return
      enqueueUniqueJob({
        type: 'integrity-scan',
        subjectType: 'system',
        subjectId: 'integrity',
        payload: { scheduled: true },
        maxAttempts: 2,
      }, db)
    } catch (err) {
      recordEvent({
        category: 'integrity',
        action: 'scheduler-error',
        severity: 'warn',
        message: err instanceof Error ? err.message : String(err),
      }, db)
    }
  }
  scheduler = setInterval(tick, pollMs)
  scheduler.unref?.()
  tick()
}

export function stopIntegrityScheduler(): void {
  if (scheduler) clearInterval(scheduler)
  scheduler = null
}
