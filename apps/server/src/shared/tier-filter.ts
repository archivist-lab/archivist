/**
 * The quality tier a library item has reached.
 *
 * Tiers run 1 (best) to 3, matching a release group against the configured
 * tier terms; 0 means the file's group matched none of them. Shared by the film
 * and series listings so the two cannot drift on what `tier=1,2` means.
 */

export const TIER_VALUES = [0, 1, 2, 3] as const
export type TierValue = typeof TIER_VALUES[number]

/**
 * Parse a `tier` query parameter into the tiers to keep.
 *
 * An empty, absent or unparseable value means no filter rather than an error —
 * a stale bookmark should show the library, not a failure. "all" says so
 * explicitly, for a UI that always sends the parameter.
 */
export function parseTierFilter(raw: unknown): TierValue[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean)
  if (parts.includes('all')) return []
  const tiers = parts
    .map(Number)
    .filter((value): value is TierValue => TIER_VALUES.includes(value as TierValue))
  // Deduplicated so `tier=1,1` binds one parameter rather than two.
  return [...new Set(tiers)]
}
