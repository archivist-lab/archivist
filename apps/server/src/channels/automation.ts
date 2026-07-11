import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { generateChannel } from './service.js'

const logger = createLogger('ChannelsAutomation')
const POLL_INTERVAL_MS = 6 * 60 * 60_000
const STARTUP_DELAY_MS = 10_000
const MINIMUM_HORIZON_MS = 48 * 60 * 60_000
const GENERATE_DAYS = 7

let timer: NodeJS.Timeout | null = null
let startupTimer: NodeJS.Timeout | null = null
let running = false

export function replenishChannelGuides(): void {
  if (running) return
  running = true
  try {
    const now = Date.now()
    const rows = getDb().prepare(`
      SELECT c.id, MAX(s.ends_at) AS guide_end
      FROM channels c
      LEFT JOIN schedule_slots s ON s.channel_id = c.id AND s.ends_at > ?
      WHERE c.is_active = 1
      GROUP BY c.id
    `).all(now) as Array<{ id: number; guide_end: number | null }>

    for (const row of rows) {
      if ((row.guide_end ?? 0) >= now + MINIMUM_HORIZON_MS) continue
      const created = generateChannel(row.id, GENERATE_DAYS, now)
      logger.info(`Generated ${created} guide slots for channel #${row.id}`)
    }
  } catch (err) {
    logger.warn('Guide replenishment failed:', err instanceof Error ? err.message : String(err))
  } finally {
    running = false
  }
}

export function startChannelScheduler(): void {
  if (timer) return
  startupTimer = setTimeout(replenishChannelGuides, STARTUP_DELAY_MS)
  startupTimer.unref?.()
  timer = setInterval(replenishChannelGuides, POLL_INTERVAL_MS)
  timer.unref?.()
}

export function stopChannelScheduler(): void {
  if (timer) clearInterval(timer)
  if (startupTimer) clearTimeout(startupTimer)
  timer = null
  startupTimer = null
}
