import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'
import { startProviderMock, providerEnv } from './provider-mock.js'

let h: TestHarness
let mock: Awaited<ReturnType<typeof startProviderMock>>
let comicsHeaders: Record<string, string>
let gamesHeaders: Record<string, string>
let comicSeriesId: number
let issueId: number
let gameId: number

test('boot with provider mocks', async () => {
  mock = await startProviderMock()
  h = await startTestApp({ env: providerEnv(mock.url) })
  const tabs = await h.request('GET', '/api/v1/tabs')
  comicsHeaders = { 'x-tab-context': String(tabs.json.find((t: any) => t.media_type === 'comics').id) }
  gamesHeaders = { 'x-tab-context': String(tabs.json.find((t: any) => t.media_type === 'games').id) }
})

after(async () => {
  await h?.close()
  await mock?.close()
})

// ── Comics ────────────────────────────────────────────────────────────────────

test('comics lookup returns ComicVine results with alreadyAdded', async () => {
  const res = await h.request('GET', '/api/v1/comics/lookup?q=saga', { headers: comicsHeaders })
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 1)
  assert.equal(res.json[0].name, 'Saga')
  assert.equal(res.json[0].alreadyAdded, false)
})

test('add comic series persists series and issues', async () => {
  const res = await h.request('POST', '/api/v1/comics/series', { body: { cvId: 43113 }, headers: comicsHeaders })
  assert.equal(res.status, 201)
  comicSeriesId = res.json.id
  assert.equal(res.json.title, 'Saga')
  assert.equal(res.json.publisher, 'Image Comics')
  assert.equal(res.json.issues.length, 2)
  issueId = res.json.issues[0].id
  assert.equal(res.json.issues[0].status, 'missing')

  const dup = await h.request('POST', '/api/v1/comics/series', { body: { cvId: 43113 }, headers: comicsHeaders })
  assert.equal(dup.status, 409)
})

test('comic series list and detail preserve legacy shapes', async () => {
  const list = await h.request('GET', '/api/v1/comics/series', { headers: comicsHeaders })
  assert.equal(list.json.length, 1)
  assert.equal(list.json[0].issue_count, 2)

  const detail = await h.request('GET', `/api/v1/comics/series/${comicSeriesId}`, { headers: comicsHeaders })
  assert.equal(detail.json.issues.length, 2)

  const missing = await h.request('GET', '/api/v1/comics/series/424242', { headers: comicsHeaders })
  assert.equal(missing.status, 404)
})

test('comic issue update persists status vocabulary', async () => {
  const res = await h.request('PUT', `/api/v1/comics/issues/${issueId}`, {
    body: { monitored: false, status: 'ignored' },
    headers: comicsHeaders,
  })
  assert.equal(res.json.monitored, false)
  assert.equal(res.json.status, 'ignored')

  const back = await h.request('PUT', `/api/v1/comics/issues/${issueId}`, {
    body: { monitored: true, status: 'missing' },
    headers: comicsHeaders,
  })
  assert.equal(back.json.status, 'missing')
})

test('comic issue acquisition history, reject, and repair', async () => {
  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE comic_issues SET status = 'acquiring', info_hash = ?, current_release_title = 'Saga.001.CBZ-TEST' WHERE id = ?").run('f'.repeat(40), issueId)

  const reject = await h.request('POST', `/api/v1/comics/issues/${issueId}/reject-current-release`, { body: {}, headers: comicsHeaders })
  assert.equal(reject.json.success, true)

  const history = await h.request('GET', `/api/v1/comics/issues/${issueId}/acquisition-history`, { headers: comicsHeaders })
  assert.equal(history.json.blocks.length, 1)

  getDb().prepare("UPDATE comic_issues SET status = 'collected', file_path = '/nonexistent/saga1.cbz', current_release_title = 'Saga.001.v2.CBZ-TEST' WHERE id = ?").run(issueId)
  const repair = await h.request('POST', `/api/v1/comics/issues/${issueId}/repair`, { body: {}, headers: comicsHeaders })
  assert.equal(repair.json.status, 'missing')
  assert.equal(repair.json.file_path, null)
})

test('comics refresh returns background envelope', async () => {
  const res = await h.request('POST', '/api/v1/comics/refresh', { body: {}, headers: comicsHeaders })
  assert.equal(res.json.success, true)
})

// ── Games ─────────────────────────────────────────────────────────────────────

test('games lookup returns IGDB results with alreadyAdded', async () => {
  const res = await h.request('GET', '/api/v1/games/lookup?q=witcher', { headers: gamesHeaders })
  assert.equal(res.status, 200)
  assert.equal(res.json.length, 1)
  assert.equal(res.json[0].title, 'The Witcher 3: Wild Hunt')
  assert.equal(res.json[0].alreadyAdded, false)
})

test('add game persists metadata; duplicate add merges platforms', async () => {
  const res = await h.request('POST', '/api/v1/games', {
    body: { igdbId: 1942, platforms: ['PC (Microsoft Windows)'] },
    headers: gamesHeaders,
  })
  assert.equal(res.status, 201)
  gameId = res.json.id
  assert.equal(res.json.title, 'The Witcher 3: Wild Hunt')
  assert.equal(res.json.status, 'wanted')
  assert.equal(res.json.developer, 'CD Projekt RED')
  assert.equal(res.json.publisher, 'CD Projekt')
  assert.deepEqual(res.json.platforms, ['PC (Microsoft Windows)'])

  const merge = await h.request('POST', '/api/v1/games', {
    body: { igdbId: 1942, platforms: ['PlayStation 4'] },
    headers: gamesHeaders,
  })
  assert.equal(merge.status, 200)
  assert.deepEqual(merge.json.platforms.sort(), ['PC (Microsoft Windows)', 'PlayStation 4'])
})

test('game list/detail/update preserve legacy vocabulary', async () => {
  const list = await h.request('GET', '/api/v1/games', { headers: gamesHeaders })
  assert.equal(list.json.length, 1)
  assert.equal(list.json[0].releaseDate, '2015-05-19')

  const updated = await h.request('PUT', `/api/v1/games/${gameId}`, {
    body: { status: 'downloaded', monitored: false },
    headers: gamesHeaders,
  })
  assert.equal(updated.json.status, 'downloaded')

  const missing = await h.request('GET', '/api/v1/games/424242', { headers: gamesHeaders })
  assert.equal(missing.status, 404)
})

test('game acquisition history, reject, and repair', async () => {
  const { getDb } = await import('../src/db.js')
  getDb().prepare("UPDATE games SET status = 'downloading', info_hash = ?, current_release_title = 'The.Witcher.3.GOG-TEST' WHERE id = ?").run('1'.repeat(40), gameId)

  const reject = await h.request('POST', `/api/v1/games/${gameId}/reject-current-release`, { body: {}, headers: gamesHeaders })
  assert.equal(reject.json.success, true)

  const history = await h.request('GET', `/api/v1/games/${gameId}/acquisition-history`, { headers: gamesHeaders })
  assert.equal(history.json.blocks.length, 1)

  getDb().prepare("UPDATE games SET status = 'downloaded', file_path = '/nonexistent/witcher3', current_release_title = 'The.Witcher.3.FITGIRL-TEST' WHERE id = ?").run(gameId)
  const repair = await h.request('POST', `/api/v1/games/${gameId}/repair`, { body: {}, headers: gamesHeaders })
  assert.equal(repair.json.status, 'missing')
})

test('games refresh returns background envelope', async () => {
  const res = await h.request('POST', '/api/v1/games/refresh', { body: {}, headers: gamesHeaders })
  assert.equal(res.json.success, true)
})

test('delete comic series and game with cascade + 204', async () => {
  const delSeries = await h.request('DELETE', `/api/v1/comics/series/${comicSeriesId}`, { headers: comicsHeaders })
  assert.equal(delSeries.status, 204)

  const delGame = await h.request('DELETE', `/api/v1/games/${gameId}`, { headers: gamesHeaders })
  assert.equal(delGame.status, 204)

  const { getDb } = await import('../src/db.js')
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM comic_issues WHERE series_id = ?').get(comicSeriesId) as any).n, 0)
})
