import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'
import { getDb } from '../src/db.js'
import { drainJobs } from '../src/system/job-runner.js'
import { registerMediaImportJobs } from '../src/services/media-imports.js'

// Importing from a folder chosen on the server, not only the downloads folder:
// browse to it, match each entry, preview, then copy or move it in, renamed.

let h: TestHarness
let films: { id: number }
let folder: string

test('boot', async () => {
  h = await startTestApp()
  const tabs = await h.request('GET', '/api/v1/tabs')
  films = tabs.json.find((t: any) => t.media_type === 'films')
  getDb().prepare(`INSERT INTO films (library_id, title, sort_title, year, genres, status) VALUES (?, 'Alien', 'alien', 1979, '["Horror"]', 'wanted')`).run(films.id)
  folder = join(h.dir, 'old-drive', 'Movies')
  mkdirSync(join(folder, 'Alien.1979.Directors.Cut.1080p.BluRay.x264'), { recursive: true })
  writeFileSync(join(folder, 'Alien.1979.Directors.Cut.1080p.BluRay.x264', 'Alien.1979.Directors.Cut.1080p.BluRay.x264.mkv'), Buffer.alloc(4096, 1))
  writeFileSync(join(folder, '.DS_Store'), 'x')
})
after(async () => { await h?.close() })

test('the folder browser lists folders first, with shortcuts to start from', async () => {
  const res = await h.request('GET', `/api/v1/system/manual-imports/browse?path=${encodeURIComponent(join(h.dir, 'old-drive'))}`)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.entries.map((e: any) => [e.name, e.isDir]), [['Movies', true]])
  assert.equal(res.json.parent, h.dir)
  assert.ok(res.json.roots.some((r: any) => r.label === 'Media'))

  const missing = await h.request('GET', `/api/v1/system/manual-imports/browse?path=${encodeURIComponent(join(h.dir, 'nope'))}`)
  assert.equal(missing.status, 404)
})

test('any folder is scanned for imports, hidden files left out', async () => {
  const res = await h.request('GET', `/api/v1/system/manual-imports/candidates?folder=${encodeURIComponent(folder)}`)
  assert.equal(res.status, 200)
  assert.equal(res.json.downloadDir, folder)
  assert.deepEqual(res.json.items.map((i: any) => i.name), ['Alien.1979.Directors.Cut.1080p.BluRay.x264'])
  assert.equal(res.json.items[0].candidates[0].title, 'Alien')
})

test('an entry is previewed, then copied in and renamed, leaving the folder as it was', async () => {
  const sourcePath = join(folder, 'Alien.1979.Directors.Cut.1080p.BluRay.x264')
  const film = getDb().prepare(`SELECT id FROM films WHERE title = 'Alien'`).get() as { id: number }

  const plan = await h.request('POST', '/api/v1/system/manual-imports/plan', { body: { tabId: films.id, mediaType: 'films', itemId: film.id, sourcePath } })
  assert.equal(plan.status, 200)
  assert.equal(plan.json.plan.status, 'ready')
  assert.equal(plan.json.plan.files[0].role, 'primary')

  const queued = await h.request('POST', '/api/v1/system/manual-imports/import', { body: { tabId: films.id, mediaType: 'films', itemId: film.id, sourcePath, copy: true } })
  assert.equal(queued.status, 201)
  assert.ok(queued.json.jobId)

  // The test app runs no worker; the import job is run here instead. A 4 KB
  // "film" fails the import's own check on what a film file is — and a copy
  // that fails leaves the folder untouched.
  registerMediaImportJobs()
  await drainJobs()
  const imported = getDb().prepare('SELECT status, error FROM media_imports ORDER BY id DESC LIMIT 1').get() as any
  assert.match(imported.error ?? '', /unexpectedly small/)
  assert.deepEqual(readdirSync(sourcePath), ['Alien.1979.Directors.Cut.1080p.BluRay.x264.mkv'], 'a copy leaves the source')
})

test('a copy lands in the library under the library\'s own name, and the folder keeps its file', async () => {
  const tabs = await h.request('GET', '/api/v1/tabs')
  const games = tabs.json.find((t: any) => t.media_type === 'games')
  const gameId = Number(getDb().prepare(`INSERT INTO games (library_id, title, sort_title, year, genres, platforms, status) VALUES (?, 'Chrono Trigger', 'chrono trigger', 1995, '[]', '["Super Nintendo (SNES)"]', 'wanted')`).run(games.id).lastInsertRowid)
  const rom = join(folder, 'Chrono Trigger (USA).sfc')
  writeFileSync(rom, Buffer.alloc(8192, 7))

  const queued = await h.request('POST', '/api/v1/system/manual-imports/import', { body: { tabId: games.id, mediaType: 'games', itemId: gameId, sourcePath: rom, copy: true } })
  assert.equal(queued.status, 201, JSON.stringify(queued.json))
  registerMediaImportJobs()
  await drainJobs()
  const row = getDb().prepare('SELECT status, file_path FROM games WHERE id = ?').get(gameId) as any
  assert.ok(row.file_path, 'the game has its file')
  assert.match(row.file_path, /Chrono Trigger \(1995\)[\\/]Chrono Trigger \(USA\)\.sfc$/)
  assert.ok(existsSync(row.file_path))
  assert.ok(existsSync(rom), 'copied, not moved')

  // Moving is the other choice: the file leaves the folder.
  const moved = join(folder, 'Chrono Trigger (Japan).sfc')
  writeFileSync(moved, Buffer.alloc(8192, 9))
  await h.request('POST', '/api/v1/system/manual-imports/import', { body: { tabId: games.id, mediaType: 'games', itemId: gameId, sourcePath: moved, copy: false, force: true } })
  await drainJobs()
  assert.equal(existsSync(moved), false, 'moved into the library')
})

test('an import is refused into a library of the wrong type, and without a match', async () => {
  const tabs = await h.request('GET', '/api/v1/tabs')
  const series = tabs.json.find((t: any) => t.media_type === 'series')
  const sourcePath = join(folder, 'Alien.1979.Directors.Cut.1080p.BluRay.x264')
  const wrong = await h.request('POST', '/api/v1/system/manual-imports/import', { body: { tabId: series.id, mediaType: 'films', itemId: 1, sourcePath, copy: true } })
  assert.equal(wrong.status, 400)
  const none = await h.request('POST', '/api/v1/system/manual-imports/import', { body: { tabId: films.id, mediaType: 'films', sourcePath, copy: true } })
  assert.equal(none.status, 400)
})
