import { chunked, placeholders, stmt } from '../../shared/repository.js'

/**
 * Data access for `series` (and the season/episode lookups the series routes
 * repeat most). Mirrors modules/films/repo.ts; see shared/repository.ts for why
 * statements are cached rather than prepared inline.
 *
 * Series carry two provider ids — TMDB and TVDB — and either may identify a show,
 * so ownership checks match on both.
 */

export interface SeriesRow {
  id: number
  library_id: number
  tvdb_id: number | null
  tmdb_id: number | null
  imdb_id: string | null
  title: string
  sort_title: string | null
  year: number | null
  overview: string | null
  network: string | null
  status: string | null
  series_type: string | null
  runtime: number | null
  genres: string | null
  poster_path: string | null
  backdrop_path: string | null
  logo_path: string | null
  banner_path: string | null
  trailer_url: string | null
  cast: string | null
  crew: string | null
  country: string | null
  rating: number | null
  certification: string | null
  language: string | null
  monitored: number
  quality_profile_id: number | null
  root_folder_path: string | null
  upgrade_allowed: number | null
  // As with films, target/minimum tiers are TEXT labels.
  target_tier: string | null
  target_resolution: string | null
  target_source: string | null
  target_codec: string | null
  minimum_tier: string | null
  minimum_resolution: string | null
  minimum_source: string | null
  minimum_codec: string | null
  air_time: string | null
  air_day: string | null
  last_metadata_refresh_at: string | null
  next_metadata_refresh_at: string | null
  refresh_interval_hours: number | null
  added_at: string
  updated_at: string
  [key: string]: unknown
}

/** A series scoped to its library. */
export function findById(libraryId: number, id: number | string): SeriesRow | undefined {
  return stmt('SELECT * FROM series WHERE id = ? AND library_id = ?').get(id, libraryId) as SeriesRow | undefined
}

/** A series by primary key, ignoring library scope (internal/background use). */
export function findByIdUnscoped(id: number | string): SeriesRow | undefined {
  return stmt('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow | undefined
}

/** True when the library already holds this show under either provider id. */
export function existsByProviderId(libraryId: number, tmdbId?: number | null, tvdbId?: number | null): boolean {
  return stmt('SELECT 1 FROM series WHERE library_id = ? AND (tmdb_id = ? OR tvdb_id = ?) LIMIT 1')
    .get(libraryId, tmdbId ?? 0, tvdbId ?? 0) !== undefined
}

/**
 * Ownership lookup for a page of discovery results in one query per provider,
 * replacing one query per candidate. Returns the TMDB and TVDB ids present in the
 * library so callers can test whichever id a result carries.
 */
export function ownedProviderIds(
  libraryId: number,
  candidates: Array<{ tmdbId?: number | null; tvdbId?: number | null }>,
): { tmdb: Set<number>; tvdb: Set<number> } {
  const tmdbIds = [...new Set(candidates.map(c => Number(c.tmdbId)).filter(Boolean))]
  const tvdbIds = [...new Set(candidates.map(c => Number(c.tvdbId)).filter(Boolean))]
  const tmdb = new Set<number>()
  const tvdb = new Set<number>()

  for (const batch of chunked(tmdbIds)) {
    const rows = stmt(`SELECT tmdb_id FROM series WHERE library_id = ? AND tmdb_id IN (${placeholders(batch.length)})`)
      .all(libraryId, ...batch) as Array<{ tmdb_id: number }>
    for (const row of rows) tmdb.add(Number(row.tmdb_id))
  }
  for (const batch of chunked(tvdbIds)) {
    const rows = stmt(`SELECT tvdb_id FROM series WHERE library_id = ? AND tvdb_id IN (${placeholders(batch.length)})`)
      .all(libraryId, ...batch) as Array<{ tvdb_id: number }>
    for (const row of rows) tvdb.add(Number(row.tvdb_id))
  }
  return { tmdb, tvdb }
}

/** Convenience predicate over the sets returned by {@link ownedProviderIds}. */
export function isOwned(owned: { tmdb: Set<number>; tvdb: Set<number> }, candidate: { tmdbId?: number | null; tvdbId?: number | null }): boolean {
  return (candidate.tmdbId != null && owned.tmdb.has(Number(candidate.tmdbId)))
    || (candidate.tvdbId != null && owned.tvdb.has(Number(candidate.tvdbId)))
}

/** Provider identifiers for a single show. */
export function providerIds(id: number | string): { tvdb_id: number | null; tmdb_id: number | null; imdb_id: string | null } | undefined {
  return stmt('SELECT tvdb_id, tmdb_id, imdb_id FROM series WHERE id = ?').get(id) as
    { tvdb_id: number | null; tmdb_id: number | null; imdb_id: string | null } | undefined
}

// ── Seasons / episodes ────────────────────────────────────────────────────────

export function findSeasonById(id: number | string): Record<string, unknown> | undefined {
  return stmt('SELECT * FROM seasons WHERE id = ?').get(id) as Record<string, unknown> | undefined
}

export function findSeasonNumber(seriesId: number, seasonNumber: number): { id: number } | undefined {
  return stmt('SELECT id FROM seasons WHERE series_id = ? AND season_number = ?').get(seriesId, seasonNumber) as { id: number } | undefined
}

export function findEpisodeById(id: number | string): Record<string, unknown> | undefined {
  return stmt('SELECT * FROM episodes WHERE id = ?').get(id) as Record<string, unknown> | undefined
}
