import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefinitionLoader, executeSearch } from '@torrentstack/indexer-engine'

/**
 * A tracker row shaped like the ones that broke searching entirely: the
 * category is a link path rather than a bare name, and the magnet is wrapped in
 * a redirect. Both need a filter argument to unwrap, and filter arguments were
 * being read a character at a time.
 */
const ROW_HTML = `<html><body><table class="data">
<tr id="t1">
  <td>
    <span id="cat_1"><strong><a href="/movies">Movies</a></strong></span>
    <a class="cellMainLink" href="/t3-A-Bugs-Life">A.Bugs.Life.1998.1080p.BluRay.x265-GROUP</a>
    <a data-download href="https://redirect.example/?url=magnet%3A%3Fxt%3Durn%3Abtih%3A6976D337A1D3594E8775DB58EFF8352045D469FB%26dn%3DA.Bugs.Life">magnet</a>
  </td>
  <td>1.44 GB</td><td>10 years ago</td><td>102</td><td>16</td>
</tr>
</table></body></html>`

const DEFINITION = `
id: filter-fixture
name: Filter Fixture
type: public
language: en-US
links:
  - https://fixture.invalid/
caps:
  categorymappings:
    - {id: movies, cat: Movies}
    - {id: other, cat: Other}
  modes:
    search: [q]
    movie-search: [q]
search:
  paths:
    - path: 'usearch/{{ .Keywords }}/'
  rows:
    selector: 'table.data tr[id]'
  fields:
    category_optional:
      selector: 'span[id^="cat_"] > strong > a'
      attribute: href
      optional: true
      filters:
        - {name: tolower}
        - {name: trim, args: "/"}
    category:
      text: "{{ if .Result.category_optional }}{{ .Result.category_optional }}{{ else }}other{{ end }}"
    title: {selector: 'a.cellMainLink'}
    details: {selector: 'a.cellMainLink', attribute: href}
    download:
      selector: 'a[data-download]'
      attribute: href
      filters:
        - {name: querystring, args: url}
    size: {selector: 'td:nth-child(2)'}
    date: {selector: 'td:nth-child(3)'}
    seeders: {selector: 'td:nth-child(4)'}
    leechers: {selector: 'td:nth-child(5)'}
`

async function searchFixture(): Promise<Awaited<ReturnType<typeof executeSearch>>> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(ROW_HTML)
  })
  await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening))
  const { port } = server.address() as AddressInfo
  try {
    const dir = await mkdtemp(join(tmpdir(), 'filter-fixture-'))
    const path = join(dir, 'filter-fixture.yml')
    await writeFile(path, DEFINITION, 'utf8')
    const definition = await new DefinitionLoader().loadFile(path)
    assert.ok(definition)
    return await executeSearch(definition, { q: 'A Bugs Life 1998', categories: [2000], type: 'movie' }, {
      settings: { sitelink: `http://127.0.0.1:${port}/` },
      timeoutMs: 5_000,
    })
  } finally {
    await new Promise<void>((closed, reject) => server.close(error => error ? reject(error) : closed()))
  }
}

test('a trim argument trims that character set, not whitespace', async () => {
  const [result] = await searchFixture()
  assert.ok(result, 'the row must parse')
  // `/movies` has to become `movies` to match the definition's mapping id.
  // Ignoring the argument left the leading slash, nothing matched, and every
  // result fell through to the unknown category — where the caller's category
  // filter then discarded it. That is how a search returned nothing at all.
  assert.deepEqual(result.categories, [2000])
})

test('the querystring filter unwraps a magnet from a redirect URL', async () => {
  const [result] = await searchFixture()
  assert.ok(result)
  assert.match(result.downloadUrl ?? '', /^magnet:\?xt=urn:btih:6976D337A1D3594E8775DB58EFF8352045D469FB/)
  // A magnet reached through `download` alone still has to register as one, or
  // the aggregator cannot deduplicate it against another indexer's copy.
  assert.equal(result.magnetUrl, result.downloadUrl)
  assert.equal(result.infoHash, '6976D337A1D3594E8775DB58EFF8352045D469FB')
})

test('the rest of the row still parses alongside the filtered fields', async () => {
  const [result] = await searchFixture()
  assert.ok(result)
  assert.equal(result.title, 'A.Bugs.Life.1998.1080p.BluRay.x265-GROUP')
  assert.equal(result.seeders, 102)
  assert.equal(result.leechers, 16)
  assert.ok((result.size ?? 0) > 1_000_000_000, 'size should parse as bytes')
})
