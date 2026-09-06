import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EpisodeSummary, FilmSummary, PlayerBoxSetRows, PlayerShelfRow, PlayerShelfSettings, SeriesDetail, SeriesShelves, SeriesSummary } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { CombinedView, type CombinedNode } from '../components/CombinedView.js'
import { catalogueRating } from '@archivist/design-system'
import type { IconName } from '@archivist/design-system'

/**
 * The library, rendered as the Combined view.
 *
 * Seasons and episodes are fetched per series on demand: the list endpoint
 * returns summaries only, and pulling every episode of every series up front
 * would be a large request for a screen that shows one row at a time.
 */
/**
 * Channel layout, written the way a spec sheet does. ffprobe's names vary by
 * container ('stereo', '5.1(side)'), so the channel count is the reliable
 * source and the layout string is only used when it is already numeric.
 */
function channelLayout(track: { channels?: number | null; channelLayout?: string | null } | undefined): string | null {
  if (!track) return null
  const named = track.channelLayout?.trim()
  if (named && /^\d+\.\d+$/.test(named)) return named
  switch (track.channels) {
    case 1: return '1.0'
    case 2: return '2.0'
    case 6: return '5.1'
    case 8: return '7.1'
    default: return track.channels ? `${track.channels}.0` : null
  }
}

/**
 * Per-type accents, mirroring the Library's --archivist-film/-series tokens so
 * a media type is the same colour wherever it appears. The Combined view needs
 * the literal value to split into rgb parts, so the token is resolved here
 * rather than referenced as a var().
 */
const MEDIA_ACCENT = {
  films: '#00d4ff',
  series: '#9b59b6',
  music: '#ff2d78',
  books: '#f1c40f',
  comics: '#e67e22',
  games: '#2ecc71',
} as const

const SOURCE_ICON: Record<string, IconName> = {
  films: 'film', series: 'series', episodes: 'series', 'next-up': 'play',
}

/** The row's own description, written from the parameters actually in force. */
function rowOverview(row: PlayerShelfRow): string {
  if (row.source === 'next-up') return 'The next episode waiting in each series you have started.'
  const noun = row.source === 'films' ? 'Films' : row.source === 'series' ? 'Series' : 'Episodes'
  const parts: string[] = []
  if (row.watchState !== 'all') parts.push(row.watchState === 'in-progress' ? 'part-watched' : row.watchState)
  if (row.windowField !== 'none') {
    const days = `${row.windowDays} day${row.windowDays === 1 ? '' : 's'}`
    parts.push(`${row.windowField} in the last ${days}`)
  }
  if (row.genres.length) parts.push(row.genres.join(', '))
  if (row.minRating != null) parts.push(`rated ${row.minRating}+`)
  if (row.yearFrom != null || row.yearTo != null) parts.push(`${row.yearFrom ?? '…'}–${row.yearTo ?? '…'}`)
  return parts.length ? `${noun} ${parts.join(', ')}.` : `Every ${noun.toLowerCase().replace(/s$/, '')} in the library.`
}

const dateValue = (value: string | null | undefined): number | null => {
  if (!value) return null
  const parsed = new Date(value).valueOf()
  return Number.isNaN(parsed) ? null : parsed
}

/** The date a film row's window and date sorts read. */
function filmDate(film: FilmSummary, field: PlayerShelfRow['windowField'] | PlayerShelfRow['sort']): number | null {
  if (field === 'released' || field === 'aired' || field === 'year') {
    return dateValue(film.releaseDate) ?? dateValue(film.digitalReleaseDate) ?? dateValue(film.physicalReleaseDate)
      ?? (film.year ? new Date(`${film.year}-01-01`).valueOf() : null)
  }
  return dateValue(film.acquiredAt) ?? dateValue(film.addedAt)
}

/**
 * Rows in the order they must be resolved: a row that excludes another has to
 * run after it, whatever order they are displayed in. A cycle has no valid
 * order, so the remainder falls back to configured order rather than hanging.
 */
function resolutionOrder(rows: PlayerShelfRow[]): PlayerShelfRow[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const ordered: PlayerShelfRow[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (row: PlayerShelfRow) => {
    if (done.has(row.id) || visiting.has(row.id)) return
    visiting.add(row.id)
    for (const ref of row.dedupeAgainst) {
      const target = byId.get(ref)
      if (target) visit(target)
    }
    visiting.delete(row.id)
    done.add(row.id)
    ordered.push(row)
  }
  for (const row of rows) visit(row)
  return ordered
}

/**
 * Rows fall back to this shape until the operator's settings arrive, so the
 * page renders its usual structure rather than flashing empty.
 */
const FALLBACK_ROW: Omit<PlayerShelfRow, 'id' | 'label' | 'source'> = {
  enabled: true, windowField: 'none', windowDays: 90, watchState: 'all',
  genres: [], minRating: null, yearFrom: null, yearTo: null,
  sort: 'added', sortOrder: 'desc', limit: 18, view: 'poster', dedupeAgainst: [],
}

/**
 * Watched means finished./**
 * Watch state over a film's own progress. "Watched" means finished — a film
 * part-way through is still something you would want surfaced.
 */
function matchesWatchState(film: FilmSummary, state: PlayerShelfRow['watchState']): boolean {
  const progress = film.progress
  switch (state) {
    case 'watched': return !!progress?.completed
    case 'unwatched': return !progress?.completed
    case 'in-progress': return !!progress && !progress.completed && progress.positionSeconds > 30
    default: return true
  }
}

/** Every filter, sort and cap a films row can carry, applied in order. */
function runFilmRow(row: PlayerShelfRow, films: FilmSummary[]): FilmSummary[] {
  const now = Date.now()
  const cutoff = now - row.windowDays * 86_400_000
  const matched = films.filter(film => {
    if (!matchesWatchState(film, row.watchState)) return false
    if (row.windowField !== 'none') {
      const value = filmDate(film, row.windowField)
      if (value == null || value < cutoff || value > now) return false
    }
    if (row.genres.length && !row.genres.some(genre => (film.genres ?? []).some(entry => entry.toLowerCase() === genre.toLowerCase()))) return false
    if (row.minRating != null && (film.rating ?? 0) < row.minRating) return false
    if (row.yearFrom != null && (film.year ?? 0) < row.yearFrom) return false
    if (row.yearTo != null && (film.year ?? 9999) > row.yearTo) return false
    return true
  })
  const direction = row.sortOrder === 'asc' ? 1 : -1
  const sorted = [...matched]
  if (row.sort === 'random') {
    // Seeded by the day so a random row is stable for a session rather than
    // reshuffling on every render.
    const seed = Math.floor(now / 86_400_000)
    sorted.sort((a, b) => ((a.id * 1103515245 + seed) % 2147483647) - ((b.id * 1103515245 + seed) % 2147483647))
  } else if (row.sort === 'title') {
    sorted.sort((a, b) => direction * (a.sortTitle ?? a.title).localeCompare(b.sortTitle ?? b.title))
  } else if (row.sort === 'rating') {
    sorted.sort((a, b) => direction * ((a.rating ?? 0) - (b.rating ?? 0)))
  } else {
    sorted.sort((a, b) => direction * ((filmDate(a, row.sort) ?? 0) - (filmDate(b, row.sort) ?? 0)))
  }
  return sorted.slice(0, row.limit)
}

/**
 * Audio and subtitle tracks for one playable item: how many there are, and
 * which languages they are in. Languages are de-duplicated and upper-cased,
 * and an untagged track — usually a commentary — is counted but names nothing,
 * which is why the count can exceed the list.
 */
function trackLoader(sdk: ArchivistSdk, kind: 'films' | 'episodes', id: number) {
  return async () => {
    const tracks = await sdk.mediaTracks(kind, id)
    // Keyed by label so the same language tagged twice flies one flag, and the
    // ffprobe code is kept because that is what picks the flag.
    const languages = (list: Array<{ language: string | null; languageCode?: string | null }>) => {
      const seen = new Map<string, { code: string | null; label: string }>()
      for (const track of list) {
        const label = track.language?.trim()
        if (!label) continue
        const key = label.toLowerCase()
        if (!seen.has(key)) seen.set(key, { code: track.languageCode?.trim() ?? null, label: label.toUpperCase() })
      }
      return [...seen.values()]
    }
    // The default audio track is the one that will actually play, so it is the
    // one worth naming; falling back to the first covers files that mark none.
    const main = tracks.audio.find(track => track.default) ?? tracks.audio[0]
    return {
      videoCodec: tracks.video?.codec ?? null,
      audioCodec: main?.codec ?? null,
      audioChannels: channelLayout(main),
      audioCount: tracks.audio.length,
      audio: languages(tracks.audio),
      subtitleCount: tracks.subtitles.length,
      subtitles: languages(tracks.subtitles),
    }
  }
}

/** Sorts offered above a whole-library grid. */
const GRID_SORTS = {
  films: [
    { value: 'title', label: 'Title' }, { value: 'added', label: 'Recently added' },
    { value: 'released', label: 'Release date' }, { value: 'rating', label: 'Rating' },
  ],
  series: [
    { value: 'title', label: 'Title' }, { value: 'added', label: 'Recently added' },
    { value: 'year', label: 'Year' }, { value: 'rating', label: 'Rating' },
  ],
} as const

export function BrowseCombined({ sdk, kind }: { sdk: ArchivistSdk; kind: 'series' | 'films' | 'home' }) {
  const navigate = useNavigate()
  // Whole-library sort lives with the page, not the saved row configuration:
  // it is a way of looking at the shelf, not a change to what is on it.
  const [gridSort, setGridSort] = useState<string>('title')
  const [gridDescending, setGridDescending] = useState(false)
  // Accent follows the media type, not the viewer's preference: a film row is
  // cyan and a series row violet on every surface, the Library included.
  const filmAccent = MEDIA_ACCENT.films
  const seriesAccent = MEDIA_ACCENT.series
  const [series, setSeries] = useState<SeriesSummary[]>([])
  const [films, setFilms] = useState<FilmSummary[]>([])
  const [shelves, setShelves] = useState<SeriesShelves>({ rows: [] })
  const [settings, setSettings] = useState<PlayerShelfSettings | null>(null)
  const [boxSets, setBoxSets] = useState<PlayerBoxSetRows>({ rowLabel: 'Box Sets', themes: [] })
  const [details, setDetails] = useState<Record<number, SeriesDetail>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    // Availability is filtered here rather than per folder, so every row —
    // curated or not — shows only what is actually on disk.
    if (kind !== 'films') {
      sdk.series()
        .then(r => setSeries(r.series.filter(item => (item.availableEpisodeCount ?? 0) > 0)))
        .catch(e => setError(String(e)))
      // Curated series rows are the server's answer; an empty one just means the
      // row is empty, so a failure here must not take the whole page down.
      sdk.seriesShelves().then(setShelves).catch(() => {})
    }
    sdk.shelfSettings().then(response => setSettings(response.settings)).catch(() => {})
    // Box sets are additive: a failure here costs those rows, not the page.
    sdk.boxSets().then(setBoxSets).catch(() => {})
    if (kind !== 'series') sdk.films()
      .then(r => setFilms(r.films.filter(film => film.hasFile)))
      .catch(e => setError(String(e)))
  }, [kind])

  // Warm the first handful so descending into a series is not a blank row.
  useEffect(() => {
    if (kind === 'films') return
    for (const item of series.slice(0, 8)) {
      if (details[item.id]) continue
      sdk.seriesDetail(item.id).then(detail => setDetails(prev => ({ ...prev, [item.id]: detail }))).catch(() => {})
    }
  }, [kind, series])

  /* Node builders, shared by the curated rows and the whole-library grids. */
  const toSeriesNode = useCallback((item: SeriesSummary): CombinedNode => {
        const detail = details[item.id]
        return {
          id: `series-${item.id}`, type: 'series', label: item.title, accent: seriesAccent,
          overview: item.overview,
          imageUrl: item.posterUrl ? sdk.asset(item.posterUrl) : null,
          fanart: item.backdropUrl ? sdk.asset(item.backdropUrl) : null,
          logoUrl: item.logoUrl ? sdk.asset(item.logoUrl) : null,
          network: item.network ?? null,
          premiered: item.year ? String(item.year) : null,
          res: null, mpaa: item.certification ?? null,
          genres: item.genres ?? null,
          stars: catalogueRating(item.rating),
          status: item.seriesStatus ?? null,
          children: (detail?.seasons ?? []).map(season => ({
            id: `season-${season.id}`, type: 'season' as const,
            label: `Season ${season.seasonNumber}`,
            overview: season.overview ?? null,
            imageUrl: season.posterUrl ? sdk.asset(season.posterUrl) : null,
            children: season.episodes.filter(episode => episode.hasFile).map(episode => ({
              id: `episode-${episode.id}`, type: 'episode' as const,
              // Episode titles are nullable in the API; the tile label is not.
              label: episode.title ?? `Episode ${episode.episodeNumber}`,
              overview: episode.overview ?? null,
              // The landscape tile is the episode's own still. Falling back to
              // the series backdrop keeps the row looking like a row when an
              // episode has no still of its own, rather than dropping a single
              // flat placeholder into the middle of it.
              imageUrl: episode.stillUrl ? sdk.asset(episode.stillUrl)
                : item.backdropUrl ? sdk.asset(item.backdropUrl) : null,
              season: season.seasonNumber, episode: episode.episodeNumber,
              premiered: episode.airDate ?? null,
              runtime: episode.runtimeSeconds ? `${Math.round(episode.runtimeSeconds / 60)} min` : null,
              res: episode.quality?.resolution ?? null,
              source: episode.quality?.source ?? null, codec: episode.quality?.codec ?? null,
              watched: false,
              loadTracks: episode.hasFile ? trackLoader(sdk, 'episodes', episode.id) : undefined,
              onActivate: () => navigate(`/series/${item.id}`),
            })),
          })),
          onActivate: () => navigate(`/series/${item.id}`),
        }
      }, [sdk, details, navigate, seriesAccent])

  const toFilmNode = useCallback((film: FilmSummary): CombinedNode => ({
          id: `film-${film.id}`, type: 'film', label: film.title, accent: filmAccent,
          overview: film.overview, imageUrl: film.posterUrl ? sdk.asset(film.posterUrl) : null,
          fanart: film.backdropUrl ? sdk.asset(film.backdropUrl) : null,
          logoUrl: film.logoUrl ? sdk.asset(film.logoUrl) : null,
          premiered: film.year ? String(film.year) : null,
          res: film.quality?.resolution ?? null, mpaa: film.certification ?? null,
          source: film.quality?.source ?? null, codec: film.quality?.codec ?? null,
          studio: film.studio ?? null,
          genres: film.genres ?? null,
          stars: catalogueRating(film.rating),
          watched: false,
          loadTracks: film.hasFile ? trackLoader(sdk, 'films', film.id) : undefined,
          onActivate: () => navigate(`/film/${film.id}`),
        }), [sdk, navigate, filmAccent])

  const roots = useMemo<CombinedNode[]>(() => {
    /*
     * Until the operator's settings arrive the shipped layout stands in. It
     * matches what the server ships, so anyone on defaults sees no change when
     * the request lands, and a server too old to answer still gets a usable
     * page rather than a bare one.
     */
    const typeOf = (name: 'films' | 'series') => settings?.[name] ?? {
      enabled: true,
      label: name === 'films' ? 'Films' : 'Series',
      rows: (name === 'films'
        ? [
            ['films-recently-added', 'Recently Added', 'films', { windowField: 'added', watchState: 'unwatched', dedupeAgainst: ['films-recently-released'] }],
            ['films-recently-released', 'Recently Released', 'films', { windowField: 'released', watchState: 'unwatched', sort: 'released' }],
            ['films-all', 'All films', 'films', { sort: 'title', sortOrder: 'asc', limit: 100 }],
          ]
        : [
            ['series-next-up', 'Next Up', 'next-up', { watchState: 'unwatched', view: 'landscape' }],
            ['series-recently-added', 'Recently Added', 'episodes', { windowField: 'added', view: 'landscape', dedupeAgainst: ['series-recently-aired'] }],
            ['series-recently-aired', 'Recently Aired', 'episodes', { windowField: 'aired', sort: 'aired', view: 'landscape' }],
            ['series-all', 'All series', 'series', { sort: 'title', sortOrder: 'asc', limit: 100 }],
          ]
      ).map(([id, label, source, over]) => ({ ...FALLBACK_ROW, id, label, source, ...(over as object) }) as PlayerShelfRow),
    }
    const filmType = typeOf('films')
    const seriesType = typeOf('series')
    const filmRows = filmType.rows.filter(row => row.enabled)
    const seriesRows = seriesType.rows.filter(row => row.enabled)


    const toEpisodeNode = (episode: EpisodeSummary): CombinedNode => ({
      id: `episode-${episode.id}`, type: 'episode', accent: seriesAccent,
      /*
       * A row of episodes drawn from across the library is read by show, so the
       * hero carries the series — its logo where there is one — and the tile
       * caption carries which episode this is.
       */
      label: episode.seriesTitle ?? episode.title ?? `Episode ${episode.episodeNumber}`,
      tileLabel: [
        `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`,
        episode.title,
      ].filter(Boolean).join(' · '),
      logoUrl: episode.seriesLogoUrl ? sdk.asset(episode.seriesLogoUrl) : null,
      overview: episode.overview,
      // Landscape tiles want the still; the series poster is the only fallback
      // the summary carries.
      imageUrl: episode.stillUrl ? sdk.asset(episode.stillUrl) : episode.seriesPosterUrl ? sdk.asset(episode.seriesPosterUrl) : null,
      season: episode.seasonNumber, episode: episode.episodeNumber,
      premiered: episode.airDate ?? null,
      runtime: episode.runtimeSeconds ? `${Math.round(episode.runtimeSeconds / 60)} min` : null,
      res: episode.quality?.resolution ?? null,
      source: episode.quality?.source ?? null, codec: episode.quality?.codec ?? null,
      watched: !!episode.progress?.completed,
      progress: episode.progress?.percent,
      loadTracks: episode.hasFile ? trackLoader(sdk, 'episodes', episode.id) : undefined,
      onActivate: () => navigate(`/series/${episode.seriesId}`),
    })

    /*
     * Box sets stack after a type's configured rows. The server has already
     * applied the field filter, the sort, the cap and the season, so what
     * arrives is a finished row that only needs its nodes built.
     */
    const boxSetFolders = (mediaType: 'films' | 'series'): CombinedNode[] => {
      const themes = boxSets.themes.filter(theme => theme.mediaType === mediaType)
      if (!themes.length) return []
      const accent = mediaType === 'films' ? filmAccent : seriesAccent
      /*
       * One row of theme tiles, three levels deep: theme → set → item. Forty
       * directors cost one tile on the browsing surface rather than forty rows,
       * and the drill-down the view already does carries the rest.
       */
      return [{
        id: `boxsets-${mediaType}`, type: 'node' as const, accent,
        label: boxSets.rowLabel, icon: 'collections' as const,
        overview: null,
        children: themes.map(theme => ({
          id: theme.id, type: 'node' as const, accent,
          label: theme.label, icon: 'collections' as const,
          overview: theme.overview,
          imageUrl: theme.imageUrl ? sdk.asset(theme.imageUrl) : null,
          view: 'landscape',
          children: theme.sets.map(set => ({
            id: set.id, type: 'node' as const, accent,
            label: set.label,
            overview: set.overview,
            imageUrl: set.imageUrl ? sdk.asset(set.imageUrl) : null,
            view: 'landscape',
            children: set.items.map(item =>
              item.type === 'series' ? toSeriesNode(item as SeriesSummary) : toFilmNode(item as FilmSummary)),
          })),
        })),
      }]
    }

    /*
     * The server has already applied every filter, sort, cap and dedupe when it
     * resolved these rows, so all that is left here is turning them into nodes
     * under the labels the operator set.
     */
    const resolved = new Map(shelves.rows.map(entry => [entry.id, entry.items]))
    const seriesFolders: CombinedNode[] = seriesRows.map(row => ({
      id: row.id, type: 'node' as const, accent: seriesAccent, label: row.label,
      icon: SOURCE_ICON[row.source] ?? 'series',
      overview: rowOverview(row),
      children: (resolved.get(row.id) ?? []).map(item =>
        item.type === 'series' ? toSeriesNode(item as SeriesSummary) : toEpisodeNode(item as EpisodeSummary)),
    }))
    seriesFolders.push(...boxSetFolders('series'))


    const filmsOnly = kind === 'films'
    if (filmsOnly || kind === 'home') {
      /*
       * The film rows are computed here rather than server-side: the film list
       * already carries every date and progress flag they need, so a row is a
       * filter over data the page has, and re-asking the server would buy
       * nothing. The series rows have no such luxury — see `seriesShelves`.
       *
       * "Released" counts theatrical, digital or physical: for most modern
       * titles the home release is the date that matters, and going on
       * theatrical alone would leave the row nearly empty.
       */
      /*
       * A row that excludes another resolves after it, so the exclusion sees a
       * finished list. Excluded films are removed before the row runs, so its
       * cap counts what it actually shows.
       */
      const produced = new Map<string, FilmSummary[]>()
      for (const row of resolutionOrder(filmRows)) {
        const excluded = new Set(row.dedupeAgainst.flatMap(ref => (produced.get(ref) ?? []).map(film => film.id)))
        produced.set(row.id, runFilmRow(row, excluded.size ? films.filter(film => !excluded.has(film.id)) : films))
      }
      // Displayed in configured order, whatever order they had to resolve in.
      const filmFolders: CombinedNode[] = filmRows.map(row => ({
        id: row.id, type: 'node' as const, accent: filmAccent, label: row.label,
        icon: SOURCE_ICON[row.source] ?? 'film',
        overview: rowOverview(row),
        children: (produced.get(row.id) ?? []).map(toFilmNode),
      }))
      filmFolders.push(...boxSetFolders('films'))
      /*
       * Home is organised by type first: the strip at the top picks Films or
       * Series, and that type's own rows stack underneath it. Every row below
       * therefore belongs to one type, rather than film rows and a lone series
       * folder sharing a level.
       *
       * A type header opens that type's whole library, so the strip is both the
       * switcher and the way in.
       */
      return [
        ...(filmType.enabled ? [{ id: 'type-films', type: 'node' as const, accent: filmAccent, label: filmType.label, icon: 'film' as const, children: filmFolders, onActivate: () => navigate('/films') }] : []),
        ...(seriesType.enabled ? [{ id: 'type-series', type: 'node' as const, accent: seriesAccent, label: seriesType.label, icon: 'series' as const, children: seriesFolders, onActivate: () => navigate('/series') }] : []),
      ]
    }

    return [{ id: 'type-series', type: 'node', accent: seriesAccent, label: seriesType.label, icon: 'series', children: seriesFolders }]
  }, [kind, films, series, shelves, settings, boxSets, sdk, toFilmNode, toSeriesNode, navigate, filmAccent, seriesAccent])

  /*
   * Whole-library pages use the same shelves as Home. Box-set types occupy one
   * landscape row and the complete library occupies a separate poster row.
   */
  const libraryRoots = useMemo<CombinedNode[]>(() => {
    const sorted = <T,>(list: T[], title: (item: T) => string, added: (item: T) => string | null | undefined,
      released: (item: T) => number | null, rating: (item: T) => number | null): T[] => {
      const direction = gridDescending ? -1 : 1
      const value = (item: T) => gridSort === 'rating' ? rating(item) ?? 0
        : gridSort === 'added' ? new Date(added(item) ?? 0).valueOf() || 0
          : gridSort === 'released' || gridSort === 'year' ? released(item) ?? 0
            : 0
      return [...list].sort((a, b) => gridSort === 'title'
        ? direction * title(a).localeCompare(title(b))
        : direction * (value(a) - value(b)))
    }
    const filmNodes = sorted(films, film => film.sortTitle ?? film.title, film => film.acquiredAt ?? film.addedAt,
      film => filmDate(film, 'released'), film => film.rating ?? null)
    const seriesNodes = sorted(series, item => item.sortTitle ?? item.title, item => item.addedAt,
      item => item.year ?? null, item => item.rating ?? null)
    const boxSetFolder = (mediaType: 'films' | 'series') =>
      roots.find(root => root.id === `type-${mediaType}`)?.children?.find(child => child.id === `boxsets-${mediaType}`)
    const filmBoxSets = boxSetFolder('films')
    const seriesBoxSets = boxSetFolder('series')
    return [
      { id: 'type-films', type: 'node', accent: filmAccent, label: 'Films', icon: 'film',
        overview: `${films.length} film${films.length === 1 ? '' : 's'} in the library.`,
        children: [
          ...(filmBoxSets ? [filmBoxSets] : []),
          { id: 'all-films', type: 'node', accent: filmAccent, label: 'All Films', icon: 'film',
            overview: `${films.length} film${films.length === 1 ? '' : 's'} in the library.`, children: filmNodes.map(toFilmNode) },
        ], onActivate: () => navigate('/films') },
      { id: 'type-series', type: 'node', accent: seriesAccent, label: 'Series', icon: 'series',
        overview: `${series.length} series in the library.`,
        children: [
          ...(seriesBoxSets ? [seriesBoxSets] : []),
          { id: 'all-series', type: 'node', accent: seriesAccent, label: 'All Series', icon: 'series',
            overview: `${series.length} series in the library.`, children: seriesNodes.map(toSeriesNode) },
        ], onActivate: () => navigate('/series') },
    ]
  }, [films, series, roots, toFilmNode, toSeriesNode, gridSort, gridDescending, navigate, filmAccent, seriesAccent])

  if (error) return <div className="cv"><div className="cv-stage"><div className="cv-info"><p className="cv-plot">{error}</p></div></div></div>

  // Home carries the curated rows; a type's own page carries its whole library.
  if (kind === 'home') return <CombinedView roots={roots} />

  const sorts = GRID_SORTS[kind]
  const controls = <>
    <span>Sort</span>
    {sorts.map(option => (
      <button key={option.value} type="button" aria-pressed={gridSort === option.value}
        onClick={() => setGridSort(option.value)}>{option.label}</button>
    ))}
    <button type="button" aria-pressed={gridDescending}
      aria-label={gridDescending ? 'Descending' : 'Ascending'}
      onClick={() => setGridDescending(value => !value)}>{gridDescending ? '↓ Desc' : '↑ Asc'}</button>
  </>
  return <CombinedView
    roots={libraryRoots}
    mode="shelves"
    initialIndex={kind === 'series' ? 1 : 0}
    controls={controls}
    // Back from a library page returns to Home rather than dead-ending.
    onExit={() => navigate('/')}
  />
}
