import { createLogger } from '@archivist/core'
import type { Database } from 'better-sqlite3'
import { getAlbumReleases, type MbAlbumRelease } from '../modules/music/musicbrainz.js'
import { normalizeTitle } from '../release-pipeline/parser.js'

const logger = createLogger('MusicMetadata')

export interface AlbumTrackMetadata {
  trackCount: number
  musicbrainzReleaseId: string | null
}

export interface CachedAlbumRelease extends MbAlbumRelease {
  selected: boolean
}

function mapCachedRelease(row: any, selectedId?: string | null): CachedAlbumRelease {
  return {
    id: String(row.musicbrainz_id),
    title: String(row.title),
    date: row.release_date ?? undefined,
    country: row.country ?? undefined,
    status: row.release_status ?? undefined,
    disambiguation: row.disambiguation ?? undefined,
    packaging: row.packaging ?? undefined,
    barcode: row.barcode ?? undefined,
    label: row.label ?? undefined,
    mediaFormats: JSON.parse(row.media_formats || '[]'),
    discCount: Number(row.disc_count ?? 0),
    trackCount: Number(row.track_count ?? 0),
    tracks: JSON.parse(row.tracks || '[]'),
    selected: row.musicbrainz_id === selectedId,
  }
}

export function listCachedAlbumReleases(db: Database, albumId: number): CachedAlbumRelease[] {
  const album = db.prepare('SELECT musicbrainz_release_id FROM albums WHERE id = ?').get(albumId) as { musicbrainz_release_id: string | null } | undefined
  if (!album) return []
  return (
    db
      .prepare(`SELECT * FROM music_album_releases WHERE album_id = ?
    ORDER BY CASE WHEN musicbrainz_id = ? THEN 0 ELSE 1 END,
      CASE WHEN release_status = 'Official' THEN 0 ELSE 1 END,
      CASE WHEN track_count > 0 THEN 0 ELSE 1 END,
      release_date, musicbrainz_id`)
      .all(albumId, album.musicbrainz_release_id) as any[]
  ).map(row => mapCachedRelease(row, album.musicbrainz_release_id))
}

export async function refreshAlbumReleases(db: Database, albumId: number): Promise<CachedAlbumRelease[]> {
  const album = db.prepare('SELECT musicbrainz_id FROM albums WHERE id = ?').get(albumId) as { musicbrainz_id: string | null } | undefined
  if (!album?.musicbrainz_id) return []
  const releases = await getAlbumReleases(album.musicbrainz_id)
  const upsert = db.prepare(`INSERT INTO music_album_releases
    (album_id, musicbrainz_id, title, release_date, country, release_status, disambiguation,
     packaging, barcode, label, media_formats, disc_count, track_count, tracks, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(album_id, musicbrainz_id) DO UPDATE SET
      title=excluded.title, release_date=excluded.release_date, country=excluded.country,
      release_status=excluded.release_status, disambiguation=excluded.disambiguation,
      packaging=excluded.packaging, barcode=excluded.barcode, label=excluded.label,
      media_formats=excluded.media_formats, disc_count=excluded.disc_count,
      track_count=excluded.track_count, tracks=excluded.tracks, cached_at=datetime('now')`)
  db.transaction(() => {
    for (const release of releases) {
      upsert.run(
        albumId,
        release.id,
        release.title,
        release.date ?? null,
        release.country ?? null,
        release.status ?? null,
        release.disambiguation ?? null,
        release.packaging ?? null,
        release.barcode ?? null,
        release.label ?? null,
        JSON.stringify(release.mediaFormats),
        release.discCount,
        release.trackCount,
        JSON.stringify(release.tracks),
      )
    }
  })()
  return listCachedAlbumReleases(db, albumId)
}

export async function albumReleases(db: Database, albumId: number, refresh = false): Promise<CachedAlbumRelease[]> {
  const cached = listCachedAlbumReleases(db, albumId)
  return refresh || cached.length === 0 ? refreshAlbumReleases(db, albumId) : cached
}

export function selectedAlbumRelease(db: Database, albumId: number): CachedAlbumRelease | null {
  return listCachedAlbumReleases(db, albumId).find(release => release.selected) ?? null
}

export function selectedAlbumReleasesForArtist(db: Database, artistId: number): Map<number, CachedAlbumRelease> {
  const selected = new Map<number, CachedAlbumRelease>()
  const rows = db
    .prepare(`SELECT release.* FROM music_album_releases release
    JOIN albums album ON album.id = release.album_id
      AND album.musicbrainz_release_id = release.musicbrainz_id
    WHERE album.artist_id = ?`)
    .all(artistId) as any[]
  for (const row of rows) selected.set(Number(row.album_id), mapCachedRelease(row, row.musicbrainz_id))
  return selected
}

interface ExistingAlbumTrack {
  id: number
  musicbrainz_id: string | null
  title: string
  track_number: string | number | null
  disc_number: number | null
}

/** Match a same-tracklist edition without relying on medium-specific numbering.
 * Release track IDs and A/B versus CD numbering may change while the recordings
 * remain identical, so normalized titles are the durable compatibility gate. */
function compatibleTrackProjection(
  existing: ExistingAlbumTrack[],
  selected: MbAlbumRelease['tracks'],
): Array<{
  existing: ExistingAlbumTrack
  selected: MbAlbumRelease['tracks'][number]
}> | null {
  if (existing.length === 0 || existing.length !== selected.length) return null
  const unused = new Set(existing.map(track => track.id))
  const pairs: Array<{ existing: ExistingAlbumTrack; selected: MbAlbumRelease['tracks'][number] }> = []
  for (const selectedTrack of selected) {
    const identityMatch = existing.find(track => unused.has(track.id) && track.musicbrainz_id === selectedTrack.id)
    const titleKey = normalizeTitle(selectedTrack.title)
    const titleMatch = existing.find(track => unused.has(track.id) && normalizeTitle(track.title) === titleKey)
    const match = identityMatch ?? titleMatch
    if (!match) return null
    unused.delete(match.id)
    pairs.push({ existing: match, selected: selectedTrack })
  }
  return unused.size === 0 ? pairs : null
}

/** Select a concrete edition. Existing ownership is retained when both
 * editions describe the same tracklist; genuinely different tracklists remain
 * blocked so selecting metadata can never disconnect acquired files. */
export async function selectAlbumRelease(db: Database, albumId: number, musicbrainzReleaseId: string): Promise<CachedAlbumRelease> {
  let releases = listCachedAlbumReleases(db, albumId)
  if (!releases.some(release => release.id === musicbrainzReleaseId)) releases = await refreshAlbumReleases(db, albumId)
  const selected = releases.find(release => release.id === musicbrainzReleaseId)
  if (!selected) throw new Error('MusicBrainz release does not belong to this album')
  const protectedTracks = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM tracks
    WHERE album_id = ? AND (status IN ('acquiring','downloading','collected','downloaded') OR file_path IS NOT NULL)`)
        .get(albumId) as { count: number }
    ).count,
  )
  const album = db.prepare('SELECT artist_id FROM albums WHERE id = ?').get(albumId) as { artist_id: number }
  const existingTracks = db
    .prepare('SELECT id, musicbrainz_id, title, track_number, disc_number FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number, id')
    .all(albumId) as ExistingAlbumTrack[]
  if (protectedTracks > 0) {
    const compatible = compatibleTrackProjection(existingTracks, selected.tracks)
    if (!compatible) {
      throw new Error('Cannot change release because its tracklist differs from acquiring or collected tracks; repair/reacquire it first')
    }
    const updateTrack = db.prepare(`UPDATE tracks
      SET musicbrainz_id = ?, title = ?, track_number = ?, disc_number = ?, duration = ?, updated_at = datetime('now')
      WHERE id = ?`)
    db.transaction(() => {
      for (const pair of compatible) {
        updateTrack.run(
          pair.selected.id,
          pair.selected.title,
          pair.selected.trackNumber,
          pair.selected.discNumber,
          pair.selected.duration ?? null,
          pair.existing.id,
        )
      }
      db.prepare(`UPDATE albums SET musicbrainz_release_id = ?, track_count = ?, updated_at = datetime('now') WHERE id = ?`).run(
        selected.id,
        selected.trackCount,
        albumId,
      )
    })()
    return { ...selected, selected: true }
  }

  const monitoring = new Map<string, number>()
  for (const track of db.prepare('SELECT musicbrainz_id, title, monitored FROM tracks WHERE album_id = ?').all(albumId) as any[]) {
    monitoring.set(track.musicbrainz_id || normalizeTitle(track.title), Number(track.monitored ?? 1))
  }
  const insert = db.prepare(`INSERT INTO tracks
    (album_id, artist_id, musicbrainz_id, title, track_number, disc_number, duration, monitored, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'missing')`)
  db.transaction(() => {
    db.prepare('DELETE FROM tracks WHERE album_id = ?').run(albumId)
    for (const track of selected.tracks) {
      insert.run(
        albumId,
        album.artist_id,
        track.id,
        track.title,
        track.trackNumber,
        track.discNumber,
        track.duration ?? null,
        monitoring.get(track.id) ?? monitoring.get(normalizeTitle(track.title)) ?? 1,
      )
    }
    db.prepare(`UPDATE albums SET musicbrainz_release_id = ?, track_count = ?, updated_at = datetime('now') WHERE id = ?`).run(
      selected.id,
      selected.trackCount,
      albumId,
    )
  })()
  return { ...selected, selected: true }
}

export function albumReleaseSearchTerms(release: CachedAlbumRelease | null, conceptualYear?: number | null): string[] {
  if (!release) return []
  const terms: string[] = []
  const year = Number.parseInt(release.date?.slice(0, 4) ?? '', 10)
  if (Number.isFinite(year) && year !== conceptualYear) terms.push(String(year))
  const edition = normalizeTitle(release.disambiguation ?? '')
  const editionMarker = ['super deluxe', 'deluxe', 'expanded', 'remaster', 'anniversary', 'mono', 'stereo'].find(marker => edition.includes(marker))
  if (editionMarker) terms.push(editionMarker)
  const physical = release.mediaFormats.find(format => !/digital media/i.test(format))
  if (physical && /vinyl|sacd|cassette/i.test(physical)) terms.push(physical)
  return [...new Set(terms.map(term => term.trim()).filter(Boolean))]
}

export function albumReleaseScope(release: CachedAlbumRelease | null): {
  releaseYear?: number
  edition?: string
  format?: string
} {
  if (!release) return {}
  const releaseYear = Number.parseInt(release.date?.slice(0, 4) ?? '', 10)
  return {
    releaseYear: Number.isFinite(releaseYear) ? releaseYear : undefined,
    edition: release.disambiguation,
    format: release.mediaFormats.join(' '),
  }
}

/**
 * Ensure appraisal has real album coverage before deciding whether a release
 * is complete. Provider failure is non-fatal: existing title/scope safeguards
 * remain available and a later search can retry hydration.
 */
export async function ensureAlbumTrackMetadata(db: Database, albumId: number): Promise<AlbumTrackMetadata> {
  const album = db
    .prepare(`SELECT id, artist_id, musicbrainz_id, musicbrainz_release_id, track_count
    FROM albums WHERE id = ?`)
    .get(albumId) as
    | {
        id: number
        artist_id: number
        musicbrainz_id: string | null
        musicbrainz_release_id: string | null
        track_count: number | null
      }
    | undefined
  if (!album) throw new Error(`Album ${albumId} not found`)

  const localCount = Number((db.prepare('SELECT COUNT(*) AS count FROM tracks WHERE album_id = ?').get(albumId) as { count: number }).count)
  if (localCount > 0) {
    if (Number(album.track_count ?? 0) !== localCount) {
      db.prepare("UPDATE albums SET track_count = ?, updated_at = datetime('now') WHERE id = ?").run(localCount, albumId)
    }
    if (album.musicbrainz_release_id || !album.musicbrainz_id) {
      return { trackCount: localCount, musicbrainzReleaseId: album.musicbrainz_release_id }
    }
  }
  if (!album.musicbrainz_id) return { trackCount: Number(album.track_count ?? 0), musicbrainzReleaseId: null }

  try {
    const concreteRelease = (await refreshAlbumReleases(db, album.id))[0]
    const tracklist = { releaseId: concreteRelease?.id ?? null, tracks: concreteRelease?.tracks ?? [] }
    if (tracklist.tracks.length === 0) {
      if (tracklist.releaseId) {
        db.prepare("UPDATE albums SET musicbrainz_release_id = ?, updated_at = datetime('now') WHERE id = ?").run(tracklist.releaseId, album.id)
      }
      return { trackCount: localCount || Number(album.track_count ?? 0), musicbrainzReleaseId: tracklist.releaseId }
    }
    if (localCount > 0) {
      db.prepare(`UPDATE albums SET track_count = ?, musicbrainz_release_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        tracklist.tracks.length,
        tracklist.releaseId,
        album.id,
      )
      return { trackCount: tracklist.tracks.length, musicbrainzReleaseId: tracklist.releaseId }
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO tracks
      (album_id, artist_id, musicbrainz_id, title, track_number, disc_number, duration, monitored, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'missing')`)
    db.transaction(() => {
      for (const track of tracklist.tracks) {
        insert.run(album.id, album.artist_id, track.id, track.title, track.trackNumber, track.discNumber, track.duration ?? null)
      }
      db.prepare(`UPDATE albums SET track_count = ?, musicbrainz_release_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        tracklist.tracks.length,
        tracklist.releaseId,
        album.id,
      )
    })()
    return { trackCount: tracklist.tracks.length, musicbrainzReleaseId: tracklist.releaseId }
  } catch (error) {
    logger.warn(`Could not hydrate track coverage for album ${albumId}: ${error instanceof Error ? error.message : String(error)}`)
    return { trackCount: Number(album.track_count ?? 0), musicbrainzReleaseId: album.musicbrainz_release_id }
  }
}
