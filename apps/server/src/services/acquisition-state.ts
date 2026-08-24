import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

export function markDiscographyAlbumAcquiring(
  db: Database,
  artistId: number,
  albumId: number,
  infoHash: string,
  progress: number,
): void {
  const hash = infoHash.toLowerCase()
  db.transaction(() => {
    const claimed = db.prepare(`UPDATE albums
      SET status = 'acquiring', discography_info_hash = ?, download_progress = ?, updated_at = datetime('now')
      WHERE id = ? AND artist_id = ? AND info_hash IS NULL AND status NOT IN ('collected','downloaded')`)
      .run(hash, progress, albumId, artistId)
    if (claimed.changes === 0) return
    db.prepare(`UPDATE tracks SET status = 'acquiring', download_progress = ?, updated_at = datetime('now')
      WHERE album_id = ? AND info_hash IS NULL AND status IN ('wanted','missing','acquiring','downloading')`)
      .run(progress, albumId)
  })()
}

export function markDiscographyAcquiring(db: Database, artistId: number, infoHash: string): number {
  const hash = infoHash.toLowerCase()
  return db.transaction(() => {
    const albums = db.prepare(`UPDATE albums
      SET status = 'acquiring', discography_info_hash = ?, download_progress = 0, updated_at = datetime('now')
      WHERE artist_id = ? AND info_hash IS NULL AND status IN ('wanted','missing','acquiring','downloading')`)
      .run(hash, artistId)
    db.prepare(`UPDATE tracks SET status = 'acquiring', download_progress = 0, updated_at = datetime('now')
      WHERE album_id IN (SELECT id FROM albums WHERE artist_id = ? AND LOWER(discography_info_hash) = ?)
        AND info_hash IS NULL AND status IN ('wanted','missing','acquiring','downloading')`)
      .run(artistId, hash)
    db.prepare(`UPDATE artists SET discography_info_hash = ?, discography_status = 'acquiring',
      discography_progress = 0, updated_at = datetime('now') WHERE id = ?`).run(hash, artistId)
    return albums.changes
  })()
}

/**
 * Release only state owned by one discography acquisition. A concurrent album
 * acquisition has its own info hash and is deliberately left untouched.
 */
export function reconcileDiscographyChildren(db: Database, artistId: number, infoHash: string): number {
  const hash = infoHash.toLowerCase()
  return db.transaction(() => {
    const ownedIds = db.prepare(`SELECT id FROM albums WHERE artist_id = ? AND LOWER(discography_info_hash) = ?`)
      .all(artistId, hash) as Array<{ id: number }>
    if (ownedIds.length === 0) return 0
    const ids = ownedIds.map(row => row.id)
    const placeholders = ids.map(() => '?').join(',')
    const tracks = db.prepare(`UPDATE tracks SET status = 'missing', download_progress = 0, updated_at = datetime('now')
      WHERE album_id IN (${placeholders}) AND info_hash IS NULL AND status IN ('acquiring','downloading')`).run(...ids)
    const albums = db.prepare(`UPDATE albums SET status = 'missing', download_progress = 0, updated_at = datetime('now')
      WHERE id IN (${placeholders}) AND info_hash IS NULL AND status IN ('acquiring','downloading')`).run(...ids)
    db.prepare(`UPDATE albums SET discography_info_hash = NULL WHERE id IN (${placeholders})`).run(...ids)
    return albums.changes + tracks.changes
  })()
}

/** Reset every library subject still tied to a terminal torrent hash. */
export function resetAcquisitionsForHash(infoHash: string | null | undefined, db: Database = getDb()): number {
  if (!infoHash) return 0
  const hash = infoHash.toLowerCase()
  const statements = [
    "UPDATE films SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')",
    "UPDATE episodes SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')",
    "UPDATE seasons SET info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ?",
    "UPDATE albums SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')",
    "UPDATE books SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')",
    "UPDATE games SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')",
    "UPDATE comic_issues SET status = 'missing', info_hash = NULL, download_progress = 0, updated_at = datetime('now') WHERE LOWER(info_hash) = ? AND status IN ('acquiring', 'downloading', 'wanted', 'missing')",
  ]
  let changes = 0
  try {
    const artists = db.prepare('SELECT id FROM artists WHERE LOWER(discography_info_hash) = ?').all(hash) as Array<{ id: number }>
    for (const artist of artists) changes += reconcileDiscographyChildren(db, artist.id, hash)
    changes += db.prepare(`UPDATE artists SET discography_info_hash = NULL, discography_status = NULL,
      discography_progress = 0, updated_at = datetime('now') WHERE LOWER(discography_info_hash) = ?`).run(hash).changes
  } catch { /* optional columns during migration/startup */ }
  for (const sql of statements) {
    try { changes += db.prepare(sql).run(hash).changes } catch { /* optional/legacy table or column */ }
  }
  return changes
}
