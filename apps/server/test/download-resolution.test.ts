import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDownloadUrl } from '@torrentstack/indexer-engine'
import type { DefinitionEntry } from '@torrentstack/indexer-engine'
import { createServer } from 'node:http'

/**
 * The grab path used to guess at a details page's HTML. Definitions describe
 * how to reach the file in their `download` block; these cover the shapes that
 * appear across the bundled definitions.
 */

function definition(download: unknown, links: string[]): DefinitionEntry {
  return {
    id: 'demo', name: 'Demo', description: '', language: 'en-us', type: 'public',
    links, legacyLinks: [], categories: [], settings: [], searchModes: ['search'],
    raw: { id: 'demo', name: 'Demo', download } as never,
  }
}

async function withPage(html: string, run: (base: string) => Promise<void>) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try { await run(base) } finally { await new Promise<void>(r => server.close(() => r())) }
}

test('a magnet is taken straight from the selector the definition names', async () => {
  const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example'
  await withPage(`<html><body><ul><li><a href="${magnet}">Magnet</a></li></ul></body></html>`, async base => {
    const entry = definition({ selectors: [{ selector: 'ul li a[href^="magnet:"]', attribute: 'href' }] }, [base])
    const resolved = await resolveDownloadUrl(entry, `${base}/torrent/1/example/`, { settings: { sitelink: base } })
    assert.equal(resolved, magnet)
  })
})

test('selectors are tried in order until one matches', async () => {
  await withPage('<html><body><a class="second" href="/download/1.torrent">Get</a></body></html>', async base => {
    const entry = definition({
      selectors: [
        { selector: 'a.first', attribute: 'href' },
        { selector: 'a.second', attribute: 'href' },
      ],
    }, [base])
    const resolved = await resolveDownloadUrl(entry, `${base}/torrent/1/`, { settings: { sitelink: base } })
    assert.equal(resolved, `${base}/download/1.torrent`, 'a relative href resolves against the site')
  })
})

test('a definition that publishes only an infohash yields a magnet', async () => {
  const hash = 'fedcba9876543210fedcba9876543210fedcba98'
  await withPage(`<html><body><span id="hash">${hash}</span><h1 id="t">Example Release</h1></body></html>`, async base => {
    const entry = definition({
      infohash: { hash: { selector: '#hash' }, title: { selector: '#t' } },
    }, [base])
    const resolved = await resolveDownloadUrl(entry, `${base}/torrent/1/`, { settings: { sitelink: base } })
    assert.equal(resolved, `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent('Example Release')}`)
  })
})

test('a magnet URL is returned untouched, and a definition without a download block resolves to nothing', async () => {
  const magnet = 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111'
  const entry = definition({ selectors: [{ selector: 'a' }] }, ['http://example.invalid'])
  assert.equal(await resolveDownloadUrl(entry, magnet, { settings: {} }), magnet)

  const bare = definition(undefined, ['http://example.invalid'])
  assert.equal(await resolveDownloadUrl(bare, 'http://example.invalid/x', { settings: {} }), null)
})

test('a page with no matching link resolves to null rather than a wrong guess', async () => {
  await withPage('<html><body><p>Nothing here</p></body></html>', async base => {
    const entry = definition({ selectors: [{ selector: 'a[href^="magnet:"]', attribute: 'href' }] }, [base])
    assert.equal(await resolveDownloadUrl(entry, `${base}/torrent/1/`, { settings: { sitelink: base } }), null)
  })
})

test('selectors templated against Config are rendered before use', async () => {
  await withPage('<html><body><a href="/dl/abc.torrent">Download</a></body></html>', async base => {
    // 1337x and friends write their selectors as {{ .Config.downloadlink }}.
    const entry = definition({
      selectors: [{ selector: 'a[href^="{{ .Config.downloadlink }}"]', attribute: 'href' }],
    }, [base])
    const resolved = await resolveDownloadUrl(entry, `${base}/torrent/1/`, {
      settings: { sitelink: base, downloadlink: '/dl/' },
    })
    assert.equal(resolved, `${base}/dl/abc.torrent`)
  })
})

// ─── Redirector links ────────────────────────────────────────────────────────

test('a magnet wrapped in a redirector link is extracted without any fetch', async () => {
  const { magnetFromUrl } = await import('../src/services/download-manager.js')
  const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'

  // The shape seen in the wild: the magnet sits encoded in a query parameter,
  // so the wrapper page never needs fetching.
  assert.equal(magnetFromUrl(`https://example.invalid/?url=${encodeURIComponent(magnet)}`), magnet)
  assert.equal(magnetFromUrl(`https://example.invalid/go?link=${encodeURIComponent(magnet)}`), magnet)

  // Encoded twice, which some redirectors do when chaining.
  assert.equal(magnetFromUrl(`https://example.invalid/?url=${encodeURIComponent(encodeURIComponent(magnet))}`), magnet)

  // Left unencoded, so a query parser would tear the magnet's own parameters off.
  const withParams = `${magnet}&dn=Example+Release&tr=udp%3A%2F%2Ftracker.invalid%3A80`
  assert.equal(magnetFromUrl(`https://example.invalid/?url=${withParams}`), withParams,
    'the trailing magnet parameters survive')

  // Already a magnet, so returned untouched.
  assert.equal(magnetFromUrl(magnet), magnet)
})

test('a genuine details page is not mistaken for a wrapped magnet', async () => {
  const { magnetFromUrl } = await import('../src/services/download-manager.js')
  assert.equal(magnetFromUrl('https://example.invalid/torrent/6002280/some-release/'), null)
  assert.equal(magnetFromUrl('https://example.invalid/download?id=123'), null)
  assert.equal(magnetFromUrl('not a url at all'), null)
  // A malformed escape must not throw.
  assert.equal(magnetFromUrl('https://example.invalid/?url=%E0%A4%A'), null)
})
