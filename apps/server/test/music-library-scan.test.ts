import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { musicParse, walkAudioGroups } from '../src/services/library-scan.js'

test('existing-library Music discovery groups multi-disc audio as one album', () => {
  const root = mkdtempSync(join(tmpdir(), 'archivist-music-scan-'))
  try {
    const cd1 = join(root, 'Durable Artist', 'Albums', '(2024) Durable Album', 'CD1')
    const cd2 = join(root, 'Durable Artist', 'Albums', '(2024) Durable Album', 'Disc 2')
    mkdirSync(cd1, { recursive: true })
    mkdirSync(cd2, { recursive: true })
    writeFileSync(join(cd1, '01 - First.flac'), 'fixture')
    writeFileSync(join(cd2, '01 - Second.flac'), 'fixture')
    writeFileSync(join(cd2, 'cover.jpg'), 'fixture')

    const groups = walkAudioGroups(root)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].files.length, 2)
    assert.deepEqual(musicParse(groups[0]), {
      artist: 'Durable Artist', title: 'Durable Album', year: 2024, kind: 'album', trackCount: 2,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
