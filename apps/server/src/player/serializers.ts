import type {
  EpisodeSummary,
  FilmDetail,
  FilmSummary,
  PersonCredit,
  PlaybackProgress,
  PlayerMediaCard,
  PlayerPrimaryAction,
  PlayerProgressSummary,
  SeriesSummary,
} from '@archivist/contracts'

export class PlayerSerializationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlayerSerializationError'
  }
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function progress(row: any): PlayerProgressSummary | null {
  if (row?.progress_position == null) return null
  const positionSeconds = Math.max(0, Number(row.progress_position) || 0)
  const durationSeconds = Math.max(0, Number(row.progress_duration) || 0)
  return {
    positionSeconds,
    durationSeconds,
    completed: !!row.progress_completed,
    percent: durationSeconds > 0 ? Math.min(100, Math.max(0, positionSeconds / durationSeconds * 100)) : 0,
  }
}

function action(hasFile: boolean, p: PlayerProgressSummary | null): PlayerPrimaryAction {
  if (!hasFile) return 'unavailable'
  return p && !p.completed && p.positionSeconds > 30 && p.percent < 95 ? 'resume' : 'play'
}

export function serializeFilmSummary(row: any): FilmSummary {
  const id = Number(row.id)
  if (!Number.isSafeInteger(id) || id < 1) throw new PlayerSerializationError('Film row has invalid id')
  const hasFile = !!row.file_path
  const p = progress(row)
  return {
    id,
    type: 'film',
    libraryId: Number(row.library_id),
    title: String(row.title ?? 'Untitled'),
    sortTitle: String(row.sort_title ?? row.title ?? 'Untitled'),
    year: row.year ?? null,
    overview: row.overview ? [...String(row.overview)].slice(0, 280).join('') : null,
    posterUrl: row.poster_path ?? null,
    backdropUrl: row.backdrop_path ?? null,
    logoUrl: row.logo_path ?? null,
    runtimeSeconds: row.runtime ? row.runtime * 60 : null,
    rating: row.rating ?? null,
    certification: row.certification ?? null,
    genres: parseJson<string[]>(row.genres, []),
    status: hasFile ? 'available' : 'unavailable',
    hasFile,
    quality: hasFile ? {
      resolution: row.current_resolution ?? null,
      source: row.current_source ?? null,
      codec: row.current_codec ?? null,
      tier: row.current_tier ?? null,
    } : null,
    addedAt: row.added_at ?? null,
    acquiredAt: row.acquired_at ?? null,
    playback: hasFile ? { directPlay: true, streamUrl: `/api/v1/player/stream/films/${id}` } : null,
    progress: p,
    primaryAction: action(hasFile, p),
    displayMetadata: {
      primary: [row.year, row.certification, row.runtime ? `${row.runtime} min` : null].filter(Boolean).map(String),
      technical: hasFile ? [row.current_resolution, row.current_source, row.current_codec].filter(Boolean).map(String) : [],
    },
  }
}

export function serializeFilmDetail(row: any): FilmDetail {
  return {
    ...serializeFilmSummary(row),
    overview: row.overview ?? null,
    originalTitle: row.original_title ?? null,
    studio: row.studio ?? null,
    country: row.country ?? null,
    releaseDate: row.release_date ?? null,
    cast: parseJson<PersonCredit[]>(row.cast, []),
    crew: parseJson<PersonCredit[]>(row.crew, []),
  }
}

export function serializeSeriesSummary(row: any): SeriesSummary {
  const id = Number(row.id)
  if (!Number.isSafeInteger(id) || id < 1) throw new PlayerSerializationError('Series row has invalid id')
  const available = Number(row.available_count ?? 0)
  const p = progress(row)
  return {
    id,
    type: 'series',
    libraryId: Number(row.library_id),
    title: String(row.title ?? 'Untitled'),
    sortTitle: String(row.sort_title ?? row.title ?? 'Untitled'),
    year: row.year ?? null,
    overview: row.overview ? [...String(row.overview)].slice(0, 280).join('') : null,
    posterUrl: row.poster_path ?? null,
    backdropUrl: row.backdrop_path ?? null,
    logoUrl: row.logo_path ?? null,
    network: row.network ?? null,
    seriesStatus: row.status ?? null,
    rating: row.rating ?? null,
    certification: row.certification ?? null,
    genres: parseJson<string[]>(row.genres, []),
    episodeCount: Number(row.episode_count ?? 0),
    availableEpisodeCount: available,
    status: available > 0 ? 'available' : 'unavailable',
    addedAt: row.added_at ?? null,
    progress: p,
    primaryAction: available > 0 ? (p && !p.completed ? 'resume-next' : 'play') : 'unavailable',
    displayMetadata: {
      primary: [row.year, row.certification, row.network, row.episode_count != null ? `${row.episode_count} episodes` : null].filter(Boolean).map(String),
      technical: [],
    },
  }
}

export function serializeEpisodeSummary(row: any): EpisodeSummary {
  const id = Number(row.id)
  if (!Number.isSafeInteger(id) || id < 1) throw new PlayerSerializationError('Episode row has invalid id')
  const hasFile = !!row.file_path
  const p = progress(row)
  return {
    id,
    type: 'episode',
    seriesId: Number(row.series_id),
    seasonNumber: Number(row.season_number),
    episodeNumber: Number(row.episode_number),
    title: row.title ?? null,
    overview: row.overview ?? null,
    airDate: row.air_date ?? null,
    runtimeSeconds: row.runtime ? row.runtime * 60 : null,
    stillUrl: row.still_path ?? null,
    hasFile,
    status: hasFile ? 'available' : 'unavailable',
    quality: hasFile ? {
      resolution: row.current_resolution ?? null,
      source: row.current_source ?? null,
      codec: row.current_codec ?? null,
      tier: row.current_tier ?? null,
    } : null,
    playback: hasFile ? { directPlay: true, streamUrl: `/api/v1/player/stream/episodes/${id}` } : null,
    seriesTitle: row.series_title ?? undefined,
    seriesPosterUrl: row.series_poster ?? undefined,
    progress: p,
    primaryAction: action(hasFile, p),
    displayMetadata: {
      primary: [`S${String(row.season_number).padStart(2, '0')}E${String(row.episode_number).padStart(2, '0')}`, row.air_date, row.runtime ? `${row.runtime} min` : null].filter(Boolean).map(String),
      technical: hasFile ? [row.current_resolution, row.current_source, row.current_codec].filter(Boolean).map(String) : [],
    },
  }
}

export function serializeProgress(row: any): PlaybackProgress {
  const type = row.media_type === 'film' ? 'film' : 'episode'
  return {
    key: `${type}:${row.media_id}`,
    type,
    id: row.media_id,
    title: row.title ?? (type === 'film' ? 'Film' : 'Episode'),
    posterUrl: row.poster_url ?? null,
    backdropUrl: row.backdrop_url ?? null,
    streamUrl: `/api/v1/player/stream/${type === 'film' ? 'films' : 'episodes'}/${row.media_id}`,
    seriesId: row.series_id ?? undefined,
    seriesTitle: row.series_title ?? undefined,
    positionSeconds: Number(row.position_seconds) || 0,
    durationSeconds: Number(row.duration_seconds) || 0,
    completed: !!row.completed,
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

export function toMediaCard(item: FilmSummary | SeriesSummary | EpisodeSummary): PlayerMediaCard {
  const episode = item.type === 'episode' ? item : null
  const landscape = item.type === 'episode' ? item.stillUrl : item.backdropUrl
  const route = item.type === 'film' ? `/film/${item.id}` : item.type === 'series' ? `/series/${item.id}` : `/series/${item.seriesId}`
  const subtitle = item.type === 'episode'
    ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}${item.title ? ` · ${item.title}` : ''}`
    : item.year ? String(item.year) : null
  const quality = item.type === 'series' ? null : item.quality
  return {
    key: `${item.type}:${item.id}`,
    mediaType: item.type,
    id: item.id,
    route,
    title: episode?.seriesTitle ?? item.title ?? 'Episode',
    subtitle,
    plot: item.overview ?? null,
    year: item.type === 'episode' ? null : item.year,
    posterUrl: item.type === 'episode' ? item.seriesPosterUrl ?? null : item.posterUrl,
    landscapeUrl: landscape,
    backdropUrl: landscape,
    logoUrl: item.type === 'episode' ? null : item.logoUrl,
    progress: item.progress ?? null,
    badges: [quality?.resolution ? { label: quality.resolution, tone: 'neutral' as const } : null].filter((v): v is NonNullable<typeof v> => !!v),
    available: item.status === 'available',
    primaryAction: item.primaryAction ?? (item.status === 'available' ? 'play' : 'unavailable'),
  }
}
