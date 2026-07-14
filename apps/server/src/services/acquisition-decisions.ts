import type { Database } from 'better-sqlite3'
import { scoreRelease, makeReleaseScorer, type ScoredRelease } from '@archivist/core'
import { getDb } from '../db.js'
import { getTierTermsForMedia, getRejectRules, type TierMediaType } from '../shared/settings.js'
import { resolveIndexerPriority } from './indexer-bridge.js'
import { normalizeTitle } from '../release-pipeline/parser.js'
import {
  compareQuality, parseQualityFromTitle, guardrailDistance, absoluteQuality, makeRejectMatcher,
  type QualitySnapshot, type CandidateQuality, type QualityTarget, type RejectMatcher,
} from './quality.js'

export interface CandidateRelease {
  guid?: string
  title: string
  downloadUrl: string
  size?: number
  seeders?: number
  leechers?: number
  publishDate?: string
  indexerName?: string
  indexerPriority?: number
}

export interface ReleaseDecision {
  release: CandidateRelease
  accepted: boolean
  score: number
  customTier: number
  /** Parsed quality of the release — carried so chooseBestRelease can rank by guardrail distance. */
  quality: CandidateQuality
  reasons: string[]
  rejectionReasons: string[]
}

export interface DecisionContext {
  source: 'rss' | 'manual' | 'auto-grab'
  tabId?: number
  tabName?: string
  mediaType: string
  subjectType: string
  subjectId?: string | number
  subjectTitle: string
  year?: number | null
  targetTier?: string | number | null
  targetResolution?: string | null
  targetSource?: string | null
  targetCodec?: string | null
  manualFilters?: boolean
  requireGameReleaseTerms?: boolean
  currentQuality?: Partial<QualitySnapshot> | null
  upgradeAllowed?: boolean
  isCollected?: boolean
}

let migrated = false

export function initAcquisitionStore(db: Database = getDb()): void {
  if (migrated) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS acquisition_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,
      tab_id INTEGER,
      tab_name TEXT,
      media_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT,
      subject_title TEXT NOT NULL,
      release_guid TEXT,
      release_title TEXT NOT NULL,
      download_url TEXT NOT NULL,
      indexer_name TEXT,
      indexer_priority INTEGER,
      size_bytes INTEGER,
      seeders INTEGER,
      leechers INTEGER,
      publish_date TEXT,
      accepted INTEGER NOT NULL,
      score INTEGER NOT NULL,
      custom_tier INTEGER NOT NULL,
      reasons TEXT NOT NULL,
      rejection_reasons TEXT NOT NULL,
      grabbed INTEGER NOT NULL DEFAULT 0,
      grab_result TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_acquisition_decisions_subject
      ON acquisition_decisions(media_type, subject_type, subject_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_acquisition_decisions_release
      ON acquisition_decisions(release_guid, release_title);

    CREATE TABLE IF NOT EXISTS release_blocklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      info_hash TEXT,
      release_guid TEXT,
      download_url TEXT,
      release_title TEXT NOT NULL,
      reason TEXT NOT NULL,
      tab_id INTEGER,
      media_type TEXT,
      subject_type TEXT,
      subject_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_release_blocklist_hash
      ON release_blocklist(info_hash);
    CREATE INDEX IF NOT EXISTS idx_release_blocklist_guid
      ON release_blocklist(release_guid);
  `)
  migrated = true
}

export function extractInfoHash(value: string | null | undefined): string | null {
  if (!value) return null
  const match = value.match(/btih:([a-zA-Z0-9]{32,40})/i) ?? value.match(/\b([a-fA-F0-9]{40})\b/)
  return match ? match[1].toLowerCase() : null
}

export function normaliseTitle(s: string | null | undefined): string {
  return normalizeTitle(s ?? '')
}

export function parseTargetTier(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (!value) return null
  if (String(value).toLowerCase() === 'any') return null
  const match = String(value).match(/\d+/)
  return match ? parseInt(match[0], 10) : null
}

function hasForeignOnlyLanguage(title: string): boolean {
  return /french|italian|spanish|german|russian/i.test(title) && !/multi|dual|en|eng/i.test(title)
}

function matchesYear(title: string, year?: number | null): boolean {
  if (!year) return true
  const yearStr = String(year)
  if (title.includes(yearStr) || title.includes(String(year - 1)) || title.includes(String(year + 1))) return true
  const found = title.match(/\b(19|20)\d{2}\b/)
  return !found || found[0] === yearStr
}

export function evaluateRelease(
  ctx: DecisionContext,
  release: CandidateRelease,
  scorer: (title: string) => ScoredRelease = scoreRelease,
  rejectMatcher?: RejectMatcher,
): ReleaseDecision {
  const scored = scorer(release.title)
  const parsedQuality = parseQualityFromTitle(release.title, scorer)
  const targetTier = parseTargetTier(ctx.targetTier)
  const reasons: string[] = []
  const rejectionReasons: string[] = []
  const nSubject = normaliseTitle(ctx.subjectTitle)
  const nRelease = normaliseTitle(release.title)

  if (nSubject.length < 2 || !nRelease.includes(nSubject)) {
    rejectionReasons.push('title mismatch')
  } else {
    reasons.push('title match')
  }

  if (!matchesYear(release.title.toLowerCase(), ctx.year)) rejectionReasons.push('year mismatch')
  else if (ctx.year) reasons.push('year match')

  if (hasForeignOnlyLanguage(release.title)) rejectionReasons.push('foreign language without multi/english marker')
// Group tier is a SOFT ranking signal, not a gate: a tier mismatch never
// rejects a release (that recreated the "wanted release never grabbed" miss).
// chooseBestRelease sorts by guardrail distance then group tier, so a better
// tier still wins when quality is equal — without dropping anything.
if (targetTier !== null && scored.tier === targetTier) {
  reasons.push(`target tier ${targetTier}`)
} else if (scored.tier > 0) {
  reasons.push(`tier ${scored.tier}`)
}

// Manual Quality Filters (from Missing Search modal) — the one explicit HARD
// floor: when the user ticks filters, off-target releases are rejected outright.
if (ctx.manualFilters) {
  if (ctx.targetResolution && parsedQuality.resolution !== ctx.targetResolution) {
    rejectionReasons.push(`resolution ${parsedQuality.resolution || 'unknown'} does not match requested ${ctx.targetResolution}`)
  }
  if (ctx.targetSource && parsedQuality.source !== ctx.targetSource) {
    rejectionReasons.push(`source ${parsedQuality.source || 'unknown'} does not match requested ${ctx.targetSource}`)
  }
  if (ctx.targetCodec && parsedQuality.codec !== ctx.targetCodec) {
    rejectionReasons.push(`codec ${parsedQuality.codec || 'unknown'} does not match requested ${ctx.targetCodec}`)
  }
}

const current = ctx.currentQuality

  if (ctx.requireGameReleaseTerms && !/repack|flt|dodi|fitgirl|iso|gog/i.test(release.title)) {
    rejectionReasons.push('missing trusted game release marker')
  }

  // Reject rules — the explicit hard floor (CAM/screener junk, banned groups,
  // resolution floor). Applies even in soft-guardrail auto mode.
  const rejectReason = rejectMatcher?.(release.title, parsedQuality)
  if (rejectReason) rejectionReasons.push(rejectReason)

  if (ctx.isCollected) {
    if (ctx.upgradeAllowed === false) {
      rejectionReasons.push('item upgrades disabled')
    } else {
      const upgrade = compareQuality(ctx.currentQuality, parsedQuality)
      if (!upgrade.isUpgrade) rejectionReasons.push('no quality improvement over current file')
      else reasons.push(...upgrade.reasons)
    }
  }

  const seedScore = Math.min(release.seeders ?? 0, 100)
  // Resolve the indexer's per-media-type priority now that the media type is
  // known — RSS-sourced releases arrive stamped with only the global priority.
  const effectivePriority = release.indexerName
    ? resolveIndexerPriority(release.indexerName, ctx.mediaType)
    : (release.indexerPriority ?? 25)
  const priorityScore = Math.max(0, 100 - effectivePriority)
  const score = scored.score + seedScore + priorityScore

  if (release.seeders !== undefined) reasons.push(`${release.seeders} seeders`)
  if (release.indexerName) reasons.push(`indexer ${release.indexerName}`)

  try {
    const blocked = findBlockedRelease(ctx, release)
    if (blocked) rejectionReasons.push(`release blocked: ${blocked.reason}`)
  } catch {
    // Acquisition decisions should never fail because the audit/blocklist store is unavailable.
  }

  return {
    release,
    accepted: rejectionReasons.length === 0,
    score,
    customTier: scored.tier,
    quality: parsedQuality,
    reasons,
    rejectionReasons,
  }
}

/** Build a tier scorer honouring the library's configured (UI) tiers. */
function scorerForContext(ctx: DecisionContext): (title: string) => ScoredRelease {
  try {
    const tiers = getTierTermsForMedia(ctx.mediaType as TierMediaType, ctx.tabId ?? 0)
    return makeReleaseScorer(tiers)
  } catch {
    return scoreRelease
  }
}

export function blockRelease(input: {
  infoHash?: string | null
  releaseGuid?: string | null
  downloadUrl?: string | null
  releaseTitle: string
  reason: string
  tabId?: number | null
  mediaType?: string | null
  subjectType?: string | null
  subjectId?: string | number | null
}, db: Database = getDb()): void {
  initAcquisitionStore(db)
  const infoHash = (input.infoHash ?? extractInfoHash(input.downloadUrl) ?? extractInfoHash(input.releaseGuid))?.toLowerCase() ?? null
  const existing = infoHash
    ? db.prepare('SELECT id FROM release_blocklist WHERE info_hash = ? LIMIT 1').get(infoHash)
    : null
  if (existing) return

  db.prepare(`
    INSERT INTO release_blocklist (
      info_hash, release_guid, download_url, release_title, reason,
      tab_id, media_type, subject_type, subject_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    infoHash,
    input.releaseGuid ?? null,
    input.downloadUrl ?? null,
    input.releaseTitle,
    input.reason,
    input.tabId ?? null,
    input.mediaType ?? null,
    input.subjectType ?? null,
    input.subjectId !== undefined && input.subjectId !== null ? String(input.subjectId) : null,
  )
}

export function findBlockedRelease(ctx: DecisionContext, release: CandidateRelease, db: Database = getDb()): { reason: string } | null {
  initAcquisitionStore(db)
  const infoHash = extractInfoHash(release.downloadUrl) ?? extractInfoHash(release.guid)
  const row = infoHash
    ? db.prepare('SELECT reason FROM release_blocklist WHERE info_hash = ? LIMIT 1').get(infoHash)
    : null
  if (row) return row as { reason: string }

  if (release.guid) {
    const byGuid = db.prepare(`
      SELECT reason FROM release_blocklist
      WHERE release_guid = ?
        AND (subject_id IS NULL OR subject_id = ?)
      LIMIT 1
    `).get(release.guid, ctx.subjectId !== undefined ? String(ctx.subjectId) : null)
    if (byGuid) return byGuid as { reason: string }
  }

  const byUrl = db.prepare(`
    SELECT reason FROM release_blocklist
    WHERE download_url = ?
      AND (subject_id IS NULL OR subject_id = ?)
    LIMIT 1
  `).get(release.downloadUrl, ctx.subjectId !== undefined ? String(ctx.subjectId) : null)
  return (byUrl as { reason: string } | undefined) ?? null
}

export function chooseBestRelease(ctx: DecisionContext, releases: CandidateRelease[]): ReleaseDecision | null {
  const scorer = scorerForContext(ctx)
  const rejectMatcher = makeRejectMatcher(getRejectRules(ctx.tabId ?? 0))
  const target: QualityTarget = {
    resolution: ctx.targetResolution,
    source: ctx.targetSource,
    codec: ctx.targetCodec,
  }
  const decisions = releases.map(r => evaluateRelease(ctx, r, scorer, rejectMatcher))
  const accepted = decisions.filter(d => d.accepted).sort((a, b) => {
    // 1. Closest to the guardrail quality target wins.
    const da = guardrailDistance(a.quality, target)
    const db = guardrailDistance(b.quality, target)
    if (da !== db) return da - db
    // 2. Better group tier (1 best; 0 = unrecognised, sorts last).
    const ta = a.customTier || 4
    const tb = b.customTier || 4
    if (ta !== tb) return ta - tb
    // 3. Higher absolute quality when equally close to target.
    const qa = absoluteQuality(a.quality)
    const qb = absoluteQuality(b.quality)
    if (qa !== qb) return qb - qa
    // 4. Composite score (indexer priority + seeders), then raw seeders.
    if (a.score !== b.score) return b.score - a.score
    return (b.release.seeders ?? 0) - (a.release.seeders ?? 0)
  })
  return accepted[0] ?? null
}

export function recordReleaseDecision(ctx: DecisionContext, decision: ReleaseDecision, db: Database = getDb()): number {
  initAcquisitionStore(db)
  const r = decision.release
  const result = db.prepare(`
    INSERT INTO acquisition_decisions (
      source, tab_id, tab_name, media_type, subject_type, subject_id, subject_title,
      release_guid, release_title, download_url, indexer_name, indexer_priority,
      size_bytes, seeders, leechers, publish_date, accepted, score, custom_tier,
      reasons, rejection_reasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ctx.source,
    ctx.tabId ?? null,
    ctx.tabName ?? null,
    ctx.mediaType,
    ctx.subjectType,
    ctx.subjectId !== undefined ? String(ctx.subjectId) : null,
    ctx.subjectTitle,
    r.guid ?? null,
    r.title,
    r.downloadUrl,
    r.indexerName ?? null,
    r.indexerPriority ?? null,
    r.size ?? null,
    r.seeders ?? null,
    r.leechers ?? null,
    r.publishDate ?? null,
    decision.accepted ? 1 : 0,
    decision.score,
    decision.customTier,
    JSON.stringify(decision.reasons),
    JSON.stringify(decision.rejectionReasons),
  )
  return Number(result.lastInsertRowid)
}

export function markDecisionGrabbed(id: number, result: unknown, db: Database = getDb()): void {
  initAcquisitionStore(db)
  db.prepare('UPDATE acquisition_decisions SET grabbed = 1, grab_result = ? WHERE id = ?')
    .run(JSON.stringify(result ?? {}), id)
}

export function listAcquisitionDecisions(limit = 200, db: Database = getDb()) {
  initAcquisitionStore(db)
  return db.prepare(`
    SELECT * FROM acquisition_decisions
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 1000)))
}

export function listReleaseBlocklist(limit = 200, db: Database = getDb()) {
  initAcquisitionStore(db)
  return db.prepare(`
    SELECT * FROM release_blocklist
    ORDER BY id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 1000)))
}

export function unblockRelease(id: number, db: Database = getDb()): boolean {
  initAcquisitionStore(db)
  const result = db.prepare('DELETE FROM release_blocklist WHERE id = ?').run(id)
  return result.changes > 0
}

export function listSubjectAcquisitionHistory(input: {
  mediaType: string
  subjectType: string
  subjectId: string | number
}, limit = 100, db: Database = getDb()) {
  initAcquisitionStore(db)
  const subjectId = String(input.subjectId)
  return {
    decisions: db.prepare(`
      SELECT * FROM acquisition_decisions
      WHERE media_type = ? AND subject_type = ? AND subject_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(input.mediaType, input.subjectType, subjectId, Math.max(1, Math.min(limit, 500))),
    blocks: db.prepare(`
      SELECT * FROM release_blocklist
      WHERE media_type = ?
        AND subject_type = ?
        AND subject_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(input.mediaType, input.subjectType, subjectId, Math.max(1, Math.min(limit, 500))),
  }
}

/**
 * Aggregated acquisition history across many child subjects — used by container
 * pages (a series' episodes, an artist's albums, an author's books, a comic
 * series' issues) to show one combined "Acquisitions" view.
 */
export function listAcquisitionHistoryForSubjectIds(input: {
  mediaType: string
  subjectType: string
  subjectIds: Array<string | number>
}, limit = 300, db: Database = getDb()) {
  initAcquisitionStore(db)
  const ids = [...new Set(input.subjectIds.map(String))]
  if (ids.length === 0) return { decisions: [], blocks: [] }
  const placeholders = ids.map(() => '?').join(',')
  const lim = Math.max(1, Math.min(limit, 500))
  return {
    decisions: db.prepare(`
      SELECT * FROM acquisition_decisions
      WHERE media_type = ? AND subject_type = ? AND subject_id IN (${placeholders})
      ORDER BY id DESC LIMIT ?
    `).all(input.mediaType, input.subjectType, ...ids, lim),
    blocks: db.prepare(`
      SELECT * FROM release_blocklist
      WHERE media_type = ? AND subject_type = ? AND subject_id IN (${placeholders})
      ORDER BY id DESC LIMIT ?
    `).all(input.mediaType, input.subjectType, ...ids, lim),
  }
}
