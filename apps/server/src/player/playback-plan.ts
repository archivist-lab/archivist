import type { PlayerClientCapabilities, PlayerPlaybackPlan, PlayerSubtitleMode } from '@archivist/contracts'
import { PLAYER_CAPABILITY_SCHEMA_VERSION, PLAYER_PLAYBACK_PLAN_VERSION } from '@archivist/contracts'
import type { MediaTracks } from './media.js'

export class PlayerCapabilityValidationError extends Error {}
const norm = (value: string) => value.trim().toLowerCase()
const set = (values: string[]) => new Set(values.map(norm).filter(Boolean))

export function validatePlayerCapabilities(value: unknown): PlayerClientCapabilities {
  if (!value || typeof value !== 'object') throw new PlayerCapabilityValidationError('capabilities are required')
  const input = value as Record<string, unknown>
  if (input.version !== PLAYER_CAPABILITY_SCHEMA_VERSION) throw new PlayerCapabilityValidationError('unsupported capability version')
  if (typeof input.clientId !== 'string' || !input.clientId.trim() || input.clientId.length > 120) throw new PlayerCapabilityValidationError('invalid clientId')
  const list = (key: string, required = true) => {
    const raw = input[key]
    if (!Array.isArray(raw) || (required && !raw.length) || raw.some(v => typeof v !== 'string')) throw new PlayerCapabilityValidationError(`invalid ${key}`)
    const result = [...new Set((raw as string[]).map(norm).filter(Boolean))]
    if (result.length > 100) throw new PlayerCapabilityValidationError(`invalid ${key}`)
    return result
  }
  const limit = (key: string) => {
    if (input[key] == null) return null
    const value = Number(input[key])
    if (!Number.isSafeInteger(value) || value <= 0) throw new PlayerCapabilityValidationError(`invalid ${key}`)
    return value
  }
  const hdrModes = list('hdrModes', false)
  if (hdrModes.some(v => !['sdr', 'hdr10', 'hlg', 'dolby-vision'].includes(v))) throw new PlayerCapabilityValidationError('invalid hdrModes')
  if (typeof input.supportsRemux !== 'boolean' || typeof input.supportsSegmentedStreaming !== 'boolean') throw new PlayerCapabilityValidationError('invalid streaming flags')
  return {
    version: PLAYER_CAPABILITY_SCHEMA_VERSION, clientId: input.clientId.trim(),
    containers: list('containers'), videoCodecs: list('videoCodecs'), audioCodecs: list('audioCodecs'),
    subtitleCodecs: list('subtitleCodecs', false), hdrModes: hdrModes as PlayerClientCapabilities['hdrModes'],
    maxWidth: limit('maxWidth'), maxHeight: limit('maxHeight'), maxVideoBitrate: limit('maxVideoBitrate'),
    supportsRemux: input.supportsRemux, supportsSegmentedStreaming: input.supportsSegmentedStreaming,
  }
}

const aliases: Record<string, string[]> = { mp4: ['mp4', 'mov'], mov: ['mov', 'mp4'], mkv: ['matroska'], matroska: ['matroska', 'mkv'], webm: ['webm'] }
const containerSupported = (value: string | null, supported: Set<string>) => !!value && value.split(',').map(norm).some(container =>
  supported.has(container) || Object.entries(aliases).some(([alias, values]) => supported.has(alias) && values.includes(container)))

export function buildPlaybackPlan(input: {
  tracks: MediaTracks; capabilities: PlayerClientCapabilities; directUrl: string; transcodeUrl: string
  subtitleUrl: (index: number) => string; audioTrackIndex?: number | null; subtitleTrackIndex?: number | null
}): PlayerPlaybackPlan {
  const { tracks, capabilities } = input
  const audio = (input.audioTrackIndex == null ? null : tracks.audio.find(t => t.index === input.audioTrackIndex)) ?? tracks.audio.find(t => t.default) ?? tracks.audio[0] ?? null
  const subtitle = input.subtitleTrackIndex == null ? null : tracks.subtitles.find(t => t.index === input.subtitleTrackIndex) ?? null
  const videoCodec = tracks.video?.codec ? norm(tracks.video.codec) : null
  const audioCodec = audio?.codec ? norm(audio.codec) : null
  const reasons: string[] = []
  const videoCopy = (!videoCodec || set(capabilities.videoCodecs).has(videoCodec))
    && (!tracks.video?.width || !capabilities.maxWidth || tracks.video.width <= capabilities.maxWidth)
    && (!tracks.video?.height || !capabilities.maxHeight || tracks.video.height <= capabilities.maxHeight)
  if (!videoCopy) reasons.push('video-unsupported')
  const audioCopy = !audioCodec || set(capabilities.audioCodecs).has(audioCodec)
  if (!audioCopy) reasons.push('audio-codec-unsupported')
  let subtitleMode: PlayerSubtitleMode = 'none'
  if (subtitle) {
    if (set(capabilities.subtitleCodecs).has(norm(subtitle.codec))) subtitleMode = 'native'
    else if (subtitle.textBased && set(capabilities.subtitleCodecs).has('webvtt')) subtitleMode = 'convert'
    else { subtitleMode = 'burn-in'; reasons.push('subtitle-burn-in-required') }
  }
  const containerCopy = containerSupported(tracks.container, set(capabilities.containers))
  if (!containerCopy) reasons.push('container-unsupported')
  const direct = containerCopy && videoCopy && audioCopy && subtitleMode !== 'burn-in'
  const mode = direct ? 'direct' : 'transcode'
  if (!direct && !capabilities.supportsSegmentedStreaming) reasons.push('segmented-streaming-unavailable')
  const query = new URLSearchParams()
  if (audio) query.set('audio', String(audio.index))
  if (subtitle && subtitleMode === 'burn-in') query.set('subs', String(subtitle.index))
  return {
    version: PLAYER_PLAYBACK_PLAN_VERSION, mode,
    mediaUrl: direct ? input.directUrl : `${input.transcodeUrl}${query.size ? `${input.transcodeUrl.includes('?') ? '&' : '?'}${query}` : ''}`,
    manifestUrl: null, selectedAudioTrackIndex: audio?.index ?? null, selectedSubtitleTrackIndex: subtitle?.index ?? null,
    subtitleMode, subtitleUrl: subtitle && ['native', 'convert'].includes(subtitleMode) ? input.subtitleUrl(subtitle.index) : null,
    videoDecision: { action: videoCopy && subtitleMode !== 'burn-in' ? 'copy' : 'transcode', codec: videoCodec, reason: videoCopy ? 'client-compatible' : 'video-unsupported' },
    audioDecision: { action: audioCopy ? 'copy' : 'transcode', codec: audioCodec, reason: audioCopy ? 'client-compatible' : 'audio-codec-unsupported' },
    hdrDecision: { action: 'not-applicable', reason: 'hdr-metadata-not-yet-probed' },
    quality: { width: tracks.video?.width ?? null, height: tracks.video?.height ?? null, bitrate: null },
    reasons: direct ? ['direct-compatible'] : reasons,
  }
}
