import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ControlSnapshot } from '../src/server/host.js'
import { historyPoint, readHistory, recordHistory } from '../src/server/history.js'

const snapshot = (at = new Date().toISOString()): ControlSnapshot => ({
  generatedAt: at,
  host: {
    hostname: 'fixture', platform: 'linux', release: 'test', uptimeSeconds: 10,
    cpuModel: 'Fixture CPU', cpuCount: 4, load: [1.25, 1, 0.5],
    memoryTotalBytes: 1_000, memoryUsedBytes: 425,
  },
  services: [{ id: 'runtime', unit: 'archivist.service', label: 'Archivist runtime', state: 'active', subState: 'running', enabled: true, pid: 42, memoryBytes: 256, startedAt: at }],
  volumes: [{ id: 'media', label: 'Media', path: '/media', totalBytes: 100, usedBytes: 70, availableBytes: 30, usedPercent: 70, filesystem: 'host' }],
  temperatures: [],
  endpoints: [
    { label: 'Library', port: 2424, path: '/library/', reachable: true, latencyMs: 4 },
    { label: 'API', port: 2424, path: '/ping', reachable: false, latencyMs: null },
  ],
  backup: { status: 'healthy', enabled: true, backupCount: 1, retentionCount: 7, intervalHours: 24, latest: null, verifiedAt: at, sqliteIntegrity: 'ok', reason: null },
  capabilities: { serviceControl: true, journal: true, smart: false, sensors: false, btrfs: false, zfs: false },
})

test('history points retain operational metrics without host or path details', () => {
  assert.deepEqual(historyPoint(snapshot('2026-08-14T00:00:00.000Z')), {
    at: '2026-08-14T00:00:00.000Z', load1: 1.25, memoryPercent: 42.5,
    serviceMemoryBytes: 256, endpointsUp: 1, endpointsTotal: 2, volumes: { media: 70 },
  })
})

test('history reads are time-bounded and tolerate malformed lines', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'archivist-control-history-'))
  const old = new Date(Date.now() - 3 * 3_600_000).toISOString()
  await recordHistory(directory, snapshot(old))
  await recordHistory(directory, snapshot())
  await writeFile(path.join(directory, 'telemetry.jsonl'), `not-json\n${JSON.stringify(historyPoint(snapshot(old)))}\n${JSON.stringify(historyPoint(snapshot()))}\n`)
  const points = await readHistory(directory, 1)
  assert.equal(points.length, 1)
  assert.ok(Date.parse(points[0].at) > Date.now() - 3_600_000)
})
