/**
 * System utilisation for the Processing dashboard — CPU %, memory %, GPU % (when
 * the driver exposes it), plus live queue throughput. CPU is sampled from
 * /proc/stat deltas on a background timer; GPU utilisation is read from sysfs
 * (`gpu_busy_percent`, exposed by AMD and newer Intel drivers).
 */

import { readFileSync, readdirSync } from 'node:fs'
import { totalmem, freemem, loadavg, cpus } from 'node:os'
import { queueStats } from './queue.js'

interface CpuSnapshot { idle: number; total: number }

let last: CpuSnapshot | null = null
let cpuPercent = 0
let timer: ReturnType<typeof setInterval> | null = null

function readCpu(): CpuSnapshot | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0] // "cpu  u n s idle iowait irq softirq steal ..."
    const parts = line.trim().split(/\s+/).slice(1).map(Number)
    if (parts.length < 5) return null
    const idle = parts[3] + (parts[4] || 0) // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0)
    return { idle, total }
  } catch { return null }
}

function sampleCpu(): void {
  const now = readCpu()
  if (now && last) {
    const dTotal = now.total - last.total
    const dIdle = now.idle - last.idle
    if (dTotal > 0) cpuPercent = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)))
  }
  if (now) last = now
}

function gpuPercent(): number | null {
  try {
    for (const card of readdirSync('/sys/class/drm')) {
      if (!/^card\d+$/.test(card)) continue
      try {
        const v = Number(readFileSync(`/sys/class/drm/${card}/device/gpu_busy_percent`, 'utf8').trim())
        if (Number.isFinite(v)) return Math.max(0, Math.min(100, v))
      } catch { /* this card doesn't expose it */ }
    }
  } catch { /* no /sys/class/drm */ }
  return null
}

export interface SystemStats {
  cpuPercent: number
  cpuCount: number
  memPercent: number
  loadAvg1: number
  gpuPercent: number | null
  encoding: number
  queued: number
  aggregateSpeed: number
}

export function getSystemStats(): SystemStats {
  const mem = 1 - freemem() / totalmem()
  const q = queueStats()
  return {
    cpuPercent,
    cpuCount: cpus().length,
    memPercent: Math.round(mem * 100),
    loadAvg1: Math.round(loadavg()[0] * 100) / 100,
    gpuPercent: gpuPercent(),
    encoding: q.encoding,
    queued: q.queued,
    aggregateSpeed: q.aggregateSpeed,
  }
}

export function startStatsSampler(): void {
  last = readCpu()
  timer = setInterval(sampleCpu, 2000)
  timer.unref?.()
}

export function stopStatsSampler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
