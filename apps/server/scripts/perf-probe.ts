/**
 * Statement-count probe.
 *
 * Boots the API against a throwaway database, seeds a synthetic library at two
 * sizes, replays a set of routes against each, and reports the SQL statement
 * count per request.
 *
 * The point is the growth column, not the absolute count. better-sqlite3 is
 * synchronous, so a route's cost is dominated by how many statements it issues;
 * a route whose statement count is flat as the library grows 10× is fine at any
 * size, and one that tracks row count is an N+1 that will feel broken on a real
 * library however fast it looks on a dev box with four films in it. A threshold
 * alone cannot tell those apart — two sizes can.
 *
 *   corepack pnpm --filter archivist-server exec tsx scripts/perf-probe.ts
 *   … --sizes 40,400   --routes /films,/series
 *
 * Nothing here touches a real database: ARCHIVIST_DB is redirected to a temp
 * directory that is deleted on exit.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

process.env.ARCHIVIST_PERF_TRACE = '1'
process.env.DEFINITIONS_OFFLINE = 'true'
process.env.LOG_LEVEL = 'error'

const dir = mkdtempSync(join(tmpdir(), 'archivist-perf-'))
process.env.ARCHIVIST_DB = join(dir, 'archivist.sqlite')
process.env.ARCHIVIST_CATALOGUE_DB = join(dir, 'catalogue', 'catalogue.sqlite')
process.env.ARCHIVIST_MEDIA_BASE = join(dir, 'media')
process.env.ARCHIVIST_DEFINITIONS_PATH = join(dir, 'definitions')
const apiKey = 'archivist-perf-probe-key'
process.env.ARCHIVIST_API_TOKEN = apiKey

const { loadConfig } = await import('../src/config.js')
const { createApp } = await import('../src/app.js')
const { getDb } = await import('../src/db.js')
const { closeAllDatabases } = await import('@archivist/db')

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const sizes = arg('sizes', '40,400').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0)
const routeFilter = arg('routes', '').split(',').map(s => s.trim()).filter(Boolean)

/** Routes worth probing: the ones a user hits by browsing, not by importing. */
const ROUTES: Array<{ path: string; scope: 'films' | 'series' | 'global' }> = [
  { path: '/api/v1/films', scope: 'films' },
  { path: '/api/v1/films?limit=100', scope: 'films' },
  { path: '/api/v1/series', scope: 'series' },
  { path: '/api/v1/series?limit=100', scope: 'series' },
  { path: '/api/v1/dashboard/stats', scope: 'films' },
  { path: '/api/v1/player/libraries', scope: 'global' },
  { path: '/api/v1/player/home', scope: 'global' },
  { path: '/api/v1/system/overview', scope: 'global' },
  { path: '/api/v1/leaving-soon', scope: 'global' },
  { path: '/api/v1/collections', scope: 'films' },
]

/**
 * Seeds `count` films and `count / 10` series of ten episodes each. One
 * transaction: per-row commits would dominate the run time and tell us nothing
 * about the routes.
 */
function seed(count: number, filmsLib: number, seriesLib: number): void {
  const db = getDb()
  db.exec('DELETE FROM episodes; DELETE FROM seasons; DELETE FROM series; DELETE FROM films')
  const insertFilm = db.prepare(
    'INSERT INTO films (library_id, tmdb_id, title, sort_title, year, status, monitored, file_path, overview) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
  )
  const insertSeries = db.prepare(
    'INSERT INTO series (library_id, tvdb_id, title, sort_title, year, status, monitored) VALUES (?, ?, ?, ?, ?, ?, 1)',
  )
  const insertSeason = db.prepare('INSERT INTO seasons (series_id, season_number, episode_count) VALUES (?, ?, ?)')
  const insertEpisode = db.prepare(
    'INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, monitored, air_date, file_path) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
  )
  db.transaction(() => {
    for (let i = 1; i <= count; i += 1) {
      const title = `Probe Film ${String(i).padStart(5, '0')}`
      insertFilm.run(filmsLib, 900000 + i, title, title, 1990 + (i % 35), i % 3 === 0 ? 'wanted' : 'downloaded', `${dir}/media/${title}.mkv`, 'seeded')
    }
    const seriesCount = Math.max(1, Math.round(count / 10))
    for (let s = 1; s <= seriesCount; s += 1) {
      const title = `Probe Series ${String(s).padStart(5, '0')}`
      const seriesId = Number(insertSeries.run(seriesLib, 800000 + s, title, title, 2000 + (s % 25), 'continuing').lastInsertRowid)
      const seasonId = Number(insertSeason.run(seriesId, 1, 10).lastInsertRowid)
      for (let e = 1; e <= 10; e += 1) {
        insertEpisode.run(seriesId, seasonId, 1, e, `Episode ${e}`, e % 2 === 0 ? 'downloaded' : 'missing', '2024-01-01', `${dir}/media/${title}-E${e}.mkv`)
      }
    }
  })()
}

const config = loadConfig(join(dir, 'nonexistent-config.toml'))
const instance = await createApp({ config, envPath: join(dir, '.env') })
const server = instance.app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const libraries = getDb().prepare('SELECT id, media_type FROM libraries').all() as Array<{ id: number; media_type: string }>
const libFor = (type: string) => libraries.find(l => l.media_type === type)?.id ?? 0

type Measurement = { queries: number; ms: number; status: number; bytes: number }

/**
 * One request, measured from the server's own tally. The perf middleware
 * stamps X-Perf-Queries onto every traced response, so the probe reads the
 * count the server actually recorded rather than approximating it from here.
 */
async function probe(path: string, scope: 'films' | 'series' | 'global'): Promise<Measurement> {
  const headers: Record<string, string> = { 'x-api-key': apiKey }
  if (scope !== 'global') headers['x-tab-context'] = String(libFor(scope))
  const response = await fetch(`${baseUrl}${path}`, { headers })
  const body = await response.text()
  return {
    queries: Number(response.headers.get('x-perf-queries') ?? 0),
    ms: Number(response.headers.get('x-perf-ms') ?? 0),
    status: response.status,
    bytes: Buffer.byteLength(body),
  }
}

const results = new Map<string, number[]>()
const statuses = new Map<string, number>()
const timings = new Map<string, number[]>()
const payloads = new Map<string, number[]>()

for (const size of sizes) {
  seed(size, libFor('films'), libFor('series'))
  for (const route of ROUTES) {
    if (routeFilter.length && !routeFilter.some(f => route.path.includes(f))) continue
    // One warm-up: first touch of a lazily-migrated store pays its DDL once,
    // and charging that to the smaller size would fake a flat curve.
    await probe(route.path, route.scope)
    const measurement = await probe(route.path, route.scope)
    results.set(route.path, [...(results.get(route.path) ?? []), measurement.queries])
    timings.set(route.path, [...(timings.get(route.path) ?? []), measurement.ms])
    payloads.set(route.path, [...(payloads.get(route.path) ?? []), measurement.bytes])
    statuses.set(route.path, measurement.status)
  }
}

const first = sizes[0]
const last = sizes[sizes.length - 1]
const rowGrowth = last / first

console.log(`\nStatement counts per request — library seeded at ${sizes.join(' then ')} films\n`)
console.log(`${'route'.padEnd(34)}${sizes.map(s => `n=${s}`.padStart(9)).join('')}${'growth'.padStart(9)}${'payload'.padStart(11)}  verdict`)
console.log('-'.repeat(34 + sizes.length * 9 + 20 + 26))
const rows = [...results.entries()].sort((a, b) => (b[1].at(-1) ?? 0) - (a[1].at(-1) ?? 0))
for (const [route, counts] of rows) {
  const from = counts[0] || 1
  const to = counts[counts.length - 1] || 0
  const growth = to / from
  // A route whose statement count grows with the library is an N+1: the fix is
  // to fold the per-row query into the list query or a single IN (…) lookup.
  const status = statuses.get(route) ?? 0
  const verdict = status >= 400 ? `HTTP ${status} — not measured`
    : growth >= rowGrowth * 0.5 ? 'N+1 — scales with rows'
    : growth > 1.5 ? 'partially scales — check'
    : to > 20 ? 'flat but heavy'
    : 'flat'
  const ms = timings.get(route)?.at(-1) ?? 0
  const bytes = payloads.get(route)?.at(-1) ?? 0
  // A flat statement count with a payload that grows with the library is not a
  // server problem — it is an unpaginated endpoint, and the fix is on the
  // client (paginate, or select only the fields the grid renders).
  const payload = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`
  console.log(`${route.padEnd(34)}${counts.map(c => String(c).padStart(9)).join('')}${`${growth.toFixed(2)}x`.padStart(9)}${payload.padStart(11)}  ${verdict}${ms ? `, ${ms}ms` : ''}`)
}
console.log('')

await new Promise<void>(resolve => server.close(() => resolve()))
await instance.stop()
closeAllDatabases()
rmSync(dir, { recursive: true, force: true })
