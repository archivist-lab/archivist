import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { discoverMoviesWith, getMovieGenreMap, getMovieRecommendations, type TmdbMovie } from '../modules/films/tmdb.js'
import { discoverSeriesWith, getSeriesGenreMap, getSeriesRecommendationsTmdb, type SeriesSearchResult } from '../modules/series/tvdb.js'

// ── "For You" — a taste-based discovery list built from the Archivist library ──
// Unlike Overseerr/Jellyseerr, which surface TMDB's per-title "similar"/"recommended"
// lists or raw trending, this builds a single weighted taste profile from the WHOLE
// library (genres, favourite actors/directors, each item weighted by its rating),
// then gathers candidates from several TMDB sources — per-title recommendations for
// your best titles, plus /discover queries seeded by your top genres and people —
// and ranks them by:
//   • genre affinity against your taste vector,
//   • a quality signal (rating) with a popularity floor to cut obscure junk,
//   • multi-source consensus (a title surfaced by several of your seeds ranks higher),
//   • a bonus when it features people you already collect.
// Diversity is capped so one genre can't dominate, and anything already owned is
// excluded. Results are cached per library for a few hours to bound TMDB calls.

const logger = createLogger('ForYou')
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const filmCache = new Map<number, { at: number; items: TmdbMovie[] }>()
const seriesCache = new Map<number, { at: number; items: SeriesSearchResult[] }>()

const jsonArray = (value: unknown): any[] => {
  if (Array.isArray(value)) return value
  try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}
const norm = (value: unknown) => String(value ?? '').trim().toLowerCase()

interface Taste {
  genreWeight: Map<string, number>
  topGenreIds: number[]
  actorIds: number[]
  crewIds: number[]
  libraryIds: Set<number>
  size: number
}

function buildTaste(rows: any[], genreNameToId: Map<string, number>, crewJob: string): Taste {
  const genreWeight = new Map<string, number>()
  const personWeight = new Map<number, { weight: number; crew: boolean }>()
  const libraryIds = new Set<number>()
  for (const row of rows) {
    libraryIds.add(Number(row.tmdb_id))
    // Weight each owned title by its quality, and boost anything you've actually
    // watched so viewing history shapes taste more than a title merely sitting
    // in the library.
    const quality = Math.min(1, Math.max(0, (Number(row.rating) || 6) / 10))
    const weight = (0.4 + 0.6 * quality) * (Number(row.watched) > 0 ? 1.6 : 1)
    for (const genre of jsonArray(row.genres)) {
      const key = norm(genre)
      if (key) genreWeight.set(key, (genreWeight.get(key) ?? 0) + weight)
    }
    for (const person of jsonArray(row.cast).slice(0, 5)) {
      const id = Number(person?.id)
      if (!id) continue
      const current = personWeight.get(id) ?? { weight: 0, crew: false }
      current.weight += weight
      personWeight.set(id, current)
    }
    for (const person of jsonArray(row.crew)) {
      if (norm(person?.job) !== crewJob) continue
      const id = Number(person?.id)
      if (!id) continue
      const current = personWeight.get(id) ?? { weight: 0, crew: true }
      current.weight += weight * 1.5
      current.crew = true
      personWeight.set(id, current)
    }
  }
  const topGenreIds = [...genreWeight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name]) => genreNameToId.get(name)).filter((id): id is number => typeof id === 'number')
  const people = [...personWeight.entries()].sort((a, b) => b[1].weight - a[1].weight)
  const crewIds = people.filter(([, value]) => value.crew).slice(0, 2).map(([id]) => id)
  const actorIds = people.filter(([, value]) => !value.crew).slice(0, 3).map(([id]) => id)
  return { genreWeight, topGenreIds, actorIds, crewIds, libraryIds, size: rows.length }
}

interface Candidate { tmdbId?: number; genres?: string[]; rating?: number; popularity?: number }

function rankByTaste<T extends Candidate>(buckets: Array<{ from: string; rows: T[] }>, taste: Taste): T[] {
  const totalGenreWeight = [...taste.genreWeight.values()].reduce((sum, value) => sum + value, 0) || 1
  const aggregated = new Map<number, { item: T; sources: Set<string>; peopleHit: boolean }>()
  for (const bucket of buckets) {
    for (const item of bucket.rows) {
      const id = Number(item.tmdbId)
      if (!id || taste.libraryIds.has(id)) continue
      const entry = aggregated.get(id) ?? { item, sources: new Set<string>(), peopleHit: false }
      entry.sources.add(bucket.from.startsWith('seed:') ? 'seed' : bucket.from)
      if (bucket.from === 'cast' || bucket.from === 'crew') entry.peopleHit = true
      aggregated.set(id, entry)
    }
  }

  const scored = [...aggregated.values()].map(entry => {
    const item = entry.item
    const genreAffinity = (item.genres ?? []).reduce((sum, genre) => sum + (taste.genreWeight.get(norm(genre)) ?? 0), 0) / totalGenreWeight
    const quality = Math.min(1, Math.max(0, ((item.rating ?? 0) - 5) / 5))
    const popularity = Math.min(1, Math.log10(1 + (item.popularity ?? 0)) / 3)
    const consensus = entry.sources.size
    const score = genreAffinity * 40 + quality * 25 + popularity * 8 + consensus * 12 + (entry.peopleHit ? 18 : 0)
    return { item, score, dominant: norm(item.genres?.[0]) }
  })
    .filter(entry => (entry.item.popularity ?? 0) >= 5) // quality floor: drop obscure noise
    .sort((a, b) => b.score - a.score)

  const genreCount = new Map<string, number>()
  const out: T[] = []
  for (const entry of scored) {
    if (entry.dominant && (genreCount.get(entry.dominant) ?? 0) >= 6) continue // diversity cap
    if (entry.dominant) genreCount.set(entry.dominant, (genreCount.get(entry.dominant) ?? 0) + 1)
    out.push(entry.item)
    if (out.length >= 60) break
  }
  return out
}

export async function recommendMoviesForLibrary(libraryId: number): Promise<TmdbMovie[]> {
  const cached = filmCache.get(libraryId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items
  try {
    const genreMap = await getMovieGenreMap()
    const nameToId = new Map([...genreMap.entries()].map(([id, name]) => [norm(name), id]))
    // NB: "cast" is a SQLite keyword, so it must be quoted. `watched` folds in
    // viewing history from playback_progress.
    const rows = getDb().prepare(`
      SELECT f.tmdb_id, f.genres, f."cast", f.crew, f.rating, MAX(pp.completed) AS watched
      FROM films f LEFT JOIN playback_progress pp ON pp.media_type = 'film' AND pp.media_id = f.id
      WHERE f.library_id = ? AND f.tmdb_id IS NOT NULL GROUP BY f.id
    `).all(libraryId) as any[]
    const taste = buildTaste(rows, nameToId, 'director')

    let items: TmdbMovie[]
    if (taste.size === 0) {
      items = await discoverMoviesWith({ sort_by: 'popularity.desc', 'vote_count.gte': 500 })
    } else {
      // Seed from what you've watched first, then your highest-rated titles.
      const seedIds = (getDb().prepare(`
        SELECT f.tmdb_id, MAX(pp.completed) AS watched
        FROM films f LEFT JOIN playback_progress pp ON pp.media_type = 'film' AND pp.media_id = f.id
        WHERE f.library_id = ? AND f.tmdb_id IS NOT NULL GROUP BY f.id
        ORDER BY watched DESC, f.rating DESC LIMIT 8
      `).all(libraryId) as any[]).map(row => Number(row.tmdb_id))
      const empty: TmdbMovie[] = []
      const sources = await Promise.all([
        ...seedIds.map(id => getMovieRecommendations(id).then(rows => ({ from: `seed:${id}`, rows })).catch(() => ({ from: `seed:${id}`, rows: empty }))),
        taste.topGenreIds.length ? discoverMoviesWith({ with_genres: taste.topGenreIds.join('|'), sort_by: 'vote_average.desc', 'vote_count.gte': 400 }).then(rows => ({ from: 'genre', rows })).catch(() => ({ from: 'genre', rows: empty })) : Promise.resolve({ from: 'genre', rows: empty }),
        taste.actorIds.length ? discoverMoviesWith({ with_cast: taste.actorIds.join('|'), sort_by: 'popularity.desc', 'vote_count.gte': 150 }).then(rows => ({ from: 'cast', rows })).catch(() => ({ from: 'cast', rows: empty })) : Promise.resolve({ from: 'cast', rows: empty }),
        taste.crewIds.length ? discoverMoviesWith({ with_crew: taste.crewIds.join('|'), sort_by: 'popularity.desc' }).then(rows => ({ from: 'crew', rows })).catch(() => ({ from: 'crew', rows: empty })) : Promise.resolve({ from: 'crew', rows: empty }),
      ])
      items = rankByTaste(sources, taste)
    }
    filmCache.set(libraryId, { at: Date.now(), items })
    return items
  } catch (error) {
    logger.warn('Film recommendations failed:', error instanceof Error ? error.message : String(error))
    return cached?.items ?? []
  }
}

export async function recommendSeriesForLibrary(libraryId: number): Promise<SeriesSearchResult[]> {
  const cached = seriesCache.get(libraryId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items
  try {
    const genreMap = await getSeriesGenreMap()
    const nameToId = new Map([...genreMap.entries()].map(([id, name]) => [norm(name), id]))
    // "cast" is a SQLite keyword (quote it); `watched` rolls up completed
    // episodes so viewing history shapes taste.
    const rows = getDb().prepare(`
      SELECT s.tmdb_id, s.genres, s."cast", s.crew, s.rating,
        MAX(CASE WHEN pp.completed = 1 THEN 1 ELSE 0 END) AS watched
      FROM series s
      LEFT JOIN episodes e ON e.series_id = s.id
      LEFT JOIN playback_progress pp ON pp.media_type = 'episode' AND pp.media_id = e.id
      WHERE s.library_id = ? AND s.tmdb_id IS NOT NULL GROUP BY s.id
    `).all(libraryId) as any[]
    const taste = buildTaste(rows, nameToId, 'creator')

    let items: SeriesSearchResult[]
    if (taste.size === 0) {
      items = await discoverSeriesWith({ sort_by: 'popularity.desc', 'vote_count.gte': 300 })
    } else {
      // Seed from shows you've watched first, then your highest-rated titles.
      const seedIds = (getDb().prepare(`
        SELECT s.tmdb_id, MAX(CASE WHEN pp.completed = 1 THEN 1 ELSE 0 END) AS watched
        FROM series s
        LEFT JOIN episodes e ON e.series_id = s.id
        LEFT JOIN playback_progress pp ON pp.media_type = 'episode' AND pp.media_id = e.id
        WHERE s.library_id = ? AND s.tmdb_id IS NOT NULL GROUP BY s.id
        ORDER BY watched DESC, s.rating DESC LIMIT 8
      `).all(libraryId) as any[]).map(row => Number(row.tmdb_id))
      const empty: SeriesSearchResult[] = []
      // TMDB /discover/tv has no with_cast/with_crew, so series taste leans on
      // per-title recommendations plus a top-genre discover query.
      const sources = await Promise.all([
        ...seedIds.map(id => getSeriesRecommendationsTmdb(id).then(rows => ({ from: `seed:${id}`, rows })).catch(() => ({ from: `seed:${id}`, rows: empty }))),
        taste.topGenreIds.length ? discoverSeriesWith({ with_genres: taste.topGenreIds.join('|'), sort_by: 'vote_average.desc', 'vote_count.gte': 200 }).then(rows => ({ from: 'genre', rows })).catch(() => ({ from: 'genre', rows: empty })) : Promise.resolve({ from: 'genre', rows: empty }),
      ])
      items = rankByTaste(sources, taste)
    }
    seriesCache.set(libraryId, { at: Date.now(), items })
    return items
  } catch (error) {
    logger.warn('Series recommendations failed:', error instanceof Error ? error.message : String(error))
    return cached?.items ?? []
  }
}
