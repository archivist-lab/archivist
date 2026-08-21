import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import { createImportPlan } from '../src/services/media-imports.js'

// A discography pack holds more than the library tracks: alternate pressings,
// EPs, bonus DVDs, and rip sidecars. It is also the common case for a torrent
// where the user deselected the duplicates. Neither may block the import of the
// albums that did match.

const TRACKED_ALBUMS = ['Is This It', 'Room on Fire', 'Comedown Machine', 'Reality Awaits']

function db() {
  const conn = new DatabaseCtor(':memory:')
  conn.exec(`CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER, title TEXT, year INTEGER, status TEXT)`)
  const insert = conn.prepare('INSERT INTO albums (artist_id, title, year, status) VALUES (7, ?, ?, ?)')
  TRACKED_ALBUMS.forEach((title, i) => insert.run(title, 2001 + i, 'acquiring'))
  return conn as any
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'archivist-disco-'))
  const write = (rel: string) => {
    const target = join(root, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'x')
    return rel
  }
  const paths = [
    // Selected: the pressings the library tracks.
    write('2001 - Is This It (US)/01 - Is This It.flac'),
    write('2001 - Is This It (US)/02 - The Modern Age.flac'),
    write('2001 - Is This It (US)/The Strokes - Is This It.cue'),
    write('2001 - Is This It (US)/The Strokes - Is This It.log'),
    write('2001 - Is This It (US)/Folder.jpg'),
    write('2003 - Room on Fire/01 - What Ever Happened.flac'),
    write('2013 - Comedown Machine/01 - Tap Out.flac'),
    // Present in the pack, absent from the library.
    write('2001 - The Modern Age [EP]/01 - The Modern Age.flac'),
    write('NFO.nfo'),
  ]
  return { root, paths }
}

test('a discography plan imports matched albums despite extras and sidecars', () => {
  const { root, paths } = tree()
  try {
    const plan = createImportPlan(
      { mediaType: 'music-discography', itemId: 7, sourcePath: root, torrentId: 't', infoHash: 'h' } as any,
      db(), root,
      paths.map(name => ({ name, wanted: true })),
    )
    assert.notEqual(plan.status, 'blocked', `plan blocked: ${plan.errors.join('; ')}`)
    const targets = new Set(plan.files.map(f => f.target))
    assert.ok(targets.has('Is This It'), 'Is This It matched')
    assert.ok(targets.has('Room on Fire'), 'Room on Fire matched')
    assert.ok(targets.has('Comedown Machine'), 'Comedown Machine matched')
    // The unreleased album has no folder — a warning, never a blocker.
    assert.ok(plan.warnings.some(w => w.includes('not matched')), 'unmatched album warned')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rip sidecars never linger as unmatched files', () => {
  const { root, paths } = tree()
  try {
    const plan = createImportPlan(
      { mediaType: 'music-discography', itemId: 7, sourcePath: root, torrentId: 't', infoHash: 'h' } as any,
      db(), root,
      paths.map(name => ({ name, wanted: true })),
    )
    const stillUnmatched = plan.ignored.filter(f => f.role === 'unmatched').map(f => f.name)
    assert.deepEqual(stillUnmatched.filter(n => /\.(cue|log|accurip)$/i.test(n)), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a source holding only deselected files says so', () => {
  const { root, paths } = tree()
  try {
    const plan = createImportPlan(
      { mediaType: 'music-discography', itemId: 7, sourcePath: root, torrentId: 't', infoHash: 'h' } as any,
      db(), root,
      paths.map(name => ({ name, wanted: false })),
    )
    assert.equal(plan.status, 'blocked')
    assert.match(plan.errors[0] ?? '', /deselected/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
