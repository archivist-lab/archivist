import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@torrentstack/torrent-engine'
import {
  normaliseDownloadQueueSettings,
  toSessionQueueSettings,
} from '../src/services/download-queue-settings.js'

/**
 * Concurrency limits for the download engine.
 *
 * The behaviour that matters is the pool arithmetic in processQueue, so these
 * drive it directly with stand-in torrents rather than booting a real swarm.
 */

type FakeTorrent = {
  id: string
  status: string
  labels: string[]
  forceStart?: boolean
}

/** A Session with no sockets, holding the given stand-in torrents. */
function sessionWith(settings: Record<string, unknown>, torrents: FakeTorrent[]) {
  const session = new Session(settings as never, { resume: '/tmp/none', torrents: '/tmp/none' }) as never as {
    torrents: Map<string, unknown>
    startTorrent: (inst: { id: string; status: string }) => Promise<void>
    processQueue: () => void
    updateSettings: (patch: Record<string, unknown>) => Promise<void>
  }

  const started: string[] = []
  session.torrents = new Map(torrents.map(t => [t.id, {
    id: t.id,
    status: t.status,
    meta: { name: t.id },
    discoveredPeers: [],
    bw: { downloadSpeed: 0 },
    resume: {
      queuePosition: torrents.indexOf(t),
      labels: t.labels,
      forceStart: t.forceStart,
      addedAt: Date.now(),
      activityAt: Date.now(),
    },
  }]))

  // startTorrent is async in the engine, so a promoted torrent is still
  // 'queued-download' for the rest of the pass. Settle it synchronously here so
  // the test observes the final state rather than the intermediate one.
  session.startTorrent = async inst => { started.push(inst.id); inst.status = 'downloading' }

  return { session, started }
}

const POOLS = { 'archivist-films': 3, 'archivist-series': 2 }

test('per-type pools are independent of the shared limit', () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: true, downloadQueueSize: 3, downloadQueuePools: POOLS, queueStalledEnabled: false },
    [
      { id: 'film1', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film2', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film3', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film4', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'series1', status: 'queued-download', labels: ['archivist-series'] },
      { id: 'music1', status: 'queued-download', labels: ['archivist-music'] },
    ],
  )

  session.processQueue()

  // Films fill their own pool of 3 and stop; the series starts anyway, even
  // though four downloads are already running against an overall limit of 3.
  assert.deepEqual(started, ['film1', 'film2', 'film3', 'series1', 'music1'])
})

test('the shared pool governs only the types without a limit of their own', () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: true, downloadQueueSize: 2, downloadQueuePools: POOLS, queueStalledEnabled: false },
    [
      { id: 'music1', status: 'queued-download', labels: ['archivist-music'] },
      { id: 'book1', status: 'queued-download', labels: ['archivist-books'] },
      { id: 'game1', status: 'queued-download', labels: ['archivist-games'] },
      { id: 'film1', status: 'queued-download', labels: ['archivist-films'] },
    ],
  )

  session.processQueue()

  // Music, books and games share two slots; the film has its own pool.
  assert.deepEqual(started, ['music1', 'book1', 'film1'])
})

test('running torrents claim their own pool, not the shared one', () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: true, downloadQueueSize: 1, downloadQueuePools: POOLS, queueStalledEnabled: false },
    [
      { id: 'film1', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film2', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film3', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film4', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'music1', status: 'queued-download', labels: ['archivist-music'] },
    ],
  )

  session.processQueue()

  // Two films already hold film slots, so only one more film starts, and the
  // shared pool is untouched by them.
  assert.deepEqual(started, ['film3', 'music1'])
})

test('a forced torrent ignores its pool and occupies none of it', () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: true, downloadQueueSize: 5, downloadQueuePools: POOLS, queueStalledEnabled: false },
    [
      { id: 'film1', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film2', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film3', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film4', status: 'queued-download', labels: ['archivist-films'], forceStart: true },
      { id: 'film5', status: 'queued-download', labels: ['archivist-films'] },
    ],
  )

  session.processQueue()

  // The film pool is full, so only the forced torrent starts.
  assert.deepEqual(started, ['film4'])
})

test('a forced torrent frees a slot for the next queued item', () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: true, downloadQueueSize: 5, downloadQueuePools: POOLS, queueStalledEnabled: false },
    [
      { id: 'film1', status: 'downloading', labels: ['archivist-films'], forceStart: true },
      { id: 'film2', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film3', status: 'downloading', labels: ['archivist-films'] },
      { id: 'film4', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film5', status: 'queued-download', labels: ['archivist-films'] },
    ],
  )

  session.processQueue()

  // Three films are running but one of them is forced, so the pool of 3 still
  // has a slot free and exactly one queued film is promoted into it.
  assert.deepEqual(started, ['film4'])
})

test('disabling the queue starts everything at once', () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: false, downloadQueueSize: 1, downloadQueuePools: POOLS, queueStalledEnabled: false },
    [
      { id: 'film1', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film2', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'music1', status: 'queued-download', labels: ['archivist-music'] },
    ],
  )

  session.processQueue()

  assert.deepEqual(started, ['film1', 'film2', 'music1'])
})

test('raising a limit releases waiting torrents immediately', async () => {
  const { session, started } = sessionWith(
    { downloadQueueEnabled: true, downloadQueueSize: 1, downloadQueuePools: {}, queueStalledEnabled: false },
    [
      { id: 'film1', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film2', status: 'queued-download', labels: ['archivist-films'] },
      { id: 'film3', status: 'queued-download', labels: ['archivist-films'] },
    ],
  )

  session.processQueue()
  assert.deepEqual(started, ['film1'])

  await session.updateSettings({ downloadQueueSize: 3 })
  assert.deepEqual(started, ['film1', 'film2', 'film3'])
})

test('settings are clamped and mapped onto the engine labels', () => {
  const settings = normaliseDownloadQueueSettings({
    enabled: true,
    globalLimit: 999,
    perType: { films: 3, series: '2', music: 0, books: null, nonsense: 4 },
  })

  assert.equal(settings.globalLimit, 50)
  assert.deepEqual(settings.perType, { films: 3, series: 2 })

  assert.deepEqual(toSessionQueueSettings(settings), {
    downloadQueueEnabled: true,
    downloadQueueSize: 50,
    downloadQueuePools: { 'archivist-films': 3, 'archivist-series': 2 },
  })
})

test('a missing or malformed setting falls back to the defaults', () => {
  assert.deepEqual(normaliseDownloadQueueSettings(undefined), { enabled: true, globalLimit: 5, perType: {} })
  assert.deepEqual(normaliseDownloadQueueSettings({ globalLimit: -4 }), { enabled: true, globalLimit: 5, perType: {} })
})
