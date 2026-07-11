import type BetterSqlite3 from 'better-sqlite3'
import { getDb } from '../db.js'
import { generateSlate } from './scheduler.js'

/**
 * Channels domain service — guide queries, now/next resolution, and the
 * playback-session builder (archivist-channels.md §30: WATCH_FROM_HERE /
 * PLAY_THIS_ONLY / JOIN_LIVE). Consumed by both the admin router and the
 * player contract, so item shapes here never leak file paths.
 */

export type SessionMode = 'WATCH_FROM_HERE' | 'PLAY_THIS_ONLY' | 'JOIN_LIVE'

const SESSION_QUEUE_CAP = 25

/** Guide/queue item view over a slot joined with its film or episode. */
export interface SlotView {
  id: number
  channelId: number
  blockId: number | null
  blockName: string | null
  itemType: 'film' | 'episode'
  itemId: number
  startsAt: number
  endsAt: number
  status: string
  locked: boolean
  title: string
  seriesId: number | null
  seriesTitle: string | null
  seasonNumber: number | null
  episodeNumber: number | null
  year: number | null
  posterUrl: string | null
  backdropUrl: string | null
  runtimeSeconds: number
  hasFile: boolean
  streamUrl: string | null
}

function slotView(row: any): SlotView {
  const isFilm = row.item_type === 'film'
  const hasFile = !!row.has_file
  return {
    id: row.id,
    channelId: row.channel_id,
    blockId: row.block_id ?? null,
    blockName: row.block_name ?? null,
    itemType: row.item_type,
    itemId: row.item_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    locked: !!row.locked,
    title: row.title ?? '(missing item)',
    seriesId: row.series_id ?? null,
    seriesTitle: row.series_title ?? null,
    seasonNumber: row.season_number ?? null,
    episodeNumber: row.episode_number ?? null,
    year: row.year ?? null,
    posterUrl: row.poster_path ?? null,
    backdropUrl: row.backdrop_path ?? null,
    runtimeSeconds: Math.round((row.ends_at - row.starts_at) / 1000),
    hasFile,
    streamUrl: hasFile ? `/api/v1/player/stream/${isFilm ? 'films' : 'episodes'}/${row.item_id}` : null,
  }
}

/**
 * Slots in [fromMs, toMs) joined with item metadata. Films and episodes are
 * joined separately and merged so each side keeps its natural columns.
 */
function slotQuery(db: BetterSqlite3.Database, where: string): BetterSqlite3.Statement {
  return db.prepare(`
    SELECT sl.*, b.name AS block_name,
      CASE sl.item_type WHEN 'film' THEN f.title ELSE COALESCE(e.title, 'Episode ' || e.episode_number) END AS title,
      CASE sl.item_type WHEN 'film' THEN NULL ELSE e.series_id END AS series_id,
      s.title AS series_title,
      e.season_number, e.episode_number,
      CASE sl.item_type WHEN 'film' THEN f.year ELSE s.year END AS year,
      CASE sl.item_type WHEN 'film' THEN f.poster_path ELSE COALESCE(e.still_path, s.poster_path) END AS poster_path,
      CASE sl.item_type WHEN 'film' THEN f.backdrop_path ELSE s.backdrop_path END AS backdrop_path,
      CASE sl.item_type WHEN 'film' THEN (f.file_path IS NOT NULL) ELSE (e.file_path IS NOT NULL) END AS has_file
    FROM schedule_slots sl
    LEFT JOIN programming_blocks b ON b.id = sl.block_id
    LEFT JOIN films f ON sl.item_type = 'film' AND f.id = sl.item_id
    LEFT JOIN episodes e ON sl.item_type = 'episode' AND e.id = sl.item_id
    LEFT JOIN series s ON s.id = e.series_id
    WHERE ${where}
    ORDER BY sl.starts_at
  `)
}

export function getGuide(channelId: number | null, fromMs: number, toMs: number): SlotView[] {
  const db = getDb()
  const rows = channelId
    ? slotQuery(db, 'sl.channel_id = ? AND sl.ends_at > ? AND sl.starts_at < ?').all(channelId, fromMs, toMs)
    : slotQuery(db, 'sl.ends_at > ? AND sl.starts_at < ?').all(fromMs, toMs)
  return (rows as any[]).map(slotView)
}

export function getSlot(slotId: number): SlotView | null {
  const row = slotQuery(getDb(), 'sl.id = ?').get(slotId) as any
  return row ? slotView(row) : null
}

/** What's on `channelId` at `atMs`: current slot (with offset) and the next one. */
export function getNow(channelId: number, atMs: number): { now: (SlotView & { offsetSeconds: number }) | null; next: SlotView | null } {
  const db = getDb()
  const current = slotQuery(db, 'sl.channel_id = ? AND sl.starts_at <= ? AND sl.ends_at > ?').get(channelId, atMs, atMs) as any
  const next = slotQuery(db, 'sl.channel_id = ? AND sl.starts_at > ?').get(channelId, atMs) as any
  return {
    now: current ? { ...slotView(current), offsetSeconds: Math.max(0, Math.floor((atMs - current.starts_at) / 1000)) } : null,
    next: next ? slotView(next) : null,
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionView {
  sessionId: number
  channelId: number | null
  mode: SessionMode
  status: string
  currentPosition: number
  items: Array<SlotView & { queuePosition: number; startOffsetSeconds: number; completedAt: string | null }>
}

export function getSession(sessionId: number): SessionView | null {
  const db = getDb()
  const session = db.prepare('SELECT * FROM play_sessions WHERE id = ?').get(sessionId) as any
  if (!session) return null
  const items = db.prepare(`
    SELECT psi.queue_position, psi.start_offset_seconds, psi.completed_at, psi.schedule_slot_id
    FROM play_session_items psi WHERE psi.session_id = ? ORDER BY psi.queue_position
  `).all(sessionId) as any[]
  const views = items.map(i => {
    const slot = i.schedule_slot_id ? getSlot(i.schedule_slot_id) : null
    return slot ? {
      ...slot,
      queuePosition: i.queue_position,
      startOffsetSeconds: i.start_offset_seconds,
      completedAt: i.completed_at ?? null,
    } : null
  }).filter((v): v is NonNullable<typeof v> => v !== null)
  return {
    sessionId: session.id,
    channelId: session.channel_id ?? null,
    mode: session.mode,
    status: session.status,
    currentPosition: session.current_position,
    items: views,
  }
}

/**
 * Builds a playback queue from a guide slot (§30). WATCH_FROM_HERE queues the
 * selected slot and everything after it on the channel (playable items only,
 * capped); JOIN_LIVE additionally offsets the first item by wall-clock elapsed
 * time; PLAY_THIS_ONLY queues just the one slot.
 */
export function createSession(channelId: number, startSlotId: number, mode: SessionMode, nowMs = Date.now()): SessionView {
  const db = getDb()
  const start = getSlot(startSlotId)
  if (!start || start.channelId !== channelId) throw new Error('Slot not found on channel')

  let queue: SlotView[]
  if (mode === 'PLAY_THIS_ONLY') {
    queue = [start]
  } else {
    const following = getGuide(channelId, start.startsAt, start.startsAt + 7 * 24 * 3600 * 1000)
      .filter(s => s.startsAt >= start.startsAt)
    queue = following.slice(0, SESSION_QUEUE_CAP)
  }
  queue = queue.filter(s => s.hasFile)
  if (!queue.length) throw new Error('Nothing playable from this slot')

  let firstOffset = 0
  if (mode === 'JOIN_LIVE') {
    const elapsed = Math.floor((nowMs - queue[0].startsAt) / 1000)
    firstOffset = Math.min(Math.max(0, elapsed), Math.max(0, queue[0].runtimeSeconds - 5))
  }

  const sessionId = db.transaction(() => {
    const id = db.prepare(
      'INSERT INTO play_sessions (channel_id, started_from_slot_id, mode) VALUES (?, ?, ?)',
    ).run(channelId, startSlotId, mode).lastInsertRowid as number
    const insert = db.prepare(`
      INSERT INTO play_session_items (session_id, schedule_slot_id, item_type, item_id, queue_position, start_offset_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    queue.forEach((s, i) => insert.run(id, s.id, s.itemType, s.itemId, i + 1, i === 0 ? firstOffset : 0))
    return id
  })()

  return getSession(sessionId)!
}

/** Marks a queue item complete, stamps the slot watched, advances the cursor. */
export function completeSessionItem(sessionId: number, queuePosition: number): SessionView | null {
  const db = getDb()
  const item = db.prepare(
    'SELECT * FROM play_session_items WHERE session_id = ? AND queue_position = ?',
  ).get(sessionId, queuePosition) as any
  if (!item) return null
  db.transaction(() => {
    db.prepare("UPDATE play_session_items SET completed_at = datetime('now') WHERE id = ?").run(item.id)
    if (item.schedule_slot_id) {
      db.prepare("UPDATE schedule_slots SET status = 'watched' WHERE id = ?").run(item.schedule_slot_id)
    }
    db.prepare("UPDATE play_sessions SET current_position = ?, updated_at = datetime('now') WHERE id = ?")
      .run(queuePosition + 1, sessionId)
  })()
  return getSession(sessionId)
}

export function endSession(sessionId: number): void {
  getDb().prepare(
    "UPDATE play_sessions SET status = 'ended', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
  ).run(sessionId)
}

// ── Generation ───────────────────────────────────────────────────────────────

export function generateChannel(channelId: number, days = 7, fromMs = Date.now()): number {
  return generateSlate(getDb(), channelId, fromMs, days)
}

export function generateAllChannels(days = 7, fromMs = Date.now()): Record<number, number> {
  const db = getDb()
  const ids = (db.prepare('SELECT id FROM channels WHERE is_active = 1').all() as Array<{ id: number }>).map(r => r.id)
  const out: Record<number, number> = {}
  for (const id of ids) out[id] = generateSlate(db, id, fromMs, days)
  return out
}
