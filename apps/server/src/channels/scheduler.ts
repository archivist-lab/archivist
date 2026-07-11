import type BetterSqlite3 from 'better-sqlite3'

/**
 * Slate generation for Channels (archivist-channels.md §27 + §15).
 *
 * A scoring-based scheduler fills each programming block's window with library
 * items. Deterministic per channel: ties are broken by a seeded PRNG so
 * regenerating an unchanged week is stable. Locked slots are pinned inputs —
 * generation flows around them.
 *
 * Two block flavours:
 *  - Rule-filled: candidates are filtered (type/genre/year/runtime/watched)
 *    and scored. Episodes are candidates at the series level — only each
 *    series' next episode is considered, giving natural sequential airing.
 *  - Series stack: an ordered priority list of series (with optional season
 *    ranges). Each block occurrence airs N sequential episodes from the first
 *    stack entry that still has matching episodes; exhausted entries fall
 *    through to the next (Sopranos → Breaking Bad → Mad Men).
 *
 * "Watched" means completed through a channel play session — the server-side
 * watch state that exists today (Player-local progress sync is a later phase).
 */

export interface SeriesPriorityEntry {
  series_id: number
  season_from?: number
  season_to?: number
}

/** One entry in a slot's priority stack: a series, or a film pool. */
export interface SlotSource {
  type: 'series' | 'films'
  // series
  series_id?: number
  season_from?: number
  season_to?: number
  // films
  genres_any?: string[]
  year_from?: number
  year_to?: number
}

/**
 * A programmed slot inside a block (§15): an ordered source stack — the first
 * source that yields a playable, fitting item wins; exhausted sources fall
 * through (all Sopranos watched → Breaking Bad → Mad Men).
 */
export interface SlotDef {
  name?: string
  sources: SlotSource[]
  /** Items per occurrence from this slot (default 1). */
  count?: number
  /** Keep filling until the block window ends (final slot only). */
  fill?: boolean
}

export interface BlockRules {
  content_types?: Array<'film' | 'episode'>
  genres_any?: string[]
  max_runtime_minutes?: number
  min_runtime_minutes?: number
  exclude_aired_within_days?: number
  allow_repeats?: boolean
  library_ids?: number[]
  /** Films: release-year window (a decade is just from/to). */
  year_from?: number
  year_to?: number
  /** unwatched = skip watched items; watched = reruns only. Default any. */
  watched_filter?: 'unwatched' | 'any' | 'watched'
  /** Programmed slots — an ordered sequence, each with its own fallbacks. */
  slots?: SlotDef[]
  /** Legacy single-stack form; treated as one slot (see normalizeSlots). */
  series_priority?: SeriesPriorityEntry[]
  episodes_per_slot?: number
  fill_block?: boolean
}

/** Slot-mode configuration for a block, or null for rule-filled blocks. */
function normalizeSlots(rules: BlockRules): SlotDef[] | null {
  if (rules.slots?.length) {
    return rules.slots.filter(s => s.sources?.length)
  }
  if (rules.series_priority?.length) {
    return [{
      sources: rules.series_priority.map(e => ({ type: 'series' as const, ...e })),
      count: rules.episodes_per_slot,
      fill: rules.fill_block,
    }]
  }
  return null
}

export interface BlockRow {
  id: number
  channel_id: number
  name: string
  days_of_week: string
  start_minute: number
  end_minute: number
  rules: string
  priority: number
}

interface Candidate {
  itemType: 'film' | 'episode'
  itemId: number
  seriesId: number | null
  title: string
  genres: string[]
  runtimeMs: number
  addedAt: string | null
  lastAiredMs: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_MS = 60 * 1000
const DEFAULT_FILM_RUNTIME_MIN = 105
const DEFAULT_EPISODE_RUNTIME_MIN = 30
/** Don't schedule fragments shorter than this at the tail of a block. */
const MIN_FILL_MS = 10 * MIN_MS

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

/** Local-midnight timestamp for a given day offset from `fromMs`. */
function localMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Items completed through channel play sessions — the server's watch state. */
function watchedSet(db: BetterSqlite3.Database, itemType: 'film' | 'episode'): Set<number> {
  const rows = db.prepare(
    'SELECT DISTINCT item_id FROM play_session_items WHERE item_type = ? AND completed_at IS NOT NULL',
  ).all(itemType) as Array<{ item_id: number }>
  return new Set(rows.map(r => r.item_id))
}

function matchesWatched(filter: BlockRules['watched_filter'], watched: boolean): boolean {
  if (filter === 'unwatched') return !watched
  if (filter === 'watched') return watched
  return true
}

function filmCandidates(db: BetterSqlite3.Database, rules: BlockRules, watched: Set<number>): Candidate[] {
  const rows = db.prepare(`
    SELECT f.id, f.title, f.genres, f.runtime, f.added_at, f.library_id, f.year,
           (SELECT MAX(s.starts_at) FROM schedule_slots s WHERE s.item_type = 'film' AND s.item_id = f.id) AS last_aired
    FROM films f WHERE f.file_path IS NOT NULL
  `).all() as any[]
  return rows
    .filter(r => !rules.library_ids?.length || rules.library_ids.includes(r.library_id))
    .filter(r => !rules.year_from || (r.year && r.year >= rules.year_from))
    .filter(r => !rules.year_to || (r.year && r.year <= rules.year_to))
    .filter(r => matchesWatched(rules.watched_filter, watched.has(r.id)))
    .map(r => ({
      itemType: 'film' as const,
      itemId: r.id,
      seriesId: null,
      title: r.title,
      genres: parseJson<string[]>(r.genres, []),
      runtimeMs: (r.runtime || DEFAULT_FILM_RUNTIME_MIN) * MIN_MS,
      addedAt: r.added_at ?? null,
      lastAiredMs: r.last_aired ?? null,
    }))
}

interface EpisodeRow {
  id: number
  title: string | null
  runtime: number | null
  added_at: string | null
  season_number: number
  episode_number: number
  last_aired: number | null
}

function seriesEpisodes(db: BetterSqlite3.Database, seriesId: number, seasonFrom?: number, seasonTo?: number): EpisodeRow[] {
  return db.prepare(`
    SELECT e.id, e.title, e.runtime, e.added_at, e.season_number, e.episode_number,
           (SELECT MAX(sl.starts_at) FROM schedule_slots sl WHERE sl.item_type = 'episode' AND sl.item_id = e.id) AS last_aired
    FROM episodes e WHERE e.series_id = ? AND e.file_path IS NOT NULL
      ${seasonFrom != null ? 'AND e.season_number >= ?' : ''}
      ${seasonTo != null ? 'AND e.season_number <= ?' : ''}
    ORDER BY e.season_number, e.episode_number
  `).all(seriesId, ...(seasonFrom != null ? [seasonFrom] : []), ...(seasonTo != null ? [seasonTo] : [])) as EpisodeRow[]
}

function episodeToCandidate(seriesId: number, seriesTitle: string, seriesGenres: string[], seriesRuntime: number | null, e: EpisodeRow): Candidate {
  return {
    itemType: 'episode',
    itemId: e.id,
    seriesId,
    title: `${seriesTitle} S${e.season_number}E${e.episode_number}`,
    genres: seriesGenres,
    runtimeMs: (e.runtime || seriesRuntime || DEFAULT_EPISODE_RUNTIME_MIN) * MIN_MS,
    addedAt: e.added_at ?? null,
    lastAiredMs: e.last_aired ?? null,
  }
}

/**
 * Selects a series' next episode. `unwatched`: the first unwatched, unconsumed
 * episode in order (continue-the-show). `watched`/`any`: rotation — continue
 * after the most recently aired episode, wrapping when exhausted. Slots
 * inserted earlier in this pass are visible to the last-aired lookup (same
 * transaction), so the cursor advances as the window fills.
 */
function nextEpisode(
  eps: EpisodeRow[],
  filter: BlockRules['watched_filter'],
  watched: Set<number>,
  consumed: Set<number>,
): EpisodeRow | null {
  if (filter === 'unwatched') {
    return eps.find(e => !watched.has(e.id) && !consumed.has(e.id)) ?? null
  }
  const pool = filter === 'watched' ? eps.filter(e => watched.has(e.id)) : eps
  if (!pool.length) return null
  let lastIdx = -1
  let lastAiredMs = 0
  pool.forEach((e, i) => {
    if (e.last_aired && e.last_aired >= lastAiredMs) { lastAiredMs = e.last_aired; lastIdx = i }
  })
  return pool[(lastIdx + 1) % pool.length]
}

/** Rule-filled blocks: one candidate per series — its next episode. */
function episodeCandidates(
  db: BetterSqlite3.Database,
  rules: BlockRules,
  watched: Set<number>,
  consumed: Set<number>,
): Candidate[] {
  const seriesRows = db.prepare(`
    SELECT s.id, s.title, s.genres, s.runtime AS series_runtime, s.library_id
    FROM series s WHERE EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = s.id AND e.file_path IS NOT NULL)
  `).all() as any[]

  const out: Candidate[] = []
  for (const s of seriesRows) {
    if (rules.library_ids?.length && !rules.library_ids.includes(s.library_id)) continue
    const eps = seriesEpisodes(db, s.id)
    const next = nextEpisode(eps, rules.watched_filter, watched, consumed)
    if (!next) continue
    out.push(episodeToCandidate(s.id, s.title, parseJson<string[]>(s.genres, []), s.series_runtime, next))
  }
  return out
}

/**
 * Resolves a programmed slot (§15): walk its source stack in priority order;
 * the first source yielding a playable item that fits the remaining time wins.
 * Exhausted or non-fitting sources fall through to the next.
 */
function resolveSlotSources(
  db: BetterSqlite3.Database,
  sources: SlotSource[],
  blockRules: BlockRules,
  filter: BlockRules['watched_filter'],
  remainingMs: number,
  cursorMs: number,
  watchedFilms: Set<number>,
  watchedEpisodes: Set<number>,
  consumed: Set<number>,
  airedInPass: Array<{ itemType: string; itemId: number; atMs: number }>,
  random: () => number,
): Candidate | null {
  for (const source of sources) {
    if (source.type === 'series' && source.series_id) {
      const s = db.prepare('SELECT id, title, genres, runtime AS series_runtime FROM series WHERE id = ?').get(source.series_id) as any
      if (!s) continue
      const eps = seriesEpisodes(db, s.id, source.season_from, source.season_to)
      const next = nextEpisode(eps, filter, watchedEpisodes, consumed)
      if (!next) continue
      const cand = episodeToCandidate(s.id, s.title, parseJson<string[]>(s.genres, []), s.series_runtime, next)
      if (cand.runtimeMs > remainingMs) continue // doesn't fit — try the fallback
      return cand
    }
    if (source.type === 'films') {
      // A film pool: the source's own genre/year window over the block's base
      // rules, best-scored candidate that fits and hasn't aired this evening.
      const poolRules: BlockRules = {
        ...blockRules,
        watched_filter: filter,
        genres_any: source.genres_any?.length ? source.genres_any : blockRules.genres_any,
        year_from: source.year_from ?? blockRules.year_from,
        year_to: source.year_to ?? blockRules.year_to,
      }
      const pool = filmCandidates(db, poolRules, watchedFilms).filter(c => {
        if (poolRules.genres_any?.length && !c.genres.some(g => poolRules.genres_any!.includes(g))) return false
        if (c.runtimeMs > remainingMs) return false
        return !airedInPass.some(a => a.itemType === 'film' && a.itemId === c.itemId && cursorMs - a.atMs < 18 * 3600 * 1000)
      })
      // A fallback stack takes the best available film even at a negative
      // score (recently-aired penalty) — only hard rejects are excluded.
      let best: Candidate | null = null
      let bestScore = -Infinity
      for (const c of pool) {
        const sc = score(c, poolRules, remainingMs, cursorMs, random, () => false)
        if (sc > -Infinity && sc > bestScore) { best = c; bestScore = sc }
      }
      if (best) return best
    }
  }
  return null
}

/** Scoring per archivist-channels.md §27. Higher wins; < 0 is rejected. */
function score(c: Candidate, rules: BlockRules, remainingMs: number, nowMs: number, random: () => number,
  airedSeriesRecently: (seriesId: number | null) => boolean): number {
  let s = 0
  if (c.genres.some(g => rules.genres_any?.includes(g))) s += 30
  if (!c.lastAiredMs) s += 20 // never aired ≈ "unwatched" until watch-state sync lands
  if (c.addedAt && nowMs - Date.parse(c.addedAt) < 30 * DAY_MS) s += 15
  if (c.runtimeMs <= remainingMs && c.runtimeMs >= remainingMs * 0.55) s += 10 // clean fit

  const noRepeatDays = rules.exclude_aired_within_days ?? 7
  if (c.lastAiredMs && nowMs - c.lastAiredMs < noRepeatDays * DAY_MS) {
    if (rules.allow_repeats === false) return -Infinity // hard reject
    s -= 40
  }
  if (airedSeriesRecently(c.seriesId)) s -= 20

  return s + random() * 5 // seeded jitter breaks ties deterministically
}

export interface GeneratedSlot {
  blockId: number
  itemType: 'film' | 'episode'
  itemId: number
  startsAt: number
  endsAt: number
  sequence: number
}

/**
 * Generates schedule slots for one channel across [fromMs, fromMs + days).
 * Deletes non-locked future slots in the window first; fills each block
 * occurrence around surviving locked slots. Returns the number of slots created.
 */
export function generateSlate(
  db: BetterSqlite3.Database,
  channelId: number,
  fromMs: number,
  days: number,
): number {
  const channel = db.prepare('SELECT id, seed FROM channels WHERE id = ?').get(channelId) as any
  if (!channel) throw new Error(`Channel ${channelId} not found`)

  const blocks = (db.prepare(
    'SELECT * FROM programming_blocks WHERE channel_id = ? ORDER BY priority DESC, start_minute',
  ).all(channelId) as BlockRow[])
  if (!blocks.length) return 0

  const windowEnd = fromMs + days * DAY_MS

  // Clear regenerable slots in the window; keep locked ones as pinned obstacles.
  db.prepare(
    'DELETE FROM schedule_slots WHERE channel_id = ? AND starts_at >= ? AND starts_at < ? AND locked = 0',
  ).run(channelId, fromMs, windowEnd)
  const lockedSlots = db.prepare(
    'SELECT starts_at, ends_at FROM schedule_slots WHERE channel_id = ? AND ends_at > ? AND starts_at < ?',
  ).all(channelId, fromMs, windowEnd) as Array<{ starts_at: number; ends_at: number }>

  const random = rng((channel.seed || channelId * 2654435761) ^ Math.floor(fromMs / DAY_MS))
  const airedInPass: Array<{ seriesId: number | null; itemType: string; itemId: number; atMs: number }> = []
  const watchedFilms = watchedSet(db, 'film')
  const watchedEpisodes = watchedSet(db, 'episode')
  // Episodes placed this pass count as consumed so "next unwatched" advances
  // across occurrences within the window instead of repeating.
  const consumedEpisodes = new Set<number>()
  const insert = db.prepare(`
    INSERT INTO schedule_slots (channel_id, block_id, item_type, item_id, starts_at, ends_at, sequence, slot_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'programme', 'scheduled')
  `)

  let created = 0
  const startDay = localMidnight(fromMs)

  const run = db.transaction(() => {
    for (let d = 0; d < days + 1; d++) {
      const dayStart = startDay + d * DAY_MS
      const weekday = new Date(dayStart).getDay()

      for (const block of blocks) {
        const daysOfWeek = parseJson<number[]>(block.days_of_week, [])
        if (!daysOfWeek.includes(weekday)) continue

        const rules = parseJson<BlockRules>(block.rules, {})
        const blockStart = dayStart + block.start_minute * MIN_MS
        const blockEnd = dayStart + block.end_minute * MIN_MS
        if (blockEnd <= fromMs || blockStart >= windowEnd) continue

        const slotDefs = normalizeSlots(rules)
        // Programmed slots default to unwatched — that's what makes fallbacks trigger.
        const watchedFilter = rules.watched_filter ?? (slotDefs ? 'unwatched' : 'any')
        const effRules: BlockRules = { ...rules, watched_filter: watchedFilter }

        let cursor = Math.max(blockStart, fromMs)
        let sequence = 0
        const blockLimit = Math.min(blockEnd, windowEnd)

        /**
         * Places one item at the cursor if a provider yields one that fits the
         * current pin-free segment. Returns false when the block is out of
         * usable time or the provider is exhausted.
         */
        const placeOne = (provider: (remaining: number) => Candidate | null): boolean => {
          while (cursor < blockLimit) {
            const pinned = lockedSlots.find(l => cursor >= l.starts_at && cursor < l.ends_at)
            if (pinned) { cursor = pinned.ends_at; continue }
            const nextPin = lockedSlots
              .filter(l => l.starts_at >= cursor && l.starts_at < blockEnd)
              .sort((a, b) => a.starts_at - b.starts_at)[0]
            const segmentEnd = Math.min(nextPin ? nextPin.starts_at : blockEnd, windowEnd)
            const remaining = segmentEnd - cursor
            if (remaining < MIN_FILL_MS) { cursor = nextPin ? nextPin.ends_at : segmentEnd; continue }

            const best = provider(remaining)
            if (!best) return false

            insert.run(channelId, block.id, best.itemType, best.itemId, cursor, cursor + best.runtimeMs, sequence++)
            created++
            airedInPass.push({ seriesId: best.seriesId, itemType: best.itemType, itemId: best.itemId, atMs: cursor })
            if (best.itemType === 'episode') consumedEpisodes.add(best.itemId)
            cursor += best.runtimeMs
            return true
          }
          return false
        }

        if (slotDefs) {
          // Programmed sequence: each slot airs `count` items from its own
          // fallback stack, then hands over to the next slot.
          for (const slotDef of slotDefs) {
            let budget = slotDef.fill ? Infinity : Math.max(1, slotDef.count ?? 1)
            while (budget > 0 && cursor < blockLimit) {
              const ok = placeOne(remaining => resolveSlotSources(
                db, slotDef.sources, effRules, watchedFilter, remaining, cursor,
                watchedFilms, watchedEpisodes, consumedEpisodes, airedInPass, random,
              ))
              if (!ok) break // slot exhausted → move on to the next programmed slot
              budget--
            }
            if (cursor >= blockLimit) break
          }
        } else {
          // Rule-filled: score the whole matching pool until the window is full.
          const provider = (remaining: number): Candidate | null => {
            const types = rules.content_types?.length ? rules.content_types : (['film', 'episode'] as const)
            const pool: Candidate[] = [
              ...(types.includes('film') ? filmCandidates(db, effRules, watchedFilms) : []),
              ...(types.includes('episode') ? episodeCandidates(db, effRules, watchedEpisodes, consumedEpisodes) : []),
            ].filter(c => {
              if (rules.max_runtime_minutes && c.runtimeMs > rules.max_runtime_minutes * MIN_MS) return false
              if (rules.min_runtime_minutes && c.runtimeMs < rules.min_runtime_minutes * MIN_MS) return false
              if (rules.genres_any?.length && !c.genres.some(g => rules.genres_any!.includes(g))) return false
              return c.runtimeMs <= remaining
            })

            const airedSeriesRecently = (seriesId: number | null) =>
              seriesId != null && airedInPass.some(a => a.seriesId === seriesId && cursor - a.atMs < DAY_MS)

            let best: Candidate | null = null
            let bestScore = -Infinity
            for (const c of pool) {
              // Never the exact same item twice in one evening (repeats on later
              // days are governed by exclude_aired_within_days scoring).
              if (airedInPass.some(a => a.itemType === c.itemType && a.itemId === c.itemId && cursor - a.atMs < 18 * 3600 * 1000)) continue
              const sc = score(c, effRules, remaining, cursor, random, airedSeriesRecently)
              if (sc >= 0 && sc > bestScore) { best = c; bestScore = sc }
            }
            return best
          }
          while (placeOne(provider)) { /* fill until exhausted */ }
        }
      }
    }
  })
  run()

  return created
}
