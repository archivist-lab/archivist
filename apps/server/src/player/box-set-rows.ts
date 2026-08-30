import type { PlayerBoxSetEntry, PlayerBoxSetField, PlayerBoxSetTemplate, PlayerBoxSetTheme } from '@archivist/contracts'
import { getDb } from '../db.js'
import { buildFieldSearch } from '../shared/field-search.js'
import { serializeFilmSummary, serializeSeriesSummary } from './serializers.js'
import { boxSetLabel, getPlayerBoxSets, inSeason } from './box-sets.js'

/**
 * Turns configured box sets into rows.
 *
 * The filter comes from the same builder the library search uses, so "Directed
 * by" here and a director search there resolve identically — the box set is a
 * saved search with a heading, not a second implementation of one.
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
 * A set's artwork, in order of how well it identifies the set: what the
 * operator chose, then the person's own portrait, then artwork borrowed from
 * the set's first item. A set with none renders as a lettered placeholder.
 */
function setArtwork(field: PlayerBoxSetField, value: string, override: string | null, first: any): string | null {
  if (override) return override
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

export function resolveBoxSetRows(profileId: string, now = new Date()): { rowLabel: string; themes: PlayerBoxSetTheme[] } {
  const db = getDb()
  const settings = getPlayerBoxSets()
  const themes: PlayerBoxSetTheme[] = []

  for (const template of settings.templates) {
    if (!template.enabled) continue
    const films = template.mediaType === 'films'
    const alias = films ? 'f' : 's'
    const sets: PlayerBoxSetEntry[] = []

    for (const set of template.sets) {
      // A set's own window overrides its template's; neither means always.
      if (!set.enabled || !inSeason(set.season ?? template.season, now)) continue
      const filter = buildFieldSearch(template.mediaType, template.field, set.value, alias)
      // A field that yields nothing filterable would return the whole library
      // under a box set's heading, so the set is skipped instead.
      if (!filter) continue

      const where = [films ? `${alias}.file_path IS NOT NULL` : `EXISTS (SELECT 1 FROM episodes ae WHERE ae.series_id = ${alias}.id AND ae.file_path IS NOT NULL)`, `(${filter.sql})`]
      const params: unknown[] = [profileId, ...filter.params]
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
        id: `${template.id}-${set.id}`,
        label: boxSetLabel(template, set),
        imageUrl: setArtwork(template.field, set.value, set.imageUrl, raw[0]),
        overview: set.overview,
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
