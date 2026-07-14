import { spawnSync } from 'node:child_process'

const tests = [
  'test/config.test.ts',
  'test/parser.test.ts',
  'test/orchestrator.test.ts',
  'test/tiers.test.ts',
  'test/monitor.test.ts',
  'test/release-automation.test.ts',
  'test/auth.test.ts',
  'test/foundation.test.ts',
  'test/list-imports.test.ts',
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
  'test/channels.e2e.test.ts',
]

for (const file of tests) {
  console.log('\n=== ' + file + ' ===')
  const result = spawnSync('tsx', [file], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
