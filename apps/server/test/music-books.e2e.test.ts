import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'
import { startProviderMock, providerEnv } from './provider-mock.js'
import { getDb } from '../src/db.js'

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
  assert.equal(res.status, 200, JSON.stringify(res.json))
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
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.tracks.length, 2)
  assert.equal(res.json.tracks[0].title, 'Airbag')
  assert.equal(res.json.track_count, 2)
  assert.equal(res.json.musicbrainz_release_id, 'official-ok-computer-release')
})

test('album releases are concrete, selectable editions beneath the release group', async () => {
  const releases = await h.request('GET', `/api/v1/music/albums/${albumId}/releases`, { headers: musicHeaders })
  assert.equal(releases.status, 200, JSON.stringify(releases.json))
  assert.equal(releases.json.releases.length, 4)
  const selected = releases.json.releases.find((release: any) => release.selected)
  assert.equal(selected.id, 'official-ok-computer-release')
  assert.equal(selected.country, 'GB')
  assert.deepEqual(selected.mediaFormats, ['CD'])

  const changed = await h.request('PUT', `/api/v1/music/albums/${albumId}/release`, {
    headers: musicHeaders,
    body: { releaseId: 'official-ok-computer-deluxe-release' },
  })
  assert.equal(changed.status, 200, JSON.stringify(changed.json))
  assert.equal(changed.json.album.musicbrainz_release_id, 'official-ok-computer-deluxe-release')
  assert.equal(changed.json.album.track_count, 3)
  assert.equal(changed.json.album.year, 1997, 'the conceptual release-group year remains stable')
  assert.equal(changed.json.album.tracks[2].title, 'I Promise')
  assert.equal(changed.json.release.disambiguation, '20th anniversary deluxe edition')

  const ownedTrack = getDb().prepare('SELECT id FROM tracks WHERE album_id = ? AND track_number = 1').get(albumId) as { id: number }
  getDb().prepare("UPDATE tracks SET status = 'collected', file_path = '/library/ok-computer/airbag.flac' WHERE id = ?").run(ownedTrack.id)
  const compatibleChange = await h.request('PUT', `/api/v1/music/albums/${albumId}/release`, {
    headers: musicHeaders,
    body: { releaseId: 'official-ok-computer-deluxe-remaster-release' },
  })
  assert.equal(compatibleChange.status, 200, JSON.stringify(compatibleChange.json))
  assert.equal(compatibleChange.json.album.musicbrainz_release_id, 'official-ok-computer-deluxe-remaster-release')
  assert.deepEqual(
    getDb().prepare('SELECT id, musicbrainz_id, status, file_path FROM tracks WHERE id = ?').get(ownedTrack.id),
    { id: ownedTrack.id, musicbrainz_id: 'rt1', status: 'collected', file_path: '/library/ok-computer/airbag.flac' },
    'compatible edition changes update metadata in place without disconnecting ownership',
  )

  const unsafeChange = await h.request('PUT', `/api/v1/music/albums/${albumId}/release`, {
    headers: musicHeaders,
    body: { releaseId: 'official-ok-computer-release' },
  })
  assert.equal(unsafeChange.status, 409)
  assert.match(unsafeChange.json.error, /tracklist differs from acquiring or collected tracks/)
  getDb().prepare("UPDATE tracks SET status = 'missing', file_path = NULL WHERE album_id = ?").run(albumId)
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
  getDb()
    .prepare("UPDATE albums SET status = 'downloading', info_hash = ?, current_release_title = 'Radiohead-OK.Computer.FLAC-TEST' WHERE id = ?")
    .run('d'.repeat(40), albumId)

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
  getDb()
    .prepare("UPDATE books SET status = 'downloading', info_hash = ?, current_release_title = 'Mistborn.EPUB-TEST' WHERE id = ?")
    .run('e'.repeat(40), bookId)

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

test('the album quality policy accepts every choice the picker can make', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  db.prepare('INSERT INTO artists (library_id, musicbrainz_id, name, monitored) VALUES (?,?,?,1)').run(libId, 'mb-policy', 'Policy Artist')
  const artistId = (db.prepare("SELECT id FROM artists WHERE musicbrainz_id='mb-policy'").get() as { id: number }).id
  db.prepare("INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, monitored, status) VALUES (?,?,?,?,1,'missing')").run(
    artistId,
    'mb-policy-al',
    'Policy Album',
    'Album',
  )
  const albumId = (db.prepare("SELECT id FROM albums WHERE musicbrainz_id='mb-policy-al'").get() as { id: number }).id

  const put = (body: unknown) => h.request('PUT', `/api/v1/music/albums/${albumId}`, { body, headers: ctx })

  assert.equal((await put({ target_resolution: 'lossless', target_codec: 'FLAC' })).status, 200)
  assert.equal(
    (await put({ minimum_resolution: 'hifi-lossy', minimum_tier: 'Tier 2' })).json.minimum_tier,
    'Tier 2',
    'floors persist — they had no columns to write to at all',
  )

  // Changing the class clears a codec the new class cannot produce. The panel
  // sends both in one patch; a schema that rejected null made the whole request
  // fail, which read as a modal that would not let you select anything.
  const changed = await put({ target_resolution: 'hifi-lossy', target_codec: null })
  assert.equal(changed.status, 200)
  assert.equal(changed.json.target_resolution, 'hifi-lossy')
  assert.equal(changed.json.target_codec, null)

  // "Any" is the absence of a constraint, so it has to be expressible.
  const cleared = await put({ target_resolution: null, target_tier: null })
  assert.equal(cleared.json.target_resolution, null)
  assert.equal(cleared.json.target_tier, null)
  assert.equal(cleared.json.minimum_tier, 'Tier 2', 'keys not sent are left alone')

  assert.equal((await put({ upgrade_allowed: false })).json.upgrade_allowed, false)
  assert.equal((await put({ monitored: true })).json.minimum_tier, 'Tier 2')
})

test('the quality profile is artist-wide and cascades to every album', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  db.prepare('INSERT INTO artists (library_id, musicbrainz_id, name, monitored) VALUES (?,?,?,1)').run(libId, 'mb-global', 'Global Artist')
  const artistId = (db.prepare("SELECT id FROM artists WHERE musicbrainz_id='mb-global'").get() as { id: number }).id
  for (const key of ['g1', 'g2', 'g3']) {
    db.prepare("INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, monitored, status) VALUES (?,?,?,?,1,'missing')").run(
      artistId,
      key,
      `Album ${key}`,
      'Album',
    )
  }

  const saved = await h.request('PUT', `/api/v1/music/artists/${artistId}`, {
    body: { target_resolution: 'lossless', target_codec: 'FLAC', minimum_tier: 'Tier 2', upgrade_allowed: false },
    headers: ctx,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.target_resolution, 'lossless')

  // Every album carries the same profile, so the grabber — which reads the
  // album row — needs no knowledge that the setting is artist-wide.
  const albums = db.prepare('SELECT target_resolution, target_codec, minimum_tier, upgrade_allowed FROM albums WHERE artist_id = ?').all(artistId) as Array<
    Record<string, unknown>
  >
  assert.equal(albums.length, 3)
  for (const album of albums) {
    assert.equal(album.target_resolution, 'lossless')
    assert.equal(album.target_codec, 'FLAC')
    assert.equal(album.minimum_tier, 'Tier 2')
    assert.equal(album.upgrade_allowed, 0)
  }

  // Clearing cascades too, rather than leaving albums pinned to a stale target.
  await h.request('PUT', `/api/v1/music/artists/${artistId}`, { body: { target_resolution: null }, headers: ctx })
  const after = db.prepare('SELECT DISTINCT target_resolution AS q FROM albums WHERE artist_id = ?').all(artistId) as Array<{ q: string | null }>
  assert.deepEqual(after, [{ q: null }])
})

test('a discography is searched, grabbed and tracked against the artist', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  db.prepare('INSERT INTO artists (library_id, musicbrainz_id, name, monitored) VALUES (?,?,?,1)').run(libId, 'mb-disco', 'Disco Artist')
  const artistId = (db.prepare("SELECT id FROM artists WHERE musicbrainz_id='mb-disco'").get() as { id: number }).id

  const search = await h.request('POST', `/api/v1/music/artists/${artistId}/search-discography`, { body: {}, headers: ctx })
  assert.equal(search.status, 200)
  assert.ok(Array.isArray(search.json.releases), 'a release list is always returned, even when empty')

  assert.equal((await h.request('POST', '/api/v1/music/artists/999999/search-discography', { body: {}, headers: ctx })).status, 404)
  assert.equal(
    (await h.request('POST', `/api/v1/music/artists/${artistId}/grab-discography`, { body: {}, headers: ctx })).status,
    400,
    'a grab needs a download url',
  )

  // The pack belongs to the artist, not to any one album, so that is where the
  // monitor looks for it.
  db.prepare(`UPDATE artists SET discography_info_hash = 'deadbeef', discography_status = 'acquiring',
    discography_title = 'Disco Artist - Discography' WHERE id = ?`).run(artistId)
  const tracked = db.prepare('SELECT discography_info_hash AS hash, discography_status AS status FROM artists WHERE id = ?').get(artistId) as {
    hash: string
    status: string
  }
  assert.equal(tracked.hash, 'deadbeef')
  assert.equal(tracked.status, 'acquiring')

  const detail = await h.request('GET', `/api/v1/music/artists/${artistId}`, { headers: ctx })
  assert.equal(detail.status, 200)
  assert.equal(
    detail.json.discography_torrent_status,
    null,
    'an acquisition without a live runtime match remains submitted rather than being mislabeled as downloading',
  )
})

test('an artist with a download in flight reports it as acquiring', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  db.prepare('INSERT INTO artists (library_id, musicbrainz_id, name, monitored) VALUES (?,?,?,1)').run(libId, 'mb-acquiring', 'Acquiring Artist')
  const artistId = (db.prepare("SELECT id FROM artists WHERE musicbrainz_id='mb-acquiring'").get() as { id: number }).id

  const add = (key: string, status: string) =>
    db
      .prepare('INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, monitored, status, download_progress) VALUES (?,?,?,?,1,?,0.25)')
      .run(artistId, key, `Album ${key}`, 'Album', status)
  add('acq-1', 'acquiring')
  add('acq-2', 'collected')
  add('acq-3', 'missing')

  // The library card needs its own counter: "partially collected" is not the
  // same as "downloading right now", and conflating them left an artist mid
  // download reading as Missing.
  const list = await h.request('GET', '/api/v1/music/artists', { headers: ctx })
  const row = (list.json as Array<Record<string, number | string>>).find(a => a.musicbrainz_id === 'mb-acquiring')
  assert.ok(row, 'the artist is listed')
  assert.equal(row!.album_count, 3)
  assert.equal(row!.downloaded_albums, 1)
  assert.equal(row!.acquiring_albums, 1)

  const detail = await h.request('GET', `/api/v1/music/artists/${artistId}`, { headers: ctx })
  const acquiring = (detail.json.albums as Array<Record<string, unknown>>).filter(a => a.status === 'acquiring')
  assert.equal(acquiring.length, 1)
  assert.equal(acquiring[0].downloadProgress, 0.25, 'progress reaches the row that renders the badge')
})

test('removing an album deletes it and its tracks but keeps the artist', async () => {
  // Removal, not exclusion: the artist keeps its release-type selection, so
  // re-applying that selection from the Releases dialog restores the album.
  // Seeded locally because the shared fixture artist is deleted earlier.
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }

  db.prepare('INSERT INTO artists (library_id, musicbrainz_id, name, monitored) VALUES (?,?,?,1)').run(libId, 'mb-removable', 'Removable Artist')
  const removableArtistId = (db.prepare("SELECT id FROM artists WHERE musicbrainz_id='mb-removable'").get() as { id: number }).id

  db.prepare("INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, monitored, status) VALUES (?,?,?,'Album',1,'missing')")
    .run(removableArtistId, 'mb-removable-al', 'Removable Album')
  const removableAlbumId = (db.prepare("SELECT id FROM albums WHERE musicbrainz_id='mb-removable-al'").get() as { id: number }).id

  const insertTrack = db.prepare(
    "INSERT INTO tracks (album_id, artist_id, musicbrainz_id, title, track_number, disc_number, monitored, status) VALUES (?,?,?,?,?,1,1,'missing')",
  )
  insertTrack.run(removableAlbumId, removableArtistId, 'mb-removable-t1', 'One', 1)
  insertTrack.run(removableAlbumId, removableArtistId, 'mb-removable-t2', 'Two', 2)

  const removed = await h.request('DELETE', `/api/v1/music/albums/${removableAlbumId}`, { headers: ctx })
  assert.equal(removed.status, 200, JSON.stringify(removed.json))
  assert.equal(removed.json.success, true)
  assert.equal(removed.json.filesDeleted, 0, 'files are kept unless deleteFiles is set')

  const gone = await h.request('GET', `/api/v1/music/albums/${removableAlbumId}`, { headers: ctx })
  assert.equal(gone.status, 404)

  const remainingTracks = (
    db.prepare('SELECT COUNT(*) AS count FROM tracks WHERE album_id = ?').get(removableAlbumId) as { count: number }
  ).count
  assert.equal(remainingTracks, 0, 'tracks cascade with the album')

  const after = await h.request('GET', `/api/v1/music/artists/${removableArtistId}`, { headers: ctx })
  assert.equal(after.status, 200, 'the artist itself survives')
  assert.equal((after.json.albums as unknown[]).length, 0, 'the album is no longer listed')
})

test('removing an album that does not exist is a 404, not a silent success', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const res = await h.request('DELETE', '/api/v1/music/albums/424242', { headers: { 'x-tab-context': String(libId) } })
  assert.equal(res.status, 404)
})

test('a refresh adds new releases but leaves removed albums removed', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

  // Album is already tracked, so nothing here counts as newly enabled.
  db.prepare("INSERT INTO artists (library_id, musicbrainz_id, name, monitored, album_types) VALUES (?,?,?,1,'[\"Album\"]')")
    .run(libId, radiohead, 'Refresh Artist')
  const id = (db.prepare("SELECT id FROM artists WHERE name='Refresh Artist'").get() as { id: number }).id

  // Never removed, so it is simply a release the library does not have yet.
  const first = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, { body: { albumTypes: ['Album'] }, headers: ctx })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  assert.equal(first.json.added, 1, 'a release the library has never seen is added')
  assert.equal(first.json.skipped, 0)

  const album = db.prepare('SELECT id FROM albums WHERE artist_id = ?').get(id) as { id: number }
  assert.equal((await h.request('DELETE', `/api/v1/music/albums/${album.id}`, { headers: ctx })).status, 200)

  const tombstones = (
    db.prepare('SELECT COUNT(*) AS count FROM album_removals WHERE artist_id = ?').get(id) as { count: number }
  ).count
  assert.equal(tombstones, 1, 'the removal is remembered')

  // Same refresh, opposite outcome — the difference is the tombstone, not absence.
  const afterRemoval = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, { body: { albumTypes: ['Album'] }, headers: ctx })
  assert.equal(afterRemoval.json.added, 0, 'a removed album is not resurrected')
  assert.equal(afterRemoval.json.skipped, 1)

  // Explicit restore forgets the removal.
  const restored = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, {
    body: { albumTypes: ['Album'], restoreRemoved: true },
    headers: ctx,
  })
  assert.equal(restored.json.added, 1, 'restore re-adds it')
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM album_removals WHERE artist_id = ?').get(id) as { count: number }).count,
    0,
    'restoring clears the tombstone so the album is not dropped again',
  )

  const settled = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, { body: { albumTypes: ['Album'] }, headers: ctx })
  assert.equal(settled.json.added, 0, 'already present')
  assert.equal(settled.json.skipped, 0, 'and no longer treated as removed')
})

test('a release type enabled for the first time populates without restore', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }

  // Reuses the artist from the previous test — one MusicBrainz id per library —
  // wound back to tracking nothing. Ticking a type must then fill it, or the
  // control does nothing at all whenever restore is left off.
  const id = (db.prepare("SELECT id FROM artists WHERE name='Refresh Artist'").get() as { id: number }).id
  db.prepare("UPDATE artists SET album_types = '[]' WHERE id = ?").run(id)
  db.prepare('DELETE FROM albums WHERE artist_id = ?').run(id)

  const res = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, { body: { albumTypes: ['Album'] }, headers: ctx })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.added, 1, 'a newly ticked type is populated even with restore off')
  assert.equal(res.json.skipped, 0)
})

test('release candidates report what the library already knows about each album', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  const id = (db.prepare("SELECT id FROM artists WHERE name='Refresh Artist'").get() as { id: number }).id

  const res = await h.request('GET', `/api/v1/music/artists/${id}/release-candidates?types=Album`, { headers: ctx })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.candidates.length, 1)
  const [candidate] = res.json.candidates as Array<Record<string, unknown>>
  assert.equal(candidate.title, 'OK Computer')
  assert.equal(candidate.albumType, 'Album')
  assert.equal(candidate.inLibrary, true, 'the previous test left it present')
  assert.equal(candidate.removed, false)
  assert.equal(candidate.locked, false, 'nothing is collected, so nothing is protected')

  // A type nothing matches yields an empty pick list rather than an error.
  const none = await h.request('GET', `/api/v1/music/artists/${id}/release-candidates?types=Single`, { headers: ctx })
  assert.equal(none.status, 200)
  assert.equal(none.json.candidates.length, 0)
})

test('an album selection is authoritative: unticking removes and tombstones', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  const id = (db.prepare("SELECT id FROM artists WHERE name='Refresh Artist'").get() as { id: number }).id
  const okc = 'b1392450-e666-3926-a536-22c65f834433'

  const cleared = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, {
    body: { albumTypes: ['Album'], selectedAlbumIds: [] },
    headers: ctx,
  })
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
  assert.equal(cleared.json.deselected, 1, 'the unticked album is removed')
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM albums WHERE artist_id = ?').get(id) as { count: number }).count,
    0,
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM album_removals WHERE artist_id = ?').get(id) as { count: number }).count,
    1,
    'deselecting records the same tombstone as removing the album directly',
  )

  const after = await h.request('GET', `/api/v1/music/artists/${id}/release-candidates?types=Album`, { headers: ctx })
  assert.equal((after.json.candidates as Array<Record<string, unknown>>)[0]?.removed, true)

  // Ticking it again brings it back and settles the tombstone.
  const restored = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, {
    body: { albumTypes: ['Album'], selectedAlbumIds: [okc] },
    headers: ctx,
  })
  assert.equal(restored.json.added, 1)
  assert.equal(restored.json.deselected, 0)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM album_removals WHERE artist_id = ?').get(id) as { count: number }).count,
    0,
  )
})

test('a collected album survives being unticked', async () => {
  const db = getDb()
  const libId = (db.prepare("SELECT id FROM libraries WHERE media_type='music'").get() as { id: number }).id
  const ctx = { 'x-tab-context': String(libId) }
  const id = (db.prepare("SELECT id FROM artists WHERE name='Refresh Artist'").get() as { id: number }).id

  // Files on disk must never be orphaned by a checkbox.
  db.prepare("UPDATE albums SET status = 'collected' WHERE artist_id = ?").run(id)

  const res = await h.request('POST', `/api/v1/music/artists/${id}/refresh`, {
    body: { albumTypes: ['Album'], selectedAlbumIds: [] },
    headers: ctx,
  })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.deselected, 0, 'a collected album is not removed')
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM albums WHERE artist_id = ?').get(id) as { count: number }).count,
    1,
    'it is still in the library',
  )

  const candidates = await h.request('GET', `/api/v1/music/artists/${id}/release-candidates?types=Album`, { headers: ctx })
  assert.equal((candidates.json.candidates as Array<Record<string, unknown>>)[0]?.locked, true, 'and reported as protected')
})
