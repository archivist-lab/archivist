import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'

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
  for (const sql of statements) {
    try { changes += db.prepare(sql).run(hash).changes } catch { /* optional/legacy table or column */ }
  }
  return changes
}
