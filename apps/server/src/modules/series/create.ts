import type { Database } from 'better-sqlite3'
import { getSeries, getSeriesTmdb, getSeriesSeasons, getSeriesSeasonsTmdb, getSeriesEpisodes, getSeriesEpisodesTmdb } from './tvdb.js'
import { ensureSeriesFolder, ensureSeasonFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot } from '../../shared/library-paths.js'
import { indexMediaCreditsFromJson } from '../../services/credit-index.js'

export interface CreateSeriesOptions {
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
 * Creates a series from its TVDB/TMDB id and **synchronously populates** its
 * seasons and episodes (unlike `POST /series`, which populates in the
 * background). The library-scan importer needs the episode rows to exist so it
 * can resolve and adopt a specific episode file immediately after creation.
 *
 * This is intentionally lean — it skips NFO/thumbnail/airtime-normalisation
 * enrichments; the metadata-refresh scheduler backfills those over time.
 */
export async function createSeriesFromMetadata(db: Database, libraryId: number, ids: { tvdbId?: number; tmdbId?: number }, opts: CreateSeriesOptions = {}): Promise<number> {
  const existing = db.prepare('SELECT id FROM series WHERE library_id = ? AND (tmdb_id = ? OR tvdb_id = ?)').get(libraryId, ids.tmdbId ?? 0, ids.tvdbId ?? 0) as { id: number } | undefined
  if (existing) return existing.id

  const useTvdb = Boolean(ids.tvdbId && !ids.tmdbId)
  const seriesData = useTvdb ? await getSeries(ids.tvdbId as number) : await getSeriesTmdb(ids.tmdbId as number)
  const seasons = useTvdb ? await getSeriesSeasons(ids.tvdbId as number) : await getSeriesSeasonsTmdb(ids.tmdbId as number)
  const root = resolveLibraryRoot(db, libraryId)
  const { targetDir: seriesDir, posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo } = await ensureSeriesFolder(seriesData, root)
  const sortTitle = seriesData.title.replace(/^(The|A|An)\s+/i, '').toLowerCase()

  const result = db.prepare(`
    INSERT INTO series (library_id, tvdb_id, tmdb_id, imdb_id, title, sort_title, year, overview,
      network, status, series_type, runtime, genres, cast, crew, country, certification, poster_path, backdrop_path, logo_path,
      rating, language, monitored, quality_profile_id, root_folder_path, air_time, air_day, upgrade_allowed,
      target_tier, target_resolution, target_source, target_codec,
      minimum_tier, minimum_resolution, minimum_source, minimum_codec)
    VALUES (@libraryId, @tvdbId, @tmdbId, @imdbId, @title, @sortTitle, @year, @overview,
      @network, @status, @seriesType, @runtime, @genres, @cast, @crew, @country, @certification, @posterPath, @backdropPath, @logoPath,
      @rating, @language, @monitored, @qualityProfileId, @rootFolderPath, @airTime, @airDay, 1,
      @targetTier, @targetResolution, @targetSource, @targetCodec,
      @minimumTier, @minimumResolution, @minimumSource, @minimumCodec)
  `).run({
    libraryId,
    tvdbId: seriesData.tvdbId ?? ids.tvdbId ?? null, tmdbId: seriesData.tmdbId ?? ids.tmdbId ?? null,
    imdbId: seriesData.imdbId ?? null, title: seriesData.title, sortTitle,
    year: seriesData.year ?? null, overview: seriesData.overview ?? null,
    network: seriesData.network ?? null, status: seriesData.status,
    seriesType: seriesData.seriesType, runtime: seriesData.runtime ?? null,
    genres: JSON.stringify(seriesData.genres),
    cast: JSON.stringify(seriesData.cast ?? []),
    crew: JSON.stringify(seriesData.crew ?? []),
    country: seriesData.country ?? null, certification: seriesData.certification ?? null,
    posterPath: localPoster ?? seriesData.posterPath ?? null,
    backdropPath: localBackdrop ?? seriesData.backdropPath ?? null,
    logoPath: localLogo ?? seriesData.logoPath ?? null,
    rating: seriesData.rating ?? null, language: seriesData.language,
    monitored: (opts.monitored ?? true) ? 1 : 0, qualityProfileId: opts.qualityProfileId ?? null,
    rootFolderPath: seriesDir, airTime: seriesData.airTime ?? null, airDay: seriesData.airDay ?? null,
    targetTier: opts.target_tier ?? null,
    targetResolution: opts.target_resolution ?? null,
    targetSource: opts.target_source ?? null,
    targetCodec: opts.target_codec ?? null,
    minimumTier: opts.minimum_tier ?? opts.target_tier ?? null,
    minimumResolution: opts.minimum_resolution ?? opts.target_resolution ?? null,
    minimumSource: opts.minimum_source ?? opts.target_source ?? null,
    minimumCodec: opts.minimum_codec ?? opts.target_codec ?? null,
  })
  const seriesId = Number(result.lastInsertRowid)
  indexMediaCreditsFromJson(db, 'series', seriesId, JSON.stringify(seriesData.cast ?? []), JSON.stringify(seriesData.crew ?? []))

  const insertEpisode = db.prepare(`
    INSERT OR IGNORE INTO episodes (series_id, season_id, season_number, episode_number, tvdb_episode_id, title, overview, air_date, runtime, still_path, monitored, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')
  `)
  for (const season of seasons) {
    try {
      const { posterPath: localSeasonPoster } = await ensureSeasonFolder(seriesData, season, root)
      db.prepare('INSERT OR IGNORE INTO seasons (series_id, season_number, title, overview, poster_path, episode_count, monitored) VALUES (?, ?, ?, ?, ?, ?, 1)')
        .run(seriesId, season.seasonNumber, season.title ?? null, season.overview ?? null, localSeasonPoster ?? season.posterPath ?? null, season.episodeCount)
      const seasonRow = db.prepare('SELECT id FROM seasons WHERE series_id = ? AND season_number = ?').get(seriesId, season.seasonNumber) as { id: number }
      const episodes = useTvdb ? await getSeriesEpisodes(ids.tvdbId as number, season.seasonNumber) : await getSeriesEpisodesTmdb(ids.tmdbId as number, season.seasonNumber)
      for (const ep of episodes) {
        try {
          insertEpisode.run(seriesId, seasonRow.id, season.seasonNumber, ep.episodeNumber, ep.tvdbEpisodeId ?? null, ep.title ?? null, ep.overview ?? null, ep.airDate ?? null, ep.runtime ?? null, ep.stillPath ?? null)
        } catch { /* one bad episode must not abort the season */ }
      }
    } catch { /* one bad season must not abort the series */ }
  }
  return seriesId
}
