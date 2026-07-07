import express from 'express'
import type { AddressInfo } from 'node:net'

/**
 * Offline mock for the non-TMDB metadata providers: MusicBrainz, Cover Art
 * Archive, Fanart.tv (404s), OpenLibrary, Google Books, ComicVine, and
 * IGDB/Twitch. Point the *_BASE_URL env vars at `url` before app creation.
 */
export async function startProviderMock(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.text({ type: 'text/plain' }))

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])
  app.get('/assets/:name', (_req, res) => {
    res.setHeader('Content-Type', 'image/jpeg')
    res.send(jpegBytes)
  })

  let url = ''

  // ── MusicBrainz ────────────────────────────────────────────────────────────
  const RADIOHEAD_MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
  const OKC_RGID = 'b1392450-e666-3926-a536-22c65f834433'

  app.get('/mb/artist', (req, res) => {
    const q = String(req.query.query ?? '').toLowerCase()
    res.json({
      artists: q.includes('radiohead')
        ? [{ id: RADIOHEAD_MBID, name: 'Radiohead', disambiguation: 'UK rock band', score: 100, tags: [{ name: 'rock' }] }]
        : [],
    })
  })
  app.get(`/mb/artist/${RADIOHEAD_MBID}`, (_req, res) => {
    res.json({
      id: RADIOHEAD_MBID,
      name: 'Radiohead',
      'sort-name': 'Radiohead',
      disambiguation: 'UK rock band',
      genres: [{ name: 'alternative rock' }, { name: 'rock' }],
      relations: [],
    })
  })
  app.get('/mb/release-group', (req, res) => {
    if (String(req.query.artist) !== RADIOHEAD_MBID) return res.json({ 'release-groups': [] })
    res.json({
      'release-groups': [{
        id: OKC_RGID,
        title: 'OK Computer',
        'first-release-date': '1997-05-21',
        'primary-type': 'Album',
        'secondary-types': [],
        genres: [{ name: 'alternative rock' }],
      }],
    })
  })
  app.get('/mb/release', (req, res) => {
    if (String(req.query['release-group']) !== OKC_RGID) return res.json({ releases: [] })
    res.json({
      releases: [{
        media: [{
          position: 1,
          tracks: [
            { id: 't1', title: 'Airbag', number: 1, length: 284000 },
            { id: 't2', title: 'Paranoid Android', number: 2, length: 386000 },
          ],
        }],
      }],
    })
  })

  // Cover Art Archive
  app.get('/caa/release-group/:id/front-500', (_req, res) => {
    res.setHeader('Content-Type', 'image/jpeg')
    res.send(jpegBytes)
  })

  // Fanart.tv — no data for anything
  app.get('/fanart/:mbid', (_req, res) => res.status(404).json({ status: 'error' }))

  // ── OpenLibrary ────────────────────────────────────────────────────────────
  app.get('/ol/search/authors.json', (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase()
    res.json({
      docs: q.includes('sanderson')
        ? [{ name: 'Brandon Sanderson', key: 'OL1394865A', top_work: 'Mistborn', work_count: 100 }]
        : [],
    })
  })
  app.get('/ol/authors/OL1394865A.json', (_req, res) => {
    res.json({ name: 'Brandon Sanderson', bio: 'American fantasy author.' })
  })
  app.get('/ol/search.json', (_req, res) => {
    res.json({
      docs: [{
        key: '/works/OL5738147W',
        title: 'Mistborn: The Final Empire',
        author_name: ['Brandon Sanderson'],
        first_publish_year: 2006,
        publish_date: ['2006-07-17'],
        subject: ['Fantasy', 'Magic'],
        publisher: ['Tor Books'],
        number_of_pages_median: 541,
        series_name: ['Mistborn'],
        series_position: ['1'],
      }],
    })
  })
  app.get('/ol/works/OL5738147W.json', (_req, res) => {
    res.json({ description: 'A world where ash falls from the sky.' })
  })

  // Google Books — empty; OpenLibrary carries the fixtures
  app.get('/gb/volumes', (_req, res) => res.json({ items: [] }))

  // ── ComicVine ──────────────────────────────────────────────────────────────
  const cvSeries = () => ({
    resource_type: 'volume',
    id: 43113,
    name: 'Saga',
    start_year: '2012',
    publisher: { name: 'Image Comics' },
    description: '<p>An epic space opera.</p>',
    image: { medium_url: `${url}/assets/saga.jpg` },
    count_of_issues: 2,
  })
  app.get('/cv/search', (req, res) => {
    const q = String(req.query.query ?? '').toLowerCase()
    res.json({ status_code: 1, results: q.includes('saga') ? [cvSeries()] : [] })
  })
  app.get('/cv/volume/4050-43113/', (_req, res) => {
    res.json({ status_code: 1, results: cvSeries() })
  })
  app.get('/cv/issues/', (_req, res) => {
    res.json({
      status_code: 1,
      results: [
        { id: 301101, issue_number: '1', name: 'Chapter One', cover_date: '2012-03-14', description: '<p>First issue.</p>', image: { medium_url: `${url}/assets/saga1.jpg` } },
        { id: 301102, issue_number: '2', name: 'Chapter Two', cover_date: '2012-04-18', description: '<p>Second issue.</p>', image: { medium_url: `${url}/assets/saga2.jpg` } },
      ],
    })
  })

  // ── IGDB / Twitch ──────────────────────────────────────────────────────────
  app.post('/twitch/oauth2/token', (_req, res) => {
    res.json({ access_token: 'mock-token', expires_in: 3600 })
  })
  app.post('/igdb/games', (req, res) => {
    const body = String(req.body ?? '')
    const game = {
      id: 1942,
      name: 'The Witcher 3: Wild Hunt',
      first_release_date: 1431993600,
      summary: 'An open-world RPG.',
      rating: 93.4,
      cover: { url: `${url}/assets/witcher-cover.jpg` },
      screenshots: [{ url: `${url}/assets/witcher-shot.jpg` }],
      genres: [{ name: 'Role-playing (RPG)' }],
      platforms: [{ name: 'PC (Microsoft Windows)' }, { name: 'PlayStation 4' }],
      involved_companies: [
        { developer: true, publisher: false, company: { name: 'CD Projekt RED' } },
        { developer: false, publisher: true, company: { name: 'CD Projekt' } },
      ],
    }
    if (body.includes('search')) {
      return res.json(body.toLowerCase().includes('witcher') ? [game] : [])
    }
    if (body.includes('where id = 1942')) {
      return res.json([game])
    }
    res.json([])
  })

  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port
  url = `http://127.0.0.1:${port}`
  return {
    url,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** Env pointing every provider at the mock. Pass to startTestApp. */
export function providerEnv(url: string): Record<string, string> {
  return {
    MUSICBRAINZ_BASE_URL: `${url}/mb`,
    COVERART_BASE_URL: `${url}/caa`,
    FANART_BASE_URL: `${url}/fanart`,
    OPENLIBRARY_BASE_URL: `${url}/ol`,
    GOOGLE_BOOKS_BASE_URL: `${url}/gb`,
    COMICVINE_BASE_URL: `${url}/cv`,
    COMICVINE_API_KEY: 'test-cv-key',
    IGDB_BASE_URL: `${url}/igdb`,
    TWITCH_OAUTH_URL: `${url}/twitch/oauth2/token`,
    IGDB_CLIENT_ID: 'test-igdb-id',
    IGDB_CLIENT_SECRET: 'test-igdb-secret',
  }
}
