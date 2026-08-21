import axios from 'axios'
import { sendToDownloadClient as originalSend, createLogger } from '@archivist/core'
import { resolveDownloadUrl } from '@torrentstack/indexer-engine'
import { getCloudflareBypassUrl, getIndexerStore } from './indexer-bridge.js'
import { recordEvent } from '../system/event-store.js'

const logger = createLogger('DownloadManager')

/**
 * Tries to resolve a detail-page URL to a direct magnet/torrent link via CloudflareBypass.
 * Returns the resolved URL, or the original URL if resolution fails.
 */
/**
 * Pulls a magnet out of a URL that merely wraps one.
 *
 * Several indexers publish their links through a redirector — the real magnet
 * sits URL-encoded in a query parameter. Fetching such a page and scraping it
 * for a link we are already holding is both slower and prone to failing, since
 * the redirector's HTML contains no link at all.
 */
export function magnetFromUrl(url: string): string | null {
  if (url.startsWith('magnet:')) return url

  // An unencoded magnet keeps its own '&' separators, which a query parser
  // would tear off as if they were the wrapper's parameters. Slice from the
  // magnet to the end of the string instead, so its trackers survive.
  const literal = url.indexOf('magnet:?')
  if (literal > 0) return url.slice(literal)

  // Otherwise the magnet was encoded, so read it back as a parameter value.
  try {
    for (const value of new URL(url).searchParams.values()) {
      const candidate = value.trim()
      if (candidate.startsWith('magnet:?')) return candidate
    }
  } catch {
    // Not a parseable URL; the scans below still stand a chance.
  }

  // Chained redirectors sometimes encode twice.
  const carrier = /[?&](?:url|link|magnet|href|u|r|torrent)=(.+)$/i.exec(url)
  if (carrier) {
    let value = carrier[1]
    for (let pass = 0; pass < 3; pass += 1) {
      if (value.startsWith('magnet:?')) return value
      try {
        const decoded = decodeURIComponent(value)
        if (decoded === value) break
        value = decoded
      } catch {
        break
      }
    }
  }

  // Last resort: find a magnet anywhere in the decoded string.
  try {
    const decoded = decodeURIComponent(url)
    const found = /magnet:\?xt=urn:btih:[^\s"'<>]+/i.exec(decoded)
    if (found) return found[0]
  } catch {
    // A malformed escape sequence means there is nothing to find.
  }

  return null
}

/**
 * Finds the indexer a details URL belongs to, by host.
 *
 * The grab path is handed a URL and nothing else, but resolving it properly
 * needs the definition that produced it. Matching on host is reliable because
 * an indexer's endpoints are exactly the hosts it can emit links for.
 */
function indexerForUrl(url: string) {
  let host: string
  try { host = new URL(url).host.toLowerCase() } catch { return null }
  try {
    for (const instance of getIndexerStore().getAll()) {
      if (!instance.definition) continue
      const candidates = [
        instance.config.baseUrl,
        instance.config.settings?.sitelink as string | undefined,
        ...instance.definition.links,
        ...instance.definition.legacyLinks,
      ]
      for (const candidate of candidates) {
        if (!candidate) continue
        try {
          if (new URL(candidate).host.toLowerCase() === host) return instance
        } catch { /* a malformed link is not a match */ }
      }
    }
  } catch { /* the store is not ready */ }
  return null
}

/**
 * Resolves a details page using the definition's own `download` block, which is
 * how the site itself says to reach the file. Falls back to scraping only when
 * the definition offers nothing.
 */
async function resolveViaDefinition(url: string): Promise<string | null> {
  const instance = indexerForUrl(url)
  if (!instance?.definition) return null
  try {
    return await resolveDownloadUrl(instance.definition, url, {
      settings: instance.config.settings as Record<string, string | number | boolean>,
      cookies: instance.cookies,
      proxyUrl: instance.proxyUrl,
      timeoutMs: 45_000,
      cloudflareBypassUrl: instance.cloudflareBypassUrl,
      forceCloudflareBypass: instance.config.settings?.cloudflareBypass === true
        || instance.config.settings?.cloudflareBypass === 'true',
    })
  } catch (err) {
    logger.warn(`Definition-driven download resolution failed for ${url.slice(0, 80)}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function resolveDetailPage(url: string, flareUrl: string): Promise<string> {
  const v1Url = flareUrl.endsWith('/v1') ? flareUrl : `${flareUrl.replace(/\/$/, '')}/v1`
  logger.info(`Resolving detail page via CloudflareBypass at ${v1Url}: ${url.slice(0, 120)}`)
  try {
    const res = await axios.post(v1Url, {
      cmd: 'request.get',
      url,
      maxTimeout: 60000,
    }, { timeout: 65_000 })

    if (res.data?.status !== 'ok') {
      logger.warn(`CloudflareBypass returned non-ok status: ${res.data?.status}`)
      return url
    }

    const html: string = res.data.solution.response ?? ''

    // Try magnet link — various quote styles and whitespace
    const magnetPatterns = [
      /href="(magnet:[^"]+)"/,
      /href='(magnet:[^']+)'/,
      /href=(magnet:[^\s>]+)/,
      /(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^"'\s<>]*)/,
    ]
    for (const pat of magnetPatterns) {
      const m = html.match(pat)
      if (m) {
        const resolved = m[1].replace(/&amp;/g, '&').trim()
        logger.info(`Resolved magnet via CloudflareBypass: ${resolved.slice(0, 80)}`)
        return resolved
      }
    }

    // Fallback: a .torrent link. Relative hrefs and query-string download
    // endpoints are both common, so neither is assumed away.
    const torrentPatterns = [
      /href="(https?:\/\/itorrents\.org\/torrent\/[^"]+)"/,
      /href=["']([^"']*\.torrent(?:\?[^"']*)?)["']/,
      /href=["']([^"']*\/(?:download|dl|get)[^"']*)["']/,
    ]
    for (const pat of torrentPatterns) {
      const m = html.match(pat)
      if (m) {
        const raw = m[1].replace(/&amp;/g, '&').trim()
        let resolved = raw
        try { resolved = new URL(raw, url).toString() } catch { /* keep as written */ }
        logger.info(`Resolved .torrent link via CloudflareBypass: ${resolved.slice(0, 80)}`)
        return resolved
      }
    }

    logger.warn(`CloudflareBypass returned HTML but no magnet/torrent link found for: ${url.slice(0, 80)}`)
    logger.debug(`HTML snippet: ${html.slice(0, 500)}`)
    return url
  } catch (err) {
    logger.error(`CloudflareBypass resolution failed: ${err instanceof Error ? err.message : String(err)}`)
    return url
  }
}

export async function sendToDownloadClient(client: any, downloadUrl: string, category?: string) {
  // If it looks like a detail page URL (not a magnet and not a direct .torrent file)
  // try to resolve it to the actual magnet link via CloudflareBypass.
  const isDetailPage =
    downloadUrl.startsWith('http') &&
    !downloadUrl.endsWith('.torrent') &&
    !downloadUrl.startsWith('magnet:')

  if (isDetailPage) {
    // Cheapest and most reliable first: the link may already carry the magnet.
    const embedded = magnetFromUrl(downloadUrl)
    if (embedded) {
      logger.info(`Extracted magnet from the link itself: ${embedded.slice(0, 80)}`)
      downloadUrl = embedded
    } else {

    // The definition knows how the site publishes its files; ask it next.
    const viaDefinition = await resolveViaDefinition(downloadUrl)
    if (viaDefinition && viaDefinition !== downloadUrl) {
      logger.info(`Resolved via definition: ${viaDefinition.slice(0, 80)}`)
      downloadUrl = viaDefinition
    } else {
    const flareUrl = getCloudflareBypassUrl()
    if (flareUrl) {
      try {
        const resolved = await resolveDetailPage(downloadUrl, flareUrl)
        if (resolved && resolved !== downloadUrl) {
          downloadUrl = resolved
        } else {
          logger.warn(`CloudflareBypass failed to resolve a magnet/torrent link from: ${downloadUrl.slice(0, 80)}`)
          return {
            success: false,
            message: indexerForUrl(downloadUrl)?.definition
              ? 'No magnet or .torrent link was found on that details page. The indexer definition may be out of date for this site.'
              : 'No magnet or .torrent link was found on that details page, and no configured indexer claims that host.',
          }
        }
      } catch (err) {
        logger.error(`Error resolving detail page via CloudflareBypass: ${err instanceof Error ? err.message : String(err)}`)
        return { success: false, message: `CloudflareBypass resolution failed: ${err instanceof Error ? err.message : 'Unknown error'}` }
      }
    } else {
      logger.warn(`Detail-page URL encountered but CloudflareBypass is not enabled: ${downloadUrl.slice(0, 80)}`)
      return { success: false, message: 'This release links to a details page. Enable the Cloudflare bypass, or pick a release that links straight to a magnet.' }
    }
    }
    }
  }

  const result = await originalSend(client, downloadUrl, category)
  if (result.success) {
    recordEvent({
      category: 'download',
      action: 'added',
      subjectType: 'torrent',
      message: `Download added${category ? ` to ${category}` : ''}`,
      data: { category: category ?? null, clientType: client?.type ?? null, infoHash: result.infoHash ?? null },
    })
  }
  return result
}
