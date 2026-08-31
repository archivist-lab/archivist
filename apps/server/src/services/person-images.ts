import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import { getMediaRoot } from '../shared/media-organizer.js'
import { createLogger } from '@archivist/core'

/**
 * Portraits, stored once per person.
 *
 * Credits arrive from the providers as a blob per film and per series, each
 * carrying the same remote URL for the same actor. Rendering those directly
 * meant a household fetching one person's photograph again for every title they
 * appear in, from a third party, on every device — and a portrait that simply
 * vanished the day the provider moved it.
 *
 * `people` already deduplicates by provider id, so the file belongs there: one
 * download per person, reused by every credit they hold. `profile_path` stays
 * as the URL it came from, which is what lets a changed provider URL be noticed
 * and fetched again; `profile_image_path` is where it landed.
 */

const logger = createLogger('PersonImages')

/** Guard against a hostile or broken provider handing us something enormous. */
const MAX_BYTES = 4 * 1024 * 1024

/** Portraits sit together rather than beside any one title's media. */
export function personImageDir(): string {
  return join(getMediaRoot(), 'people')
}

/** The public path for a stored portrait; the file itself may not exist yet. */
export function personImageUrl(personId: number): string {
  return `/media/people/${personId}.jpg`
}

export interface PersonImageRow {
  id: number
  profile_path: string | null
  profile_image_path: string | null
}

/**
 * Downloads one person's portrait and records where it went.
 *
 * Returns the stored path, or null when there was nothing to fetch or the
 * fetch failed — a missing portrait is a cosmetic loss, never a reason to fail
 * whatever asked for it.
 */
export async function downloadPersonImage(person: PersonImageRow, db: Database = getDb()): Promise<string | null> {
  const source = person.profile_path?.trim()
  if (!source || !/^https?:\/\//i.test(source)) return null

  const directory = personImageDir()
  const target = join(directory, `${person.id}.jpg`)
  const stored = personImageUrl(person.id)

  // Already on disk from an earlier run whose row update did not land.
  if (person.profile_image_path !== stored && existsSync(target) && statSync(target).size > 0) {
    db.prepare("UPDATE people SET profile_image_path = ?, updated_at = datetime('now') WHERE id = ?").run(stored, person.id)
    return stored
  }

  // Written under a temporary name and moved into place, so a portrait that is
  // half-downloaded when the process stops is never served as a whole one.
  const partial = `${target}.part`
  try {
    mkdirSync(directory, { recursive: true })
    const response = await axios.get(source, {
      responseType: 'stream',
      timeout: 15_000,
      maxContentLength: MAX_BYTES,
      headers: { 'User-Agent': 'Archivist/2.0' },
    })
    const contentType = String(response.headers['content-type'] ?? '')
    if (!contentType.startsWith('image/')) throw new Error(`expected an image, got ${contentType || 'no content type'}`)

    await new Promise<void>((resolve, reject) => {
      const file = createWriteStream(partial)
      let written = 0
      response.data.on('data', (chunk: Buffer) => {
        written += chunk.length
        if (written > MAX_BYTES) {
          response.data.destroy()
          file.destroy()
          reject(new Error('portrait exceeded the size limit'))
        }
      })
      response.data.on('error', reject)
      file.on('error', reject)
      file.on('finish', () => resolve())
      response.data.pipe(file)
    })
    if (!existsSync(partial) || statSync(partial).size === 0) throw new Error('portrait was empty')
    renameSync(partial, target)
    db.prepare("UPDATE people SET profile_image_path = ?, updated_at = datetime('now') WHERE id = ?").run(stored, person.id)
    return stored
  } catch (error) {
    rmSync(partial, { force: true })
    logger.debug(`Portrait for person ${person.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * People with a portrait to fetch and no file yet.
 *
 * A person whose provider URL later changes is put back into this set by the
 * credit index, which clears the stored path when it sees a different source —
 * so a refreshed photograph is not ignored forever.
 */
export function pendingPortraits(limit: number, db: Database = getDb()): PersonImageRow[] {
  return db.prepare(`
    SELECT id, profile_path, profile_image_path FROM people
    WHERE profile_path IS NOT NULL AND profile_path <> ''
      AND (profile_image_path IS NULL OR profile_image_path = '')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(Math.max(1, limit)) as PersonImageRow[]
}

export interface PortraitBackfill { attempted: number; stored: number }

/**
 * Fetches every outstanding portrait, a few at a time.
 *
 * Bounded because this runs against a third party over a household connection:
 * a library with a few thousand people would otherwise open a few thousand
 * sockets at once on a device that is also expected to play video.
 */
export async function backfillPersonImages(
  { limit = 5000, concurrency = 4, db = getDb() }: { limit?: number; concurrency?: number; db?: Database } = {},
): Promise<PortraitBackfill> {
  const pending = pendingPortraits(limit, db)
  if (!pending.length) return { attempted: 0, stored: 0 }
  let stored = 0
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, pending.length)) }, async () => {
    while (next < pending.length) {
      const person = pending[next++]
      if (await downloadPersonImage(person, db)) stored++
    }
  })
  await Promise.all(workers)
  logger.info(`Stored ${stored} of ${pending.length} outstanding portrait(s)`)
  return { attempted: pending.length, stored }
}

/**
 * Local portraits for a set of provider ids, in one query.
 *
 * Credits carry the provider's id, which is how `people` deduplicates them, so
 * that is the join — no name matching, and no row for a credit whose portrait
 * has not been fetched yet.
 */
export function portraitsByProviderId(providerIds: Array<number | string>, db: Database = getDb()): Map<number, string> {
  const ids = [...new Set(providerIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length) return new Map()
  const rows = db.prepare(`
    SELECT tmdb_id, profile_image_path FROM people
    WHERE profile_image_path IS NOT NULL AND profile_image_path <> ''
      AND tmdb_id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids) as Array<{ tmdb_id: number; profile_image_path: string }>
  return new Map(rows.map(row => [Number(row.tmdb_id), row.profile_image_path]))
}

/** A credit as the provider blobs store it — the fields a portrait is keyed by. */
interface CreditLike { id?: number | string; profilePath?: string | null; profileUrl?: string | null }

/**
 * Rewrites credits to the stored portrait wherever there is one.
 *
 * A credit with no stored portrait keeps the provider URL it arrived with, so
 * the picture still draws while a backfill is working through the library
 * rather than the cast row emptying out until it finishes.
 */
export function withLocalPortraits<T extends CreditLike>(credits: T[], db: Database = getDb()): T[] {
  if (!Array.isArray(credits) || !credits.length) return Array.isArray(credits) ? credits : []
  let portraits: Map<number, string>
  try {
    portraits = portraitsByProviderId(credits.map(credit => credit.id ?? 0), db)
  } catch {
    // Serving a credit matters more than serving its picture from disk.
    return credits
  }
  if (!portraits.size) return credits
  return credits.map(credit => {
    const stored = portraits.get(Number(credit.id))
    return stored ? { ...credit, profilePath: stored, profileUrl: stored } : credit
  })
}
