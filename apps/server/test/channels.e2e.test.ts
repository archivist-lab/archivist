import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'

/**
 * Channels e2e: channel + block CRUD, scoring-scheduler slate generation,
 * guide reads, lock-aware regeneration, and playback sessions (watch from
 * here / play only / join live) per archivist-channels.md §33.
 */

let h: TestHarness
let channelId: number
let blockId: number
let firstSlots: any[] = []

const DAY_MS = 24 * 3600 * 1000

test('boot and seed a playable library', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()

  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series' LIMIT 1").get() as any).id

  const mediaDir = join(process.env.ARCHIVIST_MEDIA_BASE!, 'films')
  mkdirSync(mediaDir, { recursive: true })

  // Three playable films (~100 min) and one without a file.
  const films = [
    ['The Terminator', 1984, 107, '["Action","Science Fiction"]'],
    ['RoboCop', 1987, 102, '["Action","Science Fiction"]'],
    ['Escape from New York', 1981, 99, '["Action","Science Fiction"]'],
  ] as const
  for (const [title, year, runtime, genres] of films) {
    const file = join(mediaDir, `${title}.mkv`)
    writeFileSync(file, Buffer.alloc(1024, 1))
    db.prepare(`
      INSERT INTO films (library_id, title, sort_title, year, runtime, genres, status, file_path, file_size)
      VALUES (?, ?, ?, ?, ?, ?, 'collected', ?, 1024)
    `).run(filmsLib, title, title, year, runtime, genres, file)
  }
  db.prepare(`INSERT INTO films (library_id, title, sort_title, year, genres, status) VALUES (?, 'Unplayable', 'Unplayable', 2020, '["Action"]', 'wanted')`).run(filmsLib)

  // A series with five sequential playable episodes.
  const seriesId = db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, runtime, genres, status)
    VALUES (?, 'The Wire', 'The Wire', 2002, 58, '["Crime","Drama"]', 'ended')
  `).run(seriesLib).lastInsertRowid as number
  const seasonId = db.prepare('INSERT INTO seasons (series_id, season_number, episode_count) VALUES (?, 1, 5)').run(seriesId).lastInsertRowid as number
  const epDir = join(process.env.ARCHIVIST_MEDIA_BASE!, 'series')
  mkdirSync(epDir, { recursive: true })
  for (let n = 1; n <= 5; n++) {
    const file = join(epDir, `wire-s01e0${n}.mkv`)
    writeFileSync(file, Buffer.alloc(512, 2))
    db.prepare(`
      INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, runtime)
      VALUES (?, ?, 1, ?, ?, 'downloaded', ?, 58)
    `).run(seriesId, seasonId, n, `Episode ${n}`, file)
  }
})

after(async () => { await h?.close() })

test('create channel and programming block', async () => {
  const created = await h.request('POST', '/api/v1/channels', {
    body: { name: 'Friday Night Classics', description: 'Action classics', brandColor: '#FF2D78' },
  })
  assert.equal(created.status, 201)
  assert.equal(created.json.name, 'Friday Night Classics')
  assert.equal(created.json.number, 1)
  channelId = created.json.id

  // Duplicate number rejected.
  const dupe = await h.request('POST', '/api/v1/channels', { body: { name: 'Dupe', number: 1 } })
  assert.equal(dupe.status, 409)

  // Block: every day 20:00–02:00, action films only, no repeats within 2 days.
  const block = await h.request('POST', `/api/v1/channels/${channelId}/blocks`, {
    body: {
      name: 'Classics',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 20 * 60,
      endMinute: 26 * 60,
      rules: { content_types: ['film'], genres_any: ['Action'], exclude_aired_within_days: 2, allow_repeats: true },
    },
  })
  assert.equal(block.status, 201)
  blockId = block.json.id
  assert.deepEqual(block.json.daysOfWeek, [0, 1, 2, 3, 4, 5, 6])

  const list = await h.request('GET', '/api/v1/channels')
  assert.equal(list.json.channels.length, 1)
  assert.equal(list.json.channels[0].blockCount, 1)
})

test('generate slate creates film slots inside the block window', async () => {
  const gen = await h.request('POST', `/api/v1/channels/${channelId}/generate`, { body: { days: 2 } })
  assert.equal(gen.status, 200)
  assert.ok(gen.json.created >= 2, `expected slots, got ${gen.json.created}`)

  const guide = await h.request('GET', `/api/v1/channels/${channelId}/guide?from=${Date.now()}&to=${Date.now() + 2 * DAY_MS}`)
  firstSlots = guide.json.slots
  assert.ok(firstSlots.length >= 2)
  for (const slot of firstSlots) {
    assert.equal(slot.itemType, 'film')
    assert.ok(slot.hasFile, 'only playable items are scheduled')
    assert.ok(slot.streamUrl?.startsWith('/api/v1/player/stream/films/'))
    assert.ok(slot.endsAt > slot.startsAt)
    const startMin = new Date(slot.startsAt).getHours() * 60 + new Date(slot.startsAt).getMinutes()
    assert.ok(startMin >= 20 * 60 || startMin < 2 * 60, `slot starts within block window (got ${startMin})`)
  }
  // Back-to-back within a day: each slot starts when the previous ends.
  for (let i = 1; i < firstSlots.length; i++) {
    const gap = firstSlots[i].startsAt - firstSlots[i - 1].endsAt
    assert.ok(gap === 0 || gap > 30 * 60 * 1000, 'slots are contiguous or in a later block occurrence')
  }
  // No repeats within the same evening (back-to-back pairs). Repeats on later
  // days are allowed by design — score-penalized, not forbidden.
  for (let i = 1; i < firstSlots.length; i++) {
    if (firstSlots[i].startsAt === firstSlots[i - 1].endsAt) {
      assert.notEqual(firstSlots[i].itemId, firstSlots[i - 1].itemId, 'same film twice in one evening')
    }
  }
})

test('locked slots survive regeneration; unlocked are refilled', async () => {
  const target = firstSlots[0]
  const lock = await h.request('POST', `/api/v1/channels/slots/${target.id}/lock`)
  assert.equal(lock.status, 200)
  assert.equal(lock.json.locked, true)

  await h.request('POST', `/api/v1/channels/${channelId}/generate`, { body: { days: 2 } })
  const guide = await h.request('GET', `/api/v1/channels/${channelId}/guide?from=${Date.now()}&to=${Date.now() + 2 * DAY_MS}`)
  const stillThere = guide.json.slots.find((s: any) => s.id === target.id)
  assert.ok(stillThere, 'locked slot survives regeneration')
  assert.equal(stillThere.locked, true)
  firstSlots = guide.json.slots
})

test('episode block schedules sequential episodes', async () => {
  const ch = await h.request('POST', '/api/v1/channels', { body: { name: 'Wire Channel', number: 2 } })
  const wireChannel = ch.json.id
  await h.request('POST', `/api/v1/channels/${wireChannel}/blocks`, {
    body: {
      name: 'Prestige Hour',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 8 * 60,
      endMinute: 12 * 60,
      rules: { content_types: ['episode'] },
    },
  })
  await h.request('POST', `/api/v1/channels/${wireChannel}/generate`, { body: { days: 1 } })
  const guide = await h.request('GET', `/api/v1/channels/${wireChannel}/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 2 * DAY_MS}`)
  const eps = guide.json.slots.filter((s: any) => s.itemType === 'episode')
  assert.ok(eps.length >= 3, `expected episode slots, got ${eps.length}`)
  // Strictly sequential: E1, E2, E3 — no skips (regression: cursor double-advance).
  for (let i = 0; i < Math.min(eps.length, 3); i++) {
    assert.equal(eps[i].episodeNumber, i + 1, `slot ${i} airs episode ${i + 1}, got E${eps[i].episodeNumber}`)
  }
})

test('player contract lists channels with now/next', async () => {
  const res = await h.request('GET', '/api/v1/player/channels')
  assert.equal(res.status, 200)
  const channels = res.json.channels
  assert.equal(channels.length, 2)
  assert.equal(channels[0].number, 1)
  assert.ok('now' in channels[0] && 'next' in channels[0])

  const health = await h.request('GET', '/api/v1/player/health')
  assert.equal(health.json.capabilities.channels, true)
})

test('watch from here builds a queue from the selected slot onward', async () => {
  const start = firstSlots[0]
  const res = await h.request('POST', '/api/v1/player/play-sessions', {
    body: { channelId, startSlotId: start.id, mode: 'WATCH_FROM_HERE' },
  })
  assert.equal(res.status, 201)
  const session = res.json
  assert.equal(session.mode, 'WATCH_FROM_HERE')
  assert.ok(session.items.length >= 2, 'queue contains the slot and its followers')
  assert.equal(session.items[0].id, start.id)
  assert.equal(session.items[0].queuePosition, 1)
  assert.equal(session.items[0].startOffsetSeconds, 0)
  for (let i = 1; i < session.items.length; i++) {
    assert.ok(session.items[i].startsAt >= session.items[i - 1].startsAt, 'queue follows guide order')
  }

  // Auto-advance bookkeeping: completing item 1 stamps the slot watched.
  const done = await h.request('POST', `/api/v1/player/play-sessions/${session.sessionId}/items/1/complete`)
  assert.equal(done.status, 200)
  assert.equal(done.json.currentPosition, 2)
  assert.ok(done.json.items[0].completedAt)
  assert.equal(done.json.items[0].status, 'watched')

  const stop = await h.request('POST', `/api/v1/player/play-sessions/${session.sessionId}/stop`)
  assert.equal(stop.status, 204)
  const after = await h.request('GET', `/api/v1/player/play-sessions/${session.sessionId}`)
  assert.equal(after.json.status, 'ended')
})

test('play this only queues exactly one item', async () => {
  const res = await h.request('POST', '/api/v1/player/play-sessions', {
    body: { channelId, startSlotId: firstSlots[1].id, mode: 'PLAY_THIS_ONLY' },
  })
  assert.equal(res.status, 201)
  assert.equal(res.json.items.length, 1)
})

test('join live offsets into the currently airing item', async () => {
  // Fabricate a slot that started 10 minutes ago so "now" falls inside it.
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const film = db.prepare("SELECT id, runtime FROM films WHERE file_path IS NOT NULL LIMIT 1").get() as any
  const startedAt = Date.now() - 10 * 60 * 1000
  const slotId = db.prepare(`
    INSERT INTO schedule_slots (channel_id, item_type, item_id, starts_at, ends_at)
    VALUES (?, 'film', ?, ?, ?)
  `).run(channelId, film.id, startedAt, startedAt + film.runtime * 60 * 1000).lastInsertRowid as number

  const nowRes = await h.request('GET', `/api/v1/player/channels/${channelId}/now`)
  assert.ok(nowRes.json.now, 'channel has something on now')
  assert.equal(nowRes.json.now.id, slotId)
  assert.ok(nowRes.json.now.offsetSeconds >= 590 && nowRes.json.now.offsetSeconds <= 620)

  const res = await h.request('POST', '/api/v1/player/play-sessions', {
    body: { channelId, startSlotId: slotId, mode: 'JOIN_LIVE' },
  })
  assert.equal(res.status, 201)
  assert.ok(res.json.items[0].startOffsetSeconds >= 590, `joined ~10 min in (got ${res.json.items[0].startOffsetSeconds})`)
})

test('series stack falls back when the primary is fully watched', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series' LIMIT 1").get() as any).id
  const epDir = join(process.env.ARCHIVIST_MEDIA_BASE!, 'series')

  const mkSeries = (title: string, epCount: number) => {
    const sid = db.prepare(`INSERT INTO series (library_id, title, sort_title, runtime, genres) VALUES (?, ?, ?, 55, '["Drama"]')`)
      .run(seriesLib, title, title).lastInsertRowid as number
    const seasonId = db.prepare('INSERT INTO seasons (series_id, season_number, episode_count) VALUES (?, 1, ?)').run(sid, epCount).lastInsertRowid as number
    const epIds: number[] = []
    for (let n = 1; n <= epCount; n++) {
      const file = join(epDir, `${title.replace(/\s/g, '')}-e${n}.mkv`)
      writeFileSync(file, Buffer.alloc(256, 5))
      epIds.push(db.prepare(`
        INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, runtime)
        VALUES (?, ?, 1, ?, ?, 'downloaded', ?, 55)
      `).run(sid, seasonId, n, `E${n}`, file).lastInsertRowid as number)
    }
    return { sid, epIds }
  }

  const sopranos = mkSeries('The Sopranos', 2)
  const breakingBad = mkSeries('Breaking Bad', 3)

  // Mark every Sopranos episode watched via a completed play session.
  const sessionId = db.prepare("INSERT INTO play_sessions (mode, status) VALUES ('WATCH_FROM_HERE', 'ended')").run().lastInsertRowid as number
  sopranos.epIds.forEach((epId, i) => {
    db.prepare(`
      INSERT INTO play_session_items (session_id, item_type, item_id, queue_position, completed_at)
      VALUES (?, 'episode', ?, ?, datetime('now'))
    `).run(sessionId, epId, i + 1)
  })

  const ch = await h.request('POST', '/api/v1/channels', { body: { name: 'Prestige', number: 30 } })
  const prestige = ch.json.id
  const block = await h.request('POST', `/api/v1/channels/${prestige}/blocks`, {
    body: {
      name: 'Prestige Hour',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
      rules: {
        content_types: ['episode'],
        watched_filter: 'unwatched',
        series_priority: [
          { series_id: sopranos.sid },
          { series_id: breakingBad.sid },
        ],
        episodes_per_slot: 1,
      },
    },
  })
  assert.equal(block.status, 201)

  await h.request('POST', `/api/v1/channels/${prestige}/generate`, { body: { days: 3 } })
  const guide = await h.request('GET', `/api/v1/channels/${prestige}/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 4 * DAY_MS}`)
  const eps = guide.json.slots
  assert.ok(eps.length >= 2, `expected fallback slots, got ${eps.length}`)
  // Sopranos is fully watched → everything airs from Breaking Bad, in order.
  for (const s of eps) assert.equal(s.seriesTitle, 'Breaking Bad', `expected Breaking Bad, got ${s.seriesTitle}`)
  for (let i = 0; i < eps.length; i++) assert.equal(eps[i].episodeNumber, i + 1)
  // One episode per occurrence (episodes_per_slot = 1): distinct days.
  const days = new Set(eps.map((s: any) => new Date(s.startsAt).getDate()))
  assert.equal(days.size, eps.length, 'one episode per day')
})

test('episodes_per_slot airs a batch per occurrence', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const wire = db.prepare("SELECT id FROM series WHERE title = 'The Wire'").get() as any

  const ch = await h.request('POST', '/api/v1/channels', { body: { name: 'Wire Doubles', number: 31 } })
  await h.request('POST', `/api/v1/channels/${ch.json.id}/blocks`, {
    body: {
      name: 'Double Bill',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
      rules: {
        content_types: ['episode'],
        watched_filter: 'unwatched',
        series_priority: [{ series_id: wire.id }],
        episodes_per_slot: 2,
      },
    },
  })
  await h.request('POST', `/api/v1/channels/${ch.json.id}/generate`, { body: { days: 2 } })
  const guide = await h.request('GET', `/api/v1/channels/${ch.json.id}/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 3 * DAY_MS}`)
  const slots = guide.json.slots
  assert.ok(slots.length >= 2)
  // Today's occurrence may be truncated by midnight — assert on tomorrow's
  // complete occurrence: exactly two back-to-back sequential episodes.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const t0 = midnight.getTime() + DAY_MS
  const day = slots.filter((s: any) => s.startsAt >= t0 && s.startsAt < t0 + DAY_MS)
  assert.equal(day.length, 2, `two episodes per occurrence, got ${day.length}`)
  assert.equal(day[1].startsAt, day[0].endsAt, 'double bill is back-to-back')
  assert.equal(day[0].episodeNumber + 1, day[1].episodeNumber)
})

test('programmed slots: each slot resolves its own fallback stack in sequence', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const sopranos = db.prepare("SELECT id FROM series WHERE title = 'The Sopranos'").get() as any
  const breakingBad = db.prepare("SELECT id FROM series WHERE title = 'Breaking Bad'").get() as any
  const wire = db.prepare("SELECT id FROM series WHERE title = 'The Wire'").get() as any

  const ch = await h.request('POST', '/api/v1/channels', { body: { name: 'Prestige Night', number: 33 } })
  const block = await h.request('POST', `/api/v1/channels/${ch.json.id}/blocks`, {
    body: {
      name: 'Sunday Lineup',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
      rules: {
        content_types: ['episode'],
        watched_filter: 'unwatched',
        slots: [
          // Slot 1: Sopranos (fully watched) → falls back to Breaking Bad.
          { name: 'Slot A', sources: [{ type: 'series', series_id: sopranos.id }, { type: 'series', series_id: breakingBad.id }], count: 1 },
          // Slot 2: The Wire, two episodes back-to-back.
          { name: 'Slot B', sources: [{ type: 'series', series_id: wire.id }], count: 2 },
        ],
      },
    },
  })
  assert.equal(block.status, 201)

  await h.request('POST', `/api/v1/channels/${ch.json.id}/generate`, { body: { days: 2 } })
  const guide = await h.request('GET', `/api/v1/channels/${ch.json.id}/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 3 * DAY_MS}`)
  const slots = guide.json.slots
  assert.ok(slots.length >= 3, `expected slots, got ${slots.length}`)

  // Today's occurrence starts at "now" and may be truncated by midnight, so
  // assert against tomorrow's *complete* occurrence: Slot A resolved to
  // Breaking Bad (Sopranos is fully watched), then Wire ×2 back-to-back.
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
  const t0 = midnight.getTime() + DAY_MS
  const day = slots.filter((s: any) => s.startsAt >= t0 && s.startsAt < t0 + DAY_MS)
  assert.ok(day.length >= 3, `expected a full occurrence tomorrow, got ${day.length}`)
  assert.equal(day[0].seriesTitle, 'Breaking Bad', 'slot 1 fell back to Breaking Bad')
  assert.equal(day[1].seriesTitle, 'The Wire')
  assert.equal(day[2].seriesTitle, 'The Wire')
  assert.equal(day[1].startsAt, day[0].endsAt, 'slot 2 follows slot 1 immediately')
  assert.equal(day[2].startsAt, day[1].endsAt, 'Wire double bill is back-to-back')
  assert.equal(day[1].episodeNumber + 1, day[2].episodeNumber, 'Wire episodes sequential')
  assert.equal(day.length, 3, 'occurrence ends after the programmed slots')

  // Stacks continue across occurrences: every Breaking Bad and Wire airing is
  // strictly sequential over the whole window.
  const bySeriesEps = (title: string) => slots.filter((s: any) => s.seriesTitle === title).map((s: any) => s.episodeNumber)
  for (const title of ['Breaking Bad', 'The Wire']) {
    const eps = bySeriesEps(title)
    for (let i = 1; i < eps.length; i++) assert.equal(eps[i], eps[i - 1] + 1, `${title} advances sequentially`)
  }
  assert.ok(!slots.some((s: any) => s.seriesTitle === 'The Sopranos'), 'watched primary never airs')
})

test('programmed slots: film pool source with year window', async () => {
  const ch = await h.request('POST', '/api/v1/channels', { body: { name: 'Mixed Night', number: 34 } })
  await h.request('POST', `/api/v1/channels/${ch.json.id}/blocks`, {
    body: {
      name: 'Feature Slot',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
      rules: {
        watched_filter: 'any',
        slots: [
          { name: 'Feature', sources: [{ type: 'films', year_from: 1980, year_to: 1989 }], count: 1 },
        ],
      },
    },
  })
  await h.request('POST', `/api/v1/channels/${ch.json.id}/generate`, { body: { days: 1 } })
  const guide = await h.request('GET', `/api/v1/channels/${ch.json.id}/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 2 * DAY_MS}`)
  assert.ok(guide.json.slots.length >= 1, 'film slot filled')
  for (const s of guide.json.slots) {
    assert.equal(s.itemType, 'film')
    assert.ok(s.year >= 1980 && s.year <= 1989, `film year in window, got ${s.year}`)
  }
})

test('film year filter restricts candidates', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id
  const file = join(process.env.ARCHIVIST_MEDIA_BASE!, 'films', 'Modern Film.mkv')
  writeFileSync(file, Buffer.alloc(512, 9))
  db.prepare(`
    INSERT INTO films (library_id, title, sort_title, year, runtime, genres, status, file_path, file_size)
    VALUES (?, 'Modern Film', 'Modern Film', 2005, 95, '["Action"]', 'collected', ?, 512)
  `).run(filmsLib, file)

  const ch = await h.request('POST', '/api/v1/channels', { body: { name: 'Noughties', number: 32 } })
  await h.request('POST', `/api/v1/channels/${ch.json.id}/blocks`, {
    body: {
      name: '2000s Films',
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      startMinute: 0,
      endMinute: 1440,
      rules: { content_types: ['film'], year_from: 2000, year_to: 2009, exclude_aired_within_days: 0, allow_repeats: true },
    },
  })
  await h.request('POST', `/api/v1/channels/${ch.json.id}/generate`, { body: { days: 2 } })
  const guide = await h.request('GET', `/api/v1/channels/${ch.json.id}/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 3 * DAY_MS}`)
  assert.ok(guide.json.slots.length >= 1)
  for (const s of guide.json.slots) assert.equal(s.title, 'Modern Film', `80s film leaked into 2000s block: ${s.title}`)
})

test('channel deletion cascades', async () => {
  const del = await h.request('DELETE', `/api/v1/channels/${channelId}`)
  assert.equal(del.status, 204)
  const guide = await h.request('GET', `/api/v1/channels/guide?from=${Date.now() - DAY_MS}&to=${Date.now() + 2 * DAY_MS}`)
  assert.ok(!guide.json.slots.some((s: any) => s.channelId === channelId))
})
