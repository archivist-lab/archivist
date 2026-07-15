import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DefinitionLoader, executeSearch } from '@torrentstack/indexer-engine'

test('FlareSolverr cookies include the target domain and path', async () => {
  let receivedCookies: unknown = null
  const flareSolverr = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>
      }
      receivedCookies = payload.cookies
      const valid = payload.cookies?.every(cookie => cookie.domain === 'eztv.wf' && cookie.path === '/')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(valid
        ? {
            status: 'ok',
            message: 'Challenge solved!',
            solution: {
              status: 200,
              headers: { 'content-type': 'text/html' },
              response: '<html><body><table></table></body></html>',
              cookies: [],
            },
          }
        : { status: 'error', message: "Error: Error solving the challenge. 'domain'" }))
    })
  })

  await new Promise<void>(resolve => flareSolverr.listen(0, '127.0.0.1', resolve))
  const { port } = flareSolverr.address() as AddressInfo

  try {
    const loader = new DefinitionLoader()
    const definition = loader.loadString(`
id: eztv-cookie-fixture
name: EZTV cookie fixture
type: public
links:
  - https://eztv.wf/
caps:
  modes:
    search: [q]
search:
  paths:
    - path: search/test
  headers:
    cookie: ["sort_no=100; layout=def_wlinks"]
  rows:
    selector: "table tr.result"
  fields:
    title:
      selector: td
`)
    assert.ok(definition)

    const results = await executeSearch(definition, { q: 'test', limit: 5 }, {
      settings: { sitelink: 'https://eztv.wf/' },
      timeoutMs: 2_000,
      flareSolverrUrl: `http://127.0.0.1:${port}`,
      forceFlareSolverr: true,
    })

    assert.deepEqual(results, [])
    assert.deepEqual(receivedCookies, [
      { name: 'sort_no', value: '100', domain: 'eztv.wf', path: '/' },
      { name: 'layout', value: 'def_wlinks', domain: 'eztv.wf', path: '/' },
    ])
  } finally {
    await new Promise<void>((resolve, reject) => flareSolverr.close(error => error ? reject(error) : resolve()))
  }
})
