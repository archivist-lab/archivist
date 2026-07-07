import axios from 'axios'
import { createLogger } from '@archivist/core'
import { getFanartMusic } from './fanart.js'

const logger = createLogger('MusicBrainz')

const MB_BASE = process.env.MUSICBRAINZ_BASE_URL ?? 'https://musicbrainz.org/ws/2'
const CAA_BASE = process.env.COVERART_BASE_URL ?? 'https://coverartarchive.org'

const http = axios.create({
  baseURL: MB_BASE,
  timeout: 30000,
  family: 4,
  headers: {
    'User-Agent': 'Archivist/2.0 (https://github.com/your-username/archivist)',
    'Accept': 'application/json',
  },
})

let lastRequest = 0
async function rateLimited<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let attempt = 0
  while (attempt < retries) {
    try {
      const wait = Math.max(0, 2000 - (Date.now() - lastRequest))
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      lastRequest = Date.now()
      return await fn()
    } catch (err: any) {
      attempt++
      const status = err.response?.status
      if (attempt < retries && (status === 503 || status === 502 || status === 429)) {
        const backoff = attempt * 2000
        logger.warn(`Request failed (${status}), retrying in ${backoff}ms (attempt ${attempt}/${retries})`)
        await new Promise(r => setTimeout(r, backoff))
        continue
      }
      throw err
    }
  }
  throw new Error('Max retries exceeded')
}

export interface MbArtist {
  id: string; name: string; sortName: string
  disambiguation?: string; overview?: string; genres: string[]; 
  imageUrl?: string; backdropUrl?: string; logoUrl?: string
}

export interface MbAlbum {
  id: string; title: string; releaseDate?: string; year?: number
  albumType: string; genres: string[]; coverUrl?: string; cdartUrl?: string; label?: string; trackCount: number
}

export interface MbTrack {
  id: string; title: string; trackNumber: number; discNumber: number; duration?: number
}

export async function searchArtists(query: string): Promise<Array<{ mbid: string; name: string; disambiguation?: string; genres: string[]; score: number }>> {
  const res = await rateLimited(() => http.get('/artist', { params: { query, limit: 20, fmt: 'json' } }))
  return (res.data.artists ?? []).map((a: any) => ({
    mbid: a.id, name: a.name, disambiguation: a.disambiguation,
    genres: (a.genres ?? a.tags ?? []).slice(0, 5).map((g: any) => g.name),
    score: a.score,
  }))
}

export async function getArtist(mbid: string): Promise<MbArtist> {
  const [mbRes, fanart] = await Promise.all([
    rateLimited(() => http.get(`/artist/${mbid}`, { params: { inc: 'genres+tags+url-rels', fmt: 'json' } })),
    getFanartMusic(mbid)
  ])
  
  const a = mbRes.data
  const relations = a.relations ?? []
  
  // 1. Prioritize Fanart.tv from dedicated API
  let imageUrl = fanart?.artistthumb?.[0]?.url
  let backdropUrl = fanart?.artistbackground?.[0]?.url
  let logoUrl = fanart?.hdmusiclogo?.[0]?.url || fanart?.musiclogo?.[0]?.url

  // 2. Fallback to relations for imageUrl if Fanart dedicated thumb not found
  if (!imageUrl) {
    // Try Fanart.tv relation
    let imageRel = relations.find((r: any) => 
      r.type === 'fanart.tv' && r.url?.resource?.includes('/artistbackground/')
    )

    // Try any image/logo relation, preferring Wikimedia
    if (!imageRel) {
      imageRel = relations.find((r: any) => 
        (r.type === 'image' || r.type === 'logo') && 
        r.url?.resource?.includes('commons.wikimedia.org')
      )
    }

    // Fallback to any other image relation
    if (!imageRel) {
      imageRel = relations.find((r: any) => 
        (r.type === 'image' || r.type === 'logo') && 
        r.url?.resource && 
        !r.url.resource.includes('fbcdn.net') &&
        !r.url.resource.includes('facebook.com')
      )
    }

    imageUrl = imageRel?.url?.resource
  }

  // Normalize Wikimedia Commons URLs to direct image paths
  if (imageUrl && imageUrl.includes('commons.wikimedia.org/wiki/File:')) {
    const parts = imageUrl.split('File:')
    if (parts[1]) {
      const filename = parts[1].split('?')[0]
      imageUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${filename}`
    }
  }

  return {
    id: a.id, name: a.name, sortName: a['sort-name'] ?? a.name,
    disambiguation: a.disambiguation,
    genres: (a.genres ?? a.tags ?? []).slice(0, 8).map((g: any) => g.name),
    imageUrl, backdropUrl, logoUrl
  }
}

export async function getArtistAlbums(mbid: string): Promise<MbAlbum[]> {
  const [mbRes, fanart] = await Promise.all([
    rateLimited(() => http.get('/release-group', {
      params: { artist: mbid, type: 'album|single|ep', inc: 'genres+tags', limit: 100, fmt: 'json' }
    })),
    getFanartMusic(mbid)
  ])

  return (mbRes.data['release-groups'] ?? []).map((rg: any) => {
    const fanartAlbum = fanart?.albums?.[rg.id]
    
    return {
      id: rg.id,
      title: rg.title,
      releaseDate: rg['first-release-date'],
      year: rg['first-release-date'] ? parseInt(rg['first-release-date'].slice(0, 4), 10) : undefined,
      albumType: mapAlbumType(rg['primary-type'], rg['secondary-types']),
      genres: (rg.genres ?? rg.tags ?? []).slice(0, 5).map((g: any) => g.name),
      // Prioritize Fanart.tv cover if available, otherwise Cover Art Archive
      coverUrl: fanartAlbum?.albumcover?.[0]?.url || `${CAA_BASE}/release-group/${rg.id}/front-500`,
      cdartUrl: fanartAlbum?.cdart?.[0]?.url,
      trackCount: 0,
    }
  })
}

export async function getAlbumTracks(rgid: string): Promise<MbTrack[]> {
  const res = await rateLimited(() => http.get('/release', {
    params: { 'release-group': rgid, inc: 'recordings', limit: 1, fmt: 'json' }
  }))
  
  const release = res.data.releases?.[0]
  if (!release) return []

  const tracks: MbTrack[] = []
  release.media?.forEach((disc: any) => {
    disc.tracks?.forEach((t: any) => {
      tracks.push({
        id: t.id,
        title: t.title,
        trackNumber: t.number,
        discNumber: disc.position,
        duration: t.length ? Math.floor(t.length / 1000) : undefined
      })
    })
  })
  return tracks
}

function mapAlbumType(primary: string, secondary: string[] = []): string {
  if (secondary.includes('Live')) return 'Live'
  if (secondary.includes('Compilation')) return 'Compilation'
  if (primary === 'Single') return 'Single'
  if (primary === 'EP') return 'EP'
  return 'Album'
}

export function formatDuration(seconds?: number): string {
  if (!seconds) return '—'
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
