import { createLogger, sanitizeConfigValue } from '@archivist/core'
import type { RecommendationFeedback, RecommendationMediaType, RecommendationPage, RecommendationResult } from '@archivist/contracts'
import { getDb } from '../db.js'
import { discoverMovies, getMovieRecommendations } from '../modules/films/tmdb.js'
import { discoverSeriesTmdb, getSeriesRecommendationsTmdb } from '../modules/series/tvdb.js'

const logger = createLogger('Recommendations')
export const RECOMMENDATION_MODEL_VERSION = 'hybrid-v1'
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000
const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000

export interface RecommendationSettings { enabled: boolean; retentionDays: number }

export function getRecommendationSettings(): RecommendationSettings {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE library_id = 0 AND key = 'recommendations'").get() as { value: string } | undefined
  try {
    const value = row ? JSON.parse(row.value) : {}
    return { enabled: value.enabled !== false, retentionDays: Math.max(7, Math.min(365, Number(value.retentionDays) || 90)) }
  } catch { return { enabled: true, retentionDays: 90 } }
}

export function setRecommendationSettings(input: Partial<RecommendationSettings>): RecommendationSettings {
  const current = getRecommendationSettings()
  const next = {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    retentionDays: input.retentionDays == null ? current.retentionDays : Math.max(7, Math.min(365, Math.round(Number(input.retentionDays) || current.retentionDays))),
  }
  getDb().prepare("INSERT OR REPLACE INTO app_settings (library_id, key, value) VALUES (0, 'recommendations', ?)").run(JSON.stringify(next))
  invalidateRecommendationSnapshots()
  return next
}

type Candidate = RecommendationResult & {
  popularity?: number
  sourceKey?: string
  sourceSeed?: { mediaType: RecommendationMediaType; providerId: number; title: string } | null
}

interface Seed {
  mediaType: RecommendationMediaType
  providerId: number
  title: string
  weight: number
  genres: string[]
  people: string[]
  network?: string | null
  studio?: string | null
}

const jsonArray = (value: unknown): any[] => {
  if (Array.isArray(value)) return value
  try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}
const normalise = (value: unknown) => String(value ?? '').trim().toLowerCase()
const daysFromNow = (date?: string | null) => date ? (new Date(date).getTime() - Date.now()) / 86_400_000 : Number.NaN
const ageDays = (date?: string | null) => date ? Math.max(0, (Date.now() - new Date(date).getTime()) / 86_400_000) : 365
const recencyWeight = (date?: string | null) => 0.7 + 0.3 * Math.pow(0.5, ageDays(date) / 180)

function seedRows(audience: string): Seed[] {
  const db = getDb()
  const profileClause = audience === 'household' ? '' : 'AND pp.profile_id = ?'
  const params = audience === 'household' ? [] : [audience]
  const films = db.prepare(`
    SELECT f.*, MAX(pp.completed) AS completed, MAX(CASE WHEN pp.duration_seconds > 0 THEN pp.position_seconds / pp.duration_seconds ELSE 0 END) AS progress,
      MAX(pp.updated_at) AS watched_at
    FROM playback_progress pp JOIN films f ON pp.media_type = 'film' AND pp.media_id = f.id
    WHERE 1=1 ${profileClause}
    GROUP BY f.tmdb_id
    ORDER BY completed DESC, progress DESC, watched_at DESC LIMIT 20
  `).all(...params) as any[]
  const series = db.prepare(`
    SELECT s.*, COUNT(DISTINCT e.id) AS eligible,
      COUNT(DISTINCT CASE WHEN pp.completed = 1 THEN e.id END) AS completed_episodes,
      MAX(pp.updated_at) AS watched_at
    FROM series s JOIN episodes e ON e.series_id = s.id AND e.file_path IS NOT NULL
    LEFT JOIN playback_progress pp ON pp.media_type = 'episode' AND pp.media_id = e.id ${audience === 'household' ? '' : 'AND pp.profile_id = ?'}
    WHERE e.season_number > 0 AND (e.air_date IS NULL OR date(e.air_date) <= date('now'))
    GROUP BY s.tmdb_id, s.tvdb_id
    HAVING completed_episodes > 0
    ORDER BY (1.0 * completed_episodes / eligible) DESC, watched_at DESC LIMIT 20
  `).all(...params) as any[]

  const out: Seed[] = []
  for (const row of films) {
    if (!row.tmdb_id) continue
    const ratio = row.completed ? 1 : Math.max(0, Math.min(0.8, Number(row.progress) || 0))
    if (ratio < 0.1) continue
    const dormant = !row.completed && ratio >= 0.2 && ageDays(row.watched_at) > 60
    out.push({ mediaType: 'film', providerId: Number(row.tmdb_id), title: row.title, weight: row.completed ? recencyWeight(row.watched_at) : dormant ? -ratio * 0.15 : ratio * 0.45 * recencyWeight(row.watched_at),
      genres: jsonArray(row.genres).map(normalise), people: [...jsonArray(row.cast), ...jsonArray(row.crew)].map(person => normalise(person?.name)), studio: row.studio })
  }
  for (const row of series) {
    if (!row.tmdb_id) continue
    const ratio = Number(row.eligible) ? Number(row.completed_episodes) / Number(row.eligible) : 0
    const dormant = ratio < 0.99 && ratio >= 0.2 && ageDays(row.watched_at) > 60
    out.push({ mediaType: 'series', providerId: Number(row.tmdb_id), title: row.title, weight: ratio >= 0.99 ? recencyWeight(row.watched_at) : dormant ? -ratio * 0.15 : ratio * 0.45 * recencyWeight(row.watched_at),
      genres: jsonArray(row.genres).map(normalise), people: [...jsonArray(row.cast), ...jsonArray(row.crew)].map(person => normalise(person?.name)), network: row.network })
  }

  if (audience !== 'household') {
    const household = seedRows('household')
    if (out.length) {
      const blended = new Map<string, Seed>()
      for (const seed of household) blended.set(`${seed.mediaType}:${seed.providerId}`, { ...seed, weight: seed.weight * 0.25 })
      for (const seed of out) {
        const key = `${seed.mediaType}:${seed.providerId}`
        const existing = blended.get(key)
        blended.set(key, { ...seed, weight: seed.weight * 0.75 + (existing?.weight ?? 0) })
      }
      return [...blended.values()].sort((a, b) => b.weight - a.weight)
    }
    if (household.length) return household.map(seed => ({ ...seed, weight: seed.weight * 0.6 }))
  }

  if (!out.length) {
    const fallbackFilms = db.prepare('SELECT * FROM films WHERE tmdb_id IS NOT NULL ORDER BY rating DESC LIMIT 5').all() as any[]
    const fallbackSeries = db.prepare('SELECT * FROM series WHERE tmdb_id IS NOT NULL ORDER BY rating DESC LIMIT 5').all() as any[]
    for (const row of fallbackFilms) out.push({ mediaType: 'film', providerId: row.tmdb_id, title: row.title, weight: 0.2, genres: jsonArray(row.genres).map(normalise), people: [], studio: row.studio })
    for (const row of fallbackSeries) out.push({ mediaType: 'series', providerId: row.tmdb_id, title: row.title, weight: 0.2, genres: jsonArray(row.genres).map(normalise), people: [], network: row.network })
  }
  return out
}

function localCandidates(mediaType: RecommendationMediaType, libraryId: number): Candidate[] {
  const db = getDb()
  if (mediaType === 'film') return (db.prepare('SELECT * FROM films WHERE library_id = ? AND tmdb_id IS NOT NULL').all(libraryId) as any[]).map(row => ({
    mediaType, providerId: Number(row.tmdb_id), tmdbId: Number(row.tmdb_id), localId: Number(row.id), title: row.title, year: row.year ?? undefined,
    overview: row.overview ?? undefined, genres: jsonArray(row.genres), posterPath: row.poster_path ?? undefined, backdropPath: row.backdrop_path ?? undefined,
    rating: row.rating ?? undefined, alreadyAdded: true, status: row.file_path ? 'available' : row.status, studio: row.studio, cast: jsonArray(row.cast), crew: jsonArray(row.crew),
    releaseDate: row.release_date, recommendation: {} as any,
  }))
  return (db.prepare(`SELECT s.*, COUNT(e.id) AS total_episodes, COUNT(CASE WHEN e.file_path IS NOT NULL THEN 1 END) AS available_episodes,
      COUNT(CASE WHEN e.status IN ('downloading','acquiring') THEN 1 END) AS acquiring_episodes
    FROM series s LEFT JOIN episodes e ON e.series_id = s.id WHERE s.library_id = ? AND (s.tmdb_id IS NOT NULL OR s.tvdb_id IS NOT NULL)
    GROUP BY s.id`).all(libraryId) as any[]).map(row => ({
      mediaType, providerId: Number(row.tmdb_id ?? row.tvdb_id), tmdbId: row.tmdb_id ?? undefined, tvdbId: row.tvdb_id ?? undefined,
      localId: Number(row.id), title: row.title, year: row.year ?? undefined, overview: row.overview ?? undefined, genres: jsonArray(row.genres),
      posterPath: row.poster_path ?? undefined, backdropPath: row.backdrop_path ?? undefined, rating: row.rating ?? undefined, alreadyAdded: true,
      status: Number(row.acquiring_episodes) > 0 ? 'acquiring' : Number(row.available_episodes) > 0 ? (Number(row.available_episodes) < Number(row.total_episodes) ? 'partially_available' : 'available') : 'wanted',
      network: row.network, cast: jsonArray(row.cast), crew: jsonArray(row.crew), firstAirDate: row.year ? `${row.year}-01-01` : undefined,
      recommendation: {} as any,
    }))
}

function cachedExternalCandidates(mediaType: RecommendationMediaType): Candidate[] {
  const rows = getDb().prepare(`SELECT payload, source_key FROM recommendation_source_candidates
    WHERE media_type = ? AND datetime(expires_at) > datetime('now') ORDER BY fetched_at DESC`).all(mediaType) as any[]
  const unique = new Map<number, Candidate>()
  for (const row of rows) {
    try {
      const item = JSON.parse(row.payload) as Candidate
      const prior = unique.get(item.providerId)
      if (!prior || String(row.source_key).startsWith('seed:')) unique.set(item.providerId, { ...item, sourceKey: row.source_key })
    } catch {}
  }
  return [...unique.values()]
}

function completedProviderIds(audience: string, mediaType: RecommendationMediaType): Set<number> {
  const db = getDb()
  if (mediaType === 'film') {
    const rows = db.prepare(`SELECT DISTINCT f.tmdb_id AS id FROM playback_progress pp JOIN films f ON f.id = pp.media_id
      WHERE pp.media_type = 'film' AND pp.completed = 1 AND f.tmdb_id IS NOT NULL ${audience === 'household' ? '' : 'AND pp.profile_id = ?'}`)
      .all(...(audience === 'household' ? [] : [audience])) as any[]
    return new Set(rows.map(row => Number(row.id)))
  }
  const rows = db.prepare(`SELECT s.tmdb_id AS id, COUNT(e.id) AS eligible, COUNT(CASE WHEN pp.completed = 1 THEN 1 END) AS watched
    FROM series s JOIN episodes e ON e.series_id = s.id AND e.file_path IS NOT NULL
    LEFT JOIN playback_progress pp ON pp.media_type = 'episode' AND pp.media_id = e.id ${audience === 'household' ? '' : 'AND pp.profile_id = ?'}
    WHERE s.tmdb_id IS NOT NULL AND e.season_number > 0 AND (e.air_date IS NULL OR date(e.air_date) <= date('now')) GROUP BY s.tmdb_id HAVING watched >= eligible AND eligible > 0`)
    .all(...(audience === 'household' ? [] : [audience])) as any[]
  return new Set(rows.map(row => Number(row.id)))
}

function feedbackFor(audience: string, mediaType: RecommendationMediaType): Map<number, RecommendationFeedback> {
  if (audience === 'household') return new Map()
  return new Map((getDb().prepare('SELECT provider_id, feedback FROM recommendation_feedback WHERE profile_id = ? AND media_type = ?').all(audience, mediaType) as any[])
    .map(row => [Number(row.provider_id), row.feedback as RecommendationFeedback]))
}

function availability(candidate: Candidate): RecommendationResult['recommendation']['availability'] {
  if (!candidate.alreadyAdded) {
    const date = typeof candidate.releaseDate === 'string' ? candidate.releaseDate
      : typeof candidate.firstAirDate === 'string' ? candidate.firstAirDate : undefined
    return Number.isFinite(daysFromNow(date)) && daysFromNow(date) > 0 ? 'upcoming' : 'external'
  }
  if (candidate.status === 'collected' || candidate.status === 'available') return 'available'
  if (candidate.status === 'partially_available') return 'partially_available'
  if (candidate.status === 'acquiring' || candidate.status === 'downloading') return 'downloading'
  if (candidate.status === 'processing') return 'processing'
  return 'wanted'
}

function rankCandidates(candidates: Candidate[], seeds: Seed[], audience: string, mediaType: RecommendationMediaType): Candidate[] {
  const completed = completedProviderIds(audience, mediaType)
  const feedback = feedbackFor(audience, mediaType)
  const seedIds = new Set(seeds.filter(seed => seed.mediaType === mediaType).map(seed => seed.providerId))
  const scored = candidates.filter(candidate => !completed.has(candidate.providerId) && feedback.get(candidate.providerId) !== 'not_interested' && feedback.get(candidate.providerId) !== 'already_seen')
    .map(candidate => {
      let score = Math.min(20, Math.max(0, Number(candidate.rating) || 0) * 2) + Math.min(10, Math.log10(1 + (Number(candidate.popularity) || 0)) * 3)
      let best: { value: number; reason: string; code: string; seed?: Seed } = { value: 0, reason: candidate.alreadyAdded ? 'A highly rated title already in your museum' : 'Popular with viewers', code: candidate.alreadyAdded ? 'library_quality' : 'popular' }
      const candidateGenres = new Set((candidate.genres ?? []).map(normalise))
      const people = new Set([...jsonArray((candidate as any).cast), ...jsonArray((candidate as any).crew)].map(person => normalise(person?.name)))
      for (const seed of seeds) {
        const genreOverlap = seed.genres.filter(genre => candidateGenres.has(genre)).length
        const peopleOverlap = seed.people.filter(person => person && people.has(person)).length
        const entity = mediaType === 'film' ? normalise((candidate as any).studio) === normalise(seed.studio) : normalise((candidate as any).network) === normalise(seed.network)
        const sourceMatch = candidate.sourceKey === `seed:${seed.mediaType}:${seed.providerId}`
        const contribution = seed.weight * (genreOverlap * 12 + peopleOverlap * 15 + (entity ? 8 : 0) + (sourceMatch ? 30 : 0))
        score += contribution
        if (contribution > best.value) best = { value: contribution, reason: `Because you finished ${seed.title}`, code: sourceMatch ? 'seed_recommendation' : genreOverlap ? 'shared_genres' : peopleOverlap ? 'shared_people' : 'shared_entity', seed }
      }
      if (candidate.alreadyAdded) score += 7
      if (feedback.get(candidate.providerId) === 'more_like_this') score += 40
      if (feedback.get(candidate.providerId) === 'less_like_this') score -= 35
      if (seedIds.has(candidate.providerId)) score -= 25
      return { candidate, score, best }
    })
    .sort((a, b) => b.score - a.score || a.candidate.title.localeCompare(b.candidate.title))

  const genreCount = new Map<string, number>()
  const selected: Candidate[] = []
  for (const entry of scored) {
    const dominant = normalise(entry.candidate.genres?.[0])
    if (dominant && (genreCount.get(dominant) ?? 0) >= 4 && selected.length < 24) continue
    if (dominant) genreCount.set(dominant, (genreCount.get(dominant) ?? 0) + 1)
    ;(entry.candidate as any).__reason = entry.best
    selected.push(entry.candidate)
    if (selected.length >= 60) break
  }
  return selected
}

function groupsFor(items: RecommendationResult[]): RecommendationPage['groups'] {
  const used = new Set<string>()
  const take = (predicate: (item: RecommendationResult) => boolean) => {
    const selected: RecommendationResult[] = []
    for (const item of items) {
      const key = `${item.mediaType}:${item.providerId}`
      if (used.has(key) || !predicate(item)) continue
      used.add(key); selected.push(item)
      if (selected.length === 18) break
    }
    return selected
  }
  const groups: RecommendationPage['groups'] = [
    { id: 'because', title: 'Because You Finished…', items: take(item => item.recommendation.reasonCode.startsWith('seed_')) },
    { id: 'museum', title: 'In Your Museum', items: take(item => ['available', 'partially_available'].includes(item.recommendation.availability)) },
    { id: 'discoveries', title: 'New Discoveries', items: take(item => item.recommendation.availability === 'external') },
    { id: 'coming', title: 'Coming to the Museum', items: take(item => ['wanted', 'queued', 'downloading', 'processing'].includes(item.recommendation.availability)) },
    { id: 'upcoming', title: 'Upcoming', items: take(item => item.recommendation.availability === 'upcoming') },
  ]
  return groups.filter(group => group.items.length)
}

export function generateRecommendationSnapshot(mediaType: RecommendationMediaType, audience: string, libraryId: number): RecommendationPage {
  const db = getDb()
  const seeds = seedRows(audience)
  const local = localCandidates(mediaType, libraryId)
  const localIds = new Map(local.map(item => [item.providerId, item]))
  const external = cachedExternalCandidates(mediaType).filter(item => !localIds.has(item.providerId))
  const ranked = rankCandidates([...local, ...external], seeds, audience, mediaType)
  const now = new Date().toISOString()
  let items: RecommendationResult[] = []
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO recommendation_snapshots (audience, media_type, library_id, model_version, items, generated_at, invalidated_at)
      VALUES (?, ?, ?, ?, '[]', ?, NULL)
      ON CONFLICT(audience, media_type, library_id) DO UPDATE SET model_version=excluded.model_version, items='[]', generated_at=excluded.generated_at, invalidated_at=NULL`)
      .run(audience, mediaType, libraryId, RECOMMENDATION_MODEL_VERSION, now)
    const snapshot = db.prepare('SELECT id FROM recommendation_snapshots WHERE audience = ? AND media_type = ? AND library_id = ?').get(audience, mediaType, libraryId) as { id: number }
    items = ranked.map(candidate => {
      const reason = (candidate as any).__reason as { reason: string; code: string; seed?: Seed }
      const { sourceKey: _sourceKey, sourceSeed: _sourceSeed, popularity: _popularity, __reason: _reason, ...result } = candidate as any
      return { ...result, recommendation: {
        reason: reason.reason, reasonCode: reason.code, availability: availability(candidate), scoreVersion: RECOMMENDATION_MODEL_VERSION,
        snapshotId: snapshot.id, sources: candidate.sourceKey ? [candidate.sourceKey.split(':')[0]] : ['library'],
        seed: reason.seed ? { mediaType: reason.seed.mediaType, providerId: reason.seed.providerId, title: reason.seed.title } : null,
      } }
    })
    db.prepare('UPDATE recommendation_snapshots SET items = ? WHERE id = ?').run(JSON.stringify(items), snapshot.id)
  })
  transaction()
  return { audience, mediaType, generatedAt: now, stale: false, modelVersion: RECOMMENDATION_MODEL_VERSION, groups: groupsFor(items) }
}

const snapshotRebuilds = new Set<string>()
function scheduleSnapshotRebuild(mediaType: RecommendationMediaType, audience: string, libraryId: number): void {
  const key = `${audience}:${mediaType}:${libraryId}`
  if (snapshotRebuilds.has(key)) return
  snapshotRebuilds.add(key)
  const timer = setTimeout(() => {
    try { generateRecommendationSnapshot(mediaType, audience, libraryId) }
    catch (error) { logger.warn('Snapshot rebuild failed:', error instanceof Error ? error.message : String(error)) }
    finally { snapshotRebuilds.delete(key) }
  }, 0)
  timer.unref?.()
}

export function getRecommendationPage(mediaType: RecommendationMediaType, audience: string, libraryId: number): RecommendationPage {
  if (!getRecommendationSettings().enabled) return { audience, mediaType, generatedAt: new Date().toISOString(), stale: false, modelVersion: RECOMMENDATION_MODEL_VERSION, groups: [] }
  const row = getDb().prepare('SELECT * FROM recommendation_snapshots WHERE audience = ? AND media_type = ? AND library_id = ?').get(audience, mediaType, libraryId) as any
  if (!row || row.invalidated_at) return generateRecommendationSnapshot(mediaType, audience, libraryId)
  const age = Date.now() - new Date(row.generated_at).getTime()
  let items: RecommendationResult[]
  try { items = JSON.parse(row.items) } catch { return generateRecommendationSnapshot(mediaType, audience, libraryId) }
  const stale = age > SNAPSHOT_MAX_AGE_MS
  if (stale) scheduleSnapshotRebuild(mediaType, audience, libraryId)
  return { audience, mediaType, generatedAt: row.generated_at, stale, modelVersion: row.model_version, groups: groupsFor(items) }
}

export function invalidateRecommendationSnapshots(profileId?: string): void {
  const db = getDb()
  if (profileId) db.prepare("UPDATE recommendation_snapshots SET invalidated_at = datetime('now') WHERE audience IN (?, 'household')").run(profileId)
  else db.prepare("UPDATE recommendation_snapshots SET invalidated_at = datetime('now')").run()
}

export function recordEngagement(input: { profileId: string; mediaType: 'film' | 'episode'; mediaId: number; positionSeconds: number; durationSeconds: number | null; completed: boolean; cleared?: boolean }): void {
  const percent = input.durationSeconds && input.durationSeconds > 0 ? Math.min(100, input.positionSeconds / input.durationSeconds * 100) : null
  const last = getDb().prepare('SELECT event_type FROM engagement_events WHERE profile_id = ? AND media_type = ? AND media_id = ? ORDER BY id DESC LIMIT 1').get(input.profileId, input.mediaType, input.mediaId) as any
  const eventType = input.cleared ? 'cleared' : input.completed ? (last?.event_type === 'completed' ? 'replayed' : 'completed') : (percent ?? 0) < 2 ? 'started' : 'progress'
  getDb().prepare('INSERT INTO engagement_events (profile_id, media_type, media_id, event_type, progress_percent) VALUES (?, ?, ?, ?, ?)')
    .run(input.profileId, input.mediaType, input.mediaId, eventType, percent)
  invalidateRecommendationSnapshots(input.profileId)
}

export function setRecommendationFeedback(profileId: string, mediaType: RecommendationMediaType, providerId: number, feedback: RecommendationFeedback): void {
  getDb().prepare(`INSERT INTO recommendation_feedback (profile_id, media_type, provider_id, feedback)
    VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, media_type, provider_id) DO UPDATE SET feedback=excluded.feedback, updated_at=datetime('now')`)
    .run(profileId, mediaType, providerId, feedback)
  invalidateRecommendationSnapshots(profileId)
}

function storeExternal(mediaType: RecommendationMediaType, sourceKey: string, rows: any[], seed?: Seed): void {
  const db = getDb()
  const expiry = new Date(Date.now() + CANDIDATE_TTL_MS).toISOString()
  const insert = db.prepare(`INSERT INTO recommendation_source_candidates (media_type, provider_id, source_key, payload, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, datetime('now'), ?) ON CONFLICT(media_type, provider_id, source_key) DO UPDATE SET payload=excluded.payload, fetched_at=datetime('now'), expires_at=excluded.expires_at`)
  db.transaction(() => {
    for (const row of rows) {
      const providerId = Number(row.tmdbId)
      if (!providerId || !row.title) continue
      const candidate: Candidate = { mediaType, providerId, tmdbId: providerId, title: row.title, year: row.year, overview: row.overview,
        genres: row.genres ?? [], posterPath: row.posterPath, backdropPath: row.backdropPath, rating: row.rating, popularity: row.popularity,
        alreadyAdded: false, status: row.status, releaseDate: row.releaseDate, firstAirDate: row.firstAirDate,
        sourceKey, sourceSeed: seed ? { mediaType: seed.mediaType, providerId: seed.providerId, title: seed.title } : null, recommendation: {} as any }
      insert.run(mediaType, providerId, sourceKey, JSON.stringify(candidate), expiry)
    }
  })()
}

let externalRefreshInFlight: Promise<{ films: number; series: number }> | null = null

async function performExternalRecommendationRefresh(): Promise<{ films: number; series: number }> {
  const db = getDb()
  db.prepare("DELETE FROM recommendation_source_candidates WHERE datetime(expires_at) <= datetime('now')").run()
  const settings = getRecommendationSettings()
  const retentionDays = settings.retentionDays
  db.prepare("DELETE FROM recommendation_exposures WHERE exposed_at < datetime('now', ?)").run(`-${retentionDays} days`)
  db.prepare("DELETE FROM engagement_events WHERE occurred_at < datetime('now', ?)").run(`-${retentionDays} days`)
  if (!settings.enabled || !sanitizeConfigValue(process.env.TMDB_API_KEY)) return { films: 0, series: 0 }
  const seeds = seedRows('household').sort((a, b) => b.weight - a.weight).slice(0, 12)
  let films = 0; let series = 0
  const discovered = await Promise.allSettled([discoverMovies(), discoverSeriesTmdb()])
  if (discovered[0].status === 'fulfilled') { films += discovered[0].value.length; storeExternal('film', 'discover:weekly', discovered[0].value) }
  if (discovered[1].status === 'fulfilled') { series += discovered[1].value.length; storeExternal('series', 'discover:weekly', discovered[1].value) }
  for (const seed of seeds) {
    try {
      if (seed.mediaType === 'film') { const rows = await getMovieRecommendations(seed.providerId); films += rows.length; storeExternal('film', `seed:film:${seed.providerId}`, rows, seed) }
      else { const rows = await getSeriesRecommendationsTmdb(seed.providerId); series += rows.length; storeExternal('series', `seed:series:${seed.providerId}`, rows, seed) }
    } catch (err) { logger.warn(`Candidate source failed for ${seed.title}:`, err instanceof Error ? err.message : String(err)) }
  }
  invalidateRecommendationSnapshots()
  return { films, series }
}

export function refreshExternalRecommendationCandidates(): Promise<{ films: number; series: number }> {
  if (externalRefreshInFlight) return externalRefreshInFlight
  externalRefreshInFlight = performExternalRecommendationRefresh().finally(() => { externalRefreshInFlight = null })
  return externalRefreshInFlight
}

/** Populate an empty external cache before serving its first page. */
export async function ensureExternalRecommendationCandidates(mediaType: RecommendationMediaType): Promise<void> {
  if (!getRecommendationSettings().enabled || !sanitizeConfigValue(process.env.TMDB_API_KEY)) return
  const cached = getDb().prepare(`SELECT COUNT(*) AS count FROM recommendation_source_candidates
    WHERE media_type = ? AND datetime(expires_at) > datetime('now')`).get(mediaType) as { count: number }
  if (Number(cached.count) > 0) return
  await refreshExternalRecommendationCandidates()
}

export function recommendationHealth(): Record<string, unknown> {
  const db = getDb()
  const settings = getRecommendationSettings()
  return {
    enabled: settings.enabled, settings, modelVersion: RECOMMENDATION_MODEL_VERSION,
    candidates: db.prepare('SELECT media_type, COUNT(*) AS count, MAX(fetched_at) AS refreshedAt FROM recommendation_source_candidates GROUP BY media_type').all(),
    snapshots: db.prepare('SELECT audience, media_type, library_id AS libraryId, generated_at AS generatedAt, invalidated_at AS invalidatedAt FROM recommendation_snapshots ORDER BY generated_at DESC').all(),
    feedbackCount: (db.prepare('SELECT COUNT(*) AS count FROM recommendation_feedback').get() as any).count,
  }
}

let refreshTimer: NodeJS.Timeout | null = null
let initialRefreshTimer: NodeJS.Timeout | null = null
export function startRecommendationScheduler(): void {
  if (refreshTimer) return
  const run = () => void refreshExternalRecommendationCandidates().catch(error => logger.warn('External refresh failed:', error instanceof Error ? error.message : String(error)))
  // Do not let the UI create a library-only snapshot before TMDB refresh starts.
  initialRefreshTimer = setTimeout(run, 0); initialRefreshTimer.unref?.()
  refreshTimer = setInterval(run, 6 * 60 * 60 * 1000); refreshTimer.unref?.()
}
export function stopRecommendationScheduler(): void {
  if (initialRefreshTimer) clearTimeout(initialRefreshTimer)
  if (refreshTimer) clearInterval(refreshTimer)
  initialRefreshTimer = null; refreshTimer = null
}
