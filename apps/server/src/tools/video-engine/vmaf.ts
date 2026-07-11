/**
 * VMAF quality scoring (optional). When enabled in execution settings, a
 * transcode's output is compared against the original with Netflix's VMAF metric
 * (0–100, higher = more perceptually identical). If the score falls below the
 * configured minimum the output is rejected and the original is kept.
 *
 * Requires an ffmpeg built with libvmaf (the bundled ffmpeg-static and the baked
 * Docker ffmpeg both have it); otherwise scoring is skipped.
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
import { createLogger } from '@archivist/core'
import { ffmpegBinary } from './hwaccel.js'

const logger = createLogger('VideoVmaf')

let available: boolean | null = null

export function isVmafAvailable(): boolean {
  if (available !== null) return available
  try {
    const res = spawnSync(ffmpegBinary(), ['-hide_banner', '-filters'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    available = /(\s|^)libvmaf(\s|$)/m.test(res.stdout ?? '')
  } catch { available = false }
  return available
}

/**
 * Compute VMAF of `distorted` vs `reference`. Resolves to the pooled score, or
 * null if VMAF is unavailable or the comparison fails (e.g. mismatched frames).
 */
export function computeVmaf(reference: string, distorted: string): Promise<number | null> {
  if (!isVmafAvailable()) return Promise.resolve(null)
  const threads = Math.max(1, Math.min(8, cpus().length))
  // Input 0 = distorted, input 1 = reference (libvmaf convention: main, reference).
  const args = [
    '-nostdin', '-hide_banner',
    '-i', distorted,
    '-i', reference,
    '-lavfi', `[0:v][1:v]libvmaf=n_threads=${threads}`,
    '-f', 'null', '-',
  ]
  return new Promise(resolve => {
    const proc = spawn(ffmpegBinary(), args)
    let stderr = ''
    proc.stderr.on('data', d => { stderr += String(d); if (stderr.length > 16384) stderr = stderr.slice(-16384) })
    proc.on('error', () => resolve(null))
    proc.on('close', code => {
      if (code !== 0) { logger.debug(`VMAF failed: ${stderr.trim().slice(-200)}`); return resolve(null) }
      const m = stderr.match(/VMAF score:\s*([\d.]+)/i)
      resolve(m ? Math.round(Number(m[1]) * 100) / 100 : null)
    })
  })
}
