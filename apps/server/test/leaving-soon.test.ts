import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../src/db.js'
import { sweepLeavingSoon } from '../src/leaving-soon/service.js'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness
let filmId: number
let editionId: number
let siblingEditionId: number
let seasonId: number
let episodes: number[]
let filmFolder: string
let selectedPath: string
let siblingPath: string
let selectedNfo: string

test('leaving-soon fixture boots with registered media paths', async () => {
  h = await startTestApp()
  const db = getDb()
  const filmLibrary = Number((db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id)
  const seriesLibrary = Number((db.prepare("SELECT id FROM libraries WHERE media_type = 'series' LIMIT 1").get() as any).id)
  const root = join(h.dir, 'media')
  mkdirSync(root, { recursive: true })
  db.prepare('INSERT INTO root_folders (library_id, path) VALUES (?, ?)').run(filmLibrary, root)
  db.prepare('INSERT INTO root_folders (library_id, path) VALUES (?, ?)').run(seriesLibrary, root)
  filmFolder = join(root, 'Edition Test')
  mkdirSync(filmFolder)
  selectedPath = join(filmFolder, 'theatrical.mkv')
  selectedNfo = join(filmFolder, 'theatrical.nfo')
  siblingPath = join(filmFolder, 'directors-cut.mkv')
  writeFileSync(selectedPath, 'one')
  writeFileSync(selectedNfo, '<?xml version="1.0"?><movie>\n  <title>Edition Test</title>\n</movie>\n')
  writeFileSync(siblingPath, 'two')
  filmId = Number(db.prepare("INSERT INTO films (library_id, title, status, file_path) VALUES (?, 'Edition Test', 'collected', ?)").run(filmLibrary, selectedPath).lastInsertRowid)
  editionId = Number(db.prepare("INSERT INTO film_editions (film_id, edition_name, status, file_path) VALUES (?, 'Theatrical', 'collected', ?)").run(filmId, selectedPath).lastInsertRowid)
  siblingEditionId = Number(db.prepare("INSERT INTO film_editions (film_id, edition_name, status, file_path) VALUES (?, 'Director Cut', 'collected', ?)").run(filmId, siblingPath).lastInsertRowid)
  db.prepare('UPDATE films SET default_edition_id = ? WHERE id = ?').run(editionId, filmId)

  const seriesId = Number(db.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Completion Test')").run(seriesLibrary).lastInsertRowid)
  seasonId = Number(db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, 1)').run(seriesId).lastInsertRowid)
  episodes = [1, 2].map(number => {
    const path = join(root, `episode-${number}.mkv`); writeFileSync(path, String(number))
    return Number(db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number, status, file_path) VALUES (?, ?, 1, ?, 'downloaded', ?)").run(seriesId, seasonId, number, path).lastInsertRowid)
  })
})

after(async () => { await h?.close() })

test('Sweep settings control grace period and NFO tag', async () => {
  const saved = await h.request('PUT', '/api/v1/leaving-soon/settings', { body: { graceDays: 14, taggingEnabled: true, tagName: 'Watch Soon' } })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.graceDays, 14)
  assert.equal(saved.json.taggingEnabled, true)
  assert.equal(saved.json.tagName, 'Watch Soon')
  const loaded = await h.request('GET', '/api/v1/leaving-soon/settings')
  assert.deepEqual(loaded.json, saved.json)
})

test('film edition uses configured grace and records the watched edition', async () => {
  const enabled = await h.request('PUT', `/api/v1/leaving-soon/film_edition/${editionId}`, { body: { enabled: true } })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.json.item.status, 'armed')
  const watched = await h.request('POST', '/api/v1/player/progress', { body: { type: 'film', id: filmId, editionId, positionSeconds: 100, durationSeconds: 100, completed: true, profileId: 'default' } })
  assert.equal(watched.status, 204)
  const item = (await h.request('GET', `/api/v1/leaving-soon/film_edition/${editionId}`)).json.item
  assert.equal(item.status, 'scheduled')
  assert.equal(item.daysRemaining, 14)
  assert.match(readFileSync(selectedNfo, 'utf8'), /<tag>Watch Soon<\/tag>/)
  assert.equal((getDb().prepare('SELECT edition_id FROM playback_progress WHERE media_type = \'film\' AND media_id = ?').get(filmId) as any).edition_id, editionId)
})

test('changing Sweep settings recalculates and retags scheduled items', async () => {
  await h.request('PUT', '/api/v1/leaving-soon/settings', { body: { graceDays: 21, taggingEnabled: true, tagName: 'Last Chance' } })
  const item = (await h.request('GET', `/api/v1/leaving-soon/film_edition/${editionId}`)).json.item
  assert.equal(item.daysRemaining, 21)
  const nfo = readFileSync(selectedNfo, 'utf8')
  assert.doesNotMatch(nfo, /<tag>Watch Soon<\/tag>/)
  assert.match(nfo, /<tag>Last Chance<\/tag>/)
})

test('season waits until every local episode is watched by one profile', async () => {
  await h.request('PUT', `/api/v1/leaving-soon/season/${seasonId}`, { body: { enabled: true } })
  await h.request('POST', '/api/v1/player/progress', { body: { type: 'episode', id: episodes[0], positionSeconds: 50, durationSeconds: 50, completed: true, profileId: 'alex' } })
  assert.equal((await h.request('GET', `/api/v1/leaving-soon/season/${seasonId}`)).json.item.status, 'armed')
  await h.request('POST', '/api/v1/player/progress', { body: { type: 'episode', id: episodes[1], positionSeconds: 50, durationSeconds: 50, completed: true, profileId: 'alex' } })
  assert.equal((await h.request('GET', `/api/v1/leaving-soon/season/${seasonId}`)).json.item.status, 'scheduled')
  await h.request('DELETE', `/api/v1/player/progress/episode/${episodes[0]}?profile=alex`)
  assert.equal((await h.request('GET', `/api/v1/leaving-soon/season/${seasonId}`)).json.item.status, 'armed')
  await h.request('POST', '/api/v1/player/progress', { body: { type: 'episode', id: episodes[0], positionSeconds: 50, durationSeconds: 50, completed: true, profileId: 'alex' } })
  assert.equal((await h.request('GET', `/api/v1/leaving-soon/season/${seasonId}`)).json.item.status, 'scheduled')
})

test('due deletion removes only the selected edition when a sibling shares its folder', () => {
  getDb().prepare("UPDATE leaving_soon_rules SET delete_after = datetime('now', '-1 minute') WHERE target_type = 'film_edition' AND target_id = ?").run(editionId)
  const result = sweepLeavingSoon(getDb(), new Date())
  assert.equal(result.deleted, 1)
  assert.equal(existsSync(selectedPath), false)
  assert.equal(existsSync(selectedNfo), false)
  assert.equal(existsSync(siblingPath), true)
  assert.equal(existsSync(filmFolder), true)
  assert.equal((getDb().prepare('SELECT file_path FROM film_editions WHERE id = ?').get(editionId) as any).file_path, null)
  assert.equal((getDb().prepare('SELECT file_path FROM film_editions WHERE id = ?').get(siblingEditionId) as any).file_path, siblingPath)
})

test('Keep cancels the pending deletion immediately', async () => {
  const kept = await h.request('POST', `/api/v1/player/leaving-soon/season/${seasonId}/keep`)
  assert.equal(kept.status, 200)
  assert.equal(kept.json.item.status, 'cancelled')
  assert.equal(kept.json.item.enabled, false)
})

test('optional Keep approval leaves media scheduled until an admin approves it', async () => {
  await h.request('PUT', '/api/v1/leaving-soon/settings', { body: { requireKeepApproval: true } })
  await h.request('PUT', `/api/v1/leaving-soon/season/${seasonId}`, { body: { enabled: true } })
  const requested = await h.request('POST', `/api/v1/player/leaving-soon/season/${seasonId}/keep`, { body: { profileId: 'alex' } })
  assert.equal(requested.status, 200)
  assert.equal(requested.json.pending, true)
  assert.equal(requested.json.item.enabled, true)
  const requests = await h.request('GET', '/api/v1/leaving-soon/requests')
  const pending = requests.json.requests.find((request: any) => request.profile_id === 'alex' && request.status === 'pending')
  assert.ok(pending)
  const decided = await h.request('POST', `/api/v1/leaving-soon/requests/${pending.id}/decision`, { body: { decision: 'approved' } })
  assert.equal(decided.status, 200)
  assert.equal((await h.request('GET', `/api/v1/leaving-soon/season/${seasonId}`)).json.item.status, 'cancelled')
})

test('dry run reports due deletion without touching the media', async () => {
  await h.request('PUT', '/api/v1/leaving-soon/settings', { body: { dryRun: true, requireKeepApproval: false } })
  await h.request('PUT', `/api/v1/leaving-soon/film_edition/${siblingEditionId}`, { body: { enabled: true } })
  await h.request('POST', '/api/v1/player/progress', { body: { type: 'film', id: filmId, editionId: siblingEditionId, positionSeconds: 100, durationSeconds: 100, completed: true, profileId: 'default' } })
  getDb().prepare("UPDATE leaving_soon_rules SET delete_after = datetime('now', '-1 minute') WHERE target_type = 'film_edition' AND target_id = ?").run(siblingEditionId)
  const result = sweepLeavingSoon(getDb(), new Date())
  assert.equal(result.dryRun, true)
  assert.equal(result.deleted, 1)
  assert.equal(existsSync(siblingPath), true)
  assert.equal((getDb().prepare('SELECT file_path FROM film_editions WHERE id = ?').get(siblingEditionId) as any).file_path, siblingPath)
})
