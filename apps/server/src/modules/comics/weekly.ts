import type { Database } from 'better-sqlite3'

/**
 * Weekly publisher dumps.
 *
 * Every major publisher ships a single torrent each week holding that week's
 * entire output — "Marvel Week+ (08-19-2026)" — rather than one torrent per
 * issue. For anything newly released this is the accurate route: the pack
 * appears on schedule and is complete, where a per-issue search depends on
 * someone having bothered to upload that issue on its own.
 *
 * The pack spans many series at once, which is what separates it from a
 * volume pack. Matching therefore runs against every monitored issue in the
 * library rather than the issues of one series.
 */

/** Recognised weekly pack titles, e.g. "Marvel Week+ (08-19-2026)". */
const WEEKLY_PACK = /^(.+?)\s+Week(?:\s*\+|\+)?\s*[({[]?\s*(\d{2})[-.](\d{2})[-.](\d{4})\s*[)}\]]?/i

export interface WeeklyPack {
  publisher: string
  /** ISO date of the week the pack covers. */
  date: string
}

export function parseWeeklyPackTitle(title: string): WeeklyPack | null {
  const found = WEEKLY_PACK.exec(String(title ?? '').trim())
  if (!found) return null
  const [, publisher, month, day, year] = found
  const date = `${year}-${month}-${day}`
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null
  return { publisher: publisher.trim(), date }
}

export function isWeeklyPackTitle(title: string): boolean {
  return parseWeeklyPackTitle(title) !== null
}

/** Search terms for a publisher's weekly pack. */
export function weeklyPackQueries(publisher: string): string[] {
  return [`${publisher} Week+`, `${publisher} Week`]
}

// ── Pack contents ────────────────────────────────────────────────────────────

export interface ComicFileName {
  /** Series title as written in the filename, e.g. "Alien - King Killer". */
  seriesTitle: string
  /** Issue number, zero-padding stripped: "005" becomes "5". */
  issueNumber: string
  year: number | null
}

/**
 * Reads a comic filename of the shape publishers actually use:
 *
 *   Alien - King Killer 005 (2026) (Digital) (Kileko-Empire).cbz
 *   Captain Marvel - Dark Past 005 (2026) (Digital) (F) (Shan-Empire).cbz
 *
 * The series title may itself contain " - ", so the split is anchored on the
 * issue number rather than the dash: the number is the last bare integer
 * before the first parenthesised group.
 */
export function parseComicFileName(fileName: string): ComicFileName | null {
  const name = String(fileName ?? '').replace(/\.(cbz|cbr|cb7|pdf)$/i, '').trim()
  if (!name) return null

  // Everything up to the first bracketed group is "<title> <issue>".
  const head = name.split(/\s*[(\[]/)[0].trim()
  const issue = /^(.*?)[\s#]+(\d{1,5}(?:\.\d+)?)$/.exec(head)
  if (!issue) return null

  const seriesTitle = issue[1].trim()
  if (!seriesTitle) return null

  const yearMatch = /\((19|20)\d{2}\)/.exec(name)
  return {
    seriesTitle,
    issueNumber: normaliseIssueNumber(issue[2]),
    year: yearMatch ? Number(yearMatch[0].slice(1, -1)) : null,
  }
}

/** "005" and "5" and "5.0" are the same issue. */
export function normaliseIssueNumber(value: string | number): string {
  const raw = String(value ?? '').trim()
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) return String(numeric)
  return raw.replace(/^0+(?=\d)/, '')
}

/** Comparison key for a series title: case, punctuation and articles removed. */
export function seriesKey(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .trim()
}

export interface WeeklyMatch {
  /** Absolute path of the file inside the pack. */
  file: string
  issueId: number
  seriesId: number
  seriesTitle: string
  issueNumber: string
}

interface MonitoredIssueRow {
  id: number
  issue_number: string
  series_id: number
  series_title: string
}

/**
 * Matches files from a pack to issues this library is actually waiting for.
 *
 * Only monitored, uncollected issues are considered: a weekly pack contains
 * hundreds of files and the overwhelming majority belong to series nobody
 * here tracks. Those are left alone rather than imported speculatively.
 */
export function matchWeeklyPackFiles(
  db: Database,
  libraryId: number,
  files: Array<{ path: string; name: string }>,
): { matched: WeeklyMatch[]; unmatched: string[] } {
  const wanted = db.prepare(`
    SELECT i.id, i.issue_number, i.series_id, s.title AS series_title
    FROM comic_issues i
    JOIN comic_series s ON s.id = i.series_id
    WHERE s.library_id = ? AND s.monitored = 1 AND i.monitored = 1
      AND i.status NOT IN ('collected', 'downloaded')
  `).all(libraryId) as MonitoredIssueRow[]

  const index = new Map<string, MonitoredIssueRow>()
  for (const issue of wanted) {
    index.set(`${seriesKey(issue.series_title)}#${normaliseIssueNumber(issue.issue_number)}`, issue)
  }

  const matched: WeeklyMatch[] = []
  const unmatched: string[] = []
  const claimed = new Set<number>()

  for (const file of files) {
    const parsed = parseComicFileName(file.name)
    if (!parsed) {
      unmatched.push(file.name)
      continue
    }
    const hit = index.get(`${seriesKey(parsed.seriesTitle)}#${parsed.issueNumber}`)
    // One file per issue: a pack occasionally carries a variant of the same
    // issue, and importing both would leave the second overwriting the first.
    if (!hit || claimed.has(hit.id)) {
      unmatched.push(file.name)
      continue
    }
    claimed.add(hit.id)
    matched.push({
      file: file.path,
      issueId: hit.id,
      seriesId: hit.series_id,
      seriesTitle: hit.series_title,
      issueNumber: normaliseIssueNumber(hit.issue_number),
    })
  }

  return { matched, unmatched }
}
