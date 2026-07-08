import { Router } from 'express'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { createLogger } from '@archivist/core'
import { getMediaRoot } from '../shared/media-organizer.js'

const logger = createLogger('Arcade')

/**
 * Retro arcade (hidden behind the Konami code). ROMs are user-supplied and live
 * in media/roms/<system>/ — the app never ships copyrighted ROMs. Emulation runs
 * client-side via self-hosted EmulatorJS cores; this router just lists what's on
 * disk. ROM bytes are served by the existing range-capable /media static mount.
 */
interface SystemDef {
  id: string
  label: string
  core: string        // EmulatorJS EJS_core value
  exts: string[]
  bios?: boolean      // needs a user-supplied BIOS (PSX/Saturn)
  disc?: boolean      // disc-based; prefer single-file .chd
}

const SYSTEMS: SystemDef[] = [
  { id: 'nes',          label: 'NES',                 core: 'nes',        exts: ['.nes', '.fds'] },
  { id: 'snes',         label: 'SNES',                core: 'snes',       exts: ['.sfc', '.smc'] },
  { id: 'gameboy',      label: 'Game Boy',            core: 'gb',         exts: ['.gb', '.gbc'] },
  { id: 'mastersystem', label: 'Master System',       core: 'segaMS',     exts: ['.sms'] },
  { id: 'genesis',      label: 'Genesis / Mega Drive', core: 'segaMD',    exts: ['.md', '.gen', '.smd', '.bin'] },
  { id: 'n64',          label: 'Nintendo 64',         core: 'n64',        exts: ['.n64', '.z64', '.v64'] },
  { id: 'psx',          label: 'PlayStation',         core: 'psx',        exts: ['.chd', '.pbp', '.cue'], bios: true, disc: true },
  { id: 'saturn',       label: 'Saturn',              core: 'segaSaturn', exts: ['.chd', '.cue'], bios: true, disc: true },
]

const romsRoot = () => join(getMediaRoot(), 'roms')

export function createArcadeRouter(): Router {
  const router = Router()

  router.get('/library', (_req, res) => {
    try {
      const base = romsRoot()
      const systems = SYSTEMS.map(sys => {
        const dir = join(base, sys.id)
        // Create the folder so the user can see where to drop ROMs.
        try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }

        let roms: Array<{ name: string; file: string; url: string; size: number }> = []
        let biosUrl: string | undefined
        try {
          const entries = readdirSync(dir)
          roms = entries
            .filter(f => sys.exts.includes(extname(f).toLowerCase()))
            .map(f => {
              let size = 0
              try { size = statSync(join(dir, f)).size } catch { /* ignore */ }
              return { name: f.replace(/\.[^.]+$/, ''), file: f, url: `/media/roms/${sys.id}/${encodeURIComponent(f)}`, size }
            })
            .sort((a, b) => a.name.localeCompare(b.name))

          // Optional BIOS: first file in media/roms/<system>/bios/
          const biosDir = join(dir, 'bios')
          if (existsSync(biosDir)) {
            const biosFile = readdirSync(biosDir).find(f => !f.startsWith('.'))
            if (biosFile) biosUrl = `/media/roms/${sys.id}/bios/${encodeURIComponent(biosFile)}`
          }
        } catch (err) {
          logger.warn(`Failed to scan ${dir}: ${err instanceof Error ? err.message : String(err)}`)
        }

        return { id: sys.id, label: sys.label, core: sys.core, bios: !!sys.bios, disc: !!sys.disc, folder: `media/roms/${sys.id}`, biosUrl, biosReady: !sys.bios || !!biosUrl, roms }
      })

      res.json({ systems })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  return router
}
