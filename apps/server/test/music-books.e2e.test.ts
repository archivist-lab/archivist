import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'
import { startProviderMock, providerEnv } from './provider-mock.js'

let h: TestHarness
let mock: Awaited<ReturnType<typeof startProviderMock>>
let musicHeaders: Record<string, string>
let booksHeaders: Record<string, string>
let artistId: number
let albumId: number
let authorId: number
let bookId: number

test('boot with provider mocks', async () => {
  mock = await startProviderMock()
  h = await startTestApp({ env: providerEnv(mock.url) })
  const tabs = await h.request('GET', '/api/v1/tabs')
  musicHeaders = { 'x-tab-context': String(tabs.json.find((t: any) => t.media_type === 'music').id) }
  booksHeaders = { 'x-tab-context': String(tabs.json.find((t: any) => t.media_type === 'books').id) }
})

after(async () => {
  await h?.close()
  await mock?.close()
})

// ── Music ─────────────────────────────────────────────────────────────────────

test('music lookup returns MusicBrainz results with alreadyAdded', async () => {
  const res = await h.request('GET', '/api/v1/music/lookup?q=radiohead', { headers: musicHeaders })
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 1)
  assert.equal(res.json[0].name, 'Radiohead')
  assert.equal(res.json[0].alreadyAdded, false)
})

test('add artist persists artist and albums', async () => {
  const res = await h.request('POST', '/api/v1/music/artists', {
    body: { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', monitored: true },
    headers: musicHeaders,
  })
  assert.equal(res.status, 201)
  artistId = res.json.id
  assert.equal(res.json.name, 'Radiohead')
  assert.ok(Array.isArray(res.json.genres))
  assert.equal(res.json.albums.length, 1)
  albumId = res.json.albums[0].id
  assert.equal(res.json.albums[0].title, 'OK Computer')
  assert.equal(res.json.albums[0].status, 'missing')

  const dup = await h.request('POST', '/api/v1/music/artists', {
    body: { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711' },
    headers: musicHeaders,
  })
  assert.equal(dup.status, 409)
})

test('artist list and detail preserve legacy shapes', async () => {
  const list = await h.request('GET', '/api/v1/music/artists', { headers: musicHeaders })
  assert.equal(list.json.length, 1)
  assert.equal(list.json[0].album_count, 1)
  assert.equal(list.json[0].monitored, true)

  const detail = await h.request('GET', `/api/v1/music/artists/${artistId}`, { headers: musicHeaders })
  assert.equal(detail.json.albums.length, 1)

  const missing = await h.request('GET', '/api/v1/music/artists/424242', { headers: musicHeaders })
  assert.equal(missing.status, 404)
})

test('album detail lazily imports tracks from MusicBrainz', async () => {
  const res = await h.request('GET', `/api/v1/music/albums/${albumId}`, { headers: musicHeaders })
  assert.equal(res.status, 200)
  assert.equal(res.json.tracks.length, 2)
  assert.equal(res.json.tracks[0].title, 'Airbag')
})

test('album update persists policy fields', async () => {
  const res = await h.request('PUT', `/api/v1/music/albums/${albumId}`, {
    body: { monitored: false, target_tier: 'Tier 1' },
    headers: musicHeaders,
  })
  assert.equal(res.json.monitored, false)
  assert.equal(res.json.target_tier, 'Tier 1')
})

test('album acquisition history, reject, and repair', async () => {
  const history = await h.request('GET', `/api/v1/music/albums/${albumId}/acquisition-history`, { headers: musicHeaders })
  assert.deepEqual(history.json, { decisions: [], blocks: [] })

  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE albums SET status = 'downloading', info_hash = ?, current_release_title = 'Radiohead-OK.Computer.FLAC-TEST' WHERE id = ?").run('d'.repeat(40), albumId)

  const reject = await h.request('POST', `/api/v1/music/albums/${albumId}/reject-current-release`, { body: { reason: 'bad rip' }, headers: musicHeaders })
  assert.equal(reject.json.success, true)

  const history2 = await h.request('GET', `/api/v1/music/albums/${albumId}/acquisition-history`, { headers: musicHeaders })
  assert.equal(history2.json.blocks.length, 1)

  getDb().prepare("UPDATE albums SET status = 'collected', current_release_title = 'Radiohead-OK.Computer.MP3-TEST' WHERE id = ?").run(albumId)
  getDb().prepare("UPDATE tracks SET status = 'collected', file_path = '/nonexistent/track.flac' WHERE album_id = ?").run(albumId)

  const repair = await h.request('POST', `/api/v1/music/albums/${albumId}/repair`, { body: {}, headers: musicHeaders })
  assert.equal(repair.status, 200)
  assert.equal(repair.json.status, 'missing')

  const tracks = getDb().prepare('SELECT status, file_path FROM tracks WHERE album_id = ?').all(albumId) as any[]
  for (const t of tracks) {
    assert.equal(t.status, 'missing')
    assert.equal(t.file_path, null)
  }
})

test('music refresh returns background envelope', async () => {
  const res = await h.request('POST', '/api/v1/music/refresh', { body: {}, headers: musicHeaders })
  assert.equal(res.json.success, true)
})

// ── Books ─────────────────────────────────────────────────────────────────────

test('author lookup returns OpenLibrary results with alreadyAdded', async () => {
  const res = await h.request('GET', '/api/v1/books/lookup/authors?q=sanderson', { headers: booksHeaders })
  assert.equal(res.status, 200)
  assert.equal(res.json[0].name, 'Brandon Sanderson')
  assert.equal(res.json[0].alreadyAdded, false)
})

test('author name lookup returns detail with series list', async () => {
  const res = await h.request('GET', '/api/v1/books/lookup/author/Brandon%20Sanderson', { headers: booksHeaders })
  assert.equal(res.status, 200)
  assert.equal(res.json.name, 'Brandon Sanderson')
  assert.deepEqual(res.json.series, ['Mistborn'])
})

test('add author persists author and books', async () => {
  const res = await h.request('POST', '/api/v1/books/authors', {
    body: { name: 'Brandon Sanderson', monitored: true },
    headers: booksHeaders,
  })
  assert.equal(res.status, 201)
  authorId = res.json.id
  assert.equal(res.json.name, 'Brandon Sanderson')
  assert.equal(res.json.books.length, 1)
  bookId = res.json.books[0].id
  assert.equal(res.json.books[0].title, 'Mistborn: The Final Empire')
  assert.equal(res.json.books[0].series_name, 'Mistborn')
  assert.equal(res.json.books[0].status, 'missing')

  const dup = await h.request('POST', '/api/v1/books/authors', { body: { name: 'Brandon Sanderson' }, headers: booksHeaders })
  assert.equal(dup.status, 409)
})

test('author list/detail and book update', async () => {
  const list = await h.request('GET', '/api/v1/books/authors', { headers: booksHeaders })
  assert.equal(list.json.length, 1)
  assert.equal(list.json[0].book_count, 1)

  const detail = await h.request('GET', `/api/v1/books/authors/${authorId}`, { headers: booksHeaders })
  assert.equal(detail.json.books.length, 1)

  const updated = await h.request('PUT', `/api/v1/books/${bookId}`, { body: { monitored: false }, headers: booksHeaders })
  assert.equal(updated.json.monitored, false)
})

test('book acquisition history, reject, and repair', async () => {
  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE books SET status = 'downloading', info_hash = ?, current_release_title = 'Mistborn.EPUB-TEST' WHERE id = ?").run('e'.repeat(40), bookId)

  const reject = await h.request('POST', `/api/v1/books/${bookId}/reject-current-release`, { body: {}, headers: booksHeaders })
  assert.equal(reject.json.success, true)

  const history = await h.request('GET', `/api/v1/books/${bookId}/acquisition-history`, { headers: booksHeaders })
  assert.equal(history.json.blocks.length, 1)

  getDb().prepare("UPDATE books SET status = 'collected', current_release_title = 'Mistborn.MOBI-TEST' WHERE id = ?").run(bookId)
  const repair = await h.request('POST', `/api/v1/books/${bookId}/repair`, { body: {}, headers: booksHeaders })
  assert.equal(repair.json.status, 'missing')
})

test('books refresh returns background envelope', async () => {
  const res = await h.request('POST', '/api/v1/books/refresh', { body: {}, headers: booksHeaders })
  assert.equal(res.json.success, true)
})

test('cross-library isolation: music data invisible to books scope', async () => {
  const res = await h.request('GET', '/api/v1/music/artists', { headers: booksHeaders })
  // books library id resolves, but no artists carry that library id
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 0)
})

test('delete author and artist cascade with 204 semantics', async () => {
  const delAuthor = await h.request('DELETE', `/api/v1/books/authors/${authorId}`, { headers: booksHeaders })
  assert.equal(delAuthor.status, 204)

  const delArtist = await h.request('DELETE', `/api/v1/music/artists/${artistId}`, { headers: musicHeaders })
  assert.equal(delArtist.status, 204)

  const { getDb } = await import('../src/db.js')
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM books WHERE author_id = ?').get(authorId) as any).n, 0)
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM albums WHERE artist_id = ?').get(artistId) as any).n, 0)
})
