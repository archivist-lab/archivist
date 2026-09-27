import { foldForMatching } from '@torrentstack/indexer-engine'

/** Unicode dashes (figure, en, em, horizontal bar, minus) rendered as ASCII. */
const UNICODE_DASHES = /[‐‑‒–—―−]/g

/**
 * The fold lives in the indexer engine, which needs the identical rules for the
 * Cardigann `andmatch` row filter. Two copies is how the query we send and the
 * titles we accept drift apart — and they did: `andmatch` split on the
 * apostrophe while the query builder removed it, so searching `A Bugs Life`
 * threw away the row `A Bug's Life (1998)`.
 *
 * Punctuation is deliberately left for callers. `releaseTitleTokens` splits on
 * it; `trackerSafeQuery` keeps the hyphens that scene names spell out.
 */
const foldTitle = foldForMatching

/**
 * Tokenize catalogue titles and release names through the same Unicode-aware
 * path. Diacritics and punctuation vary widely between indexers, while
 * letters from non-Latin scripts must remain meaningful match tokens.
 */
export function releaseTitleTokens(title: string): string[] {
  const folded = foldTitle(title.toLowerCase())
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()

  return folded ? folded.split(/\s+/) : []
}

export function releaseTitleContains(targetTitle: string, candidateTitle: string): boolean {
  const candidateWords = releaseTitleTokens(candidateTitle)
  return releaseTitleTokens(targetTitle).every(word => candidateWords.includes(word))
}

/**
 * A catalogue title rewritten the way uploaders spell it, so a keyword search
 * can match.
 *
 * Trackers match the release name, and scene names carry no punctuation beyond
 * the separators: `A Bug's Life` is uploaded as `A.Bugs.Life`, `Monsters, Inc.`
 * as `Monsters.Inc`. Sending the catalogue's punctuation through verbatim is
 * what made those searches return nothing at all rather than fewer rows.
 *
 * Case is preserved — trackers match case-insensitively, and the query is shown
 * back to the user in search diagnostics.
 *
 * The hyphen is the one mark kept, because it is the one mark release names
 * keep: `Spider-Man`, `X-Men`, `WALL-E`. A hyphen standing alone as a dash is
 * still punctuation, so it is dropped unless it sits inside a word.
 */
export function trackerSafeQuery(query: string): string {
  const folded = foldTitle(query.replace(UNICODE_DASHES, '-'))
    // Every mark except the hyphen becomes a separator. `-` is escaped at the
    // end of the class so it is a literal, not a range.
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')

  return folded
    .split(/\s+/)
    // Trim dashes used as punctuation ("Alien - Resurrection", "2001 -") while
    // leaving the ones inside a word ("Spider-Man") intact.
    .map(token => token.replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join(' ')
}
