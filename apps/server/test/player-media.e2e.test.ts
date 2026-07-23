import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startTestApp, type TestHarness } from './helpers.js'
import { getDb } from '../src/db.js'

/**
 * Player media endpoints: track probing, WebVTT subtitle extraction, and the
 * compatibility transcode. Builds a synthetic MKV (H.264 video + AC3 audio +
 * SRT subtitle) so the "not directly playable" fallback path is exercised for
 * real through ffmpeg/ffprobe.
 */

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string
const ffprobe = (require('ffprobe-static') as { path: string }).path

let h: TestHarness
let filmId: number
let editionId: number

test('boot and build a synthetic MKV with AC3 audio + SRT subtitles', async () => {
  h = await startTestApp()
  const db = getDb()
  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id

  const dir = join(process.env.ARCHIVIST_MEDIA_BASE!, 'films', 'Codec Test (2024)')
  mkdirSync(dir, { recursive: true })
  const srt = join(dir, 'subs.srt')
  writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,500\nHello from the subtitle track.\n\n2\n00:00:02,600 --> 00:00:04,000\nSecond line.\n')
  const file = join(dir, 'Codec Test (2024).mkv')

  // 4s H.264 video + AC3 audio (browser-unfriendly) + muxed SRT subtitle.
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng',
    '-metadata:s:s:0', 'language=eng',
    file,
  ], { stdio: 'pipe' })

  filmId = db.prepare(`
    INSERT INTO films (library_id, title, sort_title, year, runtime, genres, status, file_path, file_size)
    VALUES (?, 'Codec Test', 'Codec Test', 2024, 1, '[]', 'collected', ?, 1000)
  `).run(filmsLib, file).lastInsertRowid as number

  const editionFile = join(dir, 'Codec Test - Mobile.mp4')
  execFileSync(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=550:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', editionFile,
  ], { stdio: 'pipe' })
  editionId = Number(db.prepare(`INSERT INTO film_editions
    (film_id, edition_name, file_path, status, current_resolution, current_codec)
    VALUES (?, 'Mobile Edition', ?, 'collected', '480p', 'h264')`).run(filmId, editionFile).lastInsertRowid)
})

after(async () => { await h?.close() })

test('tracks endpoint reports codecs and browser compatibility', async () => {
  const res = await h.request('GET', `/api/v1/player/stream/films/${filmId}/tracks`)
  assert.equal(res.status, 200)
  const t = res.json
  assert.equal(t.video.codec, 'h264')
  assert.deepEqual([t.video.width, t.video.height], [320, 240])
  assert.equal(t.video.browserFriendly, true)
  assert.equal(t.audio.length, 1)
  assert.equal(t.audio[0].codec, 'ac3')
  assert.equal(t.audio[0].browserFriendly, false, 'AC3 is not browser-decodable')
  assert.equal(t.audio[0].language, 'English')
  assert.equal(t.audio[0].languageCode, 'eng', 'raw audio language tag is preserved for player flags')
  assert.equal(t.subtitles.length, 1)
  assert.equal(t.subtitles[0].languageCode, 'eng', 'raw subtitle language tag is preserved for player flags')
  assert.equal(t.subtitles[0].textBased, true, 'SRT is text-based')
  assert.equal(t.directPlayable, false, 'AC3 audio makes it not directly playable')
  assert.ok(t.durationSec >= 3 && t.durationSec <= 5, `duration ~4s, got ${t.durationSec}`)
})

test('selected film edition is used consistently for detail and probing', async () => {
  const detail = await h.request('GET', `/api/v1/player/films/${filmId}?profile=kodi`)
  const edition = detail.json.editions.find((item: any) => item.id === editionId)
  assert.equal(edition.playback.streamUrl, `/api/v1/player/stream/films/${filmId}?edition=${editionId}`)
  const tracks = await h.request('GET', `/api/v1/player/stream/films/${filmId}/tracks?edition=${editionId}`)
  assert.equal(tracks.status, 200)
  assert.deepEqual([tracks.json.video.width, tracks.json.video.height], [160, 120])
})

const browserCapabilities = {
  version: 1, clientId: 'test-browser',
  containers: ['mp4'], videoCodecs: ['h264'], audioCodecs: ['aac'],
  subtitleCodecs: ['webvtt'], hdrModes: ['sdr'],
  maxWidth: 1920, maxHeight: 1080,
  supportsRemux: false, supportsSegmentedStreaming: true,
}

test('playback planning selects transcode for incompatible audio and container', async () => {
  const res = await h.request('POST', `/api/v1/player/stream/films/${filmId}/plan`, { body: { capabilities: browserCapabilities } })
  assert.equal(res.status, 200)
  assert.equal(res.json.version, 1)
  assert.equal(res.json.mode, 'transcode')
  assert.equal(res.json.videoDecision.action, 'copy')
  assert.equal(res.json.audioDecision.action, 'transcode')
  assert.ok(res.json.reasons.includes('audio-codec-unsupported'))
  assert.match(res.json.mediaUrl, /\/transcode\?audio=/)
})

test('playback planning selects direct play for a compatible edition', async () => {
  const res = await h.request('POST', `/api/v1/player/stream/films/${filmId}/plan`, { body: { capabilities: browserCapabilities, editionId } })
  assert.equal(res.status, 200)
  assert.equal(res.json.mode, 'direct')
  assert.equal(res.json.mediaUrl, `/api/v1/player/stream/films/${filmId}?edition=${editionId}`)
  assert.deepEqual(res.json.reasons, ['direct-compatible'])
})

test('playback planning rejects unsupported capability profiles', async () => {
  const res = await h.request('POST', `/api/v1/player/stream/films/${filmId}/plan`, { body: { capabilities: { ...browserCapabilities, version: 99 } } })
  assert.equal(res.status, 400)
  assert.match(res.json.error, /capability version/)
})

test('Kodi sync manifest uses exact probed runtime and complete stream details', async () => {
  const res = await h.request('GET', '/api/v1/player/sync/manifest?profile=kodi')
  assert.equal(res.status, 200)
  const film = res.json.films.find((item: any) => item.id === filmId)
  assert.ok(film.runtimeSeconds >= 3 && film.runtimeSeconds <= 5, `exact runtime ~4s, got ${film.runtimeSeconds}`)
  assert.notEqual(film.runtimeSeconds, 60, 'provider runtime minutes must not replace the file duration')
  assert.deepEqual([film.mediaInfo.video.codec, film.mediaInfo.video.width, film.mediaInfo.video.height], ['h264', 320, 240])
  assert.deepEqual([film.mediaInfo.audio[0].codec, film.mediaInfo.audio[0].channels], ['ac3', 1])
  assert.equal(film.mediaInfo.subtitles[0].language, 'eng')
  const cached = getDb().prepare(`SELECT file_path, file_size, payload FROM player_media_probes
    WHERE media_type = 'film' AND media_id = ?`).get(filmId) as any
  assert.ok(cached)
  assert.ok(cached.file_size > 0)
  assert.equal(JSON.parse(cached.payload).video.codec, 'h264')
  assert.ok(!JSON.stringify(film).includes(cached.file_path), 'manifest must never expose cached server paths')
})

test('subtitle endpoint converts SRT to WebVTT', async () => {
  const tracks = (await h.request('GET', `/api/v1/player/stream/films/${filmId}/tracks`)).json
  const sub = tracks.subtitles[0]
  const res = await h.request('GET', `/api/v1/player/stream/films/${filmId}/subtitle/${sub.index}.vtt`)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'] as string, /text\/vtt/)
  assert.match(res.text, /^WEBVTT/)
  assert.match(res.text, /Hello from the subtitle track/)
})

test('transcode endpoint returns a browser-playable MP4 (H.264 + AAC)', async () => {
  // Fetch the transcode to a temp file, then probe it.
  const url = `${h.baseUrl}/api/v1/player/stream/films/${filmId}/transcode`
  const resp = await fetch(url, { headers: h.authHeaders })
  assert.equal(resp.status, 200)
  assert.match(resp.headers.get('content-type') ?? '', /video\/mp4/)
  const buf = Buffer.from(await resp.arrayBuffer())
  assert.ok(buf.length > 1000, `expected real MP4 bytes, got ${buf.length}`)

  const out = join(process.env.ARCHIVIST_MEDIA_BASE!, 'transcode-out.mp4')
  writeFileSync(out, buf)
  const probe = execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_type,codec_name', out,
  ], { encoding: 'utf8' })
  const streams = JSON.parse(probe).streams as Array<{ codec_type: string; codec_name: string }>
  const v = streams.find(s => s.codec_type === 'video')
  const a = streams.find(s => s.codec_type === 'audio')
  assert.equal(v?.codec_name, 'h264', 'video is H.264')
  assert.equal(a?.codec_name, 'aac', 'audio is AAC (browser-playable)')
})

test('transcode with a seek offset still produces valid MP4', async () => {
  const resp = await fetch(`${h.baseUrl}/api/v1/player/stream/films/${filmId}/transcode?t=2`, { headers: h.authHeaders })
  assert.equal(resp.status, 200)
  const buf = Buffer.from(await resp.arrayBuffer())
  assert.ok(buf.length > 500, 'seeked transcode yields bytes')
})

test('tracks trigger lazy loudness measurement (EBU R128)', async () => {
  const first = await h.request('GET', `/api/v1/player/stream/films/${filmId}/tracks`)
  assert.equal(first.json.targetLufs, -16)
  // First call schedules a background measure; poll until it lands.
  let loudness: any = first.json.loudness
  for (let i = 0; i < 40 && !loudness; i++) {
    await new Promise(r => setTimeout(r, 250))
    loudness = (await h.request('GET', `/api/v1/player/stream/films/${filmId}/tracks`)).json.loudness
  }
  assert.ok(loudness, 'loudness measured and cached')
  assert.ok(Number.isFinite(loudness.integratedLufs), `integrated LUFS is a number, got ${loudness.integratedLufs}`)
  assert.ok(Number.isFinite(loudness.truePeak), 'true peak measured')
})

test('normalized transcode applies loudnorm and stays valid H.264 + AAC', async () => {
  const resp = await fetch(`${h.baseUrl}/api/v1/player/stream/films/${filmId}/transcode?norm=-16`, { headers: h.authHeaders })
  assert.equal(resp.status, 200)
  const buf = Buffer.from(await resp.arrayBuffer())
  const out = join(process.env.ARCHIVIST_MEDIA_BASE!, 'norm-out.mp4')
  writeFileSync(out, buf)
  const probe = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'stream=codec_type,codec_name,sample_rate', out,
  ], { encoding: 'utf8' }))
  const a = (probe.streams as any[]).find(s => s.codec_type === 'audio')
  assert.equal(a?.codec_name, 'aac', 'normalized audio is still AAC')
  assert.equal(a?.sample_rate, '48000', 'resampled to 48kHz after loudnorm')
})

test('backfill sweep measures the whole library with bounded concurrency', async () => {
  const { getDb } = await import('../src/db.js')
  const { sweepUnmeasured, loudnessQueueStatus } = await import('../src/player/loudness.js')
  const db = getDb()
  const filmsLib = (db.prepare("SELECT id FROM libraries WHERE media_type = 'films' LIMIT 1").get() as any).id
  const dir = join(process.env.ARCHIVIST_MEDIA_BASE!, 'films')

  // A handful of quick 2s clips so the sweep has real work to do.
  const ids: number[] = []
  for (let i = 0; i < 4; i++) {
    const file = join(dir, `sweep-${i}.mkv`)
    execFileSync(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10',
      '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 50}:duration=2`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
    ], { stdio: 'pipe' })
    ids.push(db.prepare(`
      INSERT INTO films (library_id, title, sort_title, year, genres, status, file_path, file_size)
      VALUES (?, ?, ?, 2024, '[]', 'collected', ?, 500)
    `).run(filmsLib, `Sweep ${i}`, `Sweep ${i}`, file).lastInsertRowid as number)
  }

  const queued = sweepUnmeasured()
  assert.ok(queued >= 4, `sweep queued the new films, got ${queued}`)
  // Concurrency is bounded — never more active than the configured limit.
  const status = loudnessQueueStatus()
  assert.ok(status.concurrency >= 1)
  assert.ok(status.active <= status.concurrency, 'active measurements respect the concurrency cap')

  // Wait for the queue to drain and every clip to be measured.
  for (let i = 0; i < 80; i++) {
    const done = ids.every(id => db.prepare("SELECT 1 FROM media_loudness WHERE media_type='film' AND media_id=?").get(id))
    if (done) break
    await new Promise(r => setTimeout(r, 250))
  }
  for (const id of ids) {
    const row = db.prepare("SELECT integrated_lufs FROM media_loudness WHERE media_type='film' AND media_id=?").get(id) as any
    assert.ok(row && Number.isFinite(row.integrated_lufs), `film ${id} measured by sweep`)
  }

  // Re-sweeping is a no-op — already-measured items are skipped.
  assert.equal(sweepUnmeasured(), 0, 'nothing left to measure after backfill')
})

test('loudness status endpoint reports the queue', async () => {
  const res = await h.request('GET', '/api/v1/player/loudness/status')
  assert.equal(res.status, 200)
  assert.ok(res.json.concurrency >= 1)
  assert.ok(res.json.measured >= 4, 'reports measured count')
  assert.ok('active' in res.json && 'queued' in res.json)
})
