/**
 * FFmpeg executor — the only place that shells out to ffmpeg to produce an
 * optimised output. Kept separate from queueing/validation/replacement so the
 * "how we encode" concern is isolated. Phase 2 implements the lossless **remux**
 * path; the transcode (convert) command builder is stubbed for the next step.
 */

import { spawn } from 'node:child_process'
import { createLogger } from '@archivist/core'
import type { MediaAnalysis, HdrFormat } from './analyzer.js'
import type { OptimisationPolicy } from './policy.js'
import { ffmpegBinary, type Accelerator } from './hwaccel.js'

const logger = createLogger('VideoExecutor')

export type ExecAction = 'remux' | 'convert'

export interface HdrSpec {
  format: HdrFormat
  colorPrimaries: string | null
  colorTransfer: string | null
  colorSpace: string | null
  masterDisplayX265: string | null
  maxCll: string | null
}

export interface EncodeSpec {
  action: ExecAction
  inputPath: string
  outputPath: string
  /** Present for convert; the target video codec. */
  targetCodec?: string
  crf?: number
  /** Total duration (sec) for progress calculation. */
  durationSec: number | null
  /** HDR metadata to carry through a transcode (convert only). */
  hdr?: HdrSpec
  /** Resolved ffmpeg encoder (e.g. libx265, hevc_nvenc); defaults to software. */
  encoder?: string
  accelerator?: Accelerator
  /** VAAPI/QSV render device (e.g. /dev/dri/renderD128). */
  device?: string | null
}

/** Map our codec ids to ffmpeg software encoders (Phase 3 swaps in HW encoders). */
const SOFTWARE_ENCODER: Record<string, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  av1: 'libsvtav1',
  vp9: 'libvpx-vp9',
}

/** Build the ffmpeg args for a spec. Always writes Matroska (broadest stream support). */
export function buildArgs(spec: EncodeSpec): string[] {
  const flags = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats']
  const mapAll = ['-map', '0', '-map_metadata', '0', '-map_chapters', '0']

  if (spec.action === 'remux') {
    // Lossless: copy every stream into MKV. No re-encode.
    return [...flags, '-i', spec.inputPath, ...mapAll, '-c', 'copy', '-f', 'matroska', spec.outputPath]
  }

  // convert: re-encode video, copy audio + subtitles, carry HDR through.
  const encoder = spec.encoder ?? SOFTWARE_ENCODER[spec.targetCodec ?? 'hevc'] ?? 'libx265'
  const accel: Accelerator = spec.accelerator ?? 'software'
  const crf = spec.crf ?? 20
  const hdr = spec.hdr
  const isHdr10 = hdr && (hdr.format === 'HDR10' || hdr.format === 'HDR10+')
  const tenBit = hdr && hdr.format !== 'SDR'

  // Color-tag passthrough so the output stays flagged as HDR/HLG for players.
  const colorArgs: string[] = []
  if (hdr?.colorPrimaries) colorArgs.push('-color_primaries', hdr.colorPrimaries)
  if (hdr?.colorTransfer) colorArgs.push('-color_trc', hdr.colorTransfer)
  if (hdr?.colorSpace) colorArgs.push('-colorspace', hdr.colorSpace)

  // Hardware device init (before -i) + upload filter (after -i) for VAAPI/QSV.
  const preInput: string[] = []
  const filterArgs: string[] = []
  const uploadFmt = tenBit ? 'nv12|p010le' : 'nv12'
  if (accel === 'vaapi' && spec.device) {
    preInput.push('-vaapi_device', spec.device)
    filterArgs.push('-vf', `format=${uploadFmt},hwupload`)
  } else if (accel === 'qsv' && spec.device) {
    preInput.push('-init_hw_device', `vaapi=va:${spec.device}`, '-init_hw_device', 'qsv=hw@va', '-filter_hw_device', 'hw')
    filterArgs.push('-vf', 'hwupload=extra_hw_frames=64,format=qsv')
  }

  const codecArgs: string[] = ['-c:v', encoder]
  if (encoder === 'libx265') {
    const x265 = ['log-level=error']
    if (isHdr10) {
      x265.push('hdr10=1', 'repeat-headers=1')
      if (hdr!.masterDisplayX265) x265.push(`master-display=${hdr!.masterDisplayX265}`)
      if (hdr!.maxCll) x265.push(`max-cll=${hdr!.maxCll}`)
    }
    codecArgs.push('-crf', String(crf), '-preset', 'medium', ...colorArgs, '-x265-params', x265.join(':'))
  } else if (encoder === 'libsvtav1') {
    codecArgs.push('-crf', String(crf), '-preset', '6', ...colorArgs)
    if (tenBit) codecArgs.push('-svtav1-params', 'enable-hdr=1')
  } else if (encoder === 'libx264' || encoder === 'libvpx-vp9') {
    codecArgs.push('-crf', String(crf), '-preset', 'medium', ...colorArgs)
  } else {
    // Hardware encoders — map the quality target to each vendor's rate-control.
    codecArgs.push(...hwQualityArgs(accel, crf), ...colorArgs)
  }

  return [...flags, ...preInput, '-i', spec.inputPath, ...filterArgs, ...mapAll, ...codecArgs, '-c:a', 'copy', '-c:s', 'copy', '-f', 'matroska', spec.outputPath]
}

/** Vendor-specific constant-quality rate-control args for a hardware encoder. */
function hwQualityArgs(accel: Accelerator, crf: number): string[] {
  switch (accel) {
    case 'nvenc': return ['-rc', 'vbr', '-cq', String(crf), '-preset', 'p5']
    case 'qsv': return ['-global_quality', String(crf), '-preset', 'medium']
    case 'amf': return ['-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)]
    case 'vaapi': return ['-rc_mode', 'CQP', '-qp', String(crf)]
    case 'videotoolbox': return ['-q:v', String(Math.max(1, Math.min(100, 100 - crf * 2)))]
    default: return ['-crf', String(crf), '-preset', 'medium']
  }
}

/** Parse ffmpeg `-progress` output for fractional progress (0..1) and speed (×realtime). */
function parseProgress(chunk: string, durationSec: number | null): { progress: number | null; speed: number | null } {
  let progress: number | null = null
  const t = chunk.match(/out_time_ms=(\d+)/)
  if (t && durationSec && durationSec > 0) progress = Math.max(0, Math.min(1, (Number(t[1]) / 1_000_000) / durationSec))
  const s = chunk.match(/speed=\s*([\d.]+)x/)
  const speed = s ? Number(s[1]) : null
  return { progress, speed }
}

export interface EncodeHandle {
  promise: Promise<void>
  cancel: () => void
}

/** Run an encode, reporting progress + speed. Rejects (with stderr) on non-zero exit. */
export function runEncode(spec: EncodeSpec, onProgress?: (progress: number | null, speed: number | null) => void): EncodeHandle {
  const args = buildArgs(spec)
  logger.info(`ffmpeg ${spec.action} (${spec.accelerator ?? 'software'}): ${spec.inputPath} → ${spec.outputPath}`)
  const proc = spawn(ffmpegBinary(), args)

  let stderr = ''
  proc.stdout.on('data', d => {
    const { progress, speed } = parseProgress(String(d), spec.durationSec)
    if (progress != null || speed != null) onProgress?.(progress, speed)
  })
  proc.stderr.on('data', d => { stderr += String(d); if (stderr.length > 8192) stderr = stderr.slice(-8192) })

  const promise = new Promise<void>((resolve, reject) => {
    proc.on('error', err => reject(err))
    proc.on('close', code => {
      if (code === 0) { onProgress?.(1, null); resolve() }
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(-500)}`))
    })
  })

  return { promise, cancel: () => { try { proc.kill('SIGKILL') } catch {} } }
}

/** Resolve the intended output path for a job: same directory, .mkv extension. */
export function plannedOutputPath(inputPath: string): string {
  const dot = inputPath.lastIndexOf('.')
  const stem = dot > inputPath.lastIndexOf('/') ? inputPath.slice(0, dot) : inputPath
  return `${stem}.mkv`
}

/** Sanity-check a spec against analysis (e.g. skip remux when already MKV). */
export function needsRemux(analysis: MediaAnalysis): boolean {
  return !(analysis.container ?? '').includes('matroska')
}

export function encoderFor(policy: OptimisationPolicy): string {
  return SOFTWARE_ENCODER[policy.video.targetCodec] ?? 'libx265'
}
