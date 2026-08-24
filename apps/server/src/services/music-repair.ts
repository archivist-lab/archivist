import type { Database } from 'better-sqlite3'
import { recordEvent } from '../system/event-store.js'

export type MusicRepairIssueType = 'album-correlation' | 'discography-correlation' | 'incomplete-collected-album' | 'unresolved-acquisition' | 'suspect-release'

export interface MusicRepairIssue {
  id: string
  type: MusicRepairIssueType
  libraryId: number
  subjectType: 'album' | 'artist'
  subjectId: number
  title: string
  detail: string
  repairable: boolean
  proposedAction: string | null
  correlation?: { torrentId: string; infoHash: string; releaseTitle: string }
}

function normalise(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function compact(value: string | null | undefined): string {
  return normalise(value).replace(/\s+/g, '')
}

function uniqueLegacyAlbumTorrent(artist: string, album: string, torrents: any[]) {
  const artistKey = compact(artist)
  const albumKey = compact(album)
  if (artistKey.length < 3 || albumKey.length < 4) return null
  const matches = torrents.filter(torrent => {
    const name = compact(torrent?.name)
    return torrent?.infoHash && name.includes(artistKey) && name.includes(albumKey)
      && !/\b(sampler|preview|promo|teaser)\b/i.test(String(torrent.name))
  })
  return matches.length === 1 ? matches[0] : null
}

function uniqueLegacyDiscographyTorrent(artist: string, torrents: any[]) {
  const artistKey = compact(artist)
  if (artistKey.length < 3) return null
  const matches = torrents.filter(torrent => torrent?.infoHash && compact(torrent.name).includes(artistKey)
    && /\b(discograph|anthology|collection|complete|box\s?set|all\s+albums|studio\s+albums)\b/i.test(String(torrent.name)))
  return matches.length === 1 ? matches[0] : null
}

function latestDecision(db: Database, subjectType: 'album' | 'artist', subjectId: number) {
  return db.prepare(`SELECT id, release_title, runtime_torrent_id, info_hash
    FROM acquisition_decisions
    WHERE media_type = 'music' AND subject_type = ? AND subject_id = ? AND grabbed = 1
    ORDER BY id DESC LIMIT 1`).get(subjectType, String(subjectId)) as {
      id: number; release_title: string; runtime_torrent_id: string | null; info_hash: string | null
    } | undefined
}

function resolveDecisionTorrent(decision: ReturnType<typeof latestDecision>, torrents: any[]) {
  if (!decision) return null
  const runtime = decision.runtime_torrent_id
    ? torrents.find(torrent => String(torrent?.id) === decision.runtime_torrent_id)
    : null
  const hash = !runtime && decision.info_hash
    ? torrents.find(torrent => torrent?.infoHash?.toLowerCase() === decision.info_hash?.toLowerCase())
    : null
  const exact = runtime ?? hash
  if (exact?.infoHash) return exact
  const wanted = normalise(decision.release_title)
  const matches = torrents.filter(torrent => torrent?.infoHash && normalise(torrent.name) === wanted)
  return matches.length === 1 ? matches[0] : null
}

export function auditMusicState(db: Database, torrents: any[], libraryId?: number): MusicRepairIssue[] {
  const args = libraryId == null ? [] : [libraryId]
  const libraryFilter = libraryId == null ? '' : ' AND ar.library_id = ?'
  const issues: MusicRepairIssue[] = []
  const albums = db.prepare(`SELECT al.id, al.title, al.status, al.info_hash, ar.library_id, ar.name AS artist_name,
      SUM(CASE WHEN tr.monitored != 0 THEN 1 ELSE 0 END) AS monitored_tracks,
      SUM(CASE WHEN tr.monitored != 0 AND tr.status = 'collected' AND tr.file_path IS NOT NULL THEN 1 ELSE 0 END) AS collected_tracks
    FROM albums al JOIN artists ar ON ar.id = al.artist_id LEFT JOIN tracks tr ON tr.album_id = al.id
    WHERE 1=1${libraryFilter}
    GROUP BY al.id`).all(...args) as any[]

  for (const album of albums) {
    const label = `${album.artist_name} - ${album.title}`
    if (['acquiring', 'downloading'].includes(album.status) && !album.info_hash) {
      const decision = latestDecision(db, 'album', album.id)
      const torrent = resolveDecisionTorrent(decision, torrents) ?? uniqueLegacyAlbumTorrent(album.artist_name, album.title, torrents)
      issues.push({
        id: `album-correlation:${album.id}`,
        type: torrent ? 'album-correlation' : 'unresolved-acquisition',
        libraryId: album.library_id, subjectType: 'album', subjectId: album.id, title: label,
        detail: torrent ? `Matched active torrent ${torrent.name}` : 'Acquiring without an info hash and no unique active torrent match',
        repairable: Boolean(torrent), proposedAction: torrent ? 'Persist the torrent ID/hash on the decision, album, and acquiring tracks' : null,
        correlation: torrent ? { torrentId: String(torrent.id), infoHash: String(torrent.infoHash).toLowerCase(), releaseTitle: torrent.name } : undefined,
      })
    }
    const monitored = Number(album.monitored_tracks ?? 0)
    const collected = Number(album.collected_tracks ?? 0)
    if (album.status === 'collected' && monitored > collected) {
      issues.push({
        id: `incomplete-collected-album:${album.id}`, type: 'incomplete-collected-album',
        libraryId: album.library_id, subjectType: 'album', subjectId: album.id, title: label,
        detail: `${collected} of ${monitored} monitored tracks have collected files`, repairable: true,
        proposedAction: "Change the album state from 'collected' to 'partial'",
      })
    }
    const suspiciousDecision = db.prepare(`SELECT release_title FROM acquisition_decisions
      WHERE media_type = 'music' AND subject_type = 'album' AND subject_id = ? AND grabbed = 1
        AND lower(release_title) GLOB '*sampler*' ORDER BY id DESC LIMIT 1`).get(String(album.id)) as { release_title: string } | undefined
    const suspiciousTorrent = album.info_hash
      ? torrents.find(torrent => torrent?.infoHash?.toLowerCase() === album.info_hash.toLowerCase() && /\bsampler\b/i.test(String(torrent.name)))
      : null
    const suspicious = suspiciousDecision?.release_title ?? suspiciousTorrent?.name
    if (suspicious) issues.push({
      id: `suspect-release:${album.id}`, type: 'suspect-release', libraryId: album.library_id,
      subjectType: 'album', subjectId: album.id, title: label,
      detail: `Grabbed release looks like a sampler: ${suspicious}`, repairable: false, proposedAction: null,
    })
  }

  const artists = db.prepare(`SELECT ar.id, ar.name, ar.library_id FROM artists ar
    WHERE ar.discography_status = 'acquiring' AND ar.discography_info_hash IS NULL${libraryId == null ? '' : ' AND ar.library_id = ?'}`)
    .all(...args) as Array<{ id: number; name: string; library_id: number }>
  for (const artist of artists) {
    const decision = latestDecision(db, 'artist', artist.id)
    const torrent = resolveDecisionTorrent(decision, torrents) ?? uniqueLegacyDiscographyTorrent(artist.name, torrents)
    issues.push({
      id: `discography-correlation:${artist.id}`,
      type: torrent ? 'discography-correlation' : 'unresolved-acquisition', libraryId: artist.library_id,
      subjectType: 'artist', subjectId: artist.id, title: `${artist.name} discography`,
      detail: torrent ? `Matched active torrent ${torrent.name}` : 'Discography is acquiring without an info hash and no unique active torrent match',
      repairable: Boolean(torrent), proposedAction: torrent ? 'Persist the torrent ID/hash on the decision and artist' : null,
      correlation: torrent ? { torrentId: String(torrent.id), infoHash: String(torrent.infoHash).toLowerCase(), releaseTitle: torrent.name } : undefined,
    })
  }
  return issues
}

export function applyMusicRepairs(db: Database, issues: MusicRepairIssue[], selectedIds?: string[]): { applied: string[]; skipped: string[] } {
  const selected = selectedIds ? new Set(selectedIds) : null
  const applied: string[] = []
  const skipped: string[] = []
  const run = db.transaction(() => {
    for (const issue of issues) {
      if ((selected && !selected.has(issue.id)) || !issue.repairable) { skipped.push(issue.id); continue }
      if (issue.type === 'album-correlation' && issue.correlation) {
        db.prepare("UPDATE albums SET info_hash = ?, discography_info_hash = NULL, status = 'acquiring', updated_at = datetime('now') WHERE id = ?")
          .run(issue.correlation.infoHash, issue.subjectId)
        db.prepare("UPDATE tracks SET info_hash = ?, updated_at = datetime('now') WHERE album_id = ? AND status IN ('acquiring','downloading')")
          .run(issue.correlation.infoHash, issue.subjectId)
      } else if (issue.type === 'discography-correlation' && issue.correlation) {
        db.prepare("UPDATE artists SET discography_info_hash = ?, updated_at = datetime('now') WHERE id = ?")
          .run(issue.correlation.infoHash, issue.subjectId)
      } else if (issue.type === 'incomplete-collected-album') {
        db.prepare("UPDATE albums SET status = 'partial', updated_at = datetime('now') WHERE id = ? AND status = 'collected'").run(issue.subjectId)
      } else { skipped.push(issue.id); continue }
      if (issue.correlation) {
        db.prepare(`UPDATE acquisition_decisions SET runtime_torrent_id = ?, info_hash = ?, correlation_status = 'matched'
          WHERE id = (SELECT id FROM acquisition_decisions WHERE media_type = 'music' AND subject_type = ? AND subject_id = ? AND grabbed = 1 ORDER BY id DESC LIMIT 1)`)
          .run(issue.correlation.torrentId, issue.correlation.infoHash, issue.subjectType, String(issue.subjectId))
      }
      applied.push(issue.id)
    }
  })
  run.immediate()
  for (const id of applied) recordEvent({ category: 'maintenance', action: 'music-state-repaired', subjectType: 'music-repair', subjectId: id, message: `Applied Music repair ${id}` })
  return { applied, skipped }
}
