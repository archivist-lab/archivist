import { mkdirSync, writeFileSync, renameSync, copyFileSync, unlinkSync, rmdirSync, statSync, readdirSync, existsSync, readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { join, dirname, extname, basename, relative } from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ffprobeStatic = require('ffprobe-static')
const ffmpegStatic = require('ffmpeg-static')

import axios from 'axios'
import { createLogger } from '@archivist/core'
import type { Database } from 'better-sqlite3'
import { type TmdbMovie } from '../domains/films/tmdb.js'
import { type SeriesEntity, type SeriesSeason, type SeriesEpisode } from '../domains/series/tvdb.js'
import { type MbArtist, type MbAlbum } from '../domains/music/musicbrainz.js'
import { getDb } from '../db.js'
import { type IgdbGame } from '../domains/games/igdb.js'
import { type AuthorResult, type BookResult } from '../domains/books/google-books.js'
import { type CvSeries, type CvIssue } from '../domains/comics/comicvine.js'

const logger = createLogger('Organizer')

export interface FileInfo {
  path: string
  size: number
  filename: string
  extension: string
  resolution?: string
  codec?: string
  audio?: Array<{ language: string, channels: number, title?: string }>
  audioChannels?: string // e.g. "5.1", "7.1" (max channels found)
  subtitles?: string[] // Languages (embedded in container)
  externalSubtitles?: string[] // Languages (external .srt/.ass/.sub files)
  chapters?: Array<{ number: number, title: string, start: string }>
  tracks?: Array<{ type: string, language?: string, title?: string, codec?: string }>
}

const MEDIA_ROOT = process.env.ARCHIVIST_MEDIA_BASE ?? join(process.cwd(), 'media')

export function getMediaRoot() {
  return MEDIA_ROOT
}

/**
 * Robustly move a file — falls back to copy+delete when source and destination
 * are on different filesystems (EXDEV: cross-device link not permitted).
 */
function robustRenameFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      logger.info(`Cross-device move detected — copying then deleting: ${src} → ${dest}`)
      copyFileSync(src, dest)
      unlinkSync(src)
    } else {
      throw err
    }
  }
}

/**
 * Robustly move an entire directory tree — falls back to recursive copy+delete
 * when source and destination are on different filesystems.
 */
function robustRenameDir(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      logger.info(`Cross-device dir move detected — recursive copy: ${src} → ${dest}`)
      mkdirSync(dest, { recursive: true })
      copyDirRecursive(src, dest)
      removeDirRecursive(src)
    } else {
      throw err
    }
  }
}

function copyDirRecursive(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true })
      copyDirRecursive(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

function removeDirRecursive(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) removeDirRecursive(p)
    else unlinkSync(p)
  }
  try { rmdirSync(dir) } catch {}
}

export function mapRemotePath(inputPath: string | null | undefined): string {
  if (!inputPath) return ''
  const mapStr = process.env.REMOTE_PATH_MAP
  if (!mapStr) return inputPath

  // Format: "remote:local,remote2:local2"
  const mappings = mapStr.split(',').map(m => m.split(':'))
  for (const [remote, local] of mappings) {
    if (inputPath.startsWith(remote)) {
      const mapped = inputPath.replace(remote, local)
      logger.debug(`Mapped remote path "${inputPath}" to local path "${mapped}"`)
      return mapped
    }
  }
  return inputPath
}

// ── Films ───────────────────────────────────────────────────────────────────

export async function ensureFilmFolder(film: TmdbMovie, baseDir: string = join(MEDIA_ROOT, 'films')): Promise<{ targetDir: string, posterPath?: string, backdropPath?: string, logoPath?: string }> {
  const filmFolder = `${film.title} (${film.year})`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, filmFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)
  
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // Download Assets immediately
  logger.info(`Ensuring assets for "${film.title}" in ${targetDir}`)
  
  let localPoster = undefined
  let localBackdrop = undefined
  let localLogo = undefined

  if (film.posterPath) {
    const filename = 'poster.jpg'
    try { 
      await downloadAsset(film.posterPath, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download poster for "${film.title}"`) }
  }
  if (film.backdropPath) {
    const filename = 'backdrop.jpg'
    try { 
      await downloadAsset(film.backdropPath, join(targetDir, filename))
      localBackdrop = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download backdrop for "${film.title}"`) }
  }
  if (film.logoPath) {
    const filename = 'logo.png'
    try { 
      await downloadAsset(film.logoPath, join(targetDir, filename))
      localLogo = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download logo for "${film.title}"`) }
  }
  if (film.bannerPath) {
    try { await downloadAsset(film.bannerPath, join(targetDir, 'banner.jpg')) }
    catch (e) { logger.warn(`Failed to download banner for "${film.title}"`) }
  }

  return { targetDir, posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo }
}

function findAllVideoFilesRecursive(dir: string): { path: string, size: number, name: string }[] {
  const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v', '.part'])
  let results: { path: string, size: number, name: string }[] = []
  
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        results = results.concat(findAllVideoFilesRecursive(fullPath))
      } else if (entry.isFile() && (VIDEO_EXTS.has(extname(entry.name).toLowerCase()) || entry.name.toLowerCase().endsWith('.part'))) {
        // Skip "sample" files
        if (entry.name.toLowerCase().includes('sample')) continue
        results.push({ path: fullPath, size: statSync(fullPath).size, name: entry.name })
      }
    }
  } catch (e) {
    logger.warn(`Error scanning directory ${dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return results
}

export async function organizeFilm(film: TmdbMovie, sourcePath: string, version?: string | null, editionName: string = 'Theatrical', baseDir?: string): Promise<string> {
  const localSourcePath = mapRemotePath(sourcePath)

  if (!existsSync(localSourcePath)) {
    throw new Error(`Source path does not exist locally: ${localSourcePath} (mapped from ${sourcePath})`)
  }

  const { targetDir } = await ensureFilmFolder(film, baseDir)

  // Find all video files recursively
  let videoFiles: { path: string, size: number, name: string }[] = []
  
  if (statSync(localSourcePath).isDirectory()) {
    videoFiles = findAllVideoFilesRecursive(localSourcePath)
  } else {
    const VIDEO_EXTS = ['.mkv', '.mp4', '.avi', '.ts', '.m4v']
    const name = basename(localSourcePath)
    if (VIDEO_EXTS.includes(extname(localSourcePath).toLowerCase()) && !name.toLowerCase().includes('sample')) {
      videoFiles.push({ path: localSourcePath, size: statSync(localSourcePath).size, name })
    }
  }

  if (videoFiles.length === 0) {
    throw new Error(`No video files found in download: ${localSourcePath}`)
  }

  // Largest file is the movie
  videoFiles.sort((a, b) => b.size - a.size)
  const mainFile = videoFiles[0]
  
  // Potential trailers are other files with "trailer" or "trailers" in the name (case-insensitive)
  const trailerFile = videoFiles.slice(1).find(f => {
    const lowName = f.name.toLowerCase()
    return lowName.includes('trailer') || lowName.includes('trailers')
  })

  // Identify "Extras" (others, not including samples)
  const extraFiles = videoFiles.slice(1).filter(f => {
    if (trailerFile && f.path === trailerFile.path) return false
    const lowName = f.name.toLowerCase()
    return !lowName.includes('sample')
  })

  // Move Main Movie
  let extension = extname(mainFile.path)
  if (extension.toLowerCase() === '.part') {
    const realName = basename(mainFile.path, '.part')
    extension = extname(realName)
  }

  // Handle versions and editions in naming
  let editionSuffix = ''
  if (editionName && editionName.toLowerCase() !== 'theatrical') {
    editionSuffix = ` - ${editionName}`
  }

  const finalFileName = `${film.title} (${film.year})${editionSuffix}${extension}`.replace(/[:*?"<>|]/g, '')
  const finalPath = join(targetDir, finalFileName)

  // Generate edition NFO
  const nfoFileName = `${film.title} (${film.year})${editionSuffix}.nfo`.replace(/[:*?"<>|]/g, '')
  const nfoPath = join(targetDir, nfoFileName)
  generateFilmNfo(film, nfoPath, editionName)

  logger.info(`Moving movie ${mainFile.name} to ${finalPath}`)
  robustRenameFile(mainFile.path, finalPath)

  // Move Trailer if found
  if (trailerFile) {
    let trailerExt = extname(trailerFile.path)
    if (trailerExt.toLowerCase() === '.part') {
      const realName = basename(trailerFile.path, '.part')
      trailerExt = extname(realName)
    }
    const finalTrailerPath = join(targetDir, `trailer${trailerExt}`)
    logger.info(`Detected trailer ${trailerFile.name}, moving to ${finalTrailerPath}`)
    try {
      robustRenameFile(trailerFile.path, finalTrailerPath)
    } catch (e) {
      logger.warn(`Failed to move trailer: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Move Extras if found
  if (extraFiles.length > 0) {
    const extrasDir = join(targetDir, 'extras')
    if (!existsSync(extrasDir)) mkdirSync(extrasDir, { recursive: true })
    
    for (const extra of extraFiles) {
      let extraExt = extname(extra.path)
      let extraName = extra.name
      if (extraExt.toLowerCase() === '.part') {
        extraName = basename(extra.name, '.part')
      }
      
      const extraPath = join(extrasDir, extraName)
      logger.info(`Moving extra ${extra.name} to ${extraPath}`)
      try {
        robustRenameFile(extra.path, extraPath)
      } catch (e) {
        logger.warn(`Failed to move extra ${extra.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return finalPath
}


// ── Music ────────────────────────────────────────────────────────────────────

export async function organizeMusic(albumId: number, sourcePath: string, dbOverride?: Database, baseDir: string = join(MEDIA_ROOT, 'music')): Promise<string> {
  const db = dbOverride ?? getDb()
  const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(albumId) as any
  if (!album) throw new Error('Album not found in database')
  const artist = db.prepare("SELECT * FROM artists WHERE id = ?").get(album.artist_id) as any
  if (!artist) throw new Error('Artist not found in database')

  const localSourcePath = mapRemotePath(sourcePath)
  if (!existsSync(localSourcePath)) throw new Error(`Source not found: ${localSourcePath}`)

  const at = album.album_type
  let typeDir = 'Albums'
  if (at === 'Single') typeDir = 'Singles'
  else if (at === 'EP') typeDir = 'EPs'
  else if (at === 'Live') typeDir = 'Live Albums'

  const albumFolder = `${album.year ? `(${album.year}) ` : ''}${album.title}`.replace(/[:*?"<>|]/g, '').trim()
  const targetDir = join(baseDir, artist.name.replace(/[:*?"<>|]/g, '').trim(), typeDir, albumFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })

  const stats = statSync(localSourcePath)
  const files = stats.isDirectory() 
    ? readdirSync(localSourcePath).map(f => join(localSourcePath, f))
    : [localSourcePath]

  const audioFiles = files.filter(f => ['.mp3', '.flac', '.m4a', '.wav'].includes(extname(f).toLowerCase()))
  const tracks = db.prepare("SELECT * FROM tracks WHERE album_id = ?").all(albumId) as any[]

  for (const track of tracks) {
    const match = audioFiles.find(f => {
      const base = basename(f).toLowerCase()
      return base.includes(track.title.toLowerCase()) || 
             base.includes(`${String(track.track_number).padStart(2, '0')}`)
    })

    if (match) {
      const extension = extname(match)
      const finalFileName = `${String(track.track_number).padStart(2, '0')} - ${track.title}${extension}`.replace(/[:*?"<>|]/g, '')
      const finalPath = join(targetDir, finalFileName)
      
      logger.info(`Moving track to ${finalPath}`)
      robustRenameFile(match, finalPath)

      db.prepare("UPDATE tracks SET status = 'collected', file_path = ? WHERE id = ?").run(finalPath, track.id)
    }
  }

  db.prepare("UPDATE albums SET status = 'collected', download_progress = 1, updated_at = datetime('now') WHERE id = ?").run(albumId)
  return targetDir
}

export async function ensureArtistFolder(artist: MbArtist, baseDir: string = join(MEDIA_ROOT, 'music')): Promise<{ targetDir: string, imageUrl?: string, backdropUrl?: string, logoUrl?: string }> {
  const artistFolder = artist.name.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, artistFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localImage = undefined
  let localBackdrop = undefined
  let localLogo = undefined

  if (artist.imageUrl) {
    const filename = 'folder.jpg'
    try {
      await downloadAsset(artist.imageUrl, join(targetDir, filename))
      localImage = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download image for artist "${artist.name}"`) }
  }

  if (artist.backdropUrl) {
    const filename = 'backdrop.jpg'
    try {
      await downloadAsset(artist.backdropUrl, join(targetDir, filename))
      localBackdrop = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download backdrop for artist "${artist.name}"`) }
  }

  if (artist.logoUrl) {
    const filename = 'logo.png'
    try {
      await downloadAsset(artist.logoUrl, join(targetDir, filename))
      localLogo = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download logo for artist "${artist.name}"`) }
  }

  // Generate Artist NFO
  const nfoPath = join(targetDir, 'artist.nfo')
  generateArtistNfo(artist, nfoPath)

  return { targetDir, imageUrl: localImage, backdropUrl: localBackdrop, logoUrl: localLogo }
}

export async function ensureAlbumFolder(artist: MbArtist, album: MbAlbum, baseDir: string = join(MEDIA_ROOT, 'music')): Promise<{ targetDir: string, coverUrl?: string, cdartUrl?: string }> {
  const { targetDir: artistDir } = await ensureArtistFolder(artist, baseDir)
  
  // Categorize folder by type: "Studio Albums", "Live Albums", etc.
  let typeDir = 'Studio Albums'
  const at = album.albumType || 'Album'
  if (at === 'Compilation') typeDir = 'Compilations'
  else if (at === 'Live') typeDir = 'Live Albums'
  else if (at === 'EP') typeDir = 'EPs'
  else if (at === 'Single') typeDir = 'Singles'

  const folderName = `${album.year ? `(${album.year}) ` : ''}${album.title}`.replace(/[:*?"<>|]/g, '').trim()
  const targetDir = join(baseDir, artist.name.replace(/[:*?"<>|]/g, '').trim(), typeDir, folderName)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localCover = undefined
  let localCdArt = undefined

  if (album.coverUrl) {
    const filename = 'cover.jpg'
    try {
      await downloadAsset(album.coverUrl, join(targetDir, filename))
      localCover = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download cover for album "${album.title}"`) }
  }

  if (album.cdartUrl) {
    const filename = 'cdart.png'
    try {
      await downloadAsset(album.cdartUrl, join(targetDir, filename))
      localCdArt = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download CD art for album "${album.title}"`) }
  }

  // Generate Album NFO
  const nfoPath = join(targetDir, 'album.nfo')
  generateAlbumNfo(artist, album, nfoPath)

  return { targetDir, coverUrl: localCover, cdartUrl: localCdArt }
}

function generateArtistNfo(artist: MbArtist, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<artist>
  <name>${artist.name}</name>
  <sortname>${artist.sortName || ''}</sortname>
  <disambiguation>${artist.disambiguation || ''}</disambiguation>
  <biography>${artist.overview || ''}</biography>
  <genre>${(artist.genres || []).join(' / ')}</genre>
  <musicbrainzartistid>${artist.id}</musicbrainzartistid>
</artist>`
  writeFileSync(targetPath, nfo)
}

function generateAlbumNfo(artist: MbArtist, album: MbAlbum, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<album>
  <title>${album.title}</title>
  <artist>${artist.name}</artist>
  <releasedate>${album.releaseDate || ''}</releasedate>
  <year>${album.year || ''}</year>
  <type>${album.albumType}</type>
  <genre>${(album.genres || []).join(' / ')}</genre>
  <musicbrainzreleasegroupid>${album.id}</musicbrainzreleasegroupid>
</album>`
  writeFileSync(targetPath, nfo)
}

// ── TV Shows ─────────────────────────────────────────────────────────────────

function findVideoFileRecursive(dir: string, predicate: (name: string) => boolean): string | undefined {
  const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v', '.part'])
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = findVideoFileRecursive(join(dir, entry.name), predicate)
        if (found) return found
      } else if ((VIDEO_EXTS.has(extname(entry.name).toLowerCase()) || entry.name.toLowerCase().endsWith('.part')) && predicate(entry.name)) {
        // Skip "sample" files
        if (entry.name.toLowerCase().includes('sample')) continue
        return join(dir, entry.name)
      }
    }
  } catch { /* permission errors etc. */ }
  return undefined
}

export async function organizeEpisode(
  series: { title: string, year?: number },
  episode: { seasonNumber: number, episodeNumber: number, title?: string },
  sourcePath: string,
  options?: { copy?: boolean; baseDir?: string }
): Promise<string> {
  const localSourcePath = mapRemotePath(sourcePath)
  if (!existsSync(localSourcePath)) throw new Error(`Source not found: ${localSourcePath}`)

  const seriesFolder = `${series.title} (${series.year})`.replace(/[:*?"<>|]/g, '')
  const seasonFolder = `Season ${String(episode.seasonNumber).padStart(2, '0')}`
  const targetDir = join(options?.baseDir ?? join(MEDIA_ROOT, 'series'), seriesFolder, seasonFolder)
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })

  const sxxexx = `s${String(episode.seasonNumber).padStart(2, '0')}e${String(episode.episodeNumber).padStart(2, '0')}`
  const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v'])

  let epFile = localSourcePath
  if (statSync(localSourcePath).isDirectory()) {
    // Search recursively — handles flat packs and nested Season XX/ subdirs
    let found = findVideoFileRecursive(localSourcePath, n => n.toLowerCase().includes(sxxexx))
    if (!found) found = findVideoFileRecursive(localSourcePath, n => {
      const low = n.toLowerCase()
      return low.includes(`episode ${episode.episodeNumber}`) || low.includes(` ${episode.episodeNumber} `)
    })
    if (!found) {
      // Last resort: single video in the whole tree
      const all: string[] = []
      const collect = (d: string) => { 
        try { 
          for (const e of readdirSync(d, { withFileTypes: true })) { 
            if (e.isDirectory()) collect(join(d, e.name)); 
            else if (VIDEO_EXTS.has(extname(e.name).toLowerCase()) && !e.name.toLowerCase().includes('sample')) all.push(join(d, e.name)) 
          } 
        } catch {} 
      }
      collect(localSourcePath)
      if (all.length === 1) found = all[0]
    }
    if (!found) throw new Error(`Could not find file for S${episode.seasonNumber}E${episode.episodeNumber} in ${localSourcePath}`)
    epFile = found
  }

  let extension = extname(epFile)
  if (extension.toLowerCase() === '.part') {
    const realName = basename(epFile, '.part')
    extension = extname(realName)
  }
  const epTitle = (episode.title || `Episode ${episode.episodeNumber}`).replace(/[:*?"<>|]/g, '')
  const finalFileName = `${series.title} - S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} - ${epTitle}${extension}`.replace(/[:*?"<>|]/g, '')
  const finalPath = join(targetDir, finalFileName)

  if (options?.copy) {
    logger.info(`Copying episode to ${finalPath}`)
    copyFileSync(epFile, finalPath)
  } else {
    logger.info(`Moving episode to ${finalPath}`)
    robustRenameFile(epFile, finalPath)
  }
  return finalPath
}

export async function ensureSeriesFolder(series: SeriesEntity, baseDir: string = join(MEDIA_ROOT, 'series')): Promise<{ targetDir: string, posterPath?: string, backdropPath?: string, logoPath?: string }> {
  const seriesFolder = `${series.title} (${series.year})`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, seriesFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)
  
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  logger.info(`Ensuring assets for "${series.title}" in ${targetDir}`)
  
  let localPoster = undefined
  let localBackdrop = undefined
  let localLogo = undefined

  if (series.posterPath) {
    const filename = 'poster.png'
    try { 
      await downloadAsset(series.posterPath, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download poster for "${series.title}"`) }
  }
  if (series.backdropPath) {
    const filename = 'backdrop.png'
    try { 
      await downloadAsset(series.backdropPath, join(targetDir, filename))
      localBackdrop = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download backdrop for "${series.title}"`) }
  }
  if (series.logoPath) {
    const filename = 'logo.png'
    try { 
      await downloadAsset(series.logoPath, join(targetDir, filename))
      localLogo = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download logo for "${series.title}"`) }
  }

  // Generate NFO
  const nfoPath = join(targetDir, 'tvshow.nfo')
  generateSeriesNfo(series, nfoPath)

  return { targetDir, posterPath: localPoster, backdropPath: localBackdrop, logoPath: localLogo }
}

export async function ensureSeasonFolder(series: SeriesEntity, season: SeriesSeason, baseDir: string = join(MEDIA_ROOT, 'series')): Promise<{ targetDir: string, posterPath?: string }> {
  const { targetDir: seriesDir } = await ensureSeriesFolder(series, baseDir)
  const seasonFolder = `Season ${String(season.seasonNumber).padStart(2, '0')}`
  const targetDir = join(seriesDir, seasonFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localPoster = undefined
  if (season.posterPath) {
    const filename = 'folder.jpg'
    try { 
      await downloadAsset(season.posterPath, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download season poster for S${season.seasonNumber}`) }
  }

  // Generate Season NFO
  const nfoPath = join(targetDir, 'season.nfo')
  generateSeasonNfo(series, season, nfoPath)

  return { targetDir, posterPath: localPoster }
}

export async function ensureEpisodeThumbnail(series: SeriesEntity, season: SeriesSeason, episode: SeriesEpisode, baseDir: string = join(MEDIA_ROOT, 'series')): Promise<string | undefined> {
  if (!episode.stillPath) return undefined

  const seasonFolder = `Season ${String(season.seasonNumber).padStart(2, '0')}`
  const targetDir = join(baseDir, `${series.title} (${series.year})`.replace(/[:*?"<>|]/g, ''), seasonFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)
  
  const extension = extname(episode.stillPath.split('?')[0]) || '.png'
  // Naming: "Show Name SXXEXX-backdrop.png"
  const filename = `${series.title} S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}-backdrop${extension}`.replace(/[:*?"<>|]/g, '')
  const targetPath = join(targetDir, filename)

  try {
    await downloadAsset(episode.stillPath, targetPath)
    return `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
  } catch (e) {
    logger.warn(`Failed to download episode thumbnail for S${episode.seasonNumber}E${episode.episodeNumber}`)
    return undefined
  }
}

export function generateSeasonNfo(series: SeriesEntity, season: SeriesSeason, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<season>
  <title>${season.title || `Season ${season.seasonNumber}`}</title>
  <seasonnumber>${season.seasonNumber}</seasonnumber>
  <plot>${season.overview || ''}</plot>
</season>`
  writeFileSync(targetPath, nfo)
}

export function generateEpisodeNfo(series: SeriesEntity, episode: SeriesEpisode, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<episodedetails>
  <title>${episode.title}</title>
  <showtitle>${series.title}</showtitle>
  <season>${episode.seasonNumber}</season>
  <episode>${episode.episodeNumber}</episode>
  <plot>${episode.overview || ''}</plot>
  <aired>${episode.airDate || ''}</aired>
  <uniqueid type="tmdb">${episode.tvdbEpisodeId || ''}</uniqueid>
</episodedetails>`
  writeFileSync(targetPath, nfo)
}

function generateSeriesNfo(series: SeriesEntity, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
  <title>${series.title}</title>
  <originaltitle>${series.originalTitle || ''}</originaltitle>
  <year>${series.year || ''}</year>
  <plot>${series.overview || ''}</plot>
  <status>${series.status || ''}</status>
  <network>${series.network || ''}</network>
  <genre>${(series.genres || []).join(' / ')}</genre>
  <uniqueid type="tmdb" default="true">${series.tmdbId || ''}</uniqueid>
  <uniqueid type="tvdb">${series.tvdbId || ''}</uniqueid>
  <uniqueid type="imdb">${series.imdbId || ''}</uniqueid>
  ${(series.cast || []).map((c: any) => `
  <actor>
    <name>${c.name}</name>
    <role>${c.character}</role>
    <thumb>${c.profilePath || ''}</thumb>
  </actor>`).join('')}
</tvshow>`
  writeFileSync(targetPath, nfo)
}

// ── Games ───────────────────────────────────────────────────────────────────

export async function organizeGame(game: { title: string, year?: number }, sourcePath: string, baseDir: string = join(MEDIA_ROOT, 'games')): Promise<string> {
  const localSourcePath = mapRemotePath(sourcePath)
  if (!existsSync(localSourcePath)) throw new Error(`Source not found: ${localSourcePath}`)

  const gameFolder = `${game.title} (${game.year || 'TBA'})`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, gameFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })

  // For games, we usually move the entire folder or the installer file
  const stats = statSync(localSourcePath)
  let name = basename(localSourcePath)
  if (name.toLowerCase().endsWith('.part')) {
    name = basename(name, '.part')
  }
  const finalPath = join(targetDir, name)

  logger.info(`Moving game to ${finalPath}`)
  const gameStats = statSync(localSourcePath)
  if (gameStats.isDirectory()) {
    robustRenameDir(localSourcePath, finalPath)
  } else {
    robustRenameFile(localSourcePath, finalPath)
  }
  return finalPath
}

export async function ensureGameFolder(game: IgdbGame, baseDir: string = join(MEDIA_ROOT, 'games')): Promise<{ targetDir: string, posterPath?: string, backdropPath?: string }> {
  const gameFolder = `${game.title} (${game.year || 'TBA'})`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, gameFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)
  
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localPoster = undefined
  let localBackdrop = undefined

  if (game.coverUrl) {
    const filename = 'cover.jpg'
    try { 
      await downloadAsset(game.coverUrl, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download cover for game "${game.title}"`) }
  }
  if (game.screenshotUrl) {
    const filename = 'screenshot.jpg'
    try { 
      await downloadAsset(game.screenshotUrl, join(targetDir, filename))
      localBackdrop = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download screenshot for game "${game.title}"`) }
  }

  // Generate NFO
  const nfoPath = join(targetDir, 'game.nfo')
  generateGameNfo(game, nfoPath)

  return { targetDir, posterPath: localPoster, backdropPath: localBackdrop }
}

function generateGameNfo(game: IgdbGame, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<game>
  <title>${game.title}</title>
  <year>${game.year || ''}</year>
  <plot>${game.overview || ''}</plot>
  <genre>${(game.genres || []).join(' / ')}</genre>
  <platform>${(game.platforms || []).join(' / ')}</platform>
  <developer>${game.developer || ''}</developer>
  <publisher>${game.publisher || ''}</publisher>
  <rating>${game.rating || ''}</rating>
  <uniqueid type="igdb">${game.igdbId}</uniqueid>
</game>`
  writeFileSync(targetPath, nfo)
}

// ── Books ────────────────────────────────────────────────────────────────────

export async function ensureAuthorFolder(author: AuthorResult, baseDir: string = join(MEDIA_ROOT, 'books')): Promise<{ targetDir: string, imageUrl?: string }> {
  const authorFolder = author.name.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, authorFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localImage = undefined
  if (author.imageUrl) {
    const filename = 'folder.jpg'
    try {
      await downloadAsset(author.imageUrl, join(targetDir, filename))
      localImage = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download image for author "${author.name}"`) }
  }

  // Generate Author NFO
  const nfoPath = join(targetDir, 'author.nfo')
  generateAuthorNfo(author, nfoPath)

  return { targetDir, imageUrl: localImage }
}

export async function ensureBookFolder(author: AuthorResult, book: BookResult, baseDir: string = join(MEDIA_ROOT, 'books')): Promise<{ targetDir: string, posterPath?: string }> {
  const { targetDir: authorDir } = await ensureAuthorFolder(author, baseDir)
  const bookFolder = `${book.title} (${book.year || 'TBA'})`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(authorDir, bookFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localPoster = undefined
  if (book.coverUrl) {
    const filename = 'cover.jpg'
    try {
      await downloadAsset(book.coverUrl, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download cover for book "${book.title}"`) }
  }

  // Generate Book NFO
  const nfoPath = join(targetDir, 'book.nfo')
  generateBookNfo(author, book, nfoPath)

  return { targetDir, posterPath: localPoster }
}

function generateAuthorNfo(author: AuthorResult, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<author>
  <name>${author.name}</name>
  <biography>${author.overview || ''}</biography>
  <uniqueid type="openlibrary">${author.openLibraryId || ''}</uniqueid>
</author>`
  writeFileSync(targetPath, nfo)
}

function generateBookNfo(author: AuthorResult, book: BookResult, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<book>
  <title>${book.title}</title>
  <subtitle>${book.subtitle || ''}</subtitle>
  <author>${author.name}</author>
  <year>${book.year || ''}</year>
  <publisher>${book.publisher || ''}</publisher>
  <pagecount>${book.pageCount || ''}</pagecount>
  <plot>${book.overview || ''}</plot>
  <genre>${(book.genres || []).join(' / ')}</genre>
  <language>${book.language || ''}</language>
  <isbn13>${book.isbn13 || ''}</isbn13>
  <uniqueid type="googlebooks">${book.googleBooksId || ''}</uniqueid>
  <uniqueid type="openlibrary">${book.openLibraryId || ''}</uniqueid>
</book>`
  writeFileSync(targetPath, nfo)
}

// ── Comics ───────────────────────────────────────────────────────────────────

export async function organizeComicIssue(series: CvSeries, issue: CvIssue, sourcePath: string, baseDir: string = join(MEDIA_ROOT, 'comics')): Promise<string> {
  const localSourcePath = mapRemotePath(sourcePath)
  if (!existsSync(localSourcePath)) throw new Error(`Source not found: ${localSourcePath}`)

  const { targetDir } = await ensureComicIssueFolder(series, issue, baseDir)

  const stats = statSync(localSourcePath)
  let comicFile = localSourcePath
  if (stats.isDirectory()) {
    const files = readdirSync(localSourcePath)
    // Look for .cbz, .cbr, .pdf
    const comic = files.find(f => ['.cbz', '.cbr', '.pdf'].includes(extname(f).toLowerCase()))
    if (!comic) throw new Error(`No comic file found in ${localSourcePath}`)
    comicFile = join(localSourcePath, comic)
  }

    let extension = extname(comicFile)
    if (extension.toLowerCase() === '.part') {
    const realName = basename(comicFile, '.part')
    extension = extname(realName)
    }
    const finalFileName = `${series.name} - Issue ${issue.issueNumber}${extension}`.replace(/[:*?"<>|]/g, '')
  const finalPath = join(targetDir, finalFileName)

  logger.info(`Moving comic to ${finalPath}`)
  robustRenameFile(comicFile, finalPath)
  return finalPath
}

export async function ensureComicSeriesFolder(series: CvSeries, baseDir: string = join(MEDIA_ROOT, 'comics')): Promise<{ targetDir: string, posterPath?: string }> {
  const seriesFolder = `${series.name} (${series.startYear || 'TBA'})`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(baseDir, seriesFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localPoster = undefined
  if (series.coverUrl) {
    const filename = 'poster.jpg'
    try {
      await downloadAsset(series.coverUrl, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download poster for comic series "${series.name}"`) }
  }

  // Generate Series NFO
  const nfoPath = join(targetDir, 'series.nfo')
  generateComicSeriesNfo(series, nfoPath)

  return { targetDir, posterPath: localPoster }
}

export async function ensureComicIssueFolder(series: CvSeries, issue: CvIssue, baseDir: string = join(MEDIA_ROOT, 'comics')): Promise<{ targetDir: string, posterPath?: string }> {
  const { targetDir: seriesDir } = await ensureComicSeriesFolder(series, baseDir)
  const issueFolder = `Issue ${issue.issueNumber}`.replace(/[:*?"<>|]/g, '')
  const targetDir = join(seriesDir, issueFolder)
  const relativeDir = relative(MEDIA_ROOT, targetDir)

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  let localPoster = undefined
  if (issue.coverUrl) {
    const filename = 'cover.jpg'
    try {
      await downloadAsset(issue.coverUrl, join(targetDir, filename))
      localPoster = `/media/${relativeDir}/${filename}`.replace(/\\/g, '/')
    } catch (e) { logger.warn(`Failed to download cover for comic issue "${issue.issueNumber}"`) }
  }

  // Generate Issue NFO
  const nfoPath = join(targetDir, 'issue.nfo')
  generateComicIssueNfo(series, issue, nfoPath)

  return { targetDir, posterPath: localPoster }
}

function generateComicSeriesNfo(series: CvSeries, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<comic-series>
  <title>${series.name}</title>
  <year>${series.startYear || ''}</year>
  <publisher>${series.publisher || ''}</publisher>
  <plot>${series.overview || ''}</plot>
  <genre>${(series.genres || []).join(' / ')}</genre>
  <uniqueid type="comicvine">${series.id}</uniqueid>
</comic-series>`
  writeFileSync(targetPath, nfo)
}

function generateComicIssueNfo(series: CvSeries, issue: CvIssue, targetPath: string) {
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<comic-issue>
  <title>${issue.title || ''}</title>
  <series>${series.name}</series>
  <issue>${issue.issueNumber}</issue>
  <year>${issue.year || ''}</year>
  <coverdate>${issue.coverDate || ''}</coverdate>
  <plot>${issue.overview || ''}</plot>
  <uniqueid type="comicvine">${issue.id}</uniqueid>
</comic-issue>`
  writeFileSync(targetPath, nfo)
}

// ── Shared Helpers ───────────────────────────────────────────────────────────

async function downloadAsset(url: string, targetPath: string) {
  if (existsSync(targetPath)) {
    // Check for corrupted HTML files from previous runs
    try {
      const head = readFileSync(targetPath, { encoding: 'utf8', flag: 'r' }).slice(0, 50)
      if (head.includes('<!DOCTYPE') || head.includes('<html')) {
        logger.info(`Detected corrupted asset (HTML) at ${targetPath}, re-downloading...`)
      } else {
        return
      }
    } catch (e) {
      // If error reading, assume we should re-download
    }
  }
  
  // Normalize URLs (fix double slashes and handle Wikimedia Commons)
  let cleanUrl = url.replace(/([^:]\/)\/+/g, "$1")
  
  if (cleanUrl.includes('commons.wikimedia.org/wiki/File:')) {
    const parts = cleanUrl.split('File:')
    if (parts[1]) {
      const filename = parts[1].split('?')[0]
      cleanUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${filename}`
      logger.debug(`Resolved Wikimedia Commons URL to direct path: ${cleanUrl}`)
    }
  }

  try {
    logger.info(`Downloading asset: ${cleanUrl} -> ${targetPath}`)
    const res = await axios.get(cleanUrl, { 
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Archivist/2.0' }
    })

    const contentType = res.headers['content-type']
    if (contentType && !contentType.startsWith('image/')) {
      logger.warn(`Asset at ${cleanUrl} is not an image (Content-Type: ${contentType}). Skipping.`)
      return
    }

    writeFileSync(targetPath, res.data)
    logger.info(`Successfully saved: ${targetPath}`)
  } catch (err) {
    logger.error(`Failed to download asset ${cleanUrl}:`, err instanceof Error ? err.message : String(err))
    throw err
  }
}

function generateFilmNfo(film: TmdbMovie, targetPath: string, edition?: string) {
  const editionTag = edition && edition !== 'Theatrical' ? `\n  <edition>${edition}</edition>\n  <tag>${edition}</tag>` : ''
  const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${film.title}</title>
  <originaltitle>${film.originalTitle}</originaltitle>
  <year>${film.year}</year>
  <plot>${film.overview || ''}</plot>
  <runtime>${film.runtime || ''}</runtime>
  <thumb aspect="poster">${film.posterPath || ''}</thumb>
  <fanart>
    <thumb>${film.backdropPath || ''}</thumb>
  </fanart>
  <mpaa>${film.certification || ''}</mpaa>
  <uniqueid type="tmdb" default="true">${film.tmdbId}</uniqueid>
  <uniqueid type="imdb">${film.imdbId || ''}</uniqueid>
  <genre>${(film.genres || []).join(' / ')}</genre>${editionTag}
  <studio>${film.studio || ''}</studio>
  ${(film.cast || []).map(c => `
  <actor>
    <name>${c.name}</name>
    <role>${c.character}</role>
    <thumb>${c.profilePath || ''}</thumb>
  </actor>`).join('')}
</movie>`
  writeFileSync(targetPath, nfo)
}

export function getFilmFileInfo(filePath: string): FileInfo | null {
  if (!filePath || !existsSync(filePath)) return null
  try {
    const stats = statSync(filePath)
    const info: FileInfo = {
      path: filePath,
      size: stats.size,
      filename: basename(filePath),
      extension: extname(filePath).slice(1).toUpperCase()
    }

    // Try to get real info via ffprobe
    try {
      const ffprobe = spawnSync(ffprobeStatic.path, [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title',
        '-of', 'json',
        filePath
      ], { encoding: 'utf8' })

      if (ffprobe.status === 0) {
        const data = JSON.parse(ffprobe.stdout)
        const video = data.streams?.find((s: any) => s.width && s.height)
        if (video) {
          info.resolution = video.width >= 3840 ? '4K Ultra HD' : video.width >= 1920 ? '1080p Full HD' : video.width >= 1280 ? '720p HD' : 'SD'
          info.codec = video.codec_name.toUpperCase()
        }

        const audioStreams = data.streams?.filter((s: any) => s.codec_type === 'audio' || (!s.codec_type && s.codec_name && !s.width))
        const streams: Array<{ language: string, channels: number, title?: string }> = []
        let maxChannels = 0
        audioStreams?.forEach((s: any) => {
          const lang = s.tags?.language || 'und'
          const channels = s.channels || 0
          const title = s.tags?.title
          streams.push({ language: lang, channels, title })
          if (channels > maxChannels) maxChannels = channels
        })
        if (streams.length > 0) info.audio = streams
        
        if (maxChannels > 0) {
          const chMap: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }
          const chLabel = chMap[maxChannels] || `${maxChannels}ch`
          info.audioChannels = chLabel
        }

        // Detailed tracks
        info.tracks = data.streams?.map((s: any) => ({
          type: s.codec_type || (s.width ? 'video' : 'audio'),
          language: s.tags?.language,
          title: s.tags?.title,
          codec: s.codec_name
        }))

        // Subtitles — embedded streams (inclusive of common formats)
        const subLangs = new Set<string>()
        data.streams?.forEach((s: any) => {
          const lowCodec = (s.codec_name || '').toLowerCase()
          if (s.codec_type === 'subtitle' || lowCodec.includes('sub') || lowCodec.includes('pgs') || lowCodec === 'ass' || lowCodec === 'mov_text') {
            if (s.tags?.language) subLangs.add(s.tags.language)
          }
        })
        if (subLangs.size > 0) info.subtitles = Array.from(subLangs)
      }
    } catch (e) {
      // ffprobe failed or not installed, just use basic info
    }

    // Probe chapters separately (requires ffmpeg)
    try {
      const chapterProbe = spawnSync(ffmpegStatic, [
        '-i', filePath,
        '-f', 'ffmetadata',
        '-'
      ], { encoding: 'utf8' })

      const stdout = chapterProbe.stdout || ''
      const chapters: Array<{ number: number; title: string; start: string }> = []
      let currentChapter: any = null
      let timebaseNum = 1, timebaseDen = 1
      
      const lines = stdout.split(/\r?\n/)
      for (const line of lines) {
        if (line.trim() === '[CHAPTER]') {
          if (currentChapter) chapters.push(currentChapter)
          currentChapter = { number: chapters.length + 1, title: `Chapter ${chapters.length + 1}`, start: '0:00' }
        } else if (currentChapter) {
          const match = line.match(/^([^=]+)=(.*)$/)
          if (match) {
            const key = match[1].toUpperCase()
            const value = match[2]
            if (key === 'TIMEBASE') {
              const tbMatch = value.match(/^(\d+)\/(\d+)$/)
              if (tbMatch) {
                timebaseNum = Number.parseInt(tbMatch[1], 10) || 1
                timebaseDen = Number.parseInt(tbMatch[2], 10) || 1
              }
            } else if (key === 'START') {
              const startSecs = (Number.parseInt(value, 10) * timebaseNum) / timebaseDen
              const hours = Math.floor(startSecs / 3600)
              const mins = Math.floor((startSecs % 3600) / 60)
              const secs = Math.floor(startSecs % 60)
              currentChapter.start = hours > 0
                ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
                : `${mins}:${String(secs).padStart(2, '0')}`
            } else if (key === 'TITLE') {
              currentChapter.title = value
            }
          }
        }
      }
      if (currentChapter) chapters.push(currentChapter)
      
      if (chapters.length > 0) {
        info.chapters = chapters
      }
    } catch {
      // chapters not available
    }

    // Scan for external subtitle files (e.g. Movie.en.srt, Movie.eng.srt)
    try {
      const dir = dirname(filePath)
      const base = basename(filePath, extname(filePath))
      const subExts = ['.srt', '.ass', '.ssa', '.sub', '.vtt']
      const files = readdirSync(dir)
      const extSubs: string[] = []
      for (const f of files) {
        if (f.startsWith(base + '.') && subExts.some(ext => f.toLowerCase().endsWith(ext))) {
          // Extract language from filename: "Movie.en.srt" -> "en"
          const withoutExt = f.slice(0, f.lastIndexOf('.'))
          const langPart = withoutExt.slice(base.length + 1) // after "Movie."
          if (langPart) extSubs.push(langPart)
        }
      }
      if (extSubs.length > 0) info.externalSubtitles = extSubs
    } catch {
      // directory read failed
    }

    return info
  } catch {
    return null
  }
}
