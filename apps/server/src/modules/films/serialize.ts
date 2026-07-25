export type FilmReleaseStatus = 'upcoming' | 'in_cinemas' | 'at_home'

/**
 * Where a film sits in its release lifecycle, from the (metadata-refreshed)
 * release dates. "At home" means a digital/physical release exists — so a real
 * copy can; "in cinemas" means theatrical-only; "upcoming" means unreleased.
 * When no digital/physical date is known we fall back to a ~90-day theatrical
 * window (the typical cinema→home gap) so older films aren't stuck "in cinemas".
 */
export function filmReleaseStatus(row: {
  release_date?: unknown; digital_release_date?: unknown; physical_release_date?: unknown
}): FilmReleaseStatus {
  const parse = (value: unknown): number | null => {
    const text = typeof value === 'string' ? value.slice(0, 10) : ''
    const time = text ? Date.parse(text) : Number.NaN
    return Number.isNaN(time) ? null : time
  }
  const now = Date.now()
  const HOME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
  const theatrical = parse(row.release_date)
  const homeDates = [parse(row.digital_release_date), parse(row.physical_release_date)].filter((t): t is number => t != null)
  const home = homeDates.length ? Math.min(...homeDates) : null

  if (home != null) return home <= now ? 'at_home' : (theatrical != null && theatrical <= now ? 'in_cinemas' : 'upcoming')
  if (theatrical == null) return 'at_home' // no dates at all — assume an older, available title
  if (theatrical > now) return 'upcoming'
  if (now - theatrical >= HOME_WINDOW_MS) return 'at_home' // window fallback when the digital date is missing
  return 'in_cinemas'
}

/** Legacy film row deserialisation — response field names are the UI contract. */
export function deserialiseFilm(row: Record<string, unknown>) {
  let genres = []
  let cast = []
  let crew = []
  let versions = []
  try { genres = JSON.parse((row.genres as string) ?? '[]') } catch {}
  try { cast = JSON.parse((row.cast as string) ?? '[]') } catch {}
  try { crew = JSON.parse((row.crew as string) ?? '[]') } catch {}
  try { versions = JSON.parse((row.available_versions as string) ?? '[]') } catch {}

  return {
    ...row,
    id: row.id as number,
    status: row.status as string,
    file_path: row.file_path as string | null,
    genres: Array.isArray(genres) ? genres : [],
    cast: Array.isArray(cast) ? cast : [],
    crew: Array.isArray(crew) ? crew : [],
    availableVersions: Array.isArray(versions) ? versions : [],
    download_tier: row.download_tier as number | null,
    target_tier: row.target_tier as string | null,
    target_resolution: row.target_resolution as string | null,
    target_source: row.target_source as string | null,
    target_codec: row.target_codec as string | null,
    minimum_tier: row.minimum_tier as string | null,
    minimum_resolution: row.minimum_resolution as string | null,
    minimum_source: row.minimum_source as string | null,
    minimum_codec: row.minimum_codec as string | null,
    upgrade_allowed: row.upgrade_allowed !== undefined ? Boolean(row.upgrade_allowed) : true,
    current_tier: row.current_tier as number || 0,
    current_resolution: row.current_resolution as string | null,
    current_source: row.current_source as string | null,
    current_codec: row.current_codec as string | null,
    current_release_group: row.current_release_group as string | null,
    current_edition: row.current_edition as string | null,
    current_size_bytes: row.current_size_bytes as number | null,
    current_release_title: row.current_release_title as string | null,
    monitored: Boolean(row.monitored),
    // Release lifecycle: 'upcoming' | 'in_cinemas' | 'at_home'. Drives the film
    // release-status filter and the availability-aware collection tag.
    releaseStatus: filmReleaseStatus(row),
    // Loudness normalization measured (EBU R128). Present only in list queries.
    loudnessMeasured: row.loudness_measured !== undefined ? Boolean(row.loudness_measured) : undefined,
    // Track cleaning completed for the current file. Present only in list queries.
    tracksCleaned: row.tracks_cleaned !== undefined ? Boolean(row.tracks_cleaned) : undefined,
    posterPath: row.poster_path as string | null,
    backdropPath: row.backdrop_path as string | null,
    logoPath: row.logo_path as string | null,
    bannerPath: row.banner_path as string | null,
    downloadProgress: row.download_progress as number || 0,
  }
}
