import axios from 'axios'
import * as cheerio from 'cheerio'
import { Agent } from 'https'
import type { IndexerInstance } from '../registry/indexer-store.js'
import type { IndexerDefinition } from './definition-loader.js'

const httpsAgent = new Agent({ rejectUnauthorized: false })
import { createLogger } from '../../utils/logger.js'
import {
  TIMEOUT_LONG,
  FLARE_MAX_TIMEOUT,
  FLARE_AXIOS_TIMEOUT,
  FLARE_SESSION_TTL_MS,
  MAX_BASE_URLS_TO_TRY,
} from '../../utils/constants.js'

const logger = createLogger('Search')

// ── Prowlarr-style Robust Requester ──────────────────────────────────────────

class ProwlarrRequester {
  private static userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

  static async request(url: string, indexer: IndexerInstance, flareUrl?: string): Promise<string> {
    const useFlare = indexer.useFlareSolverr && !!flareUrl
    
    if (useFlare) {
      try {
        return await this.fetchWithFlare(url, flareUrl!, indexer.definitionId)
      } catch (err) {
        logger.warn(`${indexer.name} FlareSolverr failed, falling back to direct request: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const res = await axios.get(url, {
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      timeout: TIMEOUT_LONG,
      httpsAgent,
      validateStatus: (status) => status < 500 // Accept 403/404 to handle them manually
    })

    if (res.status === 403 || res.status === 429) {
      throw new Error(`Indexer blocked request (HTTP ${res.status}). Try enabling FlareSolverr for this indexer.`)
    }

    if (res.status >= 400) {
      throw new Error(`Indexer returned error HTTP ${res.status}`)
    }

    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  }

  private static async fetchWithFlare(url: string, flareUrl: string, definitionId: string): Promise<string> {
    const fsBase = flareUrl.replace(/\/$/, '')
    let sessionId = getFsSession(definitionId)

    const payload: any = { cmd: 'request.get', url, maxTimeout: FLARE_MAX_TIMEOUT }
    if (sessionId) payload.session = sessionId

    try {
      const res = await axios.post(`${fsBase}/v1`, payload, { timeout: FLARE_AXIOS_TIMEOUT, httpsAgent })
      
      if (res.data.status === 'error' && res.data.message?.includes('session')) {
        const create = await axios.post(`${fsBase}/v1`, { cmd: 'sessions.create' }, { httpsAgent })
        sessionId = create.data.session
        setFsSession(definitionId, sessionId!)
        payload.session = sessionId
        const retry = await axios.post(`${fsBase}/v1`, payload, { timeout: FLARE_AXIOS_TIMEOUT, httpsAgent })
        return retry.data.solution?.response || ''
      }

      if (res.data.status === 'error') {
        throw new Error(`FlareSolverr error: ${res.data.message}`)
      }

      return res.data.solution?.response || ''
    } catch (err) {
      // If session failed, try one more time without session
      const res = await axios.post(`${fsBase}/v1`, { cmd: 'request.get', url, maxTimeout: FLARE_MAX_TIMEOUT }, { timeout: FLARE_AXIOS_TIMEOUT, httpsAgent })
      if (res.data.status === 'error') throw new Error(res.data.message)
      return res.data.solution?.response || ''
    }
  }
}

export interface IndexerSearchResult {
  guid: string
  title: string
  downloadUrl: string
  size?: number
  seeders?: number
  leechers?: number
  publishDate?: string
  indexerName: string
}

interface SearchConfig {
  paths: SearchPath[]
  rows?: { selector: string; attribute?: string }
  fields: Record<string, FieldDef>
  response?: { type?: string }
}

interface SearchPath {
  path: string
  response?: { type?: string }
}

interface FieldDef {
  selector?: string
  attribute?: string
  text?: string
  filters?: FilterDef[]
  optional?: boolean
}

interface FilterDef {
  name: string
  args: string[]
}

// FlareSolverr session cache with TTL
interface FsSession {
  sessionId: string
  createdAt: number
}
const fsSessions = new Map<string, FsSession>()

function getFsSession(key: string): string | undefined {
  const entry = fsSessions.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.createdAt > FLARE_SESSION_TTL_MS) {
    fsSessions.delete(key)
    return undefined
  }
  return entry.sessionId
}

function setFsSession(key: string, sessionId: string): void {
  fsSessions.set(key, { sessionId, createdAt: Date.now() })
}

export async function searchIndexer(
  indexer: IndexerInstance,
  definition: IndexerDefinition,
  query: string,
  flareSolverrUrl?: string
): Promise<IndexerSearchResult[]> {
  const searchConfig = definition.search as unknown as SearchConfig | undefined
  if (!searchConfig || !searchConfig.paths) return []

  const defAny = definition as unknown as Record<string, unknown>
  const baseUrls = [
    indexer.baseUrl,
    ...((defAny.links as string[] | undefined) ?? []),
    ...((defAny.legacylinks as string[] | undefined) ?? []),
  ].filter((u, i, a): u is string => !!u && a.indexOf(u) === i)

  if (baseUrls.length === 0) return []

  const searchPath = searchConfig.paths.find(p =>
    p.path.includes('{Keywords}') ||
    p.path.includes('{{ .Keywords }}') ||
    p.path.includes('{{ if .Keywords }}')
  ) ?? searchConfig.paths[0]

  for (const currentBase of baseUrls.slice(0, MAX_BASE_URLS_TO_TRY)) {
    try {
      const resolvedPath = resolveTemplate(searchPath.path, query, indexer, definition)
      let fullUrl = resolvedPath.startsWith('http')
        ? resolvedPath
        : `${currentBase.replace(/\/$/, '')}/${resolvedPath.replace(/^\//, '')}`

      const protocolMatch = fullUrl.match(/^https?:\/\//)
      const protocol = protocolMatch ? protocolMatch[0] : ''
      fullUrl = protocol + fullUrl.slice(protocol.length).replace(/\/\/+/g, '/')

      logger.info(`${indexer.name} trying: ${fullUrl}`)

      const html = await ProwlarrRequester.request(fullUrl, indexer, flareSolverrUrl)

      if (
        html.includes('DNS_PROBE_FINISHED_NXDOMAIN') ||
        html.includes('Copyright 2017 The Chromium Authors') ||
        (html.length < 500 && html.includes('Error'))
      ) {
        continue
      }

      const isJson = (searchPath.response?.type === 'json') || fullUrl.includes('.json')
      let results: IndexerSearchResult[] = isJson
        ? parseJsonResults(html, searchConfig, query, currentBase, indexer.name, indexer, definition)
        : parseHtmlResults(html, searchConfig, query, currentBase, indexer.name, indexer, definition)

      logger.info(`${indexer.name} found ${results.length} results`)

      // ── Follow Details Page Logic ──────────────────────────────────────────
      // If results have no valid download URL (likely just a path to details), 
      // follow the first few to see if we can get a magnet.
      const def = definition as any
      if (results.length > 0 && (def.download?.selectors || def.download?.selector)) {
        const needsFollow = results.every(r => !r.downloadUrl.startsWith('magnet:') && !r.downloadUrl.endsWith('.torrent'))
        if (needsFollow) {
          logger.info(`${indexer.name} results need detail page follow-up`)
          results = await Promise.all(results.slice(0, 10).map(async (res) => {
            try {
              const detailHtml = await ProwlarrRequester.request(res.downloadUrl, indexer, flareSolverrUrl)
              const $d = cheerio.load(detailHtml)
              logger.info(`${indexer.name} detail page HTML length: ${detailHtml.length} for ${res.title}`)
              
              const selectors = def.download.selectors || (def.download.selector ? [{ selector: def.download.selector, attribute: def.download.attribute }] : [])
              let extractedLink: string | undefined = undefined
              
              for (const ds of selectors) {
                const selector = resolveTemplate(ds.selector, query, indexer, definition)
                const el = $d(selector)
                logger.debug(`${indexer.name} trying download selector: "${selector}", found ${el.length} matches`)
                
                let link = ds.attribute ? el.attr(ds.attribute) : el.text().trim()
                if (link) {
                  if (link.startsWith('/') && !link.startsWith('//')) {
                    link = `${currentBase.replace(/\/$/, '')}${link}`
                  }
                  
                  if (link.startsWith('magnet:')) {
                    logger.info(`${indexer.name} successfully extracted magnet link: ${link.slice(0, 50)}...`)
                    extractedLink = link
                    break // Prefer magnets above all else
                  } else if (link.includes('.torrent') && !extractedLink) {
                    extractedLink = link
                  }
                }
              }

              // Fallback: search for any magnet or .torrent link if nothing found or we only have a torrent link
              if (!extractedLink || !extractedLink.startsWith('magnet:')) {
                const anyMagnet = $d('a[href^="magnet:?xt="]').first().attr('href')
                if (anyMagnet) {
                  logger.info(`${indexer.name} successfully extracted fallback magnet: ${anyMagnet.slice(0, 50)}...`)
                  extractedLink = anyMagnet
                } else if (!extractedLink) {
                  const anyTorrent = $d('a[href$=".torrent"]').first().attr('href')
                  if (anyTorrent) {
                    let torrentUrl = anyTorrent
                    if (torrentUrl.startsWith('/') && !torrentUrl.startsWith('//')) {
                      torrentUrl = `${currentBase.replace(/\/$/, '')}${torrentUrl}`
                    }
                    logger.info(`${indexer.name} successfully extracted fallback torrent: ${torrentUrl.slice(0, 50)}...`)
                    extractedLink = torrentUrl
                  }
                }
              }

              if (extractedLink) {
                return { ...res, downloadUrl: extractedLink }
              }

              logger.warn(`${indexer.name} failed to extract download link from details page for ${res.title}`)
            } catch (e) {
              logger.error(`${indexer.name} detail follow failed for ${res.title}:`, e instanceof Error ? e.message : String(e))
            }
            return res
          }))
        }
      }

      if (results.length > 0) {
        logger.info(`${indexer.name} success: ${results.length} results from ${fullUrl}`)
        return results
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`${indexer.name} error on ${currentBase}: ${msg}`)
    }
  }

  return []
}

// Helper removed as it's now in ProwlarrRequester
// async function fetchWithFlare...

function parseJsonResults(
  html: string,
  searchConfig: SearchConfig,
  query: string,
  currentBase: string,
  indexerName: string,
  indexer: IndexerInstance,
  definition: IndexerDefinition
): IndexerSearchResult[] {
  const data: unknown = JSON.parse(html)
  const fields = searchConfig.fields

  let rowSelector = resolveTemplate(searchConfig.rows?.selector ?? '$', query, indexer, definition)
  rowSelector = rowSelector.replace(/^\$/, '').replace(/^\./, '')

  let parentRows: Record<string, unknown>[]
  if (!rowSelector) {
    parentRows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [data as Record<string, unknown>]
  } else {
    const segments = rowSelector.split('.')
    let current: unknown = data
    for (const segment of segments) {
      if (segment.includes(':')) break
      current = (current as Record<string, unknown>)?.[segment]
    }
    parentRows = Array.isArray(current)
      ? (current as Record<string, unknown>[])
      : (current ? [current as Record<string, unknown>] : [])
  }

  const results: IndexerSearchResult[] = []
  for (const parentRow of parentRows) {
    const subSelector = searchConfig.rows?.attribute
    const rows = subSelector
      ? ((parentRow[subSelector] as Record<string, unknown>[] | undefined) ?? [parentRow])
      : [parentRow]
    const rowsArray = Array.isArray(rows) ? rows : [rows]

    for (const row of rowsArray) {
      const context = { ...row, '..': parentRow }
      const title = extractFieldJson(context, fields.title ?? fields.title_default)
      let download = extractFieldJson(context, fields.download)
        ?? extractFieldJson(context, fields.magnet)
        ?? extractFieldJson(context, fields.details)

      if (!download) {
        const infohash = extractFieldJson(context, fields.infohash ?? fields.info_hash)
        if (infohash) download = `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(title ?? query)}`
      }

      if (title && download) {
        if (download.startsWith('/')) download = `${currentBase.replace(/\/$/, '')}${download}`
        results.push({
          guid: download,
          title,
          downloadUrl: download,
          seeders: parseInt(extractFieldJson(context, fields.seeders) ?? '0'),
          leechers: parseInt(extractFieldJson(context, fields.leechers) ?? '0'),
          size: parseSize(extractFieldJson(context, fields.size)),
          indexerName,
        })
      }
    }
  }
  return results
}

function parseHtmlResults(
  html: string,
  searchConfig: SearchConfig,
  query: string,
  currentBase: string,
  indexerName: string,
  indexer: IndexerInstance,
  definition: IndexerDefinition
): IndexerSearchResult[] {
  const $ = cheerio.load(html)
  const fields = searchConfig.fields

  let rowSelector = resolveTemplate(searchConfig.rows?.selector ?? 'table tr', query, indexer, definition)
  rowSelector = rowSelector.replace(/{{.*?}}/g, '').replace(/:contains\(\)/g, '').replace(/^\$/, '')

  let matches = $(rowSelector)
  if (matches.length === 0) {
    matches = $('table.table-list > tbody > tr, table.data > tbody > tr, .table-list tr')
  }

  const results: IndexerSearchResult[] = []
  matches.each((_, el) => {
    const title = extractFieldCheerio($, el, fields.title ?? fields.title_default)
    let download = extractFieldCheerio($, el, fields.download)
      ?? extractFieldCheerio($, el, fields.magnet)
      ?? $(el).find('a[href^="magnet:?xt="]').attr('href')
      ?? extractFieldCheerio($, el, fields.details)

    if (title && download) {
      if (download.startsWith('/')) download = `${currentBase.replace(/\/$/, '')}${download}`
      results.push({
        guid: download,
        title,
        downloadUrl: download,
        seeders: parseInt(extractFieldCheerio($, el, fields.seeders) ?? '0'),
        leechers: parseInt(extractFieldCheerio($, el, fields.leechers) ?? '0'),
        size: parseSize(extractFieldCheerio($, el, fields.size)),
        indexerName,
      })
    }
  })
  return results
}

function resolveTemplate(tpl: string, query: string, indexer: IndexerInstance, definition?: IndexerDefinition): string {
  if (!tpl) return ''
  let result = tpl

  const config: Record<string, string> = {
    sitelink: indexer.baseUrl || (definition?.urls?.[0] ?? ''),
  }
  if (definition?.settings) {
    for (const s of (definition.settings as Array<{ name: string; default: unknown }> )) {
      if (s.name && s.default !== undefined) config[s.name] = String(s.default)
    }
  }
  if (indexer.apiKey) config.apikey = indexer.apiKey
  if (indexer.username) config.username = indexer.username

  let changed = true
  let iterations = 0
  while (changed && iterations < 10) {
    const before = result
    result = result.replace(/{{ if (.*?) }}(.*?)(?:{{ else }}(.*?))?{{ end }}/gi, (_match, condition: string, p1: string, p2: string) => {
      let isTrue = false
      const cond = condition.trim()
      if (cond.includes('.Keywords')) isTrue = !!query
      else if (cond.includes('.Config.')) {
        const varName = cond.match(/\.Config\.([\w-]+)/)?.[1]
        if (varName) isTrue = !!config[varName]
      } else {
        isTrue = !!query
      }
      return isTrue ? p1 : (p2 ?? '')
    })
    changed = result !== before
    iterations++
  }

  const indexerAny = indexer as unknown as Record<string, unknown>
  const sort = (indexerAny.sort as string | undefined) ?? config.sort ?? 'seeders'
  const type = (indexerAny.type as string | undefined) ?? config.type ?? 'desc'
  const apiurl = config.apiurl ?? (indexer.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')

  result = result
    .replace(/{{ \.Keywords }}/g, encodeURIComponent(query))
    .replace(/{Keywords}/g, encodeURIComponent(query))
    .replace(/{query}/g, encodeURIComponent(query))
    .replace(/{{ \.Config\.apiurl }}/g, apiurl)
    .replace(/{{ \.Config\.sort }}/g, sort)
    .replace(/{{ \.Config\.type }}/g, type)
    .replace(/{{ \.Config\.sitelink }}/g, config.sitelink)
    .replace(/{{ join \.Categories "," }}/g, (indexer.categories ?? []).join(','))
    .replace(/{{ \.False }}/g, 'false')
    .replace(/{{ \.True }}/g, 'true')

  for (const [k, v] of Object.entries(config)) {
    result = result.replace(new RegExp(`{{ \\.Config\\.${k} }}`, 'gi'), v)
  }

  return result.replace(/{{.*?}}/g, '').trim()
}

function extractFieldJson(row: Record<string, unknown>, field: FieldDef | undefined): string | undefined {
  if (!field) return undefined
  if (field.text !== undefined && !String(field.text).includes('{{')) return applyFilters(String(field.text), field.filters)

  let selector = field.selector
  if (!selector) return undefined

  let current: unknown = row
  if (selector.startsWith('..')) {
    current = (row as Record<string, unknown>)['..']
    selector = selector.slice(2)
    if (selector.startsWith('.')) selector = selector.slice(1)
  }

  if (selector) {
    for (const segment of selector.split('.')) {
      current = (current as Record<string, unknown>)?.[segment]
    }
  }

  return current !== undefined ? applyFilters(String(current), field.filters) : undefined
}

function extractFieldCheerio($: cheerio.CheerioAPI, row: any, field: FieldDef | undefined): string | undefined {
  if (!field) return undefined
  if (field.text !== undefined && !String(field.text).includes('{{')) return applyFilters(String(field.text), field.filters)

  const selector = field.selector
  const el = selector ? $(row).find(selector) : $(row)
  if (!el.length && field.optional !== true) return undefined

  const val = field.attribute ? el.attr(field.attribute) : el.text().trim()
  return val ? applyFilters(val, field.filters) : undefined
}

function applyFilters(value: string, filters: FilterDef[] | undefined): string {
  if (!filters || !Array.isArray(filters)) return value
  let result = value
  for (const f of filters) {
    try {
      const name = f.name.toLowerCase()
      if (name === 'urldecode') result = decodeURIComponent(result)
      else if (name === 'split') {
        const [sep, idxStr] = f.args
        const parts = result.split(sep)
        const idx = parseInt(idxStr, 10)
        result = parts[idx] !== undefined ? parts[idx] : result
      } else if (name === 'replace') {
        result = result.replace(new RegExp(f.args[0], 'g'), f.args[1])
      } else if (name === 're_replace') {
        result = result.replace(new RegExp(f.args[0], 'gi'), f.args[1])
      } else if (name === 'trim') {
        result = result.trim()
      } else if (name === 'append') {
        result = result + f.args[0]
      } else if (name === 'prepend') {
        result = f.args[0] + result
      } else if (name === 'tolower') {
        result = result.toLowerCase()
      } else if (name === 'toupper') {
        result = result.toUpperCase()
      } else if (name === 'querystring') {
        const url = new URL(result.startsWith('http') ? result : 'http://localhost' + result)
        result = url.searchParams.get(f.args[0]) ?? result
      } else if (name === 'regexp') {
        const match = result.match(new RegExp(f.args[0], 'i'))
        result = match ? match[1] ?? match[0] : result
      } else if (name === 'timeago') {
        result = parseTimeAgo(result)
      }
    } catch {
      // Skip failed filter
    }
  }
  return result
}

function parseTimeAgo(str: string): string {
  const now = new Date()
  const match = str.match(/(\d+)/)
  if (!match) return str
  const val = parseInt(match[1], 10)
  
  if (str.includes('min')) now.setMinutes(now.getMinutes() - val)
  else if (str.includes('hour')) now.setHours(now.getHours() - val)
  else if (str.includes('day')) now.setDate(now.getDate() - val)
  else if (str.includes('week')) now.setDate(now.getDate() - val * 7)
  else if (str.includes('month')) now.setMonth(now.getMonth() - val)
  else if (str.includes('year')) now.setFullYear(now.getFullYear() - val)
  
  return now.toISOString()
}

function parseSize(sizeStr?: string): number | undefined {
  if (!sizeStr) return undefined
  const cleanStr = sizeStr.replace(/,/g, '').toUpperCase()
  const match = cleanStr.match(/^([\d.]+)\s*([KMGT]?B)/i)
  if (!match) return undefined

  const num = parseFloat(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
  }
  return Math.floor(num * (multipliers[unit] ?? 1))
}
