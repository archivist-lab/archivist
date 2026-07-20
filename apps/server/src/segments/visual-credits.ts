// SPDX-FileCopyrightText: 2025-2026 Intro Skipper contributors
// SPDX-License-Identifier: GPL-3.0-only
// Visual credits baseline derived from https://github.com/intro-skipper/intro-skipper

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let bundledFfmpeg = 'ffmpeg'
try { bundledFfmpeg = require('ffmpeg-static') as string } catch {}
const ffmpegPath = process.env.ARCHIVIST_FFMPEG_PATH ?? bundledFfmpeg

interface Frame { time: number; pblack: number }
interface Visual { time: number; entropy: number; saturation: number }
export interface VisualCreditsMarker { start: number; end: number; method: string; confidence: number; evidence: Record<string, unknown> }

function run(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let output = ''
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    const abort = () => { try { child.kill('SIGKILL') } catch {} }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { abort(); reject(new Error('Visual credits scan timed out')) }, 120_000)
    timer.unref?.()
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new Error('Segment analysis cancelled'))
      else if (code === 0) resolve(output)
      else reject(new Error(`Visual credits scan failed (${code})`))
    })
  })
}

const density = (frames: Frame[], start: number, end: number, minimum: number) => {
  const inside = frames.filter(frame => frame.time >= start && frame.time <= end)
  return inside.length ? inside.filter(frame => frame.pblack >= minimum).length / inside.length : 0
}

function blackFrameCandidate(frames: Frame[], minimumDuration: number): { start: number; end: number; density: number; minimum: number } | null {
  if (frames.length < 2) return null
  const ordered = [...frames].sort((a, b) => a.pblack - b.pblack)
  const floor = Math.min(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.01))].pblack, 30)
  const minimum = 85 * (100 - floor) / 100 + floor
  const sceneChange = 95 * (100 - floor) / 100 + floor
  const gaps = frames.slice(1).map((frame, index) => frame.time - frames[index].time).filter(gap => gap > 0).sort((a, b) => a - b)
  const maximumGap = Math.min(20, (gaps[Math.floor(gaps.length / 2)] ?? 4) * 5)
  const raw: Array<{ start: number; end: number }> = []
  let current: { start: number; end: number } | null = null
  for (const frame of frames) {
    if (frame.pblack < minimum) continue
    if (!current || frame.time - current.end > maximumGap) {
      if (current) raw.push(current)
      current = { start: frame.time, end: frame.time }
    } else current.end = frame.time
  }
  if (current) raw.push(current)
  let scenes = raw.filter(scene => density(frames, scene.start, scene.end, minimum) >= 0.5)
  const merged: typeof scenes = []
  for (const scene of scenes) {
    const previous = merged.at(-1)
    if (previous && scene.start - previous.end <= 20 && density(frames, previous.start, scene.end, minimum) >= 0.5) previous.end = scene.end
    else merged.push({ ...scene })
  }
  scenes = merged.map(scene => {
    const transition = frames.find(frame => frame.time >= scene.start && frame.time <= scene.end && frame.pblack >= sceneChange)
    return { ...scene, start: transition?.time ?? scene.start }
  }).filter(scene => scene.end - scene.start >= minimumDuration)
  const selected = scenes.at(-1)
  return selected ? { ...selected, density: density(frames, selected.start, selected.end, minimum), minimum } : null
}

function entropyCandidate(visuals: Visual[], minimumDuration: number): { start: number; end: number; density: number } | null {
  const card = (visual: Visual) => visual.entropy < 0.35 && visual.saturation < 96
  const runs: Visual[][] = []
  let run: Visual[] = []
  let nonCardSince = false
  for (const visual of visuals) {
    if (!card(visual)) { nonCardSince = true; continue }
    if (run.length && visual.time - run.at(-1)!.time > 20 && nonCardSince) { runs.push(run); run = [] }
    run.push(visual)
    nonCardSince = false
  }
  if (run.length) runs.push(run)
  const candidates = runs.map(cards => {
    const start = cards[0].time
    const end = cards.at(-1)!.time
    const inside = visuals.filter(visual => visual.time >= start && visual.time <= end)
    return { start, end, density: inside.length ? inside.filter(card).length / inside.length : 0 }
  }).filter(candidate => candidate.end - candidate.start >= minimumDuration && candidate.density >= 0.5)
  return candidates.at(-1) ?? null
}

export async function detectVisualCredits(filePath: string, duration: number, windowSeconds: number, signal?: AbortSignal): Promise<VisualCreditsMarker | null> {
  const start = Math.max(0, duration - Math.min(windowSeconds, duration))
  const scanDuration = duration - start
  try {
    const output = await run(['-hide_banner', '-loglevel', 'info', '-skip_frame', 'nokey', '-ss', String(start), '-i', filePath, '-t', String(scanDuration), '-an', '-dn', '-sn', '-vf', 'format=yuv420p,blackframe=amount=0:threshold=28', '-f', 'null', '-'], signal)
    const frames: Frame[] = []
    for (const match of output.matchAll(/frame:\s*\d+\s+pblack:\s*([0-9.]+).*?\bt:\s*([0-9.]+)/g)) frames.push({ pblack: Number(match[1]), time: Number(match[2]) })
    const candidate = blackFrameCandidate(frames, 15)
    if (candidate) return {
      start: start + candidate.start, end: duration, method: 'visual-blackframes', confidence: Math.min(0.96, 0.72 + candidate.density * 0.24),
      evidence: { sampledKeyframes: frames.length, blackFrameDensity: candidate.density, adaptiveBlackThreshold: candidate.minimum },
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }

  try {
    const output = await run(['-hide_banner', '-loglevel', 'info', '-skip_frame', 'nokey', '-ss', String(start), '-i', filePath, '-t', String(scanDuration), '-an', '-dn', '-sn', '-vf', 'format=yuv420p,entropy,signalstats,metadata=print', '-f', 'null', '-'], signal)
    const visuals: Visual[] = []
    let current: Partial<Visual> = {}
    const flush = () => {
      if (current.time != null && current.entropy != null && current.saturation != null) visuals.push(current as Visual)
      current = {}
    }
    for (const line of output.split(/\r?\n/)) {
      const time = line.match(/pts_time:([0-9.]+)/)
      if (time) { flush(); current.time = Number(time[1]); continue }
      const entropy = line.match(/normalized_entropy\.normal\.Y=([0-9.]+)/)
      if (entropy) { current.entropy = Number(entropy[1]); continue }
      const saturation = line.match(/lavfi\.signalstats\.SATAVG=([0-9.]+)/)
      if (saturation) current.saturation = Number(saturation[1])
    }
    flush()
    const candidate = entropyCandidate(visuals, 15)
    if (candidate) return {
      start: start + candidate.start, end: duration, method: 'visual-entropy', confidence: Math.min(0.9, 0.65 + candidate.density * 0.25),
      evidence: { sampledKeyframes: visuals.length, creditCardDensity: candidate.density },
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return null
}

export const visualCreditsInternals = { blackFrameCandidate, entropyCandidate }
