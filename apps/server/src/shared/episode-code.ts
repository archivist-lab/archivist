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
