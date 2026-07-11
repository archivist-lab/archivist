import axios from 'axios'
import { sanitizeConfigValue, createLogger } from '@archivist/core'

const logger = createLogger('IGDB')
const IGDB_BASE = process.env.IGDB_BASE_URL ?? 'https://api.igdb.com/v4'

let accessToken: string | null = null
let tokenExpiry = 0

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) return accessToken
  
  const clientId = sanitizeConfigValue(process.env.IGDB_CLIENT_ID)
  const clientSecret = sanitizeConfigValue(process.env.IGDB_CLIENT_SECRET)
  
  if (!clientId || !clientSecret) {
    throw new Error('IGDB_CLIENT_ID and IGDB_CLIENT_SECRET not set')
  }
  
  try {
    const params = new URLSearchParams()
    params.append('client_id', clientId)
    params.append('client_secret', clientSecret)
    params.append('grant_type', 'client_credentials')

    const res = await axios.post(process.env.TWITCH_OAUTH_URL ?? 'https://id.twitch.tv/oauth2/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    })
    
    accessToken = res.data.access_token
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000
    return accessToken!
  } catch (err: any) {
    logger.error('Auth failed:', err.response?.data || err.message)
    throw new Error('Failed to authenticate with IGDB/Twitch.')
  }
}

let lastReq = 0
async function igdbPost<T>(endpoint: string, body: string): Promise<T> {
  const wait = Math.max(0, 1000 - (Date.now() - lastReq))
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  
  const token = await getAccessToken()
  const clientId = sanitizeConfigValue(process.env.IGDB_CLIENT_ID)
  
  try {
    const res = await axios.post(`${IGDB_BASE}${endpoint}`, body, {
      headers: { 
        'Client-ID': clientId, 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'text/plain',
        'Accept': 'application/json'
      },
      timeout: 15000,
    })
    lastReq = Date.now()
    return res.data
  } catch (err: any) {
    logger.error(`API request failed (${endpoint}):`, err.response?.data || err.message)
    throw err
  }
}

export interface IgdbGame {
  igdbId: number; title: string; year?: number; releaseDate?: string; overview?: string
  genres: string[]; platforms: string[]; coverUrl?: string
  screenshotUrl?: string; rating?: number; developer?: string; publisher?: string
}

export async function searchGames(query: string, platformId?: number): Promise<any[]> {
  const safeQuery = query.replace(/"/g, '\\"')
  
  try {
    let body = `
      search "${safeQuery}";
      fields name,first_release_date,summary,cover.url,platforms.name,involved_companies.developer,involved_companies.company.name;
      limit 20;
    `
    if (platformId) {
      body += `\nwhere platforms = (${platformId});`
    }

    const results = await igdbPost<any[]>('/games', body)
    
    return (results ?? []).map(g => {
      const coverUrl = g.cover?.url?.replace('t_thumb', 't_cover_big').replace('http:', 'https:')
      const d = g.first_release_date ? new Date(g.first_release_date * 1000) : null
      const year = d ? d.getFullYear() : undefined
      const releaseDate = d ? d.toISOString().split('T')[0] : undefined
      const developer = g.involved_companies?.find((c: any) => c.developer)?.company?.name
      
      return {
        igdbId: g.id,
        title: g.name,
        year,
        releaseDate,
        overview: g.summary,
        coverUrl,
        image_url: coverUrl,
        developer,
        platforms: (g.platforms ?? []).map((p: any) => p.name)
      }
    })
  } catch (err) {
    logger.error('Search failed:', err instanceof Error ? err.message : String(err))
    throw err
  }
}

export async function getGameImages(igdbId: number): Promise<{ cover?: string; screenshots: string[]; artworks: string[] }> {
  const results = await igdbPost<any[]>('/games', `
    fields cover.url,screenshots.url,artworks.url;
    where id = ${igdbId};
    limit 1;
  `)
  const g = results?.[0] ?? {}
  const up = (u?: string, size = 't_1080p') => u?.replace('t_thumb', size).replace('http:', 'https:')
  return {
    cover: up(g.cover?.url, 't_cover_big'),
    screenshots: (g.screenshots ?? []).map((s: any) => up(s.url)).filter(Boolean) as string[],
    artworks: (g.artworks ?? []).map((a: any) => up(a.url)).filter(Boolean) as string[],
  }
}

export async function getGame(igdbId: number): Promise<IgdbGame> {
  const results = await igdbPost<any[]>('/games', `
    fields name,first_release_date,summary,genres.name,platforms.name,cover.url,screenshots.url,rating,involved_companies.company.name,involved_companies.developer,involved_companies.publisher;
    where id = ${igdbId};
    limit 1;
  `)
  if (!results?.[0]) throw new Error(`Game ${igdbId} not found`)
  
  const g = results[0]
  const companies = g.involved_companies ?? []
  const developer = companies.find((c: any) => c.developer)?.company?.name
  const publisher = companies.find((c: any) => c.publisher)?.company?.name
  
  const coverUrl = g.cover?.url?.replace('t_thumb', 't_cover_big').replace('http:', 'https:')
  const screenshotUrl = g.screenshots?.[0]?.url?.replace('t_thumb', 't_1080p').replace('http:', 'https:')
  const d = g.first_release_date ? new Date(g.first_release_date * 1000) : null
  const year = d ? d.getFullYear() : undefined
  const releaseDate = d ? d.toISOString().split('T')[0] : undefined

  return {
    igdbId: g.id, title: g.name, year, releaseDate,
    overview: g.summary || undefined,
    genres: (g.genres ?? []).map((gn: any) => gn.name),
    platforms: (g.platforms ?? []).map((p: any) => p.name),
    coverUrl, screenshotUrl,
    rating: g.rating ? Math.round(g.rating) / 10 : undefined,
    developer, publisher,
  }
}
