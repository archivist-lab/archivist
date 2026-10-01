import type { Router } from 'express'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import type { UnifiedDb } from '@archivist/db'
import { resolveLibraryRoot } from '../../shared/library-paths.js'
import { cachedImageSweep, imageCandidatePage, saveEntityImage, type ImageCandidate } from '../../shared/image-save.js'
import { launchBoxPlatformDetails, launchBoxPlatformFanart } from '../../player/launchbox.js'
import { launchBoxPlatformFor } from './launchbox-games.js'
import { consolePlatformRow, consoleSystemDir, importSystemJson, systemForPlatform, writeSystemJson } from './rom-library.js'

const logger = createLogger('GamePlatforms')

/**
 * A games platform's own page: the picture on its tile, a clear logo, a
 * background, and a description.
 *
 * A platform is the name the library's games carry — "Super Nintendo (SNES)"
 * — so what is chosen for it is kept by library and name in `game_platforms`.
 * Until something is chosen, LaunchBox's platform list supplies the details.
 * Pictures are offered from the console's Wikipedia article (its photographs
 * and logo) and, for a background, from the fanart of the platform's games.
 *
 * A platform the arcade scans keeps its pictures and a system.json in its
 * console folder (media/consoles/<system>/system/); any other platform keeps
 * its pictures in the library's _platforms folder.
 */

/** The image slots, the column each is kept in, and the file it is saved as. */
const SLOTS: Record<string, { column: string; file: string }> = {
  image: { column: 'image_url', file: 'image.jpg' },
  logo: { column: 'logo_url', file: 'logo.png' },
  background: { column: 'backdrop_url', file: 'background.jpg' },
}

/** Wikipedia's article for each LaunchBox platform whose article is not simply its name. */
const WIKIPEDIA: Record<string, string> = {
  'Nintendo Game Boy': 'Game Boy', 'Nintendo Game Boy Color': 'Game Boy Color', 'Nintendo Game Boy Advance': 'Game Boy Advance',
  'Sega Master System': 'Master System', 'Sony Playstation': 'PlayStation (console)', 'Sega Dreamcast': 'Dreamcast',
  'Sega Game Gear': 'Game Gear', 'Sony Playstation 2': 'PlayStation 2', 'Sony Playstation 3': 'PlayStation 3',
  'Sony Playstation 4': 'PlayStation 4', 'Sony Playstation 5': 'PlayStation 5', 'Sony PSP': 'PlayStation Portable',
  'Sony Playstation Vita': 'PlayStation Vita', 'Microsoft Xbox': 'Xbox (console)', 'Microsoft Xbox 360': 'Xbox 360',
  'Microsoft Xbox One': 'Xbox One', 'Microsoft Xbox Series X/S': 'Xbox Series X and Series S', 'Nintendo Wii': 'Wii',
  'Nintendo Wii U': 'Wii U', 'Windows': 'Microsoft Windows',
  'Nintendo GameCube': 'GameCube',
}

const wikipediaBase = () => process.env.ARCHIVIST_WIKIPEDIA_URL ?? 'https://en.wikipedia.org'

/** The images of a platform's Wikipedia article: its logos, and its other pictures (mostly the console). */
async function wikipediaImages(article: string): Promise<{ logos: string[]; pictures: string[] }> {
  const res = await fetch(`${wikipediaBase()}/api/rest_v1/page/media-list/${encodeURIComponent(article.replace(/ /g, '_'))}`, {
    headers: { 'User-Agent': 'Archivist/2.0 (self-hosted media server)' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Wikipedia answered ${res.status} for ${article}`)
  const body = await res.json() as { items?: Array<{ type?: string; title?: string; srcset?: Array<{ src: string }> }> }
  const logos: string[] = []
  const pictures: string[] = []
  for (const item of body.items ?? []) {
    if (item.type !== 'image' || !item.srcset?.length || !item.title) continue
    const src = item.srcset[item.srcset.length - 1].src
    const url = src.startsWith('//') ? `https:${src}` : src
    // Rating badges and icons are not a platform's picture.
    if (/rating|esrb|pegi|icon|symbol|vrc_/i.test(item.title)) continue
    if (/logo|wordmark/i.test(item.title)) logos.push(url)
    else if (/\.(jpe?g|png)$/i.test(item.title)) pictures.push(url)
  }
  return { logos, pictures }
}

const safeFolder = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'platform'

export function registerPlatformRoutes(router: Router, db: UnifiedDb, libId: (req: any) => number): void {
  const saved = (libraryId: number, name: string) => {
    const system = systemForPlatform(name)
    // A hand edit of the console's system.json is taken in before it is shown.
    if (system) importSystemJson(libraryId, system)
    const row = db.prepare('SELECT * FROM game_platforms WHERE library_id = ? AND name = ?').get(libraryId, name) as any
    return system ? consolePlatformRow(system, row) : row
  }
  /** Keep a console's system.json in step with what was just chosen for it. */
  const syncSystemJson = (libraryId: number, name: string) => {
    const system = systemForPlatform(name)
    if (system) writeSystemJson(system, db.prepare('SELECT * FROM game_platforms WHERE library_id = ? AND name = ?').get(libraryId, name) as any)
  }

  /** A platform as the library shows it: what was chosen, over what LaunchBox says. */
  const platformOf = (libraryId: number, name: string) => {
    const row = saved(libraryId, name) ?? {}
    const launchBoxName = launchBoxPlatformFor(name)
    const known = launchBoxName ? launchBoxPlatformDetails(launchBoxName) : null
    return {
      name,
      launchboxPlatform: launchBoxName ?? null,
      image_url: row.image_url ?? null,
      logo_url: row.logo_url ?? null,
      backdrop_url: row.backdrop_url ?? null,
      overview: row.overview ?? known?.overview ?? null,
      manufacturer: row.manufacturer ?? known?.manufacturer ?? null,
      developer: row.developer ?? known?.developer ?? null,
      release_year: row.release_year ?? known?.releaseYear ?? null,
      media: row.media ?? known?.media ?? null,
      cpu: row.cpu ?? known?.cpu ?? null,
    }
  }

  const ensureRow = (libraryId: number, name: string) =>
    db.prepare('INSERT OR IGNORE INTO game_platforms (library_id, name) VALUES (?, ?)').run(libraryId, name)

  // Every platform the library's games are on, with what is known of each.
  router.get('/games/platforms', (req, res) => {
    try {
      const names = new Set<string>()
      for (const row of db.prepare('SELECT platforms FROM games WHERE library_id = ?').all(libId(req)) as Array<{ platforms: string }>) {
        try { for (const name of JSON.parse(row.platforms || '[]')) names.add(String(name)) } catch { /* no platforms */ }
      }
      for (const row of db.prepare('SELECT name FROM game_platforms WHERE library_id = ?').all(libId(req)) as Array<{ name: string }>) names.add(row.name)
      res.json([...names].sort().map(name => platformOf(libId(req), name)))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/games/platforms/:name', (req, res) => {
    res.json(platformOf(libId(req), req.params.name))
  })

  router.put('/games/platforms/:name/metadata', (req, res) => {
    try {
      const { overview, manufacturer, developer, release_year, media, cpu } = req.body ?? {}
      ensureRow(libId(req), req.params.name)
      // An emptied field goes back to what LaunchBox says, so null clears it.
      db.prepare(`
        UPDATE game_platforms SET overview = @overview, manufacturer = @manufacturer, developer = @developer,
          release_year = @release_year, media = @media, cpu = @cpu, updated_at = datetime('now')
        WHERE library_id = @library_id AND name = @name
      `).run({
        library_id: libId(req), name: req.params.name,
        overview: overview ?? null, manufacturer: manufacturer ?? null, developer: developer ?? null,
        release_year: Number.isFinite(Number(release_year)) && release_year !== null && release_year !== '' ? Number(release_year) : null,
        media: media ?? null, cpu: cpu ?? null,
      })
      syncSystemJson(libId(req), req.params.name)
      res.json(platformOf(libId(req), req.params.name))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/games/platforms/:name/images', async (req, res) => {
    try {
      const wanted = String(req.query.type ?? 'image')
      if (!SLOTS[wanted]) return res.status(400).json({ error: `Unknown image type: ${wanted}` })
      const name = req.params.name
      const launchBoxName = launchBoxPlatformFor(name)
      const sweep = await cachedImageSweep<ImageCandidate>(`game-platform:${libId(req)}:${name}:${wanted}`, async () => {
        const items: ImageCandidate[] = []
        const warnings: string[] = []
        const article = launchBoxName ? WIKIPEDIA[launchBoxName] ?? launchBoxName : name
        try {
          const { logos, pictures } = await wikipediaImages(article)
          const urls = wanted === 'logo' ? logos : pictures
          for (const url of urls) items.push({ url, source: 'Wikipedia', type: wanted, language: 'null' })
        } catch (err) {
          warnings.push(`Wikipedia: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (wanted === 'background' && launchBoxName) {
          for (const url of launchBoxPlatformFanart(launchBoxName)) items.push({ url, source: 'LaunchBox', type: wanted, language: 'null' })
        }
        if (!items.length) warnings.push(`No ${wanted} found for ${name} — paste a URL instead`)
        return { items, warnings }
      })
      res.json(imageCandidatePage(sweep.items, req.query, sweep.warnings))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/games/platforms/:name/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url?: string; type?: string }
      const slot = type ? SLOTS[type] : undefined
      if (!url || !slot) return res.status(400).json({ error: 'url and type (image, logo or background) required' })
      const system = systemForPlatform(req.params.name)
      const folder = system ? consoleSystemDir(system) : join(resolveLibraryRoot(db, libId(req)), '_platforms', safeFolder(req.params.name))
      const stored = await saveEntityImage(folder, slot.file, url)
      ensureRow(libId(req), req.params.name)
      db.prepare(`UPDATE game_platforms SET ${slot.column} = ?, updated_at = datetime('now') WHERE library_id = ? AND name = ?`)
        .run(stored.path, libId(req), req.params.name)
      syncSystemJson(libId(req), req.params.name)
      res.json({ success: true, path: stored.path })
    } catch (err) {
      logger.warn(`Could not save platform artwork: ${err instanceof Error ? err.message : String(err)}`)
      res.status(400).json({ error: String(err) })
    }
  })
}
