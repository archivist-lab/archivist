import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Exact, counted legacy diagnostics from the pre-remediation source snapshot.
// Rules remain enabled. New diagnostics fail; this never updates its baseline.
const root = path.resolve(import.meta.dirname, '..')
const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/lint-baseline.json'), 'utf8'))
const result = spawnSync(path.join(root, 'node_modules/.bin/biome'), ['lint', 'apps/server/src', 'client/src', 'packages', '--reporter=json'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
let report
try { report = JSON.parse(result.stdout) } catch { process.stderr.write(result.stderr || String(result.error || 'Biome did not produce diagnostics')); process.exit(1) }
let legacy = 0, failures = 0
for (const diagnostic of report.diagnostics ?? []) {
  const location = diagnostic.location
  if (!location?.span || !location.path?.file) { console.error(diagnostic.description); failures++; continue }
  const [start, end] = location.span
  const snippet = Buffer.from(location.sourceCode).subarray(start, end).toString().trim().replace(/\s+/g, ' ')
  const key = `${diagnostic.category}|${location.path.file}|${createHash('sha256').update(snippet).digest('hex')}`
  if (baseline[key] > 0) { baseline[key]--; legacy++; continue }
  failures++
  const line = Buffer.from(location.sourceCode).subarray(0, start).toString().split('\n').length
  console.error(`${location.path.file}:${line} ${diagnostic.category}: ${diagnostic.description}`)
}
if (report.summary?.diagnosticsNotPrinted) { console.error('Incomplete Biome diagnostics'); failures++ }
console.log(`Lint: ${failures} new diagnostic(s); ${legacy} tracked legacy diagnostic(s). Run pnpm lint:all to inspect legacy debt.`)
process.exitCode = failures ? 1 : 0
