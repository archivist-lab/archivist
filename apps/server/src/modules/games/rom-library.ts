import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../../db.js'
import { consoleFolderFor, consolesRoot, consolesUrl, scanArcade, type ScannedSystem } from '../../player/arcade.js'
import { romMetadataFor } from '../../player/rom-metadata.js'

const logger = createLogger('RomLibrary')

/**
 * The ROMs in media/consoles, as games in the Games library.
 *
 * Every ROM the arcade can play is added as a game on disk ('downloaded', as the library counts them), with what the
 * ROM scraper found for it — the LaunchBox game, its description and box
 * art — so the library shows the collection without each game being searched
 * for and added by hand. A game already in the library as the same LaunchBox
 * game, with no file of its own, takes the ROM instead of gaining a twin.
 *
 * Games added this way are marked `source = 'rom'` and leave again when their
 * file does. Details someone has edited (`metadata_locked`) are not overwritten.
 */

/** The name each system goes by in the library's platform list. */
const PLATFORM_NAMES: Record<string, string> = {
  nes: 'Nintendo (NES)', snes: 'Super Nintendo (SNES)', gameboy: 'Game Boy', mastersystem: 'Sega Master System',
  genesis: 'Sega Mega Drive / Genesis', n64: 'Nintendo 64', psx: 'PlayStation 1', saturn: 'Sega Saturn',
  dreamcast: 'Sega Dreamcast', gamecube: 'Nintendo GameCube', ps2: 'PlayStation 2', psp: 'PlayStation Portable',
}

/** The arcade system a Games-library platform is, when it is one: its ROMs, pictures and details share a console folder. */
export function systemForPlatform(name: string): string | undefined {
  return Object.entries(PLATFORM_NAMES).find(([, platform]) => platform === name)?.[0]
}

/** The platform name a system goes by in the Games library. */
export const platformNameFor = (systemId: string): string | undefined => PLATFORM_NAMES[systemId]

/** The console's own folder: its pictures and system.json. */
export const consoleSystemDir = (systemId: string) => join(consolesRoot(), consoleFolderFor(systemId), 'system')

/** The pictures a console's system/ folder may hold: the column each fills, and the file the app saves it as. */
export const SYSTEM_IMAGES = { image_url: 'image.jpg', logo_url: 'logo.png', backdrop_url: 'background.jpg' } as const
type ImageColumn = keyof typeof SYSTEM_IMAGES
const TEXT_FIELDS = ['overview', 'manufacturer', 'developer', 'release_year', 'media', 'cpu'] as const

/**
 * system/system.json: a console's details, kept with it and editable by hand.
 *
 * `images` names a file in system/ (or gives a full URL). The app writes the
 * file whenever the console is edited in the Games library, and takes it back
 * into the database whenever it is newer than the database and says something
 * else — so a hand edit shows on the next page load. A field left out is left
 * as it is; null clears it, back to what LaunchBox says; a picture left out of
 * `images` is cleared; one naming a file that is not there is ignored.
 */
export interface SystemJson {
  name: string
  overview?: string | null
  manufacturer?: string | null
  developer?: string | null
  release_year?: number | null
  media?: string | null
  cpu?: string | null
  images?: Partial<Record<ImageColumn, string>>
}

const systemJsonPath = (systemId: string) => join(consoleSystemDir(systemId), 'system.json')
const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }

/** A picture column as system.json names it: the file name of a picture in system/, else its URL. */
function imageEntry(systemId: string, value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const prefix = decode(consolesUrl(consoleFolderFor(systemId), 'system')) + '/'
  const path = decode(value.split('?')[0])
  return path.startsWith(prefix) ? path.slice(prefix.length) : value
}

/** The URL a system.json picture stands for, or undefined when it names a file that is not in system/. */
function imageUrl(systemId: string, entry: string): string | undefined {
  if (/^(https?:)?\/\//i.test(entry) || entry.startsWith('/media/')) return entry
  const folder = consoleFolderFor(systemId)
  const dir = join(consolesRoot(), folder, 'system')
  const file = resolve(dir, entry)
  if (relative(dir, file).startsWith('..')) return undefined
  // Versioned by the file's time, so a picture replaced under the same name repaints.
  try { return `${consolesUrl(folder, 'system', ...relative(dir, file).split(sep))}?v=${Math.floor(statSync(file).mtimeMs)}` } catch { return undefined }
}

/** Write a console's system.json from its game_platforms row. */
export function writeSystemJson(systemId: string, row: Record<string, any> | undefined): void {
  const name = PLATFORM_NAMES[systemId]
  if (!name) return
  const images: SystemJson['images'] = {}
  for (const column of Object.keys(SYSTEM_IMAGES) as ImageColumn[]) {
    const entry = imageEntry(systemId, row?.[column])
    if (entry) images[column] = entry
  }
  const json: SystemJson = { name, ...Object.fromEntries(TEXT_FIELDS.map(key => [key, row?.[key] ?? null])), images }
  const path = systemJsonPath(systemId)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
  } catch (err) {
    logger.warn(`Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Each system.json as last read, by its time, so an unchanged file is not parsed on every request. */
const parsedSystemJson = new Map<string, { mtimeMs: number; json: SystemJson | null; warned: Set<string> }>()

function loadSystemJson(path: string, mtimeMs: number) {
  let cached = parsedSystemJson.get(path)
  if (cached?.mtimeMs === mtimeMs) return cached
  cached = { mtimeMs, json: null, warned: new Set() }
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'))
    if (json && typeof json === 'object' && !Array.isArray(json)) cached.json = json
    else logger.warn(`Ignoring ${path}: not a JSON object`)
  } catch (err) {
    logger.warn(`Ignoring ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  parsedSystemJson.set(path, cached)
  return cached
}

/** Take a hand edit of a console's system.json into its game_platforms row. */
export function importSystemJson(libraryId: number, systemId: string): void {
  const name = PLATFORM_NAMES[systemId]
  if (!name) return
  const path = systemJsonPath(systemId)
  let mtimeMs: number
  try { mtimeMs = statSync(path).mtimeMs } catch { return }
  const db = getDb()
  const row = db.prepare('SELECT * FROM game_platforms WHERE library_id = ? AND name = ?').get(libraryId, name) as Record<string, any> | undefined
  // updated_at is to the second: a row saved in the same second as the file is not newer than it.
  if (row && Date.parse(`${String(row.updated_at).replace(' ', 'T')}Z`) > mtimeMs) return
  const loaded = loadSystemJson(path, mtimeMs)
  const json = loaded.json
  if (!json) return
  const warn = (message: string) => { if (!loaded.warned.has(message)) { loaded.warned.add(message); logger.warn(message) } }

  const updates: Record<string, string | number | null> = {}
  for (const field of TEXT_FIELDS) {
    if (!(field in json)) continue
    const value = json[field]
    const valid = value === null || (field === 'release_year' ? Number.isInteger(value) : typeof value === 'string')
    if (!valid) { warn(`Ignoring ${field} in ${path}: not a ${field === 'release_year' ? 'whole number' : 'string'}`); continue }
    if (value !== (row?.[field] ?? null)) updates[field] = value as string | number | null
  }
  if (json.images && typeof json.images === 'object') {
    for (const column of Object.keys(SYSTEM_IMAGES) as ImageColumn[]) {
      const entry = json.images[column]
      if (entry === imageEntry(systemId, row?.[column])) continue
      if (entry == null) { updates[column] = null; continue }
      const url = typeof entry === 'string' ? imageUrl(systemId, entry) : undefined
      if (url) updates[column] = url
      else warn(`Ignoring ${column} in ${path}: ${String(entry)} is not a file in ${dirname(path)}`)
    }
  }
  if (!Object.keys(updates).length) return
  db.prepare('INSERT OR IGNORE INTO game_platforms (library_id, name) VALUES (?, ?)').run(libraryId, name)
  db.prepare(`UPDATE game_platforms SET ${Object.keys(updates).map(column => `${column} = @${column}`).join(', ')}, updated_at = datetime('now')
    WHERE library_id = @library_id AND name = @name`).run({ ...updates, library_id: libraryId, name })
  logger.info(`Took ${Object.keys(updates).join(', ')} for ${name} from ${path}`)
}

/**
 * A console platform's chosen details: its game_platforms row, with the
 * pictures dropped into system/ under the app's own names where the row has none.
 */
export function consolePlatformRow(systemId: string, row: Record<string, any> | undefined): Record<string, any> {
  const folder = consoleFolderFor(systemId)
  const merged: Record<string, any> = { ...(row ?? {}) }
  for (const [column, file] of Object.entries(SYSTEM_IMAGES)) {
    merged[column] ??= existsSync(join(consolesRoot(), folder, 'system', file)) ? consolesUrl(folder, 'system', file) : null
  }
  return merged
}

/**
 * The artwork and description chosen for a system's platform in the Games
 * library the ROMs go in, for the arcade's rows: its clear logo over the row,
 * its background behind a game that has none.
 */
export function platformArtFor(systemId: string): { name: string; logoUrl?: string; backdropUrl?: string; imageUrl?: string; overview?: string } | null {
  const name = PLATFORM_NAMES[systemId]
  const libraryId = name ? romLibrary() : null
  if (!name || libraryId == null) return null
  let saved: any
  try {
    importSystemJson(libraryId, systemId)
    saved = getDb().prepare('SELECT * FROM game_platforms WHERE library_id = ? AND name = ?').get(libraryId, name)
  } catch { return null }
  const row = consolePlatformRow(systemId, saved)
  return { name, logoUrl: row.logo_url ?? undefined, backdropUrl: row.backdrop_url ?? undefined, imageUrl: row.image_url ?? undefined, overview: row.overview ?? undefined }
}

/** `(Disc 2)`, `(Disk 2 of 3)`: which disc of a game a file is. */
const DISC = /\s*\(Dis[ck] (\d+)(?: of \d+)?\)/i

export interface RomLibrarySync { libraryId: number | null; added: number; updated: number; linked: number; removed: number }

/** The Games library ROMs go in: the one named Games, else the first. */
function romLibrary(): number | null {
  const row = getDb().prepare(`
    SELECT id FROM libraries WHERE media_type = 'games'
    ORDER BY lower(name) = 'games' DESC, id ASC LIMIT 1
  `).get() as { id: number } | undefined
  return row?.id ?? null
}

export function syncRomLibrary(scanned: ScannedSystem[] = scanArcade()): RomLibrarySync {
  const result: RomLibrarySync = { libraryId: null, added: 0, updated: 0, linked: 0, removed: 0 }
  if (process.env.ARCHIVIST_ROM_LIBRARY === 'off') return result
  const libraryId = romLibrary()
  result.libraryId = libraryId
  if (libraryId == null) return result
  const db = getDb()

  const byFile = new Map<string, { id: number; source: string | null; metadata_locked: number }>()
  for (const row of db.prepare('SELECT id, file_path, source, metadata_locked FROM games WHERE library_id = ? AND file_path IS NOT NULL').all(libraryId) as any[]) {
    byFile.set(row.file_path, row)
  }
  const launchBoxIds = new Map<string, number>()
  for (const row of db.prepare('SELECT system, file, launchbox_id FROM rom_metadata WHERE launchbox_id IS NOT NULL').all() as any[]) {
    launchBoxIds.set(`${row.system}/${row.file}`, row.launchbox_id)
  }
  const unclaimed = db.prepare(`SELECT id FROM games WHERE library_id = ? AND launchbox_id = ? AND file_path IS NULL ORDER BY id LIMIT 1`)
  const insert = db.prepare(`
    INSERT INTO games (library_id, launchbox_id, title, sort_title, year, overview, genres, platforms, cover_url, screenshot_url, logo_url,
      developer, publisher, status, monitored, root_folder_path, file_path, file_size, source)
    VALUES (@library_id, @launchbox_id, @title, @sort_title, @year, @overview, @genres, @platforms, @cover_url, @screenshot_url, @logo_url,
      @developer, @publisher, 'downloaded', 0, @root_folder_path, @file_path, @file_size, 'rom')
  `)
  const refresh = db.prepare(`
    UPDATE games SET launchbox_id = COALESCE(@launchbox_id, launchbox_id), title = @title, sort_title = @sort_title,
      year = COALESCE(@year, year), overview = COALESCE(@overview, overview), genres = @genres, platforms = @platforms,
      cover_url = COALESCE(@cover_url, cover_url), screenshot_url = COALESCE(@screenshot_url, screenshot_url),
      logo_url = COALESCE(@logo_url, logo_url),
      developer = COALESCE(@developer, developer), publisher = COALESCE(@publisher, publisher),
      file_size = @file_size, updated_at = datetime('now')
    WHERE id = @id
  `)
  const touchFile = db.prepare(`UPDATE games SET file_size = ?, updated_at = datetime('now') WHERE id = ?`)
  const link = db.prepare(`
    UPDATE games SET status = 'downloaded', file_path = @file_path, file_size = @file_size,
      root_folder_path = COALESCE(root_folder_path, @root_folder_path), updated_at = datetime('now')
    WHERE id = @id
  `)

  const seen = new Set<string>()
  db.transaction(() => {
    for (const system of scanned) {
      if (!system.roms.length) continue
      const meta = romMetadataFor(system.def.id, system.folders, system.roms)
      // A game on several discs is one game: its first disc stands for it.
      const firstDiscs = new Set(system.roms.filter(rom => DISC.exec(rom.name)?.[1] === '1').map(rom => rom.name.replace(DISC, '')))
      for (const rom of system.roms) {
        const disc = DISC.exec(rom.name)
        if (disc && disc[1] !== '1' && firstDiscs.has(rom.name.replace(DISC, ''))) { seen.add(rom.path); continue }
        seen.add(rom.path)
        const found = meta.get(rom.file.toLowerCase()) ?? {}
        const title = found.title ?? rom.name
        const values = {
          library_id: libraryId,
          launchbox_id: launchBoxIds.get(`${system.def.id}/${rom.file.toLowerCase()}`) ?? null,
          title,
          sort_title: title.replace(/^(The|A|An)\s+/i, '').toLowerCase(),
          year: found.year ?? null,
          overview: found.overview ?? null,
          genres: JSON.stringify(found.genre ? found.genre.split(/\s*[,/;]\s*/).filter(Boolean) : []),
          platforms: JSON.stringify([PLATFORM_NAMES[system.def.id] ?? system.def.label]),
          cover_url: found.coverUrl ?? null,
          screenshot_url: found.backdropUrl ?? null,
          logo_url: found.logoUrl ?? null,
          developer: found.developer ?? null,
          publisher: found.publisher ?? null,
          root_folder_path: dirname(rom.path),
          file_path: rom.path,
          file_size: rom.size,
        }
        const existing = byFile.get(rom.path)
        if (existing) {
          // A game someone manages themselves only learns the file's new size.
          if (existing.source !== 'rom' || existing.metadata_locked) touchFile.run(rom.size, existing.id)
          else { refresh.run({ ...values, id: existing.id }); result.updated++ }
          continue
        }
        const wanted = values.launchbox_id != null ? unclaimed.get(libraryId, values.launchbox_id) as { id: number } | undefined : undefined
        if (wanted) { link.run({ ...values, id: wanted.id }); result.linked++; continue }
        insert.run(values)
        result.added++
      }
    }
    // A ROM that has gone takes its game with it; one on a folder that could
    // not be read this time is still there, so only a missing file counts.
    for (const [path, row] of byFile) {
      if (row.source !== 'rom' || seen.has(path) || existsSync(path)) continue
      db.prepare('DELETE FROM games WHERE id = ?').run(row.id)
      result.removed++
    }
  })()
  if (result.added || result.linked || result.removed) {
    logger.info(`Games library: ${result.added} ROM(s) added, ${result.linked} linked to games already there, ${result.removed} removed`)
  }
  return result
}
