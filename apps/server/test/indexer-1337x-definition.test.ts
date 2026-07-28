import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { DefinitionLoader, executeSearch } from '@torrentstack/indexer-engine'

test('1337x keyword search collapses category paths to one request', async () => {
  const requestedUrls: string[] = []
  const server = createServer((req, res) => {
    requestedUrls.push(req.url ?? '')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<html><body><table></table></body></html>')
  })

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address() as AddressInfo

  try {
    const loader = new DefinitionLoader()
    const definition = await loader.loadFile(resolve(process.cwd(), '../../data/indexer-definitions/definitions/v11/1337x.yml'))
    assert.ok(definition)

    await executeSearch(definition, {
      q: "X-Men '97 S02E01",
      categories: [5000],
      type: 'tvsearch',
    }, {
      settings: {
        sitelink: `http://127.0.0.1:${port}/`,
        uploader: '',
        disablesort: false,
        sort: 'time',
        type: 'desc',
        downloadlink: 'magnet:',
        downloadlink2: 'magnet:',
      },
      timeoutMs: 2_000,
    })

    assert.equal(requestedUrls.length, 1)
    assert.match(requestedUrls[0] ?? '', /X-Men%20(?:'|%27)97%20S02E01/)
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  }
})
