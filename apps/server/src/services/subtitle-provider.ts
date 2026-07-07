/**
 * Subtitle Provider — searches and downloads subtitles from OpenSubtitles.
 *
 * Uses the OpenSubtitles REST API (v2) at https://api.opensubtitles.com/api/v1
 * Supports search by IMDB ID or text query, with language filtering.
 * Downloaded subtitles are placed next to the media file.
 */

import axios from 'axios'
import { writeFileSync, existsSync } from 'node:fs'
import { dirname, basename, extname, join } from 'node:path'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'

const logger = createLogger('SubtitleProvider')

const OS_API_BASE = 'https://api.opensubtitles.com/api/v1'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubtitleConfig {
  enabled: boolean
  provider: string           // 'opensubtitles'
  apiKey: string             // OpenSubtitles API key
  appName: string            // Registered app name (used as User-Agent)
  username: string           // OpenSubtitles username
  password: string           // OpenSubtitles password
  defaultLanguage: string    // ISO 639-1 code (e.g. 'en')
  autoAcquire: boolean       // fetch subtitles automatically after organize
  hearingImpaired: boolean   // include hearing-impaired subs
  forcedOnly: boolean        // only fetch forced subs
}

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  enabled: false,
  provider: 'opensubtitles',
  apiKey: '',
  appName: '',
  username: '',
  password: '',
  defaultLanguage: 'en',
  autoAcquire: false,
  hearingImpaired: false,
  forcedOnly: false,
}

export interface SubtitleSearchResult {
  id: string
  fileName: string
  language: string
  downloadCount: number
  hearingImpaired: boolean
  foreignPartsOnly: boolean  // "forced"
  rating: number
  uploadDate: string
  fileId: number
  featureDetails?: {
    title?: string
    year?: number
    episodeNumber?: number
    seasonNumber?: number
  }
}

export interface SubtitleDownloadResult {
  success: boolean
  message: string
  filePath?: string
}

// ── Settings helpers ─────────────────────────────────────────────────────────

export function getSubtitleConfig(): SubtitleConfig {
  try {
    const db = getDb()
    const row = db.prepare("SELECT value FROM app_settings WHERE library_id = 0 AND key = 'subtitles'").get() as { value: string } | undefined
    if (!row) return DEFAULT_SUBTITLE_CONFIG
    return { ...DEFAULT_SUBTITLE_CONFIG, ...JSON.parse(row.value) }
  } catch {
    return DEFAULT_SUBTITLE_CONFIG
  }
}

// ── API helpers ──────────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null

async function login(cfg: SubtitleConfig): Promise<string> {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 300_000) {
    return cachedToken.token
  }

  if (!cfg.username || !cfg.password) {
    throw new Error('OpenSubtitles username and password are required. Set them in Settings > Subtitles.')
  }

  const res = await axios.post(`${OS_API_BASE}/login`, {
    username: cfg.username,
    password: cfg.password,
  }, {
    headers: getHeaders(cfg.apiKey, cfg.appName),
    timeout: 15000,
  })

  const token = res.data?.token
  if (!token) throw new Error('Login failed: no token returned')

  // Token is valid for 24 hours
  cachedToken = { token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }
  logger.info('OpenSubtitles login successful')
  return token
}

function getHeaders(apiKey: string, appName?: string, token?: string) {
  // OpenSubtitles requires User-Agent in format "appname vX.Y.Z"
  const ua = appName ? (appName.match(/v\d/) ? appName : `${appName} v1.0.0`) : 'archivist v1.0.0'
  const headers: Record<string, string> = {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': ua,
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

// ── Search ───────────────────────────────────────────────────────────────────

export async function searchSubtitles(opts: {
  imdbId?: string
  tmdbId?: number
  query?: string
  language?: string
  seasonNumber?: number
  episodeNumber?: number
  hearingImpaired?: boolean
  forcedOnly?: boolean
  config?: SubtitleConfig
}): Promise<SubtitleSearchResult[]> {
  const cfg = opts.config ?? getSubtitleConfig()
  if (!cfg.apiKey) {
    throw new Error('OpenSubtitles API key is not configured. Set it in Settings > Subtitles.')
  }

  const params: Record<string, string | number> = {}

  if (opts.imdbId) {
    // OpenSubtitles expects numeric IMDB ID without 'tt' prefix
    params.imdb_id = opts.imdbId.replace(/^tt/, '')
  } else if (opts.tmdbId) {
    params.tmdb_id = opts.tmdbId
  } else if (opts.query) {
    params.query = opts.query
  }

  const lang = opts.language ?? cfg.defaultLanguage
  if (lang) params.languages = lang

  if (opts.seasonNumber !== undefined) params.season_number = opts.seasonNumber
  if (opts.episodeNumber !== undefined) params.episode_number = opts.episodeNumber

  if (opts.hearingImpaired !== undefined) {
    params.hearing_impaired = opts.hearingImpaired ? 'include' : 'exclude'
  } else if (!cfg.hearingImpaired) {
    params.hearing_impaired = 'exclude'
  }

  if (opts.forcedOnly ?? cfg.forcedOnly) {
    params.foreign_parts_only = 'include'
  }

  try {
    // Search endpoint only requires Api-Key, no auth token needed
    const res = await axios.get(`${OS_API_BASE}/subtitles`, {
      params,
      headers: getHeaders(cfg.apiKey, cfg.appName),
      timeout: 15000,
    })

    const results: SubtitleSearchResult[] = (res.data.data ?? []).map((item: any) => {
      const attrs = item.attributes ?? {}
      const files = attrs.files ?? []
      const file = files[0]
      return {
        id: String(item.id),
        fileName: file?.file_name ?? attrs.release ?? 'Unknown',
        language: attrs.language ?? lang,
        downloadCount: attrs.download_count ?? 0,
        hearingImpaired: attrs.hearing_impaired ?? false,
        foreignPartsOnly: attrs.foreign_parts_only ?? false,
        rating: attrs.ratings ?? 0,
        uploadDate: attrs.upload_date ?? '',
        fileId: file?.file_id ?? 0,
        featureDetails: attrs.feature_details ? {
          title: attrs.feature_details.title,
          year: attrs.feature_details.year,
          episodeNumber: attrs.feature_details.episode_number,
          seasonNumber: attrs.feature_details.season_number,
        } : undefined,
      }
    })

    logger.info(`Subtitle search returned ${results.length} results`)
    return results
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status
      const body = err.response.data
      const detail = typeof body === 'object' ? JSON.stringify(body) : String(body ?? '')
      logger.error(`OpenSubtitles search failed [${status}]: ${detail}`)
      if (status === 401) throw new Error('Invalid OpenSubtitles API key')
      if (status === 403) throw new Error(`OpenSubtitles API key rejected (403). Ensure your API key is active and matches your registered app name. Detail: ${detail}`)
      if (status === 429) throw new Error('OpenSubtitles rate limit exceeded — try again later')
      throw new Error(`OpenSubtitles API error: ${status} ${err.response.statusText}`)
    }
    throw err
  }
}

// ── Download ─────────────────────────────────────────────────────────────────

export async function downloadSubtitle(
  fileId: number,
  mediaFilePath: string,
  language?: string,
  config?: SubtitleConfig,
): Promise<SubtitleDownloadResult> {
  const cfg = config ?? getSubtitleConfig()
  if (!cfg.apiKey) {
    return { success: false, message: 'OpenSubtitles API key is not configured' }
  }

  if (!mediaFilePath || !existsSync(mediaFilePath)) {
    return { success: false, message: `Media file not found: ${mediaFilePath}` }
  }

  try {
    // Step 1: Request download link from OpenSubtitles
    // Try with login token if credentials available, otherwise just use Api-Key
    let token: string | undefined
    if (cfg.username && cfg.password) {
      try {
        token = await login(cfg)
      } catch (loginErr) {
        logger.warn(`Login failed, attempting download with Api-Key only: ${loginErr instanceof Error ? loginErr.message : String(loginErr)}`)
      }
    }
    let dlRes
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        dlRes = await axios.post(`${OS_API_BASE}/download`, {
          file_id: fileId,
        }, {
          headers: { ...getHeaders(cfg.apiKey, cfg.appName, token), 'Accept': 'application/json' },
          timeout: 15000,
        })
        break
      } catch (dlErr) {
        if (attempt === 2) throw dlErr
        const status = axios.isAxiosError(dlErr) ? dlErr.response?.status : 0
        if (status && status !== 503 && status !== 429) throw dlErr
        logger.info(`Download endpoint returned ${status}, retrying (${attempt + 1}/3)...`)
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    if (!dlRes) throw new Error('Download request failed after retries')

    const downloadLink = dlRes.data?.link
    if (!downloadLink) {
      return { success: false, message: 'No download link returned from OpenSubtitles' }
    }

    // Step 2: Download the subtitle file content (with retry for flaky CDN)
    let subRes
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        subRes = await axios.get(downloadLink, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': cfg.appName || 'archivist v1.0' },
        })
        break
      } catch (dlErr) {
        if (attempt === 2) throw dlErr
        logger.info(`Subtitle download attempt ${attempt + 1} failed, retrying...`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    if (!subRes) throw new Error('Download failed after retries')

    // Step 3: Determine output path — place next to media file
    const dir = dirname(mediaFilePath)
    const base = basename(mediaFilePath, extname(mediaFilePath))
    const lang = language ?? cfg.defaultLanguage ?? 'en'

    // Use .lang.srt naming convention (e.g. Movie.en.srt)
    const subPath = join(dir, `${base}.${lang}.srt`)

    writeFileSync(subPath, Buffer.from(subRes.data))
    logger.info(`Subtitle downloaded: ${basename(subPath)}`)

    return { success: true, message: `Downloaded subtitle: ${basename(subPath)}`, filePath: subPath }
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status
      const url = err.config?.url || ''
      const body = err.response.data ? (typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : String(err.response.data)) : ''
      logger.error(`Subtitle download failed [${status}] url=${url} body=${body.substring(0, 200)}`)
      if (status === 406) return { success: false, message: 'Download quota exceeded for this period' }
      if (status === 429) return { success: false, message: 'Rate limit exceeded — try again later' }
      if (status === 503) return { success: false, message: 'OpenSubtitles download service temporarily unavailable — try again in a moment' }
      return { success: false, message: `Download failed: ${status} ${err.response.statusText}` }
    }
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`Subtitle download failed: ${msg}`)
    return { success: false, message: msg }
  }
}

// ── Auto-acquire (for post-organize hook) ────────────────────────────────────

export async function autoAcquireSubtitle(
  mediaFilePath: string,
  opts: {
    imdbId?: string
    tmdbId?: number
    title?: string
    language?: string
    seasonNumber?: number
    episodeNumber?: number
  },
): Promise<SubtitleDownloadResult> {
  const cfg = getSubtitleConfig()

  if (!cfg.enabled || !cfg.autoAcquire) {
    return { success: true, message: 'Auto-acquire disabled' }
  }

  if (!cfg.apiKey) {
    return { success: false, message: 'OpenSubtitles API key not configured' }
  }

  try {
    const results = await searchSubtitles({
      imdbId: opts.imdbId,
      tmdbId: opts.tmdbId,
      query: opts.title,
      language: opts.language ?? cfg.defaultLanguage,
      seasonNumber: opts.seasonNumber,
      episodeNumber: opts.episodeNumber,
      config: cfg,
    })

    if (results.length === 0) {
      return { success: true, message: 'No subtitles found' }
    }

    // Pick the best result — highest download count (most popular/reliable)
    const best = results.sort((a, b) => b.downloadCount - a.downloadCount)[0]!
    return await downloadSubtitle(
      best.fileId,
      mediaFilePath,
      opts.language ?? cfg.defaultLanguage,
      cfg,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: msg }
  }
}
