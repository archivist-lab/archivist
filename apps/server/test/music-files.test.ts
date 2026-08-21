import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveTracksFromFiles, isAudioFile, parseTrackFilename } from '../src/shared/music-files.js'

test('reads track numbers and titles out of the usual filename shapes', () => {
  const numbered = parseTrackFilename('/dl/Album/01 - Last Night.mp3', 0)
  assert.equal(numbered.trackNumber, '1')
  assert.equal(numbered.title, 'Last Night')
  assert.equal(numbered.discNumber, 1)

  assert.equal(parseTrackFilename('/dl/Album/02. Everything I Love.flac', 0).title, 'Everything I Love')
  assert.equal(parseTrackFilename('/dl/Album/03_Man Made A Bar.mp3', 0).title, 'Man Made A Bar')

  // Vinyl sides, which MusicBrainz also uses.
  const vinyl = parseTrackFilename('/dl/Album/A1 - Superman.mp3', 0)
  assert.equal(vinyl.trackNumber, 'A1')
  assert.equal(vinyl.title, 'Superman')

  // "Artist - 03 - Title" takes the number nearest the title.
  const embedded = parseTrackFilename('/dl/Album/Morgan Wallen - 03 - Superman.mp3', 0)
  assert.equal(embedded.trackNumber, '3')
  assert.equal(embedded.title, 'Superman')

  // No number at all: the stem is the title and position supplies the number.
  const bare = parseTrackFilename('/dl/Album/Interlude.mp3', 6)
  assert.equal(bare.trackNumber, '7')
  assert.equal(bare.title, 'Interlude')
})

test('a title that merely starts with a letter and digit is not a vinyl side', () => {
  const track = parseTrackFilename('/dl/Album/A1 Steakhouse Blues.mp3', 0)
  assert.equal(track.title, 'A1 Steakhouse Blues', 'no separator means no side')
  assert.equal(track.trackNumber, '1', 'falls back to position')
})

test('disc number comes from the containing folder', () => {
  assert.equal(parseTrackFilename('/dl/Album/CD2/01 - Track.mp3', 0).discNumber, 2)
  assert.equal(parseTrackFilename('/dl/Album/Disc 3/01 - Track.mp3', 0).discNumber, 3)
  assert.equal(parseTrackFilename('/dl/Album/01 - Track.mp3', 0).discNumber, 1)
})

test('a multi-disc download derives one ordered tracklist', () => {
  const derived = deriveTracksFromFiles([
    '/dl/Album/CD2/02 - Fourth.mp3',
    '/dl/Album/CD1/01 - First.mp3',
    '/dl/Album/CD1/02 - Second.mp3',
    '/dl/Album/CD2/01 - Third.mp3',
    '/dl/Album/cover.jpg',
    '/dl/Album/notes.nfo',
  ])
  assert.equal(derived.length, 4, 'artwork and notes are not tracks')
  assert.deepEqual(derived.map(t => t.title), ['First', 'Second', 'Third', 'Fourth'])
  assert.deepEqual(derived.map(t => t.discNumber), [1, 1, 2, 2])
})

test('numeric ordering beats lexical ordering', () => {
  const derived = deriveTracksFromFiles([
    '/dl/Album/10 - Ten.mp3',
    '/dl/Album/2 - Two.mp3',
    '/dl/Album/1 - One.mp3',
  ])
  assert.deepEqual(derived.map(t => t.title), ['One', 'Two', 'Ten'])
})

test('recognises the audio containers music actually ships in', () => {
  for (const ext of ['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.ape', '.wv']) {
    assert.equal(isAudioFile(`/dl/track${ext}`), true, ext)
  }
  for (const ext of ['.jpg', '.nfo', '.txt', '.mkv', '.cue']) {
    assert.equal(isAudioFile(`/dl/file${ext}`), false, ext)
  }
})
