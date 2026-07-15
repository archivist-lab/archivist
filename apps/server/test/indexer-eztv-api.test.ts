import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DefinitionLoader, executeSearch } from '@torrentstack/indexer-engine'

test('EZTV API definition returns usable magnet results', async () => {
  let requestedUrl = ''
  const server = createServer((req, res) => {
    requestedUrl = req.url ?? ''
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({
      torrents_count: 1,
      limit: 5,
      page: 1,
      torrents: [{
        id: 3124927,
        hash: '7911f269920ac480f3fe3f1e02c85be0af2b8abd',
        title: 'Trying S05E02 720p WEB H264-JFF EZTV',
        magnet_url: 'magnet:?xt=urn:btih:7911f269920ac480f3fe3f1e02c85be0af2b8abd&dn=Trying',
        seeds: 12,
        peers: 3,
        date_released_unix: 1784083213,
        size_bytes: '975175680',
      }],
    }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  try {
    const loader = new DefinitionLoader()
    const definition = loader.loadString(`
id: eztv
name: EZTV
type: public
links:
  - https://eztv.wf/
caps:
  categorymappings:
    - {id: 1, cat: TV, desc: "TV"}
  categories:
    1: TV
  modes:
    search: [q]
search:
  paths:
    - path: "api/get-torrents?limit={{ if .Query.Limit }}{{ .Query.Limit }}{{ else }}100{{ end }}"
      response:
        type: json
  rows:
    selector: torrents
  fields:
    category:
      text: 1
    title:
      selector: title
      filters:
        - name: replace
          args: [" EZTV", ""]
    download:
      selector: magnet_url
    magneturl:
      selector: magnet_url
    infohash:
      selector: hash
    size:
      selector: size_bytes
    date:
      selector: date_released_unix
    seeders:
      selector: seeds
    leechers:
      selector: peers
`)

    const results = await executeSearch(definition, { q: 'test', limit: 5 }, {
      settings: { sitelink: `http://127.0.0.1:${port}/` },
      timeoutMs: 2_000,
    })

    assert.equal(requestedUrl, '/api/get-torrents?limit=5')
    assert.equal(results.length, 1)
    assert.equal(results[0]?.title, 'Trying S05E02 720p WEB H264-JFF')
    assert.equal(results[0]?.downloadUrl.startsWith('magnet:?xt=urn:btih:'), true)
    assert.equal(results[0]?.magnetUrl, results[0]?.downloadUrl)
    assert.equal(results[0]?.infoHash, '7911f269920ac480f3fe3f1e02c85be0af2b8abd')
    assert.equal(results[0]?.size, 975175680)
    assert.equal(results[0]?.seeders, 12)
    assert.equal(results[0]?.leechers, 3)
    assert.deepEqual(results[0]?.categories, [5000])
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
