import type { Database } from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  intervalHours: 24,
  retentionCount: 7,
  includeTorrentState: true,
}

let scheduler: ReturnType<typeof setInterval> | null = null

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

function copyIfExists(source: string, destDir: string, role: string, files: BackupManifest['files']): void {
  const resolved = resolve(source)
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return
  const dest = join(destDir, basename(resolved))
  copyFileSync(resolved, dest)
  files.push({ role, source, path: dest, bytes: statSync(dest).size })
}

function copyDirectoryFiles(sourceDir: string, destDir: string, role: string, files: BackupManifest['files']): void {
  const resolved = resolve(sourceDir)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    copyIfExists(join(resolved, entry.name), destDir, role, files)
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
  const unifiedPath = process.env.ARCHIVIST_DB ?? defaultDbPath()

  db.pragma('wal_checkpoint(PASSIVE)')
  const dest = join(dbDir, basename(unifiedPath))
  await db.backup(dest)
  files.push({ role: 'unified-db', source: unifiedPath, path: dest, bytes: statSync(dest).size })

  if (config.includeTorrentState) {
    copyDirectoryFiles(process.env.TORRENT_RESUME_DIR ?? './data/resume', join(stateDir, 'resume'), 'torrent-resume', files)
    copyDirectoryFiles(process.env.TORRENT_FILES_DIR ?? './data/torrents', join(stateDir, 'torrents'), 'torrent-file', files)
  }
  copyIfExists('.env', backupPath, 'env', files)

  const manifest: BackupManifest = {
    id,
    createdAt: new Date().toISOString(),
    appVersion: '2.0.0',
    backupPath,
    files,
  }
  writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2))
  setAppSetting('lastSystemBackup', manifest, 0, db)
  recordEvent({
    category: 'backup',
    action: 'created',
    message: `Created system backup ${id}`,
    data: { id, backupPath, files: files.length },
  }, db)
  pruneBackups(config.retentionCount, db)
  return manifest
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
        return JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest
      } catch {
        return null
      }
    })
    .filter((manifest): manifest is BackupManifest => !!manifest)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function pruneBackups(retentionCount: number, db: Database = getDb()): number {
  const backups = listBackups()
  const keep = Math.max(1, retentionCount)
  const stale = backups.slice(keep)
  for (const backup of stale) {
    rmSync(backup.backupPath, { recursive: true, force: true })
  }
  if (stale.length > 0) {
    recordEvent({ category: 'backup', action: 'pruned', message: `Pruned ${stale.length} old backup(s)`, data: { retentionCount: keep } }, db)
  }
  return stale.length
}

export function registerBackupJobs(): void {
  registerJobHandler('system-backup', async () => {
    await createSystemBackup()
  })
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
