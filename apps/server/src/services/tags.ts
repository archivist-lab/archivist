import type { Database } from 'better-sqlite3'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { SCORING_PROFILE } from './archivist-rating-settings.js'

/**
 * Tags, and the rules that apply them.
 *
 * A rule is a set of conditions ANDed together — "Archivist Rating is at least
 * 9", "genre contains Horror", "released before 1980". Conditions compile to
 * SQL rather than being evaluated in JavaScript, so a sweep over a large
 * library is one query per rule instead of one per title.
 *
 * Rule-applied tags are retracted as soon as a title stops matching. Tags set
 * by hand are never touched by a sweep: an operator's judgement outranks a
 * threshold, exactly as an Archivist Score outranks the weighted rating.
 */

const logger = createLogger('Tags')

export type TagMediaType = 'films' | 'series'
export type TagSubjectType = 'film' | 'series'

const SUBJECT_OF: Record<TagMediaType, TagSubjectType> = { films: 'film', series: 'series' }

export const TAG_OPERATORS = [
  'gte', 'lte', 'gt', 'lt', 'eq', 'ne', 'contains', 'not_contains', 'is_set', 'is_not_set',
] as const
export type TagOperator = typeof TAG_OPERATORS[number]

export interface TagCondition {
  field: string
  operator: TagOperator
  value?: string | number | boolean | null
}

export interface TagRule {
  id: number
  tagId: number
  name: string
  mediaTypes: TagMediaType[]
  conditions: TagCondition[]
  enabled: boolean
}

export interface Tag {
  id: number
  name: string
  slug: string
  colour: string
}

// ── The filterable fields ─────────────────────────────────────────────────────

type FieldKind = 'number' | 'text' | 'genre' | 'boolean'

interface FieldDefinition {
  label: string
  kind: FieldKind
  /** SQL for each media type. A field absent for a type never matches there. */
  sql: Partial<Record<TagMediaType, string>>
  hint?: string
}

/**
 * What a rule can test.
 *
 * `score` is the number the app displays — your Archivist Score where you have
 * set one, the weighted rating otherwise — because that is what a threshold
 * like "above 9" is naturally understood to mean. The two halves are separately
 * addressable for rules that genuinely mean one or the other.
 */
export const TAG_FIELDS: Record<string, FieldDefinition> = {
  score: {
    label: 'Archivist Rating', kind: 'number',
    hint: 'Out of 10 — your own score where you have set one, the weighted rating otherwise',
    sql: { films: 'f.rating', series: 's.rating' },
  },
  archivist_score: {
    label: 'Your Archivist Score', kind: 'number',
    hint: 'Out of 5, and unset for anything you have not scored yourself',
    sql: { films: 'mr.value', series: 'mr.value' },
  },
  weighted_score: {
    label: 'Weighted rating only', kind: 'number',
    hint: 'Out of 10, ignoring any score of your own',
    sql: { films: '(c.score / 10.0)', series: '(c.score / 10.0)' },
  },
  confidence: {
    label: 'Rating confidence', kind: 'number',
    hint: '0 to 1 — the share of the weighting that had data behind it',
    sql: { films: 'c.confidence', series: 'c.confidence' },
  },
  year: { label: 'Year', kind: 'number', sql: { films: 'f.year', series: 's.year' } },
  runtime: { label: 'Runtime (minutes)', kind: 'number', sql: { films: 'f.runtime', series: 's.runtime' } },
  added_days_ago: {
    label: 'Days since added', kind: 'number',
    sql: { films: "(julianday('now') - julianday(f.added_at))", series: "(julianday('now') - julianday(s.added_at))" },
  },
  genre: { label: 'Genre', kind: 'genre', sql: { films: 'f.genres', series: 's.genres' } },
  certification: { label: 'Certification', kind: 'text', sql: { films: 'f.certification', series: 's.certification' } },
  studio: { label: 'Studio', kind: 'text', sql: { films: 'f.studio' } },
  network: { label: 'Network', kind: 'text', sql: { series: 's.network' } },
  status: { label: 'Status', kind: 'text', sql: { films: 'f.status', series: 's.status' } },
  // Films only: a series carries no quality of its own, and "the resolution of
  // a series" has no single answer when its episodes differ.
  resolution: { label: 'Resolution', kind: 'text', sql: { films: 'f.current_resolution' } },
  tier: {
    label: 'Quality tier reached', kind: 'number',
    hint: '1 is best, 3 is lowest, 0 means the release group matched no tier',
    // A series has no tier of its own, so it takes the best any episode reached
    // — MIN over non-zero, since 1 outranks 3.
    sql: {
      films: 'COALESCE(f.current_tier, 0)',
      series: `COALESCE((SELECT MIN(e.current_tier) FROM episodes e
        WHERE e.series_id = s.id AND e.file_path IS NOT NULL AND e.current_tier > 0), 0)`,
    },
  },
  monitored: { label: 'Monitored', kind: 'boolean', sql: { films: 'f.monitored', series: 's.monitored' } },
  has_file: {
    label: 'Has a file', kind: 'boolean',
    sql: { films: '(f.file_path IS NOT NULL)', series: '(EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = s.id AND e.file_path IS NOT NULL))' },
  },
}

const NUMERIC_OPERATORS: ReadonlySet<TagOperator> = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'ne'])
const COMPARISON_SQL: Record<string, string> = { gte: '>=', lte: '<=', gt: '>', lt: '<', eq: '=', ne: '!=' }

// ── Compiling conditions to SQL ───────────────────────────────────────────────

class UnsupportedCondition extends Error {}

/**
 * One condition as a SQL fragment plus its parameters.
 *
 * Values are always bound, never interpolated — a tag rule is operator input
 * that reaches the database, and a name like `O'Brien` should be a studio
 * filter rather than a syntax error.
 */
function compileCondition(condition: TagCondition, mediaType: TagMediaType): { sql: string; params: unknown[] } {
  const field = TAG_FIELDS[condition.field]
  if (!field) throw new UnsupportedCondition(`Unknown field "${condition.field}"`)
  const column = field.sql[mediaType]
  // A field this media type does not have cannot match anything in it. Saying
  // so as `0 = 1` keeps the rule valid for the types that do have it.
  if (!column) return { sql: '0 = 1', params: [] }

  if (condition.operator === 'is_set') return { sql: `(${column} IS NOT NULL AND ${column} != '')`, params: [] }
  if (condition.operator === 'is_not_set') return { sql: `(${column} IS NULL OR ${column} = '')`, params: [] }

  if (field.kind === 'genre') {
    // Genres are stored as a JSON array, so membership is a json_each scan
    // rather than a LIKE that would match "Romance" inside "Romantic Comedy".
    const exists = `EXISTS (SELECT 1 FROM json_each(${column}) WHERE lower(json_each.value) = lower(?))`
    if (condition.operator === 'contains') return { sql: exists, params: [String(condition.value ?? '')] }
    if (condition.operator === 'not_contains') return { sql: `NOT ${exists}`, params: [String(condition.value ?? '')] }
    throw new UnsupportedCondition(`Genre cannot be compared with "${condition.operator}"`)
  }

  if (field.kind === 'boolean') {
    const wanted = condition.value === true || condition.value === 1 || condition.value === 'true'
    if (condition.operator === 'eq') return { sql: `COALESCE(${column}, 0) = ?`, params: [wanted ? 1 : 0] }
    if (condition.operator === 'ne') return { sql: `COALESCE(${column}, 0) != ?`, params: [wanted ? 1 : 0] }
    throw new UnsupportedCondition(`A yes/no field cannot be compared with "${condition.operator}"`)
  }

  if (field.kind === 'number') {
    if (!NUMERIC_OPERATORS.has(condition.operator)) throw new UnsupportedCondition(`A number cannot be compared with "${condition.operator}"`)
    const value = Number(condition.value)
    if (!Number.isFinite(value)) throw new UnsupportedCondition(`"${String(condition.value)}" is not a number`)
    // NULL never satisfies a threshold: an unrated film is not "below 9", it is
    // unrated, and a rule that swept those in would tag most of a new library.
    return { sql: `(${column} IS NOT NULL AND ${column} ${COMPARISON_SQL[condition.operator]} ?)`, params: [value] }
  }

  const text = String(condition.value ?? '')
  if (condition.operator === 'contains') return { sql: `${column} LIKE ? ESCAPE '\\'`, params: [`%${escapeLike(text)}%`] }
  if (condition.operator === 'not_contains') return { sql: `(${column} IS NULL OR ${column} NOT LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(text)}%`] }
  if (condition.operator === 'eq') return { sql: `lower(${column}) = lower(?)`, params: [text] }
  if (condition.operator === 'ne') return { sql: `(${column} IS NULL OR lower(${column}) != lower(?))`, params: [text] }
  throw new UnsupportedCondition(`Text cannot be compared with "${condition.operator}"`)
}

/** `%`, `_` and the escape character itself are literals inside a rule's value. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`)
}

function baseQuery(mediaType: TagMediaType): { from: string; id: string } {
  const subject = SUBJECT_OF[mediaType]
  return mediaType === 'films'
    ? {
        id: 'f.id',
        from: `FROM films f
          LEFT JOIN composite_scores c ON c.subject_type = '${subject}' AND c.subject_id = f.id
          LEFT JOIN media_ratings mr ON mr.profile_id = '${SCORING_PROFILE}' AND mr.subject_type = '${subject}' AND mr.subject_id = f.id`,
      }
    : {
        id: 's.id',
        from: `FROM series s
          LEFT JOIN composite_scores c ON c.subject_type = '${subject}' AND c.subject_id = s.id
          LEFT JOIN media_ratings mr ON mr.profile_id = '${SCORING_PROFILE}' AND mr.subject_type = '${subject}' AND mr.subject_id = s.id`,
      }
}

/**
 * Ids in one media type that a rule's conditions all hold for.
 *
 * `onlyId` narrows it to a single title, which is how a score change
 * re-evaluates just the thing that moved instead of the whole library.
 */
export function matchingIds(
  rule: Pick<TagRule, 'conditions'>,
  mediaType: TagMediaType,
  db: Database = getDb(),
  onlyId?: number,
): number[] {
  const { from, id } = baseQuery(mediaType)
  const clauses: string[] = []
  const params: unknown[] = []
  for (const condition of rule.conditions) {
    const compiled = compileCondition(condition, mediaType)
    clauses.push(compiled.sql)
    params.push(...compiled.params)
  }
  // A rule with no conditions matches nothing. The alternative — matching
  // everything — would tag an entire library on the way to writing a rule.
  if (clauses.length === 0) return []
  if (onlyId !== undefined) { clauses.push(`${id} = ?`); params.push(onlyId) }

  const rows = db.prepare(`SELECT ${id} AS id ${from} WHERE ${clauses.join(' AND ')}`).all(...params) as Array<{ id: number }>
  return rows.map(row => row.id)
}

/** Whether a rule's conditions can be compiled at all, and why not. */
export function validateConditions(conditions: TagCondition[]): string | null {
  for (const mediaType of ['films', 'series'] as const) {
    for (const condition of conditions) {
      try { compileCondition(condition, mediaType) }
      catch (err) { if (err instanceof UnsupportedCondition) return err.message; throw err }
    }
  }
  return null
}

// ── Reading rules and tags ────────────────────────────────────────────────────

function parseRule(row: Record<string, unknown>): TagRule {
  const list = <T,>(raw: unknown, fallback: T[]): T[] => {
    try { const parsed = JSON.parse(String(raw)); return Array.isArray(parsed) ? parsed as T[] : fallback }
    catch { return fallback }
  }
  return {
    id: Number(row.id),
    tagId: Number(row.tag_id),
    name: String(row.name ?? ''),
    mediaTypes: list<TagMediaType>(row.media_types, ['films', 'series']).filter(type => type === 'films' || type === 'series'),
    conditions: list<TagCondition>(row.conditions, []),
    enabled: Number(row.enabled) === 1,
  }
}

export function listRules(db: Database = getDb()): TagRule[] {
  return (db.prepare('SELECT * FROM tag_rules ORDER BY id').all() as Array<Record<string, unknown>>).map(parseRule)
}

export function listTags(db: Database = getDb()): Array<Tag & { rules: number; items: number }> {
  return db.prepare(`
    SELECT t.id, t.name, t.slug, t.colour,
      (SELECT COUNT(*) FROM tag_rules r WHERE r.tag_id = t.id) AS rules,
      (SELECT COUNT(*) FROM media_tags m WHERE m.tag_id = t.id) AS items
    FROM tags t ORDER BY t.name COLLATE NOCASE
  `).all() as Array<Tag & { rules: number; items: number }>
}

export function tagsForSubject(subjectType: TagSubjectType, subjectId: number, db: Database = getDb()) {
  return db.prepare(`
    SELECT t.id, t.name, t.slug, t.colour, m.source, m.rule_id AS ruleId
    FROM media_tags m JOIN tags t ON t.id = m.tag_id
    WHERE m.subject_type = ? AND m.subject_id = ?
    ORDER BY t.name COLLATE NOCASE
  `).all(subjectType, subjectId) as Array<Tag & { source: 'manual' | 'rule'; ruleId: number | null }>
}

// ── Applying rules ────────────────────────────────────────────────────────────

export interface RuleSyncResult { added: number; removed: number }

/**
 * Bring one rule's tags in line with what currently matches it.
 *
 * Both directions matter: a film that climbs past the threshold gains the tag,
 * and one that falls below loses it. A tag applied by hand is left alone, and a
 * rule will not overwrite it — if you tagged something yourself, that stands
 * even when the rule would have applied the same tag anyway.
 */
export function syncRule(rule: TagRule, db: Database = getDb(), onlyId?: number, onlyType?: TagMediaType): RuleSyncResult {
  if (!rule.enabled) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0

  const insert = db.prepare(`
    INSERT INTO media_tags (subject_type, subject_id, tag_id, source, rule_id, applied_at)
    VALUES (?, ?, ?, 'rule', ?, datetime('now'))
    ON CONFLICT(subject_type, subject_id, tag_id) DO NOTHING
  `)

  for (const mediaType of rule.mediaTypes) {
    if (onlyType && onlyType !== mediaType) continue
    const subject = SUBJECT_OF[mediaType]
    const matches = matchingIds(rule, mediaType, db, onlyId)
    const wanted = new Set(matches)

    for (const id of matches) {
      if (insert.run(subject, id, rule.tagId, rule.id).changes > 0) added++
    }

    // Retract only what this rule placed, and only within the scope examined.
    const held = db.prepare(`
      SELECT subject_id AS id FROM media_tags
      WHERE subject_type = ? AND tag_id = ? AND source = 'rule' AND rule_id = ?
        ${onlyId !== undefined ? 'AND subject_id = ?' : ''}
    `).all(...(onlyId !== undefined ? [subject, rule.tagId, rule.id, onlyId] : [subject, rule.tagId, rule.id])) as Array<{ id: number }>

    const drop = db.prepare('DELETE FROM media_tags WHERE subject_type = ? AND subject_id = ? AND tag_id = ? AND source = \'rule\'')
    for (const row of held) {
      if (!wanted.has(row.id) && drop.run(subject, row.id, rule.tagId).changes > 0) removed++
    }
  }

  return { added, removed }
}

/** Run every enabled rule over the whole library. */
export function syncAllRules(db: Database = getDb()): RuleSyncResult & { rules: number } {
  const rules = listRules(db).filter(rule => rule.enabled)
  let added = 0
  let removed = 0
  const run = db.transaction(() => {
    for (const rule of rules) {
      const result = syncRule(rule, db)
      added += result.added
      removed += result.removed
    }
  })
  run()
  if (added + removed > 0) logger.info(`Tag sweep: +${added} / -${removed} across ${rules.length} rule(s)`)
  return { added, removed, rules: rules.length }
}

/**
 * Re-evaluate every rule against one title.
 *
 * Called when a rating changes, so a film crossing a threshold gains or loses
 * its tag straight away rather than at the next sweep.
 */
export function syncSubject(subjectType: TagSubjectType, subjectId: number, db: Database = getDb()): RuleSyncResult {
  const mediaType: TagMediaType = subjectType === 'film' ? 'films' : 'series'
  let added = 0
  let removed = 0
  try {
    for (const rule of listRules(db)) {
      if (!rule.enabled || !rule.mediaTypes.includes(mediaType)) continue
      const result = syncRule(rule, db, subjectId, mediaType)
      added += result.added
      removed += result.removed
    }
  } catch (err) {
    // A malformed rule must not take a rating update down with it.
    logger.warn(`Could not retag ${subjectType} #${subjectId}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { added, removed }
}

// ── Scheduling ────────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000
const STARTUP_DELAY_MS = 60_000

let sweep: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null

/**
 * Sweep periodically as well as on every rating change.
 *
 * The per-title hook covers scores, but a rule can rest on things that move
 * without one — days since added, a genre corrected by a metadata refresh — and
 * those would otherwise wait for someone to press Apply.
 */
export function startTagScheduler(): void {
  if (sweep) return
  const run = () => {
    try { syncAllRules() }
    catch (err) { logger.warn(`Tag sweep failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
  startupTimer = setTimeout(run, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  sweep = setInterval(run, SWEEP_INTERVAL_MS)
  sweep.unref?.()
}

export function stopTagScheduler(): void {
  if (sweep) clearInterval(sweep)
  if (startupTimer) clearTimeout(startupTimer)
  sweep = null
  startupTimer = null
}
