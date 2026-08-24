import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DefinitionLoader, executeSearch } from '@torrentstack/indexer-engine'

/**
 * A definition may reference a setting the operator never saved, relying on the
 * `default:` it declares. Rendering those as empty produces a malformed URL
 * rather than an error — the failure mode that made every Pirate Bay mirror
 * answer 404 at once and read as though the endpoints had died.
 */

const dir = mkdtempSync(join(tmpdir(), 'archivist-defdefaults-'))

const definitionYaml = `---
id: defaults-fixture
name: Defaults Fixture
links:
  - http://127.0.0.1/
caps:
  categorymappings:
    - {id: 1, cat: TV}
  modes:
    search: [q]
settings:
  - name: mode
    type: select
    label: Mode
    default: recent
    options:
      recent: Recent
      archive: Archive
  - name: flag
    type: checkbox
    label: Flag
    default: false
search:
  paths:
    - path: "probe/{{ .Config.mode }}/{{ if eq .Config.flag .False }}unset{{ else }}set{{ end }}"
  rows:
    selector: tr.result
  fields:
    title:
      selector: a
    download:
      selector: a
      attribute: href
`

const definitionPath = join(dir, 'defaults-fixture.yml')
writeFileSync(definitionPath, definitionYaml)

async function captureRequest(settings: Record<string, string | number | boolean>): Promise<string> {
  const requested: string[] = []
  const server: Server = createServer((req, res) => {
    requested.push(req.url ?? '')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<html><body><table></table></body></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  try {
    const loader = new DefinitionLoader()
    const definition = await loader.loadFile(definitionPath)
    await executeSearch(definition, { q: 'query', categories: [], type: 'search' }, {
      settings: { sitelink: `http://127.0.0.1:${port}/`, ...settings },
      timeoutMs: 2_000,
    })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }

  return requested[0] ?? ''
}

test('a declared default is used when the operator never saved the setting', async () => {
  const url = await captureRequest({})
  // Without the merge this renders `probe//unset` — a path the site answers 404
  // for, which the resolver then attributes to the endpoint.
  assert.match(url, /^\/probe\/recent\//)
})

test('a saved setting overrides the declared default', async () => {
  const url = await captureRequest({ mode: 'archive' })
  assert.match(url, /^\/probe\/archive\//)
})

test('a false default stays absent so `eq .False` keeps its meaning', async () => {
  // `False` is null and `eq` is `==`, so an absent setting compares equal to it
  // but an explicit `false` does not. Filling in false-y defaults would flip
  // every optional-setting branch in every definition.
  const url = await captureRequest({})
  assert.match(url, /\/unset$/)
})

test('an explicitly saved false does NOT read as False', async () => {
  // Pre-existing engine behaviour, pinned here because it is surprising and it
  // is the reason the merge above skips false-y defaults. `False` is null and
  // `eq` is `==`: `undefined == null` holds, `false == null` does not. So an
  // absent setting takes the False branch while an explicit `false` takes the
  // other one. Filling in a `default: false` would therefore silently move
  // every such definition onto the opposite branch.
  const url = await captureRequest({ flag: false })
  assert.match(url, /\/set$/)
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
