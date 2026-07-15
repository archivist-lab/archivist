import { DEFAULT_TIERS, tierTermStrings, makeTierMatcher, tierScore, builtinTierOf, type TierMatcher } from './tiers.js'

export interface ScoredRelease {
  tier: number // 1, 2, 3 or 0 (no match)
  score: number
}

/**
 * Score a title against a configured tier matcher, falling back to the built-in
 * recognition list for titles the configured tiers don't cover. Configured
 * tiers win — the fallback only tiers otherwise-unrecognised (tier 0) groups.
 */
export function scoreReleaseWith(matcher: TierMatcher, title: string): ScoredRelease {
  const tier = matcher.tierOf(title) || builtinTierOf(title)
  return { tier, score: tierScore(tier) }
}

/** Build a reusable ranking scorer from plain per-tier term arrays. */
export function makeReleaseScorer(tiers: { tier1: string[]; tier2: string[]; tier3: string[] }) {
  const matcher = makeTierMatcher(tiers)
  return (title: string): ScoredRelease => scoreReleaseWith(matcher, title)
}

// Default scorer over DEFAULT_TIERS (+ built-in fallback) — for callers without
// a library scope. Scoped callers should build their own with makeReleaseScorer.
const DEFAULT_SCORER = makeReleaseScorer(tierTermStrings(DEFAULT_TIERS))

/** Score a release using the built-in default tiers (no library override). */
export function scoreRelease(title: string): ScoredRelease {
  return DEFAULT_SCORER(title)
}
