import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, sep } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { getMediaRoot } from '../shared/media-organizer.js'
import { mediaUrlForPath } from '../shared/library-paths.js'
import { consoleFolderFor, consolesRoot, consolesUrl, systemForFolder } from './arcade.js'
import { consoleSystemDir, SYSTEM_IMAGES, systemForPlatform, writeSystemJson } from '../modules/games/rom-library.js'

const logger = createLogger('ConsolesMigration')

/**
 * One-time move from the old ROM layout to the console folders.
 *
 * ROMs used to live in media/roms/<system>/, loose or in a `roms` folder,
 * beside `bios` and the scraper's `media`, and a console's pictures in the
 * Games library's _platforms folder. Everything of a console now lives in
 * media/consoles/<system>/{roms,bios,media,system}. This moves the files —
 * games and game folders into roms/, other loose files such as a
 * gamelist.xml to the top of the console folder, where its ./media paths
 * still resolve —
 * merges folders that are one system under two names (`megadrive` into
 * `genesis`), and rewrites the paths the database holds, so the library's
 * ROM games keep their rows instead of leaving and coming back as new ones.
 *
 * It runs before the first scan in each process and does nothing once
 * media/roms has gone. A file that would overwrite one already in place is
 * left where it was, and so is a folder that is not a console's.
 */
let done = false

export interface ConsolesMigration { moved: number; conflicts: string[]; leftBehind: string[]; rowsRewritten: number; platformsMoved: number }

export function migrateRomsToConsoles(): ConsolesMigration | null {
  if (done) return null
  done = true
  const result: ConsolesMigration = { moved: 0, conflicts: [], leftBehind: [], rowsRewritten: 0, platformsMoved: 0 }
  try {
    moveRomFolders(result)
    result.platformsMoved = movePlatformPictures()
  } catch (err) {
    logger.warn(`Moving ROMs to media/consoles failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (result.moved || result.rowsRewritten || result.platformsMoved) {
    logger.info(`Moved ${result.moved} ROM folder entries into media/consoles, rewrote ${result.rowsRewritten} database rows, moved ${result.platformsMoved} console pictures`)
  }
  for (const conflict of result.conflicts) logger.warn(`Left in media/roms, as media/consoles already has it: ${conflict}`)
  for (const folder of result.leftBehind) logger.warn(`Left in media/roms, as it is not a console's folder: ${folder}`)
  return result
}

/** Lets a test run the migration again on a fresh media root. */
export function resetConsolesMigrationForTest(): void { done = false }

const OWN = ['bios', 'media', 'roms'] as const

interface Target { folder: string; exts: string[] }

/**
 * Where a path under media/roms/<folder>/ belongs under media/consoles:
 * bios, media and roms keep their folder, a game or a game's folder goes in
 * roms, and any other loose file stays at the top of the console folder.
 */
function consolePath(parts: string[], targets: Map<string, Target>, isDirectory: boolean): string[] | null {
  const [folder, first, ...rest] = parts
  const target = targets.get(folder)
  if (!target) return null
  if (first === undefined) return [target.folder, 'roms']
  const own = OWN.find(name => name === first.toLowerCase())
  if (own) return [target.folder, own, ...rest]
  const loose = !rest.length && !isDirectory && !target.exts.includes(extname(first).toLowerCase())
  return loose ? [target.folder, first] : [target.folder, 'roms', first, ...rest]
}

function moveRomFolders(result: ConsolesMigration): void {
  const oldRoot = join(getMediaRoot(), 'roms')
  if (!existsSync(oldRoot)) return
  const newRoot = consolesRoot()
  const targets = new Map<string, Target>()
  for (const entry of readdirSync(oldRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sys = systemForFolder(entry.name)
    if (!sys) { result.leftBehind.push(entry.name); continue }
    targets.set(entry.name, { folder: consoleFolderFor(sys.id), exts: sys.exts })
  }

  for (const folder of targets.keys()) {
    const from = join(oldRoot, folder)
    for (const name of readdirSync(from)) {
      const to = consolePath([folder, name], targets, statSync(join(from, name)).isDirectory())!
      mergeInto(join(from, name), join(newRoot, ...to), result)
    }
    removeIfEmpty(from)
  }
  removeIfEmpty(oldRoot)
  result.rowsRewritten = rewriteRomPaths(oldRoot, targets)
}

/** Move `from` to `to`, merging into a folder already there; a file already there is never overwritten. */
function mergeInto(from: string, to: string, result: ConsolesMigration): void {
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    result.moved++
    return
  }
  if (statSync(from).isDirectory() && statSync(to).isDirectory()) {
    for (const name of readdirSync(from)) mergeInto(join(from, name), join(to, name), result)
    removeIfEmpty(from)
    return
  }
  result.conflicts.push(relative(join(getMediaRoot(), 'roms'), from))
}

function removeIfEmpty(dir: string): void {
  try { if (!readdirSync(dir).length) rmdirSync(dir) } catch { /* in use or already gone */ }
}

/** Point the database at where the files went: the library's ROM games, and the scraper's saved art. */
function rewriteRomPaths(oldRoot: string, targets: Map<string, Target>): number {
  const db = getDb()
  const newRoot = consolesRoot()
  const filePath = (path: string | null, isDirectory: boolean) => {
    if (!path?.startsWith(oldRoot + sep)) return path
    const to = consolePath(path.slice(oldRoot.length + 1).split(sep), targets, isDirectory)
    return to ? join(newRoot, ...to) : path
  }
  const url = (value: string | null) => {
    if (!value?.startsWith('/media/roms/')) return value
    const [path, query] = value.split('?')
    const to = consolePath(path.slice('/media/roms/'.length).split('/').map(decodeURIComponent), targets, false)
    return to ? consolesUrl(...to) + (query ? `?${query}` : '') : value
  }
  const relativeArt = (value: string | null) => {
    if (!value) return value
    const to = consolePath(value.split('/'), targets, false)
    return to ? to.join('/') : value
  }

  let rows = 0
  db.transaction(() => {
    const update = db.prepare(`
      UPDATE games SET file_path = @file_path, root_folder_path = @root_folder_path,
        cover_url = @cover_url, screenshot_url = @screenshot_url, logo_url = @logo_url
      WHERE id = @id
    `)
    const games = db.prepare(`
      SELECT id, file_path, root_folder_path, cover_url, screenshot_url, logo_url FROM games
      WHERE file_path LIKE @root OR root_folder_path LIKE @root OR cover_url LIKE '/media/roms/%'
        OR screenshot_url LIKE '/media/roms/%' OR logo_url LIKE '/media/roms/%'
    `).all({ root: `${oldRoot}${sep}%` }) as any[]
    for (const game of games) {
      update.run({
        id: game.id, file_path: filePath(game.file_path, false), root_folder_path: filePath(game.root_folder_path, true),
        cover_url: url(game.cover_url), screenshot_url: url(game.screenshot_url), logo_url: url(game.logo_url),
      })
      rows++
    }
    const art = db.prepare('UPDATE rom_metadata SET cover_path = ?, backdrop_path = ?, logo_path = ? WHERE system = ? AND file = ?')
    for (const meta of db.prepare('SELECT system, file, cover_path, backdrop_path, logo_path FROM rom_metadata').all() as any[]) {
      const next = [relativeArt(meta.cover_path), relativeArt(meta.backdrop_path), relativeArt(meta.logo_path)]
      if (next[0] === meta.cover_path && next[1] === meta.backdrop_path && next[2] === meta.logo_path) continue
      art.run(...next, meta.system, meta.file)
      rows++
    }
  })()
  return rows
}

/** Move pictures chosen for a console platform out of the library's _platforms folder into its console's system/. */
function movePlatformPictures(): number {
  const db = getDb()
  const mediaRoot = getMediaRoot()
  let moved = 0
  const touched = new Map<string, { library_id: number; name: string }>()
  for (const row of db.prepare('SELECT * FROM game_platforms').all() as any[]) {
    const system = systemForPlatform(row.name)
    if (!system) continue
    const dir = consoleSystemDir(system)
    for (const [column, file] of Object.entries(SYSTEM_IMAGES)) {
      const value: string | null = row[column]
      if (!value?.startsWith('/media/') || value.startsWith('/media/consoles/')) continue
      const [path, query] = value.split('?')
      const from = join(mediaRoot, ...path.slice('/media/'.length).split('/').map(decodeURIComponent))
      const to = join(dir, file)
      if (!existsSync(from)) continue
      if (existsSync(to)) { logger.warn(`Left ${from} in place: ${to} already exists`); continue }
      mkdirSync(dir, { recursive: true })
      renameSync(from, to)
      removeIfEmpty(dirname(from))
      const next = mediaUrlForPath(to) + (query ? `?${query}` : '')
      db.prepare(`UPDATE game_platforms SET ${column} = ? WHERE library_id = ? AND name = ?`).run(next, row.library_id, row.name)
      moved++
      touched.set(system, row)
    }
  }
  for (const [system, row] of touched) {
    writeSystemJson(system, db.prepare('SELECT * FROM game_platforms WHERE library_id = ? AND name = ?').get(row.library_id, row.name) as any)
  }
  return moved
}
