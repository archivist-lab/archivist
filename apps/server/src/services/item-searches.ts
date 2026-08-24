import { SCORE_NO_YEAR, SCORE_TITLE_MATCH, SCORE_YEAR_ADJACENT, SCORE_YEAR_EXACT, makeReleaseScorer, scoreRelease, type ScoredRelease } from '@archivist/core'
import { musicQualityRung } from '@archivist/contracts'
import { getDb } from '../db.js'
import { normalizeTitle, parseRelease, punctuationSafeQueryVariants } from '../release-pipeline/parser.js'
import { buildSeriesBrowseBases, isOpenEndedSeriesRange } from '../release-pipeline/series-cascade.js'
import { cancelJob, enqueueJob, recordEvent, type JobRecord } from '../system/event-store.js'
import { registerJobHandler } from '../system/job-runner.js'
import { sendMusicReleaseToDownloadClient, sendToDownloadClient } from './download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers, type BridgeSearchResult, type SearchDiagnostics } from './indexer-bridge.js'
import {
  absoluteQuality,
  classifyQualityMatch,
  hasQualityFloor,
  isQualityUpgrade,
  isWithinQualityEnvelope,
  meetsQualityFloor,
  parseQualityFromTitle,
  type CandidateQuality,
  type QualityFloor,
} from './quality.js'
import { ScopedDownloadClientStore } from '../shared/download-clients.js'
import { getTierTermsForMedia } from '../shared/settings.js'
import { AUTOMATIC_MUSIC_MIN_SEEDERS, rankAlbumReleases, rankMusicReleases } from '../release-pipeline/music-quality.js'
import { decideAlbum } from '../release-pipeline/subject-decisions.js'
import { evaluateRelease, extractInfoHash, markDecisionGrabbed, recordReleaseDecision } from './acquisition-decisions.js'
import { albumReleaseScope, ensureAlbumTrackMetadata, selectedAlbumRelease } from './music-metadata.js'
import { withMusicSwarmEvidence } from './music-swarm.js'

const JOB_TYPE = 'item-search'
const RESULT_RETENTION_MS = 15 * 60_000
const MAX_RESULTS = 60
// Automatic Music scans are a selection operation, not an exhaustive result
// browser. Do not let one degraded public indexer hold the acquisition lane for
// the general 45-second interactive timeout (or repeat that wait for every
// query variant). Healthy indexers normally answer inside a few seconds.
const AUTOMATIC_MUSIC_INDEXER_TIMEOUT_MS = 8_000
const AUTOMATIC_MUSIC_SEARCH_BUDGET_MS = 15_000

export type ItemSearchMediaType = 'films' | 'series' | 'music'
export type ItemSearchSubjectType = 'film' | 'series' | 'season' | 'episode' | 'album' | 'artist'
export type ItemSearchMode = 'quick' | 'deep' | 'auto' | 'auto-episodes'
export type ItemSearchStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'

export interface ItemSearchOptions {
  tier?: string
  resolution?: string
  source?: string
  codec?: string
  selectedRelease?: BridgeSearchResult
  /** Exact indexer phrases used by searches with multiple query variants. */
  searchTerms?: string[]
}

export interface ItemSearchRecord {
  id: number
  jobId: number | null
  libraryId: number
  mediaType: ItemSearchMediaType
  subjectType: ItemSearchSubjectType
  subjectId: number
  mode: ItemSearchMode
  status: ItemSearchStatus
  options: ItemSearchOptions
  results: Array<Record<string, unknown>>
  resultCount: number
  grabbed: boolean
  message: string | null
  error: string | null
  queuePosition: number | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  expiresAt: string | null
  updatedAt: string
}

interface ItemSearchRow {
  id: number
  job_id: number | null
  library_id: number
  media_type: ItemSearchMediaType
  subject_type: ItemSearchSubjectType
  subject_id: number
  mode: ItemSearchMode
  status: ItemSearchStatus
  options: string
  results: string
  result_count: number
  grabbed: number
  message: string | null
  error: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  expires_at: string | null
  updated_at: string
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function queuePosition(row: ItemSearchRow): number | null {
  if (row.status === 'running') return 0
  if (row.status !== 'queued' || row.job_id == null) return null
  const result = getDb()
    .prepare(`
    SELECT COUNT(*) AS count FROM system_jobs
    WHERE type = ? AND status = 'queued' AND id <= ?
  `)
    .get(JOB_TYPE, row.job_id) as { count: number }
  return result.count
}

function mapRow(row: ItemSearchRow): ItemSearchRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    libraryId: row.library_id,
    mediaType: row.media_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    mode: row.mode,
    status: row.status,
    options: parseJson(row.options, {}),
    results: parseJson(row.results, []),
    resultCount: row.result_count,
    grabbed: row.grabbed === 1,
    message: row.message,
    error: row.error,
    queuePosition: queuePosition(row),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  }
}

function cleanupExpired(): void {
  getDb()
    .prepare(`
    DELETE FROM item_searches
    WHERE status IN ('complete','failed','cancelled')
      AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')
  `)
    .run()
}

function getRow(id: number): ItemSearchRow | undefined {
  return getDb().prepare('SELECT * FROM item_searches WHERE id = ?').get(id) as ItemSearchRow | undefined
}

export function getItemSearch(id: number, libraryId: number): ItemSearchRecord | null {
  cleanupExpired()
  const row = getDb().prepare('SELECT * FROM item_searches WHERE id = ? AND library_id = ?').get(id, libraryId) as ItemSearchRow | undefined
  return row ? mapRow(row) : null
}

export function getLatestItemSearch(input: {
  libraryId: number
  mediaType: ItemSearchMediaType
  subjectType: ItemSearchSubjectType
  subjectId: number
}): ItemSearchRecord | null {
  cleanupExpired()
  const row = getDb()
    .prepare(`
    SELECT * FROM item_searches
    WHERE library_id = ? AND media_type = ? AND subject_type = ? AND subject_id = ?
      AND (status IN ('queued','running') OR expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, id DESC
    LIMIT 1
  `)
    .get(input.libraryId, input.mediaType, input.subjectType, input.subjectId) as ItemSearchRow | undefined
  return row ? mapRow(row) : null
}

function assertSubject(input: {
  libraryId: number
  mediaType: ItemSearchMediaType
  subjectType: ItemSearchSubjectType
  subjectId: number
  mode: ItemSearchMode
}): void {
  const db = getDb()
  let found: unknown
  if (input.mediaType === 'films' && input.subjectType === 'film') {
    found = db.prepare('SELECT id FROM films WHERE id = ? AND library_id = ?').get(input.subjectId, input.libraryId)
  } else if (input.mediaType === 'series' && input.subjectType === 'series') {
    found = db.prepare('SELECT id FROM series WHERE id = ? AND library_id = ?').get(input.subjectId, input.libraryId)
  } else if (input.mediaType === 'series' && input.subjectType === 'season') {
    found = db
      .prepare('SELECT se.id FROM seasons se JOIN series s ON s.id = se.series_id WHERE se.id = ? AND s.library_id = ?')
      .get(input.subjectId, input.libraryId)
  } else if (input.mediaType === 'series' && input.subjectType === 'episode') {
    found = db
      .prepare('SELECT e.id FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ? AND s.library_id = ?')
      .get(input.subjectId, input.libraryId)
  } else if (input.mediaType === 'music' && input.subjectType === 'album') {
    found = db
      .prepare('SELECT al.id FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.id = ? AND ar.library_id = ?')
      .get(input.subjectId, input.libraryId)
  } else if (input.mediaType === 'music' && input.subjectType === 'artist') {
    found = db.prepare('SELECT id FROM artists WHERE id = ? AND library_id = ?').get(input.subjectId, input.libraryId)
  }
  if (!found) throw new Error('Search subject not found in this library')
  if (input.mode === 'auto-episodes' && input.subjectType !== 'season') throw new Error('Auto-episodes requires a season')
}

export function enqueueItemSearch(input: {
  libraryId: number
  mediaType: ItemSearchMediaType
  subjectType: ItemSearchSubjectType
  subjectId: number
  mode: ItemSearchMode
  options?: ItemSearchOptions
}): ItemSearchRecord {
  cleanupExpired()
  assertSubject(input)
  const db = getDb()
  const transaction = db.transaction(() => {
    const active = db
      .prepare(`
      SELECT * FROM item_searches
      WHERE library_id = ? AND media_type = ? AND subject_type = ? AND subject_id = ? AND mode = ?
        AND status IN ('queued','running')
      ORDER BY id DESC LIMIT 1
    `)
      .get(input.libraryId, input.mediaType, input.subjectType, input.subjectId, input.mode) as ItemSearchRow | undefined
    if (active) return active

    const inserted = db
      .prepare(`
      INSERT INTO item_searches (library_id, media_type, subject_type, subject_id, mode, options)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(input.libraryId, input.mediaType, input.subjectType, input.subjectId, input.mode, JSON.stringify(input.options ?? {}))
    const searchId = Number(inserted.lastInsertRowid)
    const jobId = enqueueJob(
      {
        type: JOB_TYPE,
        subjectType: 'item-search',
        subjectId: String(searchId),
        payload: { searchId },
        maxAttempts: 1,
        priority: 50,
      },
      db,
    )
    db.prepare("UPDATE item_searches SET job_id = ?, updated_at = datetime('now') WHERE id = ?").run(jobId, searchId)
    return getRow(searchId)!
  })
  return mapRow(transaction.immediate())
}

export function cancelItemSearch(id: number, libraryId: number): ItemSearchRecord | null {
  const row = getDb().prepare('SELECT * FROM item_searches WHERE id = ? AND library_id = ?').get(id, libraryId) as ItemSearchRow | undefined
  if (!row) return null
  if (row.job_id != null) cancelJob(row.job_id)
  const expires = new Date(Date.now() + RESULT_RETENTION_MS).toISOString()
  getDb()
    .prepare(`
    UPDATE item_searches SET status = 'cancelled', completed_at = datetime('now'), expires_at = ?,
      message = 'Search cancelled', updated_at = datetime('now')
    WHERE id = ? AND status IN ('queued','running')
  `)
    .run(expires, id)
  return mapRow(getRow(id)!)
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error('Search cancelled')
}

function sortReleases(releases: any[]): any[] {
  const rank: Record<string, number> = { match: 0, higher: 1, lower: 2 }
  const normalTier = (tier: number) => (tier === 0 ? 4 : tier)
  return releases.sort((a, b) => {
    const match = (rank[a.matchLevel] ?? 3) - (rank[b.matchLevel] ?? 3)
    if (match !== 0) return match
    const tier = normalTier(a.customTier ?? 0) - normalTier(b.customTier ?? 0)
    if (tier !== 0) return tier
    const score = (b.customScore ?? 0) - (a.customScore ?? 0)
    if (score !== 0) return score
    const seeds = (b.seeders ?? 0) - (a.seeders ?? 0)
    if (seeds !== 0) return seeds
    return (a.indexerPriority ?? 25) - (b.indexerPriority ?? 25)
  })
}

function storeResults(searchId: number, additions: any[]): any[] {
  const row = getRow(searchId)
  if (!row) return []
  const merged = new Map<string, any>()
  for (const result of [...parseJson<any[]>(row.results, []), ...additions]) {
    const key = String(result.guid ?? result.downloadUrl ?? result.title)
    const current = merged.get(key)
    if (!current || (result.seeders ?? 0) > (current.seeders ?? 0)) merged.set(key, result)
  }
  const results = sortReleases([...merged.values()]).slice(0, MAX_RESULTS)
  getDb()
    .prepare(`
    UPDATE item_searches SET results = ?, result_count = ?, updated_at = datetime('now') WHERE id = ?
  `)
    .run(JSON.stringify(results), results.length, searchId)
  return results
}

function filmFloor(film: any): QualityFloor {
  return {
    tier: film.minimum_tier ?? film.target_tier,
    resolution: film.minimum_resolution ?? film.target_resolution,
    source: film.minimum_source ?? film.target_source,
    codec: film.minimum_codec ?? film.target_codec,
  }
}

function filmQuality(film: any): CandidateQuality {
  return {
    tier: film.current_tier ?? 0,
    resolution: film.current_resolution ?? null,
    source: film.current_source ?? null,
    codec: film.current_codec ?? null,
    releaseGroup: film.current_release_group ?? null,
    edition: film.current_edition ?? null,
  }
}

function filmBaseline(film: any): CandidateQuality | null {
  if (film.status !== 'collected') return null
  const floor = filmFloor(film)
  return hasQualityFloor(floor) && !meetsQualityFloor(filmQuality(film), floor) ? filmQuality(film) : null
}

function validateFilmRelease(
  releaseTitle: string,
  filmTitle: string,
  filmYear?: number,
  scorer: (title: string) => ScoredRelease = scoreRelease,
): { valid: boolean; score: number } {
  const title = releaseTitle.toLowerCase().replace(/[:!?,]/g, ' ')
  const target = filmTitle.toLowerCase().replace(/[:!?,]/g, ' ')
  const targetClean = target
    .replace(/^(the|a|an)\s+/i, '')
    .trim()
    .replace(/\s+/g, ' ')
  if (/\b(S\d+E\d+|S\d+|Season \d+|Complete|E\d+)\b/i.test(title)) return { valid: false, score: 0 }
  for (const sequel of ['reloaded', 'revolutions', 'resurrections', 'prophecy', 'origins', 'rising', 'rises', 'legacy', 'returns']) {
    if (title.includes(sequel) && !target.includes(sequel)) return { valid: false, score: 0 }
  }
  const words = title
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[\s.]+/)
    .filter(Boolean)
  const targetWords = targetClean.replace(/-/g, ' ').split(/\s+/).filter(Boolean)
  if (!targetWords.every(word => words.includes(word))) return { valid: false, score: 0 }
  let score = scorer(releaseTitle).score + SCORE_TITLE_MATCH
  if (filmYear) {
    if (title.includes(String(filmYear))) score += SCORE_YEAR_EXACT
    else if (title.includes(String(filmYear + 1)) || title.includes(String(filmYear - 1))) score += SCORE_YEAR_ADJACENT
    else score += SCORE_NO_YEAR
  }
  return { valid: true, score }
}

function filmQueryPlan(film: any, mode: ItemSearchMode, options: ItemSearchOptions): string[] {
  const titleBase = film.year ? `${film.title} ${film.year}` : film.title
  if (mode === 'quick') return [titleBase]
  const tiers = getTierTermsForMedia('films', film.library_id)
  const selected =
    options.tier && options.tier !== 'Any'
      ? [
          {
            name: options.tier,
            terms: options.tier.includes('1') ? tiers.tier1 : options.tier.includes('2') ? tiers.tier2 : options.tier.includes('3') ? tiers.tier3 : [],
          },
        ]
      : [
          { name: 'Tier 1', terms: tiers.tier1 },
          { name: 'Tier 2', terms: tiers.tier2 },
          { name: 'Tier 3', terms: tiers.tier3 },
          { name: 'Broad', terms: [] },
        ]
  const codecTerms: Record<string, string[]> = { Remux: ['remux'], AV1: ['AV1'], x265: ['x265', 'HEVC'], x264: ['x264'] }
  const plan: string[] = []
  for (const tier of selected) {
    const bases = tier.terms.length > 0 ? tier.terms.map(term => `${titleBase} ${term}`) : [titleBase]
    for (const base of bases) {
      let variants = [base]
      if (options.resolution && options.resolution !== 'Any') variants = variants.map(value => `${value} ${options.resolution}`)
      if (options.source && options.source !== 'Any') variants = variants.map(value => `${value} ${options.source}`)
      const selectedCodec = options.codec
      if (selectedCodec && !['Any', 'Legacy'].includes(selectedCodec) && codecTerms[selectedCodec]) {
        variants = variants.flatMap(value => codecTerms[selectedCodec]!.map((codec: string) => `${value} ${codec}`))
      }
      plan.push(...variants, base)
    }
  }
  plan.push(titleBase, film.title)
  return [...new Set(plan)]
}

async function searchFilm(row: ItemSearchRow, signal: AbortSignal): Promise<{ grabbed: boolean; message: string }> {
  const film = getDb().prepare('SELECT * FROM films WHERE id = ? AND library_id = ?').get(row.subject_id, row.library_id) as any
  if (!film) throw new Error('Film no longer exists')
  const options = parseJson<ItemSearchOptions>(row.options, {})
  const indexers = getEnabledIndexerInstances()
  if (indexers.length === 0) throw new Error('No enabled indexers configured')
  const scorer = makeReleaseScorer(getTierTermsForMedia('films', row.library_id))
  const baseline = filmBaseline(film)
  const envelope = {
    floor: filmFloor(film),
    ceiling: { tier: film.target_tier, resolution: film.target_resolution, source: film.target_source, codec: film.target_codec },
  }
  const queryMode: ItemSearchMode = row.mode === 'auto' ? 'deep' : row.mode
  const plan = filmQueryPlan(film, queryMode, options)
  for (const query of plan) {
    throwIfAborted(signal)
    const raw = await searchViaIndexers(indexers, query, {
      categories: [2000],
      type: 'movie',
      module: 'films',
      imdbId: film.imdb_id,
      tmdbId: film.tmdb_id,
    })
    const additions = raw.flatMap(release => {
      const validation = validateFilmRelease(release.title, film.title, film.year, scorer)
      if (!validation.valid) return []
      if (options.codec === 'Legacy' && /remux|av1|x\.?265|h\.?265|hevc|x\.?264|h\.?264/i.test(release.title)) return []
      const quality = parseQualityFromTitle(release.title, scorer)
      if (baseline && !isQualityUpgrade(baseline, quality)) return []
      if (row.mode === 'auto' && !isWithinQualityEnvelope(quality, envelope)) return []
      return [
        {
          ...release,
          customTier: quality.tier,
          tier: quality.tier,
          customScore: validation.score,
          matchLevel: classifyQualityMatch(quality, envelope.ceiling),
        },
      ]
    })
    const results = storeResults(row.id, additions)
    if (row.mode === 'quick') break
    if (row.mode === 'auto' && results.length > 0) break
    if (results.length >= MAX_RESULTS) break
  }

  const results = parseJson<any[]>(getRow(row.id)?.results ?? '[]', [])
  if (row.mode !== 'auto') return { grabbed: false, message: results.length > 0 ? `Found ${results.length} releases` : 'No matching releases found' }
  const best = results[0]
  if (!best)
    return { grabbed: false, message: baseline ? 'No eligible upgrade within the quality envelope found' : 'No release within the quality envelope found' }
  const clients = new ScopedDownloadClientStore(getDb(), row.library_id).getEnabled().sort((a, b) => a.priority - b.priority)
  if (clients.length === 0) throw new Error('No download clients configured')
  const result = await sendToDownloadClient(clients[0], best.downloadUrl, 'archivist-films')
  if (!result.success) throw new Error(result.message || 'Download client rejected the release')
  getDb()
    .prepare(
      `UPDATE films SET status = 'acquiring', info_hash = ?, acquired_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND library_id = ?`,
    )
    .run((result as any).infoHash ?? null, film.id, row.library_id)
  return { grabbed: true, message: `Grabbed "${best.title}"` }
}

async function searchAlbum(row: ItemSearchRow, signal: AbortSignal): Promise<{ grabbed: boolean; message: string }> {
  const album = getDb()
    .prepare(`
    SELECT al.*, ar.name AS artist_name, l.name AS library_name, l.db_path AS library_db_path
    FROM albums al JOIN artists ar ON ar.id = al.artist_id JOIN libraries l ON l.id = ar.library_id
    WHERE al.id = ? AND ar.library_id = ?
  `)
    .get(row.subject_id, row.library_id) as any
  if (!album) throw new Error('Album no longer exists')

  const trackMetadata = await ensureAlbumTrackMetadata(getDb(), album.id)
  album.track_count = trackMetadata.trackCount

  const indexers = getEnabledIndexerInstances()
  if (indexers.length === 0) throw new Error('No enabled indexers configured')
  const selectedRelease = selectedAlbumRelease(getDb(), album.id)
  const releaseScope = albumReleaseScope(selectedRelease)
  // Search broadly on artist and title only. Edition and pressing details from
  // the selected MusicBrainz release ("mono", `12" Vinyl`) describe a physical
  // artefact, not how uploaders name a rip, so folding them into the query
  // matches nothing. Release preference is applied when ranking instead.
  const query = [album.artist_name, album.title].join(' ')
  const policy = {
    targetQuality: album.target_resolution ?? null,
    targetCodec: album.target_codec ?? null,
    requireTarget: row.mode !== 'deep' && (album.upgrade_allowed === 0 || album.upgrade_allowed === false),
  }
  const queries = row.mode === 'quick' ? [query] : punctuationSafeQueryVariants(query)
  const deadlineAt = row.mode === 'auto' ? Date.now() + AUTOMATIC_MUSIC_SEARCH_BUDGET_MS : undefined
  let results: any[] = []
  const auditCandidates = new Map<string, BridgeSearchResult>()
  const failures = new Map<string, string>()

  const ingest = (raw: BridgeSearchResult[]): void => {
    for (const release of raw) auditCandidates.set(release.guid ?? release.downloadUrl, release)
    const candidates = raw.map(release => withMusicSwarmEvidence({ ...release, title: release.title ?? '', seeders: release.seeders ?? 0 }))
    const ranked =
      row.mode === 'deep'
        ? rankMusicReleases(candidates, policy)
        : rankAlbumReleases(
            candidates,
            {
              artist: album.artist_name,
              title: album.title,
              albumType: album.album_type,
              trackCount: album.track_count,
              ...releaseScope,
            },
            policy,
          )
    const additions = ranked.map(release => ({
      ...release,
      guid: release.guid ?? release.downloadUrl,
      indexerName: release.indexerName ?? 'Indexer',
      quality: musicQualityRung(release.musicScore.parsed.quality)?.label ?? undefined,
      customTier: 0,
      customScore: release.musicScore.score,
      matchLevel: 'match',
    }))
    results = storeResults(row.id, additions)
  }

  for (const searchQuery of queries) {
    throwIfAborted(signal)
    if (deadlineAt != null && Date.now() >= deadlineAt) break
    const raw = await searchViaIndexers(indexers, searchQuery, {
      categories: [3000],
      type: 'music',
      module: 'music',
      timeoutMs: row.mode === 'auto' ? AUTOMATIC_MUSIC_INDEXER_TIMEOUT_MS : undefined,
      deadlineAt,
      onDiagnostics: (diagnostics: SearchDiagnostics) => {
        for (const stat of diagnostics.stats) if (stat.error) failures.set(stat.indexerName, stat.error)
      },
      onPartialResults: ingest,
    })
    // The final aggregate is ingested as a safety net for callers/indexers that
    // cannot emit a partial batch. storeResults de-duplicates repeat delivery.
    ingest(raw)
    if (row.mode === 'quick') break
    if (row.mode === 'auto' && results.length > 0) break
    if (results.length >= MAX_RESULTS) break
  }

  if (row.mode !== 'auto') {
    const failureSummary =
      failures.size > 0 ? ` Indexer failures: ${[...failures].map(([name, error]) => `${name}: ${error.replace(/^Error:\s*/i, '')}`).join('; ')}` : ''
    return { grabbed: false, message: results.length > 0 ? `Found ${results.length} releases` : `No matching complete-album releases found.${failureSummary}` }
  }

  if (auditCandidates.size === 0) return { grabbed: false, message: 'No release matched the complete album and its quality target' }
  const decision = await decideAlbum(
    {
      tabId: row.library_id,
      tabName: album.library_name,
      dbPath: album.library_db_path,
      mediaType: 'music',
      subjectType: 'album',
      subjectId: String(album.id),
      primaryTitle: `${album.artist_name} - ${album.title}`,
      year: album.year ?? null,
    },
    [...auditCandidates.values()].map(release => ({ release, parsed: parseRelease(release.title) })),
    {
      source: 'auto-grab',
      interactive: true,
      targetResolution: album.target_resolution,
      targetCodec: album.target_codec,
      expectedTrackCount: album.track_count,
    },
  )
  if (decision.error) throw new Error(decision.error)
  if (decision.grabbed === 0) return { grabbed: false, message: 'No release matched the complete album and its quality target' }
  return { grabbed: true, message: 'Album release grabbed through the acquisition decision pipeline' }
}

const DISCOGRAPHY_WORDS = /\b(discograph|anthology|collection|complete|box\s?set|all\s+albums|studio\s+albums)\b/i
const DISCOGRAPHY_YEARS = /\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b/

function discographyMatchesArtist(title: string, artistName: string): boolean {
  const artist = normalizeTitle(artistName)
  return !!artist && normalizeTitle(title).includes(artist) && (DISCOGRAPHY_WORDS.test(title) || DISCOGRAPHY_YEARS.test(title))
}

export function discographySearchTerms(artistName: string): string[] {
  return [`${artistName} discography`]
}

async function searchArtistDiscography(row: ItemSearchRow, signal: AbortSignal): Promise<{ grabbed: boolean; message: string }> {
  const artist = getDb()
    .prepare(`SELECT ar.*, l.name AS library_name, l.db_path AS library_db_path
    FROM artists ar JOIN libraries l ON l.id = ar.library_id WHERE ar.id = ? AND ar.library_id = ?`)
    .get(row.subject_id, row.library_id) as any
  if (!artist) throw new Error('Artist no longer exists')
  const options = parseJson<ItemSearchOptions>(row.options, {})
  let results: any[] = []
  const failures = new Map<string, string>()
  const queries = discographySearchTerms(artist.name)
  options.searchTerms = queries
  row.options = JSON.stringify(options)
  getDb().prepare(`UPDATE item_searches SET options = ?, updated_at = datetime('now') WHERE id = ?`).run(row.options, row.id)

  if (options.selectedRelease) {
    results = storeResults(row.id, [options.selectedRelease])
  } else {
    const indexers = getEnabledIndexerInstances()
    if (indexers.length === 0) throw new Error('No enabled indexers configured')
    const deadlineAt = row.mode === 'auto' ? Date.now() + AUTOMATIC_MUSIC_SEARCH_BUDGET_MS : undefined
    const ingest = (raw: BridgeSearchResult[]): void => {
      const ranked = rankMusicReleases(
        raw
          .filter(release => discographyMatchesArtist(release.title ?? '', artist.name))
          .map(release => withMusicSwarmEvidence({ ...release, title: release.title ?? '', seeders: release.seeders ?? 0 })),
        {
          targetQuality: artist.target_resolution ?? null,
          targetCodec: artist.target_codec ?? null,
          minimumSeeders: row.mode === 'auto' ? AUTOMATIC_MUSIC_MIN_SEEDERS : undefined,
        },
      )
      results = storeResults(
        row.id,
        ranked.map(release => ({
          ...release,
          guid: release.guid ?? release.downloadUrl,
          indexerName: release.indexerName ?? 'Indexer',
          quality: musicQualityRung(release.musicScore.parsed.quality)?.label ?? undefined,
          customTier: 0,
          customScore: release.musicScore.score,
          matchLevel: 'match',
        })),
      )
    }
    for (const query of row.mode === 'quick' ? queries.slice(0, 1) : queries) {
      throwIfAborted(signal)
      if (deadlineAt != null && Date.now() >= deadlineAt) break
      const raw = await searchViaIndexers(indexers, query, {
        type: 'search',
        module: 'music',
        timeoutMs: row.mode === 'auto' ? AUTOMATIC_MUSIC_INDEXER_TIMEOUT_MS : undefined,
        deadlineAt,
        onDiagnostics: diagnostics => {
          for (const stat of diagnostics.stats) if (stat.error) failures.set(stat.indexerName, stat.error)
        },
        onPartialResults: ingest,
      })
      ingest(raw)
      // An automatic scan needs one eligible pack. Query variants exist to
      // recover from trackers using different names, not to make a viable
      // result wait behind every remaining variant.
      if (row.mode === 'auto' && results.length > 0) break
      if (results.length >= MAX_RESULTS) break
    }
  }

  if (row.mode !== 'auto') {
    const failureSummary =
      failures.size > 0 ? ` Indexer failures: ${[...failures].map(([name, error]) => `${name}: ${error.replace(/^Error:\s*/i, '')}`).join('; ')}` : ''
    return { grabbed: false, message: results.length ? `Found ${results.length} discography releases` : `No discography releases found.${failureSummary}` }
  }
  const selected = options.selectedRelease ?? results[0]
  if (!selected) return { grabbed: false, message: 'No discography release found' }
  const context = {
    source: 'manual' as const,
    tabId: row.library_id,
    tabName: artist.library_name,
    mediaType: 'music',
    subjectType: 'artist',
    subjectId: artist.id,
    subjectTitle: artist.name,
  }
  const decision = evaluateRelease(context, selected)
  if (!discographyMatchesArtist(selected.title, artist.name)) {
    decision.accepted = false
    decision.rejectionReasons.push('release is not an artist discography pack')
  }
  const decisionId = recordReleaseDecision(context, decision)
  if (!decision.accepted) return { grabbed: false, message: decision.rejectionReasons.join('; ') }
  const client = new ScopedDownloadClientStore(getDb(), row.library_id).getEnabled().sort((left, right) => left.priority - right.priority)[0]
  if (!client) throw new Error('No download clients configured')
  const outcome = await sendMusicReleaseToDownloadClient(client, selected)
  if (!outcome.success) throw new Error(outcome.message || 'Download client rejected the discography')
  markDecisionGrabbed(decisionId, outcome)
  const hash = (outcome as any).infoHash ?? extractInfoHash((outcome as any).resolvedDownloadUrl) ?? extractInfoHash(selected.downloadUrl)
  getDb()
    .prepare(`UPDATE artists SET discography_info_hash = ?, discography_status = 'acquiring',
    discography_progress = 0, discography_title = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(hash ?? null, selected.title, artist.id)
  recordEvent({
    category: 'acquisition',
    action: 'discography-grabbed',
    subjectType: 'artist',
    subjectId: String(artist.id),
    message: `Grabbed a discography for ${artist.name}`,
    data: { infoHash: hash ?? null, title: selected.title, itemSearchId: row.id },
  })
  return { grabbed: true, message: `Started downloading: ${selected.title}` }
}

function validateSeriesRelease(releaseTitle: string, seriesTitle: string): boolean {
  const words = new Set(normalizeTitle(releaseTitle).split(' ').filter(Boolean))
  return normalizeTitle(seriesTitle)
    .split(' ')
    .filter(Boolean)
    .every(word => words.has(word))
}

function seriesFloor(series: any): QualityFloor {
  return {
    tier: series.minimum_tier ?? series.target_tier,
    resolution: series.minimum_resolution ?? series.target_resolution,
    source: series.minimum_source ?? series.target_source,
    codec: series.minimum_codec ?? series.target_codec,
  }
}

function seriesTarget(series: any): QualityFloor {
  return {
    tier: series.target_tier,
    resolution: series.target_resolution,
    source: series.target_source,
    codec: series.target_codec,
  }
}

function episodeQuality(episode: any): CandidateQuality {
  return {
    tier: episode.current_tier ?? 0,
    resolution: episode.current_resolution ?? null,
    source: episode.current_source ?? null,
    codec: episode.current_codec ?? null,
    releaseGroup: episode.current_release_group ?? null,
    edition: episode.current_edition ?? null,
  }
}

function seriesContext(row: ItemSearchRow): { series: any; seasonNumber?: number; episode?: any } {
  const db = getDb()
  if (row.subject_type === 'series') {
    const series = db.prepare('SELECT * FROM series WHERE id = ? AND library_id = ?').get(row.subject_id, row.library_id)
    if (!series) throw new Error('Series no longer exists')
    return { series }
  }
  if (row.subject_type === 'season') {
    const value = db
      .prepare(`SELECT s.*, se.season_number FROM seasons se JOIN series s ON s.id = se.series_id WHERE se.id = ? AND s.library_id = ?`)
      .get(row.subject_id, row.library_id) as any
    if (!value) throw new Error('Season no longer exists')
    return { series: value, seasonNumber: value.season_number }
  }
  const value = db
    .prepare(`SELECT s.*, e.id AS episode_id, e.season_number, e.episode_number, e.status AS episode_status,
      e.current_tier, e.current_resolution, e.current_source, e.current_codec, e.current_release_group, e.current_edition
    FROM episodes e JOIN series s ON s.id = e.series_id WHERE e.id = ? AND s.library_id = ?`)
    .get(row.subject_id, row.library_id) as any
  if (!value) throw new Error('Episode no longer exists')
  return { series: value, seasonNumber: value.season_number, episode: value }
}

function seriesBaseline(context: { series: any; seasonNumber?: number; episode?: any }): CandidateQuality | null {
  const floor = seriesTarget(context.series)
  if (!hasQualityFloor(floor)) return null
  if (context.episode) {
    if (!['collected', 'downloaded'].includes(context.episode.episode_status)) return null
    const quality = episodeQuality(context.episode)
    return meetsQualityFloor(quality, floor) ? null : quality
  }
  const episodes = (
    context.seasonNumber != null
      ? getDb().prepare('SELECT * FROM episodes WHERE series_id = ? AND season_number = ?').all(context.series.id, context.seasonNumber)
      : getDb().prepare('SELECT * FROM episodes WHERE series_id = ? AND season_number > 0').all(context.series.id)
  ) as any[]
  const aired = episodes.filter(episode => !episode.air_date || String(episode.air_date).slice(0, 10) <= new Date().toISOString().slice(0, 10))
  if (aired.some(episode => !['collected', 'downloaded'].includes(episode.status))) return null
  const below = aired.filter(episode => !meetsQualityFloor(episodeQuality(episode), floor))
  if (below.length === 0) return null
  return below.map(episodeQuality).reduce((left, right) => (absoluteQuality(right) < absoluteQuality(left) ? right : left))
}

function seriesBase(context: { series: any; seasonNumber?: number; episode?: any }): string {
  if (context.episode)
    return `${context.series.title} S${String(context.seasonNumber).padStart(2, '0')}E${String(context.episode.episode_number).padStart(2, '0')}`
  if (context.seasonNumber != null) return `${context.series.title} S${String(context.seasonNumber).padStart(2, '0')}`
  return context.series.title
}

function seriesQueryPlan(context: { series: any; seasonNumber?: number; episode?: any }, mode: ItemSearchMode): string[] {
  const base = seriesBase(context)
  if (mode === 'quick') return punctuationSafeQueryVariants(base)
  const tiers = getTierTermsForMedia('series', context.series.library_id)
  const termTiers = [tiers.tier1, tiers.tier2, tiers.tier3]
  let bases = [base]
  if (context.seasonNumber == null && !context.episode) {
    const seasons = (
      getDb()
        .prepare('SELECT DISTINCT season_number AS season FROM seasons WHERE series_id = ? AND season_number > 0 ORDER BY season_number')
        .all(context.series.id) as Array<{ season: number }>
    ).map(row => row.season)
    bases = buildSeriesBrowseBases(context.series.title, seasons)
  }
  const plan: string[] = []
  if (bases.length > 1) {
    const ranges = bases.filter(isOpenEndedSeriesRange)
    const exact = bases.filter(value => !isOpenEndedSeriesRange(value))
    for (const terms of termTiers) for (const candidate of [...ranges, ...exact]) for (const term of terms) plan.push(`${candidate} ${term}`)
    plan.push(...exact)
  } else {
    plan.push(base)
    if (!context.episode) for (const terms of termTiers) for (const term of terms) plan.push(`${base} ${term}`)
  }
  return [...new Set(plan.flatMap(punctuationSafeQueryVariants))]
}

function releaseMatchesSeriesScope(release: BridgeSearchResult, context: { series: any; seasonNumber?: number; episode?: any }, auto: boolean): boolean {
  if (!validateSeriesRelease(release.title, context.series.title)) return false
  const parsed = parseRelease(release.title)
  if (context.episode) return parsed.season === context.seasonNumber && !parsed.isSeasonPack && parsed.episodes.includes(context.episode.episode_number)
  if (context.seasonNumber != null) return parsed.seasons.includes(context.seasonNumber) || parsed.season === context.seasonNumber
  if (!auto) return true
  const airedSeasons = (
    getDb()
      .prepare(`SELECT DISTINCT season_number AS season FROM episodes WHERE series_id = ? AND season_number > 0
    AND (air_date IS NULL OR substr(air_date, 1, 10) <= date('now')) ORDER BY season_number`)
      .all(context.series.id) as Array<{ season: number }>
  ).map(row => row.season)
  if (airedSeasons.length <= 1) return parsed.isSeasonPack && parsed.seasons.length === 1
  return parsed.seasons.length > 1 && airedSeasons.every(season => parsed.seasons.includes(season))
}

async function quickSeriesResults(row: ItemSearchRow, context: { series: any; seasonNumber?: number; episode?: any }, signal: AbortSignal): Promise<any[]> {
  throwIfAborted(signal)
  const indexers = getEnabledIndexerInstances()
  if (indexers.length === 0) throw new Error('No enabled indexers configured')
  const scorer = makeReleaseScorer(getTierTermsForMedia('series', row.library_id))
  const baseline = seriesBaseline(context)
  const target = {
    tier: context.series.target_tier,
    resolution: context.series.target_resolution,
    source: context.series.target_source,
    codec: context.series.target_codec,
  }
  const results = await searchViaIndexers(indexers, seriesBase(context), {
    categories: [5000],
    type: 'tvsearch',
    module: 'series',
    imdbId: context.series.imdb_id,
    tmdbId: context.series.tmdb_id,
    tvdbId: context.series.tvdb_id,
  })
  return results.flatMap(release => {
    if (!releaseMatchesSeriesScope(release, context, row.mode === 'auto' || row.mode === 'auto-episodes')) return []
    const quality = parseQualityFromTitle(release.title, scorer)
    if (baseline && !isQualityUpgrade(baseline, quality)) return []
    return [{ ...release, customTier: quality.tier, customScore: scorer(release.title).score, matchLevel: classifyQualityMatch(quality, target) }]
  })
}

async function searchSeries(row: ItemSearchRow, signal: AbortSignal): Promise<{ grabbed: boolean; message: string }> {
  const context = seriesContext(row)
  if (row.mode === 'auto-episodes') return autoEpisodes(row, context, signal)
  const scorer = makeReleaseScorer(getTierTermsForMedia('series', row.library_id))
  const baseline = seriesBaseline(context)
  const envelope = {
    floor: seriesFloor(context.series),
    ceiling: {
      tier: context.series.target_tier,
      resolution: context.series.target_resolution,
      source: context.series.target_source,
      codec: context.series.target_codec,
    },
  }
  const first = await quickSeriesResults(row, context, signal)
  let results = storeResults(row.id, first)
  if (
    row.mode !== 'quick' &&
    !(row.mode === 'auto' && results.some(result => isWithinQualityEnvelope(parseQualityFromTitle(result.title, scorer), envelope)))
  ) {
    const indexers = getEnabledIndexerInstances()
    for (const query of seriesQueryPlan(context, 'deep')) {
      throwIfAborted(signal)
      const raw = await searchViaIndexers(indexers, query, { categories: [5000], type: 'tvsearch', module: 'series' })
      const additions = raw.flatMap(release => {
        if (!releaseMatchesSeriesScope(release, context, row.mode === 'auto')) return []
        const quality = parseQualityFromTitle(release.title, scorer)
        if (baseline && !isQualityUpgrade(baseline, quality)) return []
        if (row.mode === 'auto' && !isWithinQualityEnvelope(quality, envelope)) return []
        return [{ ...release, customTier: quality.tier, customScore: scorer(release.title).score, matchLevel: classifyQualityMatch(quality, envelope.ceiling) }]
      })
      results = storeResults(row.id, additions)
      if (row.mode === 'auto' && results.some(result => isWithinQualityEnvelope(parseQualityFromTitle(result.title, scorer), envelope))) break
      if (results.length >= MAX_RESULTS) break
    }
  }
  if (row.mode !== 'auto') return { grabbed: false, message: results.length > 0 ? `Found ${results.length} releases` : 'No matching releases found' }
  const best = results.find(result => isWithinQualityEnvelope(parseQualityFromTitle(result.title, scorer), envelope))
  if (!best) return { grabbed: false, message: baseline ? 'No upgrade over the current file found' : 'No matching release found' }
  const clients = new ScopedDownloadClientStore(getDb(), row.library_id).getEnabled().sort((a, b) => a.priority - b.priority)
  if (clients.length === 0) throw new Error('No download clients configured')
  const outcome = await sendToDownloadClient(clients[0], best.downloadUrl, 'archivist-series')
  if (!outcome.success) throw new Error(outcome.message || 'Download client rejected the release')
  const hash = (outcome as any).infoHash ?? null
  if (context.episode) {
    getDb().prepare("UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, context.episode.episode_id)
  } else if (context.seasonNumber != null) {
    getDb().prepare("UPDATE seasons SET info_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, row.subject_id)
    getDb()
      .prepare(
        "UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE series_id = ? AND season_number = ? AND status NOT IN ('collected','downloaded')",
      )
      .run(hash, context.series.id, context.seasonNumber)
  } else {
    getDb().prepare("UPDATE seasons SET info_hash = ?, updated_at = datetime('now') WHERE series_id = ?").run(hash, context.series.id)
    getDb()
      .prepare(
        "UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE series_id = ? AND status NOT IN ('collected','downloaded')",
      )
      .run(hash, context.series.id)
  }
  return { grabbed: true, message: `Grabbed "${best.title}"` }
}

async function autoEpisodes(
  row: ItemSearchRow,
  context: { series: any; seasonNumber?: number },
  signal: AbortSignal,
): Promise<{ grabbed: boolean; message: string }> {
  const target = seriesTarget(context.series)
  const episodes = (
    getDb()
      .prepare(`SELECT id, episode_number, status, current_tier, current_resolution, current_source, current_codec,
      current_release_group, current_edition FROM episodes WHERE series_id = ? AND season_number = ? AND monitored = 1
    AND status NOT IN ('acquiring','downloading','ignored') AND (air_date IS NULL OR substr(air_date, 1, 10) <= date('now')) ORDER BY episode_number`)
      .all(context.series.id, context.seasonNumber) as any[]
  ).filter(episode => !['collected', 'downloaded'].includes(episode.status) || (hasQualityFloor(target) && !meetsQualityFloor(episodeQuality(episode), target)))
  getDb()
    .prepare("UPDATE item_searches SET message = ?, updated_at = datetime('now') WHERE id = ?")
    .run(`Auto episode scan 0 of ${episodes.length} episodes`, row.id)
  let grabbed = 0
  for (const [index, episode] of episodes.entries()) {
    throwIfAborted(signal)
    getDb()
      .prepare("UPDATE item_searches SET message = ?, updated_at = datetime('now') WHERE id = ?")
      .run(`Auto episode scan ${index + 1} of ${episodes.length} episodes`, row.id)
    const episodeRow = { ...row, subject_type: 'episode' as const, subject_id: episode.id, mode: 'auto' as const }
    const episodeContext = seriesContext(episodeRow)
    const candidates = await quickSeriesResults(episodeRow, episodeContext, signal)
    const scorer = makeReleaseScorer(getTierTermsForMedia('series', row.library_id))
    const envelope = {
      floor: seriesFloor(context.series),
      ceiling: {
        tier: context.series.target_tier,
        resolution: context.series.target_resolution,
        source: context.series.target_source,
        codec: context.series.target_codec,
      },
    }
    const best = sortReleases(candidates).find(candidate => isWithinQualityEnvelope(parseQualityFromTitle(candidate.title, scorer), envelope))
    if (!best) continue
    const clients = new ScopedDownloadClientStore(getDb(), row.library_id).getEnabled().sort((a, b) => a.priority - b.priority)
    if (clients.length === 0) throw new Error('No download clients configured')
    const outcome = await sendToDownloadClient(clients[0], best.downloadUrl, 'archivist-series')
    if (!outcome.success) continue
    getDb()
      .prepare("UPDATE episodes SET status = 'acquiring', info_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run((outcome as any).infoHash ?? null, episode.id)
    grabbed++
  }
  return { grabbed: grabbed > 0, message: `Auto episode scan grabbed ${grabbed} of ${episodes.length} episodes` }
}

async function executeItemSearch(job: JobRecord, signal: AbortSignal): Promise<void> {
  const payload = parseJson<{ searchId?: number }>(job.payload, {})
  const row = payload.searchId ? getRow(payload.searchId) : undefined
  if (!row) throw new Error('Item search record is missing')
  getDb()
    .prepare(`UPDATE item_searches SET status = 'running', started_at = COALESCE(started_at, datetime('now')),
    error = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(row.id)
  try {
    const outcome =
      row.media_type === 'films'
        ? await searchFilm(row, signal)
        : row.media_type === 'music'
          ? row.subject_type === 'artist'
            ? await searchArtistDiscography(row, signal)
            : await searchAlbum(row, signal)
          : await searchSeries(row, signal)
    const expiresAt = new Date(Date.now() + RESULT_RETENTION_MS).toISOString()
    getDb()
      .prepare(`UPDATE item_searches SET status = 'complete', grabbed = ?, message = ?, error = NULL,
      completed_at = datetime('now'), expires_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(outcome.grabbed ? 1 : 0, outcome.message, expiresAt, row.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = /cancel/i.test(message) ? 'cancelled' : 'failed'
    const expiresAt = new Date(Date.now() + RESULT_RETENTION_MS).toISOString()
    getDb()
      .prepare(`UPDATE item_searches SET status = ?, error = ?, message = ?, completed_at = datetime('now'),
      expires_at = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, message.slice(0, 2000), status === 'cancelled' ? 'Search cancelled' : 'Search failed', expiresAt, row.id)
    throw err
  }
}

export function registerItemSearchJobs(): void {
  registerJobHandler(JOB_TYPE, executeItemSearch, { lane: 'searches', timeoutMs: 30 * 60_000 })
}
