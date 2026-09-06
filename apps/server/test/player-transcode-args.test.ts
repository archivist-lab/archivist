import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscodeArgs } from '../src/player/media.js'
import type { ResolvedEncoder } from '../src/tools/video-engine/hwaccel.js'

const vaapi: ResolvedEncoder = { encoder: 'h264_vaapi', accelerator: 'vaapi', device: '/dev/dri/renderD128' }
const qsv: ResolvedEncoder = { encoder: 'h264_qsv', accelerator: 'qsv', device: '/dev/dri/renderD128' }
const nvenc: ResolvedEncoder = { encoder: 'h264_nvenc', accelerator: 'nvenc', device: null }

/** Index of a flag's value, or -1. */
const valueOf = (args: string[], flag: string) => {
  const i = args.indexOf(flag)
  return i < 0 ? null : args[i + 1]
}

test('H.264 with no burn-in is copied, so no encoder is involved', () => {
  for (const encode of [null, vaapi, nvenc]) {
    const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'h264' }, encode)
    assert.equal(valueOf(args, '-c:v'), 'copy')
    assert.ok(!args.includes('-vf'), 'a copy needs no filter chain')
    assert.ok(!args.includes('-vaapi_device'), 'a copy never initialises a GPU device')
  }
})

test('software encoding keeps the previous flags exactly', () => {
  const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'hevc' }, null)
  assert.equal(valueOf(args, '-c:v'), 'libx264')
  assert.equal(valueOf(args, '-preset'), 'veryfast')
  assert.equal(valueOf(args, '-crf'), '21')
  assert.equal(valueOf(args, '-pix_fmt'), 'yuv420p')
})

test('VAAPI initialises the device before -i and uploads after decoding', () => {
  const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'hevc' }, vaapi)
  assert.equal(valueOf(args, '-c:v'), 'h264_vaapi')
  assert.equal(valueOf(args, '-vaapi_device'), '/dev/dri/renderD128')
  assert.ok(args.indexOf('-vaapi_device') < args.indexOf('-i'), 'device init must precede the input')
  assert.equal(valueOf(args, '-vf'), 'format=nv12,hwupload')
  assert.equal(valueOf(args, '-rc_mode'), 'CQP')
  assert.ok(!args.includes('-pix_fmt'), 'the filter chain owns the pixel format on VAAPI')
})

test('QSV initialises both devices and uploads', () => {
  const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'hevc' }, qsv)
  assert.equal(valueOf(args, '-c:v'), 'h264_qsv')
  assert.ok(args.includes('-filter_hw_device'))
  assert.ok(args.indexOf('-init_hw_device') < args.indexOf('-i'))
  assert.equal(valueOf(args, '-vf'), 'hwupload=extra_hw_frames=64,format=qsv')
})

test('NVENC takes software frames, so it needs no device or upload filter', () => {
  const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'hevc' }, nvenc)
  assert.equal(valueOf(args, '-c:v'), 'h264_nvenc')
  assert.ok(!args.includes('-vaapi_device'))
  assert.ok(!args.includes('-vf'), 'nothing to filter without burn-in')
  assert.equal(valueOf(args, '-cq'), '21')
})

test('no pipeline ever round-trips frames back to system memory', () => {
  for (const encode of [null, vaapi, qsv, nvenc]) {
    for (const videoCodec of ['h264', 'hevc']) {
      const args = buildTranscodeArgs('/media/film.mkv', { videoCodec, subtitleIndex: undefined }, encode)
      assert.ok(!args.join(' ').includes('hwdownload'), 'a hwdownload/hwupload cycle costs more than the GPU saves')
    }
  }
})

test('burn-in runs the subtitle filter before the upload', () => {
  const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'h264', subtitleIndex: 3 }, vaapi)
  assert.equal(valueOf(args, '-c:v'), 'h264_vaapi', 'burn-in forces an encode even for H.264')
  const chain = valueOf(args, '-vf') ?? ''
  assert.ok(chain.startsWith('subtitles='), 'subtitles is a software filter and must run before hwupload')
  assert.ok(chain.endsWith('format=nv12,hwupload'))
})

test('seek stays a fast pre-input seek, and audio is unchanged', () => {
  const args = buildTranscodeArgs('/media/film.mkv', { videoCodec: 'hevc', startSec: 120, audioIndex: 2, audioFilter: 'loudnorm=I=-18' }, vaapi)
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), '-ss before -i is the fast seek')
  assert.equal(valueOf(args, '-af'), 'loudnorm=I=-18')
  assert.equal(valueOf(args, '-c:a'), 'aac')
  assert.equal(valueOf(args, '-map'), '0:v:0')
  assert.ok(args.includes('0:2'), 'the selected audio stream is mapped')
})
