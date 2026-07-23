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
