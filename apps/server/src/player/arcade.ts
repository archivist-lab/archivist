import { Router } from 'express'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createLogger } from '@archivist/core'
import { getMediaRoot } from '../shared/media-organizer.js'
import { romMetadataFor, romScrapeStatus, scheduleRomScrape } from './rom-metadata.js'

const logger = createLogger('Arcade')

/**
 * Retro arcade (hidden behind the Konami code). ROMs are user-supplied and live
 * in media/roms/<system>/ — the app never ships copyrighted ROMs. Emulation runs
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
]

export const romsRoot = () => join(getMediaRoot(), 'roms')

/** The /media URL of a path under the ROM root, one encoded segment at a time. */
export const romsUrl = (...segments: string[]) => `/media/roms/${segments.map(encodeURIComponent).join('/')}`

/**
 * The emulator system a file belongs to, by extension, or null.
 *
 * Extension is all that is available: the Arcade scans `media/roms/<system>/`
 * and has no link to the games table, so a library row cannot be resolved to a
 * specific ROM. This is enough to say "this is emulatable" and send the viewer
 * to the Arcade, and deliberately not enough to claim it will boot that exact file.
 */
export function arcadeSystemForFile(filePath: string | null | undefined): { id: string; label: string; core: string } | null {
  if (!filePath) return null
  const ext = extname(filePath).toLowerCase()
  if (!ext) return null
  const system = SYSTEMS.find(candidate => candidate.exts.includes(ext))
  return system ? { id: system.id, label: system.label, core: system.core } : null
}

export interface ScannedRom { name: string; file: string; url: string; size: number; /** Absolute path on disk; never sent to clients. */ path: string }
export interface ScannedSystem {
  def: SystemDef
  /** The folders on disk this system's ROMs were read from, relative to the ROM root; the first is where scraped art is kept. */
  folders: string[]
  roms: ScannedRom[]
  biosUrl?: string
  scanError?: string
}

/** Every system with the ROMs found for it under media/roms. Shared by the shelf and the ROM scraper. */
export function scanArcade(): ScannedSystem[] {
  const base = romsRoot()
  // Folder names as they are on disk, matched without case or separators:
  // `Mega Drive`, `megadrive` and `MegaDrive` are one folder.
  const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
  let present: string[] = []
  try { present = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { /* scanned per system below */ }

  return SYSTEMS.map(sys => {
    const names = new Set([sys.id, ...(sys.aliases ?? [])].map(squash))
    const folders = present.filter(name => names.has(squash(name)))
    // Create the system's own folder so the user can see where to drop ROMs.
    if (!folders.length) {
      try { mkdirSync(join(base, sys.id), { recursive: true }); folders.push(sys.id) } catch { folders.push(sys.id) }
    }

    const roms: ScannedRom[] = []
    const seen = new Set<string>()
    let biosUrl: string | undefined
    // Why a folder could not be read, when it could not. A folder the
    // server's user may not open used to read as an empty one.
    let scanError: string | undefined

    for (const folder of folders) {
      // A set often keeps its games in a `roms` folder beside `bios`; both
      // the folder itself and that one are read.
      for (const sub of [null, 'roms']) {
        const segments = sub ? [folder, sub] : [folder]
        const dir = join(base, ...segments)
        if (sub && !existsSync(dir)) continue
        try {
          for (const f of readdirSync(dir)) {
            if (!sys.exts.includes(extname(f).toLowerCase()) || seen.has(f.toLowerCase())) continue
            seen.add(f.toLowerCase())
            let size = 0
            try { size = statSync(join(dir, f)).size } catch { /* ignore */ }
            roms.push({ name: f.replace(/\.[^.]+$/, ''), file: f, url: romsUrl(...segments, f), size, path: join(dir, f) })
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          scanError ??= code === 'EACCES' || code === 'EPERM'
            ? `The server cannot read media/roms/${segments.join('/')}: its folder permissions do not let the server's user open it`
            : `The server could not read media/roms/${segments.join('/')}: ${err instanceof Error ? err.message : String(err)}`
          logger.warn(`Failed to scan ${dir}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Optional BIOS: the first file in the first <folder>/bios/ found.
      if (!biosUrl) {
        const biosDir = join(base, folder, 'bios')
        try {
          const biosFile = existsSync(biosDir) ? readdirSync(biosDir).find(f => !f.startsWith('.')) : undefined
          if (biosFile) biosUrl = romsUrl(folder, 'bios', biosFile)
        } catch { /* no BIOS */ }
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
          folder: `media/roms/${folders[0]}`, biosUrl, biosReady: !sys.bios || !!biosUrl,
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
