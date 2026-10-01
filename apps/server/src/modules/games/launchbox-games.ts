import type { IgdbGame } from './igdb.js'
import { launchBoxGame, launchBoxImages, searchLaunchBox, LAUNCHBOX_PLATFORM_FOR_IGDB, type LaunchBoxGame } from '../../player/launchbox.js'
import { matchKey } from '../../player/game-names.js'

/**
 * LaunchBox for the Games library: search, a game's details and its artwork.
 *
 * IGDB finds little from before about 1995 and cannot tell a Mega Drive
 * release from its Master System namesake; LaunchBox lists each platform's
 * release as a game of its own, with a description, box art and a clear logo.
 * Both are offered: LaunchBox's results first, IGDB's after when it is set up.
 */

/** LaunchBox's platform names as the library's platform list spells them. */
const PLATFORM_NAMES: Record<string, string> = {
  'Windows': 'PC', 'Sony Playstation 5': 'PlayStation 5', 'Sony Playstation 4': 'PlayStation 4', 'Sony Playstation 3': 'PlayStation 3',
  'Sony Playstation 2': 'PlayStation 2', 'Sony Playstation': 'PlayStation 1', 'Sony Playstation Vita': 'PlayStation Vita', 'Sony PSP': 'PlayStation Portable',
  'Microsoft Xbox Series X/S': 'Xbox Series X|S', 'Microsoft Xbox One': 'Xbox One', 'Microsoft Xbox 360': 'Xbox 360',
  'Nintendo Wii U': 'Wii U', 'Nintendo Wii': 'Wii', 'Super Nintendo Entertainment System': 'Super Nintendo (SNES)',
  'Nintendo Entertainment System': 'Nintendo (NES)', 'Sega Genesis': 'Sega Mega Drive / Genesis', 'Nintendo Game Boy': 'Game Boy',
  'Nintendo Game Boy Color': 'Game Boy Color', 'Nintendo Game Boy Advance': 'Game Boy Advance',
}
export const platformName = (launchBoxPlatform: string) => PLATFORM_NAMES[launchBoxPlatform] ?? launchBoxPlatform

/** The LaunchBox platform a library platform name stands for; LaunchBox's own names stand for themselves. */
export function launchBoxPlatformFor(libraryName: string): string | undefined {
  if (libraryName === 'Steam' || libraryName === 'Windows PC') return 'Windows'
  const named = Object.entries(PLATFORM_NAMES).find(([, name]) => name === libraryName)?.[0]
  return named ?? (libraryName || undefined)
}

/** A search result, in the shape the Add Game page lists; `key` tells the two sources apart. */
export function lookupResult(game: LaunchBoxGame) {
  return {
    key: `launchbox:${game.databaseId}`,
    source: 'LaunchBox',
    launchboxId: game.databaseId,
    title: game.name,
    year: game.year,
    releaseDate: game.releaseDate,
    overview: game.overview,
    coverUrl: game.cover,
    image_url: game.cover,
    developer: game.developer,
    platforms: [platformName(game.platform)],
  }
}

export function searchLaunchBoxGames(query: string, igdbPlatformId?: number) {
  const platform = igdbPlatformId ? LAUNCHBOX_PLATFORM_FOR_IGDB[igdbPlatformId] : undefined
  // A platform the picker offers that LaunchBox does not know is searched unfiltered, not emptied.
  return searchLaunchBox(query, { platform, limit: 40 }).map(lookupResult)
}

/** A LaunchBox game in the shape the library's IGDB code takes, for the folder, the .nfo and the row. */
export function asLibraryGame(game: LaunchBoxGame): IgdbGame {
  return {
    igdbId: 0,
    title: game.name,
    year: game.year,
    releaseDate: game.releaseDate,
    overview: game.overview,
    genres: game.genre ? game.genre.split(/\s*,\s*/).filter(Boolean) : [],
    platforms: [platformName(game.platform)],
    coverUrl: game.cover,
    screenshotUrl: game.backdrop,
    rating: game.rating,
    developer: game.developer,
    publisher: game.publisher,
  }
}

export const libraryGameFor = (launchBoxId: number): (IgdbGame & { logoUrl?: string }) | null => {
  const game = launchBoxGame(launchBoxId)
  return game ? { ...asLibraryGame(game), logoUrl: game.logo } : null
}

/**
 * The LaunchBox game a library entry is: its own id when it has one, else a
 * game of exactly its title — which is how a game added from IGDB gets
 * LaunchBox's artwork offered too.
 */
export function launchBoxIdFor(row: { launchbox_id?: number | null; title: string; platforms?: string | null }): number | null {
  if (row.launchbox_id) return row.launchbox_id
  const key = matchKey(row.title)
  const platforms = (() => { try { return JSON.parse(row.platforms ?? '[]') as string[] } catch { return [] } })()
  const hits = searchLaunchBox(row.title, { limit: 20 }).filter(game => matchKey(game.name) === key)
  const onPlatform = hits.find(game => platforms.includes(platformName(game.platform)))
  return (onPlatform ?? hits[0])?.databaseId ?? null
}

/** Artwork candidates for the library's image picker: box art for a cover, fanart and screenshots otherwise. */
export function launchBoxArtwork(launchBoxId: number, wanted: string) {
  const types = wanted === 'cover' ? ['Box - Front']
    : wanted === 'logo' ? ['Clear Logo']
    : ['Fanart - Background', 'Screenshot - Gameplay', 'Screenshot - Game Title']
  return launchBoxImages(launchBoxId, types).map(image => ({
    url: image.url, source: 'LaunchBox', type: wanted, language: 'null',
  }))
}
