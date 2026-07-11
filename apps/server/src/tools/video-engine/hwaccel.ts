/**
 * Hardware acceleration — detection for NVIDIA (NVENC), Intel (QSV / VAAPI),
 * AMD (VAAPI / AMF) and Apple (VideoToolbox).
 *
 * Two things must both be true to use a GPU encoder:
 *   1. the ffmpeg binary was compiled with that encoder, and
 *   2. a matching GPU is actually present.
 * The bundled `ffmpeg-static` is software-only, so real HW acceleration needs a
 * system ffmpeg built with VAAPI/QSV/NVENC (set ARCHIVIST_FFMPEG_PATH or install
 * `ffmpeg` on PATH) plus, in Docker, `/dev/dri` passthrough. We prefer whichever
 * available binary exposes HW encoders and report exactly what's usable.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createLogger } from '@archivist/core'

const require = createRequire(import.meta.url)
let staticFfmpeg: string
try { staticFfmpeg = require('ffmpeg-static') as string } catch { staticFfmpeg = 'ffmpeg' }

const logger = createLogger('VideoHwAccel')

export type Accelerator = 'nvenc' | 'qsv' | 'vaapi' | 'videotoolbox' | 'amf' | 'software'
export type GpuVendor = 'intel' | 'amd' | 'nvidia' | 'apple' | 'unknown'

/** ffmpeg encoder name for each (codec, accelerator). Extend to teach a new codec. */
const ENCODER_TABLE: Record<string, Partial<Record<Accelerator, string>>> = {
  h264: { software: 'libx264', nvenc: 'h264_nvenc', qsv: 'h264_qsv', vaapi: 'h264_vaapi', videotoolbox: 'h264_videotoolbox', amf: 'h264_amf' },
  hevc: { software: 'libx265', nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', vaapi: 'hevc_vaapi', videotoolbox: 'hevc_videotoolbox', amf: 'hevc_amf' },
  av1:  { software: 'libsvtav1', nvenc: 'av1_nvenc', qsv: 'av1_qsv', vaapi: 'av1_vaapi', amf: 'av1_amf' },
  vp9:  { software: 'libvpx-vp9', vaapi: 'vp9_vaapi', qsv: 'vp9_qsv' },
}

const AUTO_ORDER: Accelerator[] = ['nvenc', 'qsv', 'vaapi', 'amf', 'videotoolbox', 'software']

export interface Gpu {
  node: string | null
  vendor: GpuVendor
  vendorId: string | null
}

export interface HwCapabilities {
  /** Resolved ffmpeg binary we will actually run. */
  ffmpeg: string
  ffmpegHasHwEncoders: boolean
  gpus: Gpu[]
  /** Accelerators usable right now (encoder compiled AND matching GPU present). */
  available: Accelerator[]
  /** Primary VAAPI/QSV render node, if any. */
  renderNode: string | null
  compiledEncoders: string[]
  /** Human note when something is detected but not usable. */
  note: string | null
}

function encodersOf(bin: string): Set<string> {
  try {
    const res = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    const set = new Set<string>()
    for (const line of (res.stdout ?? '').split('\n')) {
      const m = line.trim().match(/^[A-Z.]{6}\s+(\S+)/)
      if (m) set.add(m[1])
    }
    return set
  } catch { return new Set() }
}

function hasAnyHwEncoder(encoders: Set<string>): boolean {
  for (const e of encoders) if (/_nvenc|_qsv|_vaapi|_amf|_videotoolbox/.test(e)) return true
  return false
}

/** Candidate binaries in preference order: explicit override, system, bundled static. */
function ffmpegCandidates(): string[] {
  const list: string[] = []
  if (process.env.ARCHIVIST_FFMPEG_PATH) list.push(process.env.ARCHIVIST_FFMPEG_PATH)
  list.push('ffmpeg')
  if (staticFfmpeg && !list.includes(staticFfmpeg)) list.push(staticFfmpeg)
  return list
}

function detectGpus(): Gpu[] {
  if (process.platform === 'darwin') return [{ node: null, vendor: 'apple', vendorId: null }]
  const gpus: Gpu[] = []
  try {
    for (const f of readdirSync('/dev/dri')) {
      if (!/^renderD\d+$/.test(f)) continue
      let vendorId: string | null = null
      try { vendorId = readFileSync(`/sys/class/drm/${f}/device/vendor`, 'utf8').trim() } catch {}
      const vendor: GpuVendor = vendorId === '0x8086' ? 'intel' : vendorId === '0x1002' ? 'amd' : vendorId === '0x10de' ? 'nvidia' : 'unknown'
      gpus.push({ node: `/dev/dri/${f}`, vendor, vendorId })
    }
  } catch { /* no /dev/dri */ }
  // NVIDIA often exposes /dev/nvidia0 rather than a DRI render node.
  if (existsSync('/dev/nvidia0') && !gpus.some(g => g.vendor === 'nvidia')) {
    gpus.push({ node: null, vendor: 'nvidia', vendorId: null })
  }
  return gpus
}

let cache: HwCapabilities | null = null

export function detectHwCapabilities(): HwCapabilities {
  if (cache) return cache

  // Choose the binary: prefer one that actually has HW encoders.
  let chosen = staticFfmpeg
  let chosenEncoders = encodersOf(staticFfmpeg)
  for (const bin of ffmpegCandidates()) {
    const enc = encodersOf(bin)
    if (enc.size && hasAnyHwEncoder(enc)) { chosen = bin; chosenEncoders = enc; break }
  }

  const gpus = detectGpus()
  const renderNode = gpus.find(g => g.node)?.node ?? null
  const has = (name?: string) => !!name && chosenEncoders.has(name)
  const gpuVendors = new Set(gpus.map(g => g.vendor))

  const available: Accelerator[] = ['software']
  const canVaapi = gpus.some(g => g.node) && Object.values(ENCODER_TABLE).some(r => has(r.vaapi))
  if (gpuVendors.has('nvidia') && Object.values(ENCODER_TABLE).some(r => has(r.nvenc))) available.unshift('nvenc')
  if (gpuVendors.has('intel') && Object.values(ENCODER_TABLE).some(r => has(r.qsv))) available.push('qsv')
  if (canVaapi) available.push('vaapi')
  if (gpuVendors.has('amd') && Object.values(ENCODER_TABLE).some(r => has(r.amf))) available.push('amf')
  if (process.platform === 'darwin' && Object.values(ENCODER_TABLE).some(r => has(r.videotoolbox))) available.push('videotoolbox')

  const ffmpegHasHwEncoders = hasAnyHwEncoder(chosenEncoders)
  const usableHw = available.filter(a => a !== 'software')
  let note: string | null = null
  if (gpus.length && !ffmpegHasHwEncoders) {
    const vs = [...gpuVendors].filter(v => v !== 'unknown').join('/')
    note = `${vs || 'A'} GPU detected, but the ffmpeg build has no hardware encoders. Install a HW-enabled ffmpeg (set ARCHIVIST_FFMPEG_PATH) — and in Docker pass /dev/dri — to enable ${vs === 'intel' ? 'QSV/VAAPI' : vs === 'amd' ? 'VAAPI' : 'GPU'} encoding.`
  } else if (!gpus.length && process.platform !== 'darwin') {
    note = 'No GPU render node found (/dev/dri). In Docker, add the device (e.g. `devices: [/dev/dri:/dev/dri]`).'
  }

  cache = {
    ffmpeg: chosen,
    ffmpegHasHwEncoders,
    gpus,
    available: [...new Set(available)],
    renderNode,
    compiledEncoders: [...chosenEncoders].filter(e => /_nvenc|_qsv|_vaapi|_amf|_videotoolbox|libx264|libx265|libsvtav1/.test(e)),
    note,
  }
  logger.info(`ffmpeg=${chosen.includes('/') ? 'system/override' : chosen} · GPUs: ${gpus.map(g => g.vendor).join(',') || 'none'} · HW usable: ${usableHw.join(', ') || 'none (software only)'}`)
  return cache
}

/** The ffmpeg binary the executor should run (HW-capable if one was found). */
export function ffmpegBinary(): string {
  return detectHwCapabilities().ffmpeg
}

export interface ResolvedEncoder {
  encoder: string
  accelerator: Accelerator
  /** VAAPI/QSV render device, when the accelerator needs one. */
  device: string | null
}

export function resolveEncoder(codec: string, preference: 'auto' | 'off' | Accelerator): ResolvedEncoder {
  const row = ENCODER_TABLE[codec] ?? ENCODER_TABLE.hevc
  const caps = detectHwCapabilities()
  const sw: ResolvedEncoder = { encoder: row.software ?? 'libx265', accelerator: 'software', device: null }
  if (preference === 'off') return sw

  const order = preference === 'auto' ? AUTO_ORDER : [preference, 'software' as Accelerator]
  for (const accel of order) {
    if (accel === 'software') return sw
    if (caps.available.includes(accel) && row[accel]) {
      const device = accel === 'vaapi' || accel === 'qsv' ? caps.renderNode : null
      return { encoder: row[accel]!, accelerator: accel, device }
    }
  }
  return sw
}
