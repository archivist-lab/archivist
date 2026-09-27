import { Router } from 'express'
import { getDb } from '../db.js'
import {
  TAG_FIELDS,
  TAG_OPERATORS,
  listRules,
  listTags,
  matchingIds,
  syncAllRules,
  syncRule,
  tagsForSubject,
  validateConditions,
  type TagCondition,
  type TagMediaType,
  type TagSubjectType,
} from './tags.js'

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'tag'
}

function subjectFromParams(params: Record<string, string>): { type: TagSubjectType; id: number } | null {
  const type = params.type === 'series' ? 'series' : params.type === 'film' ? 'film' : null
  const id = Number(params.id)
  return type && Number.isInteger(id) && id > 0 ? { type, id } : null
}

function mediaTypes(raw: unknown): TagMediaType[] {
  const list = Array.isArray(raw) ? raw : []
  const kept = list.filter((type): type is TagMediaType => type === 'films' || type === 'series')
  return kept.length > 0 ? kept : ['films', 'series']
}

function conditions(raw: unknown): TagCondition[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 20).flatMap((entry): TagCondition[] => {
    const record = (entry ?? {}) as Record<string, unknown>
    const field = String(record.field ?? '')
    const operator = String(record.operator ?? '')
    if (!TAG_FIELDS[field] || !TAG_OPERATORS.includes(operator as never)) return []
    return [{ field, operator: operator as TagCondition['operator'], value: record.value as TagCondition['value'] }]
  })
}

export function createTagsRouter(): Router {
  const router = Router()

  /** What a rule can be written against — the UI builds its pickers from this. */
  router.get('/tags/fields', (_req, res) => {
    res.json({
      fields: Object.entries(TAG_FIELDS).map(([key, field]) => ({
        key,
        label: field.label,
        kind: field.kind,
        hint: field.hint ?? null,
        mediaTypes: Object.keys(field.sql),
      })),
      operators: TAG_OPERATORS,
    })
  })

  router.get('/tags', (_req, res) => {
    res.json({ tags: listTags(), rules: listRules() })
  })

  router.post('/tags', (req, res) => {
    const name = String(req.body?.name ?? '').trim()
    if (!name) return res.status(400).json({ error: 'A tag needs a name' })
    const colour = /^#[0-9a-fA-F]{6}$/.test(String(req.body?.colour ?? '')) ? String(req.body.colour) : '#00D4FF'
    try {
      const result = getDb().prepare('INSERT INTO tags (name, slug, colour) VALUES (?, ?, ?)')
        .run(name.slice(0, 64), slugify(name), colour)
      res.status(201).json({ id: Number(result.lastInsertRowid) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(/UNIQUE/.test(message) ? 409 : 500).json({ error: /UNIQUE/.test(message) ? 'A tag with that name already exists' : message })
    }
  })

  router.put('/tags/:id', (req, res) => {
    const id = Number(req.params.id)
    const name = String(req.body?.name ?? '').trim()
    if (!Number.isInteger(id) || !name) return res.status(400).json({ error: 'A tag needs a name' })
    const colour = /^#[0-9a-fA-F]{6}$/.test(String(req.body?.colour ?? '')) ? String(req.body.colour) : '#00D4FF'
    getDb().prepare('UPDATE tags SET name = ?, slug = ?, colour = ? WHERE id = ?').run(name.slice(0, 64), slugify(name), colour, id)
    res.json({ ok: true })
  })

  router.delete('/tags/:id', (req, res) => {
    // The rules and applied tags go with it; both cascade on the foreign key.
    getDb().prepare('DELETE FROM tags WHERE id = ?').run(Number(req.params.id))
    res.json({ ok: true })
  })

  router.post('/tags/:id/rules', (req, res) => {
    const tagId = Number(req.params.id)
    if (!Number.isInteger(tagId)) return res.status(400).json({ error: 'Invalid tag' })
    const parsed = conditions(req.body?.conditions)
    const problem = validateConditions(parsed)
    if (problem) return res.status(400).json({ error: problem })
    const result = getDb().prepare(`
      INSERT INTO tag_rules (tag_id, name, media_types, conditions, enabled) VALUES (?, ?, ?, ?, ?)
    `).run(tagId, String(req.body?.name ?? '').slice(0, 80), JSON.stringify(mediaTypes(req.body?.mediaTypes)),
      JSON.stringify(parsed), req.body?.enabled === false ? 0 : 1)
    res.status(201).json({ id: Number(result.lastInsertRowid) })
  })

  router.put('/tags/rules/:ruleId', (req, res) => {
    const ruleId = Number(req.params.ruleId)
    if (!Number.isInteger(ruleId)) return res.status(400).json({ error: 'Invalid rule' })
    const parsed = conditions(req.body?.conditions)
    const problem = validateConditions(parsed)
    if (problem) return res.status(400).json({ error: problem })
    getDb().prepare(`
      UPDATE tag_rules SET name = ?, media_types = ?, conditions = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?
    `).run(String(req.body?.name ?? '').slice(0, 80), JSON.stringify(mediaTypes(req.body?.mediaTypes)),
      JSON.stringify(parsed), req.body?.enabled === false ? 0 : 1, ruleId)
    res.json({ ok: true })
  })

  router.delete('/tags/rules/:ruleId', (req, res) => {
    const ruleId = Number(req.params.ruleId)
    // Retract what the rule placed before it goes, so deleting a rule does not
    // leave its tags behind with nothing left to explain them.
    getDb().prepare("DELETE FROM media_tags WHERE rule_id = ? AND source = 'rule'").run(ruleId)
    getDb().prepare('DELETE FROM tag_rules WHERE id = ?').run(ruleId)
    res.json({ ok: true })
  })

  /** What a rule would tag, before it is saved. */
  router.post('/tags/rules/preview', (req, res) => {
    const parsed = conditions(req.body?.conditions)
    const problem = validateConditions(parsed)
    if (problem) return res.status(400).json({ error: problem })
    const db = getDb()
    const types = mediaTypes(req.body?.mediaTypes)
    try {
      const samples: Array<{ mediaType: TagMediaType; id: number; title: string; score: number | null }> = []
      let total = 0
      for (const mediaType of types) {
        const ids = matchingIds({ conditions: parsed }, mediaType, db)
        total += ids.length
        if (ids.length === 0) continue
        const table = mediaType === 'films' ? 'films' : 'series'
        const rows = db.prepare(`
          SELECT id, title, rating FROM ${table} WHERE id IN (${ids.slice(0, 200).map(() => '?').join(',')})
          ORDER BY rating DESC NULLS LAST LIMIT 8
        `).all(...ids.slice(0, 200)) as Array<{ id: number; title: string; rating: number | null }>
        samples.push(...rows.map(row => ({ mediaType, id: row.id, title: row.title, score: row.rating })))
      }
      res.json({ total, samples })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/tags/apply', (_req, res) => {
    try { res.json(syncAllRules()) }
    catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }) }
  })

  router.post('/tags/rules/:ruleId/apply', (req, res) => {
    const rule = listRules().find(entry => entry.id === Number(req.params.ruleId))
    if (!rule) return res.status(404).json({ error: 'No such rule' })
    try { res.json(syncRule(rule)) }
    catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }) }
  })

  // ── Tags on one title ───────────────────────────────────────────────────────

  router.get('/tags/:type/:id', (req, res) => {
    const subject = subjectFromParams(req.params)
    if (!subject) return res.status(400).json({ error: 'Invalid subject' })
    res.json({ tags: tagsForSubject(subject.type, subject.id) })
  })

  router.put('/tags/:type/:id/:tagId', (req, res) => {
    const subject = subjectFromParams(req.params)
    const tagId = Number(req.params.tagId)
    if (!subject || !Number.isInteger(tagId)) return res.status(400).json({ error: 'Invalid subject' })
    // A hand-applied tag replaces a rule's claim on it, so a later sweep leaves
    // it alone rather than retracting a deliberate choice.
    getDb().prepare(`
      INSERT INTO media_tags (subject_type, subject_id, tag_id, source, rule_id, applied_at)
      VALUES (?, ?, ?, 'manual', NULL, datetime('now'))
      ON CONFLICT(subject_type, subject_id, tag_id) DO UPDATE SET source = 'manual', rule_id = NULL
    `).run(subject.type, subject.id, tagId)
    res.json({ tags: tagsForSubject(subject.type, subject.id) })
  })

  router.delete('/tags/:type/:id/:tagId', (req, res) => {
    const subject = subjectFromParams(req.params)
    const tagId = Number(req.params.tagId)
    if (!subject || !Number.isInteger(tagId)) return res.status(400).json({ error: 'Invalid subject' })
    getDb().prepare('DELETE FROM media_tags WHERE subject_type = ? AND subject_id = ? AND tag_id = ?')
      .run(subject.type, subject.id, tagId)
    res.json({ tags: tagsForSubject(subject.type, subject.id) })
  })

  return router
}
