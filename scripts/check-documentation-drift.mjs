import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(root, relative), 'utf8')
const failures = []

function requireText(file, pattern, description) {
  if (!pattern.test(read(file))) failures.push(`${file}: ${description}`)
}

function rejectText(file, pattern, description) {
  if (pattern.test(read(file))) failures.push(`${file}: ${description}`)
}

// These assertions intentionally bind canonical documentation facts to the
// implementation. If one changes, update code and docs together.
requireText('apps/server/src/gateway.ts', /prefix:\s*'\/library'/, 'Library gateway prefix changed')
requireText('apps/server/src/gateway.ts', /prefix:\s*'\/player'/, 'Player gateway prefix changed')
requireText('apps/server/src/gateway.ts', /prefix:\s*'\/catalogue'/, 'Catalogue gateway prefix changed')
requireText('Dockerfile', /^EXPOSE 2424$/m, 'Docker production port is no longer 2424')
rejectText('docker-compose.yml', /^\s{2}archivist-control:/m, 'Control was added to Compose; deployment docs/ADR must be reviewed')
requireText('apps/server/src/supervisor.ts', /'worker'/, 'supervisor no longer starts the worker child')
requireText('packages/design-system/tokens.css', /--archivist-cyan:\s*#00d4ff;/i, 'canonical cyan token changed')
requireText('packages/design-system/tokens.css', /--archivist-font-display:\s*'Bebas Neue'/, 'display typography changed')
requireText('deploy/systemd/archivist-control-agent.service', /Environment=ARCHIVIST_FILESYSTEM_ROOT=\//, 'Control filesystem root changed')
requireText('deploy/systemd/archivist-control-agent.service', /ARCHIVIST_DEFINITIONS_PATH=/, 'Cardigann Control root changed')

const migrationVersions = [...read('packages/db/src/schema.ts').matchAll(/version:\s*(\d+),/g)].map(match => Number(match[1]))
const latestMigration = Math.max(...migrationVersions)
if (!Number.isFinite(latestMigration)) failures.push('packages/db/src/schema.ts: no numbered migrations found')
else {
  requireText('AGENT.md', new RegExp(`through version ${latestMigration}\\b`), `documented migration version is not ${latestMigration}`)
  requireText('ARCHIVIST_CORE.md', new RegExp('versions `1` through `' + latestMigration + '`'), `documented migration range is not 1..${latestMigration}`)
  requireText('docs/02-architecture/data/data-model.md', new RegExp('through version `' + latestMigration + '`'), `data architecture migration version is not ${latestMigration}`)
}

const knowledgeFiles = [
  'docs/01-foundation/capability-map.md',
  'docs/02-architecture/system-architecture.md',
  'docs/02-architecture/data/data-model.md',
  'docs/02-architecture/interfaces/http-api.md',
  'docs/03-products/library/README.md',
  'docs/03-products/player/README.md',
  'docs/03-products/catalogue/README.md',
  'docs/03-products/control/README.md',
  'docs/03-products/kodi/README.md',
  'docs/04-features/acquisition/acquisition-and-release-monitoring.md',
  'docs/06-design/design-system.md',
  'docs/07-operations/deployment-and-configuration.md',
]
for (const file of knowledgeFiles) {
  requireText(file, /^status: canonical$/m, 'canonical current-state page lost canonical status')
  requireText(file, /^evidence:$/m, 'canonical current-state page has no implementation evidence list')
}

for (const file of ['private-packages/archivist-backup/README.md', 'private-packages/archivist-backup/source-snapshot.md']) {
  rejectText(file, /^status:\s*review-required$/m, 'recovery documentation must be explicitly current or historical')
}

for (const file of ['docs/README.md', 'docs/01-foundation/README.md', 'docs/02-architecture/README.md', 'docs/03-products/README.md']) {
  rejectText(file, /status:\s*review-required/, 'a knowledge entry point exposes unreviewed material as current')
}

if (failures.length) {
  console.error(`Documentation drift validation failed:\n${failures.map(value => `- ${value}`).join('\n')}`)
  process.exit(1)
}

console.log('Canonical documentation invariants match the implementation.')
