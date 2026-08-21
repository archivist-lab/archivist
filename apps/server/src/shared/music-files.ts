import { basename, dirname, extname } from 'node:path'

/**
 * Deriving track metadata from audio filenames.
 *
 * A tracklist normally arrives from MusicBrainz when the artist is added, but
 * it does not always: rate limits, a release the lookup missed, or an album
 * added before its tracks were published all leave an album with none. The
 * import then has nothing to match files against and fails, even though the
 * audio is sitting right there. Deriving tracks from the files themselves makes
 * the import file-driven, which is the behaviour people expect.
 */

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.ape', '.wv', '.wma', '.aiff', '.aif'])

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase())
}

export interface DerivedTrack {
  /** Track number as written — vinyl sides such as "A1" are kept verbatim. */
  trackNumber: string
  discNumber: number
  title: string
  path: string
}

/** "CD2", "Disc 3", "Disk 02" in any path segment. */
function discFromPath(path: string): number {
  const parent = basename(dirname(path))
  const found = /\b(?:cd|disc|disk)\s*[-_]?\s*(\d{1,2})\b/i.exec(parent)
  return found ? Number(found[1]) : 1
}

/**
 * Splits a filename into its track number and title.
 *
 * Handles the common shapes: "01 - Title", "01. Title", "01_Title", "A1 - Title"
 * for vinyl, and "Artist - 01 - Title". A file with no leading number keeps its
 * whole stem as the title and takes its position in the listing as the number.
 */
export function parseTrackFilename(path: string, fallbackIndex: number): DerivedTrack {
  const stem = basename(path, extname(path)).trim()

  // Vinyl side first: "A1", "B12" only count when followed by a separator, so a
  // title beginning with a letter and digit is not mistaken for a side.
  const vinyl = /^([A-H]\d{1,2})\s*[-._)\]]\s*(.+)$/i.exec(stem)
  if (vinyl) {
    return { trackNumber: vinyl[1].toUpperCase(), discNumber: discFromPath(path), title: vinyl[2].trim(), path }
  }

  const numbered = /^(\d{1,3})\s*[-._)\]]\s*(.+)$/.exec(stem)
  if (numbered) {
    return { trackNumber: String(Number(numbered[1])), discNumber: discFromPath(path), title: numbered[2].trim(), path }
  }

  // "Artist - 03 - Title": take the number nearest the title.
  const embedded = /^.*?[-–]\s*(\d{1,3})\s*[-–]\s*(.+)$/.exec(stem)
  if (embedded) {
    return { trackNumber: String(Number(embedded[1])), discNumber: discFromPath(path), title: embedded[2].trim(), path }
  }

  return { trackNumber: String(fallbackIndex + 1), discNumber: discFromPath(path), title: stem, path }
}

/** Derives an ordered tracklist from a set of audio files. */
export function deriveTracksFromFiles(paths: string[]): DerivedTrack[] {
  const audio = paths.filter(isAudioFile).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return audio.map((path, index) => parseTrackFilename(path, index))
}
