import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startTestApp, type TestHarness } from './helpers.js'
import { deflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { displayTitle, matchKey, nameCandidates, parseGamelist, pickLibretroName } from '../src/player/rom-metadata.js'
import { launchBoxBlocks, zipEntryStream } from '../src/player/launchbox.js'
import { getDb } from '../src/db.js'

/** A zip holding one deflated file — what LaunchBox publishes, in miniature. */
function zipOf(...entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const data = deflateRawSync(Buffer.from(text))
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(text), 22); local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(text), 24); central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const PLATFORMS_XML = `<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Platform><Name>Super Nintendo Entertainment System</Name><ReleaseDate>1990-11-21T00:00:00+00:00</ReleaseDate>
    <Developer>Nintendo</Developer><Manufacturer>Nintendo</Manufacturer><Media>ROM cartridge</Media>
    <Notes>The Super Nintendo is a 16-bit home console.</Notes></Platform>
</LaunchBox>`

const LAUNCHBOX_XML = `<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Game><Name>Donkey Kong Country</Name><ReleaseDate>1994-11-21T00:00:00-08:00</ReleaseDate>
    <Overview>Donkey Kong &amp; Diddy set out
to win back their bananas.</Overview><DatabaseID>77</DatabaseID>
    <Platform>Super Nintendo Entertainment System</Platform><Developer>Rare</Developer><Genres>Platform; Action</Genres></Game>
  <Game><Name>Donkey Kong Country</Name><DatabaseID>78</DatabaseID><Platform>Nintendo Game Boy Advance</Platform></Game>
  <GameAlternateName><AlternateName>Super Donkey Kong</AlternateName><DatabaseID>77</DatabaseID></GameAlternateName>
  <GameImage><DatabaseID>77</DatabaseID><FileName>dkc-logo.png</FileName><Type>Clear Logo</Type></GameImage>
  <GameImage><DatabaseID>77</DatabaseID><FileName>dkc-fanart.jpg</FileName><Type>Fanart - Background</Type></GameImage>
  <GameImage><DatabaseID>77</DatabaseID><FileName>dkc-back.jpg</FileName><Type>Box - Back</Type></GameImage>
</LaunchBox>`

test('LaunchBox elements are read whole, however the stream is cut', async () => {
  const chunks = LAUNCHBOX_XML.match(/[\s\S]{1,7}/g)!
  const blocks = []
  for await (const block of launchBoxBlocks(Readable.from(chunks))) blocks.push(block.kind)
  assert.deepEqual(blocks, ['Game', 'Game', 'GameAlternateName', 'GameImage', 'GameImage', 'GameImage'])
})

test('a file comes out of a zip as it went in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'))
  writeFileSync(join(dir, 'm.zip'), zipOf(['Platforms.xml', PLATFORMS_XML], ['Metadata.xml', LAUNCHBOX_XML]))
  let text = ''
  for await (const chunk of zipEntryStream(join(dir, 'm.zip'), 'Metadata.xml')) text += chunk
  assert.equal(text, LAUNCHBOX_XML)
})

test('a ROM finds its LaunchBox game under a second title or a longer one', () => {
  const keyed = ['Enduro Racer', "David Crane's The Rescue of Princess Blobette Starring A Boy and his Blob", 'Castlevania: Symphony of the Night']
    .map(name => ({ name, key: matchKey(name) }))
  assert.deepEqual(nameCandidates('Enduro Racer ~ Super Cross (USA, Europe, Brazil)', keyed), ['Enduro Racer'])
  assert.deepEqual(nameCandidates("David Crane's The Rescue of Princess Blobette (USA)", keyed), ["David Crane's The Rescue of Princess Blobette Starring A Boy and his Blob"])
  assert.deepEqual(nameCandidates('Castelvania - Symphony of Night', keyed), ['Castlevania: Symphony of the Night'])
})

// ── Names ────────────────────────────────────────────────────────────────────

test('a set name reads as a title', () => {
  assert.equal(displayTitle('Legend of Zelda, The - A Link to the Past (USA)'), 'The Legend of Zelda - A Link to the Past')
  assert.equal(displayTitle('Battle of Olympus, The (Europe) (En,Fr,De,Es,It)'), 'The Battle of Olympus')
  assert.equal(displayTitle('Super Mario World (USA)'), 'Super Mario World')
})

test('a ROM finds its libretro box by set name, region, or a near miss', () => {
  const names = [
    'Super Mario World (Japan)', 'Super Mario World (USA)', 'Super Mario World (Europe) (Beta)',
    'Sonic _ Knuckles + Sonic The Hedgehog 3 (USA)', 'Sonic _ Knuckles (World)',
    'X-Files, The (USA) (Disc 1)', 'Castlevania - Symphony of the Night (USA)',
    'Streets of Rage (World) (Rev A)', 'Streets of Rage (USA)',
  ]
  assert.equal(pickLibretroName('Super Mario World (USA)', names), 'Super Mario World (USA)')
  assert.equal(pickLibretroName('Super Mario World (Europe)', names), 'Super Mario World (USA)', 'a beta is not the release')
  assert.equal(pickLibretroName('Sonic & Knuckles + Sonic the Hedgehog 3 (USA)', names), 'Sonic _ Knuckles + Sonic The Hedgehog 3 (USA)')
  assert.equal(pickLibretroName('X-Files', names), 'X-Files, The (USA) (Disc 1)')
  assert.equal(pickLibretroName('Castelvania - Symphony of Night', names), 'Castlevania - Symphony of the Night (USA)')
  assert.equal(pickLibretroName('Streets of Rage - Bare Knuckle - Ikari no Tekken (World) (Rev A)', names), 'Streets of Rage (World) (Rev A)')
  assert.equal(pickLibretroName('Mega Man X (USA)', names), undefined)
})

// ── gamelist.xml ─────────────────────────────────────────────────────────────

test('a gamelist entry gives a title, a year and the art beside it', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'gamelist-')), 'roms')
  const dir = join(root, 'snes')
  mkdirSync(join(dir, 'media', 'box'), { recursive: true })
  writeFileSync(join(dir, 'media', 'box', 'smw.png'), 'png')
  const entries = parseGamelist(`<?xml version="1.0"?>
    <gameList>
      <game id="1"><path>./Super Mario World (USA).sfc</path><name>Super Mario World</name>
        <desc>Mario &amp; Luigi&#39;s trip to Dinosaur Land.</desc><releasedate>19901121T000000</releasedate>
        <thumbnail>./media/box/smw.png</thumbnail><image>~/.emulationstation/x.png</image></game>
      <game><path>./roms/Missing.sfc</path><name>Missing</name><image>./media/box/none.png</image></game>
    </gameList>`, dir, root)
  const smw = entries.get('super mario world (usa).sfc')!
  assert.equal(smw.title, 'Super Mario World')
  assert.equal(smw.overview, "Mario & Luigi's trip to Dinosaur Land.")
  assert.equal(smw.year, 1990)
  assert.equal(smw.coverUrl, '/media/consoles/snes/media/box/smw.png')
  assert.equal(entries.get('missing.sfc')!.coverUrl, undefined, 'an image that is not there is not offered')
})

// ── The shelf ───────────────────────────────────────────────────────────────

let h: TestHarness
let thumbnails: http.Server
let gamesHeaders: Record<string, string>

async function scrapeSettles() {
  for (let i = 0; i < 100; i++) {
    const status = await h.request('GET', '/api/v1/roms/scrape')
    if (!status.json.running) return status.json
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('the scrape did not finish')
}

test('boot', async () => {
  // A stand-in for thumbnails.libretro.com: a directory index and the images in it.
  thumbnails = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    if (url === '/Metadata.zip') {
      res.setHeader('content-type', 'application/zip')
      res.end(zipOf(['Metadata.xml', LAUNCHBOX_XML], ['Platforms.xml', PLATFORMS_XML]))
    } else if (url.startsWith('/api/rest_v1/page/media-list/')) {
      // A stand-in for Wikipedia: a console photo, its logo, and a rating badge that is neither.
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ items: [
        { type: 'image', title: 'File:SNES-Mod1-Console-Set.jpg', srcset: [{ src: `//${req.headers.host}/wiki/snes.jpg` }] },
        { type: 'image', title: 'File:SNES logo.svg', srcset: [{ src: `//${req.headers.host}/wiki/snes-logo.png` }] },
        { type: 'image', title: 'File:ESRB_2013_Everyone.svg', srcset: [{ src: `//${req.headers.host}/wiki/esrb.png` }] },
      ] }))
    } else if (url.endsWith('/Named_Boxarts/')) {
      res.setHeader('content-type', 'text/html')
      res.end('<a href="?C=N;O=D">Name</a><a href="Donkey%20Kong%20Country%20(USA).png">x</a>')
    } else if (url.endsWith('/Named_Snaps/')) {
      res.setHeader('content-type', 'text/html')
      res.end('<a href="Donkey%20Kong%20Country%20(USA)%20(Rev%201).png">x</a>')
    } else if (url.endsWith('/Named_Logos/')) {
      res.setHeader('content-type', 'text/html')
      res.end('')
    } else if (url.endsWith('.png') || url.endsWith('.jpg')) {
      res.setHeader('content-type', url.endsWith('.jpg') ? 'image/jpeg' : 'image/png')
      res.end(Buffer.alloc(256, 1))
    } else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>(resolve => thumbnails.listen(0, '127.0.0.1', () => resolve()))
  delete process.env.SCREENSCRAPER_DEV_ID
  const base = `http://127.0.0.1:${(thumbnails.address() as AddressInfo).port}`
  h = await startTestApp({ env: {
    ARCHIVIST_LIBRETRO_THUMBNAILS_URL: base,
    ARCHIVIST_LAUNCHBOX_URL: `${base}/Metadata.zip`,
    ARCHIVIST_LAUNCHBOX_IMAGES_URL: `${base}/launchbox`,
    ARCHIVIST_ROM_SCRAPE: 'on',
    ARCHIVIST_WIKIPEDIA_URL: base,
  } })
  const tabs = await h.request('GET', '/api/v1/tabs')
  gamesHeaders = { 'x-tab-context': String(tabs.json.find((t: any) => t.media_type === 'games').id) }
})
after(async () => { await h?.close(); thumbnails?.close() })

test('the shelf sends each ROM its gamelist entry, and scrapes the rest', async () => {
  // Written in the old media/roms layout: the first scan moves it to media/consoles.
  const legacy = join(h.dir, 'media', 'roms', 'snes')
  const snes = join(h.dir, 'media', 'consoles', 'snes')
  mkdirSync(join(legacy, 'media', 'box'), { recursive: true })
  writeFileSync(join(legacy, 'Super Mario World (USA).sfc'), 'rom')
  writeFileSync(join(legacy, 'Donkey Kong Country (USA).sfc'), 'rom')
  writeFileSync(join(legacy, 'media', 'box', 'smw.png'), 'png')
  writeFileSync(join(legacy, 'gamelist.xml'), `<gameList><game><path>./Super Mario World (USA).sfc</path><name>Super Mario World</name><desc>Dinosaur Land.</desc><image>./media/box/smw.png</image></game></gameList>`)

  const first = await h.request('GET', '/api/v1/player/arcade/library')
  const roms = first.json.systems.find((s: any) => s.id === 'snes').roms
  const smw = roms.find((r: any) => r.file === 'Super Mario World (USA).sfc')
  assert.equal(smw.title, 'Super Mario World')
  assert.equal(smw.coverUrl, '/media/consoles/snes/media/box/smw.png')
  assert.equal(smw.path, undefined, 'the path on disk stays on the server')
  assert.ok(existsSync(join(snes, 'roms', 'Super Mario World (USA).sfc')), 'ROMs moved into roms/')
  assert.ok(existsSync(join(snes, 'gamelist.xml')), 'a gamelist stays beside media/, where its paths point')
  assert.equal(existsSync(join(h.dir, 'media', 'roms')), false, 'the old folder is gone once empty')

  // Donkey Kong Country has no gamelist entry, so the shelf looked it up.
  await scrapeSettles()
  const second = await h.request('GET', '/api/v1/player/arcade/library')
  const dkc = second.json.systems.find((s: any) => s.id === 'snes').roms.find((r: any) => r.file === 'Donkey Kong Country (USA).sfc')
  assert.equal(dkc.title, 'Donkey Kong Country')
  // The description, year and logo are LaunchBox's; the box is libretro's, named for the set.
  assert.equal(dkc.overview, 'Donkey Kong & Diddy set out\nto win back their bananas.')
  assert.equal(dkc.year, 1994)
  assert.equal(dkc.developer, 'Rare')
  assert.equal(dkc.genre, 'Platform, Action')
  assert.equal(dkc.coverUrl, '/media/consoles/snes/media/covers/Donkey%20Kong%20Country%20(USA).png')
  assert.equal(dkc.logoUrl, '/media/consoles/snes/media/logos/Donkey%20Kong%20Country%20(USA).png')
  assert.equal(dkc.backdropUrl, '/media/consoles/snes/media/backdrops/Donkey%20Kong%20Country%20(USA).jpg', 'LaunchBox fanart over a libretro screenshot')
  assert.ok(existsSync(join(snes, 'media', 'covers', 'Donkey Kong Country (USA).png')))
})

test('the ROMs are in the Games library, and LaunchBox is how games are found', async () => {
  const games = (await h.request('GET', '/api/v1/games', { headers: gamesHeaders })).json
  const dkc = games.find((g: any) => g.title === 'Donkey Kong Country')
  assert.ok(dkc, 'the scraped ROM is a game in the library')
  assert.equal(dkc.status, 'downloaded')
  assert.equal(dkc.source, 'rom')
  assert.equal(dkc.launchbox_id, 77)
  assert.equal(dkc.overview, 'Donkey Kong & Diddy set out\nto win back their bananas.')
  assert.deepEqual(dkc.platforms, ['Super Nintendo (SNES)'])
  assert.ok(games.find((g: any) => g.title === 'Super Mario World'), 'a ROM with a gamelist entry is added too')

  // Search offers LaunchBox's game, marked as already there, and not its Game Boy Advance namesake on a filter.
  const found = (await h.request('GET', '/api/v1/games/lookup?q=donkey%20kong&platformId=19', { headers: gamesHeaders })).json
  assert.deepEqual(found.map((g: any) => g.key), ['launchbox:77'])
  assert.equal(found[0].alreadyAdded, true)
  assert.equal(found[0].source, 'LaunchBox')
  const everywhere = (await h.request('GET', '/api/v1/games/lookup?q=super%20donkey%20kong', { headers: gamesHeaders })).json
  assert.equal(everywhere[0].key, 'launchbox:77', 'found by its other name')

  // Adding it again is the same game, not a second one.
  const again = await h.request('POST', '/api/v1/games', { body: { launchboxId: 77 }, headers: gamesHeaders })
  assert.equal(again.json.id, dkc.id)

  // The picker offers LaunchBox's artwork.
  const art = (await h.request('GET', `/api/v1/games/${dkc.id}/images?type=screenshot`, { headers: gamesHeaders })).json
  assert.ok(art.items.some((image: any) => image.source === 'LaunchBox' && image.url.endsWith('/launchbox/dkc-fanart.jpg')))
})

test('an edited ROM game keeps its edits, and a deleted ROM leaves the library', async () => {
  const games = (await h.request('GET', '/api/v1/games', { headers: gamesHeaders })).json
  const smw = games.find((g: any) => g.title === 'Super Mario World')
  await h.request('PUT', `/api/v1/games/${smw.id}/metadata`, { body: { title: 'Super Mario World (my copy)' }, headers: gamesHeaders })
  rmSync(join(h.dir, 'media', 'consoles', 'snes', 'roms', 'Donkey Kong Country (USA).sfc'))
  await h.request('POST', '/api/v1/roms/scrape', { body: {} })
  await scrapeSettles()
  const after = (await h.request('GET', '/api/v1/games', { headers: gamesHeaders })).json
  assert.equal(after.find((g: any) => g.title === 'Donkey Kong Country'), undefined)
  assert.ok(after.find((g: any) => g.id === smw.id && g.title === 'Super Mario World (my copy)'))
})

test('a ROM game has its clear logo, and the picker offers LaunchBox logos', async () => {
  const games = (await h.request('GET', '/api/v1/games', { headers: gamesHeaders })).json
  const smw = games.find((g: any) => g.platforms?.includes('Super Nintendo (SNES)'))
  assert.ok(smw)
  // Donkey Kong Country left with its ROM; its fixture logo is offered to any game named it.
  const logos = (await h.request('GET', `/api/v1/games/${smw.id}/images?type=logo`, { headers: gamesHeaders })).json
  assert.ok(Array.isArray(logos.items))
  const saved = await h.request('PUT', `/api/v1/games/${smw.id}/images`, { body: { type: 'logo', url: `${h.baseUrl.replace(/:\d+$/, '')}:${(thumbnails.address() as AddressInfo).port}/launchbox/dkc-logo.png` }, headers: gamesHeaders })
  assert.equal(saved.status, 200)
  const after = (await h.request('GET', `/api/v1/games/${smw.id}`, { headers: gamesHeaders })).json
  assert.ok(after.logo_url, 'the logo is kept')
  // Beside the ROM, named for it — not a logo.png shared by every SNES game.
  assert.match(after.logo_url, /^\/media\/consoles\/snes\/media\/library\/Super Mario World \(USA\)\.logo\.png/)
})

test('a platform has LaunchBox details until edited, and artwork of its own', async () => {
  const snes = 'Super Nintendo (SNES)'
  const path = `/api/v1/games/platforms/${encodeURIComponent(snes)}`
  const listed = (await h.request('GET', '/api/v1/games/platforms', { headers: gamesHeaders })).json
  const fromList = listed.find((p: any) => p.name === snes)
  assert.equal(fromList.launchboxPlatform, 'Super Nintendo Entertainment System')
  assert.equal(fromList.overview, 'The Super Nintendo is a 16-bit home console.')
  assert.equal(fromList.release_year, 1990)
  assert.equal(fromList.manufacturer, 'Nintendo')

  const edited = await h.request('PUT', `${path}/metadata`, { body: { overview: 'My SNES shelf.', manufacturer: 'Nintendo', release_year: 1991 }, headers: gamesHeaders })
  assert.equal(edited.json.overview, 'My SNES shelf.')
  assert.equal(edited.json.release_year, 1991)
  assert.equal(edited.json.media, 'ROM cartridge', 'an unedited field keeps what LaunchBox says')

  const logos = (await h.request('GET', `${path}/images?type=logo`, { headers: gamesHeaders })).json
  assert.deepEqual(logos.items.map((i: any) => i.source), ['Wikipedia'])
  assert.match(logos.items[0].url, /snes-logo\.png$/)
  const pictures = (await h.request('GET', `${path}/images?type=image`, { headers: gamesHeaders })).json
  assert.deepEqual(pictures.items.map((i: any) => i.url.split('/').pop()), ['snes.jpg'], 'the rating badge is not offered')
  const backgrounds = (await h.request('GET', `${path}/images?type=background`, { headers: gamesHeaders })).json
  assert.ok(backgrounds.items.some((i: any) => i.source === 'LaunchBox' && i.url.endsWith('dkc-fanart.jpg')), "the platform's games' fanart")

  const picked = await h.request('PUT', `${path}/images`, { body: { type: 'logo', url: logos.items[0].url.replace(/^https:/, 'http:') }, headers: gamesHeaders })
  assert.equal(picked.status, 200)
  const shown = (await h.request('GET', path, { headers: gamesHeaders })).json
  assert.match(shown.logo_url, /^\/media\/consoles\/snes\/system\/logo\.png/, "a console's pictures live in its system/ folder")
  const systemJson = JSON.parse(readFileSync(join(h.dir, 'media', 'consoles', 'snes', 'system', 'system.json'), 'utf8'))
  assert.equal(systemJson.overview, 'My SNES shelf.')
  assert.equal(systemJson.release_year, 1991)
  assert.equal(systemJson.media, null, "LaunchBox's details are not frozen into the file")
  assert.deepEqual(systemJson.images, { logo_url: 'logo.png' })

  // The arcade's SNES row carries the platform's logo, for the TV app.
  const shelf = (await h.request('GET', '/api/v1/player/arcade/library')).json
  const snesRow = shelf.systems.find((system: any) => system.id === 'snes')
  assert.equal(snesRow.platform.name, snes)
  assert.equal(snesRow.platform.logoUrl, shown.logo_url)

  // A console folder brought over without its database row still has its details and pictures.
  getDb().prepare('DELETE FROM game_platforms WHERE name = ?').run(snes)
  const fromFolder = (await h.request('GET', path, { headers: gamesHeaders })).json
  assert.equal(fromFolder.overview, 'My SNES shelf.')
  assert.match(fromFolder.logo_url, /^\/media\/consoles\/snes\/system\/logo\.png\?v=\d+$/)
})

test('a GameCube game is in the library, once however many discs, but not in the arcade', async () => {
  const gc = join(h.dir, 'media', 'consoles', 'gamecube', 'roms', 'Resident Evil Zero')
  mkdirSync(gc, { recursive: true })
  writeFileSync(join(gc, 'Resident Evil Zero (Disc 1).rvz'), Buffer.alloc(2048))
  writeFileSync(join(gc, 'Resident Evil Zero (Disc 2).rvz'), Buffer.alloc(2048))
  const shelf = (await h.request('GET', '/api/v1/player/arcade/library')).json
  const cube = shelf.systems.find((s: any) => s.id === 'gamecube')
  assert.equal(cube.playable, false)
  assert.equal(cube.roms.length, 2, 'both discs are found, in the game\'s own folder')
  assert.equal(shelf.systems.find((s: any) => s.id === 'snes').playable, true)
  const psp = shelf.systems.find((s: any) => s.id === 'psp')
  assert.equal(psp.playable, false, 'the browser has no PSP core')
  assert.equal(psp.tvPlayable, true, 'the TV app does')
  assert.equal(cube.tvPlayable, false)

  await h.request('POST', '/api/v1/roms/scrape', { body: {} })
  await scrapeSettles()
  const games = (await h.request('GET', '/api/v1/games', { headers: gamesHeaders })).json
  const zero = games.filter((g: any) => g.platforms?.includes('Nintendo GameCube'))
  assert.equal(zero.length, 1)
  assert.match(zero[0].file_path, /Disc 1/)
})

test('a scrape is started from the admin API, and says where it looks', async () => {
  const res = await h.request('POST', '/api/v1/roms/scrape', { body: { force: true } })
  assert.equal(res.status, 202)
  assert.equal(res.json.screenScraper, false)
  assert.deepEqual(res.json.sources, ['LaunchBox', 'libretro thumbnails'])
})
