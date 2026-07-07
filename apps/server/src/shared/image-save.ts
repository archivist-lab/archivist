import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import axios from 'axios'

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
    const relativeDir = rootPath.split('media').pop()?.replace(/\\/g, '/')
    return { path: `/media${relativeDir}/${filename}`.replace(/\\/g, '/'), local: true }
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

/** Fanart.tv lookup for TV shows (by TVDB id) reusing the music client's key handling. */
export async function getFanartTv(tvdbId: number): Promise<Record<string, Array<{ url: string; lang?: string }>> | null> {
  const apiKey = process.env.FANART_API_KEY || '52246d363a13fca319113973cfaf19aa'
  const base = process.env.FANART_TV_BASE_URL ?? 'https://webservice.fanart.tv/v3/tv'
  try {
    const res = await axios.get(`${base}/${tvdbId}`, { params: { api_key: apiKey }, timeout: 10000 })
    return res.data
  } catch {
    return null
  }
}
