import axios from 'axios'
import { createLogger, sanitizeConfigValue } from '@archivist/core'
import { withProviderRetry } from '../../shared/provider-limiter.js'

const logger = createLogger('Fanart')
const FANART_BASE = process.env.FANART_BASE_URL ?? 'https://webservice.fanart.tv/v3/music'

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
