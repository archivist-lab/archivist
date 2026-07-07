import axios from 'axios'
import { sendToDownloadClient as originalSend, createLogger } from '@archivist/core'
import { getFlareSolverrUrl } from './indexer-bridge.js'

const logger = createLogger('DownloadManager')

/**
 * Tries to resolve a detail-page URL to a direct magnet/torrent link via FlareSolverr.
 * Returns the resolved URL, or the original URL if resolution fails.
 */
async function resolveDetailPage(url: string, flareUrl: string): Promise<string> {
  const v1Url = flareUrl.endsWith('/v1') ? flareUrl : `${flareUrl.replace(/\/$/, '')}/v1`
  logger.info(`Resolving detail page via FlareSolverr at ${v1Url}: ${url.slice(0, 120)}`)
  try {
    const res = await axios.post(v1Url, {
      cmd: 'request.get',
      url,
      maxTimeout: 60000,
    }, { timeout: 65_000 })

    if (res.data?.status !== 'ok') {
      logger.warn(`FlareSolverr returned non-ok status: ${res.data?.status}`)
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
        logger.info(`Resolved magnet via FlareSolverr: ${resolved.slice(0, 80)}`)
        return resolved
      }
    }

    // Fallback: look for a direct .torrent download link
    const torrentPatterns = [
      /href="(https?:\/\/itorrents\.org\/torrent\/[^"]+)"/,
      /href="(https?:\/\/[^"]+\.torrent)"/,
      /href='(https?:\/\/[^']+\.torrent)'/,
    ]
    for (const pat of torrentPatterns) {
      const m = html.match(pat)
      if (m) {
        logger.info(`Resolved .torrent link via FlareSolverr: ${m[1].slice(0, 80)}`)
        return m[1]
      }
    }

    logger.warn(`FlareSolverr returned HTML but no magnet/torrent link found for: ${url.slice(0, 80)}`)
    logger.debug(`HTML snippet: ${html.slice(0, 500)}`)
    return url
  } catch (err) {
    logger.error(`FlareSolverr resolution failed: ${err instanceof Error ? err.message : String(err)}`)
    return url
  }
}

export async function sendToDownloadClient(client: any, downloadUrl: string, category?: string) {
  // If it looks like a detail page URL (not a magnet and not a direct .torrent file)
  // try to resolve it to the actual magnet link via FlareSolverr.
  const isDetailPage =
    downloadUrl.startsWith('http') &&
    !downloadUrl.endsWith('.torrent') &&
    !downloadUrl.startsWith('magnet:')

  if (isDetailPage) {
    const flareUrl = getFlareSolverrUrl()
    if (flareUrl) {
      try {
        const resolved = await resolveDetailPage(downloadUrl, flareUrl)
        if (resolved && resolved !== downloadUrl) {
          downloadUrl = resolved
        } else {
          logger.warn(`FlareSolverr failed to resolve a magnet/torrent link from: ${downloadUrl.slice(0, 80)}`)
          return { success: false, message: 'Could not resolve magnet/torrent from detail page. FlareSolverr found no link.' }
        }
      } catch (err) {
        logger.error(`Error resolving detail page via FlareSolverr: ${err instanceof Error ? err.message : String(err)}`)
        return { success: false, message: `FlareSolverr resolution failed: ${err instanceof Error ? err.message : 'Unknown error'}` }
      }
    } else {
      logger.warn(`Detail-page URL encountered but FlareSolverr is not enabled: ${downloadUrl.slice(0, 80)}`)
      return { success: false, message: 'Detail page resolution required but FlareSolverr is not enabled in settings.' }
    }
  }

  return originalSend(client, downloadUrl, category)
}
