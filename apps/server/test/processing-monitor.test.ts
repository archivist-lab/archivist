import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDb, resetDbForTests } from '../src/db.js'
import { estimateEtaSeconds, processingMonitorStatus, setProcessingNodePaused } from '../src/system/processing-monitor.js'
import { buildArgs } from '../src/tools/video-engine/executor.js'
import { cancelSegmentAnalysis, enqueueSeason, setSegmentQueuePaused } from '../src/segments/queue.js'
import { DETECTOR_VERSION, segmentDatabaseStatus } from '../src/segments/detector.js'
import { updateSegmentSettings } from '../src/segments/settings.js'

const dir = mkdtempSync(join(tmpdir(), 'archivist-processing-monitor-'))
initDb(join(dir, 'test.db'))

after(() => {
  setProcessingNodePaused('segments', false)
  setProcessingNodePaused('loudness', false)
  setProcessingNodePaused('track-cleaning', false)
  resetDbForTests()
  rmSync(dir, { recursive: true, force: true })
})

test('processing monitor exposes every processing node with queue details', () => {
  const status = processingMonitorStatus()
  assert.deepEqual(status.nodes.map(node => node.id), ['segments', 'loudness', 'video', 'audio', 'track-cleaning'])
  for (const node of status.nodes) {
    assert.equal(Array.isArray(node.activeItems), true)
    assert.equal(Array.isArray(node.queuedItems), true)
    assert.equal(typeof node.queuedCount, 'number')
  }
  assert.equal(status.nodes.find(node => node.id === 'audio')?.sharedWith, 'video')
})

test('processing monitor ETA is derived from elapsed time and completed progress', () => {
  assert.equal(estimateEtaSeconds(0.25, 1_000, 11_000), 30)
  assert.equal(estimateEtaSeconds(0, 1_000, 11_000), null)
  assert.equal(estimateEtaSeconds(null, 1_000, 11_000), null)
  assert.equal(estimateEtaSeconds(0.5, null, 11_000), null)
})

test('pause-after-current nodes and immediate-pause nodes report their state', () => {
  assert.equal(setProcessingNodePaused('segments', true), true)
  assert.equal(setProcessingNodePaused('loudness', true), true)
  const status = processingMonitorStatus()
  assert.equal(status.nodes.find(node => node.id === 'segments')?.pauseBehavior, 'after-current')
  assert.equal(status.nodes.find(node => node.id === 'segments')?.paused, true)
  assert.equal(status.nodes.find(node => node.id === 'loudness')?.pauseBehavior, 'immediate')
  assert.equal(status.nodes.find(node => node.id === 'loudness')?.paused, true)
})

test('audio policy produces per-track encode and preservation arguments', () => {
  const args = buildArgs({
    action: 'convert', inputPath: '/input.mkv', outputPath: '/output.mkv', durationSec: 100,
    audio: {
      policy: { enabled: true, targetCodec: 'opus', stereoBitrateKbps: 128, keepCodecs: ['eac3'], preserveLossless: true },
      streams: [
        { index: 1, codec: 'aac', language: 'eng', channels: 2, channelLayout: 'stereo', bitrateBps: null, default: true, forced: false, commentary: false },
        { index: 2, codec: 'truehd', language: 'eng', channels: 8, channelLayout: '7.1', bitrateBps: null, default: false, forced: false, commentary: false },
      ],
    },
  })
  assert.deepEqual(args.slice(args.indexOf('-c:a:0'), args.indexOf('-c:s')), ['-c:a:0', 'libopus', '-b:a:0', '128k', '-c:a:1', 'copy'])
})

test('completed segment results stay visible and are not automatically requeued', () => {
  const db = getDb()
  const libraryId = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Series', 'series', 'fixture-series.db')").run().lastInsertRowid)
  const seriesId = Number(db.prepare("INSERT INTO series (library_id, title) VALUES (?, 'Result Fixture')").run(libraryId).lastInsertRowid)
  const seasonId = Number(db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, 1)').run(seriesId).lastInsertRowid)
  const firstEpisode = Number(db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, file_size) VALUES (?, ?, 1, 1, 'Complete', 'collected', '/media/complete.mkv', 1234)").run(seriesId, seasonId).lastInsertRowid)
  db.prepare("INSERT INTO media_segments (media_signature, file_size, detector_version, analysis_state, attempts, analysed_at) VALUES ('fixture-signature', 1234, ?, 'detected', 1, datetime('now'))").run(DETECTOR_VERSION)
  db.prepare("INSERT INTO media_segment_links (episode_id, media_signature, file_path, file_size) VALUES (?, 'fixture-signature', '/media/complete.mkv', 1234)").run(firstEpisode)

  updateSegmentSettings({ enabled: true, maxAttempts: 3 })
  setSegmentQueuePaused(true)
  assert.equal(enqueueSeason(seriesId, 1), false)
  const result = segmentDatabaseStatus().results.find((row: any) => row.episodeId === firstEpisode) as any
  assert.equal(result.seriesTitle, 'Result Fixture')
  assert.equal(result.state, 'detected')

  db.prepare("UPDATE media_segments SET detector_version = 'outdated-detector' WHERE media_signature = 'fixture-signature'").run()
  assert.equal(enqueueSeason(seriesId, 1), true)
  assert.equal(cancelSegmentAnalysis(`${seriesId}:1`), 1)
  db.prepare("UPDATE media_segments SET detector_version = ?, analysis_state = 'detected' WHERE media_signature = 'fixture-signature'").run(DETECTOR_VERSION)

  db.prepare("INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, status, file_path, file_size) VALUES (?, ?, 1, 2, 'New', 'collected', '/media/new.mkv', 5678)").run(seriesId, seasonId)
  assert.equal(enqueueSeason(seriesId, 1), true)
  assert.equal(cancelSegmentAnalysis(`${seriesId}:1`), 1)
  setSegmentQueuePaused(false)
})
