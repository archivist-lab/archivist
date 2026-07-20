import { basename } from 'node:path'
import { getExecutionConfig, setExecutionConfig } from '../tools/video-engine/execution-config.js'
import { cancelJob as cancelVideoJob, listJobs as listVideoJobs, pauseJob as pauseVideoJob, resumeJob as resumeVideoJob, resumePump } from '../tools/video-engine/queue.js'
import { getActivePolicy } from '../tools/video-engine/policy.js'
import { getSystemStats } from '../tools/video-engine/stats.js'
import { cancelSegmentAnalysis, segmentQueueStatus, setSegmentQueuePaused } from '../segments/queue.js'
import { cancelLoudnessJob, loudnessQueueStatus, pauseLoudnessJob, resumeLoudnessJob, setLoudnessQueuePaused } from '../player/loudness.js'
import { cancelTrackCleaningJob, pauseTrackCleaningJob, resumeTrackCleaningJob, setTrackCleaningQueuePaused, trackCleaningQueueStatus } from '../services/media-processor.js'

export type ProcessingNodeId = 'segments' | 'loudness' | 'video' | 'audio' | 'track-cleaning'
export type ProcessingItemStatus = 'queued' | 'running' | 'paused' | 'validating' | 'replacing'

export interface ProcessingMonitorItem {
  id: string
  title: string
  status: ProcessingItemStatus
  progress: number | null
  process: string
  detail: string
  etaSeconds: number | null
  queuePosition: number | null
  speed?: number | null
  startedAt?: number | null
  completed?: number
  total?: number
  canPause: boolean
  canCancel: boolean
  canSkip: boolean
}

export interface ProcessingMonitorNode {
  id: ProcessingNodeId
  label: string
  description: string
  state: 'idle' | 'running' | 'paused'
  paused: boolean
  pauseBehavior: 'immediate' | 'after-current' | 'shared'
  concurrency: number
  activeCount: number
  queuedCount: number
  activeItems: ProcessingMonitorItem[]
  queuedItems: ProcessingMonitorItem[]
  sharedWith?: ProcessingNodeId
}

export function estimateEtaSeconds(progress: number | null, startedAt: number | null, now = Date.now()): number | null {
  if (progress == null || progress <= 0.005 || progress >= 1 || startedAt == null || startedAt >= now) return null
  const elapsedSeconds = (now - startedAt) / 1000
  const estimate = elapsedSeconds * (1 - progress) / progress
  return Number.isFinite(estimate) ? Math.max(0, Math.round(estimate)) : null
}

const normaliseItem = (item: any, canPause: boolean, process: string): ProcessingMonitorItem => {
  const progress = Number.isFinite(item.progress) ? Math.max(0, Math.min(1, Number(item.progress))) : null
  const startedAt = Number.isFinite(item.startedAt) ? Number(item.startedAt) : null
  const status = item.status ?? 'running'
  return {
    id: String(item.id),
    title: String(item.title ?? item.id),
    status,
    progress,
    process: String(item.process ?? process),
    detail: String(item.detail ?? ''),
    etaSeconds: status === 'running' ? estimateEtaSeconds(progress, startedAt) : null,
    queuePosition: null,
    speed: Number.isFinite(item.speed) ? Number(item.speed) : null,
    startedAt,
    completed: Number.isFinite(item.completed) ? Number(item.completed) : undefined,
    total: Number.isFinite(item.total) ? Number(item.total) : undefined,
    canPause,
    canCancel: true,
    canSkip: true,
  }
}

const positionQueue = (items: ProcessingMonitorItem[]) => items.map((item, index) => ({ ...item, queuePosition: index + 1 }))

function videoItems(includeAudio: boolean) {
  const policy = getActivePolicy().policy
  const relevant = listVideoJobs().filter(job => {
    if (includeAudio) return job.action === 'convert' && (job.audioEncoding || (job.status === 'queued' && policy.audio.enabled))
    return true
  })
  const active = relevant.filter(job => ['encoding', 'validating', 'replacing'].includes(job.status))
  const queued = relevant.filter(job => job.status === 'queued')
  const map = (job: typeof relevant[number]): ProcessingMonitorItem => normaliseItem({
    id: job.id,
    title: job.title || basename(job.inputPath),
    status: job.suspended ? 'paused' : job.status === 'encoding' ? 'running' : job.status,
    progress: job.progress,
    detail: job.status === 'encoding' && job.encoder ? job.encoder : job.status,
    speed: job.speed,
    startedAt: job.startedAt,
  }, job.status === 'encoding', includeAudio
    ? `Encode audio to ${policy.audio.targetCodec.toUpperCase()} (combined media job)`
    : job.action === 'remux' ? 'Remux video container' : `Encode video to ${job.targetCodec?.toUpperCase() ?? policy.video.targetCodec.toUpperCase()}`)
  return { active: active.map(map), queued: positionQueue(queued.map(map)) }
}

function state(paused: boolean, active: number): ProcessingMonitorNode['state'] {
  return paused ? 'paused' : active > 0 ? 'running' : 'idle'
}

export function processingMonitorStatus() {
  const segments = segmentQueueStatus()
  const loudness = loudnessQueueStatus()
  const trackCleaning = trackCleaningQueueStatus()
  const execution = getExecutionConfig()
  const video = videoItems(false)
  const audio = videoItems(true)

  const nodes: ProcessingMonitorNode[] = [
    {
      id: 'segments', label: 'Intro & Credits Detection', description: 'Fingerprints episode audio and matches recurring intro and credit segments.',
      state: state(segments.paused, segments.active), paused: segments.paused, pauseBehavior: 'after-current', concurrency: segments.concurrency,
      activeCount: segments.active, queuedCount: segments.queued,
      activeItems: segments.activeItems.map(item => normaliseItem(item, false, 'Detect recurring intros and credits')), queuedItems: positionQueue(segments.queuedItems.map(item => normaliseItem(item, false, 'Detect recurring intros and credits'))),
    },
    {
      id: 'loudness', label: 'Volume Normalisation', description: 'Measures integrated loudness for consistent direct play and transcoded playback.',
      state: state(loudness.paused, loudness.active), paused: loudness.paused, pauseBehavior: 'immediate', concurrency: loudness.concurrency,
      activeCount: loudness.active, queuedCount: loudness.queued,
      activeItems: loudness.activeItems.map(item => normaliseItem(item, true, 'Measure integrated loudness')), queuedItems: positionQueue(loudness.queuedItems.map(item => normaliseItem(item, false, 'Measure integrated loudness'))),
    },
    {
      id: 'video', label: 'Video Encoding', description: 'Converts or remuxes library video, then validates and atomically replaces the source.',
      state: state(execution.paused, video.active.length), paused: execution.paused, pauseBehavior: 'immediate', concurrency: execution.workerConcurrency,
      activeCount: video.active.length, queuedCount: video.queued.length, activeItems: video.active, queuedItems: video.queued,
    },
    {
      id: 'audio', label: 'Audio Encoding', description: 'Encodes audio tracks according to the active processing policy as part of the media job.',
      state: state(execution.paused, audio.active.length), paused: execution.paused, pauseBehavior: 'shared', concurrency: execution.workerConcurrency,
      activeCount: audio.active.length, queuedCount: audio.queued.length, activeItems: audio.active, queuedItems: audio.queued, sharedWith: 'video',
    },
    {
      id: 'track-cleaning', label: 'Media Track Cleaning', description: 'Losslessly removes unwanted tracks and rewrites chapters or embedded metadata.',
      state: state(trackCleaning.paused, trackCleaning.active), paused: trackCleaning.paused, pauseBehavior: 'immediate', concurrency: trackCleaning.concurrency,
      activeCount: trackCleaning.active, queuedCount: trackCleaning.queued,
      activeItems: trackCleaning.activeItems.map(item => normaliseItem(item, true, 'Clean media tracks and metadata')), queuedItems: positionQueue(trackCleaning.queuedItems.map(item => normaliseItem(item, false, 'Clean media tracks and metadata'))),
    },
  ]

  const primaryNodes = nodes.filter(node => !node.sharedWith)
  return {
    generatedAt: Date.now(),
    summary: {
      active: primaryNodes.reduce((sum, node) => sum + node.activeCount, 0),
      queued: primaryNodes.reduce((sum, node) => sum + node.queuedCount, 0),
      paused: primaryNodes.filter(node => node.paused).length,
      resources: getSystemStats(),
    },
    nodes,
  }
}

export function setProcessingNodePaused(nodeId: ProcessingNodeId, paused: boolean): boolean {
  if (nodeId === 'segments') return setSegmentQueuePaused(paused)
  if (nodeId === 'loudness') return setLoudnessQueuePaused(paused)
  if (nodeId === 'track-cleaning') return setTrackCleaningQueuePaused(paused)
  if (nodeId === 'video' || nodeId === 'audio') {
    const config = setExecutionConfig({ paused })
    if (!config.paused) resumePump()
    return config.paused
  }
  return false
}

export function controlProcessingItem(nodeId: ProcessingNodeId, itemId: string, action: 'pause' | 'resume' | 'cancel' | 'skip'): boolean {
  if (nodeId === 'segments') return action === 'cancel' || action === 'skip' ? cancelSegmentAnalysis(itemId) > 0 : false
  if (nodeId === 'loudness') return action === 'pause' ? pauseLoudnessJob(itemId) : action === 'resume' ? resumeLoudnessJob(itemId) : cancelLoudnessJob(itemId)
  if (nodeId === 'track-cleaning') return action === 'pause' ? pauseTrackCleaningJob(itemId) : action === 'resume' ? resumeTrackCleaningJob(itemId) : cancelTrackCleaningJob(itemId)
  if (nodeId === 'video' || nodeId === 'audio') return action === 'pause' ? pauseVideoJob(itemId) : action === 'resume' ? resumeVideoJob(itemId) : cancelVideoJob(itemId)
  return false
}
