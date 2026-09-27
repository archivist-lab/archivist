import type { EpisodeSummary, FilmSummary, PlayerMediaCard, PlayerShelfRow, SeriesSummary } from '@archivist/contracts'
import { getDb } from '../db.js'
import { resolveBoxSetRows } from './box-set-rows.js'
import { getPlayerShelfSettings } from './shelf-settings.js'
import { resolutionOrder, resolveSeriesShelves, runEpisodeRow } from './shelf-rows.js'
import { serializeEpisodeSummary, serializeFilmSummary, toMediaCard } from './serializers.js'

/**
 * A type's browsing rows — Films or Series — resolved for a client that draws
 * them rather than computes them, such as the native television app.
 *
 * The web Player builds the same rows itself: the series rows from
 * `/series-shelves`, the box sets from `/box-sets`, and the film rows as a
 * filter over the film list it already holds. The film half is ported here
 * from that code (`runFilmRow` in BrowseCombined), so both clients show one
 * set of rows from the same settings.
 */

export interface TypeRow {
  id: string
  label: string
  view: 'poster' | 'landscape'
  items: PlayerMediaCard[]
}

export interface TypeBoxSet { id: string; label: string; overview: string | null; imageUrl: string | null; items: PlayerMediaCard[] }
export interface TypeBoxSetTheme { id: string; label: string; overview: string | null; imageUrl: string | null; sets: TypeBoxSet[] }

export interface TypeRows {
  type: 'films' | 'series'
  label: string
  rows: TypeRow[]
  boxSets: { rowLabel: string; themes: TypeBoxSetTheme[] }
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

/** Watch state over a film's own progress. "Watched" means finished. */
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
export function runFilmRow(row: PlayerShelfRow, films: FilmSummary[], now = Date.now()): FilmSummary[] {
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
    // Seeded by the day, so a random row holds still for a session.
    const seed = Math.floor(now / 86_400_000)
    sorted.sort((a, b) => ((a.id * 1103515245 + seed) % 2147483647) - ((b.id * 1103515245 + seed) % 2147483647))
  } else if (row.sort === 'title') {
    sorted.sort((a, b) => direction * (a.sortTitle ?? a.title).localeCompare(b.sortTitle ?? b.title))
  } else if (row.sort === 'rating') {
    sorted.sort((a, b) => direction * ((a.rating ?? 0) - (b.rating ?? 0)))
  } else if (row.sort === 'last-played') {
    sorted.sort((a, b) => direction * ((dateValue(a.progress?.updatedAt) ?? 0) - (dateValue(b.progress?.updatedAt) ?? 0)))
  } else {
    sorted.sort((a, b) => direction * ((filmDate(a, row.sort) ?? 0) - (filmDate(b, row.sort) ?? 0)))
  }
  return sorted.slice(0, row.limit)
}

/** The films a row is drawn from: those on disk, in one library or all of them. */
function filmsOnDisk(profileId: string, libraryId: number | null): FilmSummary[] {
  const select = `SELECT f.*, pp.position_seconds AS progress_position,
      pp.duration_seconds AS progress_duration, pp.completed AS progress_completed,
      pp.updated_at AS progress_updated_at
    FROM films f
    LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id
    WHERE f.file_path IS NOT NULL`
  const rows = libraryId
    ? getDb().prepare(`${select} AND f.library_id = ? ORDER BY f.sort_title, f.title`).all(profileId, libraryId)
    : getDb().prepare(`${select} ORDER BY f.sort_title, f.title`).all(profileId)
  return (rows as any[]).map(serializeFilmSummary)
}

function seriesIdsOf(libraryId: number): Set<number> {
  const rows = getDb().prepare('SELECT id FROM series WHERE library_id = ?').all(libraryId) as Array<{ id: number }>
  return new Set(rows.map(row => row.id))
}

const viewOf = (row: PlayerShelfRow): 'poster' | 'landscape' => (row.view === 'landscape' ? 'landscape' : 'poster')

/**
 * What a viewer left part-way, most recently played first. Leads a type's
 * rows unless the operator has already configured an in-progress row of their
 * own — a television opens on "carry on" before it opens on "what is new".
 */
function continueRow(type: 'films' | 'series'): PlayerShelfRow {
  return {
    id: `${type}-continue`, source: type === 'films' ? 'films' : 'episodes', label: 'Continue Watching', enabled: true,
    windowField: 'none', windowDays: 90, watchState: 'in-progress', genres: [], minRating: null, yearFrom: null, yearTo: null,
    sort: 'last-played', sortOrder: 'desc', limit: 18, view: 'landscape', dedupeAgainst: [],
  }
}

export function resolveTypeRows(type: 'films' | 'series', profileId: string, libraryId: number | null, now = Date.now()): TypeRows {
  const settings = getPlayerShelfSettings()[type]
  const configured = settings.rows.filter(row => row.enabled)
  const continuing = configured.some(row => row.watchState === 'in-progress') ? null : continueRow(type)
  const inLibrary = (() => {
    if (libraryId == null) return (_item: FilmSummary | SeriesSummary | EpisodeSummary) => true
    const seriesIds = type === 'series' ? seriesIdsOf(libraryId) : new Set<number>()
    return (item: FilmSummary | SeriesSummary | EpisodeSummary) =>
      item.type === 'episode' ? seriesIds.has(item.seriesId) : item.libraryId === libraryId
  })()

  let rows: TypeRow[]
  if (type === 'films') {
    const films = filmsOnDisk(profileId, libraryId)
    // A row that excludes another resolves after it, so the exclusion sees a finished list.
    const produced = new Map<string, FilmSummary[]>()
    for (const row of resolutionOrder(configured)) {
      const excluded = new Set(row.dedupeAgainst.flatMap(ref => (produced.get(ref) ?? []).map(film => film.id)))
      produced.set(row.id, runFilmRow(row, excluded.size ? films.filter(film => !excluded.has(film.id)) : films, now))
    }
    rows = configured.map(row => ({ id: row.id, label: row.label, view: viewOf(row), items: (produced.get(row.id) ?? []).map(toMediaCard) }))
    if (continuing) rows.unshift({ id: continuing.id, label: continuing.label, view: 'landscape', items: runFilmRow(continuing, films, now).map(toMediaCard) })
  } else {
    const resolved = new Map(resolveSeriesShelves(profileId).rows.map(entry => [entry.id, entry.items]))
    rows = configured.map(row => ({
      id: row.id, label: row.label, view: viewOf(row),
      items: (resolved.get(row.id) ?? []).filter(inLibrary).map(toMediaCard),
    }))
    if (continuing) {
      const episodes = runEpisodeRow({ ...continuing, limit: 60 }, profileId).map(serializeEpisodeSummary).filter(inLibrary).slice(0, continuing.limit)
      rows.unshift({ id: continuing.id, label: continuing.label, view: 'landscape', items: episodes.map(toMediaCard) })
    }
  }

  const boxSets = resolveBoxSetRows(profileId, new Date(now))
  const themes = boxSets.themes
    .filter(theme => theme.mediaType === type)
    .map(theme => ({
      id: theme.id, label: theme.label, overview: theme.overview, imageUrl: theme.imageUrl,
      sets: theme.sets
        .map(set => ({ id: set.id, label: set.label, overview: set.overview, imageUrl: set.imageUrl, items: set.items.filter(inLibrary).map(toMediaCard) }))
        .filter(set => set.items.length > 0),
    }))
    .filter(theme => theme.sets.length > 0)

  return { type, label: settings.label, rows: rows.filter(row => row.items.length > 0), boxSets: { rowLabel: boxSets.rowLabel, themes } }
}
