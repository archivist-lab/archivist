import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegPath: string = require('ffmpeg-static')

const dir = mkdtempSync(join(tmpdir(), 'archivist-filemeta-'))
const mkvPath = join(dir, 'sample.mkv')

process.env.ARCHIVIST_DB = join(dir, 'archivist.sqlite')

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, err => err ? reject(err) : resolve())
  })
}

test('synthesize a real mkv with audio, subtitles, and chapters', async () => {
  const srtPath = join(dir, 'subs.srt')
  writeFileSync(srtPath, '1\n00:00:01,200 --> 00:00:01,800\nHello world\n')

  const metaPath = join(dir, 'chapters.ffmeta')
  writeFileSync(metaPath, [
    ';FFMETADATA1',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Opening',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=4000', 'title=Middle',
    '',
  ].join('\n'))

  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=128x72:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-i', srtPath,
    '-f', 'ffmetadata', '-i', metaPath,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-map_metadata', '3', '-map_chapters', '3',
    '-metadata:s:a:0', 'title=Original Audio Title',
    '-metadata:s:a:0', 'language=eng',
    '-metadata:s:s:0', 'language=eng',
    '-c:v', 'mpeg4', '-c:a', 'ac3', '-c:s', 'srt',
    '-y', mkvPath,
  ])
})

test('readFileMetadata reports chapters and stream titles', async () => {
  const { initDb } = await import('../src/db.js')
  initDb(process.env.ARCHIVIST_DB!)
  const { readFileMetadata } = await import('../src/services/media-processor.js')
  const meta = await readFileMetadata(mkvPath)

  assert.equal(meta.chapters.length, 2)
  assert.equal(meta.chapters[0].title, 'Opening')
  // Matroska muxing quantizes chapter marks to frame boundaries — allow slack
  assert.ok(Math.abs(meta.chapters[1].startTime - 2) < 0.05, `start ~2s, got ${meta.chapters[1].startTime}`)
  assert.equal(meta.audioTracks.length, 1)
  assert.equal(meta.audioTracks[0].title, 'Original Audio Title')
  assert.equal(meta.audioTracks[0].language, 'eng')
  assert.equal(meta.subtitleTracks.length, 1)
  assert.ok(meta.durationSeconds && meta.durationSeconds > 3)
})

test('writeFileMetadata rewrites chapters and titles losslessly', async () => {
  const { readFileMetadata, writeFileMetadata } = await import('../src/services/media-processor.js')

  const result = await writeFileMetadata(mkvPath, {
    chapters: [
      { title: 'Intro (renamed)', startTime: 0 },
      { title: 'Act One', startTime: 1.5 },
      { title: 'Finale', startTime: 3 },
    ],
    audioTitles: { 0: 'Director Commentary' },
    subtitleTitles: { 0: 'English SDH' },
    audioLanguages: { 0: 'spa' },
    subtitleLanguages: { 0: 'fra' },
  })
  assert.equal(result.success, true, result.message)
  assert.equal(result.chapters, 3)

  const meta = await readFileMetadata(mkvPath)
  assert.equal(meta.chapters.length, 3)
  assert.deepEqual(meta.chapters.map(c => c.title), ['Intro (renamed)', 'Act One', 'Finale'])
  assert.ok(Math.abs(meta.chapters[1].startTime - 1.5) < 0.05, `start ~1.5s, got ${meta.chapters[1].startTime}`)
  assert.ok(Math.abs(meta.chapters[1].endTime - 3) < 0.05, `end ~3s, got ${meta.chapters[1].endTime}`)
  assert.equal(meta.audioTracks[0].title, 'Director Commentary')
  assert.equal(meta.subtitleTracks[0].title, 'English SDH')
  assert.equal(meta.audioTracks[0].language, 'spa')
  assert.equal(meta.subtitleTracks[0].language, 'fra')
})

test('writeFileMetadata clears a title and can remove all chapters', async () => {
  const { readFileMetadata, writeFileMetadata } = await import('../src/services/media-processor.js')

  const result = await writeFileMetadata(mkvPath, {
    chapters: [],
    audioTitles: { 0: '' },
  })
  assert.equal(result.success, true, result.message)
  assert.equal(result.chapters, 0)

  const meta = await readFileMetadata(mkvPath)
  assert.equal(meta.chapters.length, 0)
  assert.ok(!meta.audioTracks[0].title, 'audio title should be cleared')
  // Subtitle title from the previous edit survives untouched
  assert.equal(meta.subtitleTracks[0].title, 'English SDH')
})

test('writeFileMetadata rejects invalid input safely', async () => {
  const { writeFileMetadata } = await import('../src/services/media-processor.js')

  const badTime = await writeFileMetadata(mkvPath, { chapters: [{ title: 'x', startTime: -5 }] })
  assert.equal(badTime.success, false)

  const beyondEnd = await writeFileMetadata(mkvPath, { chapters: [{ title: 'x', startTime: 9999 }] })
  assert.equal(beyondEnd.success, false)

  const noEdits = await writeFileMetadata(mkvPath, {})
  assert.equal(noEdits.success, false)

  const missing = await writeFileMetadata(join(dir, 'nope.mkv'), { chapters: [] })
  assert.equal(missing.success, false)

  const badExt = await writeFileMetadata(join(dir, 'subs.srt'), { chapters: [] })
  assert.equal(badExt.success, false)
})

test('writeFileMetadata removes tracks and remaps kept-title indexes', async () => {
  const { readFileMetadata, writeFileMetadata } = await import('../src/services/media-processor.js')

  // A richer file: 2 audio + 2 subtitle tracks.
  const multiPath = join(dir, 'multi.mkv')
  const srt2 = join(dir, 'subs2.srt')
  writeFileSync(srt2, '1\n00:00:00,000 --> 00:00:02,000\nBonjour\n')
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=128x72:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4',
    '-i', join(dir, 'subs.srt'), '-i', srt2,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-map', '4:s',
    '-metadata:s:a:0', 'title=English 5.1', '-metadata:s:a:0', 'language=eng',
    '-metadata:s:a:1', 'title=Commentary', '-metadata:s:a:1', 'language=eng',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre',
    '-c:v', 'mpeg4', '-c:a', 'ac3', '-c:s', 'srt',
    '-y', multiPath,
  ])

  // Remove audio #1 (Commentary) and subtitle #0 (eng); retitle the KEPT
  // audio by its original index — the writer must remap it to output 0.
  const result = await writeFileMetadata(multiPath, {
    removeAudio: [1],
    removeSubtitles: [0],
    audioTitles: { 0: 'Main Mix' },
  })
  assert.equal(result.success, true, result.message)

  const meta = await readFileMetadata(multiPath)
  assert.equal(meta.audioTracks.length, 1)
  assert.equal(meta.audioTracks[0].title, 'Main Mix')
  assert.equal(meta.subtitleTracks.length, 1)
  assert.equal(meta.subtitleTracks[0].language, 'fre')
})

test('writeFileMetadata refuses to strip every audio track or unknown indexes', async () => {
  const { writeFileMetadata } = await import('../src/services/media-processor.js')
  const multiPath = join(dir, 'multi.mkv')

  const allAudio = await writeFileMetadata(multiPath, { removeAudio: [0] })
  assert.equal(allAudio.success, false)
  assert.match(allAudio.message, /at least one/i)

  const unknown = await writeFileMetadata(multiPath, { removeSubtitles: [7] })
  assert.equal(unknown.success, false)
  assert.match(unknown.message, /not found/i)
})

test('previewFileTrack extracts only a centred audio or subtitle sample', async () => {
  const { previewFileTrack } = await import('../src/services/media-processor.js')

  const audio = await previewFileTrack(mkvPath, 'audio', 0)
  assert.equal(audio.contentType, 'audio/mpeg')
  assert.ok(audio.data.length > 100)
  assert.ok(audio.startSeconds > 0, `preview starts inside the item, got ${audio.startSeconds}`)
  assert.ok(audio.startSeconds + audio.durationSeconds < 4.1)

  const subtitles = await previewFileTrack(mkvPath, 'subtitle', 0)
  assert.equal(subtitles.contentType, 'text/vtt')
  assert.match(subtitles.data.toString(), /Hello world/)
  await assert.rejects(() => previewFileTrack(mkvPath, 'audio', 99), /not found/)
})

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true })
})
