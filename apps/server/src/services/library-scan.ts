import { readdirSync, statSync } from 'node:fs'
import { join, basename, dirname, extname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { resolveLibraryRoot } from '../shared/library-paths.js'
import { parseRelease, normalizeTitle, type ParsedRelease } from '../release-pipeline/parser.js'
import { searchMovies } from '../modules/films/tmdb.js'
import { createFilmFromTmdb } from '../modules/films/create.js'
import { searchSeries } from '../modules/series/tvdb.js'
import { createSeriesFromMetadata } from '../modules/series/create.js'
import { queueMediaImport, type MatchMediaType } from './media-imports.js'
import { getAppSetting, setAppSetting } from '../shared/settings.js'

// ── Settings ──────────────────────────────────────────────────────────────────
// Whether high-confidence matches are adopted automatically during a scan.
// Regardless of this flag, a loose episode matching a series that already
// exists in the library is never auto-adopted — it always waits for review, so
// existing shows are never modified without confirmation.
const AUTO_ADOPT_KEY = 'libraryScanAutoAdopt'
export interface LibraryScanSettings { autoAdopt: boolean }

export function getLibraryScanSettings(): LibraryScanSettings {
  return { autoAdopt: getAppSetting<{ enabled: boolean }>(AUTO_ADOPT_KEY, { enabled: true }).enabled }
}

export function setLibraryScanSettings(patch: Partial<LibraryScanSettings>): LibraryScanSettings {
  const current = getLibraryScanSettings()
  const next: LibraryScanSettings = { autoAdopt: patch.autoAdopt ?? current.autoAdopt }
  setAppSetting(AUTO_ADOPT_KEY, { enabled: next.autoAdopt })
  return next
}

// ── Library scan importer ─────────────────────────────────────────────────────
// Walks a films library root for video files that aren't linked to any film,
// identifies them (parse → match existing item / TMDB), and either adopts them
// automatically (high confidence) or parks them for review. Adoption reuses the
// import pipeline in `inPlace` mode so the file is linked where it already sits.
// Series adoption is a planned Phase 2 (this v1 handles films).

const logger = createLogger('LibraryScan')
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v'])
const MIN_SIZE = 50 * 1024 * 1024 // ignore tiny files (extras, junk)
const AUTO_THRESHOLD = 0.85

interface LibraryRow { id: number; name: string; media_type: string; db_path: string }
interface MatchCandidate { kind: 'item' | 'tmdb'; itemId?: number; tmdbId?: number; tvdbId?: number; title: string; year: number | null; score: number }

export interface ScanState {
  running: boolean
  scanned: number
  adopted: number
  review: number
  owned: number
  failed: number
  startedAt: string | null
  finishedAt: string | null
}

let scanState: ScanState = { running: false, scanned: 0, adopted: 0, review: 0, owned: 0, failed: 0, startedAt: null, finishedAt: null }

export function scanStatus(): ScanState & { pendingReview: number } {
  const pendingReview = (getDb().prepare("SELECT COUNT(*) AS c FROM library_scan_candidates WHERE state = 'review'").get() as { c: number }).c
  return { ...scanState, pendingReview }
}

// ── Discovery ─────────────────────────────────────────────────────────────────

function walkVideos(root: string, out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) { walkVideos(full, out); continue }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (!VIDEO_EXTS.has(extname(lower))) continue
    if (lower.includes('sample') || lower.includes('trailer')) continue
    try { if (statSync(full).size < MIN_SIZE) continue } catch { continue }
    out.push(full)
  }
  return out
}

function ownedFilmPaths(): Set<string> {
  const db = getDb()
  const paths = new Set<string>()
  for (const table of ['films', 'film_editions'] as const) {
    for (const row of db.prepare(`SELECT file_path FROM ${table} WHERE file_path IS NOT NULL`).all() as Array<{ file_path: string }>) {
      if (row.file_path) paths.add(resolve(row.file_path))
    }
  }
  return paths
}

function ownedEpisodePaths(): Set<string> {
  const paths = new Set<string>()
  for (const row of getDb().prepare('SELECT file_path FROM episodes WHERE file_path IS NOT NULL').all() as Array<{ file_path: string }>) {
    if (row.file_path) paths.add(resolve(row.file_path))
  }
  return paths
}

// ── Parsing & matching ────────────────────────────────────────────────────────

// Movie libraries are folder-per-title, so the parent folder name is usually the
// cleaner source; fall back to the filename.
function bestParse(file: string): ParsedRelease {
  const fromFile = parseRelease(basename(file))
  const fromDir = parseRelease(basename(dirname(file)))
  if (fromDir.year) return fromDir
  if (fromFile.year) return fromFile
  return fromDir.title.length >= fromFile.title.length ? fromDir : fromFile
}

function titleYearScore(parsedTitle: string, parsedYear: number | null, candTitle: string, candYear: number | null): number {
  const a = normalizeTitle(parsedTitle)
  const b = normalizeTitle(candTitle)
  if (!a || !b) return 0
  let score = a === b ? 0.8 : (b.includes(a) || a.includes(b)) ? 0.5 : 0
  if (score === 0) return 0
  if (parsedYear && candYear) score += parsedYear === candYear ? 0.15 : -0.35
  else if (!parsedYear) score -= 0.05 // a title without a year is less certain
  return Math.max(0, Math.min(1, score))
}

async function resolveFilmMatch(libraryId: number, parsed: ParsedRelease): Promise<MatchCandidate[]> {
  const db = getDb()
  const candidates: MatchCandidate[] = []

  for (const film of db.prepare('SELECT id, title, year FROM films WHERE library_id = ?').all(libraryId) as Array<{ id: number; title: string; year: number | null }>) {
    const score = titleYearScore(parsed.title, parsed.year, film.title, film.year)
    if (score > 0.4) candidates.push({ kind: 'item', itemId: film.id, title: film.title, year: film.year, score })
  }

  try {
    const query = `${parsed.title}${parsed.year ? ` ${parsed.year}` : ''}`.trim()
    if (query.length >= 2) {
      for (const movie of (await searchMovies(query)).slice(0, 6)) {
        const score = titleYearScore(parsed.title, parsed.year, movie.title, movie.year ?? null) * 0.98 // prefer existing items on ties
        if (score > 0.4) candidates.push({ kind: 'tmdb', tmdbId: movie.tmdbId, title: movie.title, year: movie.year ?? null, score })
      }
    }
  } catch (error) {
    logger.warn('TMDB search failed during scan:', error instanceof Error ? error.message : String(error))
  }

  // De-dupe TMDB entries already represented by a library item, keep best first.
  const seen = new Set<string>()
  return candidates.sort((a, b) => b.score - a.score).filter(c => {
    const key = c.kind === 'item' ? `i${c.itemId}` : `t${c.tmdbId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

// Series episode files usually carry SxxEyy in the filename, while the series
// title lives in a parent folder (skipping any "Season NN" level).
interface SeriesParse { title: string; year: number | null; season: number | null; episode: number | null; kind: 'series' }
function seriesParse(file: string): SeriesParse {
  const fromFile = parseRelease(basename(file))
  const parent = basename(dirname(file))
  const seriesFolderName = /^(season\b|s\d{1,2}$|specials?$)/i.test(parent) ? basename(dirname(dirname(file))) : parent
  const fromFolder = parseRelease(seriesFolderName)
  const title = fromFolder.title && fromFolder.title.length >= 2 ? fromFolder.title : fromFile.title
  return {
    title,
    year: fromFile.year ?? fromFolder.year,
    season: fromFile.season ?? fromFolder.season,
    episode: fromFile.episodes[0] ?? fromFolder.episodes[0] ?? null,
    kind: 'series',
  }
}

// A series-level match for a whole group of episode files (existing library
// series or a TVDB/TMDB hit). Resolved ONCE per show, then fanned out to each
// file's concrete episode by its SxxEyy — so the series is created/looked up a
// single time rather than per episode.
interface SeriesLevelMatch { kind: 'item' | 'tmdb'; seriesId?: number; tmdbId?: number; tvdbId?: number; title: string; year: number | null; score: number }

async function resolveSeriesGroupMatches(libraryId: number, title: string, year: number | null): Promise<SeriesLevelMatch[]> {
  const db = getDb()
  const matches: SeriesLevelMatch[] = []

  for (const series of db.prepare('SELECT id, title, year FROM series WHERE library_id = ?').all(libraryId) as Array<{ id: number; title: string; year: number | null }>) {
    const score = titleYearScore(title, year, series.title, series.year)
    if (score > 0.4) matches.push({ kind: 'item', seriesId: series.id, title: series.title, year: series.year, score: Math.min(1, score + 0.1) })
  }

  try {
    const query = `${title}${year ? ` ${year}` : ''}`.trim()
    if (query.length >= 2) {
      for (const series of (await searchSeries(query)).slice(0, 5)) {
        const score = titleYearScore(title, year, series.title, series.year ?? null) * 0.9 // prefer existing library items
        if (score > 0.45) matches.push({ kind: 'tmdb', tmdbId: series.tmdbId, tvdbId: series.tvdbId, title: series.title, year: series.year ?? null, score })
      }
    }
  } catch (error) {
    logger.warn('Series search failed during scan:', error instanceof Error ? error.message : String(error))
  }

  const seen = new Set<string>()
  return matches.sort((a, b) => b.score - a.score).filter(m => {
    const key = m.kind === 'item' ? `s${m.seriesId}` : `t${m.tmdbId ?? m.tvdbId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

// Builds the per-file episode-level candidates (stored for review) from the
// group's series matches + this file's SxxEyy — no extra network calls.
function episodeCandidatesFromSeries(db: ReturnType<typeof getDb>, matches: SeriesLevelMatch[], sp: SeriesParse): MatchCandidate[] {
  if (sp.season == null || sp.episode == null) return []
  const code = `S${String(sp.season).padStart(2, '0')}E${String(sp.episode).padStart(2, '0')}`
  const out: MatchCandidate[] = []
  for (const m of matches) {
    if (m.kind === 'item') {
      const ep = db.prepare('SELECT id FROM episodes WHERE series_id = ? AND season_number = ? AND episode_number = ?').get(m.seriesId, sp.season, sp.episode) as { id: number } | undefined
      if (ep) out.push({ kind: 'item', itemId: ep.id, title: `${m.title} ${code}`, year: m.year, score: m.score })
    } else {
      out.push({ kind: 'tmdb', tmdbId: m.tmdbId, tvdbId: m.tvdbId, title: `${m.title} ${code}`, year: m.year, score: m.score })
    }
  }
  return out.slice(0, 8)
}

// ── Adoption ──────────────────────────────────────────────────────────────────

async function adoptFilm(lib: LibraryRow, file: string, target: { itemId?: number; tmdbId?: number }, normalise: boolean): Promise<number> {
  const db = getDb()
  const filmId = target.itemId ?? (target.tmdbId ? await createFilmFromTmdb(db, lib.id, target.tmdbId) : null)
  if (!filmId) throw new Error('no film to adopt into')
  const hash = createHash('sha1').update(`scan:${file}`).digest('hex')
  queueMediaImport({
    tabId: lib.id, tabName: lib.name, dbPath: lib.db_path,
    mediaType: 'films', itemId: filmId,
    torrentId: `scan:${hash}`, infoHash: hash,
    sourcePath: file, copy: false, inPlace: !normalise,
    releaseTitle: basename(file),
  })
  return filmId
}

/**
 * Adopts an episode file. If given an existing episode id it links straight in;
 * otherwise it creates the series from TVDB/TMDB (populating its episodes),
 * resolves the concrete episode for the file's season/episode, then adopts.
 * Returns the resolved episode id.
 */
async function adoptEpisode(
  lib: LibraryRow, file: string,
  target: { episodeId?: number; tvdbId?: number; tmdbId?: number; season?: number | null; episode?: number | null },
  normalise: boolean,
): Promise<number> {
  const db = getDb()
  let episodeId = target.episodeId
  if (!episodeId) {
    if ((!target.tvdbId && !target.tmdbId) || target.season == null || target.episode == null) throw new Error('cannot resolve episode for adoption')
    const seriesId = await createSeriesFromMetadata(db, lib.id, { tvdbId: target.tvdbId, tmdbId: target.tmdbId })
    const ep = db.prepare('SELECT id FROM episodes WHERE series_id = ? AND season_number = ? AND episode_number = ?').get(seriesId, target.season, target.episode) as { id: number } | undefined
    if (!ep) throw new Error(`episode S${target.season}E${target.episode} not found after creating series`)
    episodeId = ep.id
  }
  queueEpisodeImport(lib, file, episodeId, normalise)
  return episodeId
}

// Links a single episode file into `episodeId` via the import pipeline. The
// single-episode import path is keyed by episode id under 'series'.
function queueEpisodeImport(lib: LibraryRow, file: string, episodeId: number, normalise: boolean): void {
  const hash = createHash('sha1').update(`scan:${file}`).digest('hex')
  queueMediaImport({
    tabId: lib.id, tabName: lib.name, dbPath: lib.db_path,
    mediaType: 'series', itemId: episodeId,
    torrentId: `scan:${hash}`, infoHash: hash,
    sourcePath: file, copy: false, inPlace: !normalise,
    releaseTitle: basename(file),
  })
}

function upsertCandidate(row: {
  library_id: number; media_type: string; source_path: string; parsed: string
  best_item_id: number | null; best_tmdb_id: number | null; confidence: number
  state: string; candidates: string; last_error: string | null
}): void {
  getDb().prepare(`
    INSERT INTO library_scan_candidates (library_id, media_type, source_path, parsed, best_item_id, best_tmdb_id, confidence, state, candidates, last_error, scanned_at)
    VALUES (@library_id, @media_type, @source_path, @parsed, @best_item_id, @best_tmdb_id, @confidence, @state, @candidates, @last_error, datetime('now'))
    ON CONFLICT(source_path) DO UPDATE SET
      parsed = excluded.parsed, best_item_id = excluded.best_item_id, best_tmdb_id = excluded.best_tmdb_id,
      confidence = excluded.confidence, state = excluded.state, candidates = excluded.candidates,
      last_error = excluded.last_error, scanned_at = datetime('now')
  `).run(row)
}

// ── Scan run ──────────────────────────────────────────────────────────────────

async function scanFilmFile(lib: LibraryRow, file: string, normalise: boolean, autoAdopt: boolean): Promise<void> {
  scanState.scanned++
  const parsed = bestParse(file)
  const candidates = await resolveFilmMatch(lib.id, parsed)
  const best = candidates[0]
  const base = { library_id: lib.id, media_type: 'film', source_path: file, parsed: JSON.stringify(parsed), candidates: JSON.stringify(candidates) }

  if (autoAdopt && best && best.score >= AUTO_THRESHOLD) {
    try {
      const itemId = await adoptFilm(lib, file, { itemId: best.itemId, tmdbId: best.tmdbId }, normalise)
      upsertCandidate({ ...base, best_item_id: itemId, best_tmdb_id: best.tmdbId ?? null, confidence: best.score, state: 'adopted', last_error: null })
      scanState.adopted++
    } catch (error) {
      upsertCandidate({ ...base, best_item_id: best.itemId ?? null, best_tmdb_id: best.tmdbId ?? null, confidence: best.score, state: 'failed', last_error: error instanceof Error ? error.message : String(error) })
      scanState.failed++
    }
  } else {
    upsertCandidate({ ...base, best_item_id: best?.itemId ?? null, best_tmdb_id: best?.tmdbId ?? null, confidence: best?.score ?? 0, state: 'review', last_error: null })
    scanState.review++
  }
}

/**
 * Scans a series library by grouping episode files per show, resolving one
 * series-level match for the whole group, then — when confident — creating the
 * TVDB/TMDB series a single time and adopting every episode by its SxxEyy.
 * Files that can't be resolved to a concrete episode fall back to review.
 */
async function scanSeriesFiles(lib: LibraryRow, files: string[], normalise: boolean, autoAdopt: boolean): Promise<void> {
  const db = getDb()

  // Group by normalised series title (falling back to the folder for oddities).
  const groups = new Map<string, { title: string; year: number | null; items: Array<{ file: string; sp: SeriesParse }> }>()
  for (const file of files) {
    scanState.scanned++
    const sp = seriesParse(file)
    const norm = normalizeTitle(sp.title)
    const key = norm ? `t:${norm}` : `d:${dirname(file)}`
    let g = groups.get(key)
    if (!g) { g = { title: sp.title, year: sp.year, items: [] }; groups.set(key, g) }
    g.items.push({ file, sp })
    if (!g.year && sp.year) g.year = sp.year
  }

  for (const group of groups.values()) {
    const matches = await resolveSeriesGroupMatches(lib.id, group.title, group.year)
    const best = matches[0]

    // When auto-adopt is on, a confident match adopts the whole group — into an
    // existing library series or a new one created once from TVDB/TMDB. When it's
    // off, every file is parked for review instead.
    let seriesId: number | null = null
    if (autoAdopt && best && best.score >= AUTO_THRESHOLD) {
      try {
        seriesId = best.kind === 'item' ? best.seriesId ?? null : await createSeriesFromMetadata(db, lib.id, { tvdbId: best.tvdbId, tmdbId: best.tmdbId })
      } catch (error) {
        logger.warn('Series creation failed during scan:', error instanceof Error ? error.message : String(error))
        seriesId = null
      }
    }

    for (const { file, sp } of group.items) {
      const candidates = episodeCandidatesFromSeries(db, matches, sp)
      const base = { library_id: lib.id, media_type: 'episode', source_path: file, parsed: JSON.stringify(sp), candidates: JSON.stringify(candidates) }

      if (seriesId != null) {
        try {
          if (sp.season == null || sp.episode == null) throw new Error('missing season/episode')
          const ep = db.prepare('SELECT id FROM episodes WHERE series_id = ? AND season_number = ? AND episode_number = ?').get(seriesId, sp.season, sp.episode) as { id: number } | undefined
          if (!ep) throw new Error(`S${String(sp.season).padStart(2, '0')}E${String(sp.episode).padStart(2, '0')} not in series`)
          queueEpisodeImport(lib, file, ep.id, normalise)
          upsertCandidate({ ...base, best_item_id: ep.id, best_tmdb_id: best?.tmdbId ?? null, confidence: best?.score ?? 0, state: 'adopted', last_error: null })
          scanState.adopted++
        } catch (error) {
          // Show matched but this file's episode didn't resolve — park for review.
          upsertCandidate({ ...base, best_item_id: candidates[0]?.itemId ?? null, best_tmdb_id: candidates[0]?.tmdbId ?? null, confidence: best?.score ?? 0, state: 'review', last_error: error instanceof Error ? error.message : String(error) })
          scanState.review++
        }
      } else {
        const b = candidates[0]
        upsertCandidate({ ...base, best_item_id: b?.itemId ?? null, best_tmdb_id: b?.tmdbId ?? null, confidence: b?.score ?? 0, state: 'review', last_error: null })
        scanState.review++
      }
    }
  }
}

export async function runLibraryScan(opts: { libraryId?: number; normalise?: boolean } = {}): Promise<ScanState> {
  if (scanState.running) return scanState
  const db = getDb()
  scanState = { running: true, scanned: 0, adopted: 0, review: 0, owned: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null }

  try {
    const libs = (db.prepare(
      `SELECT id, name, media_type, db_path FROM libraries WHERE media_type IN ('films','series')${opts.libraryId ? ' AND id = ?' : ''} ORDER BY id ASC`,
    ).all(...(opts.libraryId ? [opts.libraryId] : [])) as LibraryRow[])

    const ownedFilm = ownedFilmPaths()
    const ownedEpisode = ownedEpisodePaths()
    const normalise = Boolean(opts.normalise)
    const autoAdopt = getLibraryScanSettings().autoAdopt

    for (const lib of libs) {
      const isFilm = lib.media_type === 'films'
      const owned = isFilm ? ownedFilm : ownedEpisode
      const root = resolveLibraryRoot(db, lib.id)

      // Collect the untracked, not-yet-resolved files first. A file that was
      // already imported is caught by the owned-set check above, so only an
      // explicit 'ignored' is sticky — a candidate stuck at 'adopted' whose
      // import never landed (still not owned) is retried on the next scan.
      const files: string[] = []
      for (const file of walkVideos(root)) {
        if (owned.has(resolve(file))) { scanState.owned++; continue }
        const prior = db.prepare('SELECT state FROM library_scan_candidates WHERE source_path = ?').get(file) as { state: string } | undefined
        if (prior && prior.state === 'ignored') continue
        files.push(file)
      }

      if (isFilm) {
        for (const file of files) await scanFilmFile(lib, file, normalise, autoAdopt)
      } else {
        await scanSeriesFiles(lib, files, normalise, autoAdopt)
      }
    }
  } catch (error) {
    logger.warn('Library scan failed:', error instanceof Error ? error.message : String(error))
  } finally {
    scanState.running = false
    scanState.finishedAt = new Date().toISOString()
  }
  return scanState
}

// ── Review actions ────────────────────────────────────────────────────────────

export interface GroupSuggestion { kind: 'series' | 'tmdb'; seriesId?: number; tmdbId?: number; tvdbId?: number; title: string; year: number | null; score: number }
export interface SeriesReviewGroup {
  key: string; title: string; year: number | null; library_id: number
  fileCount: number; seasons: number[]; candidateIds: number[]
  files: Array<Record<string, unknown>>; suggestions: GroupSuggestion[]
}

// Episode files are grouped by series so the whole show can be matched in one
// action; film files stay individual. Series-level match suggestions are built
// locally (existing library series + the TMDB/TVDB hits already stored per file)
// so no extra network calls happen when opening the review.
export function getScanReview(): { films: Array<Record<string, unknown>>; series: SeriesReviewGroup[] } {
  const db = getDb()
  const rows = (db.prepare("SELECT * FROM library_scan_candidates WHERE state = 'review' ORDER BY confidence DESC, scanned_at DESC LIMIT 1000").all() as any[])
    .map(row => ({ ...row, parsed: safeJson(row.parsed), candidates: safeJson(row.candidates) }))

  const films = rows.filter(r => r.media_type !== 'episode')
  const episodeRows = rows.filter(r => r.media_type === 'episode')

  const groups = new Map<string, { key: string; title: string; year: number | null; library_id: number; files: any[]; seasons: Set<number> }>()
  for (const r of episodeRows) {
    const parsed = r.parsed as { title?: string; year?: number | null; season?: number | null } | null
    const norm = normalizeTitle(parsed?.title ?? '')
    const key = norm ? `t:${r.library_id}:${norm}` : `d:${dirname(r.source_path)}`
    let g = groups.get(key)
    if (!g) { g = { key, title: parsed?.title || basename(dirname(r.source_path)), year: parsed?.year ?? null, library_id: r.library_id, files: [], seasons: new Set() }; groups.set(key, g) }
    g.files.push(r)
    if (parsed?.season != null) g.seasons.add(parsed.season)
    if (!g.year && parsed?.year) g.year = parsed.year
  }

  const series: SeriesReviewGroup[] = [...groups.values()].map(g => ({
    key: g.key,
    title: g.title,
    year: g.year,
    library_id: g.library_id,
    fileCount: g.files.length,
    seasons: [...g.seasons].sort((a, b) => a - b),
    candidateIds: g.files.map(f => f.id as number),
    files: g.files.sort((a, b) => (a.source_path as string).localeCompare(b.source_path as string)),
    suggestions: buildGroupSuggestions(db, g.library_id, g.title, g.year, g.files),
  })).sort((a, b) => b.fileCount - a.fileCount)

  return { films, series }
}

function buildGroupSuggestions(db: ReturnType<typeof getDb>, libraryId: number, title: string, year: number | null, files: any[]): GroupSuggestion[] {
  const out: GroupSuggestion[] = []

  // Existing library series that the group's title matches.
  for (const s of db.prepare('SELECT id, title, year FROM series WHERE library_id = ?').all(libraryId) as Array<{ id: number; title: string; year: number | null }>) {
    const score = titleYearScore(title, year, s.title, s.year)
    if (score > 0.4) out.push({ kind: 'series', seriesId: s.id, title: s.title, year: s.year, score: Math.min(1, score + 0.1) })
  }

  // TMDB/TVDB hits already stored on each file's per-file candidates — collapse
  // the "Title SxxEyy" episode labels back to one series suggestion each.
  const tmdb = new Map<string, GroupSuggestion>()
  for (const f of files) {
    for (const c of (f.candidates ?? []) as MatchCandidate[]) {
      if (c.kind !== 'tmdb') continue
      const id = c.tmdbId ?? c.tvdbId
      if (id == null) continue
      const key = `${c.tmdbId ?? ''}:${c.tvdbId ?? ''}`
      const cleanTitle = c.title.replace(/\s+S\d{1,2}E\d{1,3}$/i, '')
      const prior = tmdb.get(key)
      if (!prior || c.score > prior.score) tmdb.set(key, { kind: 'tmdb', tmdbId: c.tmdbId, tvdbId: c.tvdbId, title: cleanTitle, year: c.year, score: c.score })
    }
  }
  out.push(...tmdb.values())

  const seen = new Set<string>()
  return out.sort((a, b) => b.score - a.score).filter(s => {
    const key = s.kind === 'series' ? `s${s.seriesId}` : `t${s.tmdbId ?? s.tvdbId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

/**
 * Bulk-adopts every episode file in a series group under one match. Creates the
 * series once (when matching to TMDB/TVDB), then resolves and links each file's
 * concrete episode. Files whose season/episode can't be resolved are marked
 * failed and reported, without blocking the rest.
 */
export async function resolveScanGroup(
  candidateIds: number[],
  choice: { seriesId?: number; tmdbId?: number; tvdbId?: number; normalise?: boolean },
): Promise<{ adopted: number; failed: number; errors: string[] }> {
  const db = getDb()
  const rows = candidateIds
    .map(id => db.prepare('SELECT * FROM library_scan_candidates WHERE id = ?').get(id) as any)
    .filter(r => r && r.media_type === 'episode' && r.state === 'review')
  if (rows.length === 0) return { adopted: 0, failed: 0, errors: ['no episodes to adopt'] }

  const getLibrary = (id: number) => db.prepare('SELECT id, name, media_type, db_path FROM libraries WHERE id = ?').get(id) as LibraryRow | undefined

  // Resolve/create the series once for the whole group; the series' own library
  // owns the episode records (matters if the chosen series lives elsewhere).
  let seriesId = choice.seriesId
  let lib: LibraryRow | undefined
  if (seriesId) {
    const s = db.prepare('SELECT library_id FROM series WHERE id = ?').get(seriesId) as { library_id: number } | undefined
    if (!s) throw new Error('series not found')
    lib = getLibrary(s.library_id)
  } else {
    if (!choice.tmdbId && !choice.tvdbId) throw new Error('no series chosen')
    lib = getLibrary(rows[0].library_id)
    if (!lib) throw new Error('library not found')
    seriesId = await createSeriesFromMetadata(db, lib.id, { tvdbId: choice.tvdbId, tmdbId: choice.tmdbId })
  }
  if (!lib) throw new Error('library not found')

  let adopted = 0, failed = 0
  const errors: string[] = []
  for (const row of rows) {
    try {
      const parsed = safeJson(row.parsed) as { season?: number | null; episode?: number | null } | null
      if (parsed?.season == null || parsed?.episode == null) throw new Error('missing season/episode')
      const ep = db.prepare('SELECT id FROM episodes WHERE series_id = ? AND season_number = ? AND episode_number = ?').get(seriesId, parsed.season, parsed.episode) as { id: number } | undefined
      if (!ep) throw new Error(`S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')} not in series`)
      queueEpisodeImport(lib, row.source_path, ep.id, Boolean(choice.normalise))
      db.prepare("UPDATE library_scan_candidates SET state = 'adopted', best_item_id = ?, last_error = NULL WHERE id = ?").run(ep.id, row.id)
      adopted++
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      db.prepare("UPDATE library_scan_candidates SET state = 'failed', last_error = ? WHERE id = ?").run(msg, row.id)
      errors.push(`${basename(row.source_path)}: ${msg}`)
      failed++
    }
  }
  return { adopted, failed, errors }
}

export async function resolveScanCandidate(
  id: number,
  choice: { itemId?: number; tmdbId?: number; tvdbId?: number; mediaType?: string; tabId?: number; normalise?: boolean },
): Promise<{ success: boolean }> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM library_scan_candidates WHERE id = ?').get(id) as any
  if (!row) throw new Error('candidate not found')

  // Manual match — an explicit item chosen via search, at film / series /
  // series-season / series-episode level (and possibly a different library).
  if (choice.mediaType && choice.itemId && choice.tabId) {
    const target = db.prepare('SELECT id, name, media_type, db_path FROM libraries WHERE id = ?').get(choice.tabId) as LibraryRow | undefined
    if (!target) throw new Error('library not found')
    const hash = createHash('sha1').update(`scan:${row.source_path}`).digest('hex')
    queueMediaImport({
      tabId: target.id, tabName: target.name, dbPath: target.db_path,
      mediaType: choice.mediaType as MatchMediaType, itemId: choice.itemId,
      torrentId: `scan:${hash}`, infoHash: hash,
      sourcePath: row.source_path, copy: false, inPlace: !choice.normalise,
      releaseTitle: basename(row.source_path),
    })
    db.prepare("UPDATE library_scan_candidates SET state = 'adopted', best_item_id = ?, last_error = NULL WHERE id = ?").run(choice.itemId, id)
    return { success: true }
  }

  const lib = db.prepare('SELECT id, name, media_type, db_path FROM libraries WHERE id = ?').get(row.library_id) as LibraryRow | undefined
  if (!lib) throw new Error('library not found')

  let adoptedItemId: number
  if (row.media_type === 'episode') {
    const parsed = safeJson(row.parsed) as { season?: number | null; episode?: number | null } | null
    // An explicit existing-episode choice links straight in; a TVDB/TMDB choice
    // (or fallback) creates the series and resolves the episode.
    adoptedItemId = await adoptEpisode(lib, row.source_path, {
      episodeId: choice.itemId ?? (choice.tmdbId || choice.tvdbId ? undefined : row.best_item_id ?? undefined),
      tmdbId: choice.tmdbId ?? (choice.itemId ? undefined : row.best_tmdb_id ?? undefined),
      tvdbId: choice.tvdbId,
      season: parsed?.season ?? null,
      episode: parsed?.episode ?? null,
    }, Boolean(choice.normalise))
  } else {
    adoptedItemId = await adoptFilm(lib, row.source_path, {
      itemId: choice.itemId ?? row.best_item_id ?? undefined,
      tmdbId: choice.tmdbId ?? row.best_tmdb_id ?? undefined,
    }, Boolean(choice.normalise))
  }
  db.prepare("UPDATE library_scan_candidates SET state = 'adopted', best_item_id = ?, last_error = NULL WHERE id = ?").run(adoptedItemId, id)
  return { success: true }
}

export function ignoreScanCandidate(id: number): { success: boolean } {
  getDb().prepare("UPDATE library_scan_candidates SET state = 'ignored' WHERE id = ?").run(id)
  return { success: true }
}

function safeJson(value: unknown): unknown {
  try { return JSON.parse(String(value ?? 'null')) } catch { return null }
}
