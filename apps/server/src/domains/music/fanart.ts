import axios from 'axios'
import { createLogger } from '@archivist/core'

const logger = createLogger('Fanart')
const FANART_BASE = process.env.FANART_BASE_URL ?? 'https://webservice.fanart.tv/v3/music'
const DEFAULT_API_KEY = '52246d363a13fca319113973cfaf19aa'

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
  const apiKey = process.env.FANART_API_KEY || DEFAULT_API_KEY
  let attempt = 0
  
  while (attempt <= retries) {
    try {
      const res = await axios.get(`${FANART_BASE}/${mbid}`, {
        params: { api_key: apiKey },
        timeout: 10000
      })
      return res.data
    } catch (err: any) {
      attempt++
      const status = err.response?.status
      if (attempt <= retries && (status === 503 || status === 502 || !status)) {
        const backoff = attempt * 1000
        logger.warn(`Request failed (${status || 'timeout'}), retrying in ${backoff}ms`)
        await new Promise(r => setTimeout(r, backoff))
        continue
      }
      // Fanart.tv returns 404 if no data found
      return null
    }
  }
  return null
}
