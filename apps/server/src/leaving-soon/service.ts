import type { Database } from 'better-sqlite3'
import { existsSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getDb } from '../db.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'
import { recordEvent } from '../system/event-store.js'

export interface SweepSettings {
  enabled: boolean
  graceDays: number
  dryRun: boolean
  cleanupIntervalHours: number
  requireKeepApproval: boolean
  manualReviewRequired: boolean
  autoEligibilityEnabled: boolean
  contentAgeDays: number
  lastWatchedDays: number
  minimumSizeGb: number
  protectionPeriodDays: number
  protectChannelItems: boolean
  excludeTags: string[]
  diskUsageThresholds: Array<{ usagePercent: number; maxGraceDays: number }>
  tvCleanupMode: 'all' | 'keep_episodes' | 'keep_seasons'
  keepCount: number
  protectSpecials: boolean
  taggingEnabled: boolean
  tagName: string
  collectionsEnabled: boolean
  movieCollectionName: string
  tvCollectionName: string
  warningDays: number[]
  ntfy: { enabled: boolean; serverUrl: string; topic: string; token: string }
  email: { enabled: boolean; webhookUrl: string }
  webPush: { enabled: boolean; webhookUrl: string }
  libraryOverrides: Record<string, Partial<SweepLibraryPolicy>>
}

export type SweepLibraryPolicy = Pick<SweepSettings,
  'enabled' | 'graceDays' | 'autoEligibilityEnabled' | 'contentAgeDays' | 'lastWatchedDays' |
  'minimumSizeGb' | 'protectionPeriodDays' | 'protectChannelItems' | 'excludeTags' |
  'taggingEnabled' | 'tagName'>

export const DEFAULT_SWEEP_SETTINGS: SweepSettings = {
  enabled: true,
  graceDays: 30,
  dryRun: false,
  cleanupIntervalHours: 1,
  requireKeepApproval: false,
  manualReviewRequired: false,
  autoEligibilityEnabled: false,
  contentAgeDays: 120,
  lastWatchedDays: 90,
  minimumSizeGb: 0,
  protectionPeriodDays: 90,
  protectChannelItems: true,
  excludeTags: ['Keep', 'Favourite', 'Ongoing'],
  diskUsageThresholds: [
    { usagePercent: 75, maxGraceDays: 14 },
    { usagePercent: 85, maxGraceDays: 7 },
    { usagePercent: 90, maxGraceDays: 3 },
  ],
  tvCleanupMode: 'all',
  keepCount: 1,
  protectSpecials: true,
  taggingEnabled: true,
  tagName: 'Leaving Soon',
  collectionsEnabled: true,
  movieCollectionName: 'Leaving Movies',
  tvCollectionName: 'Leaving TV',
  warningDays: [14, 7, 3, 1],
  ntfy: { enabled: false, serverUrl: 'https://ntfy.sh', topic: '', token: '' },
  email: { enabled: false, webhookUrl: '' },
  webPush: { enabled: false, webhookUrl: '' },
  libraryOverrides: {},
}
export type LeavingSoonTargetType = 'film_edition' | 'series' | 'season' | 'episode'

export interface LeavingSoonItem {
  id: number
  targetType: LeavingSoonTargetType
  targetId: number
  enabled: boolean
  status: 'armed' | 'scheduled' | 'deleting' | 'deleted' | 'failed' | 'cancelled'
  title: string
  subtitle: string | null
  posterUrl: string | null
  backdropUrl: string | null
  libraryId: number
  watchedAt: string | null
  deleteAfter: string | null
  daysRemaining: number | null
  lastError: string | null
}

export function getSweepSettings(db: Database = getDb()): SweepSettings {
  const stored = getAppSetting<Partial<SweepSettings>>('sweepSettings', DEFAULT_SWEEP_SETTINGS, 0, db)
  return normalizeSweepSettings({ ...DEFAULT_SWEEP_SETTINGS, ...stored })
}

export type PublicSweepSettings = Pick<SweepSettings,
  'enabled' | 'graceDays' | 'dryRun' | 'requireKeepApproval' | 'collectionsEnabled' |
  'movieCollectionName' | 'tvCollectionName' | 'warningDays'>

export function getPublicSweepSettings(db: Database = getDb()): PublicSweepSettings {
  const settings = getSweepSettings(db)
  return {
    enabled: settings.enabled,
    graceDays: settings.graceDays,
    dryRun: settings.dryRun,
    requireKeepApproval: settings.requireKeepApproval,
    collectionsEnabled: settings.collectionsEnabled,
    movieCollectionName: settings.movieCollectionName,
    tvCollectionName: settings.tvCollectionName,
    warningDays: settings.warningDays,
  }
}

export function updateSweepSettings(input: Partial<SweepSettings>, db: Database = getDb()): SweepSettings {
  const previous = getSweepSettings(db)
  const next = getSweepSettingsFrom({ ...previous, ...input })
  setAppSetting('sweepSettings', next, 0, db)
  const scheduled = db.prepare("SELECT * FROM leaving_soon_rules WHERE enabled = 1 AND status = 'scheduled'").all() as RuleRow[]
  for (const rule of scheduled) {
    const libraryId = targetLibraryId(rule.target_type, rule.target_id, db)
    const oldPolicy = effectiveSweepPolicy(libraryId, previous)
    const newPolicy = effectiveSweepPolicy(libraryId, next)
    if (oldPolicy.taggingEnabled) applySweepTag(rule.target_type, rule.target_id, oldPolicy.tagName, false, db)
    if (newPolicy.taggingEnabled) applySweepTag(rule.target_type, rule.target_id, newPolicy.tagName, true, db)
    if (rule.watched_at) {
      const deleteAfter = new Date(parseStoredDate(rule.watched_at) + effectiveGraceDays(libraryId, newPolicy, db) * 86_400_000).toISOString()
      db.prepare("UPDATE leaving_soon_rules SET delete_after = ?, updated_at = datetime('now') WHERE id = ?").run(deleteAfter, rule.id)
    }
  }
  recordEvent({
    category: 'leaving-soon',
    action: 'settings-updated',
    message: `Sweep settings updated (${next.graceDays}-day grace${next.taggingEnabled ? `, tag: ${next.tagName}` : ', tagging off'})`,
    data: { enabled: next.enabled, graceDays: next.graceDays, dryRun: next.dryRun, autoEligibilityEnabled: next.autoEligibilityEnabled },
  }, db)
  return next
}

function targetLibraryId(type: LeavingSoonTargetType, id: number, db: Database): number {
  if (type === 'film_edition') return Number((db.prepare('SELECT f.library_id FROM film_editions fe JOIN films f ON f.id = fe.film_id WHERE fe.id = ?').get(id) as { library_id?: number } | undefined)?.library_id ?? 0)
  if (type === 'series') return Number((db.prepare('SELECT library_id FROM series WHERE id = ?').get(id) as { library_id?: number } | undefined)?.library_id ?? 0)
  const table = type === 'season' ? 'seasons' : 'episodes'
  return Number((db.prepare(`SELECT s.library_id FROM ${table} child JOIN series s ON s.id = child.series_id WHERE child.id = ?`).get(id) as { library_id?: number } | undefined)?.library_id ?? 0)
}

function effectiveGraceDays(libraryId: number, policy: SweepSettings, db: Database): number {
  let grace = policy.graceDays
  const roots = db.prepare('SELECT path FROM root_folders WHERE library_id = ?').all(libraryId) as Array<{ path: string }>
  let usage = 0
  for (const root of roots) {
    try {
      const stats = statfsSync(root.path)
      if (stats.blocks > 0) usage = Math.max(usage, ((stats.blocks - stats.bavail) / stats.blocks) * 100)
    } catch {}
  }
  for (const threshold of policy.diskUsageThresholds) if (usage >= threshold.usagePercent) grace = Math.min(grace, threshold.maxGraceDays)
  return grace
}

function getSweepSettingsFrom(value: Partial<SweepSettings>): SweepSettings {
  return normalizeSweepSettings({ ...DEFAULT_SWEEP_SETTINGS, ...value })
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback
}

function cleanList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, 50)
}

function normalizeSweepSettings(value: Partial<SweepSettings>): SweepSettings {
  const mode = value.tvCleanupMode
  const overrides: Record<string, Partial<SweepLibraryPolicy>> = {}
  if (value.libraryOverrides && typeof value.libraryOverrides === 'object') {
    for (const [id, raw] of Object.entries(value.libraryOverrides)) {
      if (!raw || typeof raw !== 'object') continue
      overrides[id] = {
        ...raw,
        graceDays: raw.graceDays === undefined ? undefined : bounded(raw.graceDays, 30, 1, 3650),
        contentAgeDays: raw.contentAgeDays === undefined ? undefined : bounded(raw.contentAgeDays, 120, 0, 36500),
        lastWatchedDays: raw.lastWatchedDays === undefined ? undefined : bounded(raw.lastWatchedDays, 90, 0, 36500),
        minimumSizeGb: raw.minimumSizeGb === undefined ? undefined : Math.max(0, Number(raw.minimumSizeGb) || 0),
        protectionPeriodDays: raw.protectionPeriodDays === undefined ? undefined : bounded(raw.protectionPeriodDays, 90, 0, 36500),
        excludeTags: raw.excludeTags === undefined ? undefined : cleanList(raw.excludeTags, []),
        tagName: raw.tagName === undefined ? undefined : String(raw.tagName).trim().slice(0, 100) || DEFAULT_SWEEP_SETTINGS.tagName,
      }
    }
  }
  return {
    enabled: value.enabled !== false,
    graceDays: bounded(value.graceDays, 30, 1, 3650),
    dryRun: value.dryRun === true,
    cleanupIntervalHours: bounded(value.cleanupIntervalHours, 1, 1, 168),
    requireKeepApproval: value.requireKeepApproval === true,
    manualReviewRequired: value.manualReviewRequired === true,
    autoEligibilityEnabled: value.autoEligibilityEnabled === true,
    contentAgeDays: bounded(value.contentAgeDays, 120, 0, 36500),
    lastWatchedDays: bounded(value.lastWatchedDays, 90, 0, 36500),
    minimumSizeGb: Math.max(0, Number(value.minimumSizeGb) || 0),
    protectionPeriodDays: bounded(value.protectionPeriodDays, 90, 0, 36500),
    protectChannelItems: value.protectChannelItems !== false,
    excludeTags: cleanList(value.excludeTags, DEFAULT_SWEEP_SETTINGS.excludeTags),
    diskUsageThresholds: (Array.isArray(value.diskUsageThresholds) ? value.diskUsageThresholds : DEFAULT_SWEEP_SETTINGS.diskUsageThresholds)
      .map(row => ({ usagePercent: Math.max(1, Math.min(100, Number(row.usagePercent) || 0)), maxGraceDays: bounded(row.maxGraceDays, 1, 1, 3650) }))
      .sort((a, b) => a.usagePercent - b.usagePercent).slice(0, 10),
    tvCleanupMode: mode === 'keep_episodes' || mode === 'keep_seasons' ? mode : 'all',
    keepCount: bounded(value.keepCount, 1, 0, 1000),
    protectSpecials: value.protectSpecials !== false,
    taggingEnabled: value.taggingEnabled !== false,
    tagName: String(value.tagName ?? DEFAULT_SWEEP_SETTINGS.tagName).trim().slice(0, 100) || DEFAULT_SWEEP_SETTINGS.tagName,
    collectionsEnabled: value.collectionsEnabled !== false,
    movieCollectionName: String(value.movieCollectionName ?? DEFAULT_SWEEP_SETTINGS.movieCollectionName).trim().slice(0, 100) || DEFAULT_SWEEP_SETTINGS.movieCollectionName,
    tvCollectionName: String(value.tvCollectionName ?? DEFAULT_SWEEP_SETTINGS.tvCollectionName).trim().slice(0, 100) || DEFAULT_SWEEP_SETTINGS.tvCollectionName,
    warningDays: [...new Set((Array.isArray(value.warningDays) ? value.warningDays : DEFAULT_SWEEP_SETTINGS.warningDays).map(day => bounded(day, 1, 0, 3650)))].sort((a, b) => b - a),
    ntfy: { ...DEFAULT_SWEEP_SETTINGS.ntfy, ...(value.ntfy ?? {}) },
    email: { ...DEFAULT_SWEEP_SETTINGS.email, ...(value.email ?? {}) },
    webPush: { ...DEFAULT_SWEEP_SETTINGS.webPush, ...(value.webPush ?? {}) },
    libraryOverrides: overrides,
  }
}

export function effectiveSweepPolicy(libraryId: number, settings = getSweepSettings()): SweepSettings {
  return normalizeSweepSettings({ ...settings, ...(settings.libraryOverrides[String(libraryId)] ?? {}), libraryOverrides: settings.libraryOverrides })
}

type RuleRow = {
  id: number; target_type: LeavingSoonTargetType; target_id: number; enabled: number
  status: LeavingSoonItem['status']; watched_at: string | null; delete_after: string | null
  triggered_by_profile: string | null; last_error: string | null
}

function parseStoredDate(value: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`)
}

function assertTarget(type: string, id: number): asserts type is LeavingSoonTargetType {
  if (!['film_edition', 'series', 'season', 'episode'].includes(type) || !Number.isSafeInteger(id) || id < 1) throw new Error('A valid leaving-soon target is required')
}

function targetExists(type: LeavingSoonTargetType, id: number, db: Database): boolean {
  const table = type === 'film_edition' ? 'film_editions' : type === 'series' ? 'series' : type === 'season' ? 'seasons' : 'episodes'
  return !!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)
}

export function setLeavingSoonRule(type: string, id: number, enabled: boolean, db: Database = getDb()): LeavingSoonItem {
  assertTarget(type, id)
  if (!targetExists(type, id, db)) throw new Error('Library item not found')
  const settings = effectiveSweepPolicy(targetLibraryId(type, id, db), getSweepSettings(db))
  if (!enabled && settings.taggingEnabled) applySweepTag(type, id, settings.tagName, false, db)
  db.prepare(`
    INSERT INTO leaving_soon_rules (target_type, target_id, enabled, status, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(target_type, target_id) DO UPDATE SET enabled = excluded.enabled, status = excluded.status,
      watched_at = NULL, delete_after = NULL, deleted_at = NULL, last_error = NULL,
      triggered_by_profile = NULL, updated_at = datetime('now')
  `).run(type, id, enabled ? 1 : 0, enabled ? 'armed' : 'cancelled')
  if (enabled) reconcileLeavingSoon(db, type, id)
  recordEvent({ category: 'leaving-soon', action: enabled ? 'armed' : 'cancelled', subjectType: type, subjectId: String(id), message: enabled ? `Sweep enabled (${settings.graceDays}-day grace)` : 'Sweep cancelled' }, db)
  return getLeavingSoonItem(type, id, db)!
}

export function getLeavingSoonItem(type: string, id: number, db: Database = getDb()): LeavingSoonItem | null {
  assertTarget(type, id)
  const rule = db.prepare('SELECT * FROM leaving_soon_rules WHERE target_type = ? AND target_id = ?').get(type, id) as RuleRow | undefined
  return rule ? enrich(rule, db) : null
}

export function listLeavingSoon(options: { scheduledOnly?: boolean; includeInactive?: boolean } = {}, db: Database = getDb()): LeavingSoonItem[] {
  const clauses = [options.includeInactive ? '1=1' : 'enabled = 1']
  if (options.scheduledOnly) clauses.push("status = 'scheduled'")
  const rows = db.prepare(`SELECT * FROM leaving_soon_rules WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(delete_after, '9999-12-31'), created_at`).all() as RuleRow[]
  return rows.map(row => enrich(row, db)).filter((item): item is LeavingSoonItem => item !== null)
}

function enrich(rule: RuleRow, db: Database): LeavingSoonItem | null {
  let row: any
  if (rule.target_type === 'film_edition') row = db.prepare(`SELECT f.title, fe.edition_name AS subtitle, f.poster_path, f.backdrop_path, f.library_id FROM film_editions fe JOIN films f ON f.id = fe.film_id WHERE fe.id = ?`).get(rule.target_id)
  if (rule.target_type === 'series') row = db.prepare(`SELECT title, 'Entire series' AS subtitle, poster_path, backdrop_path, library_id FROM series WHERE id = ?`).get(rule.target_id)
  if (rule.target_type === 'season') row = db.prepare(`SELECT s.title, 'Season ' || se.season_number AS subtitle, COALESCE(se.poster_path, s.poster_path) AS poster_path, s.backdrop_path, s.library_id FROM seasons se JOIN series s ON s.id = se.series_id WHERE se.id = ?`).get(rule.target_id)
  if (rule.target_type === 'episode') row = db.prepare(`SELECT s.title, 'S' || printf('%02d', e.season_number) || 'E' || printf('%02d', e.episode_number) || CASE WHEN e.title IS NULL OR e.title = '' THEN '' ELSE ' · ' || e.title END AS subtitle, COALESCE(e.still_path, s.poster_path) AS poster_path, s.backdrop_path, s.library_id FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ?`).get(rule.target_id)
  if (!row) return null
  return {
    id: rule.id, targetType: rule.target_type, targetId: rule.target_id, enabled: !!rule.enabled, status: rule.status,
    title: row.title, subtitle: row.subtitle ?? null, posterUrl: row.poster_path ?? null, backdropUrl: row.backdrop_path ?? null,
    libraryId: Number(row.library_id), watchedAt: rule.watched_at, deleteAfter: rule.delete_after,
    daysRemaining: rule.delete_after ? Math.max(0, Math.ceil((parseStoredDate(rule.delete_after) - Date.now()) / 86_400_000)) : null,
    lastError: rule.last_error,
  }
}

function completedAt(type: LeavingSoonTargetType, id: number, db: Database): { profile: string; at: string } | null {
  if (type === 'film_edition') return db.prepare(`
    SELECT pp.profile_id AS profile, pp.updated_at AS at FROM film_editions fe JOIN films f ON f.id = fe.film_id
    JOIN playback_progress pp ON pp.media_type = 'film' AND pp.media_id = f.id AND pp.completed = 1
    WHERE fe.id = ? AND (pp.edition_id = fe.id OR (pp.edition_id IS NULL AND f.default_edition_id = fe.id))
    ORDER BY pp.updated_at DESC LIMIT 1
  `).get(id) as { profile: string; at: string } | null
  if (type === 'episode') return db.prepare(`SELECT profile_id AS profile, updated_at AS at FROM playback_progress WHERE media_type = 'episode' AND media_id = ? AND completed = 1 ORDER BY updated_at DESC LIMIT 1`).get(id) as { profile: string; at: string } | null
  const scope = type === 'season' ? 'e.season_id = ?' : 'e.series_id = ?'
  return db.prepare(`
    SELECT pp.profile_id AS profile, MAX(pp.updated_at) AS at FROM episodes e
    JOIN playback_progress pp ON pp.media_type = 'episode' AND pp.media_id = e.id AND pp.completed = 1
    WHERE ${scope} AND e.file_path IS NOT NULL GROUP BY pp.profile_id
    HAVING COUNT(DISTINCT e.id) = (SELECT COUNT(*) FROM episodes e WHERE ${scope} AND e.file_path IS NOT NULL)
      AND COUNT(DISTINCT e.id) > 0 ORDER BY at DESC LIMIT 1
  `).get(id, id) as { profile: string; at: string } | null
}

export function reconcileLeavingSoon(db: Database = getDb(), onlyType?: LeavingSoonTargetType, onlyId?: number): void {
  const settings = getSweepSettings(db)
  const rows = db.prepare(`SELECT * FROM leaving_soon_rules WHERE enabled = 1 AND status IN ('armed','scheduled','failed') ${onlyType ? 'AND target_type = ? AND target_id = ?' : ''}`).all(...(onlyType ? [onlyType, onlyId] : [])) as RuleRow[]
  for (const rule of rows) {
    const policy = effectiveSweepPolicy(targetLibraryId(rule.target_type, rule.target_id, db), settings)
    if (!settings.enabled || !policy.enabled) continue
    const completion = completedAt(rule.target_type, rule.target_id, db)
    if (!completion) {
      if (rule.status === 'scheduled') {
        if (policy.taggingEnabled) applySweepTag(rule.target_type, rule.target_id, policy.tagName, false, db)
        db.prepare("UPDATE leaving_soon_rules SET status = 'armed', watched_at = NULL, delete_after = NULL, triggered_by_profile = NULL, updated_at = datetime('now') WHERE id = ?").run(rule.id)
      }
      continue
    }
    if (rule.status === 'scheduled') continue
    const watchedAt = new Date(parseStoredDate(completion.at))
    const graceDays = effectiveGraceDays(targetLibraryId(rule.target_type, rule.target_id, db), policy, db)
    const deleteAfter = new Date(watchedAt.getTime() + graceDays * 86_400_000).toISOString()
    db.prepare("UPDATE leaving_soon_rules SET status = 'scheduled', watched_at = ?, delete_after = ?, triggered_by_profile = ?, last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(watchedAt.toISOString(), deleteAfter, completion.profile, rule.id)
    if (policy.taggingEnabled) applySweepTag(rule.target_type, rule.target_id, policy.tagName, true, db)
    recordEvent({ category: 'leaving-soon', action: 'scheduled', subjectType: rule.target_type, subjectId: String(rule.target_id), severity: 'warn', message: `Item scheduled for deletion on ${deleteAfter.slice(0, 10)}`, data: { deleteAfter, profileId: completion.profile } }, db)
  }
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

function nfoPaths(type: LeavingSoonTargetType, id: number, db: Database): Array<{ path: string; root: string }> {
  if (type === 'film_edition' || type === 'episode') {
    const root = type === 'film_edition' ? 'movie' : 'episodedetails'
    return mediaPaths(type, id, db).map(path => ({ path: join(dirname(path), `${basename(path, extname(path))}.nfo`), root }))
  }
  if (type === 'season') {
    return [...new Set(mediaPaths(type, id, db).map(path => join(dirname(path), 'season.nfo')))].map(path => ({ path, root: 'season' }))
  }
  const row = db.prepare('SELECT root_folder_path FROM series WHERE id = ?').get(id) as { root_folder_path: string | null } | undefined
  let folder = row?.root_folder_path ? resolve(row.root_folder_path) : commonDirectory(mediaPaths(type, id, db))
  if (folder && /^season\s*\d+$/i.test(basename(folder))) folder = dirname(folder)
  return folder ? [{ path: join(folder, 'tvshow.nfo'), root: 'tvshow' }] : []
}

function applySweepTag(type: LeavingSoonTargetType, id: number, tagName: string, add: boolean, db: Database): void {
  const roots = (db.prepare('SELECT path FROM root_folders').all() as Array<{ path: string }>).map(row => resolve(row.path))
  const encoded = escapeXml(tagName)
  const exactTag = new RegExp(`\\s*<tag>\\s*${escapeRegExp(encoded)}\\s*</tag>`, 'gi')
  for (const target of nfoPaths(type, id, db)) {
    if (!roots.some(root => isWithin(target.path, root))) continue
    try {
      let xml = existsSync(target.path) ? readFileSync(target.path, 'utf8') : `<?xml version="1.0" encoding="UTF-8"?>\n<${target.root}>\n</${target.root}>\n`
      xml = xml.replace(exactTag, '')
      if (add) {
        const closing = new RegExp(`</${target.root}>`, 'i')
        if (!closing.test(xml)) continue
        xml = xml.replace(closing, `  <tag>${encoded}</tag>\n</${target.root}>`)
      }
      writeFileSync(target.path, xml)
    } catch {
      // Tagging is optional metadata and must never block watch progress or deletion.
    }
  }
}

export function reconcilePlayback(mediaType: 'film' | 'episode', mediaId: number, db: Database = getDb()): void {
  if (mediaType === 'film') {
    for (const edition of db.prepare('SELECT id FROM film_editions WHERE film_id = ?').all(mediaId) as Array<{ id: number }>) reconcileLeavingSoon(db, 'film_edition', edition.id)
    return
  }
  reconcileLeavingSoon(db, 'episode', mediaId)
  const episode = db.prepare('SELECT season_id, series_id FROM episodes WHERE id = ?').get(mediaId) as { season_id: number; series_id: number } | undefined
  if (episode) { reconcileLeavingSoon(db, 'season', episode.season_id); reconcileLeavingSoon(db, 'series', episode.series_id) }
}

function mediaPaths(type: LeavingSoonTargetType, id: number, db: Database): string[] {
  if (type === 'film_edition') { const row = db.prepare('SELECT file_path FROM film_editions WHERE id = ?').get(id) as { file_path: string | null } | undefined; return row?.file_path ? [row.file_path] : [] }
  if (type === 'episode') { const row = db.prepare('SELECT file_path FROM episodes WHERE id = ?').get(id) as { file_path: string | null } | undefined; return row?.file_path ? [row.file_path] : [] }
  const column = type === 'season' ? 'season_id' : 'series_id'
  return (db.prepare(`SELECT file_path FROM episodes WHERE ${column} = ? AND file_path IS NOT NULL`).all(id) as Array<{ file_path: string }>).map(row => row.file_path)
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function commonDirectory(paths: string[]): string | null {
  if (!paths.length) return null
  let candidate = dirname(resolve(paths[0]))
  while (candidate !== dirname(candidate) && !paths.every(path => resolve(path) === candidate || isWithin(path, candidate))) candidate = dirname(candidate)
  return candidate
}

function removeFiles(type: LeavingSoonTargetType, paths: string[], db: Database): void {
  const roots = (db.prepare('SELECT path FROM root_folders').all() as Array<{ path: string }>).map(row => resolve(row.path))
  if (!roots.length) throw new Error('Deletion refused: no configured library root folder')
  for (const path of paths) if (!isAbsolute(path) || !roots.some(root => isWithin(path, root))) throw new Error(`Deletion refused outside configured library roots: ${path}`)
  const selected = new Set(paths.map(path => resolve(path)))
  const common = commonDirectory(paths)
  const folder = type === 'series' && common && /^season\s*\d+$/i.test(basename(common)) ? dirname(common) : common
  const registered = [
    ...(db.prepare('SELECT file_path FROM film_editions WHERE file_path IS NOT NULL').all() as Array<{ file_path: string }>),
    ...(db.prepare('SELECT file_path FROM films WHERE file_path IS NOT NULL').all() as Array<{ file_path: string }>),
    ...(db.prepare('SELECT file_path FROM episodes WHERE file_path IS NOT NULL').all() as Array<{ file_path: string }>),
  ].map(row => resolve(row.file_path))
  // An episode normally lives inside a shared season directory. It may remove
  // that directory only after the file deletion leaves it empty; recursive
  // directory removal is reserved for explicit film-edition/season/series rules.
  const safeFolder = type !== 'episode' && folder && !roots.includes(resolve(folder)) && !registered.some(path => !selected.has(path) && isWithin(path, folder))
  if (safeFolder && existsSync(folder)) { rmSync(folder, { recursive: true }); return }
  for (const path of selected) {
    if (existsSync(path)) rmSync(path)
    const sidecar = join(dirname(path), `${basename(path, extname(path))}.nfo`)
    if (existsSync(sidecar) && roots.some(root => isWithin(sidecar, root))) rmSync(sidecar)
  }
  for (const path of selected) {
    let parent = dirname(path)
    while (!roots.includes(parent) && roots.some(root => isWithin(parent, root)) && existsSync(parent) && statSync(parent).isDirectory() && readdirSync(parent).length === 0) { rmSync(parent); parent = dirname(parent) }
  }
}

function targetHasExcludedTag(type: LeavingSoonTargetType, id: number, tags: string[], db: Database): boolean {
  if (!tags.length) return false
  const wanted = new Set(tags.map(tag => tag.toLowerCase()))
  for (const target of nfoPaths(type, id, db)) {
    try {
      if (!existsSync(target.path)) continue
      const xml = readFileSync(target.path, 'utf8')
      for (const match of xml.matchAll(/<tag>\s*([^<]+?)\s*<\/tag>/gi)) if (wanted.has(match[1].trim().toLowerCase())) return true
    } catch {}
  }
  return false
}

function targetIsInChannel(type: LeavingSoonTargetType, id: number, db: Database): boolean {
  if (type === 'film_edition') {
    return !!db.prepare(`SELECT 1 FROM schedule_slots ss JOIN film_editions fe ON fe.film_id = ss.item_id WHERE ss.item_type = 'film' AND fe.id = ? AND ss.ends_at >= ? LIMIT 1`).get(id, Date.now())
  }
  if (type === 'episode') return !!db.prepare("SELECT 1 FROM schedule_slots WHERE item_type = 'episode' AND item_id = ? AND ends_at >= ? LIMIT 1").get(id, Date.now())
  const column = type === 'season' ? 'season_id' : 'series_id'
  return !!db.prepare(`SELECT 1 FROM schedule_slots ss JOIN episodes e ON ss.item_type = 'episode' AND ss.item_id = e.id WHERE e.${column} = ? AND ss.ends_at >= ? LIMIT 1`).get(id, Date.now())
}

function targetAddedAt(type: LeavingSoonTargetType, id: number, db: Database): string | null {
  if (type === 'film_edition') return (db.prepare('SELECT COALESCE(f.acquired_at, fe.added_at, f.added_at) AS at FROM film_editions fe JOIN films f ON f.id = fe.film_id WHERE fe.id = ?').get(id) as { at?: string } | undefined)?.at ?? null
  if (type === 'series') return (db.prepare('SELECT added_at AS at FROM series WHERE id = ?').get(id) as { at?: string } | undefined)?.at ?? null
  const table = type === 'season' ? 'seasons' : 'episodes'
  return (db.prepare(`SELECT s.added_at AS at FROM ${table} child JOIN series s ON s.id = child.series_id WHERE child.id = ?`).get(id) as { at?: string } | undefined)?.at ?? null
}

function protectionReason(rule: RuleRow, policy: SweepSettings, now: Date, db: Database): string | null {
  if (policy.protectChannelItems && targetIsInChannel(rule.target_type, rule.target_id, db)) return 'Scheduled in an Archivist Channel'
  if (targetHasExcludedTag(rule.target_type, rule.target_id, policy.excludeTags, db)) return 'Protected by an exclusion tag'
  return null
}

function notifySweep(kind: string, title: string, message: string, ruleId: number | null, profileId: string | null, settings: SweepSettings, db: Database): void {
  db.prepare('INSERT INTO sweep_notifications (profile_id, kind, title, message, rule_id) VALUES (?, ?, ?, ?, ?)').run(profileId, kind, title, message, ruleId)
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => { void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).catch(() => {}) }
  if (settings.ntfy.enabled && settings.ntfy.topic.trim()) {
    const url = `${settings.ntfy.serverUrl.replace(/\/$/, '')}/${encodeURIComponent(settings.ntfy.topic.trim())}`
    post(url, { topic: settings.ntfy.topic.trim(), title, message, tags: ['wastebasket'] }, settings.ntfy.token ? { authorization: `Bearer ${settings.ntfy.token}` } : {})
  }
  if (settings.email.enabled && settings.email.webhookUrl) post(settings.email.webhookUrl, { channel: 'email', kind, title, message, ruleId, profileId })
  if (settings.webPush.enabled && settings.webPush.webhookUrl) post(settings.webPush.webhookUrl, { channel: 'web-push', kind, title, message, ruleId, profileId })
}

export function requestSweepKeep(type: string, id: number, profileId = 'default', message = '', db: Database = getDb()): { item: LeavingSoonItem; pending: boolean } {
  assertTarget(type, id)
  const item = getLeavingSoonItem(type, id, db)
  if (!item) throw new Error('Sweep rule not found')
  const settings = getSweepSettings(db)
  if (!settings.requireKeepApproval) return { item: setLeavingSoonRule(type, id, false, db), pending: false }
  db.prepare("INSERT OR IGNORE INTO sweep_keep_requests (rule_id, profile_id, message, status) VALUES (?, ?, ?, 'pending')").run(item.id, profileId.trim().slice(0, 64) || 'default', message.trim().slice(0, 500) || null)
  notifySweep('keep-request', 'Keep requested', `${item.title}${item.subtitle ? ` · ${item.subtitle}` : ''}`, item.id, profileId, settings, db)
  return { item, pending: true }
}

export function listSweepKeepRequests(db: Database = getDb()): any[] {
  return db.prepare(`SELECT kr.*, r.target_type, r.target_id FROM sweep_keep_requests kr JOIN leaving_soon_rules r ON r.id = kr.rule_id ORDER BY CASE kr.status WHEN 'pending' THEN 0 ELSE 1 END, kr.created_at DESC`).all()
    .map((row: any) => ({ ...row, item: enrich(db.prepare('SELECT * FROM leaving_soon_rules WHERE id = ?').get(row.rule_id) as RuleRow, db) }))
}

export function decideSweepKeepRequest(id: number, decision: 'approved' | 'declined', decidedBy = 'admin', db: Database = getDb()): any {
  const request = db.prepare('SELECT * FROM sweep_keep_requests WHERE id = ?').get(id) as any
  if (!request) throw new Error('Keep request not found')
  db.prepare("UPDATE sweep_keep_requests SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(decision, decidedBy, id)
  const rule = db.prepare('SELECT * FROM leaving_soon_rules WHERE id = ?').get(request.rule_id) as RuleRow
  if (decision === 'approved') setLeavingSoonRule(rule.target_type, rule.target_id, false, db)
  const item = enrich(rule, db)
  notifySweep(`keep-${decision}`, decision === 'approved' ? 'Keep approved' : 'Keep declined', item?.title ?? 'Sweep item', rule.id, request.profile_id, getSweepSettings(db), db)
  return db.prepare('SELECT * FROM sweep_keep_requests WHERE id = ?').get(id)
}

export function listSweepNotifications(profileId?: string, db: Database = getDb()): any[] {
  return profileId
    ? db.prepare('SELECT * FROM sweep_notifications WHERE profile_id IS NULL OR profile_id = ? ORDER BY created_at DESC LIMIT 200').all(profileId)
    : db.prepare('SELECT * FROM sweep_notifications ORDER BY created_at DESC LIMIT 200').all()
}

export function sweepReport(db: Database = getDb()): any {
  const counts = db.prepare(`SELECT status, COUNT(*) AS count FROM leaving_soon_rules GROUP BY status`).all() as Array<{ status: string; count: number }>
  const totals = db.prepare('SELECT COALESCE(SUM(deleted),0) AS deleted, COALESCE(SUM(failed),0) AS failed, COALESCE(SUM(bytes_reclaimed),0) AS bytes FROM sweep_runs').get() as any
  const pendingBytes = listLeavingSoon({ scheduledOnly: true }, db).reduce((sum, item) => sum + mediaPaths(item.targetType, item.targetId, db).reduce((n, path) => { try { return n + statSync(path).size } catch { return n } }, 0), 0)
  return { counts: Object.fromEntries(counts.map(row => [row.status, row.count])), deleted: totals.deleted, failed: totals.failed, bytesReclaimed: totals.bytes, pendingBytes, runs: db.prepare('SELECT * FROM sweep_runs ORDER BY started_at DESC LIMIT 50').all() }
}

export function resetSweepTags(db: Database = getDb()): number {
  const settings = getSweepSettings(db)
  const rows = db.prepare("SELECT * FROM leaving_soon_rules WHERE status IN ('armed','scheduled','failed','cancelled')").all() as RuleRow[]
  for (const rule of rows) {
    const policy = effectiveSweepPolicy(targetLibraryId(rule.target_type, rule.target_id, db), settings)
    applySweepTag(rule.target_type, rule.target_id, policy.tagName, false, db)
  }
  return rows.length
}

export function reconcileSweepTags(db: Database = getDb()): number {
  resetSweepTags(db)
  const settings = getSweepSettings(db)
  const rows = db.prepare("SELECT * FROM leaving_soon_rules WHERE enabled = 1 AND status = 'scheduled'").all() as RuleRow[]
  for (const rule of rows) {
    const policy = effectiveSweepPolicy(targetLibraryId(rule.target_type, rule.target_id, db), settings)
    if (policy.taggingEnabled) applySweepTag(rule.target_type, rule.target_id, policy.tagName, true, db)
  }
  return rows.length
}

function deletionSelection(rule: RuleRow, policy: SweepSettings, db: Database): { paths: string[]; episodeIds: number[] | null } {
  if (rule.target_type !== 'series' || (policy.tvCleanupMode === 'all' && !policy.protectSpecials)) return { paths: mediaPaths(rule.target_type, rule.target_id, db), episodeIds: null }
  const episodes = db.prepare('SELECT id, season_number, episode_number, file_path FROM episodes WHERE series_id = ? AND file_path IS NOT NULL ORDER BY season_number, episode_number').all(rule.target_id) as Array<{ id: number; season_number: number; episode_number: number; file_path: string }>
  const regular = episodes.filter(ep => ep.season_number !== 0)
  const protectedIds = new Set<number>(policy.protectSpecials ? episodes.filter(ep => ep.season_number === 0).map(ep => ep.id) : [])
  if (policy.tvCleanupMode === 'keep_episodes') for (const ep of regular.slice(0, policy.keepCount)) protectedIds.add(ep.id)
  if (policy.tvCleanupMode === 'keep_seasons') {
    const seasons = [...new Set(regular.map(ep => ep.season_number))].slice(0, policy.keepCount)
    for (const ep of regular) if (seasons.includes(ep.season_number)) protectedIds.add(ep.id)
  }
  const selected = episodes.filter(ep => !protectedIds.has(ep.id))
  return { paths: selected.map(ep => ep.file_path), episodeIds: selected.map(ep => ep.id) }
}

function clearDatabaseMedia(type: LeavingSoonTargetType, id: number, db: Database, episodeIds: number[] | null = null): void {
  if (type === 'film_edition') {
    const edition = db.prepare('SELECT film_id FROM film_editions WHERE id = ?').get(id) as { film_id: number }
    db.prepare("UPDATE film_editions SET file_path = NULL, file_size = NULL, status = 'uncollected', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(id)
    const remaining = db.prepare('SELECT id, file_path FROM film_editions WHERE film_id = ? AND file_path IS NOT NULL ORDER BY id').get(edition.film_id) as { id: number; file_path: string } | undefined
    db.prepare("UPDATE films SET file_path = ?, file_size = NULL, status = ?, monitored = CASE WHEN ? IS NULL THEN 0 ELSE monitored END, default_edition_id = ?, updated_at = datetime('now') WHERE id = ?").run(remaining?.file_path ?? null, remaining ? 'collected' : 'uncollected', remaining?.id ?? null, remaining?.id ?? null, edition.film_id)
    return
  }
  const clearEpisodes = "file_path = NULL, file_size = NULL, status = 'ignored', monitored = 0, upgrade_allowed = 0, episode_file_id = NULL, info_hash = NULL, download_progress = 0, updated_at = datetime('now')"
  if (type === 'episode') db.prepare(`UPDATE episodes SET ${clearEpisodes} WHERE id = ?`).run(id)
  if (type === 'season') { db.prepare("UPDATE seasons SET monitored = 0, upgrade_allowed = 0, info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE id = ?").run(id); db.prepare(`UPDATE episodes SET ${clearEpisodes} WHERE season_id = ?`).run(id) }
  if (type === 'series' && episodeIds === null) { db.prepare("UPDATE series SET monitored = 0, upgrade_allowed = 0, updated_at = datetime('now') WHERE id = ?").run(id); db.prepare("UPDATE seasons SET monitored = 0, upgrade_allowed = 0, info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE series_id = ?").run(id); db.prepare(`UPDATE episodes SET ${clearEpisodes} WHERE series_id = ?`).run(id) }
  if (type === 'series' && episodeIds !== null) {
    const clear = db.prepare(`UPDATE episodes SET ${clearEpisodes} WHERE id = ?`)
    for (const episodeId of episodeIds) clear.run(episodeId)
    db.prepare("UPDATE seasons SET monitored = 0, upgrade_allowed = 0, updated_at = datetime('now') WHERE series_id = ? AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.season_id = seasons.id AND e.file_path IS NOT NULL)").run(id)
  }
  db.prepare('DELETE FROM episode_files WHERE id NOT IN (SELECT episode_file_id FROM episodes WHERE episode_file_id IS NOT NULL)').run()
}

export function evaluateSweepCandidates(db: Database = getDb(), now = new Date()): { evaluated: number; armed: number; skipped: number } {
  const settings = getSweepSettings(db)
  if (!settings.enabled || !settings.autoEligibilityEnabled) return { evaluated: 0, armed: 0, skipped: 0 }
  const candidates: Array<{ type: LeavingSoonTargetType; id: number; libraryId: number; releasedAt: string | null; addedAt: string | null; size: number; lastWatchedAt: string | null }> = []
  for (const row of db.prepare(`
    SELECT fe.id, f.library_id, COALESCE(fe.release_date, f.release_date, CASE WHEN f.year IS NOT NULL THEN f.year || '-01-01' END) AS released_at,
      COALESCE(f.acquired_at, fe.added_at, f.added_at) AS added_at, COALESCE(fe.file_size, f.file_size, 0) AS size,
      (SELECT MAX(pp.updated_at) FROM playback_progress pp WHERE pp.media_type = 'film' AND pp.media_id = f.id) AS last_watched_at
    FROM film_editions fe JOIN films f ON f.id = fe.film_id
    WHERE fe.file_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leaving_soon_rules r WHERE r.target_type = 'film_edition' AND r.target_id = fe.id AND r.enabled = 1)
  `).all() as any[]) candidates.push({ type: 'film_edition', id: row.id, libraryId: row.library_id, releasedAt: row.released_at, addedAt: row.added_at, size: Number(row.size) || 0, lastWatchedAt: row.last_watched_at })
  for (const row of db.prepare(`
    SELECT s.id, s.library_id, CASE WHEN s.year IS NOT NULL THEN s.year || '-01-01' END AS released_at, s.added_at,
      COALESCE((SELECT SUM(e.file_size) FROM episodes e WHERE e.series_id = s.id AND e.file_path IS NOT NULL), 0) AS size,
      (SELECT MAX(pp.updated_at) FROM playback_progress pp JOIN episodes e ON pp.media_type = 'episode' AND pp.media_id = e.id WHERE e.series_id = s.id) AS last_watched_at
    FROM series s WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = s.id AND e.file_path IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM leaving_soon_rules r WHERE r.target_type = 'series' AND r.target_id = s.id AND r.enabled = 1)
  `).all() as any[]) candidates.push({ type: 'series', id: row.id, libraryId: row.library_id, releasedAt: row.released_at, addedAt: row.added_at, size: Number(row.size) || 0, lastWatchedAt: row.last_watched_at })

  let armed = 0
  for (const candidate of candidates) {
    const policy = effectiveSweepPolicy(candidate.libraryId, settings)
    if (!policy.enabled || !policy.autoEligibilityEnabled) continue
    if (candidate.size < policy.minimumSizeGb * 1024 ** 3) continue
    if (candidate.releasedAt && now.getTime() - parseStoredDate(candidate.releasedAt) < policy.contentAgeDays * 86_400_000) continue
    if (candidate.addedAt && now.getTime() - parseStoredDate(candidate.addedAt) < policy.protectionPeriodDays * 86_400_000) continue
    if (candidate.lastWatchedAt && now.getTime() - parseStoredDate(candidate.lastWatchedAt) < policy.lastWatchedDays * 86_400_000) continue
    const rule = { target_type: candidate.type, target_id: candidate.id } as RuleRow
    if (protectionReason(rule, policy, now, db)) continue
    if (!settings.dryRun) setLeavingSoonRule(candidate.type, candidate.id, true, db)
    armed++
  }
  const result = { evaluated: candidates.length, armed, skipped: candidates.length - armed }
  db.prepare("INSERT INTO sweep_runs (mode, dry_run, evaluated, scheduled, details, finished_at) VALUES ('evaluation', ?, ?, ?, ?, datetime('now'))").run(settings.dryRun ? 1 : 0, result.evaluated, result.armed, JSON.stringify(result))
  return result
}

export function sweepLeavingSoon(db: Database = getDb(), now = new Date()): { deleted: number; failed: number; protected: number; dryRun: boolean; bytesReclaimed: number } {
  const settings = getSweepSettings(db)
  if (!settings.enabled) return { deleted: 0, failed: 0, protected: 0, dryRun: settings.dryRun, bytesReclaimed: 0 }
  evaluateSweepCandidates(db, now)
  reconcileLeavingSoon(db)
  for (const item of listLeavingSoon({ scheduledOnly: true }, db)) {
    const days = item.daysRemaining ?? -1
    if (!settings.warningDays.includes(days)) continue
    const kind = `warning-${days}`
    const exists = db.prepare('SELECT id FROM sweep_notifications WHERE rule_id = ? AND kind = ?').get(item.id, kind)
    if (!exists) notifySweep(kind, `${item.title} leaves in ${days} day${days === 1 ? '' : 's'}`, item.subtitle ?? 'Choose Keep to cancel deletion.', item.id, null, settings, db)
  }
  const due = db.prepare("SELECT * FROM leaving_soon_rules WHERE enabled = 1 AND status = 'scheduled' AND delete_after <= ? ORDER BY delete_after").all(now.toISOString()) as RuleRow[]
  const runId = Number(db.prepare("INSERT INTO sweep_runs (mode, dry_run, evaluated) VALUES ('deletion', ?, ?)").run(settings.dryRun ? 1 : 0, due.length).lastInsertRowid)
  let deleted = 0; let failed = 0; let protectedCount = 0; let bytesReclaimed = 0
  for (const rule of due) {
    try {
      const policy = effectiveSweepPolicy(targetLibraryId(rule.target_type, rule.target_id, db), settings)
      const reason = protectionReason(rule, policy, now, db)
      if (reason) {
        protectedCount++
        recordEvent({ category: 'leaving-soon', action: 'protected', subjectType: rule.target_type, subjectId: String(rule.target_id), message: reason }, db)
        continue
      }
      if (settings.manualReviewRequired) {
        const review = db.prepare("SELECT * FROM sweep_keep_requests WHERE rule_id = ? AND profile_id = '__deletion_review__' ORDER BY id DESC LIMIT 1").get(rule.id) as any
        if (!review) {
          db.prepare("INSERT INTO sweep_keep_requests (rule_id, profile_id, message, status) VALUES (?, '__deletion_review__', 'Final Keep or Sweep review', 'pending')").run(rule.id)
          notifySweep('review-required', 'Sweep review required', enrich(rule, db)?.title ?? 'Item ready for deletion', rule.id, null, settings, db)
          protectedCount++
          continue
        }
        if (review.status !== 'declined') { protectedCount++; continue }
      }
      const selection = deletionSelection(rule, policy, db)
      const paths = selection.paths
      if (!paths.length) {
        if (selection.episodeIds !== null) {
          protectedCount++
          recordEvent({ category: 'leaving-soon', action: 'protected', subjectType: rule.target_type, subjectId: String(rule.target_id), message: 'TV retention policy protects every remaining file' }, db)
          continue
        }
        throw new Error('No media file is registered for this item')
      }
      const bytes = paths.reduce((sum, path) => { try { return sum + statSync(path).size } catch { return sum } }, 0)
      if (settings.dryRun) { deleted++; bytesReclaimed += bytes; continue }
      db.prepare("UPDATE leaving_soon_rules SET status = 'deleting', updated_at = datetime('now') WHERE id = ?").run(rule.id)
      removeFiles(rule.target_type, paths, db)
      db.transaction(() => { clearDatabaseMedia(rule.target_type, rule.target_id, db, selection.episodeIds); db.prepare("UPDATE leaving_soon_rules SET status = 'deleted', enabled = 0, deleted_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(rule.id) })()
      deleted++
      bytesReclaimed += bytes
      recordEvent({ category: 'leaving-soon', action: 'deleted', severity: 'warn', subjectType: rule.target_type, subjectId: String(rule.target_id), message: 'Leaving Soon media and its safe containing folder were deleted', data: { paths } }, db)
      notifySweep('deleted', 'Sweep completed', enrich(rule, db)?.title ?? 'Media deleted', rule.id, null, settings, db)
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      db.prepare("UPDATE leaving_soon_rules SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message, rule.id)
      recordEvent({ category: 'leaving-soon', action: 'failed', severity: 'error', subjectType: rule.target_type, subjectId: String(rule.target_id), message, data: { ruleId: rule.id } }, db)
    }
  }
  db.prepare("UPDATE sweep_runs SET deleted = ?, failed = ?, bytes_reclaimed = ?, details = ?, finished_at = datetime('now') WHERE id = ?").run(deleted, failed, bytesReclaimed, JSON.stringify({ protected: protectedCount }), runId)
  return { deleted, failed, protected: protectedCount, dryRun: settings.dryRun, bytesReclaimed }
}
