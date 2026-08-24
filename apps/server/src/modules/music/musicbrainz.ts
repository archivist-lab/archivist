import axios from 'axios'
import { createLogger } from '@archivist/core'
import { getFanartMusic } from './fanart.js'

const logger = createLogger('MusicBrainz')

// Resolve provider URLs at request time. The test harness and bare-metal config
// install environment overrides before app creation, which may be later than
// this module's first import.
const http = () =>
  axios.create({
    baseURL: process.env.MUSICBRAINZ_BASE_URL ?? 'https://musicbrainz.org/ws/2',
    timeout: 30000,
    family: 4,
    headers: {
      'User-Agent': 'Archivist/2.0 (https://github.com/your-username/archivist)',
      Accept: 'application/json',
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
  id: string
  name: string
  sortName: string
  disambiguation?: string
  overview?: string
  genres: string[]
  imageUrl?: string
  backdropUrl?: string
  logoUrl?: string
  members?: MbMember[]
}

/** A person who played in the band, from MusicBrainz artist relations. */
export interface MbMember {
  mbid: string
  name: string
  /** Instruments or role, e.g. ['guitar', 'lead vocals']. */
  roles: string[]
  begin?: string
  end?: string
  /** False once someone has left, which the UI shows differently. */
  current: boolean
}

export interface MbAlbum {
  id: string
  title: string
  releaseDate?: string
  year?: number
  albumType: string
  genres: string[]
  coverUrl?: string
  cdartUrl?: string
  label?: string
  trackCount: number
}

export interface MbTrack {
  id: string
  title: string
  trackNumber: number
  discNumber: number
  duration?: number
}

export interface MbAlbumTracklist {
  releaseId: string | null
  tracks: MbTrack[]
}

export interface MbAlbumRelease {
  id: string
  title: string
  date?: string
  country?: string
  status?: string
  disambiguation?: string
  packaging?: string
  barcode?: string
  label?: string
  mediaFormats: string[]
  discCount: number
  trackCount: number
  tracks: MbTrack[]
}

export async function searchArtists(query: string): Promise<Array<{ mbid: string; name: string; disambiguation?: string; genres: string[]; score: number }>> {
  const res = await rateLimited(() => http().get('/artist', { params: { query, limit: 20, fmt: 'json' } }))
  return (res.data.artists ?? []).map((a: any) => ({
    mbid: a.id,
    name: a.name,
    disambiguation: a.disambiguation,
    genres: (a.genres ?? a.tags ?? []).slice(0, 5).map((g: any) => g.name),
    score: a.score,
  }))
}

export async function getArtist(mbid: string): Promise<MbArtist> {
  const [mbRes, fanart] = await Promise.all([
    rateLimited(() => http().get(`/artist/${mbid}`, { params: { inc: 'genres+tags+url-rels+artist-rels', fmt: 'json' } })),
    getFanartMusic(mbid),
  ])

  const a = mbRes.data
  const relations = a.relations ?? []

  // 1. Prioritize Fanart.tv from dedicated API
  let imageUrl = fanart?.artistthumb?.[0]?.url
  const backdropUrl = fanart?.artistbackground?.[0]?.url
  const logoUrl = fanart?.hdmusiclogo?.[0]?.url || fanart?.musiclogo?.[0]?.url

  // 2. Fallback to relations for imageUrl if Fanart dedicated thumb not found
  if (!imageUrl) {
    // Try Fanart.tv relation
    let imageRel = relations.find((r: any) => r.type === 'fanart.tv' && r.url?.resource?.includes('/artistbackground/'))

    // Try any image/logo relation, preferring Wikimedia
    if (!imageRel) {
      imageRel = relations.find((r: any) => (r.type === 'image' || r.type === 'logo') && r.url?.resource?.includes('commons.wikimedia.org'))
    }

    // Fallback to any other image relation
    if (!imageRel) {
      imageRel = relations.find(
        (r: any) =>
          (r.type === 'image' || r.type === 'logo') && r.url?.resource && !r.url.resource.includes('fbcdn.net') && !r.url.resource.includes('facebook.com'),
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
    id: a.id,
    name: a.name,
    sortName: a['sort-name'] ?? a.name,
    disambiguation: a.disambiguation,
    genres: (a.genres ?? a.tags ?? []).slice(0, 8).map((g: any) => g.name),
    imageUrl,
    backdropUrl,
    logoUrl,
    members: readMembers(relations),
  }
}

/**
 * Band members, from MusicBrainz "member of band" relations.
 *
 * Current members come first, then past ones by how long they served, so the
 * lineup reads the way people expect rather than in relation order.
 */
function readMembers(relations: any[]): MbMember[] {
  const members = relations
    .filter(r => r.type === 'member of band' && r.artist)
    .map(
      (r): MbMember => ({
        mbid: r.artist.id,
        name: r.artist.name,
        roles: [...new Set((r.attributes ?? []) as string[])],
        begin: r.begin ?? undefined,
        end: r.end ?? undefined,
        current: !r.ended && !r.end,
      }),
    )

  // One person can hold several relations — a break and a return, or a change
  // of instrument. Collapse those into a single entry.
  const byMbid = new Map<string, MbMember>()
  for (const member of members) {
    const existing = byMbid.get(member.mbid)
    if (!existing) {
      byMbid.set(member.mbid, member)
      continue
    }
    existing.roles = [...new Set([...existing.roles, ...member.roles])]
    existing.current = existing.current || member.current
    if (member.begin && (!existing.begin || member.begin < existing.begin)) existing.begin = member.begin
    if (existing.current) existing.end = undefined
    else if (member.end && (!existing.end || member.end > existing.end)) existing.end = member.end
  }

  return [...byMbid.values()].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return (a.begin ?? '').localeCompare(b.begin ?? '')
  })
}

export async function getArtistAlbums(mbid: string): Promise<MbAlbum[]> {
  const [mbRes, fanart] = await Promise.all([
    rateLimited(() =>
      http().get('/release-group', {
        params: { artist: mbid, type: 'album|single|ep', inc: 'genres+tags', limit: 100, fmt: 'json' },
      }),
    ),
    getFanartMusic(mbid),
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
      coverUrl: fanartAlbum?.albumcover?.[0]?.url || `${process.env.COVERART_BASE_URL ?? 'https://coverartarchive.org'}/release-group/${rg.id}/front-500`,
      cdartUrl: fanartAlbum?.cdart?.[0]?.url,
      trackCount: 0,
    }
  })
}

export async function getAlbumReleases(rgid: string): Promise<MbAlbumRelease[]> {
  const rawReleases: any[] = []
  let offset = 0
  let total = 0
  do {
    const res = await rateLimited(() =>
      http().get('/release', {
        params: { 'release-group': rgid, inc: 'recordings+labels', limit: 100, offset, fmt: 'json' },
      }),
    )
    const page = res.data.releases ?? []
    rawReleases.push(...page)
    total = Number(res.data['release-count'] ?? rawReleases.length)
    offset += page.length
    if (page.length === 0) break
  } while (offset < total)

  return rawReleases
    .map((release: any): MbAlbumRelease => {
      const tracks: MbTrack[] = []
      for (const medium of release.media ?? []) {
        for (const [index, track] of (medium.tracks ?? []).entries()) {
          const numericPosition = Number.parseInt(String(track.position ?? track.number), 10)
          tracks.push({
            id: track.recording?.id ?? track.id,
            title: track.title,
            trackNumber: Number.isFinite(numericPosition) ? numericPosition : index + 1,
            discNumber: Number(medium.position ?? 1),
            duration: track.length ? Math.floor(track.length / 1000) : undefined,
          })
        }
      }
      return {
        id: release.id,
        title: release.title || 'Release',
        date: release.date,
        country: release.country,
        status: release.status,
        disambiguation: release.disambiguation,
        packaging: release.packaging,
        barcode: release.barcode,
        label:
          release['label-info']
            ?.map((entry: any) => entry.label?.name)
            .filter(Boolean)
            .join(' / ') || undefined,
        mediaFormats: [...new Set((release.media ?? []).map((medium: any) => medium.format).filter(Boolean))] as string[],
        discCount: release.media?.length ?? 0,
        trackCount: tracks.length,
        tracks,
      }
    })
    .sort((left, right) => {
      const leftOfficial = left.status === 'Official' ? 0 : 1
      const rightOfficial = right.status === 'Official' ? 0 : 1
      if (leftOfficial !== rightOfficial) return leftOfficial - rightOfficial
      const leftHasTracks = left.trackCount > 0 ? 0 : 1
      const rightHasTracks = right.trackCount > 0 ? 0 : 1
      if (leftHasTracks !== rightHasTracks) return leftHasTracks - rightHasTracks
      return String(left.date ?? '').localeCompare(String(right.date ?? '')) || left.id.localeCompare(right.id)
    })
}

export async function getAlbumTracklist(rgid: string): Promise<MbAlbumTracklist> {
  const release = (await getAlbumReleases(rgid))[0]
  if (!release) return { releaseId: null, tracks: [] }
  return { releaseId: release.id, tracks: release.tracks }
}

export async function getAlbumTracks(rgid: string): Promise<MbTrack[]> {
  return (await getAlbumTracklist(rgid)).tracks
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
