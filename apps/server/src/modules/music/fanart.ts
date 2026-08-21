import axios from 'axios'
import { createLogger, sanitizeConfigValue } from '@archivist/core'
import { withProviderRetry } from '../../shared/provider-limiter.js'

const logger = createLogger('Fanart')
const FANART_BASE = process.env.FANART_BASE_URL ?? 'https://webservice.fanart.tv/v3/music'
const COVER_ART_BASE = process.env.COVER_ART_ARCHIVE_URL ?? 'https://coverartarchive.org'

export interface FanartMusicData {
  name: string
  mbid_id: string
  artistthumb?: Array<{ id: string; url: string; likes: string }>
  artistbackground?: Array<{ id: string; url: string; likes: string }>
  musiclogo?: Array<{ id: string; url: string; likes: string }>
  hdmusiclogo?: Array<{ id: string; url: string; likes: string }>
  musicbanner?: Array<{ id: string; url: string; likes: string }>
  albums?: Record<string, {
    albumcover?: Array<{ id: string; url: string; likes: string }>
    cdart?: Array<{ id: string; url: string; likes: string }>
  }>
}

export async function getFanartMusic(mbid: string, retries = 2): Promise<FanartMusicData | null> {
  const apiKey = sanitizeConfigValue(process.env.FANART_API_KEY)
  if (!apiKey) return null
  try {
    const res = await withProviderRetry('fanart', () => axios.get(`${FANART_BASE}/${mbid}`, {
      params: { api_key: apiKey },
      timeout: 10000,
    }), undefined, retries + 1)
    return res.data
  } catch (error) {
    logger.warn(`Fanart lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Cover art for one album.
 *
 * Two sources, because neither alone is enough. Fanart.tv carries album art
 * only inside the *artist* payload, keyed by release-group MBID, and needs an
 * API key. The Cover Art Archive is keyed by release-group directly and needs
 * no key at all, so it works on a fresh install — but it only has front covers,
 * never CD art.
 */
export async function getAlbumCovers(
  albumMbid: string,
  kind: 'cover' | 'cdart' = 'cover',
  artistMbid?: string,
): Promise<string[]> {
  const urls: string[] = []

  if (artistMbid) {
    const fanart = await getFanartMusic(artistMbid)
    const entry = fanart?.albums?.[albumMbid]
    for (const image of (kind === 'cdart' ? entry?.cdart : entry?.albumcover) ?? []) urls.push(image.url)
  }

  // The Cover Art Archive has no CD art, so there is nothing to ask it for.
  if (kind === 'cover') {
    try {
      const res = await withProviderRetry('coverart', () => axios.get(
        `${COVER_ART_BASE}/release-group/${albumMbid}`,
        { timeout: 10000, headers: { 'User-Agent': 'Archivist/1.0 ( https://github.com/archivist )' } },
      ), undefined, 2)
      for (const image of (res.data?.images ?? []) as Array<{ image?: string; thumbnails?: { large?: string } }>) {
        const url = image.thumbnails?.large ?? image.image
        if (url && !urls.includes(url)) urls.push(url)
      }
    } catch (error) {
      logger.warn(`Cover Art Archive lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return urls
}
