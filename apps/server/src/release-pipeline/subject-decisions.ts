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

// ── Films ─────────────────────────────────────────────────────────────────────

export async function decideFilm(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const film = tab.db.prepare(`
    SELECT id, title, year, status, target_tier, upgrade_allowed, current_tier, current_resolution,
           current_source, current_codec, current_release_group, current_edition, current_size_bytes,
           current_release_title
    FROM films WHERE id = ?
  `).get(subject.subjectId) as any
  if (!film) return { grabbed: 0, rejected: candidates.length }

  const wanted = film.status === 'wanted' || film.status === 'missing'
    || (film.status === 'collected' && (film.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const isCollected = film.status === 'collected'
  const ctx: DecisionContext = {
    source: overrides?.manualFilters ? 'manual' : 'rss',
    tabId: subject.tabId,
    tabName: subject.tabName,
    mediaType: 'films',
    subjectType: 'film',
    subjectId: film.id,
    subjectTitle: film.title,
    year: film.year,
    targetTier: overrides?.targetTier ?? film.target_tier,
    targetResolution: overrides?.targetResolution,
    targetSource: overrides?.targetSource,
    targetCodec: overrides?.targetCodec,
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
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare("UPDATE films SET status = 'acquiring', updated_at = datetime('now') WHERE id = ?").run(film.id)
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

  const series = tab.db.prepare('SELECT id, title, target_tier, upgrade_allowed FROM series WHERE id = ?').get(subject.subjectId) as any
  if (!series) return { grabbed: 0, rejected: candidates.length }

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
        SELECT id, season_number, episode_number, status, upgrade_allowed
        FROM episodes WHERE series_id = ? AND substr(air_date, 1, 10) = ?
      `).get(series.id, c.parsed.airDate) as any
      if (!ep) { result.rejected++; continue }
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

  // Episode decisions
  for (const [key, group] of byEpisode) {
    const m = /^S(\d+)E(\d+)$/.exec(key)!
    const seasonNum = parseInt(m[1], 10)
    const epNum = parseInt(m[2], 10)
    const ep = tab.db.prepare(`
      SELECT id, status, upgrade_allowed, current_tier, current_resolution, current_source, current_codec,
             current_release_group, current_edition, current_size_bytes, current_release_title
      FROM episodes WHERE series_id = ? AND season_number = ? AND episode_number = ?
    `).get(series.id, seasonNum, epNum) as any

    const seriesUpgrades = (series.upgrade_allowed ?? 1) !== 0
    if (!ep) { result.rejected += group.length; continue }
    const wanted = ep.status === 'wanted' || ep.status === 'missing'
      || (ep.status === 'collected' && seriesUpgrades && (ep.upgrade_allowed ?? 1) !== 0)
    if (!wanted) { result.rejected += group.length; continue }

    const isCollected = ep.status === 'collected'
    const ctx: DecisionContext = {
      source: overrides?.manualFilters ? 'manual' : 'rss',
      tabId: subject.tabId,
      tabName: subject.tabName,
      mediaType: 'series',
      subjectType: 'episode',
      subjectId: ep.id,
      subjectTitle: series.title,
      targetTier: overrides?.targetTier ?? series.target_tier,
      targetResolution: overrides?.targetResolution,
      targetSource: overrides?.targetSource,
      targetCodec: overrides?.targetCodec,
      manualFilters: overrides?.manualFilters,
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

  // Season-pack decisions
  for (const [seasonNum, group] of bySeason) {
    const wantedCount = tab.db.prepare(`
      SELECT COUNT(id) as count FROM episodes WHERE series_id = ? AND season_number = ? AND status IN ('wanted', 'missing')
    `).get(series.id, seasonNum) as { count: number }
    if (wantedCount.count === 0) { result.rejected += group.length; continue }

    const ctx: DecisionContext = {
      source: overrides?.manualFilters ? 'manual' : 'rss',
      tabId: subject.tabId,
      tabName: subject.tabName,
      mediaType: 'series',
      subjectType: 'season',
      subjectId: `${series.id}:S${seasonNum}`,
      subjectTitle: series.title,
      targetTier: overrides?.targetTier ?? series.target_tier,
      targetResolution: overrides?.targetResolution,
      targetSource: overrides?.targetSource,
      targetCodec: overrides?.targetCodec,
      manualFilters: overrides?.manualFilters,
    }
    const releases = group.map(g => g.release)
    const decisions = recordCandidateSet(ctx, releases)
    const best = chooseBestRelease(ctx, releases)
    if (!best) { result.rejected += group.length; continue }
    const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
    logger.info(`Season Pack "${series.title} S${seasonNum}" → ${best.release.title} (score=${best.score})`)
    try {
      const grabResult = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'tv')
      if (decisionId) markDecisionGrabbed(decisionId, grabResult)
      const infoHash = (grabResult as any).infoHash ?? null
      tab.db.prepare(`UPDATE episodes SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE series_id = ? AND season_number = ? AND status IN ('wanted', 'missing')`).run(infoHash, series.id, seasonNum)
      tab.db.prepare(`UPDATE seasons SET info_hash = COALESCE(?, info_hash), updated_at = datetime('now') WHERE series_id = ? AND season_number = ?`).run(infoHash, series.id, seasonNum)
      result.grabbed++
      result.rejected += group.length - 1
    } catch (err) {
      logger.error(`Season grab failed for "${series.title} S${seasonNum}": ${err}`)
      result.rejected += group.length
    }
  }

  // Multi-season range packs (S01-S06 etc.) — grab when any covered season
  // still has wanted episodes; every uncollected episode in the range attaches
  // to the pack so the monitor imports each file as it completes.
  for (const [rangeKey, { seasons, items: group }] of byRange) {
    const placeholders = seasons.map(() => '?').join(',')
    const wantedCount = tab.db.prepare(`
      SELECT COUNT(id) as count FROM episodes
      WHERE series_id = ? AND season_number IN (${placeholders}) AND status IN ('wanted', 'missing')
    `).get(series.id, ...seasons) as { count: number }
    if (wantedCount.count === 0) { result.rejected += group.length; continue }

    const ctx: DecisionContext = {
      source: overrides?.manualFilters ? 'manual' : 'rss',
      tabId: subject.tabId,
      tabName: subject.tabName,
      mediaType: 'series',
      subjectType: 'season',
      subjectId: `${series.id}:S${rangeKey}`,
      subjectTitle: series.title,
      targetTier: overrides?.targetTier ?? series.target_tier,
      targetResolution: overrides?.targetResolution,
      targetSource: overrides?.targetSource,
      targetCodec: overrides?.targetCodec,
      manualFilters: overrides?.manualFilters,
    }
    const releases = group.map(g => g.release)
    const decisions = recordCandidateSet(ctx, releases)
    const best = chooseBestRelease(ctx, releases)
    if (!best) { result.rejected += group.length; continue }
    const decisionId = decisions.find(d => d.decision.release === best.release)?.decisionId
    logger.info(`Multi-Season Pack "${series.title} S${rangeKey}" → ${best.release.title} (score=${best.score})`)
    try {
      const grabResult = await sendToDownloadClient(tab.client, best.release.downloadUrl, 'tv')
      if (decisionId) markDecisionGrabbed(decisionId, grabResult)
      const infoHash = (grabResult as any).infoHash ?? null
      tab.db.prepare(`
        UPDATE episodes SET status = 'acquiring', info_hash = COALESCE(?, info_hash), updated_at = datetime('now')
        WHERE series_id = ? AND season_number IN (${placeholders}) AND status IN ('wanted', 'missing')
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

  return result
}

// ── Music ─────────────────────────────────────────────────────────────────────

export async function decideAlbum(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  const tab = openTab(subject)
  if (!tab || !tab.hasClient) return { grabbed: 0, rejected: candidates.length }

  const album = tab.db.prepare(`
    SELECT id, artist_id, title, status, target_tier, upgrade_allowed, current_tier, current_resolution,
           current_source, current_codec, current_release_group, current_edition, current_size_bytes,
           current_release_title
    FROM albums WHERE id = ?
  `).get(subject.subjectId) as any
  if (!album) return { grabbed: 0, rejected: candidates.length }

  const wanted = album.status === 'wanted' || album.status === 'missing'
    || (album.status === 'collected' && (album.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const isCollected = album.status === 'collected'
  const ctx: DecisionContext = {
    source: overrides?.manualFilters ? 'manual' : 'rss',
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
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare("UPDATE albums SET status = 'acquiring', updated_at = datetime('now') WHERE id = ?").run(album.id)
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
    SELECT id, title, status, target_tier, upgrade_allowed, current_tier, current_resolution,
           current_source, current_codec, current_release_group, current_edition, current_size_bytes,
           current_release_title
    FROM games WHERE id = ?
  `).get(subject.subjectId) as any
  if (!game) return { grabbed: 0, rejected: candidates.length }

  const wanted = game.status === 'wanted' || game.status === 'missing'
    || (game.status === 'collected' && (game.upgrade_allowed ?? 1) === 1)
  if (!wanted) return { grabbed: 0, rejected: candidates.length }

  const isCollected = game.status === 'collected'
  const ctx: DecisionContext = {
    source: overrides?.manualFilters ? 'manual' : 'rss',
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
    if (decisionId) markDecisionGrabbed(decisionId, result)
    tab.db.prepare("UPDATE games SET status = 'acquiring', updated_at = datetime('now') WHERE id = ?").run(game.id)
    return { grabbed: 1, rejected: candidates.length - 1 }
  } catch (err) {
    logger.error(`Game grab failed for "${game.title}": ${err}`)
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
}

export async function decideForSubject(subject: SubjectRef, candidates: IdentifiedRelease[], overrides?: QualityOverrides): Promise<DecideResult> {
  switch (subject.mediaType) {
    case 'films':  return decideFilm(subject, candidates, overrides)
    case 'series': return decideSeries(subject, candidates, overrides)
    case 'music':  return decideAlbum(subject, candidates, overrides)
    case 'games':  return decideGame(subject, candidates, overrides)
  }
}
