/**
 * Whether a file name names a given episode, however the pack spells it.
 *
 * Packs are named by people, not a standard: `S01E01`, `S01 E01`, `S01.E01`,
 * `S1E1`, `S01E01E02` for a double episode, `1x01`, `Season 1 Episode 1`. The
 * import plan and the organiser used to look for the literal `s01e01` alone, so
 * a pack spelling it with a space — Spider-Man: The Animated Series, as
 * `Spider-Man T.A.S - S01 E01 - Night of the Lizard.mp4` — matched no file at
 * all, and the import was blocked before it could start.
 *
 * Numbers are bounded on both sides, so episode 1 never matches `E10` and
 * season 1 never matches `S10`.
 */
export function namesEpisode(fileName: string, season: number, episode: number): boolean {
  const name = fileName.toLowerCase()
  return episodePatterns(season, episode).some(pattern => pattern.test(name))
}

function episodePatterns(season: number, episode: number): RegExp[] {
  const s = Math.trunc(season)
  const e = Math.trunc(episode)
  return [
    // S01E01, S01 E01, S01.E01, S1E1, and any episode of S01E01E02 / S01E01-E02.
    new RegExp(`(?<![a-z0-9])s0*${s}[ ._-]*(?:e0*\\d+[ ._-]*-?[ ._-]*)*?e0*${e}(?!\\d)`),
    // 1x01
    new RegExp(`(?<![a-z0-9])0*${s}x0*${e}(?!\\d)`),
    // Season 1 Episode 1
    new RegExp(`season[ ._-]*0*${s}[ ._-]*episode[ ._-]*0*${e}(?!\\d)`),
  ]
}

/**
 * How a pack numbers its episodes. Most name them by season, `S02E05`. Some —
 * Dragon Ball Z Kai, most anime — number them through the whole run, so `101`
 * is the 101st episode, not a season 1 episode. And some split a show
 * differently from the library: a Dragon Ball Super pack cut into five seasons
 * against a library that has it as one.
 *
 * `absolute` reads the one episode number a file carries — its `E` number, or
 * a bare number — as a place in the series' whole run, counted across its
 * seasons in order with specials left out. `start` is where the pack's episode
 * 1 falls in that run: a pack whose `S03E01` is the 47th episode reads with
 * `start: 47`, and a truly absolute pack with `start: 1`.
 */
export type EpisodeNumbering = { mode: 'season' } | { mode: 'absolute'; start: number }

/** An episode as a file is matched against it: its code, and its place in the run when that is known. */
export interface EpisodeRef { season: number; episode: number; absolute?: number | null }

/** A stored or posted numbering, or null for the default — by season — or anything unreadable. */
export function readEpisodeNumbering(value: unknown): EpisodeNumbering | null {
  let raw = value
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return null } }
  if (!raw || typeof raw !== 'object') return null
  const { mode, start } = raw as { mode?: unknown; start?: unknown }
  if (mode !== 'absolute') return null
  const first = Math.trunc(Number(start ?? 1))
  return { mode: 'absolute', start: Number.isFinite(first) && first >= 1 ? first : 1 }
}

/**
 * The episode number a file names, ignoring any season: the `E` of `S03E05`
 * or `3x05`, `Episode 5` / `Ep05`, or the bare number of an anime-style
 * `Show - 047 (1080p) [ABCD1234].mkv`. The series title is left out first, so
 * a title with a number in it is not read as the episode. Resolutions, codecs,
 * years, audio channels and bracketed tags are never episode numbers.
 */
export function fileEpisodeNumber(fileName: string, seriesTitle?: string | null): number | null {
  let name = fileName.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '')
  const coded = name.match(/(?<![a-z0-9])s\d{1,2}[ ._-]*e(\d{1,4})(?!\d)/) ?? name.match(/(?<![a-z0-9])\d{1,2}x(\d{1,4})(?!\d)/)
  if (coded) return Number(coded[1])
  const spelled = name.match(/(?<![a-z0-9])(?:episode|ep|e)[ ._-]*(\d{1,4})(?!\d)/)
  if (spelled) return Number(spelled[1])

  const titleWords = (seriesTitle ?? '').toLowerCase().match(/[a-z0-9]+/g)
  if (titleWords?.length) name = name.replace(new RegExp(titleWords.join('[^a-z0-9]+')), ' ')
  name = name
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/(?<![a-z0-9])(?:\d{3,4}p|[xh][ .]?26[45]|\d{1,2}bit|(?:19|20)\d{2})(?![a-z0-9])/g, ' ')
    .replace(/\d\.\d/g, ' ')
  const bare = name.match(/(?<![a-z0-9])(\d{1,4})(?:v\d)?(?![a-z0-9])/)
  return bare ? Number(bare[1]) : null
}

/** Whether a file is a given episode, read the way the pack numbers them. */
export function episodeFileMatcher(numbering: EpisodeNumbering | null | undefined, seriesTitle?: string | null): (fileName: string, episode: EpisodeRef) => boolean {
  if (numbering?.mode !== 'absolute') return (fileName, episode) => namesEpisode(fileName, episode.season, episode.episode)
  const shift = numbering.start - 1
  return (fileName, episode) => {
    if (episode.absolute == null) return false
    const number = fileEpisodeNumber(fileName, seriesTitle)
    return number != null && number + shift === episode.absolute
  }
}
