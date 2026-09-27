import { createReadStream, createWriteStream, mkdtempSync, openSync, readSync, closeSync, fstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import type { Database } from 'better-sqlite3'
import { createLogger } from '@archivist/core'

const logger = createLogger('LaunchBox')

/**
 * The LaunchBox Games Database, for ROM descriptions and clear logos.
 *
 * LaunchBox publishes the whole database as one zip that anyone may download,
 * no account needed: every game's overview, release date, developer and
 * publisher, and the file names of its box art, clear logo and fanart on
 * images.launchbox-app.com. It is about 100 MB, so it is fetched at most once
 * a month and only the systems the arcade plays are kept, in `launchbox_*`.
 */

const metadataUrl = () => process.env.ARCHIVIST_LAUNCHBOX_URL ?? 'https://gamesdb.launchbox-app.com/Metadata.zip'
export const launchBoxImageUrl = (fileName: string) => `${process.env.ARCHIVIST_LAUNCHBOX_IMAGES_URL ?? 'https://images.launchbox-app.com'}/${encodeURIComponent(fileName)}`
const REFRESH_MS = 30 * 86_400_000

/** LaunchBox's platform name for each arcade system; Game Boy Color files have their own. */
export function launchBoxPlatform(systemId: string, file: string): string | undefined {
  switch (systemId) {
    case 'nes': return 'Nintendo Entertainment System'
    case 'snes': return 'Super Nintendo Entertainment System'
    case 'gameboy': return file.toLowerCase().endsWith('.gbc') ? 'Nintendo Game Boy Color' : 'Nintendo Game Boy'
    case 'mastersystem': return 'Sega Master System'
    case 'genesis': return 'Sega Genesis'
    case 'n64': return 'Nintendo 64'
    case 'psx': return 'Sony Playstation'
    case 'saturn': return 'Sega Saturn'
    default: return undefined
  }
}

const PLATFORMS = new Set(['nes', 'snes', 'gameboy', 'mastersystem', 'genesis', 'n64', 'psx', 'saturn']
  .flatMap(id => [launchBoxPlatform(id, 'x'), launchBoxPlatform(id, 'x.gbc')]).filter(Boolean) as string[])
/** The image kinds a ROM tile uses; the database lists two dozen. */
const IMAGE_TYPES = new Set(['Box - Front', 'Clear Logo', 'Fanart - Background', 'Screenshot - Gameplay', 'Screenshot - Game Title'])

// ── The zip ─────────────────────────────────────────────────────────────────

/**
 * A stream of one file in a zip. Node reads deflate but not zip, and the one
 * file wanted is 500 MB unpacked, so it is found through the zip's central
 * directory and inflated as it is read rather than unpacked to disk.
 */
export function zipEntryStream(zipPath: string, entryName: string): Readable {
  const fd = openSync(zipPath, 'r')
  try {
    const size = fstatSync(fd).size
    const tailLength = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLength)
    readSync(fd, tail, 0, tailLength, size - tailLength)
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0) throw new Error('not a zip file')
    const entries = tail.readUInt16LE(end + 10)
    const directorySize = tail.readUInt32LE(end + 12)
    const directoryOffset = tail.readUInt32LE(end + 16)
    const directory = Buffer.alloc(directorySize)
    readSync(fd, directory, 0, directorySize, directoryOffset)
    let at = 0
    for (let i = 0; i < entries; i++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip directory')
      const method = directory.readUInt16LE(at + 10)
      const compressedSize = directory.readUInt32LE(at + 20)
      const nameLength = directory.readUInt16LE(at + 28)
      const extraLength = directory.readUInt16LE(at + 30)
      const commentLength = directory.readUInt16LE(at + 32)
      const localOffset = directory.readUInt32LE(at + 42)
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength)
      at += 46 + nameLength + extraLength + commentLength
      if (name !== entryName) continue
      const local = Buffer.alloc(30)
      readSync(fd, local, 0, 30, localOffset)
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      const raw = createReadStream(zipPath, { start: dataStart, end: dataStart + compressedSize - 1 })
      if (method === 0) return raw
      if (method !== 8) throw new Error(`${entryName} is packed with method ${method}, which cannot be read`)
      return raw.pipe(createInflateRaw())
    }
    throw new Error(`${entryName} is not in the zip`)
  } finally {
    closeSync(fd)
  }
}

// ── The XML ─────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
  if (entity[0] === '#') {
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole
  }
  return ENTITIES[entity.toLowerCase()] ?? whole
}).replace(/\r\n?/g, '\n').trim()

const field = (block: string, name: string): string | undefined => {
  const start = block.indexOf(`<${name}>`)
  if (start < 0) return undefined
  const end = block.indexOf(`</${name}>`, start)
  const value = end < 0 ? '' : decode(block.slice(start + name.length + 2, end))
  return value || undefined
}

const BLOCKS = ['Game', 'GameAlternateName', 'GameImage'] as const
type BlockName = typeof BLOCKS[number]

/**
 * Each `<Game>`, `<GameAlternateName>` and `<GameImage>` element of the
 * database, in order, from a stream of its text. The file is flat — one level
 * of elements under the root — so an element runs from its opening tag to its
 * closing one and no XML parser is needed.
 */
export async function* launchBoxBlocks(source: AsyncIterable<Buffer | string>): AsyncGenerator<{ kind: BlockName; body: string }> {
  let buffer = ''
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let at = 0
    while (true) {
      let next = -1
      let kind: BlockName | null = null
      for (const name of BLOCKS) {
        const found = buffer.indexOf(`<${name}>`, at)
        if (found >= 0 && (next < 0 || found < next)) { next = found; kind = name }
      }
      if (next < 0 || !kind) { at = Math.max(at, buffer.length - 32); break }
      const close = buffer.indexOf(`</${kind}>`, next)
      if (close < 0) { at = next; break }
      yield { kind, body: buffer.slice(next + kind.length + 2, close) }
      at = close + kind.length + 3
    }
    buffer = buffer.slice(at)
  }
}

// ── Import ──────────────────────────────────────────────────────────────────

/** Replace what is kept of the database with what a stream of Metadata.xml holds. */
export async function importLaunchBox(db: Database, source: AsyncIterable<Buffer | string>, matchKey: (name: string) => string): Promise<number> {
  const kept = new Map<number, string>()
  const games: any[] = []
  const names: Array<[string, string, number]> = []
  const images: Array<[number, string, string | null, string]> = []
  for await (const { kind, body } of launchBoxBlocks(source)) {
    if (kind === 'Game') {
      const platform = field(body, 'Platform')
      const id = Number(field(body, 'DatabaseID'))
      const name = field(body, 'Name')
      if (!platform || !PLATFORMS.has(platform) || !Number.isFinite(id) || !name) continue
      kept.set(id, platform)
      const date = field(body, 'ReleaseDate')
      const year = Number(date?.slice(0, 4) ?? field(body, 'ReleaseYear'))
      games.push({
        database_id: id, platform, name,
        overview: field(body, 'Overview') ?? null,
        year: year > 1950 && year < 2100 ? year : null,
        developer: field(body, 'Developer') ?? null,
        publisher: field(body, 'Publisher') ?? null,
        genres: field(body, 'Genres')?.replace(/;\s*/g, ', ') ?? null,
        players: field(body, 'MaxPlayers') ?? null,
      })
      names.push([platform, matchKey(name), id])
    } else if (kind === 'GameAlternateName') {
      const id = Number(field(body, 'DatabaseID'))
      const platform = kept.get(id)
      const name = field(body, 'AlternateName')
      if (platform && name) names.push([platform, matchKey(name), id])
    } else {
      const id = Number(field(body, 'DatabaseID'))
      const type = field(body, 'Type')
      const file = field(body, 'FileName')
      if (kept.has(id) && type && IMAGE_TYPES.has(type) && file) images.push([id, type, field(body, 'Region') ?? null, file])
    }
  }
  if (!games.length) throw new Error('the LaunchBox database held none of the arcade’s systems')

  db.transaction(() => {
    db.exec('DELETE FROM launchbox_games; DELETE FROM launchbox_names; DELETE FROM launchbox_images;')
    const game = db.prepare(`INSERT OR REPLACE INTO launchbox_games (database_id, platform, name, overview, year, developer, publisher, genres, players)
      VALUES (@database_id, @platform, @name, @overview, @year, @developer, @publisher, @genres, @players)`)
    for (const row of games) game.run(row)
    const name = db.prepare('INSERT INTO launchbox_names (platform, key, database_id) VALUES (?, ?, ?)')
    for (const row of names) if (row[1]) name.run(...row)
    const image = db.prepare('INSERT INTO launchbox_images (database_id, type, region, file_name) VALUES (?, ?, ?, ?)')
    for (const row of images) image.run(...row)
    db.prepare(`INSERT INTO launchbox_state (key, value) VALUES ('imported_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString())
  })()
  logger.info(`Kept ${games.length} games, ${names.length} names and ${images.length} images from the LaunchBox database`)
  return games.length
}

let importing: Promise<boolean> | null = null

/**
 * Make sure a copy of the database no older than a month is kept, fetching one
 * when not. Resolves whether a copy is there to use; a failed fetch leaves the
 * old copy in place.
 */
export function ensureLaunchBox(db: Database, matchKey: (name: string) => string): Promise<boolean> {
  if (process.env.ARCHIVIST_LAUNCHBOX === 'off') return Promise.resolve(false)
  const state = db.prepare(`SELECT value FROM launchbox_state WHERE key = 'imported_at'`).get() as { value: string } | undefined
  const have = !!state && !!db.prepare('SELECT 1 FROM launchbox_games LIMIT 1').get()
  if (have && Date.now() - Date.parse(state!.value) < REFRESH_MS) return Promise.resolve(true)
  importing ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchbox-'))
    try {
      const zip = join(dir, 'Metadata.zip')
      logger.info('Downloading the LaunchBox games database')
      const res = await fetch(metadataUrl(), { signal: AbortSignal.timeout(15 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`LaunchBox answered ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zip))
      await importLaunchBox(db, zipEntryStream(zip, 'Metadata.xml'), matchKey)
      return true
    } catch (err) {
      logger.warn(`Could not refresh the LaunchBox database: ${err instanceof Error ? err.message : String(err)}`)
      return have
    } finally {
      rmSync(dir, { recursive: true, force: true })
      importing = null
    }
  })()
  return importing
}

export interface LaunchBoxGame {
  databaseId: number; name: string; overview?: string; year?: number
  developer?: string; publisher?: string; genre?: string; players?: string
  cover?: string; logo?: string; backdrop?: string
}

/**
 * The best image of a kind for a ROM: its own region's first, then the
 * American, worldwide and unmarked ones a set most often shows.
 */
function pickImage(images: Array<{ type: string; region: string | null; file_name: string }>, type: string, regions: Set<string>): string | undefined {
  const ofType = images.filter(image => image.type === type)
  if (!ofType.length) return undefined
  const order = [
    ...(regions.has('europe') ? ['Europe', 'United Kingdom'] : []),
    ...(regions.has('japan') ? ['Japan'] : []),
    'North America', 'United States', 'World', '', 'Europe', 'United Kingdom', 'Australia', 'Japan',
  ]
  const rank = (region: string | null) => { const at = order.indexOf(region ?? ''); return at < 0 ? order.length : at }
  return ofType.sort((a, b) => rank(a.region) - rank(b.region))[0].file_name
}

/** The LaunchBox game a ROM is, by one of the names it goes by, with its images. */
export function launchBoxGame(db: Database, platform: string, databaseId: number, romRegions: Set<string>): LaunchBoxGame | null {
  const game = db.prepare('SELECT * FROM launchbox_games WHERE database_id = ?').get(databaseId) as any
  if (!game || game.platform !== platform) return null
  const images = db.prepare('SELECT type, region, file_name FROM launchbox_images WHERE database_id = ?').all(databaseId) as any[]
  const cover = pickImage(images, 'Box - Front', romRegions)
  const logo = pickImage(images, 'Clear Logo', romRegions)
  const backdrop = pickImage(images, 'Fanart - Background', romRegions) ?? pickImage(images, 'Screenshot - Gameplay', romRegions)
  return {
    databaseId, name: game.name, overview: game.overview ?? undefined, year: game.year ?? undefined,
    developer: game.developer ?? undefined, publisher: game.publisher ?? undefined, genre: game.genres ?? undefined,
    players: game.players ?? undefined,
    cover: cover && launchBoxImageUrl(cover), logo: logo && launchBoxImageUrl(logo), backdrop: backdrop && launchBoxImageUrl(backdrop),
  }
}

/** Every name kept for a platform, keyed as [matchKey] keys them, with the game each names. */
export function launchBoxNames(db: Database, platform: string): Array<{ key: string; databaseId: number; hasOverview: boolean }> {
  return (db.prepare(`
    SELECT n.key, n.database_id, g.overview IS NOT NULL AS has_overview
    FROM launchbox_names n JOIN launchbox_games g ON g.database_id = n.database_id
    WHERE n.platform = ?
  `).all(platform) as any[]).map(row => ({ key: row.key, databaseId: row.database_id, hasOverview: !!row.has_overview }))
}
