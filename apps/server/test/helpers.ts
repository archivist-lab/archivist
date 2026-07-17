import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../src/config.js'
import { createApp, type AppInstance } from '../src/app.js'

export interface TestHarness {
  baseUrl: string
  dir: string
  instance: AppInstance
  authHeaders: Record<string, string>
  request: (method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; json: any; text: string; headers: http.IncomingHttpHeaders }>
  close: () => Promise<void>
}

/** Boots the Archivist app on an ephemeral port with a temp database and media root. */
export async function startTestApp(options: { apiKey?: string | null; autoAuth?: boolean; env?: Record<string, string> } = {}): Promise<TestHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'archivist-test-'))

  process.env.ARCHIVIST_DB = join(dir, 'archivist.sqlite')
  process.env.ARCHIVIST_MEDIA_BASE = join(dir, 'media')
  process.env.DEFINITIONS_OFFLINE = 'true'
  process.env.ARCHIVIST_DEFINITIONS_PATH = join(dir, 'definitions')
  const apiKey = options.apiKey === null ? '' : options.apiKey ?? 'archivist-test-service-key'
  if (apiKey) process.env.ARCHIVIST_API_TOKEN = apiKey
  else delete process.env.ARCHIVIST_API_TOKEN
  const authHeaders = options.autoAuth === false || !apiKey ? {} : { 'x-api-key': apiKey }
  for (const [k, v] of Object.entries(options.env ?? {})) process.env[k] = v

  const config = loadConfig(join(dir, 'nonexistent-config.toml'))
  const instance = await createApp({ config, envPath: join(dir, '.env'), skipBackground: true })

  const server = instance.app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  const request: TestHarness['request'] = async (method, path, opts = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...authHeaders,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text, headers: Object.fromEntries(res.headers.entries()) as http.IncomingHttpHeaders }
  }

  const close = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await instance.stop()
    const { closeAllDatabases } = await import('@archivist/db')
    closeAllDatabases()
    rmSync(dir, { recursive: true, force: true })
  }

  return { baseUrl, dir, instance, authHeaders, request, close }
}

/** Reads one SSE frame (event + data) from a streaming endpoint, then aborts. */
export async function readFirstSseEvent(url: string, headers: Record<string, string> = {}): Promise<{ event: string | null; data: string | null }> {
  const controller = new AbortController()
  const res = await fetch(url, { headers, signal: controller.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (let i = 0; i < 20; i++) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('\n\n')) break
    }
  } finally {
    controller.abort()
  }
  const frame = buffer.split('\n\n')[0] ?? ''
  const event = frame.match(/^event: (.*)$/m)?.[1] ?? null
  const data = frame.match(/^data: (.*)$/m)?.[1] ?? null
  return { event, data }
}

/** Minimal TMDB mock covering the endpoints the film/series flows use. */
export async function startTmdbMock(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
  app.get('/assets/:name', (_req, res) => {
    res.setHeader('Content-Type', 'image/jpeg')
    res.send(jpegBytes)
  })

  const movie = {
    id: 603,
    imdb_id: 'tt0133093',
    title: 'The Matrix',
    original_title: 'The Matrix',
    original_language: 'en',
    release_date: '1999-03-31',
    overview: 'A computer hacker learns about the true nature of reality.',
    runtime: 136,
    genres: [{ name: 'Action' }, { name: 'Science Fiction' }],
    poster_path: null as string | null,
    backdrop_path: null as string | null,
    vote_average: 8.2,
    popularity: 80,
    production_companies: [{ name: 'Warner Bros.' }],
    production_countries: [{ iso_3166_1: 'US' }],
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '1999-03-31', certification: 'R' }] }] },
    images: { logos: [], backdrops: [], posters: [] },
    credits: { cast: [{ id: 1, name: 'Keanu Reeves', character: 'Neo', profile_path: null }], crew: [{ id: 2, name: 'Lana Wachowski', job: 'Director', profile_path: null }] },
    videos: { results: [] },
    alternative_titles: { titles: [] },
  }

  const tvShow = {
    id: 1396,
    name: 'Breaking Bad',
    original_name: 'Breaking Bad',
    original_language: 'en',
    first_air_date: '2008-01-20',
    overview: 'A chemistry teacher turns to a life of crime.',
    status: 'Ended',
    episode_run_time: [47],
    genres: [{ name: 'Drama' }],
    networks: [{ name: 'AMC' }],
    origin_country: ['US'],
    poster_path: null as string | null,
    backdrop_path: null as string | null,
    vote_average: 8.9,
    seasons: [
      { season_number: 1, name: 'Season 1', overview: '', poster_path: null, episode_count: 2, air_date: '2008-01-20' },
      { season_number: 2, name: 'Season 2', overview: '', poster_path: null, episode_count: 2, air_date: '2009-03-08' },
    ],
    images: { logos: [], backdrops: [], posters: [] },
    credits: { cast: [{ id: 10, name: 'Bryan Cranston', character: 'Walter White', profile_path: null }], crew: [] },
    content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
    external_ids: { tvdb_id: 81189 },
    last_episode_to_air: { air_date: '2013-09-29' },
  }
  const tvSeasonEpisodes: Record<number, any[]> = {
    1: [
      { episode_number: 1, name: 'Pilot', overview: 'ep1', air_date: '2008-01-20', runtime: 58, still_path: null },
      { episode_number: 2, name: "Cat's in the Bag...", overview: 'ep2', air_date: '2008-01-27', runtime: 48, still_path: null },
    ],
    2: [
      { episode_number: 1, name: 'Seven Thirty-Seven', overview: 's2e1', air_date: '2009-03-08', runtime: 47, still_path: null },
      { episode_number: 2, name: 'Grilled', overview: 's2e2', air_date: '2009-03-15', runtime: 47, still_path: null },
    ],
  }

  app.get('/search/movie', (req, res) => {
    const q = String(req.query.query ?? '').toLowerCase()
    res.json({ results: q.includes('matrix') ? [movie] : [] })
  })
  app.get('/search/tv', (req, res) => {
    const q = String(req.query.query ?? '').toLowerCase()
    res.json({ results: q.includes('breaking') ? [tvShow] : [] })
  })
  app.get('/v1/tvdb/shows/en/:id', (req, res) => {
    if (Number(req.params.id) !== 81189) return res.status(404).json({ error: 'not found' })
    res.json({ episodes: Object.entries(tvSeasonEpisodes).flatMap(([season, episodes]) =>
      episodes.map((episode, index) => ({
        tvdbId: Number(season) * 100 + index + 1,
        seasonNumber: Number(season),
        episodeNumber: episode.episode_number,
        airDate: episode.air_date,
        airDateUtc: `${episode.air_date}T02:00:00Z`,
      }))) })
  })
  app.get('/tv/:id/season/:n', (req, res) => {
    res.json({ episodes: tvSeasonEpisodes[parseInt(req.params.n, 10)] ?? [] })
  })
  app.get('/tv/:id/season/:n/images', (_req, res) => {
    res.json({ posters: [{ file_path: '/mock-season-poster.jpg', iso_639_1: 'en', width: 1000, height: 1500 }] })
  })
  app.get('/tv/:id/season/:n/episode/:episode/images', (_req, res) => {
    res.json({ stills: [{ file_path: '/mock-episode-still.jpg', iso_639_1: null, width: 1920, height: 1080 }] })
  })
  app.get('/tv/:id', (req, res) => {
    if (parseInt(req.params.id, 10) === 1396) return res.json(tvShow)
    res.status(404).json({ status_message: 'not found' })
  })
  app.get('/movie/:id/images', (_req, res) => {
    res.json({ posters: [{ file_path: '/mock-poster.jpg', iso_639_1: 'en', width: 500, height: 750 }], backdrops: [], logos: [] })
  })
  app.get('/movie/:id', (req, res) => {
    if (parseInt(req.params.id, 10) === 603) return res.json(movie)
    res.status(404).json({ status_message: 'not found' })
  })

  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  // Full URLs pass through tmdbImageUrl untouched, so the asset pipeline
  // downloads from this mock instead of image.tmdb.org.
  movie.poster_path = `${url}/assets/poster.jpg`
  movie.backdrop_path = `${url}/assets/backdrop.jpg`
  return {
    url,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
