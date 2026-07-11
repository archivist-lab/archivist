import { useEffect, type RefObject } from 'react'
import type { Loudness } from './sdk.js'

/**
 * Applies volume normalization to a <video> during DIRECT play via the Web
 * Audio API (transcoded playback is normalized server-side by loudnorm instead).
 *
 * A GainNode can boost above 1.0, which `video.volume` cannot — needed to bring
 * quiet titles up to target. Gain is the ReplayGain-style offset
 * `target − integrated`, limited so true peak stays below 0 dBFS (no clipping).
 *
 * Routing a media element through Web Audio is permanent for that element, so
 * this is keyed on `srcKey`: the player remounts the <video> when the source or
 * mode changes, giving each element a fresh graph. Defensive throughout — any
 * failure (autoplay policy, unsupported) degrades to normal playback.
 */
export function computeGainDb(loudness: Loudness | null, targetLufs: number): number {
  if (!loudness) return 0
  const desired = targetLufs - loudness.integratedLufs
  // Keep peaks under −1 dBFS: gain can't exceed −1 − truePeak.
  const peakCeil = -1 - loudness.truePeak
  return Math.max(-12, Math.min(desired, peakCeil, 12))
}

export function useMediaGain(
  videoRef: RefObject<HTMLVideoElement>,
  active: boolean,
  gainDb: number,
  srcKey: string,
): void {
  useEffect(() => {
    const v = videoRef.current
    if (!active || !v || Math.abs(gainDb) < 0.1) return

    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return

    let ctx: AudioContext
    let source: MediaElementAudioSourceNode
    let gain: GainNode
    try {
      ctx = new AC()
      source = ctx.createMediaElementSource(v)
      gain = ctx.createGain()
      gain.gain.value = Math.pow(10, gainDb / 20)
      source.connect(gain).connect(ctx.destination)
    } catch {
      return // element already tapped, or Web Audio blocked — play normally
    }

    const resume = () => { ctx.resume().catch(() => {}) }
    v.addEventListener('play', resume)
    resume()

    return () => {
      v.removeEventListener('play', resume)
      try { source.disconnect(); gain.disconnect(); ctx.close() } catch { /* ignore */ }
    }
  }, [videoRef, active, gainDb, srcKey])
}
