import { Router } from 'express'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { generateAllChannels, generateChannel, getGuide } from './service.js'

const logger = createLogger('Channels')

/**
 * Admin API for the Channels tab (archivist-channels.md). Channel + block CRUD,
 * slate generation, guide reads, and slot edits (lock/remove). Global scope —
 * channels span libraries, so no x-tab-context is involved.
 */

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function channelShape(row: any) {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    description: row.description ?? null,
    brandColor: row.brand_color,
    logoUrl: row.logo_url ?? null,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  }
}

function blockShape(row: any) {
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    daysOfWeek: parseJson<number[]>(row.days_of_week, []),
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    rules: parseJson<Record<string, unknown>>(row.rules, {}),
    priority: row.priority,
  }
}

export function createChannelsRouter(): Router {
  const router = Router()
  const db = getDb()

  // ── Channels ───────────────────────────────────────────────────────────────

  router.get('/', (_req, res) => {
    const rows = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM programming_blocks b WHERE b.channel_id = c.id) AS block_count,
             (SELECT COUNT(*) FROM schedule_slots s WHERE s.channel_id = c.id AND s.ends_at > ?) AS upcoming_slots
      FROM channels c ORDER BY c.number
    `).all(Date.now()) as any[]
    res.json({ channels: rows.map(r => ({ ...channelShape(r), blockCount: r.block_count, upcomingSlots: r.upcoming_slots })) })
  })

  router.post('/', (req, res) => {
    try {
      const { name, number, description, brandColor } = req.body ?? {}
      if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' })
      const num = Number.isFinite(Number(number)) && Number(number) > 0
        ? Number(number)
        : ((db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM channels').get() as any).n as number)
      const seed = Math.floor(Math.random() * 2 ** 31)
      const id = db.prepare(
        'INSERT INTO channels (number, name, description, brand_color, seed) VALUES (?, ?, ?, ?, ?)',
      ).run(num, name.trim(), description ?? null, brandColor || '#00D4FF', seed).lastInsertRowid
      logger.info(`Created channel ${num} "${name}"`)
      res.status(201).json(channelShape(db.prepare('SELECT * FROM channels WHERE id = ?').get(id)))
    } catch (err: any) {
      if (String(err?.message).includes('UNIQUE')) return res.status(409).json({ error: 'Channel number already in use' })
      res.status(400).json({ error: String(err?.message ?? err) })
    }
  })

  router.put('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    const { name, number, description, brandColor, isActive } = req.body ?? {}
    try {
      db.prepare(`
        UPDATE channels SET name = ?, number = ?, description = ?, brand_color = ?, is_active = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        typeof name === 'string' && name.trim() ? name.trim() : row.name,
        Number.isFinite(Number(number)) && Number(number) > 0 ? Number(number) : row.number,
        description !== undefined ? description : row.description,
        brandColor || row.brand_color,
        isActive === undefined ? row.is_active : (isActive ? 1 : 0),
        row.id,
      )
      res.json(channelShape(db.prepare('SELECT * FROM channels WHERE id = ?').get(row.id)))
    } catch (err: any) {
      if (String(err?.message).includes('UNIQUE')) return res.status(409).json({ error: 'Channel number already in use' })
      res.status(400).json({ error: String(err?.message ?? err) })
    }
  })

  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id)
    res.status(204).end()
  })

  // ── Blocks ─────────────────────────────────────────────────────────────────

  router.get('/:id/blocks', (req, res) => {
    const rows = db.prepare('SELECT * FROM programming_blocks WHERE channel_id = ? ORDER BY start_minute').all(req.params.id) as any[]
    res.json({ blocks: rows.map(blockShape) })
  })

  router.post('/:id/blocks', (req, res) => {
    const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(req.params.id) as any
    if (!channel) return res.status(404).json({ error: 'Channel not found' })
    const { name, daysOfWeek, startMinute, endMinute, rules, priority } = req.body ?? {}
    if (!name) return res.status(400).json({ error: 'name is required' })
    const start = Number(startMinute), end = Number(endMinute)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).json({ error: 'endMinute must be after startMinute' })
    }
    const days = Array.isArray(daysOfWeek) ? daysOfWeek.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : []
    if (!days.length) return res.status(400).json({ error: 'daysOfWeek must include at least one day (0-6)' })
    const id = db.prepare(`
      INSERT INTO programming_blocks (channel_id, name, days_of_week, start_minute, end_minute, rules, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(channel.id, String(name).trim(), JSON.stringify(days), start, end,
      JSON.stringify(rules ?? {}), Number(priority) || 0).lastInsertRowid
    res.status(201).json(blockShape(db.prepare('SELECT * FROM programming_blocks WHERE id = ?').get(id)))
  })

  router.put('/:id/blocks/:blockId', (req, res) => {
    const row = db.prepare('SELECT * FROM programming_blocks WHERE id = ? AND channel_id = ?')
      .get(req.params.blockId, req.params.id) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    const { name, daysOfWeek, startMinute, endMinute, rules, priority } = req.body ?? {}
    const days = Array.isArray(daysOfWeek)
      ? daysOfWeek.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
      : parseJson<number[]>(row.days_of_week, [])
    db.prepare(`
      UPDATE programming_blocks SET name = ?, days_of_week = ?, start_minute = ?, end_minute = ?, rules = ?, priority = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name ? String(name).trim() : row.name,
      JSON.stringify(days),
      Number.isFinite(Number(startMinute)) ? Number(startMinute) : row.start_minute,
      Number.isFinite(Number(endMinute)) ? Number(endMinute) : row.end_minute,
      rules !== undefined ? JSON.stringify(rules) : row.rules,
      Number.isFinite(Number(priority)) ? Number(priority) : row.priority,
      row.id,
    )
    res.json(blockShape(db.prepare('SELECT * FROM programming_blocks WHERE id = ?').get(row.id)))
  })

  router.delete('/:id/blocks/:blockId', (req, res) => {
    db.prepare('DELETE FROM programming_blocks WHERE id = ? AND channel_id = ?').run(req.params.blockId, req.params.id)
    res.status(204).end()
  })

  // ── Slate generation & guide ───────────────────────────────────────────────

  router.post('/generate', (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 14)
      const results = generateAllChannels(days)
      const total = Object.values(results).reduce((a, b) => a + b, 0)
      logger.info(`Generated slates for ${Object.keys(results).length} channels (${total} slots)`)
      res.json({ results, totalSlots: total })
    } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }) }
  })

  router.post('/:id/generate', (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 14)
      const created = generateChannel(Number(req.params.id), days)
      logger.info(`Generated ${created} slots for channel ${req.params.id}`)
      res.json({ created })
    } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }) }
  })

  router.get('/guide', (req, res) => {
    const from = Number(req.query.from) || Date.now()
    const to = Number(req.query.to) || from + 24 * 3600 * 1000
    res.json({ slots: getGuide(null, from, to) })
  })

  router.get('/:id/guide', (req, res) => {
    const from = Number(req.query.from) || Date.now()
    const to = Number(req.query.to) || from + 24 * 3600 * 1000
    res.json({ slots: getGuide(Number(req.params.id), from, to) })
  })

  // ── Slot edits ─────────────────────────────────────────────────────────────

  router.post('/slots/:slotId/lock', (req, res) => {
    const row = db.prepare('SELECT id, locked FROM schedule_slots WHERE id = ?').get(req.params.slotId) as any
    if (!row) return res.status(404).json({ error: 'Not found' })
    db.prepare('UPDATE schedule_slots SET locked = ? WHERE id = ?').run(row.locked ? 0 : 1, row.id)
    res.json({ id: row.id, locked: !row.locked })
  })

  router.delete('/slots/:slotId', (req, res) => {
    db.prepare('DELETE FROM schedule_slots WHERE id = ?').run(req.params.slotId)
    res.status(204).end()
  })

  return router
}
