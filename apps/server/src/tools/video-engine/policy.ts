/**
 * Optimisation policies — codec behaviour is never hardcoded; every decision is
 * policy-driven so new codecs (H266, AV2, …) need only a new encoder plugin and
 * a new target, not core changes. Policies are stored in app_settings and
 * editable from Settings → Processing.
 */

import { getAppSetting, setAppSetting } from '../../shared/settings.js'

export type VideoCodec = 'h264' | 'hevc' | 'av1' | 'vc1' | 'mpeg2video' | 'vp9' | 'h266'
export type QualityMode = 'constant_quality' | 'target_bitrate'

export interface VideoPolicy {
  /** Source codecs eligible for conversion. */
  convertCodecs: VideoCodec[]
  /** Source codecs always left untouched (already efficient). */
  skipCodecs: VideoCodec[]
  targetCodec: VideoCodec
  qualityMode: QualityMode
  /** CRF / quality level (lower = higher quality). */
  crf: number
  preserve: {
    resolution: boolean
    hdr: boolean
    dolbyVision: boolean
    frameRate: boolean
    chapters: boolean
  }
  /** Recommend conversion only when BOTH thresholds are met. */
  minimumSavingPercent: number
  minimumSavingGb: number
}

export interface AudioPolicy {
  /** Transcode audio streams whose codec isn't in keepCodecs. */
  enabled: boolean
  targetCodec: 'aac' | 'opus' | 'ac3' | 'eac3' | 'flac'
  /** Per-channel-config target bitrate hint (kbps for stereo; scaled up for 5.1/7.1). */
  stereoBitrateKbps: number
  keepCodecs: string[]
  /** Never transcode lossless master tracks (TrueHD, DTS-HD MA, FLAC, PCM). */
  preserveLossless: boolean
}

export interface OptimisationPolicy {
  name: string
  description: string
  video: VideoPolicy
  audio: AudioPolicy
}

const NO_CONVERT: VideoCodec[] = []

const AUDIO_DEFAULT: AudioPolicy = {
  enabled: false,
  targetCodec: 'aac',
  stereoBitrateKbps: 160,
  keepCodecs: ['aac', 'ac3', 'eac3', 'opus'],
  preserveLossless: true,
}

/** Built-in presets from the Video Optimisation Engine spec. */
export const BUILTIN_PRESETS: Record<string, OptimisationPolicy> = {
  'maximum-compatibility': {
    name: 'Maximum Compatibility',
    description: 'Target H264 for the widest device/browser support.',
    video: {
      convertCodecs: ['hevc', 'av1', 'vc1', 'mpeg2video', 'vp9'],
      skipCodecs: ['h264'],
      targetCodec: 'h264',
      qualityMode: 'constant_quality',
      crf: 20,
      preserve: { resolution: true, hdr: false, dolbyVision: false, frameRate: true, chapters: true },
      minimumSavingPercent: 20,
      minimumSavingGb: 2,
    },
    audio: { ...AUDIO_DEFAULT, targetCodec: 'aac' },
  },
  'balanced-archive': {
    name: 'Balanced Archive',
    description: 'Recommended default. Target HEVC; preserve HDR & Dolby Vision.',
    video: {
      convertCodecs: ['h264', 'vc1', 'mpeg2video'],
      skipCodecs: ['hevc', 'av1'],
      targetCodec: 'hevc',
      qualityMode: 'constant_quality',
      crf: 20,
      preserve: { resolution: true, hdr: true, dolbyVision: true, frameRate: true, chapters: true },
      minimumSavingPercent: 20,
      minimumSavingGb: 2,
    },
    audio: { ...AUDIO_DEFAULT },
  },
  'maximum-compression': {
    name: 'Maximum Compression',
    description: 'Target AV1 for the smallest files.',
    video: {
      convertCodecs: ['h264', 'hevc', 'vc1', 'mpeg2video', 'vp9'],
      skipCodecs: ['av1'],
      targetCodec: 'av1',
      qualityMode: 'constant_quality',
      crf: 28,
      preserve: { resolution: true, hdr: true, dolbyVision: true, frameRate: true, chapters: true },
      minimumSavingPercent: 15,
      minimumSavingGb: 1,
    },
    audio: { ...AUDIO_DEFAULT, targetCodec: 'opus', stereoBitrateKbps: 128 },
  },
  'original-preservation': {
    name: 'Original Preservation',
    description: 'No transcoding — only remux, track cleanup and metadata fixes.',
    video: {
      convertCodecs: NO_CONVERT,
      skipCodecs: ['h264', 'hevc', 'av1', 'vc1', 'mpeg2video', 'vp9', 'h266'],
      targetCodec: 'hevc',
      qualityMode: 'constant_quality',
      crf: 20,
      preserve: { resolution: true, hdr: true, dolbyVision: true, frameRate: true, chapters: true },
      minimumSavingPercent: 100,
      minimumSavingGb: 1000,
    },
    audio: { ...AUDIO_DEFAULT, enabled: false },
  },
}

export const DEFAULT_PRESET_ID = 'balanced-archive'

const SETTINGS_KEY = 'processingPolicy'

interface StoredPolicy {
  /** Which preset the active policy is based on / a custom override. */
  presetId: string
  /** Full policy (a preset clone, possibly edited). */
  policy: OptimisationPolicy
}

/** The active optimisation policy (global scope), defaulting to Balanced Archive. */
export function getActivePolicy(scope = 0): StoredPolicy {
  const fallback: StoredPolicy = { presetId: DEFAULT_PRESET_ID, policy: BUILTIN_PRESETS[DEFAULT_PRESET_ID] }
  const stored = getAppSetting<StoredPolicy | null>(SETTINGS_KEY, null, scope)
  if (!stored || !stored.policy?.video) return fallback
  return stored
}

export function setActivePolicy(value: StoredPolicy, scope = 0): void {
  setAppSetting(SETTINGS_KEY, value, scope)
}
