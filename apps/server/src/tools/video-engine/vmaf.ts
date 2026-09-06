import { acquireMediaSlot, mediaThreads } from '../../shared/media-resources.js'
/**
 * VMAF quality scoring (optional). When enabled in execution settings, a
 * transcode's output is compared against the original with Netflix's VMAF metric
 * (0–100, higher = more perceptually identical). If the score falls below the
 * configured minimum the output is rejected and the original is kept.
 *
 * Requires an ffmpeg built with libvmaf (the bundled ffmpeg-static and the baked
 * Docker ffmpeg both have it); otherwise the enabled quality gate rejects replacement.
 */

import { spawn } from 'node:child_process'
import { runMediaCommand } from '../../shared/media-probe.js'
import { createLogger } from '@archivist/core'
import { ffmpegBinary } from './hwaccel.js'

const logger = createLogger('VideoVmaf')

let available: boolean | null = null

export async function isVmafAvailable(): Promise<boolean> {
  if (available !== null) return available
  try {
    const stdout = await runMediaCommand(await ffmpegBinary(), ['-hide_banner', '-filters'], 5000)
    available = /(\s|^)libvmaf(\s|$)/m.test(stdout)
  } catch { available = false }
  return available
}

/**
 * Compute VMAF of `distorted` vs `reference`. Resolves to the pooled score, or
 * null if VMAF is unavailable or the comparison fails (e.g. mismatched frames).
 */
export interface VmafResult { score: number | null; status: 'measured' | 'unavailable' | 'failed' | 'timed-out' | 'cancelled' }
export function passesVmaf(result: VmafResult, minimum: number): boolean {
  return result.status === 'measured' && result.score != null && Number.isFinite(result.score) && result.score >= minimum
}
export async function computeVmaf(reference: string, distorted: string, signal?: AbortSignal): Promise<VmafResult> {
  signal?.throwIfAborted()
  if (!await isVmafAvailable()) return { score: null, status: 'unavailable' }
  const threads = mediaThreads
  // Input 0 = distorted, input 1 = reference (libvmaf convention: main, reference).
  const args = [
    '-nostdin', '-hide_banner',
    '-threads', '1', '-filter_complex_threads', '1', '-i', distorted,
    '-threads', '1', '-i', reference,
    '-lavfi', `[0:v][1:v]libvmaf=n_threads=${threads}`,
    '-f', 'null', '-',
  ]
  const binary = await ffmpegBinary()
  const release = await acquireMediaSlot('background', signal)
  return new Promise<VmafResult>(resolve => {
    let timedOut = false
    const proc = spawn(binary, args)
    const abort = () => { proc.kill('SIGKILL') }
    const timeout = setTimeout(() => { timedOut = true; abort() }, 2 * 60 * 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    proc.once('close', () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort) })
    let stderr = ''
    proc.stderr.on('data', d => { stderr += String(d); if (stderr.length > 16384) stderr = stderr.slice(-16384) })
    proc.on('error', () => resolve({ score: null, status: 'failed' }))
    proc.on('close', code => {
      if (code !== 0) { logger.debug(`VMAF failed: ${stderr.trim().slice(-200)}`); return resolve({ score: null, status: signal?.aborted ? 'cancelled' : timedOut ? 'timed-out' : 'failed' }) }
      const m = stderr.match(/VMAF score:\s*([\d.]+)/i)
      const score = m ? Math.round(Number(m[1]) * 100) / 100 : null
      resolve({ score, status: score != null && Number.isFinite(score) ? 'measured' : 'failed' })
    })
  }).finally(release)
}
