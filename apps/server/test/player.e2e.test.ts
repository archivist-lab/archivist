import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness
let filmId: number
let seriesId: number
let episodeId: number
let filmFile: string

test('boot and seed a playable library', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()

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
  assert.equal(detail.json.seasons[0].episodes.length, 2)
  assert.equal(detail.json.nextAvailable.id, episodeId)
  assert.ok(!JSON.stringify(detail.json).includes(process.env.ARCHIVIST_MEDIA_BASE!))
})

test('episode detail', async () => {
  const res = await h.request('GET', `/api/v1/player/episodes/${episodeId}`)
  assert.equal(res.status, 200)
  assert.equal(res.json.seriesTitle, 'Severance')
  assert.equal(res.json.playback.streamUrl, `/api/v1/player/stream/episodes/${episodeId}`)
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
