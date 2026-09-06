/** Disposable browse/probe workload. ARCHIVIST_PERF_SECONDS supports longer soak runs. */
import assert from 'node:assert/strict'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { startTestApp } from './helpers.js'
import { runMediaCommand } from '../src/shared/media-probe.js'

const seconds = Number(process.env.ARCHIVIST_PERF_SECONDS ?? 5)
assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 86400, 'ARCHIVIST_PERF_SECONDS must be 1–86400')
const budget = Number(process.env.ARCHIVIST_PERF_API_P95_MS ?? 200)
assert.ok(Number.isFinite(budget) && budget > 0)
const app = await startTestApp()
const { getDb } = await import('../src/db.js')
const db = getDb()
const eventLoop = monitorEventLoopDelay({ resolution: 10 })
const samples: number[] = []
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0
const cpuStart = process.cpuUsage(), started = performance.now()
let peakRss = process.memoryUsage().rss
const matrix: Array<{ rows: number; firstMs: number; p95Ms: number }> = []
try {
  const tabs = await app.request('GET', '/api/v1/tabs')
  const library = tabs.json.find((tab: any) => tab.media_type === 'films').id
  const headers = { 'x-tab-context': String(library) }
  const insert = db.prepare('INSERT INTO films(library_id,title,sort_title,status) VALUES(?,?,?,?)')
  eventLoop.enable()
  for (const rows of [0, 100, 10_000]) {
    db.prepare('DELETE FROM films WHERE library_id=?').run(library)
    db.transaction(() => { for (let i = 0; i < rows; i++) insert.run(library, `Fixture ${i}`, `Fixture ${String(i).padStart(5, '0')}`, 'missing') })()
    const times: number[] = []
    const deadline = performance.now() + seconds * 1000 / 3
    while (performance.now() < deadline) {
      // Deliberately slow subprocess alongside browse requests. No media or
      // database from the host installation participates in this workload.
      const subprocess = runMediaCommand(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("ok"),100)'], 5000)
      for (let request = 0; request < 4; request++) {
        const t = performance.now()
        const result = await app.request('GET', '/api/v1/films?window=1&limit=100&sort=title&direction=asc', { headers })
        assert.equal(result.status, 200); assert.ok(result.json.items.length <= 100)
        times.push(performance.now() - t)
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
      }
      await subprocess
    }
    matrix.push({ rows, firstMs: times[0], p95Ms: percentile(times.slice(1), .95) })
    samples.push(...times.slice(1))
  }
  const cpu = process.cpuUsage(cpuStart)
  const report = {
    workload: 'disposable browse with concurrent delayed subprocesses', matrix,
    requests: samples.length, p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), p99Ms: percentile(samples, .99),
    eventLoopP99Ms: eventLoop.percentile(99) / 1e6, peakApiRssBytes: peakRss,
    apiCpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - started,
    budgetP95Ms: budget,
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.ARCHIVIST_PERF_REPORT) await writeFile(process.env.ARCHIVIST_PERF_REPORT, JSON.stringify(report, null, 2))
  assert.ok(report.p95Ms < budget, `browse p95 ${report.p95Ms.toFixed(1)}ms exceeds ${budget}ms`)
} finally { eventLoop.disable(); await app.close() }
