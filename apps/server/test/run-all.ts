import { spawnSync } from 'node:child_process'

const tests = [
  'test/config.test.ts',
  'test/parser.test.ts',
  'test/auth.test.ts',
  'test/foundation.test.ts',
  'test/quality.test.ts',
  'test/films.e2e.test.ts',
  'test/series.e2e.test.ts',
  'test/music-books.e2e.test.ts',
  'test/comics-games.e2e.test.ts',
  'test/system.e2e.test.ts',
  'test/metadata-edit.test.ts',
  'test/file-metadata.test.ts',
  'test/library-migration.test.ts',
]

for (const file of tests) {
  console.log('\n=== ' + file + ' ===')
  const result = spawnSync('tsx', [file], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
