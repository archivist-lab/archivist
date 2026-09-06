import type { PlayerBoxSetEntry, PlayerBoxSetField, PlayerBoxSetSeason, PlayerBoxSetTemplate, PlayerBoxSetTheme } from '@archivist/contracts'
import { getDb } from '../db.js'
import { buildFieldSearch } from '../shared/field-search.js'
import { playerBoxSetLists } from '../lists/service.js'
import { serializeFilmSummary, serializeSeriesSummary } from './serializers.js'
import { boxSetLabel, getPlayerBoxSets, inSeason } from './box-sets.js'

/**
 * Turns configured box sets into rows.
 *
 * The filter comes from the same builder the library search uses, so "Directed
 * by" here and a director search there resolve identically — the box set is a
 * saved search with a heading, not a second implementation of one.
 *
 * A list-backed template asks the same question of a different source: its
 * members are the titles a published library List holds, so the row follows the
 * list as it refreshes instead of being maintained twice.
 */

function sortExpression(template: PlayerBoxSetTemplate, alias: string, mediaType: 'films' | 'series'): string {
  switch (template.sort) {
    case 'title': return `COALESCE(${alias}.sort_title, ${alias}.title)`
    case 'rating': return `COALESCE(${alias}.rating, 0)`
    case 'year': return `COALESCE(${alias}.year, 0)`
    case 'released': case 'aired':
      return mediaType === 'films'
        ? `COALESCE(${alias}.digital_release_date, ${alias}.physical_release_date, ${alias}.release_date, '')`
        : `COALESCE(${alias}.year, 0)`
    case 'random': return `abs((${alias}.id * 1103515245 + ${Math.floor(Date.now() / 86_400_000)}) % 2147483647)`
    default: return `COALESCE(${alias}.added_at, '')`
  }
}

/** Fields whose value names a person, and so can borrow that person's portrait. */
const PERSON_FIELDS: ReadonlySet<PlayerBoxSetField> = new Set([
  'director', 'writer', 'producer', 'composer', 'cinematographer', 'editor', 'creator', 'starring', 'any_cast',
])

/**
 * A field set's artwork when the operator chose none: the person's own
 * portrait, then artwork borrowed from the set's first item. A set with neither
 * renders as a lettered placeholder.
 */
function setArtwork(field: PlayerBoxSetField, value: string, first: any): string | null {
  if (PERSON_FIELDS.has(field)) {
    const person = getDb().prepare('SELECT profile_path FROM people WHERE lower(name) = lower(?) AND profile_path IS NOT NULL LIMIT 1')
      .get(value) as { profile_path: string } | undefined
    if (person?.profile_path) return person.profile_path
  }
  if (field === 'collection') {
    const collection = getDb().prepare('SELECT backdrop_url, poster_url FROM collections WHERE lower(name) = lower(?) LIMIT 1')
      .get(value) as { backdrop_url: string | null; poster_url: string | null } | undefined
    if (collection?.backdrop_url || collection?.poster_url) return collection.backdrop_url ?? collection.poster_url
  }
  return first?.backdrop_path ?? first?.poster_path ?? null
}

/** One resolvable set: where its members come from, and how the tile reads. */
interface Candidate {
  id: string
  label: string
  season: PlayerBoxSetSeason | null
  imageUrl: string | null
  overview: string | null
  /** Appended to the row's WHERE, with its own bound parameters. */
  member: { sql: string; params: unknown[] }
  /** Artwork to fall back on when the set names no image of its own. */
  fallbackArtwork: (first: any) => string | null
}

/**
 * The sets a template resolves to. A field template varies its configured
 * values; a list template takes one set per published List, which is why
 * publishing a list in the library is the entire act of adding a box set.
 */
function candidatesFor(template: PlayerBoxSetTemplate, alias: string): Candidate[] {
  if (template.source === 'lists') {
    const mediaType = template.mediaType === 'films' ? 'film' : 'series'
    return playerBoxSetLists(mediaType).map(list => ({
      id: `list-${list.id}`,
      label: template.labelPattern.replace('{value}', list.name),
      season: template.season,
      imageUrl: list.imageUrl,
      overview: list.overview,
      member: {
        // Membership is matched by provider id inside the list's own library, so
        // a title removed and re-added keeps its place without reconciliation.
        // Only statuses that mean "held here" count; a pending match is not in
        // the library to play.
        sql: `${alias}.library_id = ? AND ${alias}.tmdb_id IS NOT NULL AND ${alias}.tmdb_id IN (
          SELECT li.tmdb_id FROM list_items li
          WHERE li.list_id = ? AND li.media_type = ? AND li.status IN ('added', 'in_library'))`,
        params: [list.libraryId, list.id, mediaType],
      },
      fallbackArtwork: first => first?.backdrop_path ?? first?.poster_path ?? null,
    }))
  }
  const candidates: Candidate[] = []
  for (const set of template.sets) {
    if (!set.enabled) continue
    const filter = buildFieldSearch(template.mediaType, template.field, set.value, alias)
    // A field that yields nothing filterable would return the whole library
    // under a box set's heading, so the set is skipped instead.
    if (!filter) continue
    candidates.push({
      id: set.id,
      label: boxSetLabel(template, set),
      season: set.season ?? template.season,
      imageUrl: set.imageUrl,
      overview: set.overview,
      member: { sql: filter.sql, params: filter.params },
      fallbackArtwork: first => setArtwork(template.field, set.value, first),
    })
  }
  return candidates
}

export function resolveBoxSetRows(profileId: string, now = new Date()): { rowLabel: string; themes: PlayerBoxSetTheme[] } {
  const db = getDb()
  const settings = getPlayerBoxSets()
  const themes: PlayerBoxSetTheme[] = []

  for (const template of settings.templates) {
    if (!template.enabled) continue
    const films = template.mediaType === 'films'
    const alias = films ? 'f' : 's'
    const sets: PlayerBoxSetEntry[] = []

    for (const candidate of candidatesFor(template, alias)) {
      // A set's own window overrides its template's; neither means always.
      if (!inSeason(candidate.season, now)) continue

      const where = [films ? `${alias}.file_path IS NOT NULL` : `EXISTS (SELECT 1 FROM episodes ae WHERE ae.series_id = ${alias}.id AND ae.file_path IS NOT NULL)`, `(${candidate.member.sql})`]
      const params: unknown[] = [profileId, ...candidate.member.params]
      if (template.watchState === 'unwatched') where.push(films ? 'COALESCE(pp.completed, 0) = 0' : `EXISTS (SELECT 1 FROM episodes we LEFT JOIN playback_progress wp ON wp.profile_id = ? AND wp.media_type = 'episode' AND wp.media_id = we.id WHERE we.series_id = ${alias}.id AND we.file_path IS NOT NULL AND COALESCE(wp.completed, 0) = 0)`)
      if (template.watchState === 'watched') where.push(films ? 'COALESCE(pp.completed, 0) = 1' : `NOT EXISTS (SELECT 1 FROM episodes we LEFT JOIN playback_progress wp ON wp.profile_id = ? AND wp.media_type = 'episode' AND wp.media_id = we.id WHERE we.series_id = ${alias}.id AND we.file_path IS NOT NULL AND COALESCE(wp.completed, 0) = 0)`)
      if (template.watchState === 'in-progress' && films) where.push('COALESCE(pp.completed, 0) = 0 AND COALESCE(pp.position_seconds, 0) > 30')
      if (!films && (template.watchState === 'unwatched' || template.watchState === 'watched')) params.push(profileId)

      const sql = films
        ? `SELECT f.*, pp.position_seconds AS progress_position, pp.duration_seconds AS progress_duration, pp.completed AS progress_completed
           FROM films f LEFT JOIN playback_progress pp ON pp.profile_id = ? AND pp.media_type = 'film' AND pp.media_id = f.id
           WHERE ${where.join(' AND ')}
           ORDER BY ${sortExpression(template, alias, 'films')} ${template.sortOrder === 'asc' ? 'ASC' : 'DESC'}, f.id DESC LIMIT ?`
        : `SELECT s.*,
             (SELECT COUNT(*) FROM episodes ec WHERE ec.series_id = s.id) AS episode_count,
             (SELECT COUNT(*) FROM episodes ac WHERE ac.series_id = s.id AND ac.file_path IS NOT NULL) AS available_count
           FROM series s WHERE ${where.join(' AND ')}
           ORDER BY ${sortExpression(template, alias, 'series')} ${template.sortOrder === 'asc' ? 'ASC' : 'DESC'}, s.id DESC LIMIT ?`
      // The films query joins progress by profile; the series one does not.
      const bound = films ? params : params.slice(1)
      const raw = db.prepare(sql).all(...bound, template.limit) as any[]
      // An empty box set is a heading over nothing, so it is not offered.
      if (!raw.length) continue
      sets.push({
        id: `${template.id}-${candidate.id}`,
        label: candidate.label,
        imageUrl: candidate.imageUrl ?? candidate.fallbackArtwork(raw[0]),
        overview: candidate.overview,
        items: raw.map(entry => films ? serializeFilmSummary(entry) : serializeSeriesSummary(entry)),
      })
    }

    // A theme whose sets all resolved empty is a tile onto nothing.
    if (!sets.length) continue
    themes.push({
      id: `boxset-${template.id}`,
      label: template.name,
      mediaType: template.mediaType,
      view: template.view,
      imageUrl: template.imageUrl ?? sets[0].imageUrl,
      overview: template.overview,
      sets,
    })
  }
  return { rowLabel: settings.rowLabel, themes }
}
