import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startTestApp, type TestHarness } from './helpers.js'
import { getDb } from '../src/db.js'
import { migrateRomsToConsoles, resetConsolesMigrationForTest } from '../src/player/consoles-migration.js'
import { scanArcade } from '../src/player/arcade.js'
import { importSystemJson, platformArtFor, writeSystemJson } from '../src/modules/games/rom-library.js'

let h: TestHarness
after(async () => { await h?.close() })

test('media/roms moves to media/consoles, and the library keeps its rows', async () => {
  h = await startTestApp()
  const media = join(h.dir, 'media')
  const roms = join(media, 'roms')
  const put = (path: string, body = 'x') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }

  // One system under two names, games loose and in roms/, a BIOS, scraped art, a stray picture.
  put(join(roms, 'genesis', 'Sonic (USA).md'))
  put(join(roms, 'genesis', 'cover.jpg'))
  put(join(roms, 'genesis', 'media', 'covers', 'Sonic (USA).png'))
  put(join(roms, 'megadrive', 'roms', 'Streets of Rage (World).md'))
  put(join(roms, 'megadrive', 'bios', 'bios_MD.bin'))
  put(join(roms, 'dreamcast', 'Shenmue', 'disc.gdi'))
  put(join(roms, 'Not A Console', 'readme.txt'))

  const db = getDb()
  const library = db.prepare(`SELECT id FROM libraries WHERE media_type = 'games' LIMIT 1`).get() as { id: number }
  const addGame = db.prepare(`INSERT INTO games (library_id, title, sort_title, status, monitored, root_folder_path, file_path, cover_url, source)
    VALUES (?, ?, ?, 'downloaded', 0, ?, ?, ?, 'rom')`)
  const sonic = addGame.run(library.id, 'Sonic', 'sonic', join(roms, 'genesis'), join(roms, 'genesis', 'Sonic (USA).md'),
    '/media/roms/genesis/media/covers/Sonic%20(USA).png').lastInsertRowid
  const sor = addGame.run(library.id, 'Streets of Rage', 'streets of rage', join(roms, 'megadrive', 'roms'), join(roms, 'megadrive', 'roms', 'Streets of Rage (World).md'), null).lastInsertRowid
  const shenmue = addGame.run(library.id, 'Shenmue', 'shenmue', join(roms, 'dreamcast', 'Shenmue'), join(roms, 'dreamcast', 'Shenmue', 'disc.gdi'), null).lastInsertRowid
  db.prepare(`INSERT INTO rom_metadata (system, file, cover_path, source, scraped_at, scrape_version) VALUES ('genesis', 'sonic (usa).md', 'genesis/media/covers/Sonic (USA).png', 'launchbox', datetime('now'), 2)`).run()

  // A console's pictures were kept in the Games library's _platforms folder.
  const platformDir = join(media, 'games', '_platforms', 'Sega Mega Drive _ Genesis')
  put(join(platformDir, 'logo.png'))
  db.prepare(`INSERT INTO game_platforms (library_id, name, logo_url, overview) VALUES (?, 'Sega Mega Drive / Genesis', ?, 'Blast processing.')`)
    .run(library.id, '/media/games/_platforms/Sega Mega Drive _ Genesis/logo.png?v=5')

  resetConsolesMigrationForTest()
  const result = migrateRomsToConsoles()!
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.leftBehind, ['Not A Console'])

  const genesis = join(media, 'consoles', 'genesis')
  assert.ok(existsSync(join(genesis, 'roms', 'Sonic (USA).md')), 'a loose ROM goes into roms/')
  assert.ok(existsSync(join(genesis, 'roms', 'Streets of Rage (World).md')), 'megadrive merges into genesis')
  assert.ok(existsSync(join(genesis, 'bios', 'bios_MD.bin')))
  assert.ok(existsSync(join(genesis, 'media', 'covers', 'Sonic (USA).png')))
  assert.ok(existsSync(join(genesis, 'cover.jpg')), 'a loose picture stays at the top of the console folder')
  assert.ok(existsSync(join(media, 'consoles', 'dreamcast', 'roms', 'Shenmue', 'disc.gdi')), 'a game folder goes into roms/')
  assert.ok(!existsSync(join(roms, 'genesis')) && !existsSync(join(roms, 'megadrive')), 'emptied folders are removed')
  assert.ok(existsSync(join(roms, 'Not A Console', 'readme.txt')), 'a folder that is not a console is left alone')

  const game = (id: number | bigint) => db.prepare('SELECT file_path, root_folder_path, cover_url FROM games WHERE id = ?').get(id) as any
  assert.deepEqual(game(sonic), {
    file_path: join(genesis, 'roms', 'Sonic (USA).md'), root_folder_path: join(genesis, 'roms'),
    cover_url: '/media/consoles/genesis/media/covers/Sonic%20(USA).png',
  })
  assert.equal(game(sor).file_path, join(genesis, 'roms', 'Streets of Rage (World).md'))
  assert.equal(game(shenmue).root_folder_path, join(media, 'consoles', 'dreamcast', 'roms', 'Shenmue'))
  assert.equal((db.prepare(`SELECT cover_path FROM rom_metadata WHERE file = 'sonic (usa).md'`).get() as any).cover_path, 'genesis/media/covers/Sonic (USA).png')

  // The scan finds the same files the rows now point at, so no game leaves and comes back.
  const scanned = scanArcade().find(system => system.def.id === 'genesis')!
  assert.deepEqual(scanned.roms.map(rom => rom.path).sort(), [game(sonic).file_path, game(sor).file_path].sort())
  assert.equal(scanned.biosUrl, '/media/consoles/genesis/bios/bios_MD.bin')

  assert.ok(existsSync(join(genesis, 'system', 'logo.png')), "the console's picture moves to system/")
  assert.ok(!existsSync(platformDir), 'and its _platforms folder goes once empty')
  const platform = db.prepare(`SELECT logo_url FROM game_platforms WHERE name = 'Sega Mega Drive / Genesis'`).get() as any
  assert.equal(platform.logo_url, '/media/consoles/genesis/system/logo.png?v=5')
  const json = JSON.parse(readFileSync(join(genesis, 'system', 'system.json'), 'utf8'))
  assert.equal(json.name, 'Sega Mega Drive / Genesis')
  assert.equal(json.overview, 'Blast processing.')
  assert.deepEqual(json.images, { logo_url: 'logo.png' })

  // Once done, a second run finds nothing to do.
  resetConsolesMigrationForTest()
  const again = migrateRomsToConsoles()!
  assert.equal(again.moved + again.rowsRewritten + again.platformsMoved, 0)
})

test('a hand edit of system.json shows in the app', () => {
  const db = getDb()
  const library = db.prepare(`SELECT id FROM libraries WHERE media_type = 'games' LIMIT 1`).get() as { id: number }
  const name = 'Sega Mega Drive / Genesis'
  const system = join(h.dir, 'media', 'consoles', 'genesis', 'system')
  const path = join(system, 'system.json')
  const row = () => db.prepare('SELECT * FROM game_platforms WHERE library_id = ? AND name = ?').get(library.id, name) as any
  // Saved later than the row, as a hand edit is.
  let clock = Date.now() / 1000 + 10
  const edit = (json: object) => { writeFileSync(path, JSON.stringify(json)); utimesSync(path, clock, clock); clock += 10 }

  writeFileSync(join(system, 'sega.svg'), '<svg/>')
  edit({ name, overview: 'Genesis does what Nintendon\'t.', release_year: 1988, images: { logo_url: 'sega.svg', image_url: 'console.jpg' } })
  importSystemJson(library.id, 'genesis')
  assert.equal(row().overview, 'Genesis does what Nintendon\'t.')
  assert.equal(row().release_year, 1988)
  assert.match(row().logo_url, /^\/media\/consoles\/genesis\/system\/sega\.svg\?v=\d+$/, 'an image renamed in the file is the one shown')
  assert.equal(row().image_url, null, 'a file that is not there is ignored')
  assert.match(platformArtFor('genesis')!.logoUrl!, /sega\.svg/, "the arcade's row follows")

  // The app writes back the name it was given, not its own.
  writeSystemJson('genesis', row())
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).images.logo_url, 'sega.svg')

  // A field left out stays; null clears it; a picture dropped from images is cleared.
  edit({ name, release_year: null, images: {} })
  importSystemJson(library.id, 'genesis')
  assert.equal(row().overview, 'Genesis does what Nintendon\'t.')
  assert.equal(row().release_year, null)
  assert.equal(row().logo_url, null)

  // A change made in the app after the file was written wins over it.
  edit({ name, overview: 'Stale.' })
  db.prepare(`UPDATE game_platforms SET overview = 'From the app.', updated_at = datetime(?, 'unixepoch') WHERE library_id = ? AND name = ?`).run(Math.ceil(clock), library.id, name)
  importSystemJson(library.id, 'genesis')
  assert.equal(row().overview, 'From the app.')
})
