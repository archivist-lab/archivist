import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness

after(async () => {
  await h?.close()
})

test('a film query plan leads with the broad query and never sends catalogue punctuation', async () => {
  h = await startTestApp()
  const { filmQueryPlan } = await import('../src/services/item-searches.js')

  const film = { title: "A Bug's Life", year: 1998, library_id: 0 }
  const plan = filmQueryPlan(film, 'deep', {})

  // The plan used to run sixteen tier-term queries before ever asking the plain
  // question, which is what made an auto search take tens of minutes.
  assert.equal(plan[0], 'A Bugs Life 1998', 'the broad, tracker-safe query must go first')

  // The canonical spelling is still worth a round trip — an indexer backed by a
  // metadata catalogue rather than release names can match it — but never
  // before the spelling that works on a release-name tracker.
  const firstApostrophe = plan.findIndex(query => /['’]/.test(query))
  assert.ok(firstApostrophe > 0, 'the apostrophe spelling must never lead the plan')

  // Tier terms are appended to the tracker-safe spelling only. Pairing all
  // sixteen with the canonical spelling doubles a fan-out that rarely matches.
  assert.deepEqual(
    plan.filter(query => /['’]/.test(query)),
    ["A Bug's Life 1998", "A Bug's Life"],
    'only the broad queries carry the canonical spelling',
  )
  assert.ok(plan.includes('A Bugs Life'), 'the title-only query must be present')

  // Tier terms come after the broad queries, not before them.
  const firstTier = plan.findIndex(query => query.includes('SARTRE'))
  const lastBroad = plan.lastIndexOf('A Bugs Life')
  assert.ok(firstTier > lastBroad, 'tier queries must follow the broad queries')
})

test('an explicitly requested tier narrows the terms but never goes first', async () => {
  const { filmQueryPlan } = await import('../src/services/item-searches.js')
  const film = { title: 'Heat', year: 1995, library_id: 0 }
  const plan = filmQueryPlan(film, 'deep', { tier: 'Tier 1' })

  assert.equal(plan[0], 'Heat 1995', 'the broad query leads even when a tier was requested')
  // Only the requested tier's terms are used.
  assert.equal(plan.some(query => query.includes('YIFY')), false)
  assert.ok(plan.some(query => query.includes('SARTRE')), 'the requested tier is still searched')
})

test('a filtered tier search reaches its broad queries inside the budget', async () => {
  const { filmQueryPlan } = await import('../src/services/item-searches.js')
  // Exactly what the UI sent for A Bug's Life: Tier 1 plus quality filters.
  // This plan used to open with fourteen queries pairing every tier term with
  // `1080p BluRay x265`, and the wall-clock budget expired on the thirteenth —
  // so the broad query that actually returns the film was never issued at all.
  const plan = filmQueryPlan({ title: "A Bug's Life", year: 1998, library_id: 0 }, 'deep', {
    tier: 'Tier 1', resolution: '1080p', source: 'BluRay', codec: 'x265',
  })

  assert.equal(plan[0], 'A Bugs Life 1998', 'the highest-recall query must be first')
  assert.ok(plan.length <= 16, `a plan of ${plan.length} queries cannot finish inside its budget`)

  // A tier term and a quality filter are two ways to narrow. Stacking them asks
  // one title to carry a group name and a resolution and a source and a codec.
  const stacked = plan.filter(query => /SARTRE|QxR|SAMPA|Prof|TAoE|SM737|HeVK/.test(query) && query.includes('1080p'))
  assert.deepEqual(stacked, [], 'tier terms must not also carry the quality filters')

  // The filters still get their own targeted query.
  assert.ok(plan.includes('A Bugs Life 1998 1080p BluRay x265'))
})

test('a quick film search sends the tracker-safe spelling', async () => {
  const { filmQueryPlan } = await import('../src/services/item-searches.js')
  const plan = filmQueryPlan({ title: 'Monsters, Inc.', year: 2001, library_id: 0 }, 'quick', {})
  assert.equal(plan[0], 'Monsters Inc 2001')
})
