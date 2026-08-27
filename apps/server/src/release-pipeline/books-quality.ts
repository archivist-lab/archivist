import type { BookEditionKind } from '../modules/books/editions.js'

/**
 * Quality grading for books, which needs two ladders rather than one.
 *
 * An ebook and an audiobook share nothing that matters for ranking: one is
 * graded on how faithfully the text is encoded, the other on the audio
 * encoding and how completely the book is read. Scoring them on one scale
 * would make a 320kbps MP3 comparable to an EPUB, which is meaningless. Each
 * track therefore has its own rungs and its own parse.
 */

export const AUTOMATIC_BOOK_MIN_SEEDERS = 2

// ── Ladders ──────────────────────────────────────────────────────────────────

export interface BookQualityRung {
  /** Stored value; also what a quality profile targets. */
  id: string
  label: string
  /** Higher is better. Gaps leave room for rungs to be inserted later. */
  rank: number
}

/**
 * Ebook rungs. EPUB tops the ladder because it reflows and carries real
 * structure; PDF sits at the bottom because it is as often a page scan as it
 * is text, and neither reflows nor reliably yields a table of contents.
 */
export const EBOOK_RUNGS: readonly BookQualityRung[] = [
  { id: 'epub', label: 'EPUB', rank: 50 },
  { id: 'azw3', label: 'AZW3', rank: 40 },
  { id: 'mobi', label: 'MOBI', rank: 30 },
  { id: 'pdf', label: 'PDF', rank: 10 },
]

/**
 * Audiobook rungs. M4B is the top rung not for fidelity but for structure: it
 * is one file with chapter marks and resumable position, which is what an
 * audiobook is actually used for. Loose MP3s play but lose all of that.
 */
export const AUDIOBOOK_RUNGS: readonly BookQualityRung[] = [
  { id: 'm4b', label: 'M4B', rank: 50 },
  { id: 'flac', label: 'FLAC', rank: 40 },
  { id: 'm4a', label: 'M4A', rank: 30 },
  { id: 'mp3', label: 'MP3', rank: 20 },
]

export function rungsFor(kind: BookEditionKind): readonly BookQualityRung[] {
  return kind === 'audiobook' ? AUDIOBOOK_RUNGS : EBOOK_RUNGS
}

export function rungFor(kind: BookEditionKind, id: string | null | undefined): BookQualityRung | null {
  if (!id) return null
  const wanted = String(id).replace(/^\./, '').toLowerCase()
  return rungsFor(kind).find(rung => rung.id === wanted) ?? null
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export interface ParsedBookQuality {
  kind: BookEditionKind
  /** Ladder rung id, or null when the title says nothing about format. */
  rung: string | null
  /** Audiobook only: stated bitrate, used to separate two MP3 rips. */
  bitrateKbps: number | null
  /** Audiobook only. An abridged reading is a different work, not a lesser rip. */
  abridged: boolean
  /** Ebook only. A retail epub beats a converted or scanned one. */
  retail: boolean
  releaseGroup: string | null
  unknown: boolean
}

const GROUP_PATTERNS = [/\[([A-Za-z0-9_.]{2,20})\]\s*[^\]]*$/, /-\s*([A-Za-z0-9_.]{2,20})\s*$/]

function readReleaseGroup(title: string): string | null {
  for (const pattern of GROUP_PATTERNS) {
    const found = pattern.exec(title.trim())
    if (found) return found[1].toUpperCase()
  }
  return null
}

function readBitrate(title: string): number | null {
  const explicit = /\b(\d{2,4})\s*k(?:bps|b\/s|bit)\b/i.exec(title)
  if (explicit) {
    const value = Number(explicit[1])
    if (value >= 32 && value <= 2000) return value
  }
  const bare = /\b(32|48|64|96|112|128|160|192|224|256|320)\b/.exec(title)
  return bare ? Number(bare[1]) : null
}

export function parseBookQuality(releaseTitle: string, kind: BookEditionKind): ParsedBookQuality {
  const title = releaseTitle ?? ''
  const rung = rungsFor(kind).find(candidate => new RegExp(`\\b${candidate.id}\\b`, 'i').test(title)) ?? null

  return {
    kind,
    rung: rung?.id ?? null,
    bitrateKbps: kind === 'audiobook' ? readBitrate(title) : null,
    // "Unabridged" is the norm and is frequently left unstated, so only an
    // explicit "abridged" counts against a release.
    abridged: kind === 'audiobook' && /\babridged\b/i.test(title) && !/\bunabridged\b/i.test(title),
    retail: kind === 'ebook' && /\b(retail|official)\b/i.test(title),
    releaseGroup: readReleaseGroup(title),
    unknown: rung === null,
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface BookQualityPolicy {
  /** Ladder rung to reach, from the edition's target_tier. */
  targetRung?: string | null
  /** Never accept below the target rather than merely preferring it. */
  requireTarget?: boolean
  /** Reject sparse swarms for automation while leaving manual choice available. */
  minimumSeeders?: number
}

export interface BookReleaseScore {
  /** Higher is better. A release failing a hard requirement scores below zero. */
  score: number
  parsed: ParsedBookQuality
  rejection: string | null
}

export function scoreBookRelease(
  releaseTitle: string,
  kind: BookEditionKind,
  seeders: number,
  policy: BookQualityPolicy = {},
): BookReleaseScore {
  const parsed = parseBookQuality(releaseTitle, kind)
  const rung = rungFor(kind, parsed.rung)
  const target = rungFor(kind, policy.targetRung)

  if (policy.minimumSeeders != null && seeders < policy.minimumSeeders) {
    return { score: -1, parsed, rejection: `Fewer than ${policy.minimumSeeders} seeders` }
  }
  // An abridged reading is a different edition of the work, so it never
  // silently satisfies a request for the book.
  if (parsed.abridged) return { score: -1, parsed, rejection: 'Abridged reading' }
  if (policy.requireTarget && target && (!rung || rung.rank < target.rank)) {
    return { score: -1, parsed, rejection: `Below target format ${target.label}` }
  }

  let score = rung ? rung.rank * 100 : 0
  if (target && rung && rung.rank === target.rank) score += 250
  if (parsed.retail) score += 120
  if (kind === 'audiobook' && parsed.bitrateKbps) score += Math.min(parsed.bitrateKbps, 320) / 4
  // Swarm health breaks ties without ever outweighing a ladder step.
  score += Math.min(seeders, 50)

  return { score, parsed, rejection: null }
}

export function rankBookReleases<T extends { title: string; seeders?: number | null }>(
  releases: T[],
  kind: BookEditionKind,
  policy: BookQualityPolicy = {},
): Array<T & { bookScore: BookReleaseScore }> {
  return releases
    .map(release => ({ ...release, bookScore: scoreBookRelease(release.title, kind, release.seeders ?? 0, policy) }))
    .filter(release => release.bookScore.score >= 0)
    .sort((a, b) => b.bookScore.score - a.bookScore.score)
}
