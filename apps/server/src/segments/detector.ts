import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { probeTracks } from '../player/media.js'
import { probeChapters, type ChapterProbeResult } from '../services/media-processor.js'
import { decodeFingerprint, encodeFingerprint, FINGERPRINT_ALGORITHM, FINGERPRINT_ENCODING, fingerprintAudioWindow } from './fingerprint.js'
import { matchFingerprintWindows, type FingerprintMatch, type FingerprintWindow } from './matcher.js'
import { getSegmentSettings } from './settings.js'
import { contentSignature, SIGNATURE_ALGORITHM } from './signature.js'

const logger = createLogger('Segments')
export const DETECTOR_VERSION = 'segment-detector-v1'

interface EpisodeRow {
  id: number
  series_id: number
  season_number: number
  episode_number: number
  file_path: string
  file_size: number | null
  runtime: number | null
}

interface LinkedEpisode extends EpisodeRow {
  signature: string
  fileSize: number
  duration: number
}

interface Marker { start: number; end: number; method: string; confidence: number }
interface EpisodeMarkers { intro?: Marker; credits?: Marker }

const abortIfNeeded = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Segment analysis cancelled')
}

function analysisSetHash(episodes: LinkedEpisode[], settings: ReturnType<typeof getSegmentSettings>): string {
  return createHash('sha256').update(JSON.stringify({
    signatures: episodes.map(e => e.signature).sort(),
    detectorVersion: DETECTOR_VERSION,
    introWindowSeconds: settings.introWindowSeconds,
    creditsWindowSeconds: settings.creditsWindowSeconds,
    minimumMatchSeconds: settings.minimumMatchSeconds,
    confidenceThreshold: settings.confidenceThreshold,
  })).digest('hex')
}

async function linkEpisode(row: EpisodeRow): Promise<LinkedEpisode> {
  const identity = await contentSignature(row.file_path)
  const duration = probeTracks(row.file_path)?.durationSec ?? (row.runtime ? row.runtime * 60 : 0)
  if (!duration || duration < 30) throw new Error(`Could not determine duration for episode ${row.id}`)
  const db = getDb()
  db.prepare(`
    INSERT INTO media_segments (media_signature, signature_algorithm, file_size, detector_version, analysis_state)
    VALUES (?, ?, ?, ?, 'pending')
    ON CONFLICT(media_signature) DO UPDATE SET
      file_size = excluded.file_size,
      signature_algorithm = excluded.signature_algorithm,
      updated_at = datetime('now')
  `).run(identity.signature, SIGNATURE_ALGORITHM, identity.fileSize, DETECTOR_VERSION)
  db.prepare(`
    INSERT INTO media_segment_links (episode_id, media_signature, file_path, file_size, linked_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(episode_id) DO UPDATE SET
      media_signature = excluded.media_signature,
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      linked_at = excluded.linked_at
  `).run(row.id, identity.signature, row.file_path, identity.fileSize)
  return { ...row, signature: identity.signature, fileSize: identity.fileSize, duration }
}

async function chapterMarkers(filePath: string): Promise<EpisodeMarkers> {
  let result: ChapterProbeResult
  try { result = await probeChapters(filePath) } catch { return {} }
  const named = (pattern: RegExp) => result.chapters.find(chapter => pattern.test(chapter.title.trim()))
  const intro = named(/(^|\b)(intro|opening|opening theme|theme song|op)(\b|$)/i)
  const credits = named(/(^|\b)(credits?|end credits|ending|closing|ed)(\b|$)/i)
  const valid = (chapter: ChapterProbeResult['chapters'][number] | undefined): Marker | undefined => {
    if (!chapter || chapter.endTime - chapter.startTime < 4) return undefined
    return { start: chapter.startTime, end: chapter.endTime, method: 'chapter', confidence: 0.99 }
  }
  return { intro: valid(intro), credits: valid(credits) }
}

function fingerprintCacheKey(kind: 'head' | 'tail', seconds: number): string {
  return `${FINGERPRINT_ALGORITHM}:${kind}:${seconds}:v1`
}

async function getFingerprint(
  episode: LinkedEpisode,
  kind: 'head' | 'tail',
  windowSeconds: number,
  signal?: AbortSignal,
): Promise<FingerprintWindow> {
  const db = getDb()
  const algorithm = fingerprintCacheKey(kind, windowSeconds)
  const cached = db.prepare(`
    SELECT fingerprint, frame_count, seconds_per_frame, processed_start, processed_duration
    FROM media_segment_fingerprints
    WHERE media_signature = ? AND window_kind = ? AND algorithm = ? AND encoding = ?
  `).get(episode.signature, kind, algorithm, FINGERPRINT_ENCODING) as any
  if (cached) {
    try {
      return {
        frames: decodeFingerprint(cached.fingerprint as Buffer),
        secondsPerFrame: cached.seconds_per_frame,
        processedStart: cached.processed_start,
        processedDuration: cached.processed_duration,
      }
    } catch {
      db.prepare('DELETE FROM media_segment_fingerprints WHERE media_signature = ? AND window_kind = ? AND algorithm = ?').run(
        episode.signature, kind, algorithm,
      )
    }
  }

  abortIfNeeded(signal)
  const processedDuration = kind === 'head'
    ? Math.min(windowSeconds, episode.duration * 0.25)
    : Math.min(windowSeconds, episode.duration)
  const processedStart = kind === 'head' ? 0 : Math.max(0, episode.duration - processedDuration)
  const fingerprint = await fingerprintAudioWindow(episode.file_path, processedStart, processedDuration, signal)
  db.prepare(`
    INSERT OR REPLACE INTO media_segment_fingerprints
      (media_signature, window_kind, algorithm, encoding, fingerprint, frame_count,
       seconds_per_frame, processed_start, processed_duration, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    episode.signature, kind, algorithm, FINGERPRINT_ENCODING, encodeFingerprint(fingerprint.frames),
    fingerprint.frames.length, fingerprint.secondsPerFrame, fingerprint.processedStart, fingerprint.processedDuration,
  )
  return fingerprint
}

function recurringMarkers(
  windows: Map<string, FingerprintWindow>,
  minimumSeconds: number,
  maximumSeconds: number,
  confidenceThreshold: number,
): Map<string, Marker> {
  const entries = [...windows.entries()]
  if (entries.length < 2) return new Map()
  let best: { markers: Map<string, Marker>; matches: number; confidence: number } | null = null

  for (let reference = 0; reference < entries.length; reference++) {
    const [referenceSignature, referenceWindow] = entries[reference]
    const markers = new Map<string, Marker>()
    const referenceMatches: FingerprintMatch[] = []
    let confidence = 0
    for (let other = 0; other < entries.length; other++) {
      if (other === reference) continue
      const [signature, window] = entries[other]
      const match = matchFingerprintWindows(referenceWindow, window, { minimumSeconds, confidenceThreshold })
      if (!match || match.duration > maximumSeconds) continue
      referenceMatches.push(match)
      confidence += match.confidence
      markers.set(signature, { start: match.startB, end: match.endB, method: 'chromaprint', confidence: match.confidence })
    }
    if (referenceMatches.length === 0) continue
    const starts = referenceMatches.map(match => match.startA).sort((a, b) => a - b)
    const ends = referenceMatches.map(match => match.endA).sort((a, b) => a - b)
    const middle = Math.floor(referenceMatches.length / 2)
    markers.set(referenceSignature, {
      start: starts[middle], end: ends[middle], method: 'chromaprint',
      confidence: confidence / referenceMatches.length,
    })
    const candidate = { markers, matches: referenceMatches.length, confidence: confidence / referenceMatches.length }
    if (!best || candidate.matches > best.matches || (candidate.matches === best.matches && candidate.confidence > best.confidence)) best = candidate
  }
  const requiredSupport = Math.max(2, Math.ceil(entries.length * 0.5))
  return best && best.markers.size >= requiredSupport ? best.markers : new Map()
}

function writeResults(
  episodes: LinkedEpisode[],
  markers: Map<string, EpisodeMarkers>,
  errors: Map<string, string>,
  setHash: string,
): void {
  const db = getDb()
  const update = db.prepare(`
    UPDATE media_segments SET
      intro_start_seconds = ?, intro_end_seconds = ?, intro_method = ?, intro_confidence = ?,
      credits_start_seconds = ?, credits_end_seconds = ?, credits_method = ?, credits_confidence = ?,
      analysis_set_hash = ?, detector_version = ?, analysis_state = ?, last_error = ?,
      analysed_at = datetime('now'), updated_at = datetime('now')
    WHERE media_signature = ?
  `)
  db.transaction(() => {
    for (const episode of episodes) {
      const found = markers.get(episode.signature) ?? {}
      const error = errors.get(episode.signature)
      const state = found.intro && found.credits ? 'detected' : found.intro || found.credits ? 'partial' : error ? 'failed' : 'no_match'
      update.run(
        found.intro?.start ?? null, found.intro?.end ?? null, found.intro?.method ?? null, found.intro?.confidence ?? null,
        found.credits?.start ?? null, found.credits?.end ?? null, found.credits?.method ?? null, found.credits?.confidence ?? null,
        setHash, DETECTOR_VERSION, state, error?.slice(0, 1000) ?? null, episode.signature,
      )
    }
  })()
}

export interface SegmentAnalysisProgress {
  progress: number
  stage: string
  completed: number
  total: number
}

export async function analyseSeason(
  seriesId: number,
  seasonNumber: number,
  signal?: AbortSignal,
  onProgress?: (update: SegmentAnalysisProgress) => void,
): Promise<{ episodes: number; detected: number }> {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, series_id, season_number, episode_number, file_path, file_size, runtime
    FROM episodes
    WHERE series_id = ? AND season_number = ? AND file_path IS NOT NULL
    ORDER BY episode_number
  `).all(seriesId, seasonNumber) as EpisodeRow[]
  const available = rows.filter(row => existsSync(row.file_path))
  if (available.length === 0) return { episodes: 0, detected: 0 }
  const report = (progress: number, stage: string, completed = 0) => onProgress?.({ progress, stage, completed, total: available.length })
  report(0.02, 'Linking episode files')

  const episodes: LinkedEpisode[] = []
  for (const row of available) {
    abortIfNeeded(signal)
    episodes.push(await linkEpisode(row))
    report(0.02 + (episodes.length / available.length) * 0.08, 'Linking episode files', episodes.length)
  }
  const settings = getSegmentSettings()
  const setHash = analysisSetHash(episodes, settings)
  const alreadyCurrent = episodes.every(episode => {
    const row = db.prepare('SELECT detector_version, analysis_set_hash, analysis_state, last_error FROM media_segments WHERE media_signature = ?').get(episode.signature) as any
    return row?.detector_version === DETECTOR_VERSION && row?.analysis_set_hash === setHash
      && ['detected', 'partial', 'no_match'].includes(row.analysis_state) && !row.last_error
  })
  if (alreadyCurrent) {
    const detected = episodes.filter(episode => {
      const row = db.prepare('SELECT intro_start_seconds, credits_start_seconds FROM media_segments WHERE media_signature = ?').get(episode.signature) as any
      return row?.intro_start_seconds != null || row?.credits_start_seconds != null
    }).length
    return { episodes: episodes.length, detected }
  }

  const signatures = [...new Set(episodes.map(episode => episode.signature))]
  const placeholders = signatures.map(() => '?').join(',')
  db.prepare(`UPDATE media_segments SET analysis_state = 'analysing', attempts = attempts + 1, last_error = NULL, updated_at = datetime('now') WHERE media_signature IN (${placeholders})`).run(...signatures)

  const markers = new Map<string, EpisodeMarkers>()
  for (const episode of episodes) {
    abortIfNeeded(signal)
    markers.set(episode.signature, await chapterMarkers(episode.file_path))
    report(0.1 + (markers.size / episodes.length) * 0.1, 'Reading chapter markers', markers.size)
  }

  const introWindows = new Map<string, FingerprintWindow>()
  const creditsWindows = new Map<string, FingerprintWindow>()
  const fingerprintErrors = new Map<string, string>()
  let fingerprinted = 0
  for (const episode of episodes) {
    abortIfNeeded(signal)
    const existing = markers.get(episode.signature) ?? {}
    if (!existing.intro) {
      try { introWindows.set(episode.signature, await getFingerprint(episode, 'head', settings.introWindowSeconds, signal)) }
      catch (error) {
        abortIfNeeded(signal)
        fingerprintErrors.set(episode.signature, `Intro fingerprint: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (!existing.credits) {
      try { creditsWindows.set(episode.signature, await getFingerprint(episode, 'tail', settings.creditsWindowSeconds, signal)) }
      catch (error) {
        abortIfNeeded(signal)
        const previous = fingerprintErrors.get(episode.signature)
        fingerprintErrors.set(episode.signature, `${previous ? `${previous}; ` : ''}Credits fingerprint: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    fingerprinted++
    report(0.2 + (fingerprinted / episodes.length) * 0.68, 'Fingerprinting episode audio', fingerprinted)
  }

  report(0.9, 'Matching recurring segments', episodes.length)
  for (const [signature, marker] of recurringMarkers(introWindows, settings.minimumMatchSeconds, 120, settings.confidenceThreshold)) {
    const existing = markers.get(signature) ?? {}
    existing.intro = marker
    markers.set(signature, existing)
  }
  for (const [signature, marker] of recurringMarkers(creditsWindows, settings.minimumMatchSeconds, 300, settings.confidenceThreshold)) {
    const existing = markers.get(signature) ?? {}
    existing.credits = marker
    markers.set(signature, existing)
  }

  abortIfNeeded(signal)
  report(0.97, 'Saving detected segments', episodes.length)
  writeResults(episodes, markers, fingerprintErrors, setHash)
  const detected = episodes.filter(episode => {
    const found = markers.get(episode.signature)
    return Boolean(found?.intro || found?.credits)
  }).length
  logger.info(`Analysed series ${seriesId} season ${seasonNumber}: ${detected}/${episodes.length} episodes with segments`)
  report(1, 'Complete', episodes.length)
  return { episodes: episodes.length, detected }
}

export function markSeasonAnalysis(seriesId: number, seasonNumber: number, state: 'failed' | 'cancelled', error?: string): void {
  getDb().prepare(`
    UPDATE media_segments SET analysis_state = ?, last_error = ?, updated_at = datetime('now')
    WHERE media_signature IN (
      SELECT l.media_signature FROM media_segment_links l
      JOIN episodes e ON e.id = l.episode_id
      WHERE e.series_id = ? AND e.season_number = ?
    )
  `).run(state, error?.slice(0, 1000) ?? null, seriesId, seasonNumber)
}

export interface EpisodeSegmentPayload {
  segments: {
    intro?: { start: number; end: number; confidence: number; method: string }
    credits?: { start: number; end: number; confidence: number; method: string }
  } | null
  segmentAnalysis: { state: string; analysedAt: string | null; detectorVersion: string | null } | null
  /** Server-only retry signal; routes must not serialize it to Player. */
  shouldRetry: boolean
}

export function getEpisodeSegments(episodeId: number): EpisodeSegmentPayload {
  const row = getDb().prepare(`
    SELECT s.*, l.file_path AS linked_path, l.file_size AS linked_size,
           e.file_path AS current_path, e.file_size AS current_size
    FROM episodes e
    LEFT JOIN media_segment_links l ON l.episode_id = e.id
    LEFT JOIN media_segments s ON s.media_signature = l.media_signature
    WHERE e.id = ?
  `).get(episodeId) as any
  const stale = row && (row.linked_path !== row.current_path
    || (row.current_size != null && row.linked_size !== row.current_size))
  if (!row || !row.media_signature || stale) return { segments: null, segmentAnalysis: null, shouldRetry: true }
  const segments: NonNullable<EpisodeSegmentPayload['segments']> = {}
  if (row.intro_start_seconds != null && row.intro_end_seconds != null) segments.intro = {
    start: row.intro_start_seconds, end: row.intro_end_seconds,
    confidence: row.intro_confidence, method: row.intro_method,
  }
  if (row.credits_start_seconds != null && row.credits_end_seconds != null) segments.credits = {
    start: row.credits_start_seconds, end: row.credits_end_seconds,
    confidence: row.credits_confidence, method: row.credits_method,
  }
  return {
    segments: Object.keys(segments).length ? segments : null,
    segmentAnalysis: {
      state: row.analysis_state, analysedAt: row.analysed_at, detectorVersion: row.detector_version,
    },
    shouldRetry: Boolean(row.last_error) || ['pending', 'queued', 'analysing', 'failed', 'cancelled'].includes(row.analysis_state),
  }
}

export function segmentDatabaseStatus() {
  const db = getDb()
  const states = db.prepare('SELECT analysis_state AS state, COUNT(*) AS count FROM media_segments GROUP BY analysis_state').all() as Array<{ state: string; count: number }>
  const links = (db.prepare('SELECT COUNT(*) AS count FROM media_segment_links').get() as { count: number }).count
  const fingerprints = (db.prepare('SELECT COUNT(*) AS count FROM media_segment_fingerprints').get() as { count: number }).count
  const fingerprintBytes = (db.prepare('SELECT COALESCE(SUM(length(fingerprint)), 0) AS bytes FROM media_segment_fingerprints').get() as { bytes: number }).bytes
  return { states: Object.fromEntries(states.map(row => [row.state, row.count])), links, fingerprints, fingerprintBytes }
}
