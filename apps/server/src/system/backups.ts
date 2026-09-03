import BetterSqlite3, { type Database } from 'better-sqlite3'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { createLogger } from '@archivist/core'
import { defaultDbPath } from '@archivist/db'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'
import { enqueueUniqueJob, recordEvent } from './event-store.js'
import { registerJobHandler } from './job-runner.js'

const logger = createLogger('Backups')

export interface BackupConfig {
  enabled: boolean
  intervalHours: number
  retentionCount: number
  includeTorrentState: boolean
}

export interface BackupManifest {
  id: string
  createdAt: string
  appVersion: string
  backupPath: string
  files: Array<{ role: string; source: string; path: string; bytes: number }>
  /** Optional files the backup could not take, and why. Empty on a clean run. */
  warnings?: Array<{ role: string; source: string; reason: string }>
}

export interface BackupHealth {
  status: 'healthy' | 'stale' | 'invalid' | 'missing' | 'disabled'
  enabled: boolean
  backupCount: number
  retentionCount: number
  intervalHours: number
  latest: null | { id: string; createdAt: string; ageHours: number; files: number; bytes: number }
  verifiedAt: string | null
  sqliteIntegrity: 'ok' | 'failed' | 'not-checked'
  reason: string | null
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  intervalHours: 24,
  retentionCount: 7,
  includeTorrentState: true,
}

let scheduler: ReturnType<typeof setInterval> | null = null
let healthCache: { id: string; checkedAt: number; integrity: 'ok' | 'failed'; reason: string | null } | null = null

function clampConfig(config: BackupConfig): BackupConfig {
  return {
    enabled: !!config.enabled,
    intervalHours: Math.max(1, Math.min(168, Number(config.intervalHours) || DEFAULT_CONFIG.intervalHours)),
    retentionCount: Math.max(1, Math.min(365, Number(config.retentionCount) || DEFAULT_CONFIG.retentionCount)),
    includeTorrentState: !!config.includeTorrentState,
  }
}

export function getBackupRoot(): string {
  return resolve(process.env.ARCHIVIST_BACKUP_DIR ?? './data/backups')
}

export function getBackupConfig(db: Database = getDb()): BackupConfig {
  return clampConfig(getAppSetting('systemBackups', DEFAULT_CONFIG, 0, db))
}

export function setBackupConfig(config: Partial<BackupConfig>, db: Database = getDb()): BackupConfig {
  const merged = clampConfig({ ...getBackupConfig(db), ...config })
  setAppSetting('systemBackups', merged, 0, db)
  recordEvent({ category: 'backup', action: 'configured', message: 'Backup settings updated', data: merged }, db)
  return merged
}

export function getLastBackupManifest(db: Database = getDb()): BackupManifest | null {
  return getAppSetting<BackupManifest | null>('lastSystemBackup', null, 0, db)
}

function backupId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Copies one optional file. A file we cannot read — a root-owned `.env` under a
 * non-root service user is the common case — is recorded as a warning rather
 * than thrown, because losing an optional file must never cost us the database
 * backup that has already been written.
 */
function copyIfExists(
  source: string,
  destDir: string,
  role: string,
  files: BackupManifest['files'],
  warnings: NonNullable<BackupManifest['warnings']>,
  mode?: number,
): void {
  const resolved = resolve(source)
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return
  const dest = join(destDir, basename(resolved))
  try {
    copyFileSync(resolved, dest)
    if (mode !== undefined) chmodSync(dest, mode)
    files.push({ role, source, path: dest, bytes: statSync(dest).size })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    warnings.push({ role, source, reason })
    logger.warn(`Skipped ${role} in backup: ${reason}`)
    rmSync(dest, { force: true })
  }
}

function copyDirectoryFiles(
  sourceDir: string,
  destDir: string,
  role: string,
  files: BackupManifest['files'],
  warnings: NonNullable<BackupManifest['warnings']>,
): void {
  const resolved = resolve(sourceDir)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    copyIfExists(join(resolved, entry.name), destDir, role, files, warnings)
  }
}

export async function createSystemBackup(db: Database = getDb(), config = getBackupConfig(db)): Promise<BackupManifest> {
  const id = backupId()
  const root = getBackupRoot()
  const backupPath = join(root, id)
  const dbDir = join(backupPath, 'db')
  const stateDir = join(backupPath, 'state')
  mkdirSync(dbDir, { recursive: true })

  const files: BackupManifest['files'] = []
  const warnings: NonNullable<BackupManifest['warnings']> = []
  const unifiedPath = process.env.ARCHIVIST_DB ?? defaultDbPath()

  try {
    db.pragma('wal_checkpoint(PASSIVE)')
    const dest = join(dbDir, basename(unifiedPath))
    await db.backup(dest)
    files.push({ role: 'unified-db', source: unifiedPath, path: dest, bytes: statSync(dest).size })

    if (config.includeTorrentState) {
      copyDirectoryFiles(process.env.TORRENT_RESUME_DIR ?? './data/resume', join(stateDir, 'resume'), 'torrent-resume', files, warnings)
      copyDirectoryFiles(process.env.TORRENT_FILES_DIR ?? './data/torrents', join(stateDir, 'torrents'), 'torrent-file', files, warnings)
    }
    // The environment file holds secrets, so the copy keeps owner-only mode
    // rather than inheriting the umask of the backup directory.
    copyIfExists('.env', backupPath, 'env', files, warnings, 0o600)

    const manifest: BackupManifest = {
      id,
      createdAt: new Date().toISOString(),
      appVersion: '2.0.0',
      backupPath,
      files,
      ...(warnings.length ? { warnings } : {}),
    }
    writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2))
    setAppSetting('lastSystemBackup', manifest, 0, db)
    recordEvent({
      category: 'backup',
      action: 'created',
      severity: warnings.length ? 'warn' : 'info',
      message: warnings.length
        ? `Created system backup ${id} — skipped ${warnings.length} optional file(s): ${warnings.map(w => w.role).join(', ')}`
        : `Created system backup ${id}`,
      data: { id, backupPath, files: files.length, warnings },
    }, db)
    pruneBackups(config.retentionCount, db)
    return manifest
  } catch (error) {
    // A half-written backup has no manifest, so listBackups() cannot see it and
    // pruneBackups() would never reclaim it. Remove it here instead of leaving
    // a full database copy behind on every failed attempt.
    rmSync(backupPath, { recursive: true, force: true })
    throw error
  }
}

export function listBackups(): BackupManifest[] {
  const root = getBackupRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const manifestPath = join(root, entry.name, 'manifest.json')
      if (!existsSync(manifestPath)) return null
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
        return manifest.id === entry.name ? manifest : null
      } catch {
        return null
      }
    })
    .filter((manifest): manifest is BackupManifest => !!manifest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getBackupHealth(db: Database = getDb()): BackupHealth {
  const config = getBackupConfig(db)
  const backups = listBackups()
  if (!config.enabled) {
    return { status: 'disabled', enabled: false, backupCount: backups.length, retentionCount: config.retentionCount, intervalHours: config.intervalHours, latest: null, verifiedAt: null, sqliteIntegrity: 'not-checked', reason: null }
  }
  const latest = backups[0]
  if (!latest) {
    return { status: 'missing', enabled: true, backupCount: 0, retentionCount: config.retentionCount, intervalHours: config.intervalHours, latest: null, verifiedAt: null, sqliteIntegrity: 'not-checked', reason: 'No completed system backup was found' }
  }

  const now = Date.now()
  if (!healthCache || healthCache.id !== latest.id || now - healthCache.checkedAt > 5 * 60_000) {
    let integrity: 'ok' | 'failed' = 'ok'
    let reason: string | null = null
    try {
      const expectedRoot = realpathSync(resolve(getBackupRoot(), latest.id))
      const filePaths = latest.files.map(file => realpathSync(resolve(file.path)))
      if (filePaths.some(filePath => !filePath.startsWith(`${expectedRoot}${sep}`))) throw new Error('Manifest contains a file outside its backup directory')
      for (let index = 0; index < latest.files.length; index += 1) {
        const info = statSync(filePaths[index])
        if (!info.isFile() || info.size !== latest.files[index].bytes) throw new Error('A backup file is missing or its size differs from the manifest')
      }
      const databaseFile = latest.files.find(file => file.role === 'unified-db')
      if (!databaseFile) throw new Error('The unified database is missing from the manifest')
      const verificationDb = new BetterSqlite3(resolve(databaseFile.path), { readonly: true, fileMustExist: true })
      try {
        const result = verificationDb.pragma('quick_check') as Array<{ quick_check: string }>
        if (result.length !== 1 || result[0]?.quick_check !== 'ok') throw new Error('SQLite quick_check did not return ok')
      } finally {
        verificationDb.close()
      }
    } catch (error) {
      integrity = 'failed'
      reason = error instanceof Error ? error.message : 'Backup verification failed'
    }
    healthCache = { id: latest.id, checkedAt: now, integrity, reason }
  }

  const createdAt = Date.parse(latest.createdAt)
  const ageHours = Number.isFinite(createdAt) ? Math.max(0, (now - createdAt) / 3_600_000) : Number.POSITIVE_INFINITY
  const stale = ageHours > config.intervalHours * 2
  const latestSummary = {
    id: latest.id,
    createdAt: latest.createdAt,
    ageHours: Math.round(ageHours * 10) / 10,
    files: latest.files.length,
    bytes: latest.files.reduce((total, file) => total + file.bytes, 0),
  }
  return {
    status: healthCache.integrity === 'failed' ? 'invalid' : stale ? 'stale' : 'healthy',
    enabled: true,
    backupCount: backups.length,
    retentionCount: config.retentionCount,
    intervalHours: config.intervalHours,
    latest: latestSummary,
    verifiedAt: new Date(healthCache.checkedAt).toISOString(),
    sqliteIntegrity: healthCache.integrity,
    reason: healthCache.reason ?? (stale ? 'The latest backup is older than two configured backup intervals' : null),
  }
}

/** Directories with no manifest that are old enough not to be a run in flight. */
const ORPHAN_MIN_AGE_MS = 60 * 60_000

/**
 * Removes backups beyond the retention count, and sweeps directories left by
 * runs that failed before writing a manifest. Those are invisible to
 * listBackups(), so without this they accumulate a full database copy per
 * attempt.
 */
export function pruneBackups(retentionCount: number, db: Database = getDb()): number {
  const root = getBackupRoot()
  const backups = listBackups()
  const keep = Math.max(1, retentionCount)
  const stale = backups.slice(keep)
  for (const backup of stale) {
    rmSync(backup.backupPath, { recursive: true, force: true })
  }

  let orphans = 0
  if (existsSync(root)) {
    const complete = new Set(backups.map(backup => backup.id))
    const now = Date.now()
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || complete.has(entry.name)) continue
      const path = join(root, entry.name)
      try {
        if (now - statSync(path).mtimeMs < ORPHAN_MIN_AGE_MS) continue
        rmSync(path, { recursive: true, force: true })
        orphans += 1
      } catch {
        // A directory that vanished or cannot be read is not worth failing over.
      }
    }
  }

  if (stale.length > 0 || orphans > 0) {
    recordEvent({
      category: 'backup',
      action: 'pruned',
      message: `Pruned ${stale.length} old backup(s)${orphans ? ` and ${orphans} incomplete director(ies)` : ''}`,
      data: { retentionCount: keep, orphans },
    }, db)
  }
  return stale.length + orphans
}

export function registerBackupJobs(): void {
  registerJobHandler('system-backup', async () => {
    await createSystemBackup()
  }, { lane: 'scans' })
}

export function startBackupScheduler(db: Database = getDb(), pollMs = 15 * 60_000): void {
  if (scheduler) return
  const tick = () => {
    try {
      const config = getBackupConfig(db)
      if (!config.enabled) return
      const last = getLastBackupManifest(db)
      const lastAt = last?.createdAt ? new Date(last.createdAt).getTime() : 0
      if (Date.now() - lastAt < config.intervalHours * 60 * 60_000) return
      const jobId = enqueueUniqueJob({
        type: 'system-backup',
        subjectType: 'system',
        subjectId: 'backup',
        payload: { scheduled: true },
        maxAttempts: 2,
      }, db)
      if (jobId) logger.info(`Queued system backup job #${jobId}`)
    } catch (err) {
      logger.warn('Backup scheduler tick failed:', err instanceof Error ? err.message : String(err))
    }
  }
  scheduler = setInterval(tick, pollMs)
  scheduler.unref?.()
  tick()
}

export function stopBackupScheduler(): void {
  if (scheduler) clearInterval(scheduler)
  scheduler = null
}
