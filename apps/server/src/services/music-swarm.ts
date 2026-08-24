import type { Database } from 'better-sqlite3'
import { getDb } from '../db.js'
import type { CandidateRelease } from './acquisition-decisions.js'
import { extractInfoHash, initAcquisitionStore } from './acquisition-decisions.js'

export type MusicSwarmOutcome = 'metadata-succeeded' | 'metadata-failed'

export interface MusicFallbackTarget {
  libraryId: number
  subjectType: 'album' | 'artist'
  subjectId: number
  failedAttempts: number
}

function releaseHash(release: CandidateRelease): string | null {
  return extractInfoHash(release.magnetUrl)
    ?? extractInfoHash(release.downloadUrl)
    ?? extractInfoHash(release.guid)
}

/**
 * Persist an observed metadata outcome against the Music decision that owns
 * the torrent. Duplicate runtime events are harmless because one hash/outcome
 * pair is unique.
 */
export function recordMusicSwarmOutcome(
  infoHash: string | null | undefined,
  outcome: MusicSwarmOutcome,
  db: Database = getDb(),
): MusicFallbackTarget | null {
  if (!infoHash) return null
  initAcquisitionStore(db)
  const hash = infoHash.toLowerCase()
  const decision = db.prepare(`
    SELECT tab_id, subject_type, subject_id, release_guid, download_url, indexer_name
    FROM acquisition_decisions
    WHERE media_type = 'music' AND grabbed = 1 AND LOWER(info_hash) = ?
      AND subject_type IN ('album','artist')
    ORDER BY id DESC LIMIT 1
  `).get(hash) as {
    tab_id: number | null
    subject_type: 'album' | 'artist'
    subject_id: string | null
    release_guid: string | null
    download_url: string
    indexer_name: string | null
  } | undefined
  if (!decision?.tab_id || !decision.subject_id) return null

  db.prepare(`INSERT OR IGNORE INTO music_swarm_observations
    (library_id, subject_type, subject_id, info_hash, release_guid, download_url, indexer_name, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(decision.tab_id, decision.subject_type, decision.subject_id, hash, decision.release_guid,
      decision.download_url, decision.indexer_name, outcome)

  const failedAttempts = Number((db.prepare(`SELECT COUNT(*) AS count FROM music_swarm_observations
    WHERE library_id = ? AND subject_type = ? AND subject_id = ? AND outcome = 'metadata-failed'
      AND observed_at >= datetime('now', '-24 hours')`)
    .get(decision.tab_id, decision.subject_type, decision.subject_id) as { count: number }).count)
  return {
    libraryId: decision.tab_id,
    subjectType: decision.subject_type,
    subjectId: Number(decision.subject_id),
    failedAttempts,
  }
}

/** Score adjustment based on real metadata outcomes, not tracker claims. */
export function musicSwarmAdjustment(release: CandidateRelease, db: Database = getDb()): number {
  initAcquisitionStore(db)
  const hash = releaseHash(release)
  if (hash) {
    const exact = db.prepare(`SELECT outcome FROM music_swarm_observations
      WHERE info_hash = ? ORDER BY id DESC LIMIT 1`).get(hash.toLowerCase()) as { outcome: MusicSwarmOutcome } | undefined
    if (exact?.outcome === 'metadata-failed') return -50
    if (exact?.outcome === 'metadata-succeeded') return 5
  }
  if (!release.indexerName) return 0
  const history = db.prepare(`SELECT
      SUM(CASE WHEN outcome = 'metadata-succeeded' THEN 1 ELSE 0 END) AS successes,
      COUNT(*) AS total
    FROM music_swarm_observations
    WHERE indexer_name = ? AND observed_at >= datetime('now', '-180 days')`)
    .get(release.indexerName) as { successes: number | null; total: number }
  if (history.total < 3) return 0
  const successRate = Number(history.successes ?? 0) / history.total
  return Math.max(-3, Math.min(3, (successRate - 0.5) * 6))
}

export function withMusicSwarmEvidence<T extends CandidateRelease>(release: T, db: Database = getDb()): T & { swarmScore: number } {
  return { ...release, swarmScore: musicSwarmAdjustment(release, db) }
}
