import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'
import { applySchema } from '../../../packages/db/src/schema.js'

let h: TestHarness
let filmId: number
let seriesId: number
let episodeId: number
let filmFile: string

test('boot and seed a playable library', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  applySchema(db)

  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series' LIMIT 1").get() as any).id

  // A collected film with a real file on disk.
  const mediaDir = join(process.env.ARCHIVIST_MEDIA_BASE!, 'films', 'Alien (1979)')
  mkdirSync(mediaDir, { recursive: true })
  filmFile = join(mediaDir, 'Alien (1979).mkv')
  writeFileSync(filmFile, Buffer.alloc(2048, 7))
  filmId = db.prepare(`
    INSERT INTO films (library_id, tmdb_id, title, sort_title, year, overview, genres, status, file_path, file_size, runtime, poster_path)
    VALUES (?, 348, 'Alien', 'Alien', 1979, 'In space no one can hear you scream.', '["Horror","Science Fiction"]', 'collected', ?, 2048, 117, '/media/films/alien/poster.jpg')
  `).run(filmsLib, filmFile).lastInsertRowid as number

  // A wanted film with no file.
  db.prepare(`INSERT INTO films (library_id, title, sort_title, year, genres, status) VALUES (?, 'Missing Film', 'Missing Film', 2020, '[]', 'wanted')`).run(filmsLib)

  // A series with one downloaded and one missing episode.
  seriesId = db.prepare(`
    INSERT INTO series (library_id, title, sort_title, year, overview, genres, status)
    VALUES (?, 'Severance', 'Severance', 2022, 'Work-life balance, surgically.', '["Drama"]', 'continuing')
  `).run(seriesLib).lastInsertRowid as number
  const seasonId = db.prepare(`INSERT INTO seasons (series_id, season_number, episode_count) VALUES (?, 1, 2)`).run(seriesId).lastInsertRowid as number
  const epFile = join(process.env.ARCHIVIST_MEDIA_BASE!, 'series', 'ep1.mkv')
  mkdirSync(join(process.env.ARCHIVIST_MEDIA_BASE!, 'series'), { recursive: true })
  writeFileSync(epFile, Buffer.alloc(1024, 3))
  episodeId = db.prepare(`
    INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, runtime)
    VALUES (?, ?, 1, 1, 'Good News About Hell', 'downloaded', ?, 56)
  `).run(seriesId, seasonId, epFile).lastInsertRowid as number
  db.prepare(`
    INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status)
    VALUES (?, ?, 1, 2, 'Half Loop', 'missing')
  `).run(seriesId, seasonId)
})

after(async () => { await h?.close() })

test('health reports capabilities', async () => {
  const res = await h.request('GET', '/api/v1/player/health')
  assert.equal(res.status, 200)
  assert.equal(res.json.status, 'ok')
  assert.equal(res.json.capabilities.films, true)
  assert.equal(res.json.capabilities.transcoding, true)
  assert.equal(res.json.capabilities.channels, true)
  assert.equal(res.json.capabilities.librarySync, true)
})

test('libraries returns consumer shape with counts', async () => {
  const res = await h.request('GET', '/api/v1/player/libraries')
  assert.equal(res.status, 200)
  const films = res.json.libraries.find((l: any) => l.mediaType === 'films')
  assert.equal(films.itemCount, 2)
  assert.equal(films.availableCount, 1)
})

test('films list: consumer fields, no file paths leaked', async () => {
  const res = await h.request('GET', '/api/v1/player/films')
  assert.equal(res.status, 200)
  assert.equal(res.json.films.length, 2)
  const alien = res.json.films.find((f: any) => f.title === 'Alien')
  assert.equal(alien.hasFile, true)
  assert.equal(alien.status, 'available')
  assert.equal(alien.playback.streamUrl, `/api/v1/player/stream/films/${filmId}`)
  assert.ok(!JSON.stringify(res.json).includes(process.env.ARCHIVIST_MEDIA_BASE!), 'no absolute paths in payload')
  const missing = res.json.films.find((f: any) => f.title === 'Missing Film')
  assert.equal(missing.hasFile, false)
  assert.equal(missing.playback, null)
})

test('film detail includes full metadata', async () => {
  const res = await h.request('GET', `/api/v1/player/films/${filmId}`)
  assert.equal(res.status, 200)
  assert.equal(res.json.year, 1979)
  assert.deepEqual(res.json.genres, ['Horror', 'Science Fiction'])
  assert.equal(res.json.runtimeSeconds, 117 * 60)
  assert.ok(!('file_path' in res.json))
})

test('series list and detail with seasons/episodes', async () => {
  const list = await h.request('GET', '/api/v1/player/series')
  assert.equal(list.json.series.length, 1)
  assert.equal(list.json.series[0].episodeCount, 2)
  assert.equal(list.json.series[0].availableEpisodeCount, 1)

  const detail = await h.request('GET', `/api/v1/player/series/${seriesId}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.json.seasons.length, 1)
  assert.equal(detail.json.seasons[0].episodes.length, 1)
  assert.equal(detail.json.seasons[0].episodes[0].hasFile, true)
  assert.equal(detail.json.nextAvailable.id, episodeId)
  assert.ok(!JSON.stringify(detail.json).includes(process.env.ARCHIVIST_MEDIA_BASE!))
})

test('sync manifest is authoritative, profile-aware, and does not leak file paths', async () => {
  await h.request('POST', '/api/v1/player/progress', {
    body: { type: 'film', id: filmId, profileId: 'kodi', positionSeconds: 240, durationSeconds: 7020, completed: false },
  })
  await h.request('PUT', `/api/v1/player/ratings/film/${filmId}`, { body: { value: 5, profileId: 'kodi' } })
  await h.request('PUT', `/api/v1/player/ratings/series/${seriesId}`, { body: { value: 4, profileId: 'kodi' } })
  const res = await h.request('GET', '/api/v1/player/sync/manifest?profile=kodi')
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.json.schemaVersion, 1)
  assert.equal(res.json.profileId, 'kodi')
  assert.match(res.json.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual(res.json.films.map((film: any) => film.title), ['Alien'])
  assert.equal(res.json.films[0].progress.positionSeconds, 240)
  assert.equal(res.json.films[0].userRating, 10)
  assert.deepEqual(res.json.series[0].seasons[0].episodes.map((episode: any) => episode.title), ['Good News About Hell'])
  assert.equal(res.json.series[0].seasons[0].episodes[0].userRating, null, 'inherited series ratings must not materialise in Kodi')
  assert.ok(!JSON.stringify(res.json).includes(process.env.ARCHIVIST_MEDIA_BASE!))
})

test('sync change feed advances after a library mutation', async () => {
  const initial = await h.request('GET', '/api/v1/player/sync/changes?cursor=0&wait=0')
  assert.equal(initial.status, 200)
  const cursor = initial.json.cursor
  const quiet = await h.request('GET', `/api/v1/player/sync/changes?cursor=${cursor}&wait=0`)
  assert.equal(quiet.json.changed, false)

  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE films SET overview = 'Updated for Kodi' WHERE id = ?").run(filmId)
  const changed = await h.request('GET', `/api/v1/player/sync/changes?cursor=${cursor}&wait=0`)
  assert.equal(changed.status, 200)
  assert.equal(changed.json.changed, true)
  assert.ok(changed.json.cursor > cursor)
  assert.ok(changed.json.changes.some((item: any) => item.mediaType === 'film' && item.mediaId === Number(filmId)))
})

test('episode detail', async () => {
  await h.request('POST', '/api/v1/player/progress', {
    body: { type: 'episode', id: episodeId, profileId: 'kodi', positionSeconds: 120, durationSeconds: 3360, completed: false },
  })
  const res = await h.request('GET', `/api/v1/player/episodes/${episodeId}?profile=kodi`)
  assert.equal(res.status, 200)
  assert.equal(res.json.seriesTitle, 'Severance')
  assert.equal(res.json.playback.streamUrl, `/api/v1/player/stream/episodes/${episodeId}`)
  assert.equal(res.json.progress.positionSeconds, 120)
  assert.equal(res.json.progress.durationSeconds, 3360)
})

test('search returns mixed films and series', async () => {
  const res = await h.request('GET', '/api/v1/player/search?q=e')
  const types = new Set(res.json.results.map((r: any) => r.type))
  assert.ok(types.has('film'))
  assert.ok(types.has('series'))
})

test('home rails include the collected film and episode', async () => {
  const res = await h.request('GET', '/api/v1/player/home')
  assert.equal(res.status, 200)
  assert.equal(res.json.rails.recentFilms.length, 1)
  assert.equal(res.json.rails.recentEpisodes.length, 1)
})

test('series shelves split next-up, recent arrivals, and recent airings', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seasonId = db.prepare('SELECT id FROM seasons WHERE series_id = ? LIMIT 1').get(seriesId) as { id: number }
  const file = join(process.env.ARCHIVIST_MEDIA_BASE!, 'series', 'ep1.mkv')
  // Two more available episodes: one that aired this week, one from years back
  // that only just landed.
  const fresh = db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, air_date, updated_at)
    VALUES (?, ?, 2, 1, 'Just Aired', 'downloaded', ?, date('now', '-4 days'), datetime('now'))`).run(seriesId, seasonId.id, file).lastInsertRowid as number
  const backfill = db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, air_date, updated_at)
    VALUES (?, ?, 2, 2, 'Old Arrival', 'downloaded', ?, date('now', '-800 days'), datetime('now'))`).run(seriesId, seasonId.id, file).lastInsertRowid as number
  // An episode that aired long ago and landed long ago belongs to neither row.
  db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, air_date, updated_at)
    VALUES (?, ?, 2, 3, 'Long Settled', 'downloaded', ?, date('now', '-900 days'), datetime('now', '-700 days'))`).run(seriesId, seasonId.id, file)

  const rowsOf = (response: any) => Object.fromEntries(response.json.rows.map((r: any) => [r.id, r.items.map((i: any) => i.title)]))
  const idle = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=shelfy'))
  // Next Up is for series you have started; an untouched library offers none.
  assert.deepEqual(idle['series-next-up'], [])
  assert.deepEqual(idle['series-recently-aired'], ['Just Aired'])
  // An episode with no air date is still an arrival — the same way a film with
  // no release date counts as added rather than released. Both land here, and
  // their timestamps share a second, so order between them is not meaningful.
  assert.deepEqual(idle['series-recently-added'].sort(), ['Good News About Hell', 'Old Arrival'])

  // Finish the first episode; the next unfinished one becomes Next Up.
  await h.request('POST', '/api/v1/player/progress', {
    body: { type: 'episode', id: episodeId, profileId: 'shelfy', positionSeconds: 3300, durationSeconds: 3360, completed: true },
  })
  const started = await h.request('GET', '/api/v1/player/series-shelves?profile=shelfy')
  const nextUp = started.json.rows.find((r: any) => r.id === 'series-next-up')
  assert.deepEqual(nextUp.items.map((e: any) => e.title), ['Just Aired'])
  assert.equal(nextUp.items[0].seriesTitle, 'Severance')
  assert.equal(nextUp.items.length, 1, 'one entry per series, not one per episode')
  void backfill; void fresh
})

test('player row settings drive the series shelves and survive a round trip', async () => {
  const rowsOf = (response: any) => Object.fromEntries(response.json.rows.map((r: any) => [r.id, r.items.map((i: any) => i.title)]))
  const defaults = await h.request('GET', '/api/v1/system/player-shelves/settings')
  assert.equal(defaults.status, 200)
  assert.deepEqual(
    defaults.json.settings.films.rows.map((r: any) => r.id),
    ['films-recently-added', 'films-recently-released', 'films-all'],
  )
  const exposed = await h.request('GET', '/api/v1/player/shelf-settings')
  assert.deepEqual(exposed.json.settings, defaults.json.settings)

  const next = structuredClone(defaults.json.settings)
  const series = next.series
  series.label = 'Television'
  series.rows = [series.rows[2], series.rows[1], series.rows[0], series.rows[3]]
  series.rows.find((r: any) => r.id === 'series-recently-aired').windowDays = 3
  series.rows.find((r: any) => r.id === 'series-recently-added').limit = 1
  const saved = await h.request('PUT', '/api/v1/system/player-shelves/settings', { body: next })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.settings.series.label, 'Television')
  assert.deepEqual(
    saved.json.settings.series.rows.map((r: any) => r.id),
    ['series-recently-aired', 'series-recently-added', 'series-next-up', 'series-all'],
  )

  // The aired window is now 3 days, so the episode that aired 4 days ago drops out.
  const narrowed = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=shelfy'))
  assert.deepEqual(narrowed['series-recently-aired'], [])
  assert.equal(narrowed['series-recently-added'].length, 1, 'limit of 1 is applied')

  // Dedupe is what keeps a fresh airing out of the arrivals row; drop the
  // reference and the same episode fills both.
  const overlapping = structuredClone(saved.json.settings)
  const added = overlapping.series.rows.find((r: any) => r.id === 'series-recently-added')
  added.dedupeAgainst = []
  added.limit = 20
  overlapping.series.rows.find((r: any) => r.id === 'series-recently-aired').windowDays = 90
  await h.request('PUT', '/api/v1/system/player-shelves/settings', { body: overlapping })
  const both = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=shelfy'))
  assert.ok(both['series-recently-aired'].includes('Just Aired'))
  assert.ok(both['series-recently-added'].includes('Just Aired'), 'no dedupe lets one episode fill both rows')

  // Out-of-range values clamp, unknown sources and sorts fall back, and a
  // dedupe reference to a row that does not exist is dropped.
  const hostile = structuredClone(overlapping)
  hostile.series.rows[0].limit = 9999
  hostile.series.rows[0].windowDays = -5
  hostile.series.rows[0].sort = 'not-a-sort'
  hostile.series.rows[0].source = 'films'
  hostile.series.rows[0].dedupeAgainst = ['ghost-row']
  hostile.series.rows[0].minRating = 99
  const clamped = await h.request('PUT', '/api/v1/system/player-shelves/settings', { body: hostile })
  const first = clamped.json.settings.series.rows[0]
  assert.equal(first.limit, 100)
  assert.equal(first.windowDays, 1)
  assert.equal(first.sort, 'added')
  assert.equal(first.source, 'episodes', 'a films source is not valid under the series type')
  assert.deepEqual(first.dedupeAgainst, [])
  assert.equal(first.minRating, 10)

  const restored = await h.request('POST', '/api/v1/system/player-shelves/reset')
  assert.deepEqual(restored.json.settings, defaults.json.settings)
})

test('operators can add their own rows, and the player runs them', async () => {
  const rowsOf = (response: any) => Object.fromEntries(response.json.rows.map((r: any) => [r.id, r.items.map((i: any) => i.title)]))
  const current = (await h.request('GET', '/api/v1/system/player-shelves/settings')).json.settings
  const next = structuredClone(current)
  // A row nothing ships with: every available series episode, oldest first.
  next.series.rows.push({
    id: 'my-oldest', source: 'episodes', label: 'From the Start', enabled: true,
    windowField: 'none', windowDays: 90, watchState: 'all', genres: [],
    minRating: null, yearFrom: null, yearTo: null, sort: 'title', sortOrder: 'asc',
    limit: 3, view: 'landscape', dedupeAgainst: [],
  })
  // Two rows asking for the same id must not collide.
  next.series.rows.push({ ...next.series.rows.at(-1), label: 'Clash' })
  const saved = await h.request('PUT', '/api/v1/system/player-shelves/settings', { body: next })
  const ids = saved.json.settings.series.rows.map((r: any) => r.id)
  assert.ok(ids.includes('my-oldest'))
  assert.equal(new Set(ids).size, ids.length, 'a duplicate id is renamed rather than shadowing')

  const resolved = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=shelfy'))
  assert.equal(resolved['my-oldest'].length, 3, 'the added row runs and honours its cap')

  // A genre filter no episode matches empties the row rather than erroring.
  const filtered = structuredClone(saved.json.settings)
  filtered.series.rows.find((r: any) => r.id === 'my-oldest').genres = ['Nonexistent Genre']
  await h.request('PUT', '/api/v1/system/player-shelves/settings', { body: filtered })
  const empty = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=shelfy'))
  assert.deepEqual(empty['my-oldest'], [])

  await h.request('POST', '/api/v1/system/player-shelves/reset')
})

test('a part-watched row can sort by when each item was last played', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const seriesLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'series' LIMIT 1").get() as any).id
  const episodeFile = (db.prepare('SELECT file_path FROM episodes WHERE id = ?').get(episodeId) as any).file_path

  // A second series, so the series-source ordering has two things to order.
  const otherSeries = db.prepare(`INSERT INTO series (library_id, title, sort_title, year, genres, status)
    VALUES (?, 'Andor', 'Andor', 2022, '["Drama"]', 'continuing')`).run(seriesLib).lastInsertRowid as number
  const otherSeason = db.prepare('INSERT INTO seasons (series_id, season_number, episode_count) VALUES (?, 1, 1)').run(otherSeries).lastInsertRowid as number
  const otherEpisode = db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, runtime)
    VALUES (?, ?, 1, 1, 'Kassa', 'downloaded', ?, 45)`).run(otherSeries, otherSeason, episodeFile).lastInsertRowid as number
  const stalled = db.prepare("SELECT id FROM episodes WHERE title = 'Just Aired'").get() as { id: number }
  const finished = db.prepare("SELECT id FROM episodes WHERE title = 'Old Arrival'").get() as { id: number }

  // Written straight to the table so each position carries a time of its own;
  // three writes through the API would share a second and order nothing.
  const progress = db.prepare(`INSERT OR REPLACE INTO playback_progress
    (profile_id, media_type, media_id, position_seconds, duration_seconds, completed, updated_at)
    VALUES ('resumer', 'episode', ?, ?, 3600, ?, ?)`)
  progress.run(episodeId, 900, 0, '2026-03-01 20:00:00')
  progress.run(stalled.id, 600, 0, '2026-03-04 21:30:00')
  // Finished, so it is not part-watched however recently it was played.
  progress.run(finished.id, 3600, 1, '2026-03-09 22:00:00')
  progress.run(otherEpisode, 300, 0, '2026-03-02 19:00:00')

  const shelves = (await h.request('GET', '/api/v1/system/player-shelves/settings')).json.settings
  const next = structuredClone(shelves)
  const base = {
    enabled: true, windowField: 'none', windowDays: 90, watchState: 'in-progress', genres: [],
    minRating: null, yearFrom: null, yearTo: null, sort: 'last-played', sortOrder: 'desc',
    limit: 10, view: 'landscape', dedupeAgainst: [],
  }
  next.series.rows.push({ ...base, id: 'resume-episodes', source: 'episodes', label: 'Carry On' })
  next.series.rows.push({ ...base, id: 'resume-episodes-oldest', source: 'episodes', label: 'Longest Left', sortOrder: 'asc' })
  next.series.rows.push({ ...base, id: 'resume-series', source: 'series', label: 'Shows In Play', view: 'poster' })
  const saved = await h.request('PUT', '/api/v1/system/player-shelves/settings', { body: next })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.settings.series.rows.find((r: any) => r.id === 'resume-episodes').sort, 'last-played',
    'last-played survives validation rather than falling back to added')

  const rowsOf = (response: any) => Object.fromEntries(response.json.rows.map((r: any) => [r.id, r.items.map((i: any) => i.title)]))
  const resolved = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=resumer'))
  // Most recently left off first, and the finished episode is not in the row.
  assert.deepEqual(resolved['resume-episodes'], ['Just Aired', 'Kassa', 'Good News About Hell'])
  assert.deepEqual(resolved['resume-episodes-oldest'], ['Good News About Hell', 'Kassa', 'Just Aired'])
  // A series is sorted by the most recent progress across its episodes, so
  // Severance's 9 March position outranks Andor's 2 March one.
  assert.deepEqual(resolved['resume-series'], ['Severance', 'Andor'])

  // Another viewer has played none of it, so the same rows come back empty.
  const stranger = rowsOf(await h.request('GET', '/api/v1/player/series-shelves?profile=stranger'))
  assert.deepEqual(stranger['resume-episodes'], [])

  db.prepare("DELETE FROM playback_progress WHERE profile_id = 'resumer'").run()
  db.prepare('DELETE FROM episodes WHERE series_id = ?').run(otherSeries)
  db.prepare('DELETE FROM seasons WHERE series_id = ?').run(otherSeries)
  db.prepare('DELETE FROM series WHERE id = ?').run(otherSeries)
  await h.request('POST', '/api/v1/system/player-shelves/reset')
})

test('box sets resolve from one varied value, and respect their season', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const library = db.prepare("SELECT id FROM libraries WHERE media_type = 'films' ORDER BY id LIMIT 1").get() as { id: number }
  const film = db.prepare(`INSERT INTO films (library_id, title, sort_title, year, genres, status, file_path, release_date)
    VALUES (?, ?, ?, ?, ?, 'collected', '/fixture/boxset.mkv', ?)`)
  const kubrick = film.run(library.id, 'The Shining', 'Shining', 1980, '["Horror"]', '1980-05-23').lastInsertRowid as number
  const other = film.run(library.id, 'Unrelated Film', 'Unrelated Film', 1999, '["Drama"]', '1999-01-01').lastInsertRowid as number
  const person = db.prepare("INSERT INTO people (name, normalized_name) VALUES ('Stanley Kubrick', 'stanley kubrick')").run().lastInsertRowid as number
  db.prepare(`INSERT INTO media_credits (media_type, media_id, person_id, credit_type, role, is_starring)
    VALUES ('film', ?, ?, 'crew', 'director', 1)`).run(kubrick, person)

  const defaults = await h.request('GET', '/api/v1/system/player-box-sets/settings')
  assert.equal(defaults.status, 200)
  // Nothing ships enabled with values: a shipped director would be an empty row.
  assert.ok(defaults.json.settings.templates.every((t: any) => t.sets.length === 0))

  // The picker offers what the library actually has, with counts.
  const values = await h.request('GET', '/api/v1/system/player-box-sets/values?mediaType=films&field=director')
  assert.deepEqual(values.json.values, [{ value: 'Stanley Kubrick', count: 1 }])

  const next = structuredClone(defaults.json.settings)
  const directors = next.templates.find((t: any) => t.field === 'director')
  directors.sets = [{ id: 'kubrick', value: 'Stanley Kubrick', label: null, enabled: true, season: null, imageUrl: null, overview: null }]
  const saved = await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: next })
  assert.equal(saved.status, 200)

  const rows = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  // A theme is one tile; its sets sit behind it rather than as sibling rows.
  const theme = rows.json.themes.find((t: any) => t.id === 'boxset-directed-by')
  assert.ok(theme, 'the enabled template becomes a theme tile')
  assert.equal(theme.label, 'Directed By')
  assert.equal(theme.view, 'landscape')
  const boxSet = theme.sets.find((entry: any) => entry.label === 'Directed by Stanley Kubrick')
  assert.ok(boxSet, 'the template pattern names the set')
  assert.deepEqual(boxSet.items.map((i: any) => i.title), ['The Shining'])
  assert.ok(!boxSet.items.some((i: any) => i.id === other), 'the filter excludes everything else')

  // A season the year is not currently inside takes the row away entirely.
  const today = new Date()
  const offset = (days: number) => {
    const date = new Date(today.getTime() + days * 86_400_000)
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }
  const seasonal = structuredClone(saved.json.settings)
  seasonal.templates.find((t: any) => t.field === 'director').sets[0].season = { from: offset(40), to: offset(80) }
  await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: seasonal })
  const outOfSeason = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  // With its only set out of season the theme has nothing behind it, so the
  // tile goes too rather than opening onto an empty screen.
  assert.ok(!outOfSeason.json.themes.some((t: any) => t.id === 'boxset-directed-by'), 'out of season the theme is not offered')

  // A window spanning today shows it again, including one that wraps new year.
  const inSeason = structuredClone(saved.json.settings)
  inSeason.templates.find((t: any) => t.field === 'director').sets[0].season = { from: offset(-5), to: offset(5) }
  await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: inSeason })
  const shown = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  assert.ok(shown.json.themes.some((t: any) => t.sets.some((entry: any) => entry.label.includes('Kubrick'))))

  // A set with no value would match the library, so it is dropped on write.
  const blank = structuredClone(saved.json.settings)
  blank.templates.find((t: any) => t.field === 'director').sets.push({ id: 'blank', value: '   ', label: null, enabled: true, season: null, imageUrl: null, overview: null })
  const cleaned = await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: blank })
  assert.equal(cleaned.json.settings.templates.find((t: any) => t.field === 'director').sets.length, 1)

  // A heading with no placeholder still distinguishes its sets.
  const patternless = structuredClone(saved.json.settings)
  patternless.templates.find((t: any) => t.field === 'director').labelPattern = 'Directed by'
  const patched = await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: patternless })
  assert.equal(patched.json.settings.templates.find((t: any) => t.field === 'director').labelPattern, 'Directed by {value}')

  await h.request('POST', '/api/v1/system/player-box-sets/reset')
  db.prepare('DELETE FROM films WHERE id IN (?, ?)').run(kubrick, other)
})

test('a list published in the library becomes a box set in the player', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const library = db.prepare("SELECT id FROM libraries WHERE media_type = 'films' ORDER BY id LIMIT 1").get() as { id: number }
  const film = db.prepare(`INSERT INTO films (library_id, tmdb_id, title, sort_title, year, genres, status, file_path, release_date)
    VALUES (?, ?, ?, ?, ?, ?, 'collected', '/fixture/list-boxset.mkv', ?)`)
  const held = film.run(library.id, 9001, 'Solaris', 'Solaris', 1972, '["Science Fiction"]', '1972-03-20').lastInsertRowid as number
  const outside = film.run(library.id, 9002, 'Not On The List', 'Not On The List', 2001, '[]', '2001-01-01').lastInsertRowid as number

  const list = db.prepare(`INSERT INTO lists (library_id, name, description, image_url, overview, player_box_set, media_type, filter)
    VALUES (?, 'Slow Cinema', 'Operator note', '/media/lists/slow.jpg', 'Films that take their time.', 1, 'film', '{"op":"year","min":1960}')`)
    .run(library.id).lastInsertRowid as number
  const item = db.prepare(`INSERT INTO list_items (list_id, media_type, tmdb_id, title, year, status, library_item_id)
    VALUES (?, 'film', ?, ?, ?, ?, ?)`)
  item.run(list, 9001, 'Solaris', 1972, 'in_library', held)
  // A match not yet in the library is not playable, so it must not appear.
  item.run(list, 9003, 'Still Wanted', 1975, 'new', null)

  const rows = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  const theme = rows.json.themes.find((entry: any) => entry.id === 'boxset-film-lists')
  assert.ok(theme, 'the shipped list template resolves once a list is published')
  const set = theme.sets.find((entry: any) => entry.label === 'Slow Cinema')
  assert.ok(set, 'the set is named after the list')
  assert.equal(set.imageUrl, '/media/lists/slow.jpg', 'artwork comes from the list, not the first item')
  assert.equal(set.overview, 'Films that take their time.')
  assert.deepEqual(set.items.map((entry: any) => entry.title), ['Solaris'])
  assert.ok(!set.items.some((entry: any) => entry.id === outside), 'titles outside the list stay out')

  // Tile shape is per type, so the Player is told which to draw.
  assert.equal(theme.view, 'landscape', 'the shipped list type draws landscape tiles')
  const settings = (await h.request('GET', '/api/v1/system/player-box-sets/settings')).json.settings
  settings.templates.find((entry: any) => entry.id === 'film-lists').view = 'poster'
  await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: settings })
  const posters = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  assert.equal(posters.json.themes.find((entry: any) => entry.id === 'boxset-film-lists').view, 'poster')

  // Unpublishing takes the set away without touching the list itself.
  db.prepare('UPDATE lists SET player_box_set = 0 WHERE id = ?').run(list)
  const withdrawn = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  assert.ok(!withdrawn.json.themes.some((entry: any) => entry.id === 'boxset-film-lists'), 'an unpublished list leaves no empty tile')

  // A paused list is not maintained, so it is not offered either.
  db.prepare('UPDATE lists SET player_box_set = 1, enabled = 0 WHERE id = ?').run(list)
  const paused = await h.request('GET', '/api/v1/player/box-sets?profile=default')
  assert.ok(!paused.json.themes.some((entry: any) => entry.id === 'boxset-film-lists'), 'a paused list is not published')

  await h.request('POST', '/api/v1/system/player-box-sets/reset')
  db.prepare('DELETE FROM lists WHERE id = ?').run(list)
  db.prepare('DELETE FROM films WHERE id IN (?, ?)').run(held, outside)
})

test('each list appears under its own box set type, whole, in release order', async () => {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const library = db.prepare("SELECT id FROM libraries WHERE media_type = 'films' ORDER BY id LIMIT 1").get() as { id: number }
  const film = db.prepare(`INSERT INTO films (library_id, tmdb_id, title, sort_title, year, genres, status, file_path, release_date, digital_release_date)
    VALUES (?, ?, ?, ?, ?, '[]', 'collected', ?, ?, ?)`)
  const films: number[] = []
  // Twenty films, more than a template's row limit, released a year apart. The
  // oldest has a recent digital release, which must not move it.
  for (let n = 0; n < 20; n++) {
    films.push(film.run(library.id, 9100 + n, `Studio Film ${n}`, `Studio Film ${n}`, 2000 + n, `/fixture/studio-${n}.mkv`,
      `${2000 + n}-05-01`, n === 0 ? '2024-01-01' : null).lastInsertRowid as number)
  }
  const directorFilm = film.run(library.id, 9200, 'A Director Film', 'A Director Film', 1999, '/fixture/director.mkv', '1999-01-01', null).lastInsertRowid as number
  const list = db.prepare(`INSERT INTO lists (library_id, name, player_box_set, media_type, filter, box_set_template_id)
    VALUES (?, ?, 1, 'film', '{}', ?)`)
  const studio = list.run(library.id, 'Big Studio', 'from-studio').lastInsertRowid as number
  const director = list.run(library.id, 'Directed By Someone', 'directed-by').lastInsertRowid as number
  const item = db.prepare(`INSERT INTO list_items (list_id, media_type, tmdb_id, title, year, status) VALUES (?, 'film', ?, 'x', 2000, 'added')`)
  for (let n = 0; n < 20; n++) item.run(studio, 9100 + n)
  item.run(director, 9200)

  // Both types read from lists, as an operator sets them up to.
  const settings = (await h.request('GET', '/api/v1/system/player-box-sets/settings')).json.settings
  for (const id of ['from-studio', 'directed-by']) {
    const template = settings.templates.find((entry: any) => entry.id === id)
    Object.assign(template, { source: 'lists', sort: 'released', sortOrder: 'asc', limit: 18 })
  }
  await h.request('PUT', '/api/v1/system/player-box-sets/settings', { body: settings })

  const themes = (await h.request('GET', '/api/v1/player/box-sets?profile=default')).json.themes
  const studioTheme = themes.find((entry: any) => entry.id === 'boxset-from-studio')
  const directorTheme = themes.find((entry: any) => entry.id === 'boxset-directed-by')
  assert.deepEqual(studioTheme.sets.map((set: any) => set.label), ['Big Studio'], 'the studio list, and only it, under Studio')
  assert.deepEqual(directorTheme.sets.map((set: any) => set.label), ['Directed By Someone'], 'no doubled heading, and no studio list under Directed By')
  const titles = studioTheme.sets[0].items.map((entry: any) => entry.title)
  assert.equal(titles.length, 20, 'the whole list, past the template limit of 18')
  assert.deepEqual(titles.slice(0, 3), ['Studio Film 0', 'Studio Film 1', 'Studio Film 2'], 'theatrical release order, whatever the digital date')

  await h.request('POST', '/api/v1/system/player-box-sets/reset')
  db.prepare('DELETE FROM lists WHERE id IN (?, ?)').run(studio, director)
  db.prepare(`DELETE FROM films WHERE id IN (${[...films, directorFilm].map(() => '?').join(',')})`).run(...films, directorFilm)
})

test('recommendations expose a stable player-only collection', async () => {
  const films = await h.request('GET', '/api/v1/player/recommendations/film?profile=default')
  assert.equal(films.status, 200)
  assert.ok(Array.isArray(films.json.items))
  const invalid = await h.request('GET', '/api/v1/player/recommendations/book')
  assert.equal(invalid.status, 400)
})

test('playback progress persists and returns consumer metadata', async () => {
  const saved = await h.request('POST', '/api/v1/player/progress', {
    body: { type: 'film', id: filmId, positionSeconds: 321, durationSeconds: 7020, completed: false },
  })
  assert.equal(saved.status, 204)

  const list = await h.request('GET', '/api/v1/player/progress')
  assert.equal(list.status, 200)
  assert.equal(list.json.progress.length, 1)
  assert.equal(list.json.progress[0].key, `film:${filmId}`)
  assert.equal(list.json.progress[0].title, 'Alien')
  assert.equal(list.json.progress[0].positionSeconds, 321)
  assert.ok(!JSON.stringify(list.json).includes(process.env.ARCHIVIST_MEDIA_BASE!))

  const removed = await h.request('DELETE', `/api/v1/player/progress/film/${filmId}`)
  assert.equal(removed.status, 204)
  assert.equal((await h.request('GET', '/api/v1/player/progress')).json.progress.length, 0)
})

test('playback progress validates media identity and positions', async () => {
  const missing = await h.request('POST', '/api/v1/player/progress', {
    body: { type: 'film', id: 999999, positionSeconds: 1 },
  })
  assert.equal(missing.status, 404)
  const invalid = await h.request('POST', '/api/v1/player/progress', {
    body: { type: 'book', id: filmId, positionSeconds: -1 },
  })
  assert.equal(invalid.status, 400)
})

test('film stream: full, range, and HEAD', async () => {
  const full = await fetch(`${h.baseUrl}/api/v1/player/stream/films/${filmId}`, { headers: h.authHeaders })
  assert.equal(full.status, 200)
  assert.equal((await full.arrayBuffer()).byteLength, 2048)

  const range = await fetch(`${h.baseUrl}/api/v1/player/stream/films/${filmId}`, { headers: { ...h.authHeaders, Range: 'bytes=0-99' } })
  assert.equal(range.status, 206)
  assert.equal((await range.arrayBuffer()).byteLength, 100)

  const head = await fetch(`${h.baseUrl}/api/v1/player/stream/films/${filmId}`, { method: 'HEAD', headers: h.authHeaders })
  assert.equal(head.status, 200)
})

test('episode stream works; unavailable items 404/410 correctly', async () => {
  const ep = await fetch(`${h.baseUrl}/api/v1/player/stream/episodes/${episodeId}`, { headers: h.authHeaders })
  assert.equal(ep.status, 200)

  const noRow = await h.request('GET', '/api/v1/player/stream/films/999999')
  assert.equal(noRow.status, 404)

  rmSync(filmFile)
  const gone = await h.request('GET', `/api/v1/player/stream/films/${filmId}`)
  assert.equal(gone.status, 410)
})
