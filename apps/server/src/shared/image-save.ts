import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'
import { createLogger, sanitizeConfigValue } from '@archivist/core'
import { withProviderRetry } from './provider-limiter.js'
import { mediaUrlForPath, nextArtworkVersion } from './library-paths.js'

const logger = createLogger('Artwork')

/**
 * Downloads an image into an entity's media folder and returns the local
 * `/media/...` path the UI can render. When the entity has no folder yet the
 * remote URL is returned unchanged so the artwork still displays.
 */
export async function saveEntityImage(rootPath: string | null | undefined, filename: string, url: string): Promise<{ path: string; local: boolean }> {
  if (!rootPath) return { path: url, local: false }
  try {
    if (!existsSync(rootPath)) mkdirSync(rootPath, { recursive: true })
    const targetPath = join(rootPath, filename)
    const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Archivist/2.0' } })
    const contentType = imgRes.headers['content-type']
    if (contentType && !String(contentType).startsWith('image/')) {
      throw new Error(`URL did not return an image (Content-Type: ${contentType})`)
    }
    writeFileSync(targetPath, imgRes.data)
    // Versioned so replacing an image under its fixed filename repaints the UI
    // instead of leaving the browser on the copy it already cached.
    const localUrl = mediaUrlForPath(targetPath, nextArtworkVersion())
    if (!localUrl) return { path: url, local: false }
    return { path: localUrl, local: true }
  } catch (err) {
    // Folder write failed — keep the remote URL so the selection still sticks.
    if (err instanceof Error && err.message.includes('did not return an image')) throw err
    return { path: url, local: false }
  }
}

export interface ImageCandidate {
  url: string
  source: string
  type: string
  language: string
  width?: number
  height?: number
}

export type FanartArtwork = Record<string, Array<{ url: string; lang?: string; season?: string }>>

/** Why a Fanart lookup came back empty, phrased for the metadata editor. */
function fanartReason(error: unknown, subject: string): string {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined
  if (status === 404) return `Fanart.tv has no artwork for ${subject}`
  if (status === 401 || status === 403) {
    return 'Fanart.tv rejected the API key — check FANART_API_KEY is a project key, not a personal one'
  }
  if (status) return `Fanart.tv returned HTTP ${status}`
  return `Fanart.tv is unreachable (${error instanceof Error ? error.message : String(error)})`
}

/**
 * Fanart.tv lookup over a list of ids, in order, returning the first hit. A 404
 * only rules out that one id, never the provider.
 */
async function fanartLookup(base: string, ids: Array<string | number | null | undefined>, subject: string): Promise<{ data: FanartArtwork | null; warning?: string }> {
  const apiKey = sanitizeConfigValue(process.env.FANART_API_KEY)
  if (!apiKey) return { data: null, warning: 'Fanart.tv is not configured — set FANART_API_KEY' }
  const usable = ids.filter((id): id is string | number => id !== null && id !== undefined && String(id).length > 0)
  if (!usable.length) return { data: null, warning: `No provider id to look ${subject} up by on Fanart.tv` }

  let lastError: unknown
  for (const id of usable) {
    try {
      const res = await withProviderRetry('fanart', () => axios.get(`${base}/${id}`, { params: { api_key: apiKey }, timeout: 10000 }))
      return { data: res.data as FanartArtwork }
    } catch (err) {
      lastError = err
      logger.warn(`Fanart.tv lookup failed for ${subject} (id ${id}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { data: null, warning: fanartReason(lastError, subject) }
}

/** Fanart.tv artwork for a TV show, by TVDB id. */
export async function getFanartTvResult(tvdbId: number, title = 'this series'): Promise<{ data: FanartArtwork | null; warning?: string }> {
  const base = process.env.FANART_TV_BASE_URL ?? 'https://webservice.fanart.tv/v3/tv'
  return fanartLookup(base, [tvdbId], title)
}

/**
 * Fanart.tv artwork for a film. Its movie records are keyed by TMDB *or* IMDb
 * id, and plenty of entries only carry the IMDb one, so a miss on the TMDB id
 * is retried against the IMDb id before giving up.
 */
export async function getFanartMovie(
  ids: { tmdbId?: number | string | null; imdbId?: string | null },
  title = 'this film',
): Promise<{ data: FanartArtwork | null; warning?: string }> {
  const base = process.env.FANART_MOVIES_BASE_URL ?? 'https://webservice.fanart.tv/v3/movies'
  return fanartLookup(base, [ids.tmdbId, ids.imdbId], title)
}

// ── Candidate paging ─────────────────────────────────────────────────────────
//
// Providers hand back everything they have in one response (Fanart.tv routinely
// has 40+ posters for a popular film), so the editor pages through a cached
// sweep rather than making each provider call again per page.

/** Page size when the request doesn't ask for one — four grid rows. */
const DEFAULT_PAGE = 24
const MAX_PAGE = 100
/** Ceiling on one cached sweep, so a pathological provider can't grow the heap. */
const MAX_CANDIDATES = 500
const SWEEP_TTL_MS = 120_000
const MAX_SWEEPS = 200

export interface ImageCandidatePage<T> {
  items: T[]
  /** Offset to ask for next, or null at the end of the list. */
  nextOffset: number | null
  /** Candidates matching the current filters. */
  total: number
  /**
   * Every provider in the sweep with how much art it offers, counted before the
   * source filter so the editor's chips stay put while one is selected.
   */
  sources: Array<{ source: string; count: number }>
  /** Why a provider contributed nothing, so a missing source is explicable. */
  warnings: string[]
}

/** What one provider sweep produced: its art, and why any provider came up empty. */
export interface ImageSweepResult<T> {
  items: T[]
  warnings?: string[]
}

const sweeps = new Map<string, { at: number; items: unknown[]; warnings: string[] }>()

/**
 * Run a provider sweep, reusing a recent one for the same key. Sweeps that found
 * nothing are never cached: a provider that failed this minute may answer the
 * next, and the caller should see a fresh reason each time.
 */
export async function cachedImageSweep<T>(key: string, load: () => Promise<ImageSweepResult<T>>): Promise<Required<ImageSweepResult<T>>> {
  const hit = sweeps.get(key)
  if (hit && Date.now() - hit.at < SWEEP_TTL_MS) return { items: hit.items as T[], warnings: hit.warnings }
  const { items, warnings = [] } = await load()
  if (items.length) {
    sweeps.set(key, { at: Date.now(), items, warnings })
    if (sweeps.size > MAX_SWEEPS) {
      const oldest = [...sweeps.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, sweeps.size - MAX_SWEEPS)
      for (const [staleKey] of oldest) sweeps.delete(staleKey)
    }
  }
  return { items, warnings }
}

/** Drop repeats — providers overlap, and Fanart lists the same art under several types. */
function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) continue
    seen.add(item.url)
    unique.push(item)
    if (unique.length >= MAX_CANDIDATES) break
  }
  return unique
}

/**
 * Slice a full candidate sweep into the page `offset`/`limit` asked for,
 * narrowed to `source` when the editor is filtering by provider.
 */
export function imageCandidatePage<T extends { url: string; source?: string }>(
  all: T[],
  query: { offset?: unknown; limit?: unknown; source?: unknown },
  warnings: string[] = [],
): ImageCandidatePage<T> {
  const positive = (value: unknown, fallback: number) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
  }
  const offset = positive(query.offset, 0)
  const limit = Math.min(Math.max(positive(query.limit, DEFAULT_PAGE), 1), MAX_PAGE)
  const unique = dedupeByUrl(all)

  const counts = new Map<string, number>()
  for (const item of unique) {
    const source = item.source ?? 'Unknown'
    counts.set(source, (counts.get(source) ?? 0) + 1)
  }
  const sources = [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count)

  const wanted = typeof query.source === 'string' ? query.source.trim().toLowerCase() : ''
  const matching = !wanted || wanted === 'all'
    ? unique
    : unique.filter(item => (item.source ?? 'Unknown').toLowerCase() === wanted)

  const items = matching.slice(offset, offset + limit)
  const next = offset + items.length
  return { items, nextOffset: next < matching.length ? next : null, total: matching.length, sources, warnings }
}

/** True when the request wants every language, which is also the default. */
export function isAllLanguages(language: string | undefined): boolean {
  const wanted = (language ?? '').trim().toLowerCase()
  return !wanted || wanted === 'all'
}

/**
 * Language filter shared by the provider sweeps. No language (or `all`) keeps
 * everything — the editor's language picker narrows it, it does not have to.
 */
export function languageFilter(language: string | undefined): (imageLanguage: string | null | undefined) => boolean {
  if (isAllLanguages(language)) return () => true
  const wanted = (language ?? '').trim().toLowerCase()
  return imageLanguage => {
    const actual = (imageLanguage ?? '').toLowerCase()
    // Language-less art (plain posters, textless backdrops) suits every choice.
    return actual === wanted || actual === '' || actual === 'null'
  }
}
