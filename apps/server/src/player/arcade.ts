import { Router } from 'express'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { createLogger } from '@archivist/core'
import { getMediaRoot } from '../shared/media-organizer.js'
import { romMetadataFor, romScrapeStatus, scheduleRomScrape } from './rom-metadata.js'
import { platformArtFor } from '../modules/games/rom-library.js'
import { migrateRomsToConsoles } from './consoles-migration.js'

const logger = createLogger('Arcade')

/**
 * Retro arcade (hidden behind the Konami code). ROMs are user-supplied and live
 * in media/consoles/<system>/roms/ — the app never ships copyrighted ROMs. Emulation runs
 * client-side via self-hosted EmulatorJS cores; this router just lists what's on
 * disk. ROM bytes are served by the existing range-capable /media static mount.
 *
 * Mounted under the player router (/api/v1/player/arcade), so it is reachable
 * only from the Player frontend on its own port — the admin API exposes no
 * arcade surface at all.
 */
export interface SystemDef {
  id: string
  label: string
  core: string        // EmulatorJS EJS_core value
  exts: string[]
  /**
   * Other names the system's folder goes by. ROM sets and frontends name them
   * differently — a Mega Drive collection is usually in `megadrive`, not
   * `genesis` — and a folder under its other name used to be ignored outright.
   */
  aliases?: string[]
  bios?: boolean      // needs a user-supplied BIOS (PSX/Saturn)
  disc?: boolean      // disc-based; prefer single-file .chd
  /**
   * False for a system kept for the library only: its games are scanned,
   * scraped and listed in the Games library, but nothing here can emulate
   * them — no browser core, and more than a TV's processor can run.
   */
  /** 'tv': the TV app has a core for it (PSP), the browser does not. */
  playable?: boolean | 'tv'
}

const SYSTEMS: SystemDef[] = [
  { id: 'nes',          label: 'NES',                 core: 'nes',        exts: ['.nes', '.fds'], aliases: ['famicom', 'nintendo'] },
  { id: 'snes',         label: 'SNES',                core: 'snes',       exts: ['.sfc', '.smc'], aliases: ['superfamicom', 'supernintendo', 'sfc'] },
  { id: 'gameboy',      label: 'Game Boy',            core: 'gb',         exts: ['.gb', '.gbc'], aliases: ['gb', 'gbc', 'gameboycolor'] },
  { id: 'mastersystem', label: 'Master System',       core: 'segaMS',     exts: ['.sms'], aliases: ['sms', 'segamastersystem'] },
  { id: 'genesis',      label: 'Genesis / Mega Drive', core: 'segaMD',    exts: ['.md', '.gen', '.smd', '.bin'], aliases: ['megadrive', 'md', 'segagenesis', 'segamegadrive'] },
  { id: 'n64',          label: 'Nintendo 64',         core: 'n64',        exts: ['.n64', '.z64', '.v64'], aliases: ['nintendo64'] },
  { id: 'psx',          label: 'PlayStation',         core: 'psx',        exts: ['.chd', '.pbp', '.cue'], bios: true, disc: true, aliases: ['ps1', 'playstation', 'psone'] },
  { id: 'saturn',       label: 'Saturn',              core: 'segaSaturn', exts: ['.chd', '.cue'], bios: true, disc: true, aliases: ['segasaturn'] },
  { id: 'dreamcast',    label: 'Dreamcast',           core: '',           exts: ['.chd', '.gdi', '.cdi', '.cue'], disc: true, playable: false, aliases: ['dc', 'segadreamcast'] },
  { id: 'gamecube',     label: 'GameCube',            core: '',           exts: ['.iso', '.gcm', '.rvz', '.gcz', '.ciso'], disc: true, playable: false, aliases: ['gc', 'ngc', 'nintendogamecube'] },
  { id: 'ps2',          label: 'PlayStation 2',       core: '',           exts: ['.chd', '.iso', '.cso', '.cue'], disc: true, playable: false, aliases: ['playstation2', 'sonyplaystation2'] },
  { id: 'psp',          label: 'PSP',                 core: 'psp',        exts: ['.iso', '.cso', '.chd', '.pbp'], disc: true, playable: 'tv', aliases: ['playstationportable', 'sonypsp'] },
]

/**
 * Each console keeps everything of its own in one folder:
 *   media/consoles/<system>/roms/    the games (a disc game may sit in a folder of its own)
 *   media/consoles/<system>/bios/    the BIOS, for systems that need one
 *   media/consoles/<system>/media/   box art, fanart and logos the scraper saved
 *   media/consoles/<system>/system/  the console's own pictures and system.json
 */
export const consolesRoot = () => join(getMediaRoot(), 'consoles')

/** Folder names as they are on disk, matched without case or separators: `Mega Drive`, `megadrive` and `MegaDrive` are one. */
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The system a console folder is for, by its id or one of its other names. */
export function systemForFolder(name: string): SystemDef | undefined {
  const key = squash(name)
  return SYSTEMS.find(sys => [sys.id, ...(sys.aliases ?? [])].some(alias => squash(alias) === key))
}

/** The folders under media/consoles that are this system's, the first being where its art is kept. */
function consoleFolders(sys: SystemDef, present: string[]): string[] {
  return present.filter(name => systemForFolder(name) === sys)
}

/** The folder a system's own files go in: the one already on disk, else one named for it. */
export function consoleFolderFor(systemId: string): string {
  const sys = SYSTEMS.find(candidate => candidate.id === systemId)
  let present: string[] = []
  try { present = readdirSync(consolesRoot(), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { /* none yet */ }
  return (sys && consoleFolders(sys, present)[0]) ?? systemId
}

/** File names that say nothing of the game, used by sets that keep each disc in a folder named for it. */
const GENERIC_DISC_NAME = /^(disc|disk|game|image|default|rom|track\s*0*1)$/i

/** A console's media/ folder, for the ROM at `romPath`; a path outside media/consoles keeps its own folder. */
export function consoleMediaDirFor(romPath: string): string {
  const inside = relative(consolesRoot(), romPath)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return join(dirname(romPath), 'media')
  return join(consolesRoot(), inside.split(sep)[0], 'media')
}

/** The /media URL of a path under media/consoles, one encoded segment at a time. */
export const consolesUrl = (...segments: string[]) => `/media/consoles/${segments.map(encodeURIComponent).join('/')}`

/**
 * The emulator system a file belongs to, by extension, or null.
 *
 * Extension is all that is available: the Arcade scans `media/consoles/<system>/roms/`
 * and has no link to the games table, so a library row cannot be resolved to a
 * specific ROM. This is enough to say "this is emulatable" and send the viewer
 * to the Arcade, and deliberately not enough to claim it will boot that exact file.
 */
export function arcadeSystemForFile(filePath: string | null | undefined): { id: string; label: string; core: string } | null {
  if (!filePath) return null
  const ext = extname(filePath).toLowerCase()
  if (!ext) return null
  // Only a system the arcade can play: a GameCube .iso is a game, but not one to send there.
  const system = SYSTEMS.find(candidate => (candidate.playable ?? true) === true && candidate.exts.includes(ext))
  return system ? { id: system.id, label: system.label, core: system.core } : null
}

export interface ScannedRom { name: string; file: string; url: string; size: number; /** Absolute path on disk; never sent to clients. */ path: string }
export interface ScannedSystem {
  def: SystemDef
  /** This system's folders under media/consoles; the first is where scraped art is kept. */
  folders: string[]
  roms: ScannedRom[]
  biosUrl?: string
  scanError?: string
}

/** Every system with the ROMs found for it under media/consoles. Shared by the shelf and the ROM scraper. */
export function scanArcade(): ScannedSystem[] {
  migrateRomsToConsoles()
  const base = consolesRoot()
  let present: string[] = []
  try { present = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { /* scanned per system below */ }

  return SYSTEMS.map(sys => {
    const folders = consoleFolders(sys, present)
    // Create the system's own folder so the user can see where to drop ROMs.
    if (!folders.length) {
      try { mkdirSync(join(base, sys.id, 'roms'), { recursive: true }) } catch { /* reported when scanned */ }
      folders.push(sys.id)
    }

    const roms: ScannedRom[] = []
    const seen = new Set<string>()
    let biosUrl: string | undefined
    // Why a folder could not be read, when it could not. A folder the
    // server's user may not open used to read as an empty one.
    let scanError: string | undefined

    for (const folder of folders) {
      // Games sit in roms/, and a disc game may have a folder of its own
      // there (`Shenmue/Shenmue.gdi` beside its tracks): both are read.
      let gameFolders: string[] = []
      try {
        gameFolders = readdirSync(join(base, folder, 'roms'), { withFileTypes: true })
          .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
          .map(entry => entry.name)
      } catch { /* reported below, when the folder itself is read */ }
      for (const sub of [null, ...gameFolders]) {
        const segments = sub ? [folder, 'roms', sub] : [folder, 'roms']
        const dir = join(base, ...segments)
        if (!sub && !existsSync(dir)) continue
        try {
          for (const f of readdirSync(dir)) {
            const ext = extname(f)
            if (!sys.exts.includes(ext.toLowerCase())) continue
            // A disc file with a generic name (`disc.gdi`) is its game folder's:
            // named after the folder, so two games' `disc.gdi` stay two games.
            const generic = sub && GENERIC_DISC_NAME.test(f.slice(0, -ext.length))
            const file = generic ? `${sub}${ext}` : f
            if (seen.has(file.toLowerCase())) continue
            seen.add(file.toLowerCase())
            let size = 0
            try { size = statSync(join(dir, f)).size } catch { /* ignore */ }
            roms.push({ name: file.replace(/\.[^.]+$/, ''), file, url: consolesUrl(...segments, f), size, path: join(dir, f) })
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          scanError ??= code === 'EACCES' || code === 'EPERM'
            ? `The server cannot read media/consoles/${segments.join('/')}: its folder permissions do not let the server's user open it`
            : `The server could not read media/consoles/${segments.join('/')}: ${err instanceof Error ? err.message : String(err)}`
          logger.warn(`Failed to scan ${dir}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Optional BIOS: the first file in the first <folder>/bios/ found.
      if (!biosUrl) {
        const biosDir = join(base, folder, 'bios')
        try {
          const biosFile = existsSync(biosDir) ? readdirSync(biosDir).find(f => !f.startsWith('.')) : undefined
          if (biosFile) biosUrl = consolesUrl(folder, 'bios', biosFile)
        } catch (err) {
          // A BIOS folder the server cannot open read as no BIOS at all, so a
          // Saturn BIOS copied in as root showed "BIOS needed" with the file
          // plainly there. Say why instead.
          const code = (err as NodeJS.ErrnoException)?.code
          scanError ??= code === 'EACCES' || code === 'EPERM'
            ? `The server cannot read media/consoles/${folder}/bios: its folder permissions do not let the server's user open it`
            : `The server could not read media/consoles/${folder}/bios: ${err instanceof Error ? err.message : String(err)}`
          logger.warn(`Failed to read BIOS folder ${biosDir}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    roms.sort((a, b) => a.name.localeCompare(b.name))
    return { def: sys, folders, roms, biosUrl, scanError }
  })
}

export function createArcadeRouter(): Router {
  const router = Router()

  router.get('/library', (_req, res) => {
    try {
      const scanned = scanArcade()
      // New files are looked up in the background; the shelf answers now with
      // whatever is already known, and fills in on the next visit.
      scheduleRomScrape(scanned)
      const systems = scanned.map(({ def: sys, folders, roms, biosUrl, scanError }) => {
        const meta = romMetadataFor(sys.id, folders, roms)
        return {
          id: sys.id, label: sys.label, core: sys.core, bios: !!sys.bios, disc: !!sys.disc,
          folder: `media/consoles/${folders[0]}/roms`, biosUrl, biosReady: !sys.bios || !!biosUrl,
          // Playable in the browser, and on the TV — which has a core the browser lacks.
          playable: (sys.playable ?? true) === true,
          tvPlayable: sys.playable !== false,
          platform: platformArtFor(sys.id),
          roms: roms.map(({ path: _path, ...rom }) => ({ ...rom, ...(meta.get(rom.file.toLowerCase()) ?? {}) })),
          ...(scanError ? { scanError } : {}),
        }
      })
      res.json({ systems, scrape: romScrapeStatus() })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  return router
}
