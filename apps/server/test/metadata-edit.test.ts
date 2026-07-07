import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'
import { startProviderMock } from './provider-mock.js'

let h: TestHarness
let mock: Awaited<ReturnType<typeof startProviderMock>>
const headers: Record<string, Record<string, string>> = {}

test('boot and seed one row per domain', async () => {
  mock = await startProviderMock()
  h = await startTestApp()
  const tabs = await h.request('GET', '/api/v1/tabs')
  for (const t of tabs.json) headers[t.media_type] = { 'x-tab-context': String(t.id) }

  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const lib = (type: string) => tabs.json.find((t: any) => t.media_type === type).id
  db.prepare("INSERT INTO series (library_id, tvdb_id, title, year, overview) VALUES (?, 1, 'Old Show', 2000, 'old')").run(lib('series'))
  db.prepare("INSERT INTO artists (library_id, musicbrainz_id, name, sort_name) VALUES (?, 'mbid-1', 'Old Artist', 'Old Artist')").run(lib('music'))
  const authorId = db.prepare("INSERT INTO authors (library_id, name) VALUES (?, 'Old Author')").run(lib('books')).lastInsertRowid
  db.prepare("INSERT INTO books (author_id, title, year) VALUES (?, 'Old Book', 1990)").run(authorId)
  db.prepare("INSERT INTO comic_series (library_id, comicvine_id, title, start_year) VALUES (?, 9, 'Old Comic', 1980)").run(lib('comics'))
  db.prepare("INSERT INTO games (library_id, igdb_id, title, year) VALUES (?, 7, 'Old Game', 1995)").run(lib('games'))
})

after(async () => {
  await h?.close()
  await mock?.close()
})

test('series metadata edit persists with null no-op semantics', async () => {
  const list = await h.request('GET', '/api/v1/series', { headers: headers.series })
  const id = list.json[0].id
  const res = await h.request('PUT', `/api/v1/series/${id}/metadata`, {
    body: { title: 'New Show', network: 'HBO', genres: ['Drama'], year: null },
    headers: headers.series,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.title, 'New Show')
  assert.equal(res.json.network, 'HBO')
  assert.deepEqual(res.json.genres, ['Drama'])
  assert.equal(res.json.year, 2000) // null → unchanged
  assert.equal(res.json.sort_title, 'new show')

  const missing = await h.request('PUT', '/api/v1/series/424242/metadata', { body: { title: 'x' }, headers: headers.series })
  assert.equal(missing.status, 404)
})

test('artist metadata edit persists', async () => {
  const list = await h.request('GET', '/api/v1/music/artists', { headers: headers.music })
  const id = list.json[0].id
  const res = await h.request('PUT', `/api/v1/music/artists/${id}/metadata`, {
    body: { name: 'New Artist', disambiguation: 'UK band', overview: 'A biography.', genres: ['rock', 'indie'] },
    headers: headers.music,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.name, 'New Artist')
  assert.equal(res.json.disambiguation, 'UK band')
  assert.deepEqual(res.json.genres, ['rock', 'indie'])
})

test('author and book metadata edits persist', async () => {
  const authors = await h.request('GET', '/api/v1/books/authors', { headers: headers.books })
  const authorId = authors.json[0].id
  const author = await h.request('PUT', `/api/v1/books/authors/${authorId}/metadata`, {
    body: { name: 'Jane Doe', overview: 'Bio.' },
    headers: headers.books,
  })
  assert.equal(author.status, 200)
  assert.equal(author.json.name, 'Jane Doe')
  assert.equal(author.json.sort_name, 'Doe, Jane')

  const detail = await h.request('GET', `/api/v1/books/authors/${authorId}`, { headers: headers.books })
  const bookId = detail.json.books[0].id
  const book = await h.request('PUT', `/api/v1/books/${bookId}/metadata`, {
    body: { title: 'New Book', series_name: 'Saga', series_position: 1.5, publisher: 'Tor', year: null },
    headers: headers.books,
  })
  assert.equal(book.status, 200)
  assert.equal(book.json.title, 'New Book')
  assert.equal(book.json.series_name, 'Saga')
  assert.equal(book.json.series_position, 1.5)
  assert.equal(book.json.year, 1990)

  // scoping: book id under wrong library context 404s
  const wrong = await h.request('PUT', `/api/v1/books/${bookId}/metadata`, { body: { title: 'x' }, headers: headers.films })
  assert.equal(wrong.status, 404)
})

test('comic series metadata edit persists', async () => {
  const list = await h.request('GET', '/api/v1/comics/series', { headers: headers.comics })
  const id = list.json[0].id
  const res = await h.request('PUT', `/api/v1/comics/series/${id}/metadata`, {
    body: { title: 'The New Comic', publisher: 'Image', overview: 'Space opera.' },
    headers: headers.comics,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.title, 'The New Comic')
  assert.equal(res.json.sort_title, 'New Comic')
  assert.equal(res.json.publisher, 'Image')
  assert.equal(res.json.start_year, 1980)
})

test('image save without a media folder stores the remote URL', async () => {
  const list = await h.request('GET', '/api/v1/series', { headers: headers.series })
  const id = list.json[0].id
  const url = `${mock.url}/assets/poster.jpg`
  const res = await h.request('PUT', `/api/v1/series/${id}/images`, {
    body: { type: 'poster', url },
    headers: headers.series,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.success, true)
  assert.equal(res.json.path, url)

  const { getDb } = await import('../src/db.js')
  const row = getDb().prepare('SELECT poster_path FROM series WHERE id = ?').get(id) as any
  assert.equal(row.poster_path, url)
})

test('image save with a media folder downloads the file locally', async () => {
  const { getDb } = await import('../src/db.js')
  const list = await h.request('GET', '/api/v1/series', { headers: headers.series })
  const id = list.json[0].id
  const folder = join(h.dir, 'media', 'series', 'New Show (2000)')
  mkdirSync(folder, { recursive: true })
  getDb().prepare('UPDATE series SET root_folder_path = ? WHERE id = ?').run(folder, id)

  const res = await h.request('PUT', `/api/v1/series/${id}/images`, {
    body: { type: 'backdrop', url: `${mock.url}/assets/backdrop.jpg` },
    headers: headers.series,
  })
  assert.equal(res.status, 200)
  assert.match(res.json.path, /^\/media\//)
  assert.ok(existsSync(join(folder, 'backdrop.png')))

  const bad = await h.request('PUT', `/api/v1/series/${id}/images`, {
    body: { type: 'nonsense', url: `${mock.url}/assets/x.jpg` },
    headers: headers.series,
  })
  assert.equal(bad.status, 400)
})

test('game image endpoints respond (IGDB-backed search + save)', async () => {
  const list = await h.request('GET', '/api/v1/games', { headers: headers.games })
  const id = list.json[0].id
  // No IGDB credentials in this suite: search degrades to empty candidates.
  const search = await h.request('GET', `/api/v1/games/${id}/images?type=cover`, { headers: headers.games })
  assert.equal(search.status, 200)
  assert.ok(Array.isArray(search.json))

  const save = await h.request('PUT', `/api/v1/games/${id}/images`, {
    body: { type: 'cover', url: `${mock.url}/assets/cover.jpg` },
    headers: headers.games,
  })
  assert.equal(save.status, 200)
  assert.equal(save.json.success, true)
})

test('game metadata edit persists including platforms', async () => {
  const list = await h.request('GET', '/api/v1/games', { headers: headers.games })
  const id = list.json[0].id
  const res = await h.request('PUT', `/api/v1/games/${id}/metadata`, {
    body: { title: 'New Game', developer: 'DevCo', platforms: ['PC', 'PS5'], rating: 8.7 },
    headers: headers.games,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.title, 'New Game')
  assert.equal(res.json.developer, 'DevCo')
  assert.deepEqual(res.json.platforms, ['PC', 'PS5'])
  assert.equal(res.json.rating, 8.7)
  assert.equal(res.json.year, 1995)
})
