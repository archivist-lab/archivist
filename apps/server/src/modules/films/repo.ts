import { chunked, placeholders, stmt } from '../../shared/repository.js'

/**
 * Data access for the `films` table.
 *
 * Covers the lookups that were previously re-prepared inline on every request,
 * and replaces the per-result ownership checks that ran one query per candidate.
 * Dynamic/one-off SQL still lives in the route that needs it.
 */

export interface FilmRow {
  id: number
  library_id: number
  tmdb_id: number | null
  imdb_id: string | null
  title: string
  original_title: string | null
  sort_title: string | null
  year: number | null
  overview: string | null
  runtime: number | null
  genres: string
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
  studio: string | null
  collection_tmdb_id: number | null
  collection_name: string | null
  collection_poster_path: string | null
  collection_backdrop_path: string | null
  collection_metadata_checked_at: string | null
  status: string
  monitored: number
  quality_profile_id: number | null
  root_folder_path: string | null
  file_path: string | null
  file_size: number | null
  quality: string | null
  added_at: string
  updated_at: string
  download_progress: number | null
  info_hash: string | null
  release_date: string | null
  digital_release_date: string | null
  physical_release_date: string | null
  last_metadata_refresh_at: string | null
  post_release_metadata_refreshed_at: string | null
  acquired_at: string | null
  download_tier: number | null
  // Quality envelope: target = ceiling, minimum = floor, current = what is on disk.
  // Note the asymmetry, which mirrors the schema: target/minimum tiers are TEXT
  // labels ("Tier 1"), while current/download tiers are INTEGER scores.
  target_tier: string | null
  target_resolution: string | null
  target_source: string | null
  target_codec: string | null
  minimum_tier: string | null
  minimum_resolution: string | null
  minimum_source: string | null
  minimum_codec: string | null
  available_versions: string | null
  expected_version: string | null
  upgrade_allowed: number | null
  current_tier: number | null
  current_resolution: string | null
  current_source: string | null
  current_codec: string | null
  current_release_group: string | null
  current_edition: string | null
  current_size_bytes: number | null
  current_release_title: string | null
  default_edition_id: number | null
  // Joined/computed columns vary by query (e.g. loudness_measured), so keep the
  // row open rather than forcing a cast at every call site.
  [key: string]: unknown
}

/** A single film scoped to its library. Undefined when it does not exist there. */
export function findById(libraryId: number, id: number | string): FilmRow | undefined {
  return stmt('SELECT * FROM films WHERE id = ? AND library_id = ?').get(id, libraryId) as FilmRow | undefined
}

/** Film by provider id within a library. */
export function findByTmdbId(libraryId: number, tmdbId: number): FilmRow | undefined {
  return stmt('SELECT * FROM films WHERE library_id = ? AND tmdb_id = ?').get(libraryId, tmdbId) as FilmRow | undefined
}

/** True when the library already holds this TMDB id. */
export function existsByTmdbId(libraryId: number, tmdbId: number): boolean {
  return stmt('SELECT 1 FROM films WHERE library_id = ? AND tmdb_id = ? LIMIT 1').get(libraryId, tmdbId) !== undefined
}

/**
 * The subset of `tmdbIds` already in the library, as a Set — one query instead of
 * one per candidate. Use this to filter discovery results; the previous
 * `results.filter(f => db.prepare(...).get(...))` shape ran (and re-prepared) a
 * query for every row returned by TMDB.
 */
export function ownedTmdbIds(libraryId: number, tmdbIds: number[]): Set<number> {
  const ids = [...new Set(tmdbIds.filter(id => Number.isFinite(id)))]
  const owned = new Set<number>()
  for (const batch of chunked(ids)) {
    const rows = stmt(
      `SELECT tmdb_id FROM films WHERE library_id = ? AND tmdb_id IN (${placeholders(batch.length)})`,
    ).all(libraryId, ...batch) as Array<{ tmdb_id: number }>
    for (const row of rows) owned.add(Number(row.tmdb_id))
  }
  return owned
}

/** All films in a library, newest first by sort title. */
export function listByLibrary(libraryId: number): FilmRow[] {
  return stmt('SELECT * FROM films WHERE library_id = ? ORDER BY COALESCE(sort_title, title) ASC').all(libraryId) as FilmRow[]
}

/** Id + provider id pairs, for reconciliation passes. */
export function listIdentifiers(libraryId: number): Array<{ id: number; tmdb_id: number }> {
  return stmt('SELECT id, tmdb_id FROM films WHERE library_id = ?').all(libraryId) as Array<{ id: number; tmdb_id: number }>
}

/** Deletes a film scoped to its library; returns true when a row was removed. */
export function deleteById(libraryId: number, id: number | string): boolean {
  return stmt('DELETE FROM films WHERE id = ? AND library_id = ?').run(id, libraryId).changes > 0
}
