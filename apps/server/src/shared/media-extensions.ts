import { extname } from 'node:path'

/**
 * Single source of truth for "which files are media".
 *
 * These sets used to be redeclared in seven places across the monitor, the
 * import planner, the library scanner and the organiser — and they had drifted:
 * `.mov` existed only in the import planner, so a .mov episode passed the import
 * plan and then failed in `organizeEpisode` with "Could not find file for SxxEyy".
 * The screenshot-import bug was the same shape: one module's idea of a media file
 * disagreeing with the next module's.
 *
 * Add a container here and every stage agrees.
 */

/** Playable video containers. */
export const VIDEO_EXTS: ReadonlySet<string> = new Set([
  '.mkv', '.mp4', '.avi', '.ts', '.m4v', '.mov',
])

export const AUDIO_EXTS: ReadonlySet<string> = new Set([
  '.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg',
])

export const BOOK_EXTS: ReadonlySet<string> = new Set([
  '.epub', '.mobi', '.azw3', '.pdf', '.m4b', '.mp3', '.flac',
])

export const COMIC_EXTS: ReadonlySet<string> = new Set(['.cbz', '.cbr', '.pdf'])

/** Subtitle sidecars — wanted alongside media, never the media itself. */
export const SUBTITLE_EXTS: ReadonlySet<string> = new Set([
  '.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt',
])

/**
 * Scene extras that are never the imported asset. No supported media type is a
 * loose image (comics arrive as .cbz/.cbr/.pdf), so extension alone is a safe test.
 */
export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff',
])

export const METADATA_EXTS: ReadonlySet<string> = new Set([
  '.nfo', '.sfv', '.txt', '.md5', '.url', '.lnk', '.diz',
])

/** Lowercased extension with any in-progress `.part` suffix stripped. */
export function mediaExtname(name: string): string {
  return extname(name.replace(/\.part$/i, '')).toLowerCase()
}

/**
 * True for a playable video. `allowPartial` accepts a still-downloading
 * `<name>.mkv.part`, which the organiser and monitor need but the library
 * scanner deliberately does not.
 */
export function isVideoFile(name: string, allowPartial = false): boolean {
  if (!allowPartial && /\.part$/i.test(name)) return false
  return VIDEO_EXTS.has(mediaExtname(name))
}

/** Scene sample clips — excluded from every selection path. */
export function isSampleFile(name: string): boolean {
  return name.toLowerCase().includes('sample')
}
