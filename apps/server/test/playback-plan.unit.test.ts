import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlayerClientCapabilities } from '@archivist/contracts'
import { buildPlaybackPlan } from '../src/player/playback-plan.js'
import type { MediaTracks } from '../src/player/media.js'

/**
 * Capability negotiation, without ffmpeg.
 *
 * The case that matters: an HEVC library. Kodi and Safari decode HEVC natively,
 * so they must direct-play it; Chrome cannot, so it must transcode. The old
 * decision was a single server-side boolean that said 'no browser plays HEVC'
 * and sent every client to the transcoder.
 */

const hevcFile: MediaTracks = {
  container: 'matroska,webm',
  durationSec: 5400,
  video: { codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', width: 3840, height: 2160, browserFriendly: false },
  audio: [{ index: 1, codec: 'aac', languageCode: 'eng', language: 'English', title: null, channels: 2, channelLayout: 'stereo', default: true, browserFriendly: true }],
  subtitles: [],
  directPlayable: false,
  chapters: [],
}

const client = (over: Partial<PlayerClientCapabilities> = {}): PlayerClientCapabilities => ({
  version: 1, clientId: 'test',
  containers: ['mp4', 'matroska'],
  videoCodecs: ['h264'],
  audioCodecs: ['aac', 'mp3'],
  subtitleCodecs: ['webvtt'],
  hdrModes: ['sdr'],
  maxWidth: null, maxHeight: null, maxVideoBitrate: null,
  supportsRemux: false, supportsSegmentedStreaming: false,
  ...over,
})

const plan = (tracks: MediaTracks, capabilities: PlayerClientCapabilities) => buildPlaybackPlan({
  tracks, capabilities, directUrl: '/direct', transcodeUrl: '/transcode', subtitleUrl: i => `/sub/${i}`,
})

test('an HEVC-capable client direct-plays an HEVC file', () => {
  const result = plan(hevcFile, client({ videoCodecs: ['h264', 'hevc'] }))
  assert.equal(result.mode, 'direct')
  assert.equal(result.videoDecision.action, 'copy')
  assert.equal(result.mediaUrl, '/direct')
})

test('a client without HEVC transcodes the same file', () => {
  const result = plan(hevcFile, client())
  assert.equal(result.mode, 'transcode')
  assert.ok(result.reasons.includes('video-unsupported'))
})

test('the server-side directPlayable flag no longer decides for a capable client', () => {
  // The file is flagged not-directly-playable by the coarse probe, yet a client
  // that reports HEVC still gets the original file. This is the whole fix.
  assert.equal(hevcFile.directPlayable, false)
  assert.equal(plan(hevcFile, client({ videoCodecs: ['hevc'] })).mode, 'direct')
})

test('a resolution ceiling forces a transcode even when the codec is supported', () => {
  const result = plan(hevcFile, client({ videoCodecs: ['hevc'], maxHeight: 1080 }))
  assert.equal(result.mode, 'transcode')
  assert.ok(result.reasons.includes('video-unsupported'))
})

test('unsupported audio alone transcodes, and names only that reason', () => {
  const dtsFile: MediaTracks = {
    ...hevcFile,
    video: { ...hevcFile.video!, codec: 'h264', browserFriendly: true },
    audio: [{ ...hevcFile.audio[0], codec: 'dts', browserFriendly: false }],
  }
  const result = plan(dtsFile, client())
  assert.equal(result.mode, 'transcode')
  assert.deepEqual(result.audioDecision, { action: 'transcode', codec: 'dts', reason: 'audio-codec-unsupported' })
  assert.ok(!result.reasons.includes('video-unsupported'), 'the video is fine; only the audio is not')
})

test('a bitmap subtitle forces burn-in; a text one is converted', () => {
  const withSubs = (codec: string, textBased: boolean): MediaTracks => ({
    ...hevcFile,
    video: { ...hevcFile.video!, codec: 'h264', browserFriendly: true },
    subtitles: [{ index: 2, codec, languageCode: 'eng', language: 'English', title: null, default: true, forced: false, textBased }],
  })
  const bitmap = buildPlaybackPlan({
    tracks: withSubs('hdmv_pgs_subtitle', false), capabilities: client(),
    directUrl: '/direct', transcodeUrl: '/transcode', subtitleUrl: i => `/sub/${i}`, subtitleTrackIndex: 2,
  })
  assert.equal(bitmap.subtitleMode, 'burn-in')
  assert.equal(bitmap.mode, 'transcode')

  const text = buildPlaybackPlan({
    tracks: withSubs('subrip', true), capabilities: client(),
    directUrl: '/direct', transcodeUrl: '/transcode', subtitleUrl: i => `/sub/${i}`, subtitleTrackIndex: 2,
  })
  assert.equal(text.subtitleMode, 'convert')
  assert.equal(text.mode, 'direct', 'a WebVTT sidecar does not need the transcoder')
})
