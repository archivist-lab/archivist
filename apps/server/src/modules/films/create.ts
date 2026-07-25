import type { Database } from 'better-sqlite3'
import { getMovie } from './tmdb.js'
import { ensureFilmFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot } from '../../shared/library-paths.js'
import { indexMediaCreditsFromJson } from '../../services/credit-index.js'

export interface CreateFilmOptions {
  monitored?: boolean
  qualityProfileId?: number | null
  target_tier?: string | null
  target_resolution?: string | null
  target_source?: string | null
  target_codec?: string | null
  minimum_tier?: string | null
  minimum_resolution?: string | null
  minimum_source?: string | null
  minimum_codec?: string | null
}

/**
 * Adds a film to a library from its TMDB id and returns the new (or existing)
 * film id. Shared by `POST /films` and the library-scan importer so the two
 * paths can't drift. The film starts as 'missing'; import/adoption flips it to
 * 'collected' afterwards.
 */
export async function createFilmFromTmdb(db: Database, libraryId: number, tmdbId: number, opts: CreateFilmOptions = {}): Promise<number> {
  const existing = db.prepare('SELECT id FROM films WHERE library_id = ? AND tmdb_id = ?').get(libraryId, tmdbId) as { id: number } | undefined
  if (existing) return existing.id

  const film = await getMovie(tmdbId)
  const { targetDir, posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo } = await ensureFilmFolder(film, resolveLibraryRoot(db, libraryId))

  const sortTitle = film.title.replace(/^(The|A|An)\s+/i, '').toLowerCase()
  const primaryReleaseDate = film.releaseDate ?? film.digitalReleaseDate ?? film.physicalReleaseDate
  const postReleaseMetadataRefreshedAt = primaryReleaseDate
    && primaryReleaseDate.slice(0, 10) < new Date().toISOString().slice(0, 10)
    ? new Date().toISOString()
    : null

  const result = db.prepare(`
    INSERT INTO films (library_id, tmdb_id, imdb_id, title, original_title, sort_title, year, overview,
      runtime, genres, poster_path, backdrop_path, logo_path, banner_path, trailer_url, cast, crew, country, rating, certification, studio,
      collection_tmdb_id, collection_name, collection_poster_path, collection_backdrop_path, collection_metadata_checked_at,
      monitored, quality_profile_id, root_folder_path, release_date, digital_release_date, physical_release_date,
      post_release_metadata_refreshed_at, status,
      target_tier, target_resolution, target_source, target_codec,
      minimum_tier, minimum_resolution, minimum_source, minimum_codec, available_versions)
    VALUES (@libraryId, @tmdbId, @imdbId, @title, @originalTitle, @sortTitle, @year, @overview,
      @runtime, @genres, @posterPath, @backdropPath, @logoPath, @bannerPath, @trailerUrl, @cast, @crew, @country, @rating, @certification, @studio,
      @collectionTmdbId, @collectionName, @collectionPosterPath, @collectionBackdropPath, datetime('now'),
      @monitored, @qualityProfileId, @rootFolderPath, @releaseDate, @digitalReleaseDate, @physicalReleaseDate,
      @postReleaseMetadataRefreshedAt, 'missing',
      @target_tier, @target_resolution, @target_source, @target_codec,
      @minimum_tier, @minimum_resolution, @minimum_source, @minimum_codec, @availableVersions)
  `).run({
    libraryId,
    tmdbId: film.tmdbId, imdbId: film.imdbId ?? null, title: film.title,
    originalTitle: film.originalTitle, sortTitle, year: film.year ?? null,
    overview: film.overview ?? null, runtime: film.runtime ?? null,
    genres: JSON.stringify(film.genres),
    posterPath: localPoster ?? film.posterPath ?? null,
    backdropPath: localBackdrop ?? film.backdropPath ?? null,
    logoPath: localLogo ?? film.logoPath ?? null,
    bannerPath: film.bannerPath ?? null,
    trailerUrl: film.videos?.find(video => video.site === 'YouTube' && video.type === 'Trailer')?.key
      ? `https://www.youtube.com/watch?v=${film.videos.find(video => video.site === 'YouTube' && video.type === 'Trailer')!.key}` : null,
    cast: JSON.stringify(film.cast ?? []),
    crew: JSON.stringify(film.crew ?? []),
    country: film.country ?? null,
    rating: film.rating ?? null,
    certification: film.certification ?? null, studio: film.studio ?? null,
    collectionTmdbId: film.collection?.tmdbId ?? null,
    collectionName: film.collection?.name ?? null,
    collectionPosterPath: film.collection?.posterPath ?? null,
    collectionBackdropPath: film.collection?.backdropPath ?? null,
    monitored: (opts.monitored ?? true) ? 1 : 0, qualityProfileId: opts.qualityProfileId ?? null,
    rootFolderPath: targetDir, releaseDate: film.releaseDate ?? null,
    digitalReleaseDate: film.digitalReleaseDate ?? null,
    physicalReleaseDate: film.physicalReleaseDate ?? null,
    postReleaseMetadataRefreshedAt,
    target_tier: opts.target_tier ?? null,
    target_resolution: opts.target_resolution ?? null,
    target_source: opts.target_source ?? null,
    target_codec: opts.target_codec ?? null,
    minimum_tier: opts.minimum_tier ?? opts.target_tier ?? null,
    minimum_resolution: opts.minimum_resolution ?? opts.target_resolution ?? null,
    minimum_source: opts.minimum_source ?? opts.target_source ?? null,
    minimum_codec: opts.minimum_codec ?? opts.target_codec ?? null,
    availableVersions: JSON.stringify(film.availableVersions ?? []),
  })

  const filmId = Number(result.lastInsertRowid)
  indexMediaCreditsFromJson(db, 'film', filmId, JSON.stringify(film.cast ?? []), JSON.stringify(film.crew ?? []))
  return filmId
}
