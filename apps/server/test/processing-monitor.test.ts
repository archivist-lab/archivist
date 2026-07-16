import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDb, resetDbForTests } from '../src/db.js'
import { processingMonitorStatus, setProcessingNodePaused } from '../src/system/processing-monitor.js'
import { buildArgs } from '../src/tools/video-engine/executor.js'

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

