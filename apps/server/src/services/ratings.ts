import type Database from 'better-sqlite3'
import type { RatingSubject, RatingSubjectType, RatingTreeNode, ResolvedRating, SeriesRatingTree, UnratedQueueItem } from '@archivist/contracts'
import { getDb } from '../db.js'

const SCALE_MAX = 5 as const
const SUBJECT_TABLE: Record<RatingSubjectType, string> = {
  film: 'films',
  series: 'series',
  season: 'seasons',
  episode: 'episodes',
}

type Db = Database.Database

type ResolutionRow = {
  ord: number
  type: RatingSubjectType
  id: number
  own_value: number | null
  season_id: number | null
  season_value: number | null
  series_id: number | null
  series_value: number | null
}

const none = (): ResolvedRating => ({ value: null, source: 'none', inheritedFrom: null, scaleMax: SCALE_MAX })
const own = (value: number): ResolvedRating => ({ value, source: 'own', inheritedFrom: null, scaleMax: SCALE_MAX })
const inherited = (value: number, type: 'series' | 'season', id: number): ResolvedRating => ({ value, source: 'inherited', inheritedFrom: { type, id }, scaleMax: SCALE_MAX })

function fromRow(row: ResolutionRow): ResolvedRating {
  if (row.own_value != null) return own(Number(row.own_value))
  if (row.type === 'episode' && row.season_value != null && row.season_id != null) return inherited(Number(row.season_value), 'season', Number(row.season_id))
  if ((row.type === 'episode' || row.type === 'season') && row.series_value != null && row.series_id != null) return inherited(Number(row.series_value), 'series', Number(row.series_id))
  return none()
}

export function resolveRatingsBulk(profileId: string, subjects: RatingSubject[], db: Db = getDb()): ResolvedRating[] {
  if (subjects.length === 0) return []
  const values = subjects.map(() => '(?, ?, ?)').join(', ')
  const params = subjects.flatMap((subject, ord) => [ord, subject.type, subject.id])
  const rows = db.prepare(`
    WITH requested(ord, type, id) AS (VALUES ${values})
    SELECT requested.ord, requested.type, requested.id,
      own.value AS own_value,
      CASE WHEN requested.type = 'episode' THEN episode.season_id
           WHEN requested.type = 'season' THEN season_direct.id ELSE NULL END AS season_id,
      season_rating.value AS season_value,
      CASE WHEN requested.type = 'episode' THEN episode.series_id
           WHEN requested.type = 'season' THEN season_direct.series_id
           WHEN requested.type = 'series' THEN requested.id ELSE NULL END AS series_id,
      series_rating.value AS series_value
    FROM requested
    LEFT JOIN episodes episode ON requested.type = 'episode' AND episode.id = requested.id
    LEFT JOIN seasons season_direct ON requested.type = 'season' AND season_direct.id = requested.id
    LEFT JOIN media_ratings own
      ON own.profile_id = ? AND own.subject_type = requested.type AND own.subject_id = requested.id
    LEFT JOIN media_ratings season_rating
      ON season_rating.profile_id = ? AND season_rating.subject_type = 'season'
      AND season_rating.subject_id = CASE WHEN requested.type = 'episode' THEN episode.season_id WHEN requested.type = 'season' THEN season_direct.id END
    LEFT JOIN media_ratings series_rating
      ON series_rating.profile_id = ? AND series_rating.subject_type = 'series'
      AND series_rating.subject_id = CASE WHEN requested.type = 'episode' THEN episode.series_id WHEN requested.type = 'season' THEN season_direct.series_id WHEN requested.type = 'series' THEN requested.id END
    ORDER BY requested.ord
  `).all(...params, profileId, profileId, profileId) as ResolutionRow[]
  const byOrd = new Map(rows.map(row => [Number(row.ord), fromRow(row)]))
  return subjects.map((_, index) => byOrd.get(index) ?? none())
}

export function resolveRating(profileId: string, subjectType: RatingSubjectType, subjectId: number, db: Db = getDb()): ResolvedRating {
  return resolveRatingsBulk(profileId, [{ type: subjectType, id: subjectId }], db)[0] ?? none()
}

function assertSubjectExists(subjectType: RatingSubjectType, subjectId: number, db: Db): void {
  const table = SUBJECT_TABLE[subjectType]
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(subjectId)) {
    const error = new Error(`${subjectType} ${subjectId} not found`) as Error & { status?: number }
    error.status = 404
    throw error
  }
}

function recordRatingChange(profileId: string, subjectType: RatingSubjectType, subjectId: number, db: Db): void {
  db.prepare("INSERT INTO player_sync_changes (scope, media_type, media_id) VALUES ('ratings', ?, ?)").run(subjectType, subjectId)
  db.prepare("UPDATE recommendation_snapshots SET invalidated_at = datetime('now') WHERE audience = ? OR audience = 'household'").run(profileId)
}

export function setRating(profileId: string, subjectType: RatingSubjectType, subjectId: number, value: number, db: Db = getDb()): ResolvedRating {
  if (!Number.isInteger(value) || value < 1 || value > SCALE_MAX) throw new RangeError('Rating value must be an integer from 1 to 5')
  assertSubjectExists(subjectType, subjectId, db)
  db.transaction(() => {
    db.prepare(`INSERT INTO media_ratings (profile_id, subject_type, subject_id, value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, subject_type, subject_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(profileId, subjectType, subjectId, value)
    db.prepare('DELETE FROM media_rating_dismissals WHERE profile_id = ? AND subject_type = ? AND subject_id = ?').run(profileId, subjectType, subjectId)
    recordRatingChange(profileId, subjectType, subjectId, db)
  })()
  return resolveRating(profileId, subjectType, subjectId, db)
}

export function clearRating(profileId: string, subjectType: RatingSubjectType, subjectId: number, db: Db = getDb()): ResolvedRating {
  assertSubjectExists(subjectType, subjectId, db)
  db.transaction(() => {
    db.prepare('DELETE FROM media_ratings WHERE profile_id = ? AND subject_type = ? AND subject_id = ?').run(profileId, subjectType, subjectId)
    recordRatingChange(profileId, subjectType, subjectId, db)
  })()
  return resolveRating(profileId, subjectType, subjectId, db)
}

export function dismissUnrated(profileId: string, subjectType: RatingSubjectType, subjectId: number, db: Db = getDb()): void {
  assertSubjectExists(subjectType, subjectId, db)
  db.prepare(`INSERT INTO media_rating_dismissals (profile_id, subject_type, subject_id)
    VALUES (?, ?, ?) ON CONFLICT(profile_id, subject_type, subject_id) DO NOTHING`).run(profileId, subjectType, subjectId)
}

export function resolveSeriesRatingTree(profileId: string, seriesId: number, db: Db = getDb()): SeriesRatingTree {
  const series = db.prepare('SELECT id, title FROM series WHERE id = ?').get(seriesId) as { id: number; title: string } | undefined
  if (!series) { const error = new Error(`series ${seriesId} not found`) as Error & { status?: number }; error.status = 404; throw error }
  const seasons = db.prepare('SELECT id, season_number, title FROM seasons WHERE series_id = ? ORDER BY season_number').all(seriesId) as Array<{ id: number; season_number: number; title: string | null }>
  const episodes = db.prepare('SELECT id, season_id, season_number, episode_number, title FROM episodes WHERE series_id = ? ORDER BY season_number, episode_number').all(seriesId) as Array<{ id: number; season_id: number; season_number: number; episode_number: number; title: string | null }>
  const subjects: RatingSubject[] = [
    { type: 'series', id: seriesId },
    ...seasons.map(row => ({ type: 'season' as const, id: row.id })),
    ...episodes.map(row => ({ type: 'episode' as const, id: row.id })),
  ]
  const ratings = resolveRatingsBulk(profileId, subjects, db)
  const ratingByKey = new Map(subjects.map((subject, index) => [`${subject.type}:${subject.id}`, ratings[index]]))
  const node = (subject: RatingSubject, title: string, subtitle: string | null): RatingTreeNode => ({
    subject, title, subtitle, rating: ratingByKey.get(`${subject.type}:${subject.id}`) ?? none(),
  })
  return {
    series: node({ type: 'series', id: seriesId }, series.title, 'Series'),
    seasons: seasons.map(season => ({
      season: node({ type: 'season', id: season.id }, season.title || `Season ${season.season_number}`, `Season ${season.season_number}`),
      episodes: episodes.filter(episode => episode.season_id === season.id).map(episode => node(
        { type: 'episode', id: episode.id },
        episode.title || `Episode ${episode.episode_number}`,
        `S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')}`,
      )),
    })),
  }
}

export function listUnratedQueue(profileId: string, lookbackDays = 30, limit = 20, db: Db = getDb()): UnratedQueueItem[] {
  const rows = db.prepare(`
    SELECT 'film' AS subject_type, f.id AS subject_id, f.title, NULL AS subtitle,
      f.poster_path AS poster_url, pp.updated_at AS completed_at, NULL AS series_id, NULL AS series_title,
      NULL AS season_number, NULL AS episode_number
    FROM playback_progress pp JOIN films f ON pp.media_type = 'film' AND f.id = pp.media_id
    LEFT JOIN media_ratings rating ON rating.profile_id = pp.profile_id AND rating.subject_type = 'film' AND rating.subject_id = f.id
    LEFT JOIN media_rating_dismissals dismissal ON dismissal.profile_id = pp.profile_id AND dismissal.subject_type = 'film' AND dismissal.subject_id = f.id
    WHERE pp.profile_id = ? AND (pp.completed = 1 OR (pp.duration_seconds > 0 AND pp.position_seconds / pp.duration_seconds >= .85))
      AND rating.subject_id IS NULL AND dismissal.subject_id IS NULL AND datetime(pp.updated_at) >= datetime('now', ?)
    UNION ALL
    SELECT 'episode', e.id, COALESCE(e.title, 'Episode ' || e.episode_number),
      'S' || printf('%02d', e.season_number) || 'E' || printf('%02d', e.episode_number),
      COALESCE(e.still_path, s.poster_path), pp.updated_at AS completed_at, s.id, s.title, e.season_number, e.episode_number
    FROM playback_progress pp JOIN episodes e ON pp.media_type = 'episode' AND e.id = pp.media_id JOIN series s ON s.id = e.series_id
    LEFT JOIN media_ratings rating ON rating.profile_id = pp.profile_id AND rating.subject_type = 'episode' AND rating.subject_id = e.id
    LEFT JOIN media_rating_dismissals dismissal ON dismissal.profile_id = pp.profile_id AND dismissal.subject_type = 'episode' AND dismissal.subject_id = e.id
    WHERE pp.profile_id = ? AND (pp.completed = 1 OR (pp.duration_seconds > 0 AND pp.position_seconds / pp.duration_seconds >= .85))
      AND rating.subject_id IS NULL AND dismissal.subject_id IS NULL AND datetime(pp.updated_at) >= datetime('now', ?)
    ORDER BY completed_at DESC
  `).all(profileId, `-${lookbackDays} days`, profileId, `-${lookbackDays} days`) as any[]

  const films: UnratedQueueItem[] = []
  const episodeGroups = new Map<number, any[]>()
  for (const row of rows) {
    if (row.subject_type === 'film') {
      films.push({ subject: { type: 'film', id: Number(row.subject_id) }, title: row.title, subtitle: null, posterUrl: row.poster_url ?? null, completedAt: row.completed_at, rating: resolveRating(profileId, 'film', Number(row.subject_id), db) })
    } else {
      const group = episodeGroups.get(Number(row.series_id)) ?? []
      group.push(row)
      episodeGroups.set(Number(row.series_id), group)
    }
  }
  const seriesItems: UnratedQueueItem[] = [...episodeGroups.entries()].map(([seriesId, group]) => {
    const subjects = group.map(row => ({ type: 'episode' as const, id: Number(row.subject_id) }))
    const ratings = resolveRatingsBulk(profileId, subjects, db)
    return {
      subject: { type: 'series', id: seriesId }, title: group[0].series_title, subtitle: `${group.length} finished episode${group.length === 1 ? '' : 's'}`,
      posterUrl: group[0].poster_url ?? null, completedAt: group[0].completed_at, rating: resolveRating(profileId, 'series', seriesId, db), childCount: group.length,
      children: group.map((row, index) => ({ subject: subjects[index], title: row.title, subtitle: row.subtitle, rating: ratings[index] })),
    }
  })
  return [...films, ...seriesItems].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, limit)
}

export function listExplicitRatingSignals(profileId: string, db: Db = getDb()): Array<{ subjectType: RatingSubjectType; subjectId: number; value: number }> {
  return (db.prepare('SELECT subject_type, subject_id, value FROM media_ratings WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId) as any[])
    .map(row => ({ subjectType: row.subject_type, subjectId: Number(row.subject_id), value: Number(row.value) }))
}
