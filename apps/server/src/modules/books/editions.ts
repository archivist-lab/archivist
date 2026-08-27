import type { Database } from 'better-sqlite3'

/**
 * A book is acquired as two independent editions. They are found by different
 * searches, arrive in different formats and complete at different times, so
 * each carries its own acquisition state and the parent book row only rolls
 * them up for display.
 */
export const BOOK_EDITION_KINDS = ['ebook', 'audiobook'] as const
export type BookEditionKind = (typeof BOOK_EDITION_KINDS)[number]

export function isBookEditionKind(value: unknown): value is BookEditionKind {
  return BOOK_EDITION_KINDS.includes(value as BookEditionKind)
}

/**
 * Containers each track accepts, best first. Position is the quality ladder:
 * an ebook release in epub outranks the same book as a pdf, which is a scan
 * as often as it is a text.
 */
export const BOOK_CONTAINERS: Record<BookEditionKind, readonly string[]> = {
  ebook: ['epub', 'azw3', 'mobi', 'pdf'],
  audiobook: ['m4b', 'm4a', 'flac', 'mp3'],
}

/** Which track a file extension belongs to, or null when it is neither. */
export function kindForContainer(container: string | null | undefined): BookEditionKind | null {
  if (!container) return null
  const normalised = container.replace(/^\./, '').toLowerCase()
  for (const kind of BOOK_EDITION_KINDS) {
    if (BOOK_CONTAINERS[kind].includes(normalised)) return kind
  }
  return null
}

/**
 * Format words belong to matching, never to the query.
 *
 * Uploaders do not name releases consistently, and an indexer matching on the
 * literal string drops every release that omits the word — which is most of
 * them. Searching the plain author and title returns both tracks, and
 * `classifyReleaseKind` then routes each result to the edition it belongs to.
 * That is strictly more complete than filtering at the indexer.
 */
export function editionMatchTerms(kind: BookEditionKind): string[] {
  return kind === 'audiobook'
    ? ['audiobook', 'm4b', 'unabridged']
    : ['epub', 'ebook', 'mobi']
}

/** Newznab category for the track, so category-aware indexers filter server-side. */
export function editionCategories(kind: BookEditionKind): number[] {
  // 3030 Audio/Audiobook, 7020 Books/EBook — the two the executor already maps.
  return kind === 'audiobook' ? [3030] : [7020]
}

/**
 * Creates whichever of the two tracks a book is missing. Called wherever a
 * book enters the library: without both rows there is nothing for the missing
 * search to enqueue, and the format would silently never be looked for.
 */
export function ensureBookEditions(db: Database, bookId: number): void {
  const insert = db.prepare(`
    INSERT INTO book_editions (book_id, kind, status, monitored)
    VALUES (?, ?, 'missing', 1)
    ON CONFLICT (book_id, kind) DO NOTHING
  `)
  for (const kind of BOOK_EDITION_KINDS) insert.run(bookId, kind)
}

interface EditionState {
  kind: BookEditionKind
  status: string
  monitored: number
  download_progress: number | null
}

/**
 * Recomputes the book row from its editions. The book is only 'downloaded'
 * when every monitored track is in — a book with the ebook but not the
 * audiobook is genuinely incomplete, and reporting it as done would hide it
 * from the missing list forever.
 *
 * Unmonitored tracks are excluded: turning the audiobook off is a statement
 * that the ebook alone completes the book.
 */
export function rollUpBook(db: Database, bookId: number): void {
  const editions = db.prepare(
    'SELECT kind, status, monitored, download_progress FROM book_editions WHERE book_id = ?',
  ).all(bookId) as EditionState[]
  if (editions.length === 0) return

  const tracked = editions.filter(e => e.monitored)
  // Every track unmonitored: fall back to what is actually on disk rather
  // than reporting a book with files as missing.
  const considered = tracked.length > 0 ? tracked : editions

  const downloaded = considered.filter(e => e.status === 'downloaded')
  const inFlight = considered.find(e => e.status === 'downloading' || e.status === 'acquiring')

  let status: string
  if (downloaded.length === considered.length) status = 'downloaded'
  else if (inFlight) status = inFlight.status
  else if (downloaded.length > 0) status = 'partial'
  else status = 'missing'

  const progress = considered.reduce(
    (sum, e) => sum + (e.status === 'downloaded' ? 1 : Number(e.download_progress) || 0), 0,
  ) / considered.length

  db.prepare(`
    UPDATE books SET status = ?, download_progress = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, Math.max(0, Math.min(1, progress)), bookId)
}

/**
 * Which track a release belongs to. This is the guard that keeps an m4b from
 * satisfying the ebook request: both tracks search the same author and title,
 * so indexer results overlap and the format markers in the title are the only
 * thing separating them.
 *
 * An unmarked release resolves to 'ebook'. A plain "Author - Title" book
 * torrent is overwhelmingly an ebook, and audiobooks are near-always labelled
 * as such because size and narrator are what buyers look for.
 */
export function classifyReleaseKind(title: string, container?: string | null): BookEditionKind {
  const fromContainer = kindForContainer(container)
  if (fromContainer) return fromContainer

  const haystack = String(title || '')
  if (/\b(?:audio ?books?|m4b|m4a|unabridged|abridged|narrat(?:ed|or)|mp3 ?(?:cd|audio))\b/i.test(haystack)) {
    return 'audiobook'
  }
  return 'ebook'
}
