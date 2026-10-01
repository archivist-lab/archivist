import { createReadStream, createWriteStream, existsSync, mkdtempSync, openSync, readSync, closeSync, fstatSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import Database from 'better-sqlite3'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { matchKey } from './game-names.js'

const logger = createLogger('LaunchBox')

/**
 * The LaunchBox Games Database, for ROM descriptions and clear logos.
 *
 * LaunchBox publishes the whole database as one zip that anyone may download,
 * no account needed: every game's overview, release date, developer and
 * publisher, and the file names of its box art, clear logo and fanart on
 * images.launchbox-app.com. It is about 100 MB, so it is fetched at most once
 * a month and kept in a database of its own (see [launchBoxPath]).
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
    case 'dreamcast': return 'Sega Dreamcast'
    case 'gamecube': return 'Nintendo GameCube'
    case 'ps2': return 'Sony Playstation 2'
    case 'psp': return 'Sony PSP'
    default: return undefined
  }
}

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
type BlockName = string

/**
 * Each `<Game>`, `<GameAlternateName>` and `<GameImage>` element of the
 * database, in order, from a stream of its text. The file is flat — one level
 * of elements under the root — so an element runs from its opening tag to its
 * closing one and no XML parser is needed.
 */
export async function* launchBoxBlocks(source: AsyncIterable<Buffer | string>, blocks: readonly string[] = BLOCKS): AsyncGenerator<{ kind: BlockName; body: string }> {
  let buffer = ''
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let at = 0
    while (true) {
      let next = -1
      let kind: BlockName | null = null
      for (const name of blocks) {
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

// ── The kept copy ───────────────────────────────────────────────────────────

/**
 * Where the kept copy lives: a database of its own beside the main one. All
 * of it is kept — every platform, for the Games library as well as the ROMs —
 * which is a couple of hundred megabytes the main database's backups need not
 * carry, and a fresh copy can be built alongside and swapped in whole.
 */
export function launchBoxPath(): string {
  if (process.env.ARCHIVIST_LAUNCHBOX_DB) return process.env.ARCHIVIST_LAUNCHBOX_DB
  const main = (getDb() as unknown as { name?: string }).name
  return join(main && main !== ':memory:' ? dirname(main) : tmpdir(), 'launchbox.sqlite')
}

let handle: { path: string; db: Database.Database } | null = null

/** The kept copy, open for reading; null until one has been fetched. */
export function launchBoxDb(): Database.Database | null {
  const path = launchBoxPath()
  if (handle?.path === path) return handle.db
  if (!existsSync(path)) return null
  try {
    handle = { path, db: new Database(path, { readonly: true, fileMustExist: true }) }
    return handle.db
  } catch (err) {
    logger.warn(`Could not open ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function closeLaunchBox() {
  try { handle?.db.close() } catch { /* already closed */ }
  handle = null
}

const SCHEMA = `
  CREATE TABLE games (
    database_id INTEGER PRIMARY KEY,
    platform    TEXT NOT NULL,
    name        TEXT NOT NULL,
    overview    TEXT,
    year        INTEGER,
    release_date TEXT,
    developer   TEXT,
    publisher   TEXT,
    genres      TEXT,
    players     TEXT,
    rating      REAL
  );
  CREATE TABLE names (platform TEXT NOT NULL, key TEXT NOT NULL, database_id INTEGER NOT NULL);
  CREATE TABLE images (database_id INTEGER NOT NULL, type TEXT NOT NULL, region TEXT, file_name TEXT NOT NULL);
  CREATE TABLE platforms (
    name TEXT PRIMARY KEY, overview TEXT, developer TEXT, manufacturer TEXT, release_year INTEGER,
    media TEXT, cpu TEXT, category TEXT
  );
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** Raised when the kept copy's tables change, so an older copy is fetched again. 2 added platforms. */
const COPY_VERSION = '2'

/**
 * Build a copy at `target` from a stream of Metadata.xml. It is written beside
 * the target and moved over it once complete, so a failed import leaves the old
 * copy as it was. Rows are written as they are read: the file is 500 MB.
 */
export async function importLaunchBox(
  target: string,
  source: AsyncIterable<Buffer | string>,
  keyOf: (name: string) => string = matchKey,
  /** Platforms.xml, for each platform's description, maker and year. */
  platformsSource?: AsyncIterable<Buffer | string>,
): Promise<number> {
  const building = `${target}.building`
  rmSync(building, { force: true })
  const db = new Database(building)
  let games = 0
  try {
    db.pragma('journal_mode = OFF')
    db.pragma('synchronous = OFF')
    db.exec(SCHEMA)
    const game = db.prepare(`INSERT OR REPLACE INTO games (database_id, platform, name, overview, year, release_date, developer, publisher, genres, players, rating)
      VALUES (@database_id, @platform, @name, @overview, @year, @release_date, @developer, @publisher, @genres, @players, @rating)`)
    const name = db.prepare('INSERT INTO names (platform, key, database_id) VALUES (?, ?, ?)')
    const image = db.prepare('INSERT INTO images (database_id, type, region, file_name) VALUES (?, ?, ?, ?)')
    const platformOf = new Map<number, string>()
    let pending = 0
    db.exec('BEGIN')
    for await (const { kind, body } of launchBoxBlocks(source)) {
      if (kind === 'Game') {
        const platform = field(body, 'Platform')
        const id = Number(field(body, 'DatabaseID'))
        const title = field(body, 'Name')
        if (!platform || !Number.isFinite(id) || !title) continue
        platformOf.set(id, platform)
        const date = field(body, 'ReleaseDate')?.slice(0, 10)
        const year = Number(date?.slice(0, 4) ?? field(body, 'ReleaseYear'))
        const rating = Number(field(body, 'CommunityRating'))
        game.run({
          database_id: id, platform, name: title,
          overview: field(body, 'Overview') ?? null,
          year: year > 1950 && year < 2100 ? year : null,
          release_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
          developer: field(body, 'Developer') ?? null,
          publisher: field(body, 'Publisher') ?? null,
          genres: field(body, 'Genres')?.replace(/;\s*/g, ', ') ?? null,
          players: field(body, 'MaxPlayers') ?? null,
          // A community score out of five, onto the library's ten.
          rating: rating > 0 ? Math.round(rating * 20) / 10 : null,
        })
        const key = keyOf(title)
        if (key) name.run(platform, key, id)
        games++
      } else if (kind === 'GameAlternateName') {
        const id = Number(field(body, 'DatabaseID'))
        const platform = platformOf.get(id)
        const alternate = field(body, 'AlternateName')
        const key = alternate && keyOf(alternate)
        if (platform && key) name.run(platform, key, id)
      } else {
        const id = Number(field(body, 'DatabaseID'))
        const type = field(body, 'Type')
        const file = field(body, 'FileName')
        if (platformOf.has(id) && type && IMAGE_TYPES.has(type) && file) image.run(id, type, field(body, 'Region') ?? null, file)
      }
      if (++pending >= 5000) { db.exec('COMMIT; BEGIN'); pending = 0 }
    }
    db.exec('COMMIT')
    if (!games) throw new Error('the LaunchBox database held no games')
    if (platformsSource) {
      const platform = db.prepare(`INSERT OR REPLACE INTO platforms (name, overview, developer, manufacturer, release_year, media, cpu, category)
        VALUES (@name, @overview, @developer, @manufacturer, @release_year, @media, @cpu, @category)`)
      db.exec('BEGIN')
      for await (const { body } of launchBoxBlocks(platformsSource, ['Platform'])) {
        const name = field(body, 'Name')
        if (!name) continue
        const year = Number(field(body, 'ReleaseDate')?.slice(0, 4))
        platform.run({
          name, overview: field(body, 'Notes') ?? null, developer: field(body, 'Developer') ?? null,
          manufacturer: field(body, 'Manufacturer') ?? null, release_year: year > 1950 && year < 2100 ? year : null,
          media: field(body, 'Media') ?? null, cpu: field(body, 'Cpu') ?? null, category: field(body, 'Category') ?? null,
        })
      }
      db.exec('COMMIT')
    }
    db.exec(`
      CREATE INDEX names_by_key ON names (platform, key);
      CREATE INDEX names_by_game ON names (database_id);
      CREATE INDEX images_by_game ON images (database_id);
      CREATE INDEX games_by_platform ON games (platform);
    `)
    db.prepare(`INSERT INTO state (key, value) VALUES ('imported_at', ?), ('version', ?)`).run(new Date().toISOString(), COPY_VERSION)
    db.close()
    closeLaunchBox()
    renameSync(building, target)
    logger.info(`Kept ${games} games from the LaunchBox database`)
    return games
  } catch (err) {
    try { db.close() } catch { /* closed */ }
    rmSync(building, { force: true })
    throw err
  }
}

let importing: Promise<boolean> | null = null

/**
 * Make sure a copy no older than a month is kept, fetching one when not.
 * Resolves whether a copy is there to use; a failed fetch leaves the old
 * copy in place.
 */
export function ensureLaunchBox(): Promise<boolean> {
  if (process.env.ARCHIVIST_LAUNCHBOX === 'off') return Promise.resolve(false)
  const current = launchBoxDb()
  const state = (key: string) => {
    try { return (current?.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined)?.value } catch { return undefined }
  }
  const importedAt = state('imported_at')
  if (current && importedAt && state('version') === COPY_VERSION && Date.now() - Date.parse(importedAt) < REFRESH_MS) return Promise.resolve(true)
  importing ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchbox-'))
    try {
      const zip = join(dir, 'Metadata.zip')
      logger.info('Downloading the LaunchBox games database')
      const res = await fetch(metadataUrl(), { signal: AbortSignal.timeout(15 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`LaunchBox answered ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(zip))
      let platforms: Readable | undefined
      try { platforms = zipEntryStream(zip, 'Platforms.xml') } catch { /* the games alone will do */ }
      await importLaunchBox(launchBoxPath(), zipEntryStream(zip, 'Metadata.xml'), matchKey, platforms)
      return true
    } catch (err) {
      logger.warn(`Could not refresh the LaunchBox database: ${err instanceof Error ? err.message : String(err)}`)
      return !!current
    } finally {
      rmSync(dir, { recursive: true, force: true })
      importing = null
    }
  })()
  return importing
}

// ── Reading it ──────────────────────────────────────────────────────────────

export interface LaunchBoxGame {
  databaseId: number; platform: string; name: string; overview?: string; year?: number; releaseDate?: string
  developer?: string; publisher?: string; genre?: string; players?: string; rating?: number
  cover?: string; logo?: string; backdrop?: string
}

type ImageRow = { type: string; region: string | null; file_name: string }

/**
 * The best image of a kind for a game: a ROM's own region's first, then the
 * American, worldwide and unmarked ones a set most often shows.
 */
function pickImage(images: ImageRow[], type: string, regions: Set<string>): string | undefined {
  const ofType = images.filter(image => image.type === type)
  if (!ofType.length) return undefined
  const order = [
    ...(regions.has('europe') ? ['Europe', 'United Kingdom'] : []),
    ...(regions.has('japan') ? ['Japan'] : []),
    'North America', 'United States', 'World', '', 'Europe', 'United Kingdom', 'Australia', 'Japan',
  ]
  const rank = (region: string | null) => { const at = order.indexOf(region ?? ''); return at < 0 ? order.length : at }
  return [...ofType].sort((a, b) => rank(a.region) - rank(b.region))[0].file_name
}

function gameOf(row: any, images: ImageRow[], regions: Set<string>): LaunchBoxGame {
  const cover = pickImage(images, 'Box - Front', regions)
  const logo = pickImage(images, 'Clear Logo', regions)
  const backdrop = pickImage(images, 'Fanart - Background', regions) ?? pickImage(images, 'Screenshot - Gameplay', regions)
  return {
    databaseId: row.database_id, platform: row.platform, name: row.name,
    overview: row.overview ?? undefined, year: row.year ?? undefined, releaseDate: row.release_date ?? undefined,
    developer: row.developer ?? undefined, publisher: row.publisher ?? undefined, genre: row.genres ?? undefined,
    players: row.players ?? undefined, rating: row.rating ?? undefined,
    cover: cover && launchBoxImageUrl(cover), logo: logo && launchBoxImageUrl(logo), backdrop: backdrop && launchBoxImageUrl(backdrop),
  }
}

/** One game, with its images; `platform`, when given, must be the game's. */
export function launchBoxGame(databaseId: number, options: { platform?: string; regions?: Set<string> } = {}): LaunchBoxGame | null {
  const db = launchBoxDb()
  if (!db) return null
  const row = db.prepare('SELECT * FROM games WHERE database_id = ?').get(databaseId) as any
  if (!row || (options.platform && row.platform !== options.platform)) return null
  const images = db.prepare('SELECT type, region, file_name FROM images WHERE database_id = ?').all(databaseId) as ImageRow[]
  return gameOf(row, images, options.regions ?? new Set())
}

/** Every image of a game of one kind, best region first, as URLs. */
export function launchBoxImages(databaseId: number, types: string[]): Array<{ url: string; type: string; region: string | null }> {
  const db = launchBoxDb()
  if (!db) return []
  const rows = db.prepare('SELECT type, region, file_name FROM images WHERE database_id = ?').all(databaseId) as ImageRow[]
  return rows.filter(row => types.includes(row.type)).map(row => ({ url: launchBoxImageUrl(row.file_name), type: row.type, region: row.region }))
}

/** Every name kept for a platform, keyed as [matchKey] keys them, with the game each names. */
export function launchBoxNames(platform: string): Array<{ key: string; databaseId: number; hasOverview: boolean }> {
  const db = launchBoxDb()
  if (!db) return []
  return (db.prepare(`
    SELECT n.key, n.database_id, g.overview IS NOT NULL AS has_overview
    FROM names n JOIN games g ON g.database_id = n.database_id
    WHERE n.platform = ?
  `).all(platform) as any[]).map(row => ({ key: row.key, databaseId: row.database_id, hasOverview: !!row.has_overview }))
}

/**
 * Games whose name or other name holds every word of `query`, on `platform`
 * when one is given: the exact name first, then those it begins, then the
 * rest; a described game before a bare one.
 */
export function searchLaunchBox(query: string, options: { platform?: string; limit?: number } = {}): LaunchBoxGame[] {
  const db = launchBoxDb()
  const key = matchKey(query)
  if (!db || !key) return []
  const words = key.split(' ')
  const where = words.map(() => `n.key LIKE ? ESCAPE '\\'`).join(' AND ')
  const params: unknown[] = words.map(word => `%${word.replace(/[%_\\]/g, '\\$&')}%`)
  if (options.platform) params.push(options.platform)
  const rows = db.prepare(`
    SELECT g.*, n.key AS matched FROM names n JOIN games g ON g.database_id = n.database_id
    WHERE ${where}${options.platform ? ' AND n.platform = ?' : ''}
    LIMIT 2000
  `).all(...params) as any[]
  const rank = (row: any) => (row.matched === key ? 0 : row.matched.startsWith(key) ? 1 : 2) * 2 + (row.overview ? 0 : 1)
  const best = new Map<number, any>()
  for (const row of rows) {
    const had = best.get(row.database_id)
    if (!had || rank(row) < rank(had)) best.set(row.database_id, row)
  }
  const chosen = [...best.values()]
    .sort((a, b) => rank(a) - rank(b) || (a.year ?? 9999) - (b.year ?? 9999) || a.name.localeCompare(b.name))
    .slice(0, options.limit ?? 40)
  const images = db.prepare('SELECT type, region, file_name FROM images WHERE database_id = ?')
  return chosen.map(row => gameOf(row, images.all(row.database_id) as ImageRow[], new Set()))
}

export interface LaunchBoxPlatform {
  name: string; overview?: string; developer?: string; manufacturer?: string; releaseYear?: number; media?: string; cpu?: string
}

/** What LaunchBox says of a platform, by its LaunchBox name. */
export function launchBoxPlatformDetails(name: string): LaunchBoxPlatform | null {
  const db = launchBoxDb()
  if (!db) return null
  let row: any
  try { row = db.prepare('SELECT * FROM platforms WHERE name = ?').get(name) } catch { return null }
  if (!row) return null
  return {
    name: row.name, overview: row.overview ?? undefined, developer: row.developer ?? undefined, manufacturer: row.manufacturer ?? undefined,
    releaseYear: row.release_year ?? undefined, media: row.media ?? undefined, cpu: row.cpu ?? undefined,
  }
}

/** Fanart from a platform's games, the best-known first, for a platform's background. */
export function launchBoxPlatformFanart(platform: string, limit = 60): string[] {
  const db = launchBoxDb()
  if (!db) return []
  return (db.prepare(`
    SELECT i.file_name FROM images i JOIN games g ON g.database_id = i.database_id
    WHERE g.platform = ? AND i.type = 'Fanart - Background'
    ORDER BY COALESCE(g.rating, 0) DESC LIMIT ?
  `).all(platform, limit) as Array<{ file_name: string }>).map(row => launchBoxImageUrl(row.file_name))
}

/** The LaunchBox platform for each of the IGDB platform ids the Games library's picker offers. */
export const LAUNCHBOX_PLATFORM_FOR_IGDB: Record<number, string> = {
  6: 'Windows', 167: 'Sony Playstation 5', 48: 'Sony Playstation 4', 9: 'Sony Playstation 3', 8: 'Sony Playstation 2',
  7: 'Sony Playstation', 46: 'Sony Playstation Vita', 38: 'Sony PSP', 169: 'Microsoft Xbox Series X/S', 49: 'Microsoft Xbox One',
  12: 'Microsoft Xbox 360', 130: 'Nintendo Switch', 37: 'Nintendo 3DS', 41: 'Nintendo Wii U', 5: 'Nintendo Wii',
  4: 'Nintendo 64', 19: 'Super Nintendo Entertainment System', 18: 'Nintendo Entertainment System', 29: 'Sega Dreamcast',
  32: 'Sega Saturn', 21: 'Nintendo GameCube', 23: 'Sega Genesis', 33: 'Sega Master System', 35: 'Sega Game Gear',
}
