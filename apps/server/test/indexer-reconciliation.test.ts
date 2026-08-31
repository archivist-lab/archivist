import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDb, resetDbForTests } from '../src/db.js'
import {
  getIndexerStore,
  initIndexerBridge,
  reconcileIndexerStore,
} from '../src/services/indexer-bridge.js'
import { addUserEndpoint, setActiveEndpoint } from '../src/indexers/endpoints/store.js'
import { persistedRssEligible } from '../src/release-pipeline/poller.js'

const dir = mkdtempSync(join(tmpdir(), 'archivist-indexer-reconcile-'))
const definitionsDir = join(dir, 'definitions')
const customDefinitionsDir = join(dir, 'custom-definitions')
mkdirSync(definitionsDir)
mkdirSync(customDefinitionsDir)

writeFileSync(join(definitionsDir, 'fixture.yml'), `---
id: reconcile-fixture
name: Reconcile Fixture
type: public
links:
  - https://fixture.invalid/
caps:
  categories:
    1: TV
  modes:
    search: [q]
search:
  paths:
    - path: latest
  rows:
    selector: tr
  fields:
    title:
      selector: td.title
    download:
      selector: a.magnet
      attribute: href
`)

const previousCustomDefinitions = process.env.ARCHIVIST_CUSTOM_DEFINITIONS_PATH
process.env.ARCHIVIST_CUSTOM_DEFINITIONS_PATH = customDefinitionsDir
const db = initDb(join(dir, 'archivist.sqlite'))
await initIndexerBridge(db, definitionsDir, true)

test('worker registry reconciles add, update, endpoint selection and delete from SQLite', () => {
  const id = 'reconcile-indexer'
  db.prepare(`
    INSERT INTO indexers_ts
      (id, name, protocol, definition_id, enabled, priority, base_url, settings, status, capabilities, tags)
    VALUES (?, ?, 'cardigann', 'reconcile-fixture', 1, 25, ?, ?, '{}', '{}', '[]')
  `).run(id, 'Original name', 'https://fixture.invalid/', JSON.stringify({ rss: true }))

  const added = reconcileIndexerStore(db)
  assert.equal(added.added, 1)
  const original = getIndexerStore().get(id)
  assert.ok(original)
  assert.equal(original.config.name, 'Original name')
  assert.equal(original.config.enabled, true)
  original.cookies.session = 'preserved'

  const alternate = addUserEndpoint(id, 'https://alternate.invalid/', db)
  assert.ok(alternate)
  setActiveEndpoint(id, alternate.id, db)
  db.prepare(`
    UPDATE indexers_ts
    SET name = ?, enabled = 0, priority = 4, settings = ?, updated_at = ?
    WHERE id = ?
  `).run('Updated name', JSON.stringify({ rss: false }), Date.now(), id)

  const updated = reconcileIndexerStore(db)
  assert.equal(updated.updated, 1)
  const current = getIndexerStore().get(id)
  assert.equal(current, original, 'runtime instance identity is retained for in-flight bookkeeping')
  assert.equal(current?.config.name, 'Updated name')
  assert.equal(current?.config.enabled, false)
  assert.equal(current?.config.priority, 4)
  assert.equal(current?.config.baseUrl, 'https://alternate.invalid')
  assert.equal(current?.config.settings.rss, false)
  assert.equal(current?.cookies.session, 'preserved')
  assert.equal(persistedRssEligible(id, db), false)

  const unchanged = reconcileIndexerStore(db)
  assert.equal(unchanged.unchanged, 1)
  assert.equal(unchanged.updated, 0)

  db.prepare('DELETE FROM indexers_ts WHERE id = ?').run(id)
  const removed = reconcileIndexerStore(db)
  assert.equal(removed.removed, 1)
  assert.equal(getIndexerStore().get(id), undefined)
  assert.equal(persistedRssEligible(id, db), false)
})

process.on('exit', () => {
  if (previousCustomDefinitions === undefined) delete process.env.ARCHIVIST_CUSTOM_DEFINITIONS_PATH
  else process.env.ARCHIVIST_CUSTOM_DEFINITIONS_PATH = previousCustomDefinitions
  resetDbForTests()
  rmSync(dir, { recursive: true, force: true })
})
