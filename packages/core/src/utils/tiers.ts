// ── Quality tiers: the single source of truth for release-group tiers ─────────
//
// These group tiers drive BOTH search (terms appended to indexer queries to
// beat result caps) and ranking (a tie-breaker within a quality class — see
// services/quality.ts for the resolution/source/codec ladders that lead the
// sort). The app layer can override this per library via `getTierTermsForMedia`,
// but this list is the built-in default both layers fall back to.

export type TierMediaType = 'films' | 'series' | 'music' | 'games' | 'comics'
export interface TierTerm { term: string; mediaTypes: TierMediaType[] }
export interface TierConfig { tier1: TierTerm[]; tier2: TierTerm[]; tier3: TierTerm[] }

export const DEFAULT_TIERS: TierConfig = {
  tier1: [
    { term: 'SARTRE', mediaTypes: ['films', 'series'] },
    { term: 'QxR',    mediaTypes: ['films', 'series'] },
    { term: 'SAMPA',  mediaTypes: ['films', 'series'] },
    { term: 'Prof',   mediaTypes: ['films', 'series'] },
    { term: 'TAoE',   mediaTypes: ['films', 'series'] },
    { term: 'SM737',  mediaTypes: ['films', 'series'] },
    { term: 'HeVK',   mediaTypes: ['films', 'series'] },
  ],
  tier2: [
    { term: 'POIASD',  mediaTypes: ['films', 'series'] },
    { term: 'UTR',     mediaTypes: ['films', 'series'] },
    { term: '"[SEV]"', mediaTypes: ['films', 'series'] },
  ],
  tier3: [
    { term: 'YIFY',     mediaTypes: ['films', 'series'] },
    { term: 'PSA',      mediaTypes: ['films', 'series'] },
    { term: 'MeGusta',  mediaTypes: ['films', 'series'] },
    { term: 'ELiTE',    mediaTypes: ['films', 'series'] },
    { term: 'KONTRAST', mediaTypes: ['films', 'series'] },
    { term: 'NeoNoir',  mediaTypes: ['films', 'series'] },
  ],
}

/** Flatten a TierConfig to plain per-tier term-string arrays. */
export function tierTermStrings(config: TierConfig): { tier1: string[]; tier2: string[]; tier3: string[] } {
  return {
    tier1: config.tier1.map(t => t.term),
    tier2: config.tier2.map(t => t.term),
    tier3: config.tier3.map(t => t.term),
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reduce a stored term to its matchable token: strip surrounding quotes and
 * brackets so a term written for phrase-search — e.g. `"[SEV]"` — still matches
 * a release whose group renders as `-SEV` or `[SEV]`. Punctuation inside the
 * token (rare) is preserved after escaping.
 */
function matchToken(term: string): string {
  return term.replace(/^["'\[\](){}\s]+|["'\[\](){}\s]+$/g, '')
}

/**
 * Build one anchored, case-insensitive matcher per term. Anchored on a release
 * boundary (start, whitespace, `.`, `-`, `[`) plus a trailing word boundary so
 * `Prof` matches the group `-Prof` but NOT the word "Professional". Terms whose
 * token is under two chars are skipped (too noisy to anchor safely).
 */
export function buildTierMatchers(terms: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const term of terms) {
    const token = matchToken(term)
    if (token.length < 2) continue
    out.push(new RegExp(`(?<=^|[\\s.\\-\\[])${escapeRegex(token)}\\b`, 'i'))
  }
  return out
}

export interface TierMatcher {
  /** Tier (1/2/3) of the first matching term, or 0 if no term matches. */
  tierOf(title: string): number
}

/**
 * Compile a reusable matcher from a tier config. Build this ONCE per selection
 * batch and reuse across releases — the regexes are compiled up front.
 */
export function makeTierMatcher(tiers: { tier1: string[]; tier2: string[]; tier3: string[] }): TierMatcher {
  const t1 = buildTierMatchers(tiers.tier1)
  const t2 = buildTierMatchers(tiers.tier2)
  const t3 = buildTierMatchers(tiers.tier3)
  return {
    tierOf(title: string): number {
      if (t1.some(r => r.test(title))) return 1
      if (t2.some(r => r.test(title))) return 2
      if (t3.some(r => r.test(title))) return 3
      return 0
    },
  }
}

/** Points awarded for a group tier — feeds the ranking score. */
export function tierScore(tier: number): number {
  return tier === 1 ? 1000 : tier === 2 ? 500 : tier === 3 ? 100 : 0
}

// ── Built-in ranking recognition (fallback only, never searched) ──────────────
//
// A broad list of known release groups used ONLY to tier a release the user's
// configured tiers don't cover — so recognition stays wide without bloating the
// (searched) DEFAULT_TIERS. Configured tiers always take precedence; this only
// fills gaps. Not user-editable and never appended to search queries.
export const BUILTIN_RANK_TIERS: { tier1: string[]; tier2: string[]; tier3: string[] } = {
  tier1: [
    'QxR', 'afm72', 'Bandi', 'FreetheFish', 'Garshasp', 'Ghost', 'Ime', 'Kappa', 'Langbard',
    'LION', 'Panda', 'MONOLITH', 'Natty', 'r00t', 'RCVR', 'RZeroX', 'SAMPA', 'Silence', 't3nzin',
    'Tigole', 'YOGI', 'TAoE', 'Ainz', 'AJJMIN', 'ANONAZ', 'ArcX', 'bccornfo', 'DNU', 'DrainedDay',
    'DUHIT', 'Erie', 'Frys', 'Goki', 'HxD', 'jb2049', 'JBENT', 'Nostradamus', 'r0b0t', 'Species180',
    'TheSickle', 'xtrem3x', 'WEM', 'POIASD', 'SARTRE',
  ],
  tier2: [
    'R1GY3B', 'Ralphy', 'TimeDistortion', 'SQS', 'Chivaman', 'Vyndros', 'Prof', 'HeVK', 'UTR',
    'Joy', 'Q22', 'Qman', 'Q18', 'theincognito', 'Korach', 'D0ct0rLew', 'SM737',
  ],
  tier3: [
    'iVy', 'KONTRAST', 'PHOCiS', 'YAWNiX', 'edge2020', 'YIFY', 'PSA', 'MeGusta',
  ],
}

const BUILTIN_MATCHER: TierMatcher = makeTierMatcher(BUILTIN_RANK_TIERS)

/**
 * Tier of a title using the built-in recognition list only. Callers should
 * prefer configured tiers first and fall back to this for tier-0 titles.
 */
export function builtinTierOf(title: string): number {
  return BUILTIN_MATCHER.tierOf(title)
}
