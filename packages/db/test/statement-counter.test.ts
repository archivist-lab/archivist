// The tracing flag is read once at module load, so it must be set before the
// counter is imported — hence the dynamic imports below.
process.env.ARCHIVIST_PERF_TRACE = '1'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'archivist-stmt-'))

const { openDatabase, closeAllDatabases } = await import('../src/client.js')
const { runWithStatementTally, statementTracingEnabled, topStatements } = await import('../src/statement-counter.js')
type Tally = Awaited<ReturnType<typeof tallyOf>>

/** Runs `body` under a tally and hands back the tally it filled. */
function tallyOf(body: () => void) {
  return runWithStatementTally(scope => {
    if (!scope) throw new Error('tracing is disabled — the env flag did not take')
    body()
    return scope
  })
}

test('tracing is enabled by the env flag', () => {
  assert.equal(statementTracingEnabled(), true)
})

test('statements are counted against the tally that is in scope', () => {
  const db = openDatabase(join(dir, 'counted.sqlite'))
  db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, group_id INTEGER)')
  const insert = db.prepare('INSERT INTO item (id, group_id) VALUES (?, ?)')
  for (let id = 1; id <= 5; id += 1) insert.run(id, id % 2)

  const outside = db.prepare('SELECT COUNT(*) AS n FROM item').get() as { n: number }
  assert.equal(outside.n, 5, 'statements outside any tally still execute')

  const tally = tallyOf(() => {
    // The N+1 shape this counter exists to catch: one query per row.
    const ids = db.prepare('SELECT id FROM item').all() as Array<{ id: number }>
    for (const row of ids) db.prepare('SELECT group_id FROM item WHERE id = ?').get(row.id)
  })

  assert.equal(tally.total, 6, '1 list statement + 5 per-row statements')
  const top = topStatements(tally, 2)
  assert.equal(top[0].count, 5, 'the per-row query collapses to one shape')
  assert.match(top[0].sql, /SELECT group_id FROM item WHERE id = \?/)
})

test('bound literals are normalised so one loop is one shape', () => {
  const db = openDatabase(join(dir, 'counted.sqlite'))
  const tally = tallyOf(() => {
    db.prepare('SELECT * FROM item WHERE group_id = ? AND id > ?').all(1, 0)
    db.prepare('SELECT * FROM item WHERE group_id = ? AND id > ?').all(9, 3)
  })
  assert.equal(tally.total, 2)
  assert.equal(tally.bySql.size, 1, 'differing parameters must not fragment the tally')
})

test('a tally counts only its own async context', async () => {
  const db = openDatabase(join(dir, 'counted.sqlite'))
  const inner: Tally = await runWithStatementTally(async scope => {
    if (!scope) throw new Error('tracing is disabled — the env flag did not take')
    db.prepare('SELECT 1').get()
    await Promise.resolve()
    // Statements after an await still land in the same tally: the store
    // follows the async chain rather than a global counter delta.
    db.prepare('SELECT 2').get()
    return scope
  })
  assert.equal(inner.total, 2)

  const untracked = tallyOf(() => { db.prepare('SELECT 3').get() })
  assert.equal(untracked.total, 1, 'a second request gets its own tally')
  assert.equal(inner.total, 2, 'and does not add to the first')
})

test('cleanup', () => {
  closeAllDatabases()
  rmSync(dir, { recursive: true, force: true })
})
