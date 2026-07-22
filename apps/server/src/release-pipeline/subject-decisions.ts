/**
 * Per-subject decide-and-grab. Each function operates on a single monitored
 * subject (one film, one episode, one season, one album, one game) and a list
 * of candidate releases that have already been identified to that subject.
 *
 * This replaces the old `matchAndGrab*` matchers in `rss-monitor.ts`. The old
 * matchers iterated all monitored items × all results (O(items × releases)
 * with string-includes). The new shape lets the pipeline parse + identify
 * once, group candidates by subject, and call the right decision function
 * O(1) per identified release.
 */

import { createLogger } from '@archivist/core'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { ScopedDownloadClientStore } from '../shared/download-clients.js'
import { sendToDownloadClient } from '../services/download-manager.js'
import {
  chooseBestRelease,
  evaluateRelease,
  markDecisionGrabbed,
  recordReleaseDecision,
  type CandidateRelease,
  type DecisionContext,
} from '../services/acquisition-decisions.js'
import type { ParsedRelease } from './parser.js'
import type { SubjectRef } from './title-index.js'

const logger = createLogger('SubjectDecisions')

export interface IdentifiedRelease {
  release: CandidateRelease
  parsed: ParsedRelease
}

export interface DecideResult {
  grabbed: number
  rejected: number
}

interface TabDb {
  db: Database
  client: any
  hasClient: boolean
}

const tabCache = new Map<number, TabDb>()

/** Library-scoped view over the unified DB with that library's best client. */
function openTab(subject: SubjectRef): TabDb | null {
  const cached = tabCache.get(subject.tabId)
  if (cached) return cached
  const db = getDb()
  const downloadClientStore = new ScopedDownloadClientStore(db, subject.tabId)
  const clients = downloadClientStore.getEnabled()
  const tabDb: TabDb = { db, client: clients[0], hasClient: clients.length > 0 }
  tabCache.set(subject.tabId, tabDb)
  return tabDb
}

export function clearTabCache(): void {
  tabCache.clear()
}

function recordCandidateSet(ctx: DecisionContext, candidates: CandidateRelease[]) {
  return candidates.map(release => {
    const decision = evaluateRelease(ctx, release)
    return { decisionId: recordReleaseDecision(ctx, decision), decision }
  })
}

function requireSuccessfulGrab(result: { success?: boolean; message?: string }): void {
  if (!result.success) throw new Error(result.message || 'Download client rejected the release')
}

// ── Films ─────────────────────────────────────────────────────────────────────

export async function decideFilm(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const film = tab.db.prepare(`
    SELECT id, title, year, status, monitored, target_tier, target_resolution, target_source, target_codec,
           minimum_tier, minimum_resolution, minimum_source, minimum_codec, upgrade_allowed, current_tier, current_resolution,
           current_source, current_codec, current_release_group, current_edition, current_size_bytes,
           current_release_title
    FROM films WHERE id = ?
  `).get(subject.subjectId) as any
  if (!film || film.monitored !== 1) return { grabbed: 0, rejected: candidates.length }

  const wanted = film.status === 'wanted' || film.status === 'missing'
    || (film.status === 'collected' && (film.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const isCollected = film.status === 'collected'
  const ctx: DecisionContext = {
    source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
    tabId: subject.tabId,
    tabName: subject.tabName,
    mediaType: 'films',
    subjectType: 'film',
    subjectId: film.id,
    subjectTitle: film.title,
    year: film.year,
    targetTier: overrides?.targetTier ?? film.target_tier,
    targetResolution: overrides?.targetResolution ?? film.target_resolution,
    targetSource: overrides?.targetSource ?? film.target_source,
    targetCodec: overrides?.targetCodec ?? film.target_codec,
    minimumTier: film.minimum_tier,
    minimumResolution: film.minimum_resolution,
    minimumSource: film.minimum_source,
    minimumCodec: film.minimum_codec,
    enforceTargetFloor: !overrides?.manualFilters,
    manualFilters: overrides?.manualFilters,
    isCollected,
    upgradeAllowed: film.upgrade_allowed !== 0,
    currentQuality: isCollected ? film : null,
  }

  const releases = candidates.map(c => c.release)
  const decisions = recordCandidateSet(ctx, releases)
  const best = chooseBestRelease(ctx, releases)
  if (!best) return { grabbed: 0, rejected: candidates.length }

  const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
  logger.info(`Film "${film.title}" → ${best.release.title} (score=${best.score}${isCollected ? ', upgrade' : ''})`)

  try {
    const result = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'movies')
    requireSuccessfulGrab(result)
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare("UPDATE films SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE id = ?")
      .run((result as any).infoHash ?? null, film.id)
    return { grabbed: 1, rejected: candidates.length - 1 }
  } catch (err) {
    logger.error(`Grab failed for "${film.title}": ${err}`)
    return { grabbed: 0, rejected: candidates.length }
  }
}

// ── Series ────────────────────────────────────────────────────────────────────

export async function decideSeries(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const series = tab.db.prepare(`
    SELECT id, title, monitored, target_tier, target_resolution, target_source, target_codec,
           minimum_tier, minimum_resolution, minimum_source, minimum_codec, upgrade_allowed
    FROM series WHERE id = ?
  `).get(subject.subjectId) as any
  if (!series || series.monitored !== 1) return { grabbed: 0, rejected: candidates.length }

  const result: DecideResult = { grabbed: 0, rejected: 0 }

  // Group candidates by their structural shape so we can drive the right decision per group.
  const byEpisode = new Map<string, IdentifiedRelease[]>()  // key = "S{n}E{m}"
  const bySeason = new Map<number, IdentifiedRelease[]>()   // season pack OR multi-ep groups
  const byRange = new Map<string, { seasons: number[]; items: IdentifiedRelease[] }>() // multi-season packs, key = "1-6"

  for (const c of candidates) {
    if (c.parsed.absoluteEpisode != null) {
      // Anime absolute numbering: not yet supported — skip but record rejection
      result.rejected++
      logger.debug(`Skipping anime absolute episode ${c.parsed.absoluteEpisode} for "${series.title}" (mappings TBD)`)
      continue
    }
    if (c.parsed.airDate) {
      // Daily series: try to look up the episode by air date
      const ep = tab.db.prepare(`
        SELECT e.id, e.season_number, e.episode_number, e.status, e.monitored, e.air_date, e.upgrade_allowed,
               se.monitored AS season_monitored
        FROM episodes e
        JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
        WHERE e.series_id = ? AND substr(e.air_date, 1, 10) = ?
      `).get(series.id, c.parsed.airDate) as any
      if (!ep || ep.monitored !== 1 || ep.season_monitored !== 1) { result.rejected++; continue }
      const key = `S${ep.season_number}E${ep.episode_number}`
      const list = byEpisode.get(key)
      if (list) list.push(c)
      else byEpisode.set(key, [c])
      continue
    }
    if (c.parsed.season == null) { result.rejected++; continue }
    if ((c.parsed.seasons?.length ?? 0) > 1) {
      // Multi-season range pack (S01-S06 etc.)
      const key = `${c.parsed.seasons[0]}-${c.parsed.seasons[c.parsed.seasons.length - 1]}`
      const entry = byRange.get(key)
      if (entry) entry.items.push(c)
      else byRange.set(key, { seasons: c.parsed.seasons, items: [c] })
      continue
    }
    if (c.parsed.isSeasonPack || c.parsed.episodes.length === 0) {
      const list = bySeason.get(c.parsed.season)
      if (list) list.push(c)
      else bySeason.set(c.parsed.season, [c])
      continue
    }
    // Single or multi-episode release — we register it under each episode key it covers
    for (const epNum of c.parsed.episodes) {
      const key = `S${c.parsed.season}E${epNum}`
      const list = byEpisode.get(key)
      if (list) list.push(c)
      else byEpisode.set(key, [c])
    }
  }

  // Decide widest-coverage first: multi-season range packs → season packs →
  // individual episodes. A grab marks every episode it covers as 'acquiring',
  // and the narrower passes below re-read episode status, so anything a wider
  // release already claimed is skipped. This makes one complete-series pack win
  // over N season packs, and a season pack win over N episode grabs — instead
  // of the reverse (which downloaded redundant, narrower torrents first).

  // Multi-season range packs (S01-S06 etc.) — grab when any covered season
  // still has wanted episodes; every uncollected episode in the range attaches
  // to the pack so the monitor imports each file as it completes.
  for (const [rangeKey, { seasons, items: group }] of byRange) {
    const placeholders = seasons.map(() => '?').join(',')
    const monitoredSeasonCount = tab.db.prepare(`
      SELECT COUNT(*) AS count FROM seasons
      WHERE series_id = ? AND season_number IN (${placeholders}) AND monitored = 1
    `).get(series.id, ...seasons) as { count: number }
    if (monitoredSeasonCount.count !== seasons.length) { result.rejected += group.length; continue }
    const wantedCount = tab.db.prepare(`
      SELECT COUNT(e.id) as count FROM episodes e
      JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
      WHERE e.series_id = ? AND e.season_number IN (${placeholders}) AND se.monitored = 1 AND e.monitored = 1
        AND e.status IN ('wanted', 'missing')
        AND (e.file_path IS NULL OR e.file_path = '')
        AND ((e.air_at IS NOT NULL AND datetime(e.air_at) <= datetime('now'))
          OR (e.air_at IS NULL AND (e.air_date IS NULL OR substr(e.air_date, 1, 10) <= date('now'))))
    `).get(series.id, ...seasons) as { count: number }
    if (wantedCount.count === 0) { result.rejected += group.length; continue }

    const ctx: DecisionContext = {
      source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
      tabId: subject.tabId,
      tabName: subject.tabName,
      mediaType: 'series',
      subjectType: 'season',
      subjectId: `${series.id}:S${rangeKey}`,
      subjectTitle: series.title,
      targetTier: overrides?.targetTier ?? series.target_tier,
      targetResolution: overrides?.targetResolution ?? series.target_resolution,
      targetSource: overrides?.targetSource ?? series.target_source,
      targetCodec: overrides?.targetCodec ?? series.target_codec,
      minimumTier: series.minimum_tier,
      minimumResolution: series.minimum_resolution,
      minimumSource: series.minimum_source,
      minimumCodec: series.minimum_codec,
      manualFilters: overrides?.manualFilters,
      enforceTargetFloor: !overrides?.manualFilters,
    }
    const releases = group.map(g => g.release)
    const decisions = recordCandidateSet(ctx, releases)
    const best = chooseBestRelease(ctx, releases)
    if (!best) { result.rejected += group.length; continue }
    const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
    logger.info(`Multi-Season Pack "${series.title} S${rangeKey}" → ${best.release.title} (score=${best.score})`)
    try {
      const grabResult = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'tv')
      requireSuccessfulGrab(grabResult)
      if (decisionId) markDecisionGrabbed(decisionId, grabResult)
      const infoHash = (grabResult as any).infoHash ?? null
      tab.db.prepare(`
        UPDATE episodes SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now')
        WHERE series_id = ? AND season_number IN (${placeholders}) AND monitored = 1
          AND status IN ('wanted', 'missing')
          AND (file_path IS NULL OR file_path = '')
          AND ((air_at IS NOT NULL AND datetime(air_at) <= datetime('now'))
            OR (air_at IS NULL AND (air_date IS NULL OR substr(air_date, 1, 10) <= date('now'))))
      `).run(infoHash, series.id, ...seasons)
      tab.db.prepare(`
        UPDATE seasons SET info_hash = COALESCE(?, info_hash), updated_at = datetime('now')
        WHERE series_id = ? AND season_number IN (${placeholders})
      `).run(infoHash, series.id, ...seasons)
      result.grabbed++
      result.rejected += group.length - 1
    } catch (err) {
      logger.error(`Multi-season grab failed for "${series.title} S${rangeKey}": ${err}`)
      result.rejected += group.length
    }
  }

  // Season-pack decisions
  for (const [seasonNum, group] of bySeason) {
    const seasonMonitored = tab.db.prepare('SELECT monitored FROM seasons WHERE series_id = ? AND season_number = ?')
      .get(series.id, seasonNum) as { monitored: number } | undefined
    if (!seasonMonitored || seasonMonitored.monitored !== 1) { result.rejected += group.length; continue }
    const wantedCount = tab.db.prepare(`
      SELECT COUNT(e.id) as count FROM episodes e
      JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
      WHERE e.series_id = ? AND e.season_number = ? AND se.monitored = 1 AND e.monitored = 1
        AND e.status IN ('wanted', 'missing')
        AND (e.file_path IS NULL OR e.file_path = '')
        AND ((e.air_at IS NOT NULL AND datetime(e.air_at) <= datetime('now'))
          OR (e.air_at IS NULL AND (e.air_date IS NULL OR substr(e.air_date, 1, 10) <= date('now'))))
    `).get(series.id, seasonNum) as { count: number }
    if (wantedCount.count === 0) { result.rejected += group.length; continue }

    const ctx: DecisionContext = {
      source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
      tabId: subject.tabId,
      tabName: subject.tabName,
      mediaType: 'series',
      subjectType: 'season',
      subjectId: `${series.id}:S${seasonNum}`,
      subjectTitle: series.title,
      targetTier: overrides?.targetTier ?? series.target_tier,
      targetResolution: overrides?.targetResolution ?? series.target_resolution,
      targetSource: overrides?.targetSource ?? series.target_source,
      targetCodec: overrides?.targetCodec ?? series.target_codec,
      minimumTier: series.minimum_tier,
      minimumResolution: series.minimum_resolution,
      minimumSource: series.minimum_source,
      minimumCodec: series.minimum_codec,
      manualFilters: overrides?.manualFilters,
      enforceTargetFloor: !overrides?.manualFilters,
    }
    const releases = group.map(g => g.release)
    const decisions = recordCandidateSet(ctx, releases)
    const best = chooseBestRelease(ctx, releases)
    if (!best) { result.rejected += group.length; continue }
    const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
    logger.info(`Season Pack "${series.title} S${seasonNum}" → ${best.release.title} (score=${best.score})`)
    try {
      const grabResult = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'tv')
      requireSuccessfulGrab(grabResult)
      if (decisionId) markDecisionGrabbed(decisionId, grabResult)
      const infoHash = (grabResult as any).infoHash ?? null
      tab.db.prepare(`UPDATE episodes SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now')
        WHERE series_id = ? AND season_number = ? AND monitored = 1 AND status IN ('wanted', 'missing')
          AND (file_path IS NULL OR file_path = '')
          AND ((air_at IS NOT NULL AND datetime(air_at) <= datetime('now'))
            OR (air_at IS NULL AND (air_date IS NULL OR substr(air_date, 1, 10) <= date('now'))))`).run(infoHash, series.id, seasonNum)
      tab.db.prepare(`UPDATE seasons SET info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE series_id = ? AND season_number = ?`).run(infoHash, series.id, seasonNum)
      result.grabbed++
      result.rejected += group.length - 1
    } catch (err) {
      logger.error(`Season grab failed for "${series.title} S${seasonNum}": ${err}`)
      result.rejected += group.length
    }
  }

  // Episode decisions (narrowest — only for episodes no wider pack claimed above)
  for (const [key, group] of byEpisode) {
    const m = /^S(\d+)E(\d+)$/.exec(key)!
    const seasonNum = parseInt(m[1], 10)
    const epNum = parseInt(m[2], 10)
    const ep = tab.db.prepare(`
      SELECT e.id, e.status, e.monitored, e.air_date, e.air_at, e.file_path, e.upgrade_allowed,
             e.current_tier, e.current_resolution, e.current_source, e.current_codec,
             e.current_release_group, e.current_edition, e.current_size_bytes, e.current_release_title,
             se.monitored AS season_monitored
      FROM episodes e
      JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
      WHERE e.series_id = ? AND e.season_number = ? AND e.episode_number = ?
    `).get(series.id, seasonNum, epNum) as any

    const seriesUpgrades = (series.upgrade_allowed ?? 1) !== 0
    if (!ep || ep.monitored !== 1 || ep.season_monitored !== 1) { result.rejected += group.length; continue }
    const hasAired = ep.air_at
      ? Date.parse(String(ep.air_at)) <= Date.now()
      : !ep.air_date || String(ep.air_date).slice(0, 10) <= new Date().toISOString().slice(0, 10)
    if (!hasAired) { result.rejected += group.length; continue }
    const hasLocalFile = typeof ep.file_path === 'string' && ep.file_path.trim().length > 0
    const wanted = (!hasLocalFile && (ep.status === 'wanted' || ep.status === 'missing'))
      || (ep.status === 'collected' && seriesUpgrades && (ep.upgrade_allowed ?? 1) !== 0)
    if (!wanted) { result.rejected += group.length; continue }

    const isCollected = ep.status === 'collected'
    const ctx: DecisionContext = {
      source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
      tabId: subject.tabId,
      tabName: subject.tabName,
      mediaType: 'series',
      subjectType: 'episode',
      subjectId: ep.id,
      subjectTitle: series.title,
      targetTier: overrides?.targetTier ?? series.target_tier,
      targetResolution: overrides?.targetResolution ?? series.target_resolution,
      targetSource: overrides?.targetSource ?? series.target_source,
      targetCodec: overrides?.targetCodec ?? series.target_codec,
      minimumTier: series.minimum_tier,
      minimumResolution: series.minimum_resolution,
      minimumSource: series.minimum_source,
      minimumCodec: series.minimum_codec,
      manualFilters: overrides?.manualFilters,
      enforceTargetFloor: !overrides?.manualFilters,
      isCollected,
      upgradeAllowed: seriesUpgrades && (ep.upgrade_allowed ?? 1) !== 0,
      currentQuality: isCollected ? ep : null,
    }
    const releases = group.map(g => g.release)
    const decisions = recordCandidateSet(ctx, releases)
    const best = chooseBestRelease(ctx, releases)
    if (!best) { result.rejected += group.length; continue }
    const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
    logger.info(`Episode "${series.title} S${seasonNum}E${epNum}" → ${best.release.title} (score=${best.score})`)
    try {
      const grabResult = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'tv')
      requireSuccessfulGrab(grabResult)
      if (decisionId) markDecisionGrabbed(decisionId, grabResult)
      tab.db.prepare("UPDATE episodes SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE id = ?")
        .run((grabResult as any).infoHash ?? null, ep.id)
      result.grabbed++
      result.rejected += group.length - 1
    } catch (err) {
      logger.error(`Episode grab failed for "${series.title} S${seasonNum}E${epNum}": ${err}`)
      result.rejected += group.length
    }
  }

  return result
}

// ── Music ─────────────────────────────────────────────────────────────────────

export async function decideAlbum(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const album = tab.db.prepare(`
    SELECT al.id, al.artist_id, al.title, al.status, al.monitored, ar.monitored AS artist_monitored,
           al.target_tier, al.upgrade_allowed, al.current_tier, al.current_resolution,
           al.current_source, al.current_codec, al.current_release_group, al.current_edition, al.current_size_bytes,
           al.current_release_title
    FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.id = ?
  `).get(subject.subjectId) as any
  if (!album || album.monitored !== 1 || album.artist_monitored !== 1) return { grabbed: 0, rejected: candidates.length }

  const wanted = album.status === 'wanted' || album.status === 'missing'
    || (album.status === 'collected' && (album.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const isCollected = album.status === 'collected'
  const ctx: DecisionContext = {
    source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
    tabId: subject.tabId,
    tabName: subject.tabName,
    mediaType: 'music',
    subjectType: 'album',
    subjectId: album.id,
    subjectTitle: subject.primaryTitle,
    targetTier: overrides?.targetTier ?? album.target_tier,
    targetResolution: overrides?.targetResolution,
    targetSource: overrides?.targetSource,
    targetCodec: overrides?.targetCodec,
    manualFilters: overrides?.manualFilters,
    isCollected,
    upgradeAllowed: album.upgrade_allowed !== 0,
    currentQuality: isCollected ? album : null,
  }

  const releases = candidates.map(c => c.release)
  const decisions = recordCandidateSet(ctx, releases)
  const best = chooseBestRelease(ctx, releases)
  if (!best) return { grabbed: 0, rejected: candidates.length }

  const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
  logger.info(`Album "${subject.primaryTitle}" → ${best.release.title} (score=${best.score}${isCollected ? ', upgrade' : ''})`)
  try {
    const result = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'music')
    requireSuccessfulGrab(result)
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare("UPDATE albums SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE id = ?")
      .run((result as any).infoHash ?? null, album.id)
    return { grabbed: 1, rejected: candidates.length - 1 }
  } catch (err) {
    logger.error(`Album grab failed for "${subject.primaryTitle}": ${err}`)
    return { grabbed: 0, rejected: candidates.length }
  }
}

// ── Games ─────────────────────────────────────────────────────────────────────

export async function decideGame(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const game = tab.db.prepare(`
    SELECT id, title, status, monitored, target_tier, upgrade_allowed, current_tier, current_resolution,
           current_source, current_codec, current_release_group, current_edition, current_size_bytes,
           current_release_title
    FROM games WHERE id = ?
  `).get(subject.subjectId) as any
  if (!game || game.monitored !== 1) return { grabbed: 0, rejected: candidates.length }

  const wanted = game.status === 'wanted' || game.status === 'missing'
    || (game.status === 'collected' && (game.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const isCollected = game.status === 'collected'
  const ctx: DecisionContext = {
    source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
    tabId: subject.tabId,
    tabName: subject.tabName,
    mediaType: 'games',
    subjectType: 'game',
    subjectId: game.id,
    subjectTitle: game.title,
    targetTier: overrides?.targetTier ?? game.target_tier,
    targetResolution: overrides?.targetResolution,
    targetSource: overrides?.targetSource,
    targetCodec: overrides?.targetCodec,
    manualFilters: overrides?.manualFilters,
    requireGameReleaseTerms: true,
    isCollected,
    upgradeAllowed: game.upgrade_allowed !== 0,
    currentQuality: isCollected ? game : null,
  }

  const releases = candidates.map(c => c.release)
  const decisions = recordCandidateSet(ctx, releases)
  const best = chooseBestRelease(ctx, releases)
  if (!best) return { grabbed: 0, rejected: candidates.length }

  const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
  logger.info(`Game "${game.title}" → ${best.release.title} (score=${best.score}${isCollected ? ', upgrade' : ''})`)
  try {
    const result = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'games')
    requireSuccessfulGrab(result)
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare("UPDATE games SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE id = ?")
      .run((result as any).infoHash ?? null, game.id)
    return { grabbed: 1, rejected: candidates.length - 1 }
  } catch (err) {
    logger.error(`Game grab failed for "${game.title}": ${err}`)
    return { grabbed: 0, rejected: candidates.length }
  }
}

// ── Books and comics ─────────────────────────────────────────────────────────

export async function decideBook(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const book = tab.db.prepare(`
    SELECT b.*, a.name AS author_name, a.monitored AS author_monitored
    FROM books b JOIN authors a ON a.id = b.author_id
    WHERE b.id = ?
  `).get(subject.subjectId) as any
  if (!book || book.monitored !== 1 || book.author_monitored !== 1) {
    return { grabbed: 0, rejected: candidates.length }
  }

  const isCollected = book.status === 'downloaded' || book.status === 'collected'
  const wanted = book.status === 'wanted' || book.status === 'missing'
    || (isCollected && (book.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const ctx: DecisionContext = {
    source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
    tabId: subject.tabId,
    tabName: subject.tabName,
    mediaType: 'books',
    subjectType: 'book',
    subjectId: book.id,
    subjectTitle: book.title,
    year: book.year,
    targetTier: overrides?.targetTier ?? book.target_tier,
    manualFilters: overrides?.manualFilters,
    isCollected,
    upgradeAllowed: book.upgrade_allowed !== 0,
    currentQuality: isCollected ? book : null,
  }
  const releases = candidates.map(candidate => candidate.release)
  const decisions = recordCandidateSet(ctx, releases)
  const best = chooseBestRelease(ctx, releases)
  if (!best) return { grabbed: 0, rejected: candidates.length }

  const decisionId = decisions.find(item => item.decision.release === best.release)?.decisionId
  try {
    const result = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'archivist-books')
    requireSuccessfulGrab(result)
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare(`
      UPDATE books SET status = 'downloading', info_hash = COALESCE(?, info_hash), updated_at = datetime('now')
      WHERE id = ?
    `).run((result as any).infoHash ?? null, book.id)
    return { grabbed: 1, rejected: candidates.length - 1 }
  } catch (err) {
    logger.error(`Book grab failed for "${book.author_name} - ${book.title}": ${err}`)
    return { grabbed: 0, rejected: candidates.length }
  }
}

export async function decideComicIssue(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const issue = tab.db.prepare(`
    SELECT i.*, s.title AS series_title, s.monitored AS series_monitored
    FROM comic_issues i JOIN comic_series s ON s.id = i.series_id
    WHERE i.id = ?
  `).get(subject.subjectId) as any
  if (!issue || issue.monitored !== 1 || issue.series_monitored !== 1) {
    return { grabbed: 0, rejected: candidates.length }
  }

  const isCollected = issue.status === 'collected' || issue.status === 'downloaded'
  const wanted = issue.status === 'wanted' || issue.status === 'missing'
    || (isCollected && (issue.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const ctx: DecisionContext = {
    source: overrides?.source ?? (overrides?.manualFilters ? 'manual' : 'rss'),
    tabId: subject.tabId,
    tabName: subject.tabName,
    mediaType: 'comics',
    subjectType: 'issue',
    subjectId: issue.id,
    subjectTitle: issue.series_title,
    year: issue.year,
    targetTier: overrides?.targetTier,
    manualFilters: overrides?.manualFilters,
    isCollected,
    upgradeAllowed: issue.upgrade_allowed !== 0,
    currentQuality: isCollected ? issue : null,
  }
  const releases = candidates.map(candidate => candidate.release)
  const decisions = recordCandidateSet(ctx, releases)
  const best = chooseBestRelease(ctx, releases)
  if (!best) return { grabbed: 0, rejected: candidates.length }

  const decisionId = decisions.find(item => item.decision.release === best.release)?.decisionId
  try {
    const result = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'archivist-comics')
    requireSuccessfulGrab(result)
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare(`
      UPDATE comic_issues SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now')
      WHERE id = ?
    `).run((result as any).infoHash ?? null, issue.id)
    return { grabbed: 1, rejected: candidates.length - 1 }
  } catch (err) {
    logger.error(`Comic grab failed for "${issue.series_title} #${issue.issue_number}": ${err}`)
    return { grabbed: 0, rejected: candidates.length }
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export interface QualityOverrides {
  targetTier?: string | number | null
  targetResolution?: string | null
  targetSource?: string | null
  targetCodec?: string | null
  manualFilters?: boolean
  source?: 'rss' | 'manual' | 'auto-grab'
}

export async function decideForSubject(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  switch (subject.mediaType) {
    case 'films':  return decideFilm(subject, candidates, overrides)
    case 'series': return decideSeries(subject, candidates, overrides)
    case 'music':  return decideAlbum(subject, candidates, overrides)
    case 'books':  return decideBook(subject, candidates, overrides)
    case 'comics': return decideComicIssue(subject, candidates, overrides)
    case 'games':  return decideGame(subject, candidates, overrides)
  }
}
