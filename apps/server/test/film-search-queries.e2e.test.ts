import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { startTestApp, type TestHarness } from './helpers.js'

/**
 * The Deep Scan path end to end, against a fake Torznab indexer that behaves
 * like a real tracker's full-text index: every query token must match a whole
 * word in the release name.
 *
 * That is what makes this an e2e test rather than two unit tests. A catalogue
 * title of "Kill Bill: Vol. 1" has to survive BOTH halves — the query has to
 * reach the tracker in a spelling that returns the release, and the release has
 * to survive title validation on the way back. Fixing only the second half
 * still finds nothing, because a tracker indexing whole words never returns
 * "Kill.Bill.Volume.1" for a query that says "Vol".
 */

const CATALOGUE = { title: 'Kill Bill: Vol. 1', year: 2003 }

const WANTED = [
  'Kill.Bill.Volume.1.2003.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-SARTRE',
  'Kill Bill: Volume 1 (2003) [1080p] [BluRay] [YTS.MX]',
  'Kill.Bill.Vol.1.2003.1080p.BluRay.x265.10bit.QxR',
]
const UNWANTED = [
  'Kill.Bill.Vol.2.2004.1080p.BluRay.x265.10bit.QxR',
  'Kill.Bill.The.Whole.Bloody.Affair.2011.1080p.WEB-DL',
]
const CARRIED = [...WANTED, ...UNWANTED]

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function trackerSearch(query: string): string[] {
  const terms = words(query)
  return CARRIED.filter(title => {
    const have = new Set(words(title))
    return terms.every(term => have.has(term))
  })
}

function feed(results: string[]): string {
  const items = results.map((title, index) => `
    <item>
      <title>${title.replace(/&/g, '&amp;')}</title>
      <guid>fake-${index}</guid>
      <link>magnet:?xt=urn:btih:${String(index).padStart(40, '0')}</link>
      <size>8000000000</size>
      <torznab:attr name="seeders" value="120"/>
      <torznab:attr name="leechers" value="4"/>
      <torznab:attr name="category" value="2040"/>
    </item>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel><response offset="0" total="${results.length}"/>${items}</channel>
</rss>`
}

let harness: TestHarness | undefined
let fake: http.Server | undefined

after(async () => {
  await harness?.close()
  if (fake) {
    // undici holds the connection open, so a plain close() would wait out the
    // keep-alive timeout and leave the suite hanging after the test passed.
    fake.closeAllConnections()
    await new Promise<void>(resolve => fake!.close(() => resolve()))
  }
})

test('a Deep Scan finds a punctuated catalogue title spelled differently by the tracker', async () => {
  const queries: string[] = []
  fake = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://indexer.invalid')
    res.setHeader('Content-Type', 'application/xml')
    if (url.searchParams.get('t') === 'caps') {
      return res.end(`<?xml version="1.0"?><caps><searching>
        <search available="yes" supportedParams="q"/>
        <movie-search available="yes" supportedParams="q,imdbid"/>
      </searching><categories><category id="2000" name="Movies"/></categories></caps>`)
    }
    const q = url.searchParams.get('q') ?? ''
    queries.push(q)
    res.end(feed(trackerSearch(q)))
  })
  // The app's HTTP client pools connections to this origin. Without a short
  // keep-alive the sockets outlive the test and node:test waits out the whole
  // idle timeout before the suite exits.
  fake.keepAliveTimeout = 1
  await new Promise<void>(resolve => fake!.listen(0, '127.0.0.1', resolve))
  fake.unref()
  const indexerUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

  harness = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()

  db.prepare(`
    INSERT INTO indexers_ts (id, name, protocol, enabled, priority, base_url, api_path, capabilities)
    VALUES ('fake', 'FakeTracker', 'torznab', 1, 1, ?, '/api', '{}')
  `).run(indexerUrl)
  const { reconcileIndexerStore } = await import('../src/services/indexer-bridge.js')
  reconcileIndexerStore(db)

  const libraryId = Number(db.prepare(`
    INSERT INTO libraries (name, media_type, db_path) VALUES ('Punctuated Films', 'films', 'punctuated-films')
  `).run().lastInsertRowid)
  db.prepare("INSERT INTO films (library_id, title, year, status) VALUES (?, ?, ?, 'wanted')")
    .run(libraryId, CATALOGUE.title, CATALOGUE.year)

  const params = new URLSearchParams({ q: CATALOGUE.title, year: String(CATALOGUE.year), tier: 'Tier 1' })
  // agent: false — the endpoint is an event stream, and a pooled keep-alive
  // socket to it outlives the assertions and stalls the suite's exit.
  const stream = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.get(`${harness!.baseUrl}/api/v1/films/releases/search?${params}`, {
      agent: false,
      headers: { ...harness!.authHeaders, 'x-tab-context': String(libraryId) },
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
  })
  assert.equal(stream.status, 200)

  const shown = new Set<string>()
  for (const line of stream.body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = JSON.parse(line.slice(6))
    if (Array.isArray(payload)) for (const release of payload) shown.add(release.title)
  }

  for (const title of WANTED) assert.ok(shown.has(title), `missing from the scan: ${title}`)
  for (const title of UNWANTED) assert.ok(!shown.has(title), `wrongly matched: ${title}`)

  // The queries themselves: the tracker has to be asked in a spelling it can answer.
  assert.ok(queries.includes('Kill Bill Vol 1 2003'), 'punctuation-free spelling was never tried')
  assert.ok(queries.includes('Kill Bill Volume 1 2003'), 'the tracker\'s own word choice was never tried')
})
