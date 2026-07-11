/**
 * Series search cascade — turns a series + its missing structure into an ordered
 * broad → narrow list of search targets:
 *
 *   Level A  multi-season range packs   S01-S06, S01-S05, … S01-S02
 *   Level B  season packs               S01, S02, …
 *   Level C  individual episodes        S01E01, …
 *
 * Range packs are enumerated with a fixed start (the lowest in-scope season) and
 * a shrinking end, so the broadest "complete series" pack is tried first. Callers
 * cycle quality tiers within each target and decide when to stop (missing-search
 * stops once every missing episode is covered; the manual UI streams results).
 */

export type SeriesTargetKind = 'range' | 'season' | 'episode'

export interface SeriesTarget {
  kind: SeriesTargetKind
  /** Seasons a matching release would cover (a range pack covers its whole span). */
  seasons: number[]
  /** Present only for episode-level targets. */
  episode?: { season: number; episode: number }
  /** Query base including the season/episode token, e.g. "The Sopranos S01-S06". */
  base: string
}

export const padSeason = (n: number): string => `S${String(n).padStart(2, '0')}`
export const padEpisode = (n: number): string => `E${String(n).padStart(2, '0')}`

export function buildSeriesTargets(
  title: string,
  opts: {
    /** Seasons in scope (missing seasons for missing-search; all seasons for a manual browse). */
    seasons: number[]
    /** Missing episodes per season — required to emit episode-level targets. */
    episodesBySeason?: Map<number, number[]>
    /** Which levels to emit (defaults: all). */
    levels?: { range?: boolean; season?: boolean; episode?: boolean }
  },
): SeriesTarget[] {
  const levels = { range: true, season: true, episode: true, ...(opts.levels ?? {}) }
  const seasons = [...new Set(opts.seasons)].filter(s => s > 0).sort((a, b) => a - b)
  const targets: SeriesTarget[] = []
  if (seasons.length === 0) return targets

  const lo = seasons[0]
  const hi = seasons[seasons.length - 1]

  // Level A — multi-season range packs: fixed start `lo`, shrink the end hi → lo+1.
  if (levels.range && hi > lo) {
    for (let end = hi; end >= lo + 1; end--) {
      const covered: number[] = []
      for (let s = lo; s <= end; s++) covered.push(s)
      targets.push({ kind: 'range', seasons: covered, base: `${title} ${padSeason(lo)}-${padSeason(end)}` })
    }
  }

  // Level B — season packs (one per in-scope season).
  if (levels.season) {
    for (const s of seasons) targets.push({ kind: 'season', seasons: [s], base: `${title} ${padSeason(s)}` })
  }

  // Level C — individual episodes.
  if (levels.episode && opts.episodesBySeason) {
    for (const s of seasons) {
      const eps = [...(opts.episodesBySeason.get(s) ?? [])].sort((a, b) => a - b)
      for (const e of eps) {
        targets.push({
          kind: 'episode',
          seasons: [s],
          episode: { season: s, episode: e },
          base: `${title} ${padSeason(s)}${padEpisode(e)}`,
        })
      }
    }
  }

  return targets
}
