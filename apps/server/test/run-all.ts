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
  'test/indexer-flaresolverr.test.ts',
  'test/indexer-eztv-api.test.ts',
  'test/orchestrator.test.ts',
  'test/series-search.test.ts',
  'test/discovery-filters.test.ts',
  'test/new-release-search.test.ts',
  'test/tiers.test.ts',
  'test/monitor.test.ts',
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
  'test/comics-games.e2e.test.ts',
  'test/system.e2e.test.ts',
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

for (const file of tests) {
  console.log('\n=== ' + file + ' ===')
  const result = spawnSync('tsx', [file], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
