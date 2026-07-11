/**
 * Execution settings for the optimisation queue — hardware preference, worker
 * concurrency, quarantine retention, global pause, and the scheduled encode
 * window. Stored in app_settings `processingExecution`, editable from the UI.
 */

import { getAppSetting, setAppSetting } from '../../shared/settings.js'
import type { Accelerator } from './hwaccel.js'

export interface EncodeWindow {
  enabled: boolean
  /** 0–23; window may wrap past midnight (e.g. 1→7 or 22→6). */
  startHour: number
  endHour: number
}

export interface VmafConfig {
  enabled: boolean
  /** Reject a transcode whose VMAF vs the original is below this (0–100). */
  minScore: number
}

export interface ExecutionConfig {
  hwAccel: 'auto' | 'off' | Accelerator
  workerConcurrency: number
  quarantineRetentionDays: number
  paused: boolean
  encodeWindow: EncodeWindow
  vmaf: VmafConfig
}

const DEFAULTS: ExecutionConfig = {
  hwAccel: 'auto',
  workerConcurrency: 1,
  quarantineRetentionDays: 7,
  paused: false,
  encodeWindow: { enabled: false, startHour: 1, endHour: 7 },
  vmaf: { enabled: false, minScore: 92 },
}

function clampHour(v: unknown, def: number): number {
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : def
}

export function getExecutionConfig(): ExecutionConfig {
  const c = getAppSetting<Partial<ExecutionConfig>>('processingExecution', {}, 0)
  return {
    hwAccel: (c.hwAccel as ExecutionConfig['hwAccel']) ?? DEFAULTS.hwAccel,
    workerConcurrency: Math.max(1, Math.min(8, Number(c.workerConcurrency) || 1)),
    quarantineRetentionDays: Number.isFinite(c.quarantineRetentionDays) ? Number(c.quarantineRetentionDays) : DEFAULTS.quarantineRetentionDays,
    paused: !!c.paused,
    encodeWindow: {
      enabled: !!c.encodeWindow?.enabled,
      startHour: clampHour(c.encodeWindow?.startHour, DEFAULTS.encodeWindow.startHour),
      endHour: clampHour(c.encodeWindow?.endHour, DEFAULTS.encodeWindow.endHour),
    },
    vmaf: {
      enabled: !!c.vmaf?.enabled,
      minScore: Number.isFinite(c.vmaf?.minScore) ? Math.max(0, Math.min(100, Number(c.vmaf!.minScore))) : DEFAULTS.vmaf.minScore,
    },
  }
}

export function setExecutionConfig(patch: Partial<ExecutionConfig>): ExecutionConfig {
  const merged: ExecutionConfig = { ...getExecutionConfig(), ...patch }
  setAppSetting('processingExecution', merged, 0)
  return getExecutionConfig()
}

/** Whether a new encode may START now: not paused, and inside the encode window. */
export function encodingAllowed(now = new Date()): boolean {
  const c = getExecutionConfig()
  if (c.paused) return false
  if (!c.encodeWindow.enabled) return true
  const h = now.getHours()
  const { startHour, endHour } = c.encodeWindow
  // Non-wrapping window (1→7) vs overnight window (22→6).
  return startHour <= endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}
