import type { Database } from 'better-sqlite3'
import type { FilterNode, ListMediaType } from '@archivist/contracts'
import { RATING_PROVIDERS, getArchivistRatingSettings, weightsFor, type ArchivistRatingSettings } from '../services/archivist-rating-settings.js'
import { UnsupportedListFilterError, type ListMember, type ListMemberResult } from './types.js'
import { getDb } from '../db.js'
import { resolveCandidateScores } from './candidate-scores.js'
import { libraryMean } from '../services/archivist-rating.js'

/**
 * The weighted Archivist Rating threshold on a List.
 *
 * Every other rule narrows at TMDB, which has never heard of this weighting.
 * This one is applied afterwards, against the score built from the public
 * provider ratings — IMDb, Rotten Tomatoes, Metacritic and TMDB.
 *
 * Because those are public, the score exists for titles the library does not
 * hold, so a List can genuinely discover: every film of the nineties above
 * nine, not merely the ones already owned. See `candidate-scores.ts` for how a
 * candidate is resolved and what it costs.
 *
 * A personal Archivist Score does not override the threshold here. A List asks
 * what the world makes of a title; most candidates are titles nobody has rated.
 */

export interface ArchivistRatingBounds { min?: number; max?: number }

/**
 * The lowest TMDB score a candidate can carry and still reach a threshold.
 *
 * The weighting renormalises over whichever providers replied, so a candidate's
 * best possible outcome is its TMDB score alongside a perfect 100 from every
 * other weighted provider:
 *
 *     best = (wTmdb x tmdb + wOthers x 100) / (wTmdb + wOthers)
 *
 * Setting `best = threshold` and solving for `tmdb` gives the floor: below it
 * no combination of other scores can reach the threshold, so the title can be
 * refused at TMDB and never cost an OMDb lookup.
 *
 *     floor = threshold - (wOthers / wTmdb) x (100 - threshold)
 *
 * Two things make the floor unusable, and both return null rather than a floor
 * that would drop titles which could have qualified:
 *
 *  - TMDB carrying no weight, where it constrains nothing and the division is
 *    undefined;
 *  - a floor at or below the library mean. Few-vote scores are pulled toward
 *    that mean, so a title with a low raw score and thin votes can be adjusted
 *    upward. The adjusted value is a weighted blend of the raw score and the
 *    mean, so it stays under the floor only when both do — which is exactly the
 *    condition that the floor sits above the mean.
 */
export function tmdbFloorFor(
  threshold: number | undefined,
  mediaType: ListMediaType,
  settings: ArchivistRatingSettings,
  libraryMean: number,
): number | null {
  if (threshold == null) return null
  const weights = weightsFor(settings, mediaType === 'film' ? 'films' : 'series')
  const tmdb = weights.tmdb
  if (tmdb <= 0) return null

  const others = RATING_PROVIDERS.reduce((sum, provider) => provider === 'tmdb' ? sum : sum + weights[provider], 0)
  const target = Math.min(100, Math.max(0, threshold * 10))
  const floor = target - (others / tmdb) * (100 - target)
  if (floor <= libraryMean) return null

  // Rounded down to two places so the bound is never tightened by rounding.
  return Math.floor((floor / 10) * 100) / 100
}

/**
 * Pull the Archivist Rating rules out of a filter.
 *
 * Only a top-level conjunction is supported — the rule alone, or ANDed with
 * others. Inside a NOT, "not rated above 9" would read as true for every
 * candidate whose score could not be resolved, quietly turning a curated List
 * into a firehose. Saying so is better than answering a question nobody meant
 * to ask.
 */
export function extractArchivistRating(node: FilterNode): ArchivistRatingBounds | null {
  const found: ArchivistRatingBounds[] = []

  const walk = (current: FilterNode, conjunctive: boolean): void => {
    if (current.op === 'and') {
      for (const child of current.nodes) walk(child, conjunctive)
      return
    }
    if (current.op === 'rating' && current.source === 'archivist') {
      if (!conjunctive) {
        throw new UnsupportedListFilterError([
          'An Archivist Rating rule cannot sit inside an "any of" or "none of" group. Negated, it would read as true for every candidate whose score could not be resolved, so it has to narrow the whole List rather than one branch of it.',
        ])
      }
      found.push({ min: current.min, max: current.max })
      return
    }
    if (current.op === 'or') { for (const child of current.nodes) walk(child, false); return }
    if (current.op === 'not') { walk(current.node, false); return }
  }

  walk(node, true)
  if (found.length === 0) return null

  // Several thresholds ANDed together are the tightest of them.
  return {
    min: found.reduce<number | undefined>((tightest, bounds) =>
      bounds.min == null ? tightest : tightest == null ? bounds.min : Math.max(tightest, bounds.min), undefined),
    max: found.reduce<number | undefined>((tightest, bounds) =>
      bounds.max == null ? tightest : tightest == null ? bounds.max : Math.min(tightest, bounds.max), undefined),
  }
}

/** Remove the Archivist Rating rules, leaving what the provider can answer. */
export function withoutArchivistRating(node: FilterNode): FilterNode | null {
  if (node.op === 'rating' && node.source === 'archivist') return null
  if (node.op === 'and' || node.op === 'or') {
    const kept = node.nodes.map(withoutArchivistRating).filter((child): child is FilterNode => child != null)
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0]
    return { ...node, nodes: kept } as FilterNode
  }
  return node
}

/**
 * Narrow a provider result to the members whose weighted score is in bounds.
 *
 * A candidate that could not be scored is dropped: an absent score satisfies no
 * threshold, the same rule tag rules follow, where an unscored film is neither
 * above nor below nine. Those left unresolved because the day's OMDb budget ran
 * out are reported separately — they are not judged, only postponed, and the
 * next refresh picks them up.
 */
export async function applyArchivistRating(
  result: ListMemberResult,
  mediaType: ListMediaType,
  bounds: ArchivistRatingBounds,
  db: Database = getDb(),
  signal?: AbortSignal,
): Promise<ListMemberResult> {
  /*
   * The same floor again, locally. Discover applies it where it can, but a
   * title-text List never runs discover, and a candidate can arrive from the
   * exact-person path too. Refusing them here is what keeps a doomed title from
   * spending an OMDb call on its way to being dropped.
   */
  const floor = tmdbFloorFor(bounds.min, mediaType, getArchivistRatingSettings(db), libraryMean(db))
  const worthScoring = floor == null
    ? result.members
    : result.members.filter(entry => entry.providerRating == null || entry.providerRating >= floor)
  const refusedByFloor = result.members.length - worthScoring.length

  const { scores, deferred } = await resolveCandidateScores(worthScoring, mediaType, db, signal)
  const kept: ListMember[] = worthScoring.filter(entry => {
    const score = scores.get(entry.tmdbId)
    if (score == null) return false
    return (bounds.min == null || score >= bounds.min) && (bounds.max == null || score <= bounds.max)
  })

  const dropped = result.members.length - kept.length
  const notes: string[] = []
  if (dropped > 0) notes.push(`${dropped} of ${result.members.length} provider matches scored outside the range or could not be scored.`)
  if (deferred > 0) notes.push(`${deferred} could not be scored today — the OMDb budget is spent, and the next refresh will pick them up.`)
  if (refusedByFloor > 0) notes.push(`${refusedByFloor} were ruled out on their TMDB score alone: below ${floor}, no combination of the other providers reaches this threshold.`)
  if (result.warning) notes.push(result.warning)

  return {
    ...result,
    members: kept,
    // `total` described what the provider matched; after this it describes what
    // the List actually holds, which is what the count on screen should say.
    total: kept.length,
    capped: false,
    warning: notes.length > 0 ? notes.join(' ') : undefined,
  }
}
