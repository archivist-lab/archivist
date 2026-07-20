import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createLogger } from '@archivist/core'
import { getDb } from '../db.js'
import { probeTracks } from '../player/media.js'
import { decodeFingerprint, encodeFingerprint, FINGERPRINT_ALGORITHM, FINGERPRINT_ENCODING, fingerprintAudioWindow, selectFingerprintAudioTrack, type FingerprintAudioTrack } from './fingerprint.js'
import { matchFingerprintWindows, type FingerprintMatch, type FingerprintWindow } from './matcher.js'
import { refineMarkerBoundaries } from './refinement.js'
import { getSeasonSegmentSettings, type SegmentSettings } from './settings.js'
import { contentSignature, SIGNATURE_ALGORITHM } from './signature.js'
import { detectVisualCredits } from './visual-credits.js'

const logger = createLogger('Segments')
export const DETECTOR_VERSION = 'segment-detector-v5-independent-segments'

interface EpisodeRow {
  id: number
  series_id: number
  season_number: number
  episode_number: number
  file_path: string
  file_size: number | null
  runtime: number | null
  original_language: string | null
}

interface LinkedEpisode extends EpisodeRow {
  signature: string
  fileSize: number
  duration: number
  audio: FingerprintAudioTrack
}

interface Marker { start: number; end: number; method: string; confidence: number }
interface EpisodeMarkers { intro?: Marker; credits?: Marker }

const abortIfNeeded = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Segment analysis cancelled')
}

function analysisSetHash(episodes: LinkedEpisode[], settings: SegmentSettings): string {
  return createHash('sha256').update(JSON.stringify({
    signatures: episodes.map(e => e.signature).sort(),
    detectorVersion: DETECTOR_VERSION,
    introWindowSeconds: settings.introWindowSeconds,
    creditsWindowSeconds: settings.creditsWindowSeconds,
    minimumMatchSeconds: settings.minimumMatchSeconds,
    confidenceThreshold: settings.confidenceThreshold,
    seasonSupportRatio: settings.seasonSupportRatio,
    refineWithSilence: settings.refineWithSilence,
    refineWithBlackFrames: settings.refineWithBlackFrames,
    audioStreams: episodes.map(episode => episode.audio.index),
  })).digest('hex')
}

async function linkEpisode(row: EpisodeRow, settings: SegmentSettings): Promise<LinkedEpisode> {
  const identity = await contentSignature(row.file_path)
  const media = probeTracks(row.file_path)
  const audio = selectFingerprintAudioTrack(media?.audio ?? [], settings.preferredLanguage, row.original_language)
  if (!audio) throw new Error(`Could not select a main audio track for episode ${row.id}`)
  const duration = media?.durationSec ?? (row.runtime ? row.runtime * 60 : 0)
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
  db.prepare(`UPDATE media_segments SET audio_stream_index = ?, audio_language = ?, audio_title = ?, audio_codec = ?, audio_channels = ?, updated_at = datetime('now') WHERE media_signature = ?`).run(
    audio.index, audio.languageCode, audio.title, audio.codec, audio.channels, identity.signature,
  )
  db.prepare(`
    INSERT INTO media_segment_links (episode_id, media_signature, file_path, file_size, linked_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(episode_id) DO UPDATE SET
      media_signature = excluded.media_signature,
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      linked_at = excluded.linked_at
  `).run(row.id, identity.signature, row.file_path, identity.fileSize)
  return { ...row, signature: identity.signature, fileSize: identity.fileSize, duration, audio }
}

function fingerprintCacheKey(kind: 'head' | 'tail', seconds: number, audioStreamIndex: number): string {
  return `${FINGERPRINT_ALGORITHM}:${kind}:${seconds}:stream-${audioStreamIndex}:stereo-v3`
}

async function getFingerprint(
  episode: LinkedEpisode,
  kind: 'head' | 'tail',
  windowSeconds: number,
  signal?: AbortSignal,
): Promise<FingerprintWindow> {
  const db = getDb()
  const algorithm = fingerprintCacheKey(kind, windowSeconds, episode.audio.index)
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
  const fingerprint = await fingerprintAudioWindow(episode.file_path, processedStart, processedDuration, episode.audio.index, signal)
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
  supportRatio: number,
): Map<string, Marker> {
  const entries = [...windows.entries()]
  if (entries.length < 2) return new Map()
  const candidates = new Map<string, Array<{ start: number; end: number; confidence: number; peer: string }>>()
  const add = (signature: string, marker: { start: number; end: number; confidence: number }, peer: string) => {
    const list = candidates.get(signature) ?? []
    list.push({ ...marker, peer })
    candidates.set(signature, list)
  }
  for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) {
    const [leftSignature, leftWindow] = entries[left]
    const [rightSignature, rightWindow] = entries[right]
    const match = matchFingerprintWindows(leftWindow, rightWindow, { minimumSeconds, confidenceThreshold })
    if (!match || match.duration > maximumSeconds) continue
    add(leftSignature, { start: match.startA, end: match.endA, confidence: match.confidence }, rightSignature)
    add(rightSignature, { start: match.startB, end: match.endB, confidence: match.confidence }, leftSignature)
  }
  const requiredEpisodes = Math.max(2, Math.ceil(entries.length * supportRatio))
  const markers = new Map<string, Marker>()
  for (const [signature, allValues] of candidates) {
    if (allValues.length === 0) continue
    // Avoid blending a recap/sting with the actual title sequence. Cluster
    // candidates by start time, then prefer the cluster with the most peers;
    // ties go to the longest recurring region.
    const clusters: typeof allValues[] = []
    for (const value of [...allValues].sort((a, b) => a.start - b.start)) {
      const cluster = clusters.find(group => Math.abs(group.reduce((sum, item) => sum + item.start, 0) / group.length - value.start) <= 12)
      if (cluster) cluster.push(value)
      else clusters.push([value])
    }
    clusters.sort((a, b) => new Set(b.map(value => value.peer)).size - new Set(a.map(value => value.peer)).size || Math.max(...b.map(value => value.end - value.start)) - Math.max(...a.map(value => value.end - value.start)))
    const values = clusters[0]
    const median = (items: number[]) => items.sort((a, b) => a - b)[Math.floor(items.length / 2)]
    const peers = new Set(values.map(value => value.peer)).size + 1
    markers.set(signature, {
      start: median(values.map(value => value.start)), end: median(values.map(value => value.end)),
      method: peers >= requiredEpisodes ? 'chromaprint-consensus' : 'chromaprint-pair',
      confidence: values.reduce((sum, value) => sum + value.confidence, 0) / values.length,
    })
  }
  return markers
}

function writeResults(
  episodes: LinkedEpisode[],
  markers: Map<string, EpisodeMarkers>,
  errors: Map<string, string>,
  setHash: string,
  evidence: Map<string, Record<string, unknown>>,
): void {
  const db = getDb()
  const update = db.prepare(`
    UPDATE media_segments SET
      intro_start_seconds = ?, intro_end_seconds = ?, intro_method = ?, intro_confidence = ?,
      credits_start_seconds = ?, credits_end_seconds = ?, credits_method = ?, credits_confidence = ?,
      analysis_set_hash = ?, detector_version = ?, analysis_state = ?, last_error = ?,
      analysis_evidence = ?,
      analysed_at = datetime('now'), updated_at = datetime('now')
    WHERE media_signature = ? AND manually_locked = 0
  `)
  db.transaction(() => {
    for (const episode of episodes) {
      const found = markers.get(episode.signature) ?? {}
      const error = errors.get(episode.signature)
      const state = found.intro && found.credits ? 'detected' : found.intro || found.credits ? 'partial' : error ? 'failed' : 'no_match'
      update.run(
        found.intro?.start ?? null, found.intro?.end ?? null, found.intro?.method ?? null, found.intro?.confidence ?? null,
        found.credits?.start ?? null, found.credits?.end ?? null, found.credits?.method ?? null, found.credits?.confidence ?? null,
        setHash, DETECTOR_VERSION, state, error?.slice(0, 1000) ?? null,
        JSON.stringify(evidence.get(episode.signature) ?? {}), episode.signature,
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
    SELECT e.id, e.series_id, e.season_number, e.episode_number, e.file_path, e.file_size, e.runtime,
           series.language AS original_language
    FROM episodes e JOIN series ON series.id = e.series_id
    WHERE e.series_id = ? AND e.season_number = ? AND e.file_path IS NOT NULL
    ORDER BY e.episode_number
  `).all(seriesId, seasonNumber) as EpisodeRow[]
  const available = rows.filter(row => existsSync(row.file_path))
  if (available.length === 0) return { episodes: 0, detected: 0 }
  const settings = getSeasonSegmentSettings(seriesId, seasonNumber)
  const report = (progress: number, stage: string, completed = 0) => onProgress?.({ progress, stage, completed, total: available.length })
  report(0.02, 'Linking episode files')

  const episodes: LinkedEpisode[] = []
  for (const row of available) {
    abortIfNeeded(signal)
    episodes.push(await linkEpisode(row, settings))
    report(0.02 + (episodes.length / available.length) * 0.08, 'Linking episode files', episodes.length)
  }
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

  // Chapters are media metadata, not skip segments. Segment analysis starts
  // empty and is populated only by audio/visual detection or manual edits.
  const markers = new Map<string, EpisodeMarkers>()
  report(0.2, 'Preparing independent segment analysis', episodes.length)

  const introWindows = new Map<string, FingerprintWindow>()
  const creditsWindows = new Map<string, FingerprintWindow>()
  const fingerprintErrors = new Map<string, string>()
  let fingerprinted = 0
  for (const episode of episodes) {
    abortIfNeeded(signal)
    try { introWindows.set(episode.signature, await getFingerprint(episode, 'head', settings.introWindowSeconds, signal)) }
    catch (error) {
      abortIfNeeded(signal)
      fingerprintErrors.set(episode.signature, `Intro fingerprint: ${error instanceof Error ? error.message : String(error)}`)
    }
    try { creditsWindows.set(episode.signature, await getFingerprint(episode, 'tail', settings.creditsWindowSeconds, signal)) }
    catch (error) {
      abortIfNeeded(signal)
      const previous = fingerprintErrors.get(episode.signature)
      fingerprintErrors.set(episode.signature, `${previous ? `${previous}; ` : ''}Credits fingerprint: ${error instanceof Error ? error.message : String(error)}`)
    }
    fingerprinted++
    report(0.2 + (fingerprinted / episodes.length) * 0.68, 'Fingerprinting episode audio', fingerprinted)
  }

  report(0.9, 'Matching recurring segments', episodes.length)
  for (const [signature, marker] of recurringMarkers(introWindows, settings.minimumMatchSeconds, 120, settings.confidenceThreshold, settings.seasonSupportRatio)) {
    const existing = markers.get(signature) ?? {}
    existing.intro = marker
    markers.set(signature, existing)
  }
  for (const [signature, marker] of recurringMarkers(creditsWindows, settings.minimumMatchSeconds, 300, settings.confidenceThreshold, settings.seasonSupportRatio)) {
    const existing = markers.get(signature) ?? {}
    existing.credits = marker
    markers.set(signature, existing)
  }

  const evidence = new Map<string, Record<string, unknown>>()
  let visuallyScanned = 0
  for (const episode of episodes) {
    const existing = markers.get(episode.signature) ?? {}
    if (!existing.credits) {
      const visual = await detectVisualCredits(episode.file_path, episode.duration, settings.creditsWindowSeconds, signal)
      if (visual) {
        existing.credits = { start: visual.start, end: visual.end, method: visual.method, confidence: visual.confidence }
        markers.set(episode.signature, existing)
        evidence.set(episode.signature, { ...(evidence.get(episode.signature) ?? {}), visualCredits: visual.evidence })
      }
    }
    visuallyScanned++
    report(0.9 + (visuallyScanned / episodes.length) * 0.04, 'Scanning credit visuals', visuallyScanned)
  }

  // Embedded chapter names are advisory. Never persist an intro in the tail
  // credits window or two substantially overlapping skip ranges.
  for (const episode of episodes) {
    const found = markers.get(episode.signature)
    if (!found?.intro) continue
    const overlap = found.credits
      ? Math.max(0, Math.min(found.intro.end, found.credits.end) - Math.max(found.intro.start, found.credits.start))
      : 0
    const shorter = found.credits ? Math.min(found.intro.end - found.intro.start, found.credits.end - found.credits.start) : Infinity
    if (found.intro.start >= Math.max(0, episode.duration - settings.creditsWindowSeconds) || overlap >= shorter * 0.5) delete found.intro
  }

  let refined = 0
  for (const episode of episodes) {
    const found = markers.get(episode.signature)
    if (!found) continue
    const episodeEvidence: Record<string, unknown> = { ...(evidence.get(episode.signature) ?? {}), audio: episode.audio }
    if (found.intro) {
      const result = await refineMarkerBoundaries(episode.file_path, found.intro, episode.audio.index, { silence: settings.refineWithSilence, blackFrames: settings.refineWithBlackFrames }, signal)
      found.intro = result.marker
      episodeEvidence.introRefinement = result.evidence
    }
    if (found.credits) {
      const result = await refineMarkerBoundaries(episode.file_path, found.credits, episode.audio.index, { silence: settings.refineWithSilence, blackFrames: settings.refineWithBlackFrames }, signal)
      found.credits = result.marker
      episodeEvidence.creditsRefinement = result.evidence
    }
    evidence.set(episode.signature, episodeEvidence)
    refined++
    report(0.94 + (refined / episodes.length) * 0.03, 'Refining audio and video boundaries', refined)
  }

  abortIfNeeded(signal)
  report(0.97, 'Saving detected segments', episodes.length)
  writeResults(episodes, markers, fingerprintErrors, setHash, evidence)
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

export interface EpisodeSegmentUpdate {
  introStart?: number | null
  introEnd?: number | null
  creditsStart?: number | null
  creditsEnd?: number | null
  locked?: boolean
}

export function updateEpisodeSegments(episodeId: number, input: EpisodeSegmentUpdate): void {
  const db = getDb()
  const row = db.prepare(`
    SELECT e.file_path, e.runtime, l.media_signature
    FROM episodes e
    LEFT JOIN media_segment_links l ON l.episode_id = e.id
    WHERE e.id = ?
  `).get(episodeId) as { file_path: string | null; runtime: number | null; media_signature: string | null } | undefined
  if (!row) throw new Error('Episode not found')
  if (!row.media_signature) throw new Error('Episode has not been linked for segment analysis')

  const current = db.prepare(`
    SELECT intro_start_seconds, intro_end_seconds, credits_start_seconds, credits_end_seconds, manually_locked
    FROM media_segments WHERE media_signature = ?
  `).get(row.media_signature) as any
  const numberOrNull = (value: unknown, fallback: number | null): number | null => {
    if (value === undefined) return fallback
    if (value === null || value === '') return null
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0) throw new Error('Segment times must be positive numbers')
    return number
  }
  const introStart = numberOrNull(input.introStart, current.intro_start_seconds)
  const introEnd = numberOrNull(input.introEnd, current.intro_end_seconds)
  const creditsStart = numberOrNull(input.creditsStart, current.credits_start_seconds)
  const creditsEnd = numberOrNull(input.creditsEnd, current.credits_end_seconds)
  if ((introStart == null) !== (introEnd == null)) throw new Error('Intro start and end must both be set or both be cleared')
  if ((creditsStart == null) !== (creditsEnd == null)) throw new Error('Credits start and end must both be set or both be cleared')
  if (introStart != null && introEnd! <= introStart) throw new Error('Intro end must be after intro start')
  if (creditsStart != null && creditsEnd! <= creditsStart) throw new Error('Credits end must be after credits start')

  const duration = row.file_path && existsSync(row.file_path)
    ? probeTracks(row.file_path)?.durationSec ?? (row.runtime ? row.runtime * 60 : null)
    : (row.runtime ? row.runtime * 60 : null)
  for (const value of [introEnd, creditsEnd]) if (duration && value != null && value > duration + 1) throw new Error('Segment end exceeds the episode duration')
  const locked = input.locked === undefined ? Boolean(current.manually_locked) : Boolean(input.locked)
  const state = introStart != null && creditsStart != null ? 'detected' : introStart != null || creditsStart != null ? 'partial' : 'no_match'
  db.prepare(`
    UPDATE media_segments SET
      intro_start_seconds = ?, intro_end_seconds = ?, intro_method = ?, intro_confidence = ?,
      credits_start_seconds = ?, credits_end_seconds = ?, credits_method = ?, credits_confidence = ?,
      analysis_state = ?, manually_locked = ?, last_error = NULL,
      analysis_evidence = json_set(COALESCE(analysis_evidence, '{}'), '$.manualEdit', json('true')),
      analysed_at = datetime('now'), updated_at = datetime('now')
    WHERE media_signature = ?
  `).run(
    introStart, introEnd, introStart == null ? null : 'manual', introStart == null ? null : 1,
    creditsStart, creditsEnd, creditsStart == null ? null : 'manual', creditsStart == null ? null : 1,
    state, locked ? 1 : 0, row.media_signature,
  )
}

export function unlockEpisodeSegments(episodeId: number): { seriesId: number; seasonNumber: number } {
  const db = getDb()
  const row = db.prepare('SELECT series_id AS seriesId, season_number AS seasonNumber FROM episodes WHERE id = ?').get(episodeId) as { seriesId: number; seasonNumber: number } | undefined
  if (!row) throw new Error('Episode not found')
  db.prepare(`
    UPDATE media_segments SET manually_locked = 0, analysis_state = 'pending', analysis_set_hash = NULL,
      last_error = NULL, updated_at = datetime('now')
    WHERE media_signature IN (SELECT media_signature FROM media_segment_links WHERE episode_id = ?)
  `).run(episodeId)
  return row
}

export function segmentDatabaseStatus() {
  const db = getDb()
  const states = db.prepare('SELECT analysis_state AS state, COUNT(*) AS count FROM media_segments GROUP BY analysis_state').all() as Array<{ state: string; count: number }>
  const links = (db.prepare('SELECT COUNT(*) AS count FROM media_segment_links').get() as { count: number }).count
  const fingerprints = (db.prepare('SELECT COUNT(*) AS count FROM media_segment_fingerprints').get() as { count: number }).count
  const fingerprintBytes = (db.prepare('SELECT COALESCE(SUM(length(fingerprint)), 0) AS bytes FROM media_segment_fingerprints').get() as { bytes: number }).bytes
  const results = db.prepare(`
    SELECT e.id AS episodeId, series.id AS seriesId, series.title AS seriesTitle,
           e.season_number AS seasonNumber, e.episode_number AS episodeNumber, e.title AS episodeTitle,
           segments.analysis_state AS state, segments.attempts, segments.last_error AS lastError,
           segments.analysed_at AS analysedAt,
           segments.intro_start_seconds AS introStart, segments.intro_end_seconds AS introEnd,
           segments.intro_method AS introMethod, segments.intro_confidence AS introConfidence,
           segments.credits_start_seconds AS creditsStart, segments.credits_end_seconds AS creditsEnd,
           segments.credits_method AS creditsMethod, segments.credits_confidence AS creditsConfidence,
           segments.audio_stream_index AS audioStreamIndex, segments.audio_language AS audioLanguage,
           segments.audio_title AS audioTitle, segments.audio_codec AS audioCodec,
           segments.audio_channels AS audioChannels, segments.manually_locked AS manuallyLocked,
           segments.analysis_evidence AS analysisEvidence,
           (SELECT COUNT(*) FROM media_segment_fingerprints fingerprints
            WHERE fingerprints.media_signature = segments.media_signature) AS fingerprintCount
    FROM media_segment_links links
    JOIN episodes e ON e.id = links.episode_id
    JOIN series ON series.id = e.series_id
    JOIN media_segments segments ON segments.media_signature = links.media_signature
    ORDER BY COALESCE(segments.analysed_at, segments.updated_at) DESC, series.title, e.season_number, e.episode_number
    LIMIT 250
  `).all()
  return { states: Object.fromEntries(states.map(row => [row.state, row.count])), links, fingerprints, fingerprintBytes, results }
}
