import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { startTestApp, type TestHarness } from './helpers.js'
import { deflateRawSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { displayTitle, matchKey, nameCandidates, parseGamelist, pickLibretroName } from '../src/player/rom-metadata.js'
import { launchBoxBlocks, zipEntryStream } from '../src/player/launchbox.js'

/** A zip holding one deflated file — what LaunchBox publishes, in miniature. */
function zipOf(name: string, text: string): Buffer {
  const data = deflateRawSync(Buffer.from(text))
  const nameBytes = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(text.length, 24); central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)
  const directoryOffset = local.length + nameBytes.length + data.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(directoryOffset, 16)
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end])
}

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
  writeFileSync(join(dir, 'm.zip'), zipOf('Metadata.xml', LAUNCHBOX_XML))
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
  assert.equal(smw.coverUrl, '/media/roms/snes/media/box/smw.png')
  assert.equal(entries.get('missing.sfc')!.coverUrl, undefined, 'an image that is not there is not offered')
})

// ── The shelf ───────────────────────────────────────────────────────────────

let h: TestHarness
let thumbnails: http.Server

test('boot', async () => {
  // A stand-in for thumbnails.libretro.com: a directory index and the images in it.
  thumbnails = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    if (url === '/Metadata.zip') {
      res.setHeader('content-type', 'application/zip')
      res.end(zipOf('Metadata.xml', LAUNCHBOX_XML))
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
  } })
})
after(async () => { await h?.close(); thumbnails?.close() })

test('the shelf sends each ROM its gamelist entry, and scrapes the rest', async () => {
  const snes = join(h.dir, 'media', 'roms', 'snes')
  mkdirSync(join(snes, 'media', 'box'), { recursive: true })
  writeFileSync(join(snes, 'Super Mario World (USA).sfc'), 'rom')
  writeFileSync(join(snes, 'Donkey Kong Country (USA).sfc'), 'rom')
  writeFileSync(join(snes, 'media', 'box', 'smw.png'), 'png')
  writeFileSync(join(snes, 'gamelist.xml'), `<gameList><game><path>./Super Mario World (USA).sfc</path><name>Super Mario World</name><desc>Dinosaur Land.</desc><image>./media/box/smw.png</image></game></gameList>`)

  const first = await h.request('GET', '/api/v1/player/arcade/library')
  const roms = first.json.systems.find((s: any) => s.id === 'snes').roms
  const smw = roms.find((r: any) => r.file === 'Super Mario World (USA).sfc')
  assert.equal(smw.title, 'Super Mario World')
  assert.equal(smw.coverUrl, '/media/roms/snes/media/box/smw.png')
  assert.equal(smw.path, undefined, 'the path on disk stays on the server')

  // Donkey Kong Country has no gamelist entry, so the shelf looked it up.
  for (let i = 0; i < 50; i++) {
    const status = await h.request('GET', '/api/v1/roms/scrape')
    if (!status.json.running) break
    await new Promise(r => setTimeout(r, 100))
  }
  const second = await h.request('GET', '/api/v1/player/arcade/library')
  const dkc = second.json.systems.find((s: any) => s.id === 'snes').roms.find((r: any) => r.file === 'Donkey Kong Country (USA).sfc')
  assert.equal(dkc.title, 'Donkey Kong Country')
  // The description, year and logo are LaunchBox's; the box is libretro's, named for the set.
  assert.equal(dkc.overview, 'Donkey Kong & Diddy set out\nto win back their bananas.')
  assert.equal(dkc.year, 1994)
  assert.equal(dkc.developer, 'Rare')
  assert.equal(dkc.genre, 'Platform, Action')
  assert.equal(dkc.coverUrl, '/media/roms/snes/media/covers/Donkey%20Kong%20Country%20(USA).png')
  assert.equal(dkc.logoUrl, '/media/roms/snes/media/logos/Donkey%20Kong%20Country%20(USA).png')
  assert.equal(dkc.backdropUrl, '/media/roms/snes/media/backdrops/Donkey%20Kong%20Country%20(USA).jpg', 'LaunchBox fanart over a libretro screenshot')
  assert.ok(existsSync(join(snes, 'media', 'covers', 'Donkey Kong Country (USA).png')))
})

test('a scrape is started from the admin API, and says where it looks', async () => {
  const res = await h.request('POST', '/api/v1/roms/scrape', { body: { force: true } })
  assert.equal(res.status, 202)
  assert.equal(res.json.screenScraper, false)
  assert.deepEqual(res.json.sources, ['LaunchBox', 'libretro thumbnails'])
})
