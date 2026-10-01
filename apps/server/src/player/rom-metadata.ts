import { Router } from 'express'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { consolesRoot, consolesUrl, scanArcade, type ScannedRom, type ScannedSystem } from './arcade.js'
import { displayTitle, matchKey, nameCandidates, regionsOf } from './game-names.js'
import { ensureLaunchBox, launchBoxGame, launchBoxNames, launchBoxPlatform, type LaunchBoxGame } from './launchbox.js'

const logger = createLogger('RomMetadata')

/**
 * Titles, descriptions and artwork for the ROMs in media/consoles.
 *
 * A ROM is a file, not a library entry, so none of the library's metadata
 * reaches it. Three sources fill that in, best first:
 *
 * 1. A `gamelist.xml` in the system's folder — what EmulationStation, Batocera,
 *    RetroPie and Skraper write. It is the user's own curation, so it wins
 *    field by field and is read live, never copied.
 * 2. ScreenScraper, when developer credentials are configured. It identifies
 *    the file by its checksum, which is why it is the right source for ROMs:
 *    a search by title (IGDB) cannot tell a Mega Drive release from its Master
 *    System namesake and finds little from before 1995 at all.
 * 3. The libretro thumbnail archive, which needs no account. It is named after
 *    the No-Intro and Redump sets, so a ROM that keeps its set name finds its
 *    box art by that name. It has no descriptions.
 *
 * What (2) and (3) find is kept in `rom_metadata`, with the images saved beside
 * the ROMs in `<system>/media/covers` and `<system>/media/backdrops`.
 */

export interface RomMeta {
  title?: string
  overview?: string
  year?: number
  developer?: string
  publisher?: string
  genre?: string
  players?: string
  coverUrl?: string
  backdropUrl?: string
  /** A clear logo: the title as a transparent image, for over the backdrop. */
  logoUrl?: string
  source?: 'gamelist' | 'screenscraper' | 'launchbox' | 'libretro'
}

export { displayTitle, matchKey, nameCandidates } from './game-names.js'

// ── gamelist.xml ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (text: string) => text
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[entity.toLowerCase()] ?? whole
  })
  .trim()

const tag = (block: string, name: string): string | undefined => {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  const value = match ? decode(match[1]) : ''
  return value || undefined
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** A gamelist's `releasedate` is `19910821T000000`; a year is all the shelf shows. */
const yearOf = (value: string | undefined): number | undefined => {
  const year = value ? Number(value.slice(0, 4)) : NaN
  return year > 1950 && year < 2100 ? year : undefined
}

/**
 * The entries of one gamelist.xml, by lowercased ROM file name. An image path
 * is resolved against the gamelist's own folder and kept only when it is a file
 * under media/consoles, since only those are served.
 */
export function parseGamelist(xml: string, gamelistDir: string, root = consolesRoot()): Map<string, RomMeta> {
  const entries = new Map<string, RomMeta>()
  const image = (path: string | undefined): string | undefined => {
    if (!path || path.startsWith('~')) return undefined
    const absolute = isAbsolute(path) ? path : resolve(gamelistDir, path)
    const inside = relative(root, absolute)
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || !existsSync(absolute)) return undefined
    return consolesUrl(...inside.split(sep))
  }
  for (const [, block] of xml.matchAll(/<game(?:\s[^>]*)?>([\s\S]*?)<\/game>/gi)) {
    const path = tag(block, 'path')
    if (!path) continue
    // Batocera and Skraper put box art in `thumbnail` and a screenshot (or a
    // mix) in `image`; plain EmulationStation has only `image`.
    const box = image(tag(block, 'thumbnail')) ?? image(tag(block, 'boxart'))
    const shot = image(tag(block, 'image'))
    const fanart = image(tag(block, 'fanart'))
    const meta: RomMeta = {
      title: tag(block, 'name'),
      overview: tag(block, 'desc'),
      year: yearOf(tag(block, 'releasedate')),
      developer: tag(block, 'developer'),
      publisher: tag(block, 'publisher'),
      genre: tag(block, 'genre'),
      players: tag(block, 'players'),
      coverUrl: box ?? shot,
      backdropUrl: fanart ?? (box ? shot : undefined),
      // EmulationStation calls a clear logo a marquee; some frontends a wheel.
      logoUrl: image(tag(block, 'marquee')) ?? image(tag(block, 'wheel')),
      source: 'gamelist',
    }
    for (const key of Object.keys(meta) as Array<keyof RomMeta>) if (meta[key] === undefined) delete meta[key]
    entries.set(baseName(path).toLowerCase(), meta)
  }
  return entries
}

const gamelistCache = new Map<string, { mtimeMs: number; entries: Map<string, RomMeta> }>()

/** Every gamelist.xml for a system: in each of its console folders and their `roms` folders. */
function gamelistsFor(folders: string[]): Map<string, RomMeta> {
  const merged = new Map<string, RomMeta>()
  for (const folder of folders) {
    for (const dir of [join(consolesRoot(), folder), join(consolesRoot(), folder, 'roms')]) {
      const file = join(dir, 'gamelist.xml')
      let mtimeMs: number
      try { mtimeMs = statSync(file).mtimeMs } catch { continue }
      let cached = gamelistCache.get(file)
      if (!cached || cached.mtimeMs !== mtimeMs) {
        try {
          cached = { mtimeMs, entries: parseGamelist(readFileSync(file, 'utf8'), dir) }
          gamelistCache.set(file, cached)
        } catch (err) {
          logger.warn(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
      }
      for (const [key, meta] of cached.entries) if (!merged.has(key)) merged.set(key, meta)
    }
  }
  return merged
}

// ── What the shelf is sent ──────────────────────────────────────────────────

interface RomRow {
  system: string; file: string; title: string | null; overview: string | null; year: number | null
  developer: string | null; publisher: string | null; genre: string | null; players: string | null
  cover_path: string | null; backdrop_path: string | null; logo_path: string | null
  source: string; scraped_at: string; scrape_version: number
}

const pathUrl = (path: string | null) => path ? consolesUrl(...path.split('/')) : undefined

function rowMeta(row: RomRow): RomMeta {
  const meta: RomMeta = {
    title: row.title ?? undefined, overview: row.overview ?? undefined, year: row.year ?? undefined,
    developer: row.developer ?? undefined, publisher: row.publisher ?? undefined, genre: row.genre ?? undefined,
    players: row.players ?? undefined, coverUrl: pathUrl(row.cover_path), backdropUrl: pathUrl(row.backdrop_path),
    logoUrl: pathUrl(row.logo_path),
    source: ['screenscraper', 'launchbox', 'libretro'].includes(row.source) ? row.source as RomMeta['source'] : undefined,
  }
  for (const key of Object.keys(meta) as Array<keyof RomMeta>) if (meta[key] === undefined) delete meta[key]
  return meta
}

/** The metadata of each ROM of a system, by lowercased file name: its gamelist entry over what was scraped. */
export function romMetadataFor(systemId: string, folders: string[], roms: Array<{ file: string }>): Map<string, RomMeta> {
  const result = new Map<string, RomMeta>()
  if (!roms.length) return result
  const scraped = new Map<string, RomRow>()
  try {
    for (const row of getDb().prepare('SELECT * FROM rom_metadata WHERE system = ?').all(systemId) as RomRow[]) scraped.set(row.file, row)
  } catch { /* table missing on an old database: gamelists still apply */ }
  const gamelist = gamelistsFor(folders)
  for (const rom of roms) {
    const key = rom.file.toLowerCase()
    const row = scraped.get(key)
    const merged = { ...(row ? rowMeta(row) : {}), ...(gamelist.get(key) ?? {}) }
    if (Object.keys(merged).length) result.set(key, merged)
  }
  return result
}

// ── libretro thumbnails ─────────────────────────────────────────────────────

const libretroBase = () => process.env.ARCHIVIST_LIBRETRO_THUMBNAILS_URL ?? 'https://thumbnails.libretro.com'

/** The libretro playlist name of each system; Game Boy Color files have their own. */
function libretroSystem(systemId: string, file: string): string | undefined {
  const ext = file.toLowerCase().split('.').pop()
  switch (systemId) {
    case 'nes': return 'Nintendo - Nintendo Entertainment System'
    case 'snes': return 'Nintendo - Super Nintendo Entertainment System'
    case 'gameboy': return ext === 'gbc' ? 'Nintendo - Game Boy Color' : 'Nintendo - Game Boy'
    case 'mastersystem': return 'Sega - Master System - Mark III'
    case 'genesis': return 'Sega - Mega Drive - Genesis'
    case 'n64': return 'Nintendo - Nintendo 64'
    case 'psx': return 'Sony - PlayStation'
    case 'saturn': return 'Sega - Saturn'
    case 'dreamcast': return 'Sega - Dreamcast'
    case 'gamecube': return 'Nintendo - GameCube'
    case 'ps2': return 'Sony - PlayStation 2'
    case 'psp': return 'Sony - PlayStation Portable'
    default: return undefined
  }
}

const listingCache = new Map<string, { at: number; names: string[] }>()

/** The image names in one libretro thumbnail folder, from its directory index; kept for a day. */
async function libretroListing(system: string, kind: 'Named_Boxarts' | 'Named_Snaps' | 'Named_Titles' | 'Named_Logos'): Promise<string[]> {
  const key = `${system}/${kind}`
  const cached = listingCache.get(key)
  if (cached && Date.now() - cached.at < 86_400_000) return cached.names
  const res = await fetch(`${libretroBase()}/${encodeURIComponent(system)}/${kind}/`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`libretro thumbnails answered ${res.status} for ${key}`)
  const html = await res.text()
  const names = [...html.matchAll(/href="([^"?/][^"]*\.png)"/gi)].map(([, href]) => decodeURIComponent(href).replace(/\.png$/i, ''))
  listingCache.set(key, { at: Date.now(), names })
  return names
}

/**
 * The thumbnail named for a ROM. The set name is tried as it is first — with
 * the characters libretro replaces in file names replaced — and then any
 * thumbnail of the same game, preferring one that shares the ROM's region.
 */
export function pickLibretroName(romName: string, names: string[]): string | undefined {
  const exact = romName.replace(/[&*/:`<>?\\|"]/g, '_')
  if (names.includes(exact)) return exact
  const candidates = nameCandidates(romName, names.map(name => ({ name, key: matchKey(name) })))
  if (!candidates.length) return undefined
  const wanted = regionsOf(romName)
  const score = (name: string) => {
    const regions = regionsOf(name)
    let points = 0
    for (const region of wanted) if (regions.has(region)) points += 2
    if (regions.has('usa') || regions.has('world') || regions.has('europe')) points += 1
    // A beta or a demo is someone else's box.
    if ([...regions].some(region => /beta|proto|demo|sample|unl/.test(region))) points -= 3
    return points
  }
  return candidates.sort((a, b) => score(b) - score(a) || a.length - b.length)[0]
}

async function libretroLookup(systemId: string, rom: ScannedRom): Promise<{ cover?: string; backdrop?: string; logo?: string } | null> {
  const system = libretroSystem(systemId, rom.file)
  if (!system) return null
  const url = (kind: string, name: string) => `${libretroBase()}/${encodeURIComponent(system)}/${kind}/${encodeURIComponent(name)}.png`
  const find = async (kind: 'Named_Boxarts' | 'Named_Snaps' | 'Named_Logos') => {
    try {
      const name = pickLibretroName(rom.name, await libretroListing(system, kind))
      return name ? url(kind, name) : undefined
    } catch (err) {
      // Box art is what matters; a missing folder of snaps or logos is not an error.
      if (kind === 'Named_Boxarts') throw err
      return undefined
    }
  }
  const [cover, backdrop, logo] = [await find('Named_Boxarts'), await find('Named_Snaps'), await find('Named_Logos')]
  return cover || backdrop || logo ? { cover, backdrop, logo } : null
}

// ── LaunchBox ───────────────────────────────────────────────────────────────

const launchBoxNameCache = new Map<string, Array<{ name: string; key: string; hasOverview: boolean }>>()

/** The LaunchBox game a ROM is, when the kept copy of the database names it. */
export function launchBoxMatch(systemId: string, rom: { name: string; file: string }): LaunchBoxGame | null {
  const platform = launchBoxPlatform(systemId, rom.file)
  if (!platform) return null
  let names = launchBoxNameCache.get(platform)
  if (!names) {
    names = launchBoxNames(platform).map(entry => ({ name: String(entry.databaseId), key: entry.key, hasOverview: entry.hasOverview }))
    launchBoxNameCache.set(platform, names)
  }
  const ids = [...new Set(nameCandidates(rom.name, names))]
  if (!ids.length) return null
  // Several games can share a name; the one with a description is the one worth showing.
  const described = new Set(names.filter(entry => entry.hasOverview).map(entry => entry.name))
  const id = ids.find(candidate => described.has(candidate)) ?? ids[0]
  return launchBoxGame(Number(id), { platform, regions: regionsOf(rom.name) })
}

// ── ScreenScraper ───────────────────────────────────────────────────────────

const screenScraperBase = () => process.env.SCREENSCRAPER_BASE_URL ?? 'https://api.screenscraper.fr/api2'
const SS_SYSTEMS: Record<string, number> = { nes: 3, snes: 4, gameboy: 9, mastersystem: 2, genesis: 1, n64: 14, psx: 57, saturn: 22, dreamcast: 23, gamecube: 13, ps2: 58, psp: 61 }
const SS_REGIONS = ['us', 'wor', 'eu', 'uk', 'ss', 'jp']

export const screenScraperConfigured = () => !!(process.env.SCREENSCRAPER_DEV_ID && process.env.SCREENSCRAPER_DEV_PASSWORD)

/** A reason to stop asking ScreenScraper for the rest of a run: bad credentials, a spent quota, the API closed. */
class ScreenScraperUnavailable extends Error {}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export async function crc32File(path: string): Promise<string> {
  let crc = -1
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8)
  }
  return ((crc ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

type SsText = { region?: string; langue?: string; text?: string }
const pickText = (list: SsText[] | undefined, key: 'region' | 'langue', order: string[]) => {
  if (!Array.isArray(list) || !list.length) return undefined
  for (const want of order) {
    const hit = list.find(item => item[key] === want && item.text)
    if (hit) return hit.text
  }
  return list.find(item => item.text)?.text
}

interface SsMedia { type?: string; region?: string; url?: string; format?: string }
const pickMedia = (medias: SsMedia[] | undefined, types: string[]) => {
  if (!Array.isArray(medias)) return undefined
  for (const type of types) {
    const ofType = medias.filter(media => media.type === type && media.url)
    if (!ofType.length) continue
    for (const region of SS_REGIONS) {
      const hit = ofType.find(media => media.region === region)
      if (hit) return hit.url
    }
    return ofType[0].url
  }
  return undefined
}

async function screenScraperLookup(systemId: string, rom: ScannedRom): Promise<Found | null> {
  const systemeid = rom.file.toLowerCase().endsWith('.gbc') ? 10 : SS_SYSTEMS[systemId]
  if (!systemeid) return null
  // A checksum is what makes the match certain; a disc image of several
  // hundred megabytes is matched by name and size instead.
  const crc = rom.size > 0 && rom.size <= 128 * 1024 * 1024 ? await crc32File(rom.path) : undefined
  const params = new URLSearchParams({
    devid: process.env.SCREENSCRAPER_DEV_ID ?? '',
    devpassword: process.env.SCREENSCRAPER_DEV_PASSWORD ?? '',
    softname: 'Archivist',
    output: 'json',
    systemeid: String(systemeid),
    romtype: 'rom',
    romnom: rom.file,
    romtaille: String(rom.size),
  })
  if (crc) params.set('crc', crc)
  if (process.env.SCREENSCRAPER_USER) params.set('ssid', process.env.SCREENSCRAPER_USER)
  if (process.env.SCREENSCRAPER_PASSWORD) params.set('sspassword', process.env.SCREENSCRAPER_PASSWORD)

  const res = await fetch(`${screenScraperBase()}/jeuInfos.php?${params}`, { signal: AbortSignal.timeout(30_000) })
  const body = await res.text()
  if (res.status === 404) return null
  if ([401, 403, 423, 426, 430, 431].includes(res.status)) throw new ScreenScraperUnavailable(`ScreenScraper refused the request (${res.status}): ${body.slice(0, 160)}`)
  if (res.status === 429) {
    // Too many threads at once: wait and let the next ROM try again.
    await new Promise(r => setTimeout(r, 5000))
    return null
  }
  if (!res.ok) throw new Error(`ScreenScraper answered ${res.status}: ${body.slice(0, 160)}`)
  let game: any
  try { game = JSON.parse(body)?.response?.jeu } catch { throw new Error(`ScreenScraper sent something other than JSON: ${body.slice(0, 160)}`) }
  if (!game) return null

  const genre = Array.isArray(game.genres) ? pickText(game.genres[0]?.noms, 'langue', ['en']) : undefined
  return {
    title: pickText(game.noms, 'region', SS_REGIONS),
    overview: pickText(game.synopsis, 'langue', ['en']),
    year: yearOf(pickText(game.dates, 'region', SS_REGIONS)),
    developer: game.developpeur?.text,
    publisher: game.editeur?.text,
    genre,
    players: game.joueurs?.text,
    cover: pickMedia(game.medias, ['box-2D']),
    backdrop: pickMedia(game.medias, ['fanart', 'ss', 'sstitle']),
    logo: pickMedia(game.medias, ['wheel-hd', 'wheel']),
    crc,
    source: 'screenscraper',
  }
}

// ── Saving what was found ───────────────────────────────────────────────────

/** Download an image into the console's media/ folder; the path it was saved at, relative to media/consoles. */
async function saveImage(url: string, folder: string, kind: 'covers' | 'backdrops' | 'logos', romName: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    const ext = type.includes('jpeg') || type.includes('jpg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png'
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length < 64) return null
    const relativePath = [folder, 'media', kind, `${romName.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`]
    const target = join(consolesRoot(), ...relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    return relativePath.join('/')
  } catch (err) {
    logger.warn(`Could not save ${kind} for ${romName}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

// ── The scrape job ──────────────────────────────────────────────────────────

export interface RomScrapeStatus {
  running: boolean
  total: number
  done: number
  matched: number
  current?: string
  sources: string[]
  startedAt?: string
  finishedAt?: string
  error?: string
  /** What the last pass added to the Games library. */
  library?: { added: number; updated: number; linked: number; removed: number }
}

let status: RomScrapeStatus = { running: false, total: 0, done: 0, matched: 0, sources: [] }
let lastAutoRun = 0
/** Raised when a source is added: rows scraped before it are looked up again. 2 added LaunchBox and logos; 3 records the LaunchBox game, for the Games library. */
const SCRAPE_VERSION = 3
/** A ROM found nowhere is asked about again after this long, in case a source has added it. */
const RETRY_MISSES_MS = 30 * 86_400_000

export const romScrapeStatus = (): RomScrapeStatus => ({ ...status })

/** ROMs with nothing known about them: no row yet, or a miss old enough to try again. Force takes every ROM. */
function pending(scanned: ScannedSystem[], force: boolean, onlySystem?: string) {
  const db = getDb()
  const rows = new Map<string, { source: string; scraped_at: string; scrape_version: number }>()
  for (const row of db.prepare('SELECT system, file, source, scraped_at, scrape_version FROM rom_metadata').all() as Array<{ system: string; file: string; source: string; scraped_at: string; scrape_version: number }>) {
    rows.set(`${row.system}/${row.file}`, row)
  }
  const work: Array<{ system: ScannedSystem; rom: ScannedRom }> = []
  for (const system of scanned) {
    if (onlySystem && system.def.id !== onlySystem) continue
    const gamelist = gamelistsFor(system.folders)
    for (const rom of system.roms) {
      const key = rom.file.toLowerCase()
      // A gamelist entry with art is the user's own answer; nothing to look up.
      if (!force && gamelist.get(key)?.coverUrl) continue
      const row = rows.get(`${system.def.id}/${key}`)
      // A row from before a source was added is looked up again for what it adds.
      const current = row && row.scrape_version >= SCRAPE_VERSION
      if (!force && row && current && (row.source !== 'none' || Date.now() - Date.parse(`${row.scraped_at}Z`) < RETRY_MISSES_MS)) continue
      work.push({ system, rom })
    }
  }
  return work
}

/** What one source found for a ROM: its details, and where its images can be fetched. */
type Found = Omit<RomMeta, 'coverUrl' | 'backdropUrl' | 'logoUrl'> & { cover?: string; backdrop?: string; logo?: string; crc?: string }

/** Fill what `into` lacks from `from`; the first source to answer a field keeps it. */
function merge(into: Found | null, from: Found | null): Found | null {
  if (!from) return into
  if (!into) return { ...from }
  const merged: any = { ...into }
  for (const [key, value] of Object.entries(from)) if (merged[key] === undefined && value !== undefined) merged[key] = value
  return merged
}

async function run(work: Array<{ system: ScannedSystem; rom: ScannedRom }>) {
  const db = getDb()
  const upsert = db.prepare(`
    INSERT INTO rom_metadata (system, file, title, overview, year, developer, publisher, genre, players, cover_path, backdrop_path, logo_path, source, crc, launchbox_id, scrape_version, scraped_at)
    VALUES (@system, @file, @title, @overview, @year, @developer, @publisher, @genre, @players, @cover_path, @backdrop_path, @logo_path, @source, @crc, @launchbox_id, @scrape_version, datetime('now'))
    ON CONFLICT (system, file) DO UPDATE SET
      title = excluded.title, overview = excluded.overview, year = excluded.year, developer = excluded.developer,
      publisher = excluded.publisher, genre = excluded.genre, players = excluded.players,
      cover_path = COALESCE(excluded.cover_path, rom_metadata.cover_path),
      backdrop_path = COALESCE(excluded.backdrop_path, rom_metadata.backdrop_path),
      logo_path = COALESCE(excluded.logo_path, rom_metadata.logo_path),
      source = excluded.source, crc = excluded.crc, launchbox_id = excluded.launchbox_id,
      scrape_version = excluded.scrape_version, scraped_at = excluded.scraped_at
  `)
  const existing = db.prepare('SELECT cover_path, backdrop_path, logo_path, scrape_version FROM rom_metadata WHERE system = ? AND file = ?')
  let useScreenScraper = screenScraperConfigured()
  status = {
    running: true, total: work.length, done: 0, matched: 0, startedAt: new Date().toISOString(),
    sources: [...(useScreenScraper ? ['ScreenScraper'] : []), 'LaunchBox', 'libretro thumbnails'],
  }
  status.current = 'Fetching the LaunchBox games database'
  const useLaunchBox = await ensureLaunchBox()
  launchBoxNameCache.clear()
  if (!useLaunchBox) status.sources = status.sources.filter(source => source !== 'LaunchBox')
  logger.info(`Scraping ${work.length} ROM(s) from ${status.sources.join(', ')}`)

  for (const { system, rom } of work) {
    status.current = `${system.def.label}: ${rom.name}`
    const id = system.def.id
    // Each source fills what the ones before it left: ScreenScraper knows the
    // file itself; LaunchBox has the descriptions and logos; libretro, named
    // after the ROM sets, has the most exact box art.
    let found: Found | null = null
    if (useScreenScraper) {
      try {
        found = await screenScraperLookup(id, rom)
      } catch (err) {
        if (err instanceof ScreenScraperUnavailable) {
          useScreenScraper = false
          status.error = err.message
          logger.warn(`${err.message}; carrying on without ScreenScraper`)
        } else logger.warn(`ScreenScraper lookup failed for ${rom.file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    let libretro: Found | null = null
    try {
      const art = await libretroLookup(id, rom)
      if (art) libretro = { ...art, source: 'libretro' }
    } catch (err) {
      logger.warn(`libretro lookup failed for ${rom.file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    let launchBox: Found | null = null
    let launchBoxId: number | null = null
    if (useLaunchBox) {
      const game = launchBoxMatch(id, rom)
      if (game) {
        launchBoxId = game.databaseId
        launchBox = {
          title: game.name, overview: game.overview, year: game.year, developer: game.developer, publisher: game.publisher,
          genre: game.genre, players: game.players, cover: game.cover, logo: game.logo, backdrop: game.backdrop, source: 'launchbox',
        }
      }
    }
    // libretro's box is the set's own, so it goes before LaunchBox's; for the
    // rest — text, logo, fanart — LaunchBox goes first.
    if (!found?.cover && libretro?.cover) found = merge(found, { cover: libretro.cover, source: 'libretro' })
    found = merge(found, launchBox)
    found = merge(found, libretro)

    const folder = system.folders[0]
    const had = existing.get(id, rom.file.toLowerCase()) as { cover_path: string | null; backdrop_path: string | null; logo_path: string | null; scrape_version: number } | undefined
    // Before LaunchBox the backdrop was a small in-game screenshot; its fanart replaces one.
    if (had && had.scrape_version < 2 && launchBox?.backdrop) { had.backdrop_path = null; found = { ...found!, backdrop: launchBox.backdrop } }
    const keep = (path: string | null | undefined) => path && existsSync(join(consolesRoot(), ...path.split('/'))) ? path : null
    // An image already saved is kept rather than fetched again.
    const cover = keep(had?.cover_path) ?? (found?.cover ? await saveImage(found.cover, folder, 'covers', rom.name) : null)
    const backdrop = keep(had?.backdrop_path) ?? (found?.backdrop ? await saveImage(found.backdrop, folder, 'backdrops', rom.name) : null)
    const logo = keep(had?.logo_path) ?? (found?.logo ? await saveImage(found.logo, folder, 'logos', rom.name) : null)
    const matched = !!(found && (cover || backdrop || logo || found.overview))
    upsert.run({
      system: id,
      file: rom.file.toLowerCase(),
      // Without a source's title, the set name tidied up still reads better than the file name.
      title: found?.title ?? displayTitle(rom.name),
      overview: found?.overview ?? null,
      year: found?.year ?? null,
      developer: found?.developer ?? null,
      publisher: found?.publisher ?? null,
      genre: found?.genre ?? null,
      players: found?.players ?? null,
      cover_path: cover,
      backdrop_path: backdrop,
      logo_path: logo,
      source: matched ? found!.source : 'none',
      crc: found?.crc ?? null,
      launchbox_id: launchBoxId,
      scrape_version: SCRAPE_VERSION,
    })
    status.done++
    if (matched) status.matched++
  }
  status.current = 'Adding the ROMs to the Games library'
  await syncLibrary()
  status = { ...status, running: false, current: undefined, finishedAt: new Date().toISOString() }
  logger.info(`ROM scrape finished: ${status.matched} of ${status.total} matched`)
}

/** Bring the Games library up to date with the ROMs and what is now known of them. */
async function syncLibrary(scanned?: ScannedSystem[]) {
  try {
    // Imported when needed: the Games library's module reads this one's results.
    const { syncRomLibrary } = await import('../modules/games/rom-library.js')
    const { added, updated, linked, removed } = syncRomLibrary(scanned)
    status.library = { added, updated, linked, removed }
  } catch (err) {
    logger.warn(`Could not add the ROMs to the Games library: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Start a scrape unless one is running. Returns false when one already was. */
export function startRomScrape(options: { force?: boolean; system?: string; scanned?: ScannedSystem[] } = {}): boolean {
  if (status.running) return false
  const scanned = options.scanned ?? scanArcade()
  const work = pending(scanned, !!options.force, options.system)
  if (!work.length) {
    status = { running: false, total: 0, done: 0, matched: 0, sources: [], finishedAt: new Date().toISOString() }
    // Nothing new to look up, but a ROM may have gone, or the library been made since.
    void syncLibrary(scanned)
    return true
  }
  status.running = true
  run(work).catch(err => {
    logger.error(`ROM scrape failed: ${err instanceof Error ? err.message : String(err)}`)
    status = { ...status, running: false, current: undefined, error: err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() }
  })
  return true
}

/** Scrape what is new, at most every ten minutes, from the shelf's own listing. */
export function scheduleRomScrape(scanned: ScannedSystem[]): void {
  if (process.env.ARCHIVIST_ROM_SCRAPE === 'off' || status.running || Date.now() - lastAutoRun < 600_000) return
  if (!scanned.some(system => system.roms.length)) return
  lastAutoRun = Date.now()
  try { startRomScrape({ scanned }) } catch (err) {
    logger.warn(`Could not start the ROM scrape: ${err instanceof Error ? err.message : String(err)}`)
  }
}

let scheduleTimers: { startup?: ReturnType<typeof setTimeout>; every?: ReturnType<typeof setInterval> } = {}
const SCHEDULE_EVERY_MS = 6 * 3_600_000

/**
 * Look through media/consoles a minute after the server starts and every six
 * hours after, so new ROMs are scraped and reach the Games library without
 * anyone opening the arcade.
 */
export function startRomScheduler(): void {
  if (scheduleTimers.startup || scheduleTimers.every) return
  const tick = () => {
    if (process.env.ARCHIVIST_ROM_SCRAPE === 'off' || status.running) return
    try { startRomScrape() } catch (err) { logger.warn(`ROM scan failed: ${err instanceof Error ? err.message : String(err)}`) }
  }
  scheduleTimers.startup = setTimeout(() => {
    scheduleTimers.startup = undefined
    tick()
    scheduleTimers.every = setInterval(tick, SCHEDULE_EVERY_MS)
    scheduleTimers.every.unref?.()
  }, 60_000)
  scheduleTimers.startup.unref?.()
}

export function stopRomScheduler(): void {
  if (scheduleTimers.startup) clearTimeout(scheduleTimers.startup)
  if (scheduleTimers.every) clearInterval(scheduleTimers.every)
  scheduleTimers = {}
}

/** Admin: see and start the ROM scrape. Mounted at /api/v1/roms. */
export function createRomScrapeRouter(): Router {
  const router = Router()
  router.get('/scrape', (_req, res) => {
    res.json({ ...romScrapeStatus(), screenScraper: screenScraperConfigured() })
  })
  router.post('/scrape', (req, res) => {
    const force = req.body?.force === true
    const system = typeof req.body?.system === 'string' ? req.body.system : undefined
    const started = startRomScrape({ force, system })
    res.status(started ? 202 : 409).json({ started, ...romScrapeStatus(), screenScraper: screenScraperConfigured() })
  })
  return router
}
