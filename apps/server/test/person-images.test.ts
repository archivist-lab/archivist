import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { applySchema } from '@archivist/db'
import { indexMediaCredits } from '../src/services/credit-index.js'
import {
  backfillPersonImages, downloadPersonImage, pendingPortraits,
  personImageUrl, portraitsByProviderId, withLocalPortraits,
} from '../src/services/person-images.js'

const PIXEL = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')

/** A stand-in provider, so nothing in this file reaches the real internet. */
function imageHost(): Promise<{ url: string; hits: () => number; close: () => Promise<void>; server: Server }> {
  let hits = 0
  const server = createServer((request, response) => {
    hits++
    if (request.url?.includes('missing')) { response.writeHead(404).end(); return }
    if (request.url?.includes('notanimage')) {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html>nope</html>')
      return
    }
    response.writeHead(200, { 'content-type': 'image/png' }).end(PIXEL)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo
    resolve({
      url: `http://127.0.0.1:${port}`,
      hits: () => hits,
      close: () => new Promise<void>(done => server.close(() => done())),
      server,
    })
  }))
}

function fixture() {
  const media = mkdtempSync(join(tmpdir(), 'archivist-portraits-'))
  mkdirSync(join(media, 'people'), { recursive: true })
  process.env.ARCHIVIST_MEDIA_BASE = media
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const libraryId = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films', 'films', 'portraits')").run().lastInsertRowid)
  const filmId = Number(db.prepare("INSERT INTO films (library_id, title) VALUES (?, 'The Archive')").run(libraryId).lastInsertRowid)
  const otherId = Number(db.prepare("INSERT INTO films (library_id, title) VALUES (?, 'The Archive II')").run(libraryId).lastInsertRowid)
  return { db, media, filmId, otherId, cleanup: () => { db.close(); rmSync(media, { recursive: true, force: true }) } }
}

test('one portrait is downloaded per person and reused by every credit they hold', async () => {
  const f = fixture()
  const host = await imageHost()
  try {
    // The same actor in two films, exactly as the provider blobs carry them.
    const actor = { id: 4242, name: 'Anna Archivist', character: 'Herself', profilePath: `${host.url}/anna.png` }
    indexMediaCredits(f.db, 'film', f.filmId, [actor], [])
    indexMediaCredits(f.db, 'film', f.otherId, [actor], [])
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM people').get() as any).n, 1, 'the provider id dedupes them')

    const result = await backfillPersonImages({ db: f.db })
    assert.deepEqual(result, { attempted: 1, stored: 1 })
    assert.equal(host.hits(), 1, 'two credits, one download')

    const person = f.db.prepare('SELECT id, profile_image_path FROM people').get() as any
    assert.equal(person.profile_image_path, personImageUrl(person.id))
    assert.deepEqual(readFileSync(join(f.media, 'people', `${person.id}.jpg`)), PIXEL)

    // Both films now serve the stored file rather than the provider's URL.
    const served = withLocalPortraits([actor], f.db)
    assert.equal(served[0].profilePath, personImageUrl(person.id))
    assert.equal((served[0] as any).profileUrl, personImageUrl(person.id))

    // And a second sweep has nothing left to do.
    assert.deepEqual(await backfillPersonImages({ db: f.db }), { attempted: 0, stored: 0 })
    assert.equal(host.hits(), 1)
  } finally {
    await host.close()
    f.cleanup()
  }
})

test('a credit with no stored portrait keeps the URL it arrived with', async () => {
  const f = fixture()
  try {
    const credits = [{ id: 99, name: 'Unfetched', profilePath: 'https://provider.example/99.jpg' }]
    // Nothing downloaded yet: the picture still draws while a backfill runs,
    // rather than the cast row emptying out until it finishes.
    assert.equal(withLocalPortraits(credits, f.db)[0].profilePath, 'https://provider.example/99.jpg')
    assert.equal(portraitsByProviderId([99], f.db).size, 0)
    // A credit with no provider id is left alone rather than matched by name.
    assert.deepEqual(withLocalPortraits([{ name: 'Anonymous' }], f.db), [{ name: 'Anonymous' }])
  } finally {
    f.cleanup()
  }
})

test('a failed or non-image response leaves no file and no recorded path', async () => {
  const f = fixture()
  const host = await imageHost()
  try {
    indexMediaCredits(f.db, 'film', f.filmId, [
      { id: 1, name: 'Gone', profilePath: `${host.url}/missing.png` },
      { id: 2, name: 'Wrong Type', profilePath: `${host.url}/notanimage.png` },
      { id: 3, name: 'Fine', profilePath: `${host.url}/ok.png` },
    ], [])
    const result = await backfillPersonImages({ db: f.db })
    assert.equal(result.attempted, 3)
    assert.equal(result.stored, 1, 'only the real image lands')

    const stored = f.db.prepare('SELECT name FROM people WHERE profile_image_path IS NOT NULL').all() as any[]
    assert.deepEqual(stored.map(row => row.name), ['Fine'])
    // A half-written file is never left behind to be served as a whole one.
    const partials = f.db.prepare('SELECT id FROM people').all() as any[]
    for (const person of partials) {
      assert.equal(existsInMedia(f.media, `${person.id}.jpg.part`), false)
    }
  } finally {
    await host.close()
    f.cleanup()
  }
})

test('a portrait that moves at the provider is fetched again; one that is merely absent is kept', async () => {
  const f = fixture()
  const host = await imageHost()
  try {
    const actor = { id: 77, name: 'Moved', profilePath: `${host.url}/first.png` }
    indexMediaCredits(f.db, 'film', f.filmId, [actor], [])
    await backfillPersonImages({ db: f.db })
    const personId = (f.db.prepare('SELECT id FROM people').get() as any).id
    assert.equal((f.db.prepare('SELECT profile_image_path AS p FROM people').get() as any).p, personImageUrl(personId))

    // A refresh that omits the field must not discard the file on disk.
    indexMediaCredits(f.db, 'film', f.filmId, [{ id: 77, name: 'Moved' }], [])
    assert.equal((f.db.prepare('SELECT profile_image_path AS p FROM people').get() as any).p, personImageUrl(personId))
    assert.deepEqual(pendingPortraits(10, f.db), [])

    // A different URL is a different photograph, so it goes back in the queue.
    indexMediaCredits(f.db, 'film', f.filmId, [{ ...actor, profilePath: `${host.url}/second.png` }], [])
    assert.equal((f.db.prepare('SELECT profile_image_path AS p FROM people').get() as any).p, null)
    assert.equal(pendingPortraits(10, f.db).length, 1)
  } finally {
    await host.close()
    f.cleanup()
  }
})

test('a portrait already on disk is recorded without fetching it again', async () => {
  const f = fixture()
  const host = await imageHost()
  try {
    indexMediaCredits(f.db, 'film', f.filmId, [{ id: 8, name: 'Already Here', profilePath: `${host.url}/eight.png` }], [])
    const personId = (f.db.prepare('SELECT id FROM people').get() as any).id
    // Stands in for a run that wrote the file and stopped before the row update.
    writeFileSync(join(f.media, 'people', `${personId}.jpg`), PIXEL)

    const stored = await downloadPersonImage(
      f.db.prepare('SELECT id, profile_path, profile_image_path FROM people').get() as any, f.db,
    )
    assert.equal(stored, personImageUrl(personId))
    assert.equal(host.hits(), 0, 'the file on disk is the answer')
  } finally {
    await host.close()
    f.cleanup()
  }
})

function existsInMedia(media: string, name: string): boolean {
  try { readFileSync(join(media, 'people', name)); return true } catch { return false }
}
