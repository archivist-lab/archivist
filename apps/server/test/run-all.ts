import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

/**
 * Explicit ordering for the suites that care about it — fast unit tests first,
 * then the e2e suites that build their own database.
 *
 * Any test file NOT listed here still runs, appended after these. The list used
 * to be the sole source of truth, which meant a new `*.test.ts` was silently
 * skipped until someone remembered to add it; several were.
 */
const ordered = [
  'test/config.test.ts',
  'test/parser.test.ts',
  'test/segments.test.ts',
  'test/processing-monitor.test.ts',
  'test/indexer-cloudflareBypass.test.ts',
  'test/indexer-eztv-api.test.ts',
  'test/orchestrator.test.ts',
  'test/series-search.test.ts',
  'test/discovery-filters.test.ts',
  'test/new-release-search.test.ts',
  'test/tiers.test.ts',
  'test/monitor.test.ts',
  'test/storage-finalise.test.ts',
  'test/discography-import-plan.test.ts',
  'test/music-acquisition-state.test.ts',
  'test/music-ratings.test.ts',
  'test/import-file-roles.test.ts',
  'test/release-automation.test.ts',
  'test/auth.test.ts',
  'test/foundation.test.ts',
  'test/list-imports.test.ts',
  'test/lists.test.ts',
  'test/list-autodetect.test.ts',
  'test/quality.test.ts',
  'test/films.e2e.test.ts',
  'test/series.e2e.test.ts',
  'test/music-books.e2e.test.ts',
  'test/music-quality.test.ts',
  'test/music-files.test.ts',
  'test/download-resolution.test.ts',
  'test/comics-games.e2e.test.ts',
  'test/system.e2e.test.ts',
  'test/indexer-endpoints.test.ts',
  'test/metadata-edit.test.ts',
  'test/file-metadata.test.ts',
  'test/library-migration.test.ts',
  'test/player.e2e.test.ts',
  'test/player-ui.unit.test.ts',
  'test/player-ui.e2e.test.ts',
  'test/player-media.e2e.test.ts',
  'test/recommendations.test.ts',
  'test/channels.e2e.test.ts',
]

const discovered = readdirSync('test')
  .filter(name => name.endsWith('.test.ts'))
  .map(name => `test/${name}`)
  .sort()

const known = new Set(ordered)
const extra = discovered.filter(file => !known.has(file))
if (extra.length > 0) {
  console.log(`Discovered ${extra.length} unlisted test file(s): ${extra.join(', ')}`)
}

// A listed file that no longer exists is a stale entry, not a failure to run.
const missing = ordered.filter(file => !discovered.includes(file))
if (missing.length > 0) {
  console.log(`Skipping ${missing.length} listed file(s) that no longer exist: ${missing.join(', ')}`)
}

const tests = [...ordered.filter(file => discovered.includes(file)), ...extra]

/**
 * Every suite runs, even after one fails.
 *
 * Exiting on the first failure meant a single long-standing failure hid every
 * suite ordered after it — the same silent-skip problem the `ordered` list
 * above was fixed to avoid, arriving by a different route. Set
 * ARCHIVIST_TEST_BAIL=1 to stop at the first failure instead.
 */
const bail = process.env.ARCHIVIST_TEST_BAIL === '1'
const failures: string[] = []

for (const file of tests) {
  console.log('\n=== ' + file + ' ===')
  const result = spawnSync('tsx', [file], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    failures.push(file)
    if (bail) break
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${tests.length} suite(s) failed:`)
  for (const file of failures) console.error(`  - ${file}`)
  process.exit(1)
}

console.log(`\nAll ${tests.length} suite(s) passed.`)
