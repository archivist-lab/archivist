import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { enqueueLoudness } from '../player/loudness.js'
import { registerJobHandler } from '../system/job-runner.js'
import { enqueueUniqueJob, recordEvent, type JobRecord } from '../system/event-store.js'
import { getTorrentSession } from './torrent-session.js'
import { getExternalTorrentController, getExternalTorrentFiles } from './external-downloads.js'
import { getTrackCleanerConfig, cleanTracks, probeChapters, type ChapterProbeResult } from './media-processor.js'
import { autoAcquireSubtitle } from './subtitle-provider.js'
import { getMovie } from '../domains/films/tmdb.js'
import { getSeriesEpisodesTmdb } from '../domains/series/tvdb.js'
import { organizeFilm, organizeEpisode, organizeGame, organizeBook, organizeComicIssue, organizeMusic, mapRemotePath, getFilmFileInfo } from '../shared/media-organizer.js'
import { resolveLibraryRoot } from '../shared/library-paths.js'
import { buildQualitySnapshot } from './quality.js'

const logger = createLogger('MediaImports')

async function probeChaptersSafe(filePath: string): Promise<ChapterProbeResult | null> {
  try {
    return await probeChapters(filePath)
  } catch {
    return null
  }
}

function validateImportedVideoFile(
  mediaLabel: string,
  filePath: string,
  chaptersBeforeProcessing: ChapterProbeResult | null,
  chaptersAfterProcessing: ChapterProbeResult | null,
) {
  const errors: string[] = []
  const warnings: string[] = []
  const info = getFilmFileInfo(filePath)

  if (!existsSync(filePath)) {
    errors.push(`Imported ${mediaLabel} file is missing: ${filePath}`)
  } else {
    const size = statSync(filePath).size
    if (size < 50 * 1024 * 1024) {
      errors.push(`Imported ${mediaLabel} file is unexpectedly small: ${size} bytes`)
    }
  }

  if (!info) {
    errors.push(`Imported ${mediaLabel} file could not be probed`)
  } else {
    const tracks = info.tracks ?? []
    const primaryVideo = tracks.filter(track => track.type === 'video' && (track.codec ?? '').toLowerCase() !== 'mjpeg')
    const audio = tracks.filter(track => track.type === 'audio')
    const embeddedSubs = tracks.filter(track => track.type === 'subtitle')
    const externalSubs = info.externalSubtitles ?? []

    if (primaryVideo.length === 0) errors.push(`Imported ${mediaLabel} file has no primary video stream`)
    if (audio.length === 0) errors.push(`Imported ${mediaLabel} file has no audio stream`)
    if (embeddedSubs.length === 0 && externalSubs.length === 0) warnings.push(`Imported ${mediaLabel} file has no embedded or external subtitles`)
  }

  const chapterCountBefore = chaptersBeforeProcessing?.count ?? null
  const chapterCountAfter = chaptersAfterProcessing?.count ?? null
  if (chapterCountBefore !== null && chapterCountAfter !== null && chapterCountAfter < chapterCountBefore) {
    errors.push(`Chapter count dropped from ${chapterCountBefore} to ${chapterCountAfter}`)
  } else if (chapterCountAfter === 0) {
    warnings.push(`Imported ${mediaLabel} file has no embedded chapters`)
  } else if (chapterCountAfter === 1) {
    warnings.push(`Imported ${mediaLabel} file has only one embedded chapter`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      path: filePath,
      size: info?.size ?? (existsSync(filePath) ? statSync(filePath).size : 0),
      resolution: info?.resolution ?? null,
      codec: info?.codec ?? null,
      audioTracks: info?.tracks?.filter(track => track.type === 'audio').length ?? 0,
      subtitleTracks: info?.tracks?.filter(track => track.type === 'subtitle').length ?? 0,
      externalSubtitles: info?.externalSubtitles?.length ?? 0,
      chapterCountBefore,
      chapterCountAfter,
      firstChapter: chaptersAfterProcessing?.chapters[0] ?? null,
    },
  }
}

function collectAssetFiles(rootPath: string): Array<{ path: string; size: number; extension: string }> {
  if (!existsSync(rootPath)) return []
  const stats = statSync(rootPath)
  if (stats.isFile()) return [{ path: rootPath, size: stats.size, extension: extname(rootPath).toLowerCase() }]
  if (!stats.isDirectory()) return []
  const files: Array<{ path: string; size: number; extension: string }> = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) {
        const fileStats = statSync(fullPath)
        files.push({ path: fullPath, size: fileStats.size, extension: extname(entry.name).toLowerCase() })
      }
    }
  }
  walk(rootPath)
  return files
}

function validateImportedAsset(mediaLabel: string, targetPath: string, opts: { allowedExtensions?: string[]; minBytes?: number; allowDirectory?: boolean }) {
  const errors: string[] = []
  const warnings: string[] = []
  const files = collectAssetFiles(targetPath)
  const allowed = new Set((opts.allowedExtensions ?? []).map(ext => ext.toLowerCase()))
  const minBytes = opts.minBytes ?? 1

  if (!existsSync(targetPath)) {
    errors.push(`Imported ${mediaLabel} target is missing: ${targetPath}`)
  } else if (!opts.allowDirectory && statSync(targetPath).isDirectory()) {
    errors.push(`Imported ${mediaLabel} target is a directory but a file was expected`)
  }

  const matchingFiles = allowed.size > 0 ? files.filter(file => allowed.has(file.extension)) : files
  if (matchingFiles.length === 0) {
    errors.push(allowed.size > 0
      ? `Imported ${mediaLabel} target contains no expected files (${Array.from(allowed).join(', ')})`
      : `Imported ${mediaLabel} target contains no files`)
  }

  const tinyFiles = matchingFiles.filter(file => file.size < minBytes)
  if (tinyFiles.length > 0) {
    errors.push(`Imported ${mediaLabel} has ${tinyFiles.length} unexpectedly small file${tinyFiles.length === 1 ? '' : 's'}`)
  }

  const totalBytes = matchingFiles.reduce((sum, file) => sum + file.size, 0)
  if (files.length > matchingFiles.length && allowed.size > 0) {
    warnings.push(`Imported ${mediaLabel} target also contains ${files.length - matchingFiles.length} non-primary file${files.length - matchingFiles.length === 1 ? '' : 's'}`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      path: targetPath,
      fileCount: files.length,
      matchingFileCount: matchingFiles.length,
      totalBytes,
      largestFileBytes: matchingFiles.reduce((max, file) => Math.max(max, file.size), 0),
      extensions: Array.from(new Set(matchingFiles.map(file => file.extension))).sort(),
    },
  }
}

function recordAssetValidation(
  payload: MediaImportPayload,
  mediaLabel: string,
  subjectId: string,
  sourcePath: string,
  targetPath: string,
  validation: ReturnType<typeof validateImportedAsset>,
): void {
  recordEvent({
    category: 'import',
    action: 'import-validation',
    severity: validation.errors.length > 0 ? 'error' : validation.warnings.length > 0 ? 'warn' : 'info',
    subjectType: payload.mediaType,
    subjectId,
    message: validation.errors.length > 0
      ? `Imported ${mediaLabel} failed validation: ${validation.errors.join('; ')}`
      : validation.warnings.length > 0
        ? `Imported ${mediaLabel} has validation warnings: ${validation.warnings.join('; ')}`
        : `Imported ${mediaLabel} passed validation`,
    data: {
      sourcePath,
      destinationPath: targetPath,
      errors: validation.errors,
      warnings: validation.warnings,
      summary: validation.summary,
    },
  })
  if (!validation.ok) {
    throw new Error(`Imported ${mediaLabel} failed validation: ${validation.errors.join('; ')}`)
  }
}

async function validateImportedVideo(
  payload: MediaImportPayload,
  mediaLabel: string,
  subjectId: string,
  sourcePath: string,
  finalPath: string,
  chaptersBeforeProcessing: ChapterProbeResult | null,
): Promise<void> {
  const chaptersAfterProcessing = await probeChaptersSafe(finalPath)
  const validation = validateImportedVideoFile(mediaLabel, finalPath, chaptersBeforeProcessing, chaptersAfterProcessing)
  recordEvent({
    category: 'import',
    action: 'import-validation',
    severity: validation.errors.length > 0 ? 'error' : validation.warnings.length > 0 ? 'warn' : 'info',
    subjectType: payload.mediaType,
    subjectId,
    message: validation.errors.length > 0
      ? `Imported ${mediaLabel} failed validation: ${validation.errors.join('; ')}`
      : validation.warnings.length > 0
        ? `Imported ${mediaLabel} has validation warnings: ${validation.warnings.join('; ')}`
        : `Imported ${mediaLabel} passed validation`,
    data: {
      sourcePath,
      destinationPath: finalPath,
      errors: validation.errors,
      warnings: validation.warnings,
      summary: validation.summary,
    },
  })
  if (!validation.ok) {
    throw new Error(`Imported ${mediaLabel} failed validation: ${validation.errors.join('; ')}`)
  }
}

export type ImportMediaType = 'films' | 'series' | 'music' | 'books' | 'games' | 'comics'
export type MatchMediaType =
  | ImportMediaType
  | 'series-season'
  | 'series-episode'
  | 'music-album'
  | 'music-discography'
  | 'books'
  | 'comics-issue'
  | 'comics-volume'

export interface MediaImportPayload {
  tabId: number
  tabName: string
  dbPath: string
  mediaType: MatchMediaType
  itemId: number
  torrentId: string
  infoHash: string
  sourcePath: string
  copy?: boolean
  expectedVersion?: string | null
  releaseTitle?: string | null
}

export interface TorrentMatchOverride {
  torrentId?: string | null
  infoHash?: string | null
  sourcePath?: string | null
  name?: string | null
  tabId: number
  tabName: string
  dbPath: string
  mediaType: MatchMediaType
  itemId: number
  title: string
  subtitle?: string | null
  status?: string | null
  score?: number
}

export interface ImportPlanFile {
  path: string
  name: string
  sizeBytes: number
  role: 'primary' | 'extra' | 'track' | 'issue' | 'ignored' | 'unmatched'
  target?: string | null
  reason?: string | null
}

export interface ImportPlan {
  status: 'ready' | 'needs-review' | 'blocked'
  mediaType: MatchMediaType
  itemId: number
  sourcePath: string
  summary: string
  files: ImportPlanFile[]
  ignored: ImportPlanFile[]
  warnings: string[]
  errors: string[]
}

let migrated = false
const importLocks = new Set<string>()

export function initMediaImportStore(db: Database = getDb()): void {
  if (migrated) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      tab_id INTEGER,
      tab_name TEXT,
      db_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      torrent_id TEXT,
      info_hash TEXT,
      source_path TEXT NOT NULL,
      destination_path TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      copy INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      payload TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_media_imports_status ON media_imports(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_media_imports_item ON media_imports(media_type, item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_imports_torrent ON media_imports(info_hash, torrent_id);

    CREATE TABLE IF NOT EXISTS ignored_staged_downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'removed'
    );

    CREATE TABLE IF NOT EXISTS torrent_match_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      torrent_id TEXT,
      info_hash TEXT,
      source_path TEXT,
      name TEXT,
      tab_id INTEGER NOT NULL,
      tab_name TEXT NOT NULL,
      db_path TEXT NOT NULL,
      media_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      status TEXT,
      score INTEGER NOT NULL DEFAULT 100
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_torrent_match_overrides_info_hash
      ON torrent_match_overrides(info_hash)
      WHERE info_hash IS NOT NULL AND info_hash != '';
    CREATE INDEX IF NOT EXISTS idx_torrent_match_overrides_torrent ON torrent_match_overrides(torrent_id);
    CREATE INDEX IF NOT EXISTS idx_torrent_match_overrides_source ON torrent_match_overrides(source_path);
  `)
  migrated = true
}

export function baseImportMediaType(mediaType: MatchMediaType): ImportMediaType {
  if (mediaType.startsWith('series')) return 'series'
  if (mediaType.startsWith('music')) return 'music'
  if (mediaType.startsWith('comics')) return 'comics'
  return mediaType as ImportMediaType
}

function normaliseSourcePath(sourcePath?: string | null) {
  return sourcePath ? resolve(sourcePath) : null
}

function mapMatchRow(row: any): (TorrentMatchOverride & { createdAt: string; updatedAt: string }) | null {
  if (!row) return null
  return {
    torrentId: row.torrent_id,
    infoHash: row.info_hash,
    sourcePath: row.source_path,
    name: row.name,
    tabId: Number(row.tab_id),
    tabName: row.tab_name,
    dbPath: row.db_path,
    mediaType: row.media_type,
    itemId: Number(row.item_id),
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    score: Number(row.score ?? 100),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getTorrentMatchOverride(
  input: { torrentId?: string | null; infoHash?: string | null; sourcePath?: string | null },
  db: Database = getDb(),
) {
  initMediaImportStore(db)
  const sourcePath = normaliseSourcePath(input.sourcePath)
  const row = db.prepare(`
    SELECT *
    FROM torrent_match_overrides
    WHERE (? IS NOT NULL AND info_hash = ?)
       OR (? IS NOT NULL AND torrent_id = ?)
       OR (? IS NOT NULL AND source_path IN (?, ?))
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(
    input.infoHash ?? null, input.infoHash ?? null,
    input.torrentId ?? null, input.torrentId ?? null,
    input.sourcePath ?? null, input.sourcePath ?? null, sourcePath,
  )
  return mapMatchRow(row)
}

export function setTorrentMatchOverride(match: TorrentMatchOverride, db: Database = getDb()) {
  initMediaImportStore(db)
  const sourcePath = normaliseSourcePath(match.sourcePath)
  const existing = getTorrentMatchOverride({ torrentId: match.torrentId, infoHash: match.infoHash, sourcePath }, db)
  const values = [
    match.torrentId ?? null,
    match.infoHash ?? null,
    sourcePath,
    match.name ?? null,
    match.tabId,
    match.tabName,
    match.dbPath,
    match.mediaType,
    String(match.itemId),
    match.title,
    match.subtitle ?? null,
    match.status ?? null,
    Math.max(0, Math.min(100, Math.round(match.score ?? 100))),
  ] as const

  if (existing) {
    db.prepare(`
      UPDATE torrent_match_overrides
      SET torrent_id = ?, info_hash = ?, source_path = ?, name = ?, tab_id = ?, tab_name = ?,
          db_path = ?, media_type = ?, item_id = ?, title = ?, subtitle = ?, status = ?,
          score = ?, updated_at = datetime('now')
      WHERE id = (SELECT id FROM torrent_match_overrides
        WHERE (? IS NOT NULL AND info_hash = ?)
           OR (? IS NOT NULL AND torrent_id = ?)
           OR (? IS NOT NULL AND source_path IN (?, ?))
        ORDER BY updated_at DESC, id DESC
        LIMIT 1)
    `).run(
      ...values,
      match.infoHash ?? null, match.infoHash ?? null,
      match.torrentId ?? null, match.torrentId ?? null,
      match.sourcePath ?? null, match.sourcePath ?? null, sourcePath,
    )
  } else {
    db.prepare(`
      INSERT INTO torrent_match_overrides (
        torrent_id, info_hash, source_path, name, tab_id, tab_name, db_path,
        media_type, item_id, title, subtitle, status, score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values)
  }

  return getTorrentMatchOverride({ torrentId: match.torrentId, infoHash: match.infoHash, sourcePath }, db)
}

export function queueMediaImport(payload: MediaImportPayload): number | null {
  const db = getDb()
  initMediaImportStore(db)
  const jobId = enqueueUniqueJob({
    type: 'media-import',
    subjectType: payload.mediaType,
    subjectId: `${payload.itemId}:${payload.infoHash}`,
    payload,
    maxAttempts: 3,
  }, db)
  if (!jobId) return null

  db.prepare(`
    INSERT INTO media_imports (
      tab_id, tab_name, db_path, media_type, item_id, torrent_id, info_hash, source_path, copy, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.tabId,
    payload.tabName,
    payload.dbPath,
    payload.mediaType,
    String(payload.itemId),
    payload.torrentId,
    payload.infoHash,
    payload.sourcePath,
    payload.copy ? 1 : 0,
    JSON.stringify(payload),
  )

  recordEvent({
    category: 'import',
    action: 'queued',
    subjectType: payload.mediaType,
    subjectId: String(payload.itemId),
    message: `Queued ${payload.mediaType} import from ${basename(payload.sourcePath)}`,
    data: { jobId, sourcePath: payload.sourcePath, infoHash: payload.infoHash },
  }, db)
  return jobId
}

export function listMediaImports(limit = 200, db: Database = getDb()) {
  initMediaImportStore(db)
  return db.prepare(`
    SELECT * FROM media_imports
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 1000)))
}

export function ignoreStagedDownload(sourcePath: string, reason = 'removed', db: Database = getDb()): void {
  initMediaImportStore(db)
  const resolved = resolve(sourcePath)
  db.prepare(`
    INSERT INTO ignored_staged_downloads (source_path, name, reason)
    VALUES (?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET reason = excluded.reason
  `).run(resolved, basename(resolved), reason)
}

export function isIgnoredStagedDownload(sourcePath: string, db: Database = getDb()): boolean {
  initMediaImportStore(db)
  return !!db.prepare('SELECT id FROM ignored_staged_downloads WHERE source_path = ?').get(resolve(sourcePath))
}

export function purgeMediaImportReferences(input: { torrentId?: string | null; infoHash?: string | null; sourcePath?: string | null }, db: Database = getDb()): void {
  initMediaImportStore(db)
  const sourcePath = input.sourcePath ? resolve(input.sourcePath) : null
  db.prepare(`
    DELETE FROM torrent_match_overrides
    WHERE (? IS NOT NULL AND torrent_id = ?)
       OR (? IS NOT NULL AND info_hash = ?)
       OR (? IS NOT NULL AND source_path IN (?, ?))
  `).run(
    input.torrentId ?? null, input.torrentId ?? null,
    input.infoHash ?? null, input.infoHash ?? null,
    input.sourcePath ?? null, input.sourcePath ?? null, sourcePath,
  )

  db.prepare(`
    DELETE FROM media_imports
    WHERE (? IS NOT NULL AND torrent_id = ?)
       OR (? IS NOT NULL AND info_hash = ?)
       OR (? IS NOT NULL AND source_path IN (?, ?))
  `).run(
    input.torrentId ?? null, input.torrentId ?? null,
    input.infoHash ?? null, input.infoHash ?? null,
    input.sourcePath ?? null, input.sourcePath ?? null, sourcePath,
  )

  const jobs = db.prepare(`
    SELECT id, payload
    FROM system_jobs
    WHERE type = 'media-import'
  `).all() as Array<{ id: number; payload: string }>
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload || '{}') as MediaImportPayload
      const sameTorrent = input.torrentId && payload.torrentId === input.torrentId
      const sameHash = input.infoHash && payload.infoHash === input.infoHash
      const sameSource = sourcePath && payload.sourcePath && resolve(payload.sourcePath) === sourcePath
      if (sameTorrent || sameHash || sameSource) db.prepare('DELETE FROM system_jobs WHERE id = ?').run(job.id)
    } catch {}
  }
}

export function registerMediaImportJobs(): void {
  initMediaImportStore()
  registerJobHandler('media-import', async job => {
    await runMediaImportJob(job)
  })
}

function parsePayload(job: JobRecord): MediaImportPayload {
  const parsed = JSON.parse(job.payload || '{}') as MediaImportPayload
  if (!parsed.mediaType || !parsed.dbPath || !parsed.sourcePath || !parsed.itemId) {
    throw new Error(`Invalid media-import payload for job ${job.id}`)
  }
  return parsed
}

function updateImport(payload: MediaImportPayload, status: string, fields: { destinationPath?: string; error?: string; attempts?: number } = {}) {
  const db = getDb()
  initMediaImportStore(db)
  db.prepare(`
    UPDATE media_imports
    SET status = ?,
        destination_path = COALESCE(?, destination_path),
        error = ?,
        attempts = CASE WHEN ? IS NULL THEN attempts ELSE ? END,
        updated_at = datetime('now')
    WHERE media_type = ?
      AND item_id = ?
      AND info_hash = ?
      AND status IN ('queued', 'running', 'failed')
  `).run(
    status,
    fields.destinationPath ?? null,
    fields.error ?? null,
    fields.attempts ?? null,
    fields.attempts ?? null,
    payload.mediaType,
    String(payload.itemId),
    payload.infoHash,
  )
}

function simpleKey(value: string | null | undefined) {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v', '.mov'])
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg'])
const BOOK_EXTS = new Set(['.epub', '.mobi', '.azw3', '.pdf', '.m4b', '.mp3', '.flac'])
const COMIC_EXTS = new Set(['.cbz', '.cbr', '.pdf'])

function fileRole(path: string) {
  const name = basename(path).toLowerCase()
  if (name.endsWith('.part') || name.includes('.part.')) return { ignored: false, reason: 'partial file' }
  if (name.includes('sample')) return { ignored: true, reason: 'sample' }
  if (name === 'info.txt' || name.endsWith('.nfo') || name.endsWith('.sfv') || name.endsWith('.txt')) return { ignored: true, reason: 'metadata' }
  if (/\b(screenshot|screens|proof)\b/i.test(name)) return { ignored: true, reason: 'proof/screenshot' }
  return { ignored: false, reason: null }
}

function cleanTorrentFileName(name: string) {
  return name.replace(/\\/g, '/').replace(/\.part$/i, '')
}

function collectFiles(sourcePath: string, torrentFiles?: Array<{ name: string; wanted?: boolean }>): ImportPlanFile[] {
  const root = mapRemotePath(sourcePath)
  if (!existsSync(root)) return []
  const wantedByName = new Map((torrentFiles ?? []).map(f => [cleanTorrentFileName(f.name), f.wanted !== false]))
  const out: ImportPlanFile[] = []
  const addFile = (path: string) => {
    const stat = statSync(path)
    const rel = cleanTorrentFileName(relative(root, path))
    const wanted = wantedByName.size === 0 ? true : wantedByName.get(rel) ?? wantedByName.get(cleanTorrentFileName(basename(path))) ?? true
    if (!wanted) {
      out.push({
        path,
        name: basename(path),
        sizeBytes: stat.size,
        role: 'ignored',
        reason: 'not selected',
      })
      return
    }
    const role = fileRole(path)
    out.push({
      path,
      name: basename(path),
      sizeBytes: stat.size,
      role: role.ignored ? 'ignored' : 'unmatched',
      reason: role.reason,
    })
  }
  const walk = (path: string) => {
    const stat = statSync(path)
    if (stat.isFile()) {
      addFile(path)
      return
    }
    for (const entry of readdirSync(path)) {
      try { walk(join(path, entry)) } catch {}
    }
  }
  walk(root)
  return out
}

function finishPlan(mediaType: MatchMediaType, itemId: number, sourcePath: string, files: ImportPlanFile[], warnings: string[], errors: string[]): ImportPlan {
  const selected = files.filter(f => f.role !== 'ignored' && f.role !== 'unmatched')
  const ignored = files.filter(f => f.role === 'ignored')
  const unmatched = files.filter(f => f.role === 'unmatched')
  const status: ImportPlan['status'] = errors.length > 0 ? 'blocked' : warnings.length > 0 || unmatched.length > 0 ? 'needs-review' : 'ready'
  const summary = errors[0] ?? `${selected.length} file${selected.length === 1 ? '' : 's'} mapped, ${ignored.length} ignored${unmatched.length ? `, ${unmatched.length} unmatched` : ''}`
  return { status, mediaType, itemId, sourcePath, summary, files: selected, ignored: [...ignored, ...unmatched], warnings, errors }
}

function codeForEpisode(season: number, episode: number) {
  return `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
}

function matchEpisodePlanFile(files: ImportPlanFile[], season: number, episode: number) {
  const code = codeForEpisode(season, episode)
  return files.find(f => f.role === 'unmatched' && VIDEO_EXTS.has(extname(f.name).toLowerCase()) && f.name.toLowerCase().includes(code))
}

function issueMatches(name: string, issueNumber: string | number, title?: string | null) {
  const key = simpleKey(name)
  const issue = String(issueNumber).replace(/^0+/, '')
  const padded = issue.padStart(2, '0')
  return key.includes(`issue${issue}`) || key.includes(`issue${padded}`) || key.includes(`number${issue}`) || key.includes(`no${issue}`) || (!!title && key.includes(simpleKey(title)))
}

export function createImportPlan(
  payload: MediaImportPayload,
  db: Database,
  sourcePath = payload.sourcePath,
  torrentFiles?: Array<{ name: string; wanted?: boolean }>,
): ImportPlan {
  const files = collectFiles(sourcePath, torrentFiles)
  const warnings: string[] = []
  const errors: string[] = []
  if (!existsSync(mapRemotePath(sourcePath))) errors.push(`Source path not found: ${sourcePath}`)
  if (files.some(f => f.reason === 'partial file')) errors.push('Download still contains partial files')

  const available = files.filter(f => f.role === 'unmatched')
  if (available.length === 0 && errors.length === 0) errors.push('No importable files found')

  if (payload.mediaType === 'films') {
    const videos = available.filter(f => VIDEO_EXTS.has(extname(f.name).toLowerCase()))
    const main = videos.filter(f => !/\b(trailer|teaser)\b/i.test(f.name)).sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
    if (!main) errors.push('No primary video file found')
    else {
      main.role = 'primary'
      main.target = payload.releaseTitle ?? null
      for (const f of videos) {
        if (f === main) continue
        f.role = /\b(trailer|teaser)\b/i.test(f.name) ? 'ignored' : 'extra'
        f.reason = f.role === 'ignored' ? 'trailer' : null
      }
    }
  } else if (payload.mediaType === 'series-episode' || payload.mediaType === 'series') {
    const ep = db.prepare('SELECT e.*, s.title as series_title FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?').get(payload.itemId) as any
    if (ep) {
      const match = matchEpisodePlanFile(available, ep.season_number, ep.episode_number) ?? (available.length === 1 && VIDEO_EXTS.has(extname(available[0]!.name).toLowerCase()) ? available[0] : null)
      if (!match) errors.push(`No file matched S${String(ep.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`)
      else {
        match.role = 'primary'
        match.target = `${ep.series_title} ${codeForEpisode(ep.season_number, ep.episode_number).toUpperCase()}`
      }
    } else if (payload.mediaType === 'series') {
      const episodes = db.prepare('SELECT e.*, s.title as series_title FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.series_id = ? AND e.status != ? ORDER BY e.season_number, e.episode_number').all(payload.itemId, 'collected') as any[]
      let matched = 0
      for (const epRow of episodes) {
        const match = matchEpisodePlanFile(available, epRow.season_number, epRow.episode_number)
        if (!match) continue
        match.role = 'primary'
        match.target = `${epRow.series_title} ${codeForEpisode(epRow.season_number, epRow.episode_number).toUpperCase()}`
        matched += 1
      }
      if (matched === 0) errors.push('No episode files matched this series')
      else if (matched < episodes.length) warnings.push(`${episodes.length - matched} expected episode(s) were not matched`)
    } else {
      errors.push(`Episode ${payload.itemId} not found`)
    }
  } else if (payload.mediaType === 'series-season') {
    const season = db.prepare('SELECT se.*, s.title as series_title FROM seasons se JOIN series s ON s.id = se.series_id WHERE se.id = ?').get(payload.itemId) as any
    if (!season) errors.push(`Season ${payload.itemId} not found`)
    else {
      const episodes = db.prepare('SELECT * FROM episodes WHERE series_id = ? AND season_number = ? AND status != ? ORDER BY episode_number').all(season.series_id, season.season_number, 'collected') as any[]
      let matched = 0
      for (const ep of episodes) {
        const match = matchEpisodePlanFile(available, ep.season_number, ep.episode_number)
        if (!match) continue
        match.role = 'primary'
        match.target = `${season.series_title} ${codeForEpisode(ep.season_number, ep.episode_number).toUpperCase()}`
        matched += 1
      }
      if (matched === 0) errors.push(`No files matched season ${season.season_number}`)
      else if (matched < episodes.length) warnings.push(`${episodes.length - matched} expected episode(s) were not matched`)
    }
  } else if (payload.mediaType === 'music' || payload.mediaType === 'music-album') {
    const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY track_number').all(payload.itemId) as any[]
    const audio = available.filter(f => AUDIO_EXTS.has(extname(f.name).toLowerCase()))
    let matched = 0
    for (const track of tracks) {
      const match = audio.find(f => f.role === 'unmatched' && (simpleKey(f.name).includes(simpleKey(track.title)) || f.name.includes(String(track.track_number).padStart(2, '0'))))
      if (!match) continue
      match.role = 'track'
      match.target = `${String(track.track_number).padStart(2, '0')} - ${track.title}`
      matched += 1
    }
    if (matched === 0) errors.push('No audio tracks matched this album')
    else if (matched < tracks.length) warnings.push(`${tracks.length - matched} album track(s) were not matched`)
  } else if (payload.mediaType === 'music-discography') {
    const albums = db.prepare('SELECT * FROM albums WHERE artist_id = ? AND status != ? ORDER BY year, title').all(payload.itemId, 'collected') as any[]
    let matched = 0
    for (const album of albums) {
      const albumKey = simpleKey(album.title)
      const albumFiles = available.filter(f => f.role === 'unmatched' && simpleKey(f.path).includes(albumKey) && AUDIO_EXTS.has(extname(f.name).toLowerCase()))
      for (const f of albumFiles) {
        f.role = 'track'
        f.target = album.title
      }
      if (albumFiles.length > 0) matched += 1
    }
    if (matched === 0) errors.push('No album folders or tracks matched this discography')
    else if (matched < albums.length) warnings.push(`${albums.length - matched} album(s) were not matched`)
  } else if (payload.mediaType === 'books') {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(payload.itemId) as any
    const asset = available
      .filter(file => BOOK_EXTS.has(extname(file.name).toLowerCase()))
      .sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
    if (!book) errors.push(`Book ${payload.itemId} not found`)
    else if (!asset) errors.push('No ebook or audiobook file found')
    else {
      asset.role = 'primary'
      asset.target = book.title
    }
  } else if (payload.mediaType === 'comics' || payload.mediaType === 'comics-issue') {
    const issue = db.prepare('SELECT * FROM comic_issues WHERE id = ?').get(payload.itemId) as any
    const comic = available.find(f => COMIC_EXTS.has(extname(f.name).toLowerCase()) && (!issue || issueMatches(f.name, issue.issue_number, issue.name ?? issue.title))) ?? available.find(f => COMIC_EXTS.has(extname(f.name).toLowerCase()))
    if (!comic) errors.push('No comic archive/PDF matched this issue')
    else {
      comic.role = 'issue'
      comic.target = issue ? `Issue ${issue.issue_number}` : null
    }
  } else if (payload.mediaType === 'comics-volume') {
    const issues = db.prepare('SELECT * FROM comic_issues WHERE series_id = ? AND status != ? ORDER BY CAST(issue_number AS REAL), issue_number').all(payload.itemId, 'collected') as any[]
    let matched = 0
    for (const issue of issues) {
      const comic = available.find(f => f.role === 'unmatched' && COMIC_EXTS.has(extname(f.name).toLowerCase()) && issueMatches(f.name, issue.issue_number, issue.name ?? issue.title))
      if (!comic) continue
      comic.role = 'issue'
      comic.target = `Issue ${issue.issue_number}`
      matched += 1
    }
    if (matched === 0) errors.push('No comic files matched this volume')
    else if (matched < issues.length) warnings.push(`${issues.length - matched} issue(s) were not matched`)
  } else if (payload.mediaType === 'games') {
    const installable = available.sort((a, b) => b.sizeBytes - a.sizeBytes)[0]
    if (!installable) errors.push('No game files found')
    else {
      installable.role = 'primary'
      installable.target = payload.releaseTitle ?? null
    }
  }

  return finishPlan(payload.mediaType, payload.itemId, sourcePath, files, warnings, errors)
}

function assertImportPlanReady(payload: MediaImportPayload, db: Database, sourcePath: string) {
  let torrentFiles = getExternalTorrentFiles(payload.torrentId)
  if (!torrentFiles) {
    try { torrentFiles = (getTorrentSession().getTorrent(payload.torrentId) as any)?.files } catch { /* external-only mode */ }
  }
  const plan = createImportPlan(payload, db, sourcePath, torrentFiles)
  if (plan.status === 'blocked') throw new Error(plan.errors.join('; '))
  if (plan.status === 'needs-review' && ['series-season', 'series', 'music-discography', 'comics-volume'].includes(payload.mediaType)) {
    throw new Error(`Import needs review: ${plan.warnings.concat(plan.ignored.filter(f => f.role === 'unmatched').map(f => `Unmatched file: ${f.name}`)).slice(0, 8).join('; ')}`)
  }
}

function immediateEntries(sourcePath: string) {
  try {
    if (!statSync(sourcePath).isDirectory()) return []
    return readdirSync(sourcePath).map(name => join(sourcePath, name))
  } catch {
    return []
  }
}

function findAlbumSource(sourcePath: string, albumTitle: string): string | null {
  const wanted = simpleKey(albumTitle)
  if (!wanted) return null
  for (const entry of immediateEntries(sourcePath)) {
    if (simpleKey(basename(entry)).includes(wanted)) return entry
  }
  return null
}

function findComicIssueSource(sourcePath: string, issueNumber: string | number, title?: string | null): string | null {
  const issue = String(issueNumber).replace(/^0+/, '')
  const padded = issue.padStart(2, '0')
  const titleKey = simpleKey(title)
  const comicExts = new Set(['.cbz', '.cbr', '.pdf'])
  for (const entry of immediateEntries(sourcePath)) {
    const name = basename(entry)
    const key = simpleKey(name)
    const hasIssue = key.includes(`issue${issue}`) || key.includes(`issue${padded}`) || key.includes(`#${issue}`) || key.includes(`#${padded}`) || key.includes(` ${issue} `)
    const hasTitle = !!titleKey && key.includes(titleKey)
    if ((hasIssue || hasTitle) && (!extname(name) || comicExts.has(extname(name).toLowerCase()))) return entry
  }
  return null
}

async function runMediaImportJob(job: JobRecord): Promise<void> {
  const payload = parsePayload(job)
  const localSource = mapRemotePath(payload.sourcePath)
  if (!existsSync(localSource)) throw new Error(`Source path not found: ${localSource}`)
  if (!statSync(localSource)) throw new Error(`Source path is not readable: ${localSource}`)

  if (importLocks.has(localSource)) throw new Error(`Import already running for ${localSource}`)
  importLocks.add(localSource)
  updateImport(payload, 'running', { attempts: job.attempts })

  try {
    const tabDb = getDb()
    const destinationPath = await executeImport(payload, tabDb, localSource)
    updateImport(payload, 'succeeded', { destinationPath, attempts: job.attempts })
    recordEvent({
      category: 'import',
      action: 'succeeded',
      subjectType: payload.mediaType,
      subjectId: String(payload.itemId),
      message: `Imported ${payload.mediaType} item ${payload.itemId}`,
      data: { sourcePath: payload.sourcePath, destinationPath },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    updateImport(payload, 'failed', { error: message, attempts: job.attempts })
    recordEvent({
      category: 'import',
      action: 'failed',
      severity: 'error',
      subjectType: payload.mediaType,
      subjectId: String(payload.itemId),
      message,
      data: { sourcePath: payload.sourcePath },
    })
    throw err
  } finally {
    importLocks.delete(localSource)
  }
}

async function executeImport(payload: MediaImportPayload, db: Database, sourcePath: string): Promise<string> {
  const externalController = getExternalTorrentController(payload.torrentId)
  const session = externalController ?? getTorrentSession()
  const releaseTitle = payload.releaseTitle ?? basename(payload.sourcePath)
  assertImportPlanReady(payload, db, sourcePath)

  if (payload.mediaType === 'films') {
    const film = db.prepare('SELECT * FROM films WHERE id = ?').get(payload.itemId) as any
    if (!film) throw new Error(`Film ${payload.itemId} not found`)
    const tmdbMovie = await getMovie(film.tmdb_id)
    try { await session.stopTorrent(payload.torrentId) } catch {}

    // Query Rules Engine for Edition
    const rules = db.prepare('SELECT regex_pattern, output_label FROM edition_rules WHERE active = 1 ORDER BY priority DESC').all() as any[]
    let editionName = 'Theatrical'
    for (const rule of rules) {
      try {
        const regex = new RegExp(rule.regex_pattern.replace('(?i)', ''), 'i')
        if (regex.test(releaseTitle)) {
          editionName = rule.output_label
          break
        }
      } catch (err) {
        // Skip invalid regex
      }
    }

    // Heuristic Fallback for Holding Pen
    if (editionName === 'Theatrical') {
      // Look for unknown brackets that are not standard tags
      const bracketMatches = releaseTitle.match(/\[([^\]]+)\]/g)
      if (bracketMatches) {
        const ignoredTags = ['1080p', '2160p', '720p', '4k', 'hevc', 'x264', 'x265', 'remux', 'hdr', 'hdr10', 'dv', 'bluray', 'webdl', 'web-dl', 'webrip']
        for (const match of bracketMatches) {
          const inner = match.slice(1, -1)
          if (!ignoredTags.includes(inner.toLowerCase()) && /cut|edition|fanedit|version/i.test(inner)) {
            editionName = 'Unknown / Custom'
            break
          }
        }
      }
    }

    // Allow payload override (e.g. from UI "Holding Pen")
    if (payload.expectedVersion && payload.expectedVersion !== 'any') {
      editionName = payload.expectedVersion
    }

    const finalPath = await organizeFilm(tmdbMovie, sourcePath, payload.expectedVersion ?? film.expected_version, editionName, resolveLibraryRoot(db, film.library_id))
    const chaptersBeforeProcessing = await probeChaptersSafe(finalPath)

    try {
      const tcConfig = getTrackCleanerConfig()
      if (tcConfig.enabled) {
        const cleanResult = await cleanTracks(finalPath, tmdbMovie.originalLanguage ?? null, tcConfig)
        if (!cleanResult.success) {
          recordEvent({
            category: 'import',
            action: 'track-cleaner-skipped',
            severity: 'warn',
            subjectType: payload.mediaType,
            subjectId: String(payload.itemId),
            message: `Track cleaner skipped for ${film.title}: ${cleanResult.message}`,
            data: { sourcePath: payload.sourcePath, destinationPath: finalPath, result: cleanResult },
          })
        }
      }
    } catch (err) {
      recordEvent({
        category: 'import',
        action: 'track-cleaner-skipped',
        severity: 'warn',
        subjectType: payload.mediaType,
        subjectId: String(payload.itemId),
        message: `Track cleaner skipped for ${film.title}: ${err instanceof Error ? err.message : String(err)}`,
        data: { sourcePath: payload.sourcePath, destinationPath: finalPath },
      })
    }

    try {
      await autoAcquireSubtitle(finalPath, { imdbId: tmdbMovie.imdbId, tmdbId: film.tmdb_id, title: film.title })
    } catch {}

    await validateImportedVideo(payload, 'film', String(payload.itemId), payload.sourcePath, finalPath, chaptersBeforeProcessing)

    const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
    
    db.transaction(() => {
      // Find or create edition
      let edition = db.prepare('SELECT * FROM film_editions WHERE film_id = ? AND edition_name COLLATE NOCASE = ?').get(film.id, editionName) as any
      
      if (edition) {
        db.prepare(`
          UPDATE film_editions
          SET status = 'collected', file_path = ?, file_size = ?, quality = ?, download_progress = 1,
              current_tier = ?, current_resolution = ?, current_source = ?,
              current_codec = ?, current_release_group = ?, current_edition = ?, current_size_bytes = ?,
              current_release_title = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          finalPath,
          snapshot.current_size_bytes,
          snapshot.current_resolution,
          snapshot.current_tier,
          snapshot.current_resolution,
          snapshot.current_source,
          snapshot.current_codec,
          snapshot.current_release_group,
          snapshot.current_edition,
          snapshot.current_size_bytes,
          snapshot.current_release_title,
          edition.id,
        )
      } else {
        const result = db.prepare(`
          INSERT INTO film_editions (
            film_id, edition_name, status, download_progress, file_path, file_size, quality,
            current_tier, current_resolution, current_source, current_codec, current_release_group,
            current_edition, current_size_bytes, current_release_title
          ) VALUES (
            ?, ?, 'collected', 1, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?
          )
        `).run(
          film.id,
          editionName,
          finalPath,
          snapshot.current_size_bytes,
          snapshot.current_resolution,
          snapshot.current_tier,
          snapshot.current_resolution,
          snapshot.current_source,
          snapshot.current_codec,
          snapshot.current_release_group,
          snapshot.current_edition,
          snapshot.current_size_bytes,
          snapshot.current_release_title
        )
        edition = { id: result.lastInsertRowid }
      }
      
      // Set the default edition if the film has none yet.
      if (!film.default_edition_id) {
        db.prepare('UPDATE films SET default_edition_id = ? WHERE id = ?').run(edition.id, film.id)
      }

      // Roll the *default* edition's file up to the parent film row. The rest
      // of the system (library-integrity monitor, list views, player hasFile,
      // repair/reject) treats films.file_path + current_* as authoritative, so
      // leaving them null makes the integrity check flip the film back to
      // 'missing' even though the edition is collected on disk.
      const defaultEditionId = film.default_edition_id ?? edition.id
      const def = db.prepare('SELECT * FROM film_editions WHERE id = ?').get(defaultEditionId) as any
      if (def) {
        db.prepare(`
          UPDATE films SET
            status = 'collected', file_path = ?, file_size = ?, quality = ?, download_progress = 1,
            current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
            current_release_group = ?, current_edition = ?, current_size_bytes = ?, current_release_title = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          def.file_path, def.file_size, def.quality,
          def.current_tier, def.current_resolution, def.current_source, def.current_codec,
          def.current_release_group, def.current_edition, def.current_size_bytes, def.current_release_title,
          film.id,
        )
      } else {
        db.prepare("UPDATE films SET status = 'collected', download_progress = 1, updated_at = datetime('now') WHERE id = ?").run(film.id)
      }
    })()

    // Measure loudness for volume normalization (background, bounded queue).
    const played = db.prepare('SELECT file_path FROM films WHERE id = ?').get(film.id) as { file_path: string | null }
    enqueueLoudness('film', film.id, played?.file_path)

    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return finalPath
  }

  if (payload.mediaType === 'series-season') {
    const season = db.prepare('SELECT * FROM seasons WHERE id = ?').get(payload.itemId) as any
    if (!season) throw new Error(`Season ${payload.itemId} not found`)
    const series = db.prepare('SELECT title, year, tmdb_id, language, library_id FROM series WHERE id = ?').get(season.series_id) as any
    if (!series) throw new Error(`Series ${season.series_id} not found`)
    const episodes = db.prepare(`
      SELECT *
      FROM episodes
      WHERE series_id = ? AND season_number = ? AND status != 'collected'
      ORDER BY episode_number ASC
    `).all(season.series_id, season.season_number) as any[]
    const tmdbEpisodes = await getSeriesEpisodesTmdb(series.tmdb_id, season.season_number)
    try { await session.stopTorrent(payload.torrentId) } catch {}

    let lastPath = sourcePath
    let imported = 0
    for (const ep of episodes) {
      const tmdbEp = tmdbEpisodes.find((e: any) => e.episodeNumber === ep.episode_number)
      if (!tmdbEp) continue
      try {
        const finalPath = await organizeEpisode(series, tmdbEp, sourcePath, { copy: !!payload.copy, baseDir: resolveLibraryRoot(db, series.library_id) })
        const chaptersBeforeProcessing = await probeChaptersSafe(finalPath)
        await validateImportedVideo(payload, 'episode', String(ep.id), payload.sourcePath, finalPath, chaptersBeforeProcessing)
        const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
        db.prepare(`
          UPDATE episodes
          SET status = 'collected', file_path = ?, file_size = ?, quality = ?, download_progress = 1,
              current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
              current_release_group = ?, current_edition = ?, current_size_bytes = ?,
              current_release_title = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          finalPath,
          snapshot.current_size_bytes,
          snapshot.current_resolution,
          snapshot.current_tier,
          snapshot.current_resolution,
          snapshot.current_source,
          snapshot.current_codec,
          snapshot.current_release_group,
          snapshot.current_edition,
          snapshot.current_size_bytes,
          snapshot.current_release_title,
          ep.id,
        )
        lastPath = finalPath
        imported += 1
      } catch (err) {
        logger.warn(`Could not import S${season.season_number}E${ep.episode_number} from pack: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (imported === 0) throw new Error(`No episodes imported for season ${season.season_number}`)
    db.prepare("UPDATE seasons SET download_progress = 1, info_hash = NULL, updated_at = datetime('now') WHERE id = ?").run(season.id)
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return lastPath
  }

  if (payload.mediaType === 'series') {
    const ep = db.prepare('SELECT * FROM episodes WHERE id = ?').get(payload.itemId) as any
    if (!ep) {
      const seriesRow = db.prepare('SELECT * FROM series WHERE id = ?').get(payload.itemId) as any
      if (!seriesRow) throw new Error(`Episode or series ${payload.itemId} not found`)
      const seasons = db.prepare('SELECT * FROM seasons WHERE series_id = ? ORDER BY season_number ASC').all(seriesRow.id) as any[]
      try { await session.stopTorrent(payload.torrentId) } catch {}
      let lastPath = sourcePath
      let imported = 0
      for (const season of seasons) {
        const episodes = db.prepare(`
          SELECT *
          FROM episodes
          WHERE series_id = ? AND season_number = ? AND status != 'collected'
          ORDER BY episode_number ASC
        `).all(seriesRow.id, season.season_number) as any[]
        const tmdbEpisodes = await getSeriesEpisodesTmdb(seriesRow.tmdb_id, season.season_number)
        for (const episode of episodes) {
          const tmdbEp = tmdbEpisodes.find((e: any) => e.episodeNumber === episode.episode_number)
          if (!tmdbEp) continue
          try {
            const finalPath = await organizeEpisode(seriesRow, tmdbEp, sourcePath, { copy: !!payload.copy, baseDir: resolveLibraryRoot(db, seriesRow.library_id) })
            const chaptersBeforeProcessing = await probeChaptersSafe(finalPath)
            await validateImportedVideo(payload, 'episode', String(episode.id), payload.sourcePath, finalPath, chaptersBeforeProcessing)
            const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
            db.prepare(`
              UPDATE episodes
              SET status = 'collected', file_path = ?, file_size = ?, quality = ?, download_progress = 1,
                  current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
                  current_release_group = ?, current_edition = ?, current_size_bytes = ?,
                  current_release_title = ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(
              finalPath,
              snapshot.current_size_bytes,
              snapshot.current_resolution,
              snapshot.current_tier,
              snapshot.current_resolution,
              snapshot.current_source,
              snapshot.current_codec,
              snapshot.current_release_group,
              snapshot.current_edition,
              snapshot.current_size_bytes,
              snapshot.current_release_title,
              episode.id,
            )
            enqueueLoudness('episode', episode.id, finalPath)
            lastPath = finalPath
            imported += 1
          } catch (err) {
            logger.warn(`Could not import S${season.season_number}E${episode.episode_number} from series pack: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      if (imported === 0) throw new Error(`No episodes imported for series ${seriesRow.title}`)
      try { await session.removeTorrent(payload.torrentId, false) } catch {}
      return lastPath
    }
    const series = db.prepare('SELECT title, year, tmdb_id, language, library_id FROM series WHERE id = ?').get(ep.series_id) as any
    if (!series) throw new Error(`Series ${ep.series_id} not found`)
    const tmdbEpisodes = await getSeriesEpisodesTmdb(series.tmdb_id, ep.season_number)
    const tmdbEp = tmdbEpisodes.find((e: any) => e.episodeNumber === ep.episode_number)
    if (!tmdbEp) throw new Error(`Episode metadata not found for S${ep.season_number}E${ep.episode_number}`)
    if (!payload.copy) try { await session.stopTorrent(payload.torrentId) } catch {}
    const finalPath = await organizeEpisode(series, tmdbEp, sourcePath, { copy: !!payload.copy, baseDir: resolveLibraryRoot(db, series.library_id) })
    const chaptersBeforeProcessing = await probeChaptersSafe(finalPath)
    await validateImportedVideo(payload, 'episode', String(payload.itemId), payload.sourcePath, finalPath, chaptersBeforeProcessing)
    const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
    db.prepare(`
      UPDATE episodes
      SET status = 'collected', file_path = ?, file_size = ?, quality = ?, download_progress = 1,
          current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
          current_release_group = ?, current_edition = ?, current_size_bytes = ?,
          current_release_title = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      finalPath,
      snapshot.current_size_bytes,
      snapshot.current_resolution,
      snapshot.current_tier,
      snapshot.current_resolution,
      snapshot.current_source,
      snapshot.current_codec,
      snapshot.current_release_group,
      snapshot.current_edition,
      snapshot.current_size_bytes,
      snapshot.current_release_title,
      payload.itemId,
    )
    enqueueLoudness('episode', Number(payload.itemId), finalPath)
    return finalPath
  }

  if (payload.mediaType === 'music-discography') {
    const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(payload.itemId) as any
    if (!artist) throw new Error(`Artist ${payload.itemId} not found`)
    const albums = db.prepare(`
      SELECT *
      FROM albums
      WHERE artist_id = ? AND status != 'collected'
      ORDER BY year ASC, title ASC
    `).all(artist.id) as any[]
    try { await session.stopTorrent(payload.torrentId) } catch {}

    let lastPath = sourcePath
    let imported = 0
    for (const album of albums) {
      const albumSource = findAlbumSource(sourcePath, album.title) ?? sourcePath
      try {
        const finalPath = await organizeMusic(album.id, albumSource, db, resolveLibraryRoot(db, artist.library_id))
        const validation = validateImportedAsset('album', finalPath, { allowedExtensions: ['.mp3', '.flac', '.m4a', '.wav'], minBytes: 16 * 1024, allowDirectory: true })
        recordAssetValidation(payload, 'album', String(album.id), albumSource, finalPath, validation)
        const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
        db.prepare(`
          UPDATE albums
          SET status = 'collected', download_progress = 1, current_tier = ?, current_resolution = ?,
              current_source = ?, current_codec = ?, current_release_group = ?, current_edition = ?,
              current_size_bytes = ?, current_release_title = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          snapshot.current_tier,
          snapshot.current_resolution,
          snapshot.current_source,
          snapshot.current_codec,
          snapshot.current_release_group,
          snapshot.current_edition,
          snapshot.current_size_bytes,
          snapshot.current_release_title,
          album.id,
        )
        lastPath = finalPath
        imported += 1
      } catch (err) {
        logger.warn(`Could not import album "${album.title}" from discography: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (imported === 0) throw new Error(`No albums imported for artist ${artist.name}`)
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return lastPath
  }

  if (payload.mediaType === 'music' || payload.mediaType === 'music-album') {
    const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(payload.itemId) as any
    if (!album) throw new Error(`Album ${payload.itemId} not found`)
    try { await session.stopTorrent(payload.torrentId) } catch {}
    const finalPath = await organizeMusic(payload.itemId, sourcePath, db, resolveLibraryRoot(db, (db.prepare('SELECT library_id FROM artists WHERE id = ?').get(album.artist_id) as any).library_id))
    const validation = validateImportedAsset('album', finalPath, { allowedExtensions: ['.mp3', '.flac', '.m4a', '.wav'], minBytes: 16 * 1024, allowDirectory: true })
    recordAssetValidation(payload, 'album', String(payload.itemId), payload.sourcePath, finalPath, validation)
    const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
    db.prepare(`
      UPDATE albums
      SET status = 'collected', download_progress = 1, current_tier = ?, current_resolution = ?,
          current_source = ?, current_codec = ?, current_release_group = ?, current_edition = ?,
          current_size_bytes = ?, current_release_title = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      snapshot.current_tier,
      snapshot.current_resolution,
      snapshot.current_source,
      snapshot.current_codec,
      snapshot.current_release_group,
      snapshot.current_edition,
      snapshot.current_size_bytes,
      snapshot.current_release_title,
      payload.itemId,
    )
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return finalPath
  }

  if (payload.mediaType === 'books') {
    const book = db.prepare(`
      SELECT b.*, a.name AS author_name, a.overview AS author_overview, a.library_id
      FROM books b JOIN authors a ON a.id = b.author_id
      WHERE b.id = ?
    `).get(payload.itemId) as any
    if (!book) throw new Error(`Book ${payload.itemId} not found`)
    try { await session.stopTorrent(payload.torrentId) } catch {}

    const finalPath = await organizeBook(
      { name: book.author_name, overview: book.author_overview },
      {
        title: book.title,
        year: book.year,
        subtitle: book.subtitle,
        publisher: book.publisher,
        pageCount: book.page_count,
        overview: book.overview,
        genres: JSON.parse(book.genres || '[]'),
        language: book.language,
        isbn13: book.isbn_13,
        googleBooksId: book.google_books_id,
      },
      sourcePath,
      resolveLibraryRoot(db, book.library_id),
    )
    const validation = validateImportedAsset('book', finalPath, {
      allowedExtensions: [...BOOK_EXTS],
      minBytes: 1024,
      allowDirectory: true,
    })
    recordAssetValidation(payload, 'book', String(payload.itemId), payload.sourcePath, finalPath, validation)

    const files = collectAssetFiles(finalPath).filter(file => BOOK_EXTS.has(file.extension))
    const audio = files.some(file => ['.m4b', '.mp3', '.flac'].includes(file.extension))
    const format = statSync(finalPath).isFile() ? extname(finalPath).slice(1).toLowerCase() : audio ? 'audiobook' : 'ebook'
    const totalSize = files.reduce((sum, file) => sum + file.size, 0)
    const snapshot = buildQualitySnapshot(releaseTitle, statSync(finalPath).isFile() ? finalPath : null)
    db.transaction(() => {
      const edition = db.prepare('SELECT id FROM book_editions WHERE book_id = ? AND format = ? ORDER BY id LIMIT 1')
        .get(book.id, format) as { id: number } | undefined
      if (edition) {
        db.prepare(`
          UPDATE book_editions SET file_path = ?, file_size = ?, status = 'downloaded'
          WHERE id = ?
        `).run(finalPath, totalSize || snapshot.current_size_bytes, edition.id)
      } else {
        db.prepare(`
          INSERT INTO book_editions (book_id, format, file_path, file_size, status)
          VALUES (?, ?, ?, ?, 'downloaded')
        `).run(book.id, format, finalPath, totalSize || snapshot.current_size_bytes)
      }
      db.prepare(`
        UPDATE books SET status = 'downloaded', download_progress = 1,
          current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
          current_release_group = ?, current_edition = ?, current_size_bytes = ?,
          current_release_title = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        snapshot.current_tier,
        snapshot.current_resolution,
        snapshot.current_source,
        snapshot.current_codec,
        snapshot.current_release_group,
        format,
        totalSize || snapshot.current_size_bytes,
        snapshot.current_release_title,
        book.id,
      )
    })()
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return finalPath
  }

  if (payload.mediaType === 'games') {
    const game = db.prepare('SELECT * FROM games WHERE id = ?').get(payload.itemId) as any
    if (!game) throw new Error(`Game ${payload.itemId} not found`)
    try { await session.stopTorrent(payload.torrentId) } catch {}
    const finalPath = await organizeGame(game, sourcePath, resolveLibraryRoot(db, game.library_id))
    const validation = validateImportedAsset('game', finalPath, { minBytes: 1024, allowDirectory: true })
    recordAssetValidation(payload, 'game', String(payload.itemId), payload.sourcePath, finalPath, validation)
    const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
    db.prepare(`
      UPDATE games
      SET status = 'collected', file_path = ?, file_size = ?, download_progress = 1,
          current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
          current_release_group = ?, current_edition = ?, current_size_bytes = ?,
          current_release_title = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      finalPath,
      snapshot.current_size_bytes,
      snapshot.current_tier,
      snapshot.current_resolution,
      snapshot.current_source,
      snapshot.current_codec,
      snapshot.current_release_group,
      snapshot.current_edition,
      snapshot.current_size_bytes,
      snapshot.current_release_title,
      payload.itemId,
    )
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return finalPath
  }

  if (payload.mediaType === 'comics-volume') {
    const series = db.prepare('SELECT * FROM comic_series WHERE id = ?').get(payload.itemId) as any
    if (!series) throw new Error(`Comic volume ${payload.itemId} not found`)
    const issues = db.prepare(`
      SELECT i.*, s.title as series_title, s.comicvine_id as series_cv_id, s.start_year
      FROM comic_issues i JOIN comic_series s ON i.series_id = s.id
      WHERE i.series_id = ? AND i.status != 'collected'
      ORDER BY CAST(i.issue_number AS REAL), i.issue_number
    `).all(series.id) as any[]
    const cvSeries = { id: series.comicvine_id ?? series.id, name: series.title, startYear: series.start_year, genres: [], issueCount: issues.length, seriesType: 'ongoing' } as any
    try { await session.stopTorrent(payload.torrentId) } catch {}

    let lastPath = sourcePath
    let imported = 0
    for (const issue of issues) {
      const issueSource = findComicIssueSource(sourcePath, issue.issue_number, issue.name ?? issue.title) ?? sourcePath
      const cvIssue = { id: issue.comicvine_id ?? issue.id, issueNumber: issue.issue_number, title: issue.name ?? issue.title } as any
      try {
        const finalPath = await organizeComicIssue(cvSeries, cvIssue, issueSource, resolveLibraryRoot(db, series.library_id))
        const validation = validateImportedAsset('comic issue', finalPath, { allowedExtensions: ['.cbz', '.cbr', '.pdf'], minBytes: 32 * 1024, allowDirectory: false })
        recordAssetValidation(payload, 'comic issue', String(issue.id), issueSource, finalPath, validation)
        const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
        db.prepare(`
          UPDATE comic_issues
          SET status = 'collected', file_path = ?, file_size = ?, download_progress = 1,
              current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
              current_release_group = ?, current_edition = ?, current_size_bytes = ?,
              current_release_title = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(
          finalPath,
          snapshot.current_size_bytes,
          snapshot.current_tier,
          snapshot.current_resolution,
          snapshot.current_source,
          snapshot.current_codec,
          snapshot.current_release_group,
          snapshot.current_edition,
          snapshot.current_size_bytes,
          snapshot.current_release_title,
          issue.id,
        )
        lastPath = finalPath
        imported += 1
      } catch (err) {
        logger.warn(`Could not import comic issue ${issue.issue_number} from volume: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (imported === 0) throw new Error(`No issues imported for comic volume ${series.title}`)
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return lastPath
  }

  if (payload.mediaType === 'comics' || payload.mediaType === 'comics-issue') {
    const issue = db.prepare(`
      SELECT i.*, s.title as series_title, s.comicvine_id as series_cv_id, s.start_year, s.library_id as series_library_id
      FROM comic_issues i JOIN comic_series s ON i.series_id = s.id
      WHERE i.id = ?
    `).get(payload.itemId) as any
    if (!issue) throw new Error(`Comic issue ${payload.itemId} not found`)
    const cvSeries = { id: issue.series_cv_id, name: issue.series_title, startYear: issue.start_year, genres: [], issueCount: 0, seriesType: 'ongoing' } as any
    const cvIssue = { id: issue.comicvine_id ?? issue.id, issueNumber: issue.issue_number, title: issue.title } as any
    try { await session.stopTorrent(payload.torrentId) } catch {}
    const finalPath = await organizeComicIssue(cvSeries, cvIssue, sourcePath, resolveLibraryRoot(db, issue.series_library_id))
    const validation = validateImportedAsset('comic issue', finalPath, { allowedExtensions: ['.cbz', '.cbr', '.pdf'], minBytes: 32 * 1024, allowDirectory: false })
    recordAssetValidation(payload, 'comic issue', String(payload.itemId), payload.sourcePath, finalPath, validation)
    const snapshot = buildQualitySnapshot(releaseTitle, finalPath)
    db.prepare(`
      UPDATE comic_issues
      SET status = 'collected', file_path = ?, file_size = ?, download_progress = 1,
          current_tier = ?, current_resolution = ?, current_source = ?, current_codec = ?,
          current_release_group = ?, current_edition = ?, current_size_bytes = ?,
          current_release_title = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      finalPath,
      snapshot.current_size_bytes,
      snapshot.current_tier,
      snapshot.current_resolution,
      snapshot.current_source,
      snapshot.current_codec,
      snapshot.current_release_group,
      snapshot.current_edition,
      snapshot.current_size_bytes,
      snapshot.current_release_title,
      payload.itemId,
    )
    try { await session.removeTorrent(payload.torrentId, false) } catch {}
    return finalPath
  }

  throw new Error(`Unsupported media import type: ${payload.mediaType}`)
}
