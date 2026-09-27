import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import { namesEpisode } from '../src/shared/episode-code.js'
import { createImportPlan } from '../src/services/media-imports.js'

test('episode codes are recognised however a pack spells them', () => {
  const yes: Array<[string, number, number]> = [
    ['Spider-Man T.A.S - S01 E01 - Night of the Lizard (1080p).mp4', 1, 1],
    ['Show.S01E01.1080p.mkv', 1, 1],
    ['Show S01.E02.mkv', 1, 2],
    ['Show - S1E3.mkv', 1, 3],
    ['Show.S02E05E06.mkv', 2, 6],
    ['Show.S02E05-E06.mkv', 2, 6],
    ['Show 1x07 Title.mkv', 1, 7],
    ['Show Season 3 Episode 12.mkv', 3, 12],
  ]
  for (const [name, season, episode] of yes) assert.ok(namesEpisode(name, season, episode), `${name} is S${season}E${episode}`)
})

test('episode codes never match a neighbour', () => {
  assert.equal(namesEpisode('Show.S01E10.mkv', 1, 1), false, 'E1 is not E10')
  assert.equal(namesEpisode('Show.S10E01.mkv', 1, 1), false, 'S1 is not S10')
  assert.equal(namesEpisode('Show.S01E01.mkv', 2, 1), false, 'a different season')
  assert.equal(namesEpisode('Show 11x01.mkv', 1, 1), false, '11x01 is not 1x01')
  assert.equal(namesEpisode('Show.Season.1.Episode.10.mkv', 1, 1), false)
})

function spiderManLibrary() {
  const db = new DatabaseCtor(':memory:')
  db.exec(`CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, year INTEGER)`)
  db.exec(`CREATE TABLE seasons (id INTEGER PRIMARY KEY, series_id INTEGER, season_number INTEGER)`)
  db.exec(`CREATE TABLE episodes (id INTEGER PRIMARY KEY, series_id INTEGER, season_number INTEGER, episode_number INTEGER, status TEXT, title TEXT)`)
  db.prepare('INSERT INTO series VALUES (205, ?, 1994)').run('Spider-Man')
  let episodeId = 120_000
  for (const season of [1, 2]) {
    db.prepare('INSERT INTO seasons VALUES (?, 205, ?)').run(7850 + season, season)
    for (let episode = 1; episode <= 3; episode++) db.prepare('INSERT INTO episodes VALUES (?, 205, ?, ?, ?, NULL)').run(episodeId++, season, episode, 'acquiring')
  }
  return db
}

function spiderManPack() {
  const root = mkdtempSync(join(tmpdir(), 'archivist-spiderman-'))
  const paths: string[] = []
  const add = (path: string, bytes = 64) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), Buffer.alloc(bytes)); paths.push(path) }
  for (const [season, folder] of [[1, 'Season 1 (1994-95)'], [2, 'Season 2 (1995-96)']] as const) {
    for (let episode = 1; episode <= 3; episode++) {
      const name = `Spider-Man T.A.S - S0${season} E0${episode} - Title (1080p)`
      add(`${folder}/${name}.mp4`, 4096)
      add(`${folder}/${name}.srt`)
    }
  }
  add('Torrent Description (READ Me).txt')
  add('Other SUPERHERO-Related Cartoons, Shows, and Movies, HERE/BATMAN The Animated Series.txt')
  return { root, paths }
}

test('a season pack spelling S01 E01 plans rather than blocks', () => {
  const { root, paths } = spiderManPack()
  try {
    const plan = createImportPlan({ mediaType: 'series-season', itemId: 7851, sourcePath: root, torrentId: 't', infoHash: 'h' } as any,
      spiderManLibrary(), root, paths.map(name => ({ name, wanted: true })))
    assert.notEqual(plan.status, 'blocked', `plan blocked: ${plan.errors.join('; ')}`)
    assert.equal(plan.files.filter(f => f.role === 'primary').length, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the whole series plans from the same pack', () => {
  const { root, paths } = spiderManPack()
  try {
    const plan = createImportPlan({ mediaType: 'series', itemId: 205, sourcePath: root, torrentId: 't', infoHash: 'h' } as any,
      spiderManLibrary(), root, paths.map(name => ({ name, wanted: true })))
    assert.notEqual(plan.status, 'blocked', `plan blocked: ${plan.errors.join('; ')}`)
    assert.equal(plan.files.filter(f => f.role === 'primary').length, 6)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function careBears(collected: boolean) {
  const db = new DatabaseCtor(':memory:')
  db.exec(`CREATE TABLE series (id INTEGER PRIMARY KEY, title TEXT, year INTEGER)`)
  db.exec(`CREATE TABLE seasons (id INTEGER PRIMARY KEY, series_id INTEGER, season_number INTEGER)`)
  db.exec(`CREATE TABLE episodes (id INTEGER PRIMARY KEY, series_id INTEGER, season_number INTEGER, episode_number INTEGER, status TEXT, title TEXT)`)
  db.prepare('INSERT INTO series VALUES (251, ?, 1985)').run('The Care Bears')
  db.prepare('INSERT INTO seasons VALUES (9248, 251, 3)').run()
  for (let episode = 1; episode <= 3; episode++) db.prepare('INSERT INTO episodes VALUES (?, 251, 3, ?, ?, NULL)').run(130_000 + episode, episode, collected ? 'collected' : 'missing')
  const root = mkdtempSync(join(tmpdir(), 'archivist-carebears-'))
  const paths: string[] = []
  for (let episode = 1; episode <= 3; episode++) {
    const name = `Care Bears S03e0${episode}-Title (1080).mp4`
    writeFileSync(join(root, name), Buffer.alloc(4096)); paths.push(name)
  }
  return { db, root, files: paths.map(name => ({ name, wanted: true })) }
}

test('a season already in the library says to force it, and a forced plan replaces it', () => {
  const { db, root, files } = careBears(true)
  try {
    const payload = { mediaType: 'series-season', itemId: 9248, sourcePath: root, torrentId: 't', infoHash: 'h' } as any
    const ordinary = createImportPlan(payload, db, root, files)
    assert.equal(ordinary.status, 'blocked')
    assert.match(ordinary.errors.join(' '), /already in your library.*Force Import/)
    const forced = createImportPlan({ ...payload, force: true }, db, root, files)
    assert.notEqual(forced.status, 'blocked', forced.errors.join('; '))
    assert.equal(forced.files.filter(f => f.role === 'primary').length, 3)
    assert.ok(forced.warnings.some(w => /3 episode\(s\) already in your library will be replaced/.test(w)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a whole-series match is read as the series, even where an episode has the same id', () => {
  const { db, root, files } = careBears(false)
  try {
    // An episode of another show that happens to carry the series' id.
    db.prepare('INSERT INTO series VALUES (900, ?, 2001)').run('Another Show')
    db.prepare('INSERT INTO episodes VALUES (251, 900, 1, 1, ?, NULL)').run('missing')
    const show = createImportPlan({ mediaType: 'series-show', itemId: 251, sourcePath: root, torrentId: 't', infoHash: 'h' } as any, db, root, files)
    assert.notEqual(show.status, 'blocked', show.errors.join('; '))
    assert.equal(show.files.filter(f => f.role === 'primary').length, 3)
    // The older, ambiguous type still means what it meant: the episode, when there is one.
    const legacy = createImportPlan({ mediaType: 'series', itemId: 251, sourcePath: root, torrentId: 't', infoHash: 'h' } as any, db, root, files)
    assert.match(legacy.errors.join(' '), /No file matched S01E01/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
